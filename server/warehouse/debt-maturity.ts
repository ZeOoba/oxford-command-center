// server/warehouse/debt-maturity.ts
//
// Debt & Maturity warehouse module v1 (branch next5-debt-module).
// Design + what-already-exists survey: server/warehouse/debt-maturity.DESIGN.md.
//
// Three pure read functions over active debt_positions rows:
//   buildMaturityTimeline()        — chronological maturity / rate-reset / demand-callable events
//   buildRefiWindows()             — per-property 12/24-month refi-window flags + governor breaches
//   computePortfolioAggregateLtv() — conservative aggregate LTV vs the ratified 40% governor
//
// GOVERNOR CONSTANTS (Hard Invariant 4 — referenced, never redefined):
//   DSCR floor / aggregate LTV ceiling → loadGovernors(db) (capital_config, ratified fallback)
//   65% per-property refi ceiling      → ALERT_THRESHOLDS.ltvCeiling (src/analytics/conditions.ts,
//                                        the codebase's single existing definition)
//
// CONFIDENTIALITY: nothing returned here carries a balance, a rate VALUE, or a lender name —
// tighter than the existing /maturity ladder, per migration 009's stated intent. rateType is
// loan STRUCTURE ("Fixed"/"Floating"), not a term.
//
// UNKNOWNS ARE FLAGGED, NEVER GUESSED (F1/F2/F3 precedent from debt-scoring.ts):
//   unknown maturity  → hasUnknownMaturity, not a fabricated near/far date
//   unknown DSCR/LTV  → null breach flags, never a cleared/false verdict
//   demand note       → callable immediately: both refi windows forced true
import type { WarehouseDb } from './db';
import { loadGovernors, type Governors } from './governors';
import { effectiveMonthsToMaturity } from './debt-scoring';
import { referenceDate } from '../config';
import { MONTH_MS } from './time-constants';
import { ALERT_THRESHOLDS } from '../../src/analytics/conditions';
import type {
  DebtScore,
  MaturityTimelineEvent,
  PortfolioAggregateLtv,
  RefiWindowEntry,
} from '../../src/contracts/debt';

/**
 * Refi-window horizons (months) — module-owned constant, not a CLAUDE.md governor.
 * RATIFIED by Gabriel 2026-07-19 ("approve as-is") on PR #222. Not DB-backed like
 * dscrFloor/ltvCeiling — a future change here is a code edit + review, not a
 * capital_config write.
 */
export const REFI_WINDOW_MONTHS_NEAR = 12;
export const REFI_WINDOW_MONTHS_FAR = 24;

/** The per-property refi LTV ceiling — a REFERENCE to the single existing definition
 *  (ALERT_THRESHOLDS.ltvCeiling, currently 0.65), never a new literal. Drift-pinned in tests. */
export const REFI_LTV_CEILING: number = ALERT_THRESHOLDS.ltvCeiling;

/**
 * Floating-point tolerance for the aggregate-LTV governor comparison. NOT a governor value and
 * NOT a widening of the ceiling — the ratified ceiling is INCLUSIVE ("at 40%" is compliant), and
 * this exists so that intent survives IEEE-754.
 *
 * Why it is needed (2026-07-24 integrity sweep, determinism lens): aggregateLtv is
 * Σbalance ÷ Σ(balance ÷ ltv). For a portfolio whose stored per-loan LTV is exactly the ceiling,
 * that double roundtrip lands a fraction of an ulp ABOVE the ceiling for most cents-precision
 * balances (7,839,422.99 ÷ (7,839,422.99 ÷ 0.4) === 0.40000000000000008), so an untoleranced
 * `<=` reported a portfolio sitting exactly AT the inclusive ceiling as failing it. Worse, for
 * multi-loan portfolios the summation order is `ORDER BY d.id` — the loan-name slug — so renaming
 * a loan (this repo's own documented slug-collision remedy) could flip the verdict on
 * economically unchanged inputs.
 *
 * 1e-9 is ~7 orders of magnitude above the accumulated ulp error at realistic portfolio sizes and
 * ~5 orders BELOW any materially meaningful LTV difference (1e-9 of LTV on a $60M book is well
 * under one cent), so it absorbs float noise without ever admitting a real breach.
 */
export const GOVERNOR_LTV_EPSILON = 1e-9;

/**
 * Float-equality tolerance for the ltv/rate collision check below. Deliberately as tight as
 * GOVERNOR_LTV_EPSILON — this detects "the same underlying cell value was copied into both
 * fields", which is exact by construction (a column-drift bug reads one cell into two output
 * fields), not "these two independent values are in a similar range". A loose tolerance here
 * would risk excluding a genuine loan whose ltv and rate happen to be merely close but distinct.
 */
export const RATE_LTV_COLLISION_EPSILON = 1e-9;

/** True when an ISO-ish date string actually parses to a real instant. Used so a free-form
 *  workbook cell ("TBD") is never emitted as if it were a date. */
function isParseableDate(value: string | null): value is string {
  return value !== null && Number.isFinite(new Date(value).getTime());
}

// ── Shared row read ───────────────────────────────────────────────────────────────────────

interface ActiveLoanRow {
  id: string;
  property_id: string | null;
  property_name: string | null;
  loan_name: string;
  current_balance: number;
  maturity_date: string | null;
  months_to_maturity: number | null;
  is_demand: number;
  balloon: number;
  ltv: number | null;
  rate_type: string | null;
  next_rate_reset: string | null;
  /** INTERNAL ONLY (round 7) — consumed exclusively by computePortfolioAggregateLtv's
   *  rate-collision coverage check below. NEVER add this to any return value in this file: the
   *  module docblock's confidentiality contract is explicit that nothing returned here carries
   *  a rate VALUE. Reading it internally to validate a DIFFERENT field (ltv) does not violate
   *  that contract as long as it stays internal — enforced by a dedicated test. */
  rate: number | null;
}

/** All active debt_positions rows joined to property_master, deterministic order. */
function activeLoans(db: WarehouseDb): ActiveLoanRow[] {
  return db
    .prepare(
      `SELECT d.id, d.property_id, p.name AS property_name, d.loan_name,
              d.current_balance, d.maturity_date, d.months_to_maturity,
              d.is_demand, d.balloon, d.ltv, d.rate_type, d.next_rate_reset, d.rate
       FROM debt_positions d
       LEFT JOIN property_master p ON p.id = d.property_id
       WHERE d.status = 'active'
       ORDER BY d.id ASC`,
    )
    .all() as ActiveLoanRow[];
}

// ── Maturity / rate-reset timeline ────────────────────────────────────────────────────────

/** Fresh months-out for an arbitrary ISO event date; null when either date is unparseable. */
function monthsOutFresh(eventDateIso: string, asOf: string): number | null {
  const months = (new Date(eventDateIso).getTime() - new Date(asOf).getTime()) / MONTH_MS;
  return Number.isFinite(months) ? months : null;
}

/**
 * One chronological event stream across all active loans:
 *   demand-callable events FIRST (callable now beats any dated event — F3 spirit),
 *   then dated/known events by months-out ascending,
 *   then unknown-maturity loans LAST (visible, never silently dropped),
 *   ties broken by loanId for determinism.
 * Rate-reset events appear only when next_rate_reset is populated (NULL until the workbook
 * mapping is confirmed — see DESIGN.md [GG: confirm]).
 */
export function buildMaturityTimeline(
  db: WarehouseDb,
  asOf: string = referenceDate(),
): MaturityTimelineEvent[] {
  const events: MaturityTimelineEvent[] = [];

  for (const row of activeLoans(db)) {
    const base = {
      loanId: row.id,
      loanName: row.loan_name,
      propertyId: row.property_id,
      propertyName: row.property_name,
      balloon: row.balloon === 1,
      rateType: row.rate_type,
    };

    if (row.is_demand === 1) {
      // Callable immediately — no date, no months; sorted first below.
      events.push({ ...base, eventType: 'demand-callable', eventDate: null, monthsOut: null });
    } else {
      // Fresh recompute from maturity_date; stored-cell fallback only when the date is absent
      // (the exact ratified logic from debt-scoring.ts — reused, not duplicated).
      const monthsOut = effectiveMonthsToMaturity(row, asOf);
      events.push({
        ...base,
        eventType: 'maturity',
        // L3 (2026-07-24 integrity sweep) applies here too — independent-review finding, same
        // day: this event's `eventDate` was still emitting row.maturity_date unconditionally,
        // the identical defect class L3 closed in buildRefiWindows' soonestMaturityDate below
        // (a free-form unparseable workbook cell, e.g. "TBD", reaching a date-typed field on a
        // client-facing endpoint). monthsOut already falls back correctly via
        // effectiveMonthsToMaturity; eventDate needs the matching guard.
        eventDate: isParseableDate(row.maturity_date) ? row.maturity_date : null,
        monthsOut,
      });
    }

    if (row.next_rate_reset !== null) {
      events.push({
        ...base,
        eventType: 'rate-reset',
        eventDate: row.next_rate_reset,
        monthsOut: monthsOutFresh(row.next_rate_reset, asOf),
      });
    }
  }

  // Sort: demand-callable first, then known monthsOut ascending, then unknown last; loanId ties.
  const sortKey = (e: MaturityTimelineEvent): number =>
    e.eventType === 'demand-callable' ? -Infinity : (e.monthsOut ?? Infinity);
  events.sort((a, b) => {
    const ka = sortKey(a);
    const kb = sortKey(b);
    // Guard the subtraction against NaN: two same-key events — e.g. two demand-callable
    // (both -Infinity) or two unknown-maturity (both Infinity) — would make ka - kb === NaN,
    // and a NaN comparator return is undefined (non-deterministic) order. Only subtract once
    // the keys are known to differ (mirrors the buildRefiWindows sort guard below).
    if (ka !== kb) return ka - kb;
    if (a.loanId !== b.loanId) return a.loanId < b.loanId ? -1 : 1;
    return a.eventType < b.eventType ? -1 : a.eventType > b.eventType ? 1 : 0;
  });
  return events;
}

// ── Per-property refi windows ─────────────────────────────────────────────────────────────

/**
 * Per-property refi-window flags. DSCR/LTV are PASSED THROUGH from the ratified scoring
 * engine's DebtScore rows (Spine-B NOI basis, D1 LTV convention) — no financial math is
 * re-derived here. Breach flags compare against loadGovernors(db) (DSCR floor, aggregate LTV
 * ceiling) and REFI_LTV_CEILING (per-property 65% refi ceiling). Unknown inputs → null flags.
 */
export function buildRefiWindows(
  db: WarehouseDb,
  scores: DebtScore[],
  asOf: string = referenceDate(),
): RefiWindowEntry[] {
  const governors = loadGovernors(db);
  const scoreByProperty = new Map(scores.map((s) => [s.propertyId, s]));

  // Group active loans by attributed property (property_id null → not attributable to a
  // refi window; still visible on the timeline).
  const byProperty = new Map<string, ActiveLoanRow[]>();
  for (const row of activeLoans(db)) {
    if (row.property_id === null) continue;
    const list = byProperty.get(row.property_id);
    if (list === undefined) byProperty.set(row.property_id, [row]);
    else list.push(row);
  }

  const entries: RefiWindowEntry[] = [];
  for (const [propertyId, loans] of byProperty) {
    let hasDemandNote = false;
    let hasUnknownMaturity = false;
    let minMonths: number | null = null;
    let minMonthsDate: string | null = null;
    for (const loan of loans) {
      if (loan.is_demand === 1) {
        hasDemandNote = true;
        continue;
      }
      const months = effectiveMonthsToMaturity(loan, asOf);
      if (months === null) {
        hasUnknownMaturity = true;
        continue;
      }
      if (minMonths === null || months < minMonths) {
        minMonths = months;
        // L3: effectiveMonthsToMaturity falls back to the STORED months_to_maturity cell when
        // maturity_date is absent or unparseable. Carrying loan.maturity_date through
        // unconditionally therefore emitted free-form workbook text ("TBD") through a
        // z.string() date field, or paired a real months figure with a null date. Only surface
        // the date when it is genuinely a date; otherwise months stands alone.
        minMonthsDate = isParseableDate(loan.maturity_date) ? loan.maturity_date : null;
      }
    }

    // A demand note is callable immediately — more urgent than any 12/24-month window.
    const within12 =
      hasDemandNote || (minMonths !== null && minMonths <= REFI_WINDOW_MONTHS_NEAR);
    const within24 =
      hasDemandNote || (minMonths !== null && minMonths <= REFI_WINDOW_MONTHS_FAR);

    const s = scoreByProperty.get(propertyId);
    const dscr = s?.dscr ?? null;
    const ltv = s?.ltv ?? null;

    entries.push({
      propertyId,
      propertyName: loans[0]?.property_name ?? propertyId,
      loanCount: loans.length,
      soonestMaturityDate: minMonthsDate,
      monthsToSoonestMaturity: minMonths,
      hasDemandNote,
      hasUnknownMaturity,
      maturityWithin12mo: within12,
      maturityWithin24mo: within24,
      dscr,
      dscrFloorBreach: dscr !== null ? dscr < governors.dscrFloor : null,
      ltv,
      govLtvCeilingBreach: ltv !== null ? ltv > governors.ltvCeiling : null,
      refiLtvHeadroom: ltv !== null ? REFI_LTV_CEILING - ltv : null,
      refiCeilingBreach: ltv !== null ? ltv > REFI_LTV_CEILING : null,
    });
  }

  // Deterministic order: most urgent first (known soonest maturity ascending, demand notes
  // treated as now), then propertyId.
  entries.sort((a, b) => {
    const ka = a.hasDemandNote ? -Infinity : (a.monthsToSoonestMaturity ?? Infinity);
    const kb = b.hasDemandNote ? -Infinity : (b.monthsToSoonestMaturity ?? Infinity);
    if (ka !== kb) return ka - kb;
    return a.propertyId < b.propertyId ? -1 : a.propertyId > b.propertyId ? 1 : 0;
  });
  return entries;
}

// ── Conservative portfolio aggregate LTV ──────────────────────────────────────────────────

/**
 * Aggregate LTV vs the ratified aggregate governor (governors.ltvCeiling), on a deliberately
 * CONSERVATIVE basis:
 *
 *   covered loan  = the ONLY active loan on its property, with known ltv > 0, a NON-NEGATIVE
 *                   current_balance, and an ltv that does NOT exactly collide with the loan's
 *                   own rate (multi-loan properties are excluded — the workbook's per-loan LTV
 *                   semantics for stacked loans are unconfirmed, and blending a single loan's
 *                   LTV across a multi-loan balance was already refute-rejected once: see the
 *                   C-2 note in debt-scoring.ts; a negative balance is excluded outright — see
 *                   the H1 comment below; a rate-colliding ltv is excluded — see round 7 below)
 *   implied value = balance ÷ ltv (mutually consistent by construction for a single loan)
 *   aggregateLtv  = Σ covered balances ÷ Σ implied values
 *
 * The denominator EXCLUDES unlevered-property value entirely (the warehouse has no appraised
 * values — governors.ts header), so this basis OVERSTATES the true portfolio aggregate LTV.
 * Consequence: complete coverage AND ≤ ceiling (+ a float tolerance — see GOVERNOR_LTV_EPSILON)
 * ⇒ the true aggregate is also ≤ ceiling (clearedConservatively: true). Anything else ⇒ false
 * (complete but above the ceiling on this basis — cannot conservatively clear, though not
 * proof of a true breach) or null (incomplete coverage, an empty cohort — see emptyCohort — or
 * every covered loan has a zero balance ⇒ no verdict). Never a fabricated figure (Hard
 * Invariant 7). 2026-07-24 integrity sweep: H1 (balance-sign guard), H2a/H2b (empty-cohort
 * handling), M2 (float epsilon) all hardened this function against false clearances; see each
 * fix's own inline comment below for the concrete attack it closes.
 *
 * ROUND 7 (low-LTV structural defense): H1 excluded a too-LOW aggregate caused by a NEGATIVE
 * balance. It never addressed a too-LOW aggregate caused by a too-LOW but positive ltv — since
 * aggregateLtv reduces to exactly a sole covered loan's own ltv, a too-low value is a false
 * clearance by the same mechanism. Demonstrated attack: a workbook column drift where ltv reads
 * the loan's own interest-rate cell (both small decimals — a drifted 0.065 looks entirely
 * plausible in isolation). No safe magnitude floor exists — this repo's own legitimate low-LTV
 * fixtures go as low as 0.01 (debt-scoring.test.ts), so any floor tight enough to catch a
 * drifted rate value would also reject real near-payoff loans. Instead: cross-check ltv against
 * the SAME loan's own rate (read internally, never returned — see ActiveLoanRow.rate). Exact
 * numeric collision is strong, narrow evidence of the specific column-drift failure (a genuine,
 * independently-set ltv has no causal reason to equal its own loan's rate) — this closes the
 * ONE demonstrated attack, not "any implausible ltv" in general; a broader defense remains a
 * genuinely open question (see the residual note in src/contracts/loan.ts's ltv doc comment).
 * SCOPE: this check protects this aggregate function AND debt-scoring.ts's per-property
 * governor checks (ltvCeiling breach, cash-out gate) — same defect class, separate consumer;
 * scoreDebtPositions's D1 ltv pick applies the identical cross-check (round-7 follow-up
 * commit; there, a collision on ANY loan poisons the whole property's ltv one-directionally
 * — a breach measured on clean rows still fires, only clearance is forbidden) so a drifted
 * value can no longer yield per-property "governors clear" signals feeding
 * capital-allocation.ts. RESIDUAL: debt-api.ts's toLoanSignal (the /maturity ladder's
 * per-loan display hint — explicitly NOT governor enforcement, per its own docblock) still
 * reads the raw ltv column unguarded; a drifted rate-magnitude value there displays 'hold'
 * for a loan whose true ltv may breach. Known follow-up, not bundled here.
 */
export function computePortfolioAggregateLtv(
  db: WarehouseDb,
  governors?: Governors,
): PortfolioAggregateLtv {
  const g = governors ?? loadGovernors(db);
  const loans = activeLoans(db);

  const countByProperty = new Map<string, number>();
  for (const l of loans) {
    if (l.property_id !== null) {
      countByProperty.set(l.property_id, (countByProperty.get(l.property_id) ?? 0) + 1);
    }
  }

  let coveredBalance = 0;
  let coveredImpliedValue = 0;
  let coveredLoanCount = 0;
  let totalBalance = 0;
  for (const l of loans) {
    // coveredBalancePct guard (2026-07-24, refute-review on the H1 fix below): sum over
    // max(balance, 0), not the raw signed value. A negative balance is EXCLUDED from
    // coveredBalance (below) but was still being added to totalBalance uncapped — so a
    // negative row could make coveredBalance/totalBalance exceed 1.0 (a "200% covered"
    // figure is not a real percentage) or, at exactly the wrong magnitude, divide by a
    // near-zero/negative totalBalance and emit nonsense instead of null. Clamping keeps
    // this a genuine coverage fraction in [0, 1] even with a malformed row present.
    totalBalance += Math.max(l.current_balance, 0);
    const soleLoan = l.property_id !== null && countByProperty.get(l.property_id) === 1;
    // H1 (2026-07-24 integrity sweep): current_balance must be NON-NEGATIVE for a loan to
    // count as covered. The original predicate guarded the sign of ltv but not of the
    // balance, and a negative balance contributes a NEGATIVE implied value (balance ÷ ltv) —
    // shrinking the denominator proportionally more than the numerator whenever its ltv
    // exceeds the clean aggregate, and so DEFLATING the reported aggregate. Demonstrated: a
    // real 55%-LTV loan ($4.0M @ 0.55) plus one sign-flipped row (-$2.0M @ 0.90) reported
    // aggregateLtv 0.396 with clearedConservatively=true — a false clearance of the
    // Hard-Invariant-4 40% governor.
    //
    // `>= 0`, not `> 0` (refute-review correction, same day): a genuinely active zero-balance
    // loan (an undrawn revolver, or a blank workbook cell parsed as 0) contributes exactly 0
    // to BOTH sums — it cannot deflate anything, because the deflation mechanism requires a
    // NEGATIVE numerator/denominator contribution. Excluding it too would needlessly downgrade
    // a real, correct clearance (or an explicit above-ceiling breach) to no-verdict for as
    // long as that zero-balance row exists, with no data actually missing. Only a strictly
    // negative balance is excluded, exactly like an unknown LTV: it makes coverage incomplete,
    // forcing the verdict to null. Unknowns are flagged, never guessed.
    const usableBalance = l.current_balance >= 0;
    // Round 7: exclude an ltv that exactly collides with this loan's own rate — see the
    // docblock's ROUND 7 note and RATE_LTV_COLLISION_EPSILON's doc comment. `rate` is read
    // ONLY for this comparison and is never assigned to any output field below.
    const rateCollision =
      l.rate !== null && l.ltv !== null && Math.abs(l.ltv - l.rate) < RATE_LTV_COLLISION_EPSILON;
    if (soleLoan && usableBalance && l.ltv !== null && l.ltv > 0 && !rateCollision) {
      coveredBalance += l.current_balance;
      coveredImpliedValue += l.current_balance / l.ltv;
      coveredLoanCount++;
    }
  }

  const totalLoanCount = loans.length;
  const aggregateLtv = coveredImpliedValue > 0 ? coveredBalance / coveredImpliedValue : null;
  const complete = coveredLoanCount === totalLoanCount; // vacuously true at zero debt
  const emptyCohort = totalLoanCount === 0;

  // H2b (2026-07-24 integrity sweep): an empty cohort is NO LONGER a clearance.
  //
  // This branch previously returned `true` on the reasoning "no active debt ⇒ true aggregate LTV
  // is 0 ⇒ trivially ≤ ceiling". The arithmetic is fine; the PREMISE is not. Zero active rows
  // does not mean "verified unlevered portfolio" — writeDebtSnapshot's stale-supersede clause
  // retires every active row absent from an incoming snapshot, so an empty or zero-borrower
  // snapshot (a parse regression upstream, a bad POST) wipes the entire book, and this function
  // then manufactured a Hard-Invariant-4 CLEARANCE out of the wreckage. The warehouse cannot
  // distinguish "no debt" from "no data", so it must not guess: emptyCohort marks the state and
  // the verdict is null. (writeDebtSnapshot now also refuses the wipe — defence in depth, since
  // a genuinely empty table is still reachable pre-seed.)
  //
  // M2: the ceiling comparison carries GOVERNOR_LTV_EPSILON so the RATIFIED INCLUSIVE ceiling
  // survives floating-point roundtrip and summation-order noise. See the constant's note.
  const clearedConservatively = !complete
    ? null
    : emptyCohort
      ? null
      : aggregateLtv !== null
        ? aggregateLtv <= g.ltvCeiling + GOVERNOR_LTV_EPSILON
        : null; // complete ∧ loans>0 ∧ null aggregate ⇒ all covered balances are 0 (implied
                // value 0) — a degenerate snapshot; no verdict rather than a guessed one

  // Round-2 refute-review correction: this ternary used to be BINARY over what is actually a
  // THREE-way verdict (true / false / null). Once the >=0 relaxation let an all-zero-balance
  // cohort reach `complete: true` with `aggregateLtv: null` (a real, reachable "undrawn
  // revolver only" state — see the coveredImpliedValue===0 branch above), the old `complete ?
  // (clearedConservatively === true ? clearanceNote : aboveCeilingNote) : partialNote` silently
  // routed that null verdict into the ABOVE-CEILING wording — asserting a Hard-Invariant-4
  // breach-direction claim about a comparison that never ran. Never inferred: each of the three
  // clearedConservatively states now gets its own sentence.
  const note = emptyCohort
    ? 'No active debt positions in the warehouse. This is NOT a clearance: an empty cohort is indistinguishable from a wiped or never-loaded snapshot, so no aggregate-LTV verdict is issued. Confirm the debt snapshot loaded before reading this as an unlevered portfolio.'
    : !complete
      ? `Partial coverage (${coveredLoanCount}/${totalLoanCount} active loans; multi-loan properties, negative-balance loans, unknown-LTV/unattributed loans, and loans whose ltv exactly collides with their own rate (a likely column-drift, see round 7) excluded) — no aggregate verdict. See DESIGN.md [GG: confirm] on per-loan LTV semantics.`
      : clearedConservatively === true
        ? 'Complete coverage on an LTV-overstating basis (unlevered-property value excluded from the denominator) — true portfolio aggregate LTV is at or below this figure.'
        : clearedConservatively === false
          ? 'Complete coverage but above the aggregate ceiling on this conservative basis — NOT proof of a true breach (unlevered-property value, absent from the warehouse, would dilute it). Needs appraised values to resolve.'
          : 'Complete coverage but every covered loan carries a zero balance (e.g. undrawn revolvers only) — a degenerate snapshot with no leverage to compute an LTV over. No aggregate-ceiling comparison ran; this is not a breach claim in either direction.';

  return {
    aggregateLtv,
    basis: 'levered-properties-implied-value',
    coveredLoanCount,
    totalLoanCount,
    coveredBalancePct: totalBalance > 0 ? coveredBalance / totalBalance : null,
    complete,
    emptyCohort,
    clearedConservatively,
    note,
  };
}
