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
import type { DebtScore, DebtSignal, DebtScoreBand } from '../../src/contracts/debt';
import { clamp } from './clamp';
import { todayEastern, MONTH_MS } from './time-constants';

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
  maturity_date: string | null;
  months_to_maturity: number | null;
  ltv: number | null;
  status: string;
}

/** Fresh months-to-maturity from maturity_date vs asOf — NEVER the stored months_to_maturity, a
 * workbook-cell snapshot frozen at whenever the workbook was last recalced/saved, which would
 * otherwise drift from the calendar exactly like the bug class this module's callers now avoid
 * elsewhere. Falls back to the stored value only when maturity_date is absent or unparseable. */
function effectiveMonthsToMaturity(row: DebtRow, asOf: string): number | null {
  const maturityMs = row.maturity_date ? new Date(row.maturity_date).getTime() : NaN;
  return Number.isFinite(maturityMs) ? (maturityMs - new Date(asOf).getTime()) / MONTH_MS : row.months_to_maturity;
}

/**
 * Score all active debt positions for each property.
 *
 * @param db - Warehouse DB connection
 * @param metrics - All PeriodMetrics (Spine B ledger basis) — used as the NOI source
 * @param marketRateFiveYearTreasury - FRED 5Y Treasury rate as a decimal (e.g. 0.045 = 4.5%);
 *   null when FRED is unavailable — refi signal is suppressed when null
 * @param asOf - defaults to real today (Eastern, injectable in tests). Anchors the fresh
 *   months-to-maturity recompute that drives minMonthsToMaturity / the cash-out gate / maturityComp.
 */
export function scoreDebtPositions(
  db: WarehouseDb,
  metrics: PeriodMetrics[],
  marketRateFiveYearTreasury: number | null,
  asOf: string = todayEastern(),
): DebtScore[] {
  const governors = loadGovernors(db);

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
  const propertyRows = db
    .prepare(
      `SELECT DISTINCT property_id
       FROM debt_positions
       WHERE status = 'active' AND property_id IS NOT NULL`,
    )
    .all() as Array<{ property_id: string }>;

  const activePropertyIds = propertyRows.map((r) => r.property_id);

  // F5: ORDER BY current_balance DESC, id ASC ensures deterministic LTV tie-break when two
  // loans share the same current_balance. Without ORDER BY, SQLite row order is unspecified.
  const getLoansForProperty = db.prepare<[string]>(
    `SELECT id, property_id, loan_name, current_balance, rate,
            monthly_pmt, annual_interest, annual_principal,
            maturity_date, months_to_maturity, ltv, status
     FROM debt_positions
     WHERE property_id = ? AND status = 'active'
     ORDER BY current_balance DESC, id ASC`,
  );

  const getPropertyName = db.prepare<[string]>(
    `SELECT name FROM property_master WHERE id = ?`,
  );

  const scores: DebtScore[] = [];

  for (const propertyId of activePropertyIds) {
    const loans = getLoansForProperty.all(propertyId) as DebtRow[];

    // Lookup property name
    const nameRow = getPropertyName.get(propertyId) as { name: string } | undefined;
    const propertyName = nameRow?.name ?? propertyId;

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
      });
      continue;
    }

    // === Compute annual debt service ===
    let annualDebtService: number | null = null;
    {
      let sum = 0;
      let anyNonNull = false;
      for (const loan of loans) {
        if (loan.monthly_pmt !== null) {
          sum += loan.monthly_pmt * 12;
          anyNonNull = true;
        } else if (loan.annual_interest !== null || loan.annual_principal !== null) {
          sum += (loan.annual_interest ?? 0) + (loan.annual_principal ?? 0);
          anyNonNull = true;
        }
      }
      // F4: separate "no payment data" (anyNonNull=false → null) from "fields present but sum to 0"
      // (anyNonNull=true, sum=0 → 0). A legitimate zero means fully paid down; that is NOT the
      // same as unknown. Division-by-zero is guarded at the DSCR calculation below.
      annualDebtService = anyNonNull ? sum : null;
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

    // D1: LTV from highest-balance loan
    let ltv: number | null = null;
    {
      let maxBalance = -Infinity;
      for (const loan of loans) {
        if (loan.ltv !== null && loan.current_balance > maxBalance) {
          maxBalance = loan.current_balance;
          ltv = loan.ltv;
        }
      }
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
    // maturity_date vs asOf (effectiveMonthsToMaturity) — NEVER the stale stored column directly.
    // F3: a loan with NO known maturity (neither a fresh maturity_date nor a stored fallback —
    // a true demand note) must NOT be treated as "far away" via ?? 999; it is callable immediately.
    // F3 edge case (CodeRabbit): mixed portfolios (demand note + term loan) must also block
    // cash-out. hasUnknownMaturity tracks whether ANY loan had no determinable maturity; after
    // the loop, if true, minMonthsToMaturity is forced to null so the cash-out gate fails.
    let minMonthsToMaturity: number | null = null;
    let hasUnknownMaturity = false;
    {
      for (const loan of loans) {
        const months = effectiveMonthsToMaturity(loan, asOf);
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
      if (dscr === null && ltv === null) {
        signalReason =
          'Governor check skipped — DSCR unknown (no warehouse NOI for this property); LTV unknown at snapshot time. Re-run after populating both.';
      } else if (dscr === null) {
        signalReason =
          'Governor check skipped — DSCR unknown (no warehouse NOI for this property)';
      } else {
        signalReason =
          'Governor check incomplete — LTV unknown at snapshot time; re-run snapshot after workbook LTV column is populated';
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
    const scoreBand = toBand(score);

    // C-2: post-refi annualized cash savings as % of equity. Undrivable (any input
    // missing, a leveraged-to-zero/negative-equity property, or >1 active loan) → null,
    // never a guess. value is derived from totalBalance / ltv — but D1's `ltv` is the
    // HIGHEST-BALANCE loan's own LTV (a governor-check figure), not a blended combined-loan
    // LTV. Applying it to totalBalance across multiple loans manufactures a value/equity
    // figure with no real basis (refute-verified defect), so this is restricted to
    // single-loan properties, where the single loan's balance/ltv/rate are mutually
    // consistent by construction.
    let refiCashSavingsPct: number | null = null;
    if (loans.length === 1) {
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
    });
  }

  return scores;
}

/**
 * Score a property with no active debt — exported for callers that know a property
 * has no loans and want a consistent no-debt DebtScore without a DB query.
 */
export function noDebtScore(
  propertyId: string,
  propertyName: string,
  capitalConfigVersion: number,
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
  };
}
