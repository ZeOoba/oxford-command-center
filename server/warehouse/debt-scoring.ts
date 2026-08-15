// server/warehouse/debt-scoring.ts
//
// Phase 2 Step 4 — Debt/Refi Scoring Engine
//
// scoreDebtPositions(): pure fn — DSCR/LTV/maturity/debt-yield scoring.
// Ratified decisions:
//   D1 (LTV): debt_positions.ltv (master workbook at snapshot time)
//   D2 (weights): equal-weight 25% each of 4 sub-components
//   D3 (market rate): FRED 5Y Treasury + 200bps spread (passed in, not fetched inline)
// Signal priority: no-debt → governor-block → refi → cash-out → hold
// Score bands: strong≥75, adequate≥50, watch≥25, critical<25
//
// PENDING: adversarial refute pass before this PR merges (financial-decision code)
import type { WarehouseDb } from './db';
import type { PeriodMetrics } from '../../src/contracts/warehouse';
import { loadGovernors } from './governors';
import type { DebtScore, DebtSignal, DebtScoreBand, DebtBookTrust } from '../../src/contracts/debt';
import { readDebtBookTrust } from './debt-trust';
import { clamp } from './clamp';
import { referenceDate } from '../config';
import { MONTH_MS } from './time-constants';
// Module cycle with debt-maturity.ts (it imports effectiveMonthsToMaturity from here) —
// safe: both cross-bindings are consumed only inside function bodies, never at module init.
import { RATE_LTV_COLLISION_EPSILON } from './debt-maturity';

const DEBT_CONFIG = {
  fredSpreadBps: 200,          // D3: spread over 5-Year Treasury
  maturityNormMonths: 36,      // maturity distance normalizer (36 months = full score)
  debtYieldStrong: 0.12,       // debt yield at which maturity sub-component scores 1.0
  scoreBands: {
    strong: 75,                // score >= 75 → 'strong'
    adequate: 50,              // score >= 50 → 'adequate'
    watch: 25,                 // score >= 25 → 'watch'
    // score < 25 → 'critical'
  },
} as const;

/** Map a numeric score to a DebtScoreBand. */
function toBand(score: number): DebtScoreBand {
  if (score >= DEBT_CONFIG.scoreBands.strong) return 'strong';
  if (score >= DEBT_CONFIG.scoreBands.adequate) return 'adequate';
  if (score >= DEBT_CONFIG.scoreBands.watch) return 'watch';
  return 'critical';
}

interface DebtRow {
  id: string;
  property_id: string | null;
  loan_name: string;
  current_balance: number;
  rate: number | null;
  monthly_pmt: number | null;
  annual_interest: number | null;
  annual_principal: number | null;
  is_demand: number;
  maturity_date: string | null;
  months_to_maturity: number | null;
  ltv: number | null;
  status: string;
}

/** Fresh months-to-maturity from maturity_date vs the reference date — NEVER the stored
 * months_to_maturity, a workbook-cell snapshot frozen at whenever the workbook was last
 * recalced/saved, which would otherwise drift from the calendar exactly like the bug class this
 * module's callers now avoid elsewhere (see server/config.ts referenceDate). Falls back to the
 * stored value when maturity_date is absent/unparseable, OR when the computed result itself is
 * non-finite (e.g. an unparseable `asOf` — referenceDate()/REPORT_DATE performs no validation) —
 * checking only the intermediate maturityMs would let a NaN asOf silently produce a NaN months
 * value that then poisons minMonthsToMaturity/maturityComp/DebtScore.score.
 *
 * is_demand is checked FIRST and wins regardless of maturity_date: F3 (ratified) requires a
 * demand note to never pass the >24mo cash-out gate because it is callable immediately. The
 * workbook parser enforces maturity=null for every is_demand row, but debt-api.ts's POST
 * /snapshot route performs zero schema validation on its JSON payload, so is_demand=1 with a
 * populated maturity_date is a reachable (if malformed) row — treating "no date" as the sole
 * demand-note signal would let such a row silently clear the cash-out gate.
 *
 * Exported (structural MaturityInputRow param) so debt-maturity.ts reuses this ratified
 * fresh-recompute + demand-first logic instead of duplicating the date math. */
export interface MaturityInputRow {
  is_demand: number;
  maturity_date: string | null;
  months_to_maturity: number | null;
}
export function effectiveMonthsToMaturity(row: MaturityInputRow, asOf: string): number | null {
  if (row.is_demand) return null;
  const maturityMs = row.maturity_date ? new Date(row.maturity_date).getTime() : NaN;
  const asOfMs = new Date(asOf).getTime();
  const fresh = (maturityMs - asOfMs) / MONTH_MS;
  return Number.isFinite(fresh) ? fresh : row.months_to_maturity;
}

/**
 * Score all active debt positions for each property.
 *
 * @param db - Warehouse DB connection
 * @param metrics - All PeriodMetrics (Spine B ledger basis) — used as the NOI source
 * @param marketRateFiveYearTreasury - FRED 5Y Treasury rate as a decimal (e.g. 0.045 = 4.5%);
 *   null when FRED is unavailable — refi signal is suppressed when null
 * @param referenceDateIso - day-count reference (YYYY-MM-DD), defaults to referenceDate() (see
 *   server/config.ts). Anchors the fresh months-to-maturity recompute that drives
 *   minMonthsToMaturity / the cash-out gate / maturityComp.
 */
/**
 * Round 19g (adversarial refute of 19f, HIGH — reproduced): 19f made scoreDebtPositions read
 * readDebtBookTrust ITSELF, closing the CRITICAL per-score-vs-envelope disagreement — but every
 * production caller that ALSO needs the book trust for its own envelope/verdict (GET /scores, GET
 * /refi-windows, buildPortfolioAllocation, buildCapitalAllocationReport) then called
 * readDebtBookTrust(db) A SECOND TIME, in a separate transaction. Reproduced: a healing or
 * damaging write landing between the two calls reopens the identical contradiction one call
 * deeper — `scores[].bookTrust` from the FIRST read disagreeing with the envelope's own
 * `bookTrust` from the SECOND, in the same response. `scores[0]?.bookTrust` is not a fix either:
 * the empty-scores case (total destruction, or an all-unattributed book) is exactly when trust
 * matters most, and is exactly the case that fallback has nothing to read.
 *
 * scoreDebtPositionsWithTrust is the ONE atomic read: marker, both loan counts, and every row this
 * engine scores, in a single transaction, returning the trust value it actually used alongside the
 * scores it computed from it. Every production caller must use THIS function and consume the
 * returned bookTrust directly — never re-read trust afterward. `scoreDebtPositions` below is kept
 * as a thin wrapper purely so the ~80 existing unit tests that call it directly (testing pure
 * scoring math against a fixed DB snapshot, where no concurrent write is possible) do not all need
 * rewriting for a concern that does not apply to them.
 */
export function scoreDebtPositionsWithTrust(
  db: WarehouseDb,
  metrics: PeriodMetrics[],
  marketRateFiveYearTreasury: number | null,
  referenceDateIso: string = referenceDate(),
): { scores: DebtScore[]; bookTrust: DebtBookTrust } {
  const governors = loadGovernors(db);

  // Round 19 (H1 — 2026-07-27 integrity sweep, HIGH, reproduced end-to-end and found
  // independently by all three refuter lenses): read the snapshot trust marker HERE, inside the
  // engine, rather than expecting each of the five call sites to remember. The marker existed for
  // five rounds with exactly ONE consumer (computePortfolioAggregateLtv) while scoreDebtPositions,
  // GET /scores, GET /refi-windows, buildPortfolioAllocation (×2) and the new permanent
  // debt_scores writer all scored the same distrusted rows blind. Adding the check at the call
  // sites would have fixed the five that exist today and left the sixth — added next month — to
  // repeat the defect. Reading it where the ROWS are read means a consumer cannot forget, because
  // it never has to remember.
  //
  // Read in the same transaction as the row reads (see the single db.transaction below),
  // mirroring the round-10 fix in computePortfolioAggregateLtv: as separate autocommit reads, the
  // documented dev-server + backfill-CLI concurrency can commit a healing write between them and
  // pair pre-heal rows with a freshly cleared marker — the exact class the marker exists to
  // prevent.

  // Precompute: market rate proxy (D3)
  const marketRate =
    marketRateFiveYearTreasury !== null
      ? marketRateFiveYearTreasury + DEBT_CONFIG.fredSpreadBps / 10_000
      : null;

  // Precompute: index PeriodMetrics by propertyId → latest full-year NOI (Spine B)
  // A "latest full-year period" is the most recent period where grainHint === 'year'
  // (not a partial year like "2026-Q1" or a YTD). This matches latestFullYearPeriod()
  // logic in metrics.ts.
  const noiByProperty = new Map<string, number>();
  {
    // Group by propertyId, find latest full-year period, extract noi
    const latestPeriodByProperty = new Map<string, string>();
    for (const m of metrics) {
      if (m.grainHint !== 'year') continue;
      const existing = latestPeriodByProperty.get(m.propertyId);
      if (existing === undefined || m.period.localeCompare(existing) > 0) {
        latestPeriodByProperty.set(m.propertyId, m.period);
      }
    }
    for (const m of metrics) {
      if (m.grainHint !== 'year') continue;
      const latestPeriod = latestPeriodByProperty.get(m.propertyId);
      if (latestPeriod !== undefined && m.period === latestPeriod) {
        noiByProperty.set(m.propertyId, m.noi);
      }
    }
  }

  // Get all distinct active property_ids from debt_positions
  const selectActiveProperties = db.prepare(
    `SELECT DISTINCT property_id
     FROM debt_positions
     WHERE status = 'active' AND property_id IS NOT NULL`,
  );

  // F5: ORDER BY current_balance DESC, id ASC ensures deterministic LTV tie-break when two
  // loans share the same current_balance. Without ORDER BY, SQLite row order is unspecified.
  // 2026-07-25 hardening: `, snapshot_date DESC` closes a residual non-total-sort gap — debt_
  // positions' PRIMARY KEY is (id, snapshot_date), not id alone, so two ACTIVE rows can share an
  // id at different snapshot_dates (unreachable via writeDebtSnapshot's transactional supersede
  // today, but not prevented by the schema). Without this key, id ASC does not fully order such
  // a pair and the tie falls through to unspecified physical row order — empirically proven
  // insertion-order-sensitive (see the '2026-07-25 hardening' describe block in
  // debt-scoring.test.ts), which could silently flip a property's D1 LTV pick between a clean
  // and a governor-breaching value. snapshot_date DESC prefers the freshest row on a genuine tie,
  // matching the property's PK-declared recency ordering; zero behavior change when ids are
  // unique among active rows (the app's own actual state today).
  const getLoansForProperty = db.prepare<[string]>(
    `SELECT id, property_id, loan_name, current_balance, rate,
            monthly_pmt, annual_interest, annual_principal,
            is_demand, maturity_date, months_to_maturity, ltv, status
     FROM debt_positions
     WHERE property_id = ? AND status = 'active'
     ORDER BY current_balance DESC, id ASC, snapshot_date DESC`,
  );

  const getPropertyName = db.prepare<[string]>(
    `SELECT name FROM property_master WHERE id = ?`,
  );

  // Round 19 (H1): ONE transaction for the trust marker AND every row this engine scores, so all
  // of them observe a single database snapshot. Reading the marker separately would let a healing
  // (or damaging) write commit in between and pair rows with the wrong trust state.
  //
  // Round 19f (adversarial refute of 19e, CRITICAL — reproduced): this used to read ONLY the raw
  // marker (readLastSnapshotRefusal), while round 19e taught readDebtBookTrust a SECOND way to
  // reach 'degraded' — an unattributed active loan (property_id NULL), with no marker required.
  // That second path was wired into every REPORTING surface (the /scores, /maturity, /timeline
  // envelopes, capital-allocation's book-level trust) but never into WITHHOLDING: this engine kept
  // reading the marker alone, so an unattributed loan sitting alongside an attributed one produced
  // full, un-withheld DSCR/LTV — even a 'refinance'/'cash-out' action — on a score whose own
  // envelope simultaneously reported bookTrust:'degraded'. Reproduced: DSCR 2.00x, signal
  // 'cash-out', action 'refinance', empty rationale, while the response envelope said 'degraded'
  // and the entry's own dataQuality flag said "DSCR/LTV are withheld entirely." One helper for
  // REPORTING trust is not the same guarantee as one gate for WITHHOLDING it — readDebtBookTrust
  // is now the single source for BOTH, closing the gap at its root rather than patching each
  // consumer's display logic separately.
  const { bookTrust, activePropertyIds, loansByProperty, nameByProperty } = db.transaction(() => {
    const trust = readDebtBookTrust(db);
    const ids = (selectActiveProperties.all() as Array<{ property_id: string }>).map(
      (r) => r.property_id,
    );
    const loansBy = new Map<string, DebtRow[]>();
    const nameBy = new Map<string, string>();
    for (const id of ids) {
      loansBy.set(id, getLoansForProperty.all(id) as DebtRow[]);
      const nameRow = getPropertyName.get(id) as { name: string } | undefined;
      nameBy.set(id, nameRow?.name ?? id);
    }
    return { bookTrust: trust, activePropertyIds: ids, loansByProperty: loansBy, nameByProperty: nameBy };
  })();

  const scores: DebtScore[] = [];

  for (const propertyId of activePropertyIds) {
    const loans = loansByProperty.get(propertyId) ?? [];
    const propertyName = nameByProperty.get(propertyId) ?? propertyId;

    // === no-debt branch (handled at query level — no active loans for propertyId) ===
    // If loans is empty here, the property had its rows deleted between the DISTINCT query and now;
    // treat as no-debt. In practice the DISTINCT query only returns IDs with ≥1 active row.
    if (loans.length === 0) {
      scores.push({
        propertyId,
        propertyName,
        noiBasis: 'spine-b/warehouse-ledger',
        dscr: null,
        dscrHeadroom: null,
        ltv: null,
        ltvHeadroom: null,
        debtYield: null,
        signal: 'no-debt',
        signalReason: 'No active debt positions',
        score: 100,
        scoreBand: 'strong',
        capitalConfigVersion: governors.version,
        refiCashSavingsPct: null,
        bookTrust: 'trusted', // overwritten by applyBookTrust below when the book is distrusted
      });
      continue;
    }

    // === Compute annual debt service ===
    let annualDebtService: number | null = null;
    {
      let sum = 0;
      let hasUnknownLoan = false;
      for (const loan of loans) {
        if (loan.monthly_pmt !== null) {
          sum += loan.monthly_pmt * 12;
        } else if (loan.annual_interest !== null && loan.annual_principal !== null) {
          // R1: BOTH fields must be known before treating the pair as a real total — a single
          // known field (e.g. principal) standing in for the other via `?? 0` previously let a
          // genuinely unrecorded interest amount silently vanish, understating debt service and
          // therefore inflating DSCR past the governor floor on data that was actually incomplete.
          sum += loan.annual_interest + loan.annual_principal;
        } else {
          hasUnknownLoan = true;
        }
      }
      // F4: separate "no payment data" from "fields present but sum to 0" — a legitimate zero
      // means fully paid down, not unknown. R1: ANY loan with an unresolvable pair forces the
      // WHOLE property's annualDebtService to unknown (mirrors hasUnknownMaturity below) — a
      // partial sum that silently omits one loan's payment is not a true total, and presenting
      // it as one would fabricate completeness the data doesn't have (Hard Invariant 7).
      annualDebtService = hasUnknownLoan ? null : sum;
    }

    // === Get NOI from PeriodMetrics (Spine B) ===
    // SPINE-B NOI: use warehouse ledger NOI from PeriodMetrics, NOT Spine A Property.noi.
    // These are independent computations with no reconciliation check. Mixing them produces
    // a basis mismatch — see architecture/system-overview.md §2 NOI-spine-split warning.
    const noi = noiByProperty.get(propertyId) ?? null;

    // === Derived values ===
    const dscr =
      noi !== null && annualDebtService !== null && annualDebtService > 0
        ? noi / annualDebtService
        : null;
    const dscrHeadroom = dscr !== null ? dscr - governors.dscrFloor : null;

    // D1: LTV from highest-balance loan.
    // Round 7 follow-up (see computePortfolioAggregateLtv's ROUND 7 docblock in
    // debt-maturity.ts): an ltv that exactly equals its own loan's rate (within
    // RATE_LTV_COLLISION_EPSILON) is the demonstrated workbook column-drift signature — the
    // ltv column read the loan's own interest-rate cell. Such a value is never trusted as
    // data. A collision on ANY loan poisons the WHOLE property's ltv, not just that row
    // (refute-review correction, same change): a same-row collision is evidence the ltv
    // COLUMN drifted for this snapshot, so a sibling row's non-colliding value is not thereby
    // trustworthy — falling through to it let a property whose dominant loan carried
    // detected-corrupt data clear governors off the minority loan. Mirrors R1's
    // annualDebtService and F3's hasUnknownMaturity any-loan-poisons semantics, and the
    // aggregate's complete=false stance on identical evidence. Unknown governor → hold via
    // the F1/F2 handling below, never a fabricated clearance. The collided row's `rate` needs
    // no separate exclusion from avgLoanRate: the signature cannot say WHICH column drifted,
    // but every action signal (refi, cash-out, refiCashSavingsPct) requires governorsClear,
    // which a collision now forces false — a corrupt rate can never drive an action.
    //
    // Poisoning is ONE-DIRECTIONAL (second refute-review correction): if the pick computed
    // from the NON-collided rows already BREACHES the ceiling, it is kept, so isGovernorBlock
    // still fires with the measured value ('fires even on partial knowledge' — matching the
    // DSCR side, which also still fires on a collided snapshot). Suppressing a clean row's
    // measured breach because a sibling collided would trade a real Hard-Invariant-4 alarm
    // for data-quality caution in the wrong direction. Only a non-breaching (would-be
    // clearing) pick degrades to unknown.
    let ltv: number | null = null;
    let hasCollidedLtv = false;
    {
      let maxBalance = -Infinity;
      for (const loan of loans) {
        const rateCollision =
          loan.rate !== null &&
          loan.ltv !== null &&
          Math.abs(loan.ltv - loan.rate) < RATE_LTV_COLLISION_EPSILON;
        if (rateCollision) {
          hasCollidedLtv = true;
          continue;
        }
        if (loan.ltv !== null && loan.current_balance > maxBalance) {
          maxBalance = loan.current_balance;
          ltv = loan.ltv;
        }
      }
      // The keep predicate MUST stay the exact complement of governorsClear's LTV conjunct
      // (`ltv <= governors.ltvCeiling`, below): kept ⇒ isGovernorBlock fires, nulled ⇒ hold —
      // no gap. Do NOT "harmonize" it with the aggregate's GOVERNOR_LTV_EPSILON; an epsilon
      // here would open a kept-but-not-blocked sliver on a poisoned snapshot.
      if (hasCollidedLtv && !(ltv !== null && ltv > governors.ltvCeiling)) ltv = null;
    }
    const ltvHeadroom = ltv !== null ? governors.ltvCeiling - ltv : null;

    const totalBalance = loans.reduce((acc, l) => acc + l.current_balance, 0);
    const debtYield =
      noi !== null && totalBalance > 0 ? noi / totalBalance : null;

    // Weighted-average loan rate by current_balance (skip null-rate loans)
    let avgLoanRate: number | null = null;
    {
      let weightedSum = 0;
      let totalWeight = 0;
      for (const loan of loans) {
        if (loan.rate !== null) {
          weightedSum += loan.rate * loan.current_balance;
          totalWeight += loan.current_balance;
        }
      }
      avgLoanRate = totalWeight > 0 ? weightedSum / totalWeight : null;
    }

    // Min months to maturity (soonest maturity is binding), computed fresh per-loan from
    // maturity_date vs the reference date (effectiveMonthsToMaturity) — NEVER the stale stored
    // column directly.
    // F3: a loan with NO known maturity (neither a fresh maturity_date nor a stored fallback —
    // a true demand note) must NOT be treated as "far away" via ?? 999; it is callable immediately.
    // F3 edge case (CodeRabbit): mixed portfolios (demand note + term loan) must also block
    // cash-out. hasUnknownMaturity tracks whether ANY loan had no determinable maturity; after
    // the loop, if true, minMonthsToMaturity is forced to null so the cash-out gate fails.
    let minMonthsToMaturity: number | null = null;
    let hasUnknownMaturity = false;
    {
      for (const loan of loans) {
        const months = effectiveMonthsToMaturity(loan, referenceDateIso);
        if (months === null) {
          hasUnknownMaturity = true; // demand/unknown — track it
          continue;
        }
        if (minMonthsToMaturity === null || months < minMonthsToMaturity) {
          minMonthsToMaturity = months;
        }
      }
      if (hasUnknownMaturity) minMonthsToMaturity = null;
    }

    // === Signal logic (first match wins) ===
    let signal: DebtSignal;
    let signalReason: string;

    // Known breach on either governor → governor-block (fires even on partial knowledge)
    const isGovernorBlock =
      (dscr !== null && dscr < governors.dscrFloor) ||
      (ltv !== null && ltv > governors.ltvCeiling);

    // F1 + F2: action signals (refi, cash-out) require AFFIRMATIVE governor clearance —
    // both governors must be KNOWN and PASSING. Unknown governors are not cleared governors.
    // Rationale: recommending refinancing or cash-out with zero DSCR/LTV knowledge is a
    // capital-allocation error. Unknown → hold, not action.
    const governorsClear =
      dscr !== null && dscr >= governors.dscrFloor &&
      ltv !== null && ltv <= governors.ltvCeiling;

    if (isGovernorBlock) {
      signal = 'governor-block';
      if (dscr !== null && dscr < governors.dscrFloor) {
        signalReason = `DSCR ${dscr.toFixed(2)}x below floor ${governors.dscrFloor}x`;
      } else {
        signalReason = `LTV ${((ltv ?? 0) * 100).toFixed(1)}% above ceiling ${(governors.ltvCeiling * 100).toFixed(1)}%`;
      }
    } else if (!governorsClear) {
      // Unknown governor — cannot recommend action signals; fall through to hold.
      signal = 'hold';
      // The collision path gets its own text (refute-review correction, same change): the
      // generic "column is unpopulated" remediation is an impossible errand when the cell IS
      // populated with a drifted value — the fix is the workbook's ltv column MAPPING, not
      // the data, and re-running the snapshot unchanged reproduces the hold forever. The
      // non-collision branches keep their pre-change literals byte-identical.
      const collidedLtvText =
        "LTV rejected — ltv exactly collides with its own loan's rate (workbook column-drift signature); fix the workbook ltv column mapping, then re-run snapshot";
      if (dscr === null && ltv === null) {
        signalReason = hasCollidedLtv
          ? `Governor check skipped — DSCR unknown (no warehouse NOI for this property); ${collidedLtvText}`
          : 'Governor check skipped — DSCR unknown (no warehouse NOI for this property); LTV unknown at snapshot time. Re-run after populating both.';
      } else if (dscr === null) {
        signalReason =
          'Governor check skipped — DSCR unknown (no warehouse NOI for this property)';
      } else {
        signalReason = hasCollidedLtv
          ? `Governor check incomplete — ${collidedLtvText}`
          : 'Governor check incomplete — LTV unknown at snapshot time; re-run snapshot after workbook LTV column is populated';
      }
    } else if (
      marketRate !== null &&
      avgLoanRate !== null &&
      avgLoanRate > marketRate + governors.refiTriggerBps / 10_000
    ) {
      // governorsClear is true here (checked above)
      signal = 'refi';
      signalReason = `In-place rate ${(avgLoanRate * 100).toFixed(2)}% exceeds market proxy ${(marketRate * 100).toFixed(2)}% by ${Math.round((avgLoanRate - marketRate) * 10_000)}bps`;
    } else if (
      dscrHeadroom !== null &&
      dscrHeadroom > 0.5 &&
      ltvHeadroom !== null &&
      ltvHeadroom > 0.10 &&
      // F3: demand notes (null maturity) must NOT pass. null ?? 999 was wrong — demand notes
      // are callable immediately. Require an explicitly known maturity > 24 months.
      // Also block if ANY loan has unknown maturity (mixed-loan cases with demand notes).
      minMonthsToMaturity !== null &&
      !hasUnknownMaturity &&
      minMonthsToMaturity > 24
    ) {
      // governorsClear is true here (checked above)
      signal = 'cash-out';
      signalReason = `Headroom: DSCR +${dscrHeadroom.toFixed(2)}x, LTV headroom ${(ltvHeadroom * 100).toFixed(1)}%, ${Math.round(minMonthsToMaturity)}mo to maturity`;
    } else {
      signal = 'hold';
      if (dscr !== null && ltv !== null) {
        signalReason = `Governors clear; DSCR ${dscr.toFixed(2)}x, LTV ${(ltv * 100).toFixed(1)}%`;
      } else if (dscr !== null) {
        signalReason = `Governors clear; DSCR ${dscr.toFixed(2)}x`;
      } else if (ltv !== null) {
        signalReason = `Governors clear; LTV ${(ltv * 100).toFixed(1)}%`;
      } else {
        signalReason = 'Governors clear; insufficient data for DSCR/LTV assessment';
      }
    }

    // === Score sub-components (each [0, 1], null inputs use 0.5 neutral) ===
    const dscrComp =
      dscrHeadroom !== null
        ? clamp(dscrHeadroom / governors.dscrFloor, 0, 1)
        : 0.5;
    const ltvComp =
      ltvHeadroom !== null
        ? clamp(ltvHeadroom / governors.ltvCeiling, 0, 1)
        : 0.5;
    const maturityComp =
      minMonthsToMaturity !== null
        ? clamp(minMonthsToMaturity / DEBT_CONFIG.maturityNormMonths, 0, 1)
        : 0.5;
    const debtYieldComp =
      debtYield !== null
        ? clamp(debtYield / DEBT_CONFIG.debtYieldStrong, 0, 1)
        : 0.5;

    const rawScore =
      ((dscrComp + ltvComp + maturityComp + debtYieldComp) / 4) * 100;
    const score = clamp(Math.round(rawScore), 0, 100);
    // R3: dscrComp/ltvComp default to a "neutral" 0.5 when dscr/ltv is unknown (lines above), so
    // a property whose DSCR or LTV governor was never actually verified can still land a high
    // rawScore purely from the other components' neutral fill — reading as 'strong'/'adequate'
    // when `signal` itself is 'hold' precisely because a governor input is unverified. Cap the
    // band (never raise it) so 'strong'/'adequate' require governorsClear; a band that already
    // computed 'watch'/'critical' on its own merits is left alone.
    const rawBand = toBand(score);
    const scoreBand =
      governorsClear || (rawBand !== 'strong' && rawBand !== 'adequate')
        ? rawBand
        : 'watch';

    // C-2: post-refi annualized cash savings as % of equity. Undrivable (any input
    // missing, a leveraged-to-zero/negative-equity property, or >1 active loan) → null,
    // never a guess. value is derived from totalBalance / ltv — but D1's `ltv` is the
    // HIGHEST-BALANCE loan's own LTV (a governor-check figure), not a blended combined-loan
    // LTV. Applying it to totalBalance across multiple loans manufactures a value/equity
    // figure with no real basis (refute-verified defect), so this is restricted to
    // single-loan properties, where the single loan's balance/ltv/rate are mutually
    // consistent by construction.
    // R2: also gated on governorsClear — as ltv approaches 1.0, `value - totalBalance` (equity)
    // approaches zero and the ratio diverges into a triple-digit, no-real-basis "savings" figure;
    // that only happens above the governor's own 40% ceiling, so requiring governorsClear both
    // bounds the ratio to a sane range AND stops a governor-blocked property from surfacing a
    // headline savings number alongside the block signal.
    let refiCashSavingsPct: number | null = null;
    if (loans.length === 1 && governorsClear) {
      const currentAnnualInterest = avgLoanRate !== null ? avgLoanRate * totalBalance : null;
      const refiAnnualInterest = marketRate !== null ? marketRate * totalBalance : null;
      const value = ltv !== null && ltv > 0 ? totalBalance / ltv : null;
      const equity = value !== null ? value - totalBalance : null;
      if (
        currentAnnualInterest !== null &&
        refiAnnualInterest !== null &&
        equity !== null &&
        equity > 0
      ) {
        refiCashSavingsPct = (currentAnnualInterest - refiAnnualInterest) / equity;
      }
    }

    scores.push({
      propertyId,
      propertyName,
      noiBasis: 'spine-b/warehouse-ledger',
      dscr,
      dscrHeadroom,
      ltv,
      ltvHeadroom,
      debtYield,
      signal,
      signalReason,
      score,
      scoreBand,
      capitalConfigVersion: governors.version,
      refiCashSavingsPct,
      bookTrust: 'trusted', // overwritten by applyBookTrust below when the book is distrusted
    });
  }

  // Round 19 (H1): every score leaves through this one transform, so no branch above can emit a
  // governor verdict the warehouse itself distrusts.
  return { scores: applyBookTrust(scores, bookTrust), bookTrust };
}

/**
 * Thin wrapper over scoreDebtPositionsWithTrust for callers (and the existing unit-test suite)
 * that only need the scores, not the book trust. See that function's docblock — production
 * callers that ALSO need trust for their own envelope/verdict must call
 * scoreDebtPositionsWithTrust directly and consume its returned bookTrust, never re-derive it.
 */
export function scoreDebtPositions(
  db: WarehouseDb,
  metrics: PeriodMetrics[],
  marketRateFiveYearTreasury: number | null,
  referenceDateIso: string = referenceDate(),
): DebtScore[] {
  return scoreDebtPositionsWithTrust(db, metrics, marketRateFiveYearTreasury, referenceDateIso)
    .scores;
}

/**
 * Score band FLOOR for a 'degraded' property — applied as a cap, never as a raise.
 *
 * Round 19b (adversarial refute, MEDIUM — reproduced): round 19a assigned this band
 * UNCONDITIONALLY, so a property scoring 12 / band 'critical' (a real DSCR 1.10 + LTV 0.55 double
 * breach) was UPGRADED to 'watch' the moment the book degraded. That is the opposite of
 * withholding: `ScorecardView` computes its red "N critical" badge as
 * `scores.filter(s => s.scoreBand === 'critical').length`, so the badge for a known-breaching
 * property disappeared exactly when the system went blind. It also contradicted this module's own
 * precedent ~120 lines above, which caps the band and never raises it.
 */
const DEGRADED_SCORE_BAND: DebtScoreBand = 'watch';

/**
 * Score ceiling under a 'degraded' book. The underlying number is meaningless once rows are
 * missing, but `score` is a required 0-100 field that feeds ranking, so it is CAPPED rather than
 * invented: a distrusted property can never outrank a verified one, and the companion
 * bookTrust/scoreBand/signalReason fields carry the real "we do not know" signal.
 */
const DEGRADED_SCORE_CAP = 50;

/**
 * Apply the book's derived trust level to a set of freshly computed DebtScores.
 *
 * Precedence mirrors computePortfolioAggregateLtv's, per-property (round 10's ratified split):
 *
 *   'trusted' / 'unknown' — no withholding. 'unknown' is reachable here only in principle (a
 *                book-wide zero-active-row state means no property would have a score to begin
 *                with), kept as a no-op rather than a throw so the function stays total over the
 *                DebtBookTrust type.
 *
 *   'refused'  — the write was DECLINED, so zero rows changed and these ARE the last trusted
 *                book. The measured numbers survive and a measured BREACH still fires — nulling
 *                it would silence a standing Hard-Invariant-4 alarm at exactly the moment the
 *                system is last-known-in-breach AND blind. Only the CLEARANCE-direction action
 *                signals ('refi', 'cash-out') are demoted to 'hold', because acting on a book the
 *                warehouse just declined to update is acting on knowingly stale data.
 *
 *   'degraded' — some portion of the book cannot be reasoned about, either because rows were
 *                LOST (a marker stands) or because an active loan sits UNATTRIBUTED (round 19e:
 *                readDebtBookTrust also returns 'degraded' for property_id IS NULL rows, with no
 *                marker required — the same withholding applies regardless of which condition
 *                triggered it, because both leave the same book incomplete in the same way). The
 *                survivors are an incomplete remnant and every governor-derived figure computed
 *                from them is fabricated in either direction, so dscr / ltv / their headrooms /
 *                debtYield / refiCashSavingsPct are all withheld and the signal collapses to
 *                'hold'. Reproduced (marker case): a property whose true DSCR is 0.71x (a real
 *                governor-block) reported "Governors clear; DSCR 1.67x" once one of its two loans
 *                was destroyed. Reproduced (round 19f, unattributed case): a property with an
 *                unattributed sibling loan reported DSCR 2.00x and action 'refinance' while its
 *                own response envelope said bookTrust:'degraded'.
 *
 * Deliberately NOT 'no-debt' and NOT 'governor-block' under 'degraded': 'no-debt' reads as a
 * verified unlevered property (capital allocation treats it as free to lever), and
 * 'governor-block' asserts a breach this data cannot support either. 'hold' is the only existing
 * signal that asserts nothing.
 */
export function applyBookTrust(scores: DebtScore[], trust: DebtBookTrust): DebtScore[] {
  if (trust === 'trusted' || trust === 'unknown') return scores;

  return scores.map((s) => {
    if (trust === 'refused') {
      const demoted = s.signal === 'refi' || s.signal === 'cash-out';
      // Round 19b (adversarial refute, MEDIUM — reproduced): the staleness note was attached to
      // the DEMOTION, not to the trust state. A property already sitting at 'hold' (e.g. governors
      // clear but ltvHeadroom too thin for the cash-out gate) therefore kept asserting
      // "Governors clear; DSCR 1.60x, LTV 35.0%" verbatim and unannotated, off a book the
      // warehouse had just declined to update. signalReason is the human-facing scorecard string
      // and is persisted into debt_scores.signal_reason, so the unannotated claim outlives the
      // incident. Annotate on TRUST, not on demotion.
      const staleNote =
        'the last debt snapshot write was REFUSED, so this book may be stale (figures are the last trusted book)';
      return {
        ...s,
        signal: demoted ? ('hold' as DebtSignal) : s.signal,
        signalReason: `${s.signalReason ?? ''} — ${demoted ? 'action withheld: ' : ''}${staleNote}`.trim(),
        bookTrust: trust,
      };
    }
    return {
      ...s,
      dscr: null,
      dscrHeadroom: null,
      ltv: null,
      ltvHeadroom: null,
      debtYield: null,
      refiCashSavingsPct: null,
      signal: 'hold' as DebtSignal,
      // Round 19f: this text used to name only the marker-loss cause ("see the debt-snapshot
      // refusal marker"), which is wrong for the round-19e unattributed-loan trigger — no marker
      // exists in that case, and a reader sent to look for one would find nothing standing.
      signalReason:
        'Book state not trusted: the debt book is incomplete — either the last snapshot write ' +
        'lost rows (see the debt-snapshot refusal marker), or an active loan could not be ' +
        'attributed to a property. Per-property DSCR/LTV computed from the surviving/incomplete ' +
        'rows would be fabricated in either direction, so no governor verdict is reported.',
      score: Math.min(s.score, DEGRADED_SCORE_CAP),
      // Cap, never raise (round 19b). 'critical' is a worse band than DEGRADED_SCORE_BAND, so a
      // property already known to be critical keeps that band — withholding a verdict must never
      // improve a property's standing.
      scoreBand: s.scoreBand === 'critical' ? 'critical' : DEGRADED_SCORE_BAND,
      bookTrust: trust,
    };
  });
}

/**
 * Score a property with no active debt — exported for callers that know a property
 * has no loans and want a consistent no-debt DebtScore without a DB query.
 */
export function noDebtScore(
  propertyId: string,
  propertyName: string,
  capitalConfigVersion: number,
  /**
   * Round 19b: REQUIRED, not defaulted. This helper previously hardcoded `bookTrust: 'trusted'`
   * behind a prose warning — the last remaining way to mint a trusted DebtScore without
   * consulting the marker, in a module whose whole H1 rationale is "a consumer cannot forget,
   * because it never has to remember." A prose comment is exactly what failed for five rounds.
   * The parameter has no default so the compiler forces every future call site to answer.
   */
  bookTrust: DebtBookTrust,
): DebtScore {
  return {
    propertyId,
    propertyName,
    noiBasis: 'spine-b/warehouse-ledger',
    dscr: null,
    dscrHeadroom: null,
    ltv: null,
    ltvHeadroom: null,
    debtYield: null,
    signal: 'no-debt',
    signalReason: 'No active debt positions',
    score: 100,
    scoreBand: 'strong',
    capitalConfigVersion,
    refiCashSavingsPct: null,
    // Callers deriving "no debt" from an ABSENCE in scoreDebtPositions' output must pass the
    // book's real trust level here — under a degraded book an absent score means "its loans were
    // destroyed", not "unlevered". Only a caller with independent knowledge that the property has
    // no debt may pass 'trusted'.
    bookTrust,
  };
}
