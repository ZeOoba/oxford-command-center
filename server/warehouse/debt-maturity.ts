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
}

/** All active debt_positions rows joined to property_master, deterministic order. */
function activeLoans(db: WarehouseDb): ActiveLoanRow[] {
  return db
    .prepare(
      `SELECT d.id, d.property_id, p.name AS property_name, d.loan_name,
              d.current_balance, d.maturity_date, d.months_to_maturity,
              d.is_demand, d.balloon, d.ltv, d.rate_type, d.next_rate_reset
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
        eventDate: row.maturity_date,
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
        minMonthsDate = loan.maturity_date;
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
 *   covered loan  = the ONLY active loan on its property, with known ltv > 0
 *                   (multi-loan properties are excluded — the workbook's per-loan LTV
 *                   semantics for stacked loans are unconfirmed, and blending a single loan's
 *                   LTV across a multi-loan balance was already refute-rejected once: see the
 *                   C-2 note in debt-scoring.ts)
 *   implied value = balance ÷ ltv (mutually consistent by construction for a single loan)
 *   aggregateLtv  = Σ covered balances ÷ Σ implied values
 *
 * The denominator EXCLUDES unlevered-property value entirely (the warehouse has no appraised
 * values — governors.ts header), so this basis OVERSTATES the true portfolio aggregate LTV.
 * Consequence: complete coverage AND ≤ ceiling ⇒ the true aggregate is also ≤ ceiling
 * (clearedConservatively: true). Anything else ⇒ false (complete but above the ceiling on
 * this basis — cannot conservatively clear, though not proof of a true breach) or null
 * (incomplete coverage — no verdict). Never a fabricated figure (Hard Invariant 7).
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
    totalBalance += l.current_balance;
    const soleLoan = l.property_id !== null && countByProperty.get(l.property_id) === 1;
    if (soleLoan && l.ltv !== null && l.ltv > 0) {
      coveredBalance += l.current_balance;
      coveredImpliedValue += l.current_balance / l.ltv;
      coveredLoanCount++;
    }
  }

  const totalLoanCount = loans.length;
  const aggregateLtv = coveredImpliedValue > 0 ? coveredBalance / coveredImpliedValue : null;
  const complete = coveredLoanCount === totalLoanCount; // vacuously true at zero debt
  const clearedConservatively = !complete
    ? null
    : totalLoanCount === 0
      ? true // no active debt — true aggregate LTV is 0
      : aggregateLtv !== null
        ? aggregateLtv <= g.ltvCeiling
        : null; // complete ∧ loans>0 ∧ null aggregate ⇒ all covered balances are 0 (implied
                // value 0) — a degenerate snapshot; no verdict rather than a guessed one

  const note =
    totalLoanCount === 0
      ? 'No active debt positions — portfolio aggregate LTV is 0.'
      : complete
        ? clearedConservatively === true
          ? 'Complete coverage on an LTV-overstating basis (unlevered-property value excluded from the denominator) — true portfolio aggregate LTV is at or below this figure.'
          : 'Complete coverage but above the aggregate ceiling on this conservative basis — NOT proof of a true breach (unlevered-property value, absent from the warehouse, would dilute it). Needs appraised values to resolve.'
        : `Partial coverage (${coveredLoanCount}/${totalLoanCount} active loans; multi-loan properties and unknown-LTV/unattributed loans excluded) — no aggregate verdict. See DESIGN.md [GG: confirm] on per-loan LTV semantics.`;

  return {
    aggregateLtv,
    basis: 'levered-properties-implied-value',
    coveredLoanCount,
    totalLoanCount,
    coveredBalancePct: totalBalance > 0 ? coveredBalance / totalBalance : null,
    complete,
    clearedConservatively,
    note,
  };
}
