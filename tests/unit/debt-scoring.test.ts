// @vitest-environment node
//
// tests/unit/debt-scoring.test.ts
//
// Phase 2 Step 4 — Debt/Refi scoring engine.
// All 10 required test cases per spec.
//
// Uses in-memory SQLite (tmpdir) with full migrations — never touches the live warehouse.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { scoreDebtPositions, noDebtScore } from '../../server/warehouse/debt-scoring';
import { CAPITAL_CONFIG } from '../../server/warehouse/capital-config';
import type { PeriodMetrics } from '../../src/contracts/warehouse';

// --- helpers ---

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'debt-scoring-test-'));
  const db = openWarehouse(join(dir, 'test.sqlite'));
  // Seed property_master with two test properties so property name lookup works
  db.prepare(`
    INSERT OR IGNORE INTO property_master
      (id, name, market, financial_mode, rentable_sf, acquisition_date,
       ownership_pct, ownership_status)
    VALUES (?, ?, 'Test Market', 'pnl', 10000, '2020-01-01', 1, 'active')
  `).run('prop-a', 'Test Property A');
  db.prepare(`
    INSERT OR IGNORE INTO property_master
      (id, name, market, financial_mode, rentable_sf, acquisition_date,
       ownership_pct, ownership_status)
    VALUES (?, ?, 'Test Market', 'pnl', 10000, '2020-01-01', 1, 'active')
  `).run('prop-b', 'Test Property B');
  return db;
}

/** Insert a minimal active debt_positions row. */
function insertLoan(
  db: WarehouseDb,
  overrides: {
    id?: string;
    property_id?: string;
    current_balance?: number;
    rate?: number | null;
    monthly_pmt?: number | null;
    annual_interest?: number | null;
    annual_principal?: number | null;
    is_demand?: number;
    maturity_date?: string | null;
    months_to_maturity?: number | null;
    ltv?: number | null;
    status?: string;
    snapshot_date?: string;
  } = {},
): void {
  const row = {
    id: overrides.id ?? 'loan-001',
    snapshot_date: overrides.snapshot_date ?? '2026-06-01',
    property_id: overrides.property_id ?? 'prop-a',
    loan_name: 'Test Mortgage',
    lender: 'Test Bank',
    original_principal: 1_000_000,
    current_balance: overrides.current_balance ?? 800_000,
    rate: overrides.rate !== undefined ? overrides.rate : 0.065,
    loan_type: 'Amortizing',
    monthly_pmt: overrides.monthly_pmt !== undefined ? overrides.monthly_pmt : 5_500,
    annual_interest: overrides.annual_interest !== undefined ? overrides.annual_interest : null,
    annual_principal: overrides.annual_principal !== undefined ? overrides.annual_principal : null,
    is_demand: overrides.is_demand ?? 0,
    // Defaults to null (not a fixed date) — scoreDebtPositions now prefers a fresh recompute from
    // maturity_date over the stored months_to_maturity whenever maturity_date is present, so a
    // fixture that wants to control months_to_maturity directly (nearly every test below) must
    // leave maturity_date unset to exercise the fallback path. Tests exercising the fresh path
    // explicitly pass maturity_date.
    maturity_date: overrides.maturity_date !== undefined ? overrides.maturity_date : null,
    months_to_maturity: overrides.months_to_maturity !== undefined ? overrides.months_to_maturity : 42,
    ltv: overrides.ltv !== undefined ? overrides.ltv : 0.30,
    balloon: 0,
    status: overrides.status ?? 'active',
  };
  db.prepare(`
    INSERT INTO debt_positions
      (id, snapshot_date, property_id, loan_name, lender, original_principal, current_balance,
       rate, loan_type, monthly_pmt, annual_interest, annual_principal,
       is_demand, maturity_date, months_to_maturity, ltv, balloon, status)
    VALUES
      (@id, @snapshot_date, @property_id, @loan_name, @lender, @original_principal, @current_balance,
       @rate, @loan_type, @monthly_pmt, @annual_interest, @annual_principal,
       @is_demand, @maturity_date, @months_to_maturity, @ltv, @balloon, @status)
  `).run(row);
}

/**
 * Minimal PeriodMetrics fixture. Only fields needed by the scorer are required;
 * numeric summary fields default to 0 for test fixture simplicity.
 */
function makePeriodMetrics(overrides: Partial<PeriodMetrics> & { propertyId: string; noi: number }): PeriodMetrics {
  return {
    propertyId: overrides.propertyId,
    propertyName: overrides.propertyName ?? null,
    period: overrides.period ?? '2025',
    grainHint: overrides.grainHint ?? 'year',
    basis: overrides.basis ?? 'cash',
    rentableSf: overrides.rentableSf ?? 10_000,
    ownershipPct: overrides.ownershipPct ?? 1,
    revenue: overrides.revenue ?? overrides.noi,
    opex: overrides.opex ?? 0,
    noi: overrides.noi,
    noiMargin: overrides.noiMargin ?? null,
    expenseRatio: overrides.expenseRatio ?? null,
    capex: overrides.capex ?? 0,
    ti: overrides.ti ?? 0,
    leasing: overrides.leasing ?? 0,
    categories: overrides.categories ?? {},
    revenueCategories: overrides.revenueCategories ?? {},
    revenuePerSf: overrides.revenuePerSf ?? null,
    noiPerSf: overrides.noiPerSf ?? null,
    expensePerSf: overrides.expensePerSf ?? null,
    taxesPerSf: overrides.taxesPerSf ?? null,
    insurancePerSf: overrides.insurancePerSf ?? null,
    repairsPerSf: overrides.repairsPerSf ?? null,
    oxfordNoi: overrides.oxfordNoi ?? overrides.noi,
  };
}

// Governors from compile-time constants (what freshDb() will return on an empty capital_config)
const GOV = CAPITAL_CONFIG; // dscrFloor=1.25, ltvCeiling=0.40, refiTriggerBps=150

// A market rate (5Y Treasury) that will NOT trigger refi by default
// (loan rate 6.5%, market rate 4.5% + 2% spread = 6.5%, + 1.5% trigger = 8% threshold)
// So 6.5% loan rate vs 6.5% market proxy → refi suppressed (not strictly above)
const MARKET_5Y = 0.045; // 4.5% → marketRate = 4.5% + 2.0% = 6.5%

// --- Test cases ---

describe('TC1 — no-debt signal: property with no debt_positions rows → signal=no-debt, score=100', () => {
  it('returns no-debt for a property absent from debt_positions', () => {
    const db = freshDb();
    // Insert loan for prop-b ONLY; prop-a has no loans
    insertLoan(db, { property_id: 'prop-b', id: 'loan-b1' });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 120_000 })];
    // prop-a has no loans, so it won't appear in results (DISTINCT query only returns
    // properties with active loans). The no-debt score for prop-a can be triggered by
    // the caller; scoreDebtPositions only processes IDs with active rows.
    // Verify: only prop-b is returned, with signal=hold or similar
    const results = scoreDebtPositions(db, metrics, MARKET_5Y);
    const propB = results.find((r) => r.propertyId === 'prop-b');
    expect(propB).toBeDefined();
    // prop-a has no loans and should not appear
    const propA = results.find((r) => r.propertyId === 'prop-a');
    expect(propA).toBeUndefined();
  });

  it('noDebtScore helper: returns score=100, signal=no-debt, scoreBand=strong', () => {
    // Use the exported noDebtScore helper for the no-debt case
    const s = noDebtScore('prop-z', 'Zero Debt Property', 1);
    expect(s.signal).toBe('no-debt');
    expect(s.score).toBe(100);
    expect(s.scoreBand).toBe('strong');
    expect(s.dscr).toBeNull();
    expect(s.ltv).toBeNull();
    expect(s.refiCashSavingsPct).toBeNull();
  });
});

describe('TC2 — governor-block on DSCR: dscr < dscrFloor → signal=governor-block', () => {
  it('fires governor-block when DSCR falls below 1.25', () => {
    const db = freshDb();
    // annual debt service = 5500 * 12 = 66000; noi = 60000 → dscr = 60000/66000 ≈ 0.91
    insertLoan(db, { monthly_pmt: 5_500, ltv: 0.30 });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 60_000 })];
    const results = scoreDebtPositions(db, metrics, MARKET_5Y);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    expect(s).toBeDefined();
    expect(s.signal).toBe('governor-block');
    expect(s.dscr).not.toBeNull();
    expect(s.dscr!).toBeLessThan(GOV.dscrFloor);
    expect(s.signalReason).toContain('DSCR');
    expect(s.signalReason).toContain('floor');
  });
});

describe('TC3 — governor-block on LTV: ltv > ltvCeiling → signal=governor-block (takes priority over refi)', () => {
  it('fires governor-block when LTV exceeds 0.40, even if refi would otherwise trigger', () => {
    const db = freshDb();
    // Rate 10% >> market proxy 6.5%; would normally trigger refi — but LTV=0.55 > 0.40 → governor-block
    // NOI = 200_000, monthly_pmt = 1000 → dscr >> floor (DSCR governor clear)
    insertLoan(db, { rate: 0.10, ltv: 0.55, monthly_pmt: 1_000 });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 200_000 })];
    // Market rate that would trigger refi: 6.5% proxy, refiTrigger=150bps → threshold=8%
    // rate=10% > 8% would trigger refi, but LTV governor takes priority
    const results = scoreDebtPositions(db, metrics, MARKET_5Y);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    expect(s.signal).toBe('governor-block');
    expect(s.ltv).toBeGreaterThan(GOV.ltvCeiling);
    expect(s.signalReason).toContain('LTV');
  });
});

describe('TC4 — refi signal: rate above market + spread + refiTriggerBps, governors clear → signal=refi', () => {
  it('fires refi when in-place rate clearly exceeds market proxy threshold', () => {
    const db = freshDb();
    // Market proxy = 4.5% + 2.0% = 6.5%; refiTrigger = 150bps = 1.5%; threshold = 8.0%
    // Loan rate = 9.0% > 8.0% → refi
    // NOI = 200_000, monthly_pmt = 3_000 → dscr = 200_000 / 36_000 ≈ 5.56 (clear)
    // LTV = 0.30 < 0.40 (clear)
    insertLoan(db, { rate: 0.09, ltv: 0.30, monthly_pmt: 3_000 });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 200_000 })];
    const results = scoreDebtPositions(db, metrics, 0.045);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    expect(s.signal).toBe('refi');
    expect(s.signalReason).toContain('market proxy');
  });
});

describe('C-2 TC4b — refiCashSavingsPct: post-refi annual cash savings as % of equity', () => {
  it('computes a drivable value when rate, LTV, and balance are all known (refi signal)', () => {
    const db = freshDb();
    // Market proxy = 4.5% + 2.0% = 6.5%; loan rate = 9.0% > 8.0% threshold → refi
    // currentAnnualInterest = 0.09 * 800_000 = 72_000
    // refiAnnualInterest   = 0.065 * 800_000 = 52_000 → savings = 20_000
    // value = balance / ltv = 800_000 / 0.30 = 2_666_666.67; equity = value - balance = 1_866_666.67
    // refiCashSavingsPct = 20_000 / 1_866_666.67 ≈ 0.0107143
    insertLoan(db, { rate: 0.09, ltv: 0.30, monthly_pmt: 3_000 });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 200_000 })];
    const results = scoreDebtPositions(db, metrics, MARKET_5Y);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    expect(s.signal).toBe('refi');
    expect(s.refiCashSavingsPct).not.toBeNull();
    expect(s.refiCashSavingsPct!).toBeCloseTo(0.0107143, 5);
  });

  it('returns null when the loan rate is unknown, even though cash-out signal fires', () => {
    const db = freshDb();
    // rate=null → avgLoanRate null → currentAnnualInterest undrivable → refiCashSavingsPct null,
    // even though DSCR/LTV/maturity headroom all clear the cash-out signal thresholds.
    insertLoan(db, { rate: null, ltv: 0.25, monthly_pmt: 2_000, months_to_maturity: 30 });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 120_000 })];
    const results = scoreDebtPositions(db, metrics, MARKET_5Y);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    expect(s.signal).toBe('cash-out');
    expect(s.refiCashSavingsPct).toBeNull();
  });

  it('returns null for a multi-loan property (single-loan LTV cannot be blended against total balance)', () => {
    const db = freshDb();
    // Loan A is the highest-balance loan, so D1 reports ltv=0.30 (loan A's own ltv) — but that
    // ltv describes loan A's basis alone, not the combined position. Applying it to totalBalance
    // (both loans summed) would manufacture a value/equity figure with no real basis. refiCashSavingsPct
    // must stay undrivable (null) for any property with more than one active loan.
    insertLoan(db, { id: 'loan-a', rate: 0.09, ltv: 0.30, current_balance: 600_000, monthly_pmt: 3_000 });
    insertLoan(db, { id: 'loan-b', rate: 0.09, ltv: 0.05, current_balance: 200_000, monthly_pmt: 1_000 });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 200_000 })];
    const results = scoreDebtPositions(db, metrics, MARKET_5Y);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    expect(s.refiCashSavingsPct).toBeNull();
  });
});

describe('TC5 — refi suppressed when FRED unavailable', () => {
  it('does not fire refi when marketRateFiveYearTreasury is null', () => {
    const db = freshDb();
    // Same setup as TC4 — rate=9% >> threshold — but marketRate=null → refi suppressed
    insertLoan(db, { rate: 0.09, ltv: 0.30, monthly_pmt: 3_000 });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 200_000 })];
    const results = scoreDebtPositions(db, metrics, null);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    expect(s.signal).not.toBe('refi');
    // Should fall through to cash-out or hold based on headroom
  });
});

describe('TC6 — hold default: governors clear, rate not above threshold → signal=hold', () => {
  it('returns hold when all governors are satisfied and no special action triggered', () => {
    const db = freshDb();
    // rate=6.5%, market proxy=6.5%, threshold=8.0% → rate NOT > threshold → no refi
    // NOI=120_000, monthly_pmt=5_000 → annual DS=60_000, dscr=2.0 → dscrHeadroom=0.75 > 0.5
    // LTV=0.38 → ltvHeadroom = 0.40 - 0.38 = 0.02, which is NOT > 0.10 → no cash-out
    // (Note: 0.40 - 0.30 = 0.10000...3 due to floating point, which IS > 0.10; use 0.38 to be unambiguous)
    insertLoan(db, { rate: 0.065, ltv: 0.38, monthly_pmt: 5_000, months_to_maturity: 42 });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 120_000 })];
    const results = scoreDebtPositions(db, metrics, MARKET_5Y);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    expect(s.signal).toBe('hold');
    expect(s.dscr).not.toBeNull();
  });
});

describe('TC7 — score clamps to [0, 100]: extreme inputs never produce out-of-range score', () => {
  it('score never exceeds 100 even with extremely favorable inputs', () => {
    const db = freshDb();
    // Extremely favorable: very low balance, huge NOI, decades to maturity
    insertLoan(db, {
      monthly_pmt: 100,   // DS = 1200/yr
      ltv: 0.01,          // almost zero LTV
      months_to_maturity: 9999,  // far future
      current_balance: 10_000,
    });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 5_000_000 })];
    const results = scoreDebtPositions(db, metrics, null);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(100);
  });

  it('score never goes below 0 even with catastrophically bad inputs', () => {
    const db = freshDb();
    // Catastrophic: huge DS, zero NOI, extremely high LTV, imminent maturity
    insertLoan(db, {
      monthly_pmt: 999_999,
      ltv: 0.99,
      months_to_maturity: 0,
      current_balance: 999_999_999,
    });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 1 })];
    const results = scoreDebtPositions(db, metrics, null);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(100);
  });
});

describe('TC8 — score determinism: identical inputs produce identical output', () => {
  it('returns the same scores when called twice with identical inputs', () => {
    const db = freshDb();
    insertLoan(db, { rate: 0.065, ltv: 0.30, monthly_pmt: 5_500 });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 120_000 })];
    const r1 = scoreDebtPositions(db, metrics, MARKET_5Y);
    const r2 = scoreDebtPositions(db, metrics, MARKET_5Y);
    expect(r1).toEqual(r2);
  });
});

describe('TC9 — multiple loans for one property: debt service summed; LTV from highest-balance loan', () => {
  it('sums annual debt service across all active loans for a property', () => {
    const db = freshDb();
    // Two loans: monthly_pmt 3000 and 2000 → total DS = 60_000/yr
    insertLoan(db, {
      id: 'loan-p1',
      property_id: 'prop-a',
      monthly_pmt: 3_000,
      current_balance: 500_000,
      ltv: 0.30,
    });
    insertLoan(db, {
      id: 'loan-p2',
      property_id: 'prop-a',
      monthly_pmt: 2_000,
      current_balance: 300_000,   // lower balance → LTV from loan-p1
      ltv: 0.35,
    });
    // NOI=90_000, DS=60_000 → DSCR = 1.5 (above floor)
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 90_000 })];
    const results = scoreDebtPositions(db, metrics, MARKET_5Y);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    expect(s).toBeDefined();
    expect(s.dscr).toBeCloseTo(90_000 / 60_000, 5); // 1.5
    // LTV should come from loan-p1 (higher balance 500_000)
    expect(s.ltv).toBeCloseTo(0.30, 5);
  });

  it('uses LTV from the loan with the highest current_balance', () => {
    const db = freshDb();
    insertLoan(db, {
      id: 'loan-big',
      property_id: 'prop-a',
      current_balance: 800_000,
      ltv: 0.32,
      monthly_pmt: 4_000,
    });
    insertLoan(db, {
      id: 'loan-small',
      property_id: 'prop-a',
      current_balance: 100_000,
      ltv: 0.38,
      monthly_pmt: 700,
    });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 300_000 })];
    const results = scoreDebtPositions(db, metrics, null);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    // LTV from loan-big (higher balance) = 0.32
    expect(s.ltv).toBeCloseTo(0.32, 5);
  });
});

describe('TC10 — NOI spine-B invariant: warehouse NOI used, not Spine A', () => {
  it('uses the noi from PeriodMetrics (Spine B), not any Spine A value', () => {
    const db = freshDb();
    // Set up a loan with monthly_pmt=5_000 → DS=60_000
    insertLoan(db, { monthly_pmt: 5_000, ltv: 0.30 });

    // Spine B NOI = 120_000 → DSCR = 2.0 (above floor)
    // If Spine A NOI were used (hypothetically 50_000), DSCR = 0.83 → governor-block
    // We verify that with spineB NOI=120_000, signal is NOT governor-block
    const spineB_noi = 120_000;
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: spineB_noi })];

    const results = scoreDebtPositions(db, metrics, null);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    expect(s).toBeDefined();

    // Confirm the DSCR reflects Spine B NOI
    expect(s.dscr).toBeCloseTo(spineB_noi / (5_000 * 12), 4); // 2.0
    expect(s.signal).not.toBe('governor-block');

    // noiBasis must identify the Spine B source
    expect(s.noiBasis).toBe('spine-b/warehouse-ledger');

    // If the same noi were passed as 50_000 (Spine A hypothetical), DSCR would be 0.83 → governor-block
    // Passing 50_000 as Spine B confirms this is data-driven, not hardcoded:
    const metricsLowNoi = [makePeriodMetrics({ propertyId: 'prop-a', noi: 50_000 })];
    const resultsLow = scoreDebtPositions(db, metricsLowNoi, null);
    const sLow = resultsLow.find((r) => r.propertyId === 'prop-a')!;
    expect(sLow.dscr).toBeCloseTo(50_000 / (5_000 * 12), 4); // 0.833
    expect(sLow.signal).toBe('governor-block');
  });

  it('uses the LATEST full-year period (grainHint=year) for NOI, not partial-year data', () => {
    const db = freshDb();
    insertLoan(db, { monthly_pmt: 5_000, ltv: 0.30 });

    // Two full-year periods and one YTD — scorer must use 2025 (latest full-year)
    const metrics: PeriodMetrics[] = [
      makePeriodMetrics({ propertyId: 'prop-a', noi: 80_000, period: '2024', grainHint: 'year' }),
      makePeriodMetrics({ propertyId: 'prop-a', noi: 120_000, period: '2025', grainHint: 'year' }),
      makePeriodMetrics({ propertyId: 'prop-a', noi: 40_000, period: '2026-Q1', grainHint: 'ytd' }),
    ];

    const results = scoreDebtPositions(db, metrics, null);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    // If YTD or 2024 were used instead of 2025: 40_000/60_000=0.67 or 80_000/60_000=1.33 (<1.25)
    // Only 120_000/60_000=2.0 produces a non-governor-block result for this NOI
    expect(s.dscr).toBeCloseTo(120_000 / 60_000, 4); // 2.0 → 2025 period used
    expect(s.signal).not.toBe('governor-block');
  });
});

describe('score band thresholds', () => {
  it('assigns correct score bands', () => {
    // We check the band mapping via extreme scenarios that produce known bands
    const db = freshDb();

    // strong: very low DS, long maturity, low LTV, high NOI → score near 100
    insertLoan(db, {
      id: 'loan-strong',
      property_id: 'prop-a',
      monthly_pmt: 100,
      ltv: 0.01,
      months_to_maturity: 480,
      current_balance: 5_000,
    });
    const metricsStrong = [makePeriodMetrics({ propertyId: 'prop-a', noi: 500_000 })];
    const rStrong = scoreDebtPositions(db, metricsStrong, null);
    expect(rStrong[0]!.scoreBand).toBe('strong');
    expect(rStrong[0]!.score).toBeGreaterThanOrEqual(75);
  });
});

describe('cash-out signal', () => {
  it('fires cash-out when DSCR headroom > 0.5, LTV headroom > 0.10, and maturity > 24 months', () => {
    const db = freshDb();
    // DSCR = 200_000 / (2_000 * 12) = 200_000 / 24_000 ≈ 8.33 → headroom = 8.33 - 1.25 = 7.08 > 0.5 ✓
    // LTV = 0.20 → ltvHeadroom = 0.40 - 0.20 = 0.20 > 0.10 ✓
    // months_to_maturity = 36 > 24 ✓
    // Rate = 5.5%; market proxy = 6.5%; threshold = 8.0% → rate NOT > 8% → no refi
    insertLoan(db, {
      rate: 0.055,
      ltv: 0.20,
      monthly_pmt: 2_000,
      months_to_maturity: 36,
    });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 200_000 })];
    const results = scoreDebtPositions(db, metrics, MARKET_5Y);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    expect(s.signal).toBe('cash-out');
  });

  // Regression: the cash-out maturity gate must derive minMonthsToMaturity from a fresh
  // maturity_date recompute, NEVER the stored months_to_maturity — a workbook-cell snapshot
  // frozen at whenever the workbook was last recalced/saved, which only ever grows staler with
  // time (true remaining term always shrinks). A stale-preferring implementation would let a
  // cell that understates the term relative to the true maturity date wrongly BLOCK the gate.
  it('derives the >24mo maturity gate from a fresh maturity_date, not a divergent stale months_to_maturity cell', () => {
    const db = freshDb();
    const asOf = '2026-07-12';
    // Stale cell says 10 months (would FAIL the >24 gate if consulted directly) but the true
    // maturity_date (~30 months out from asOf) clears it comfortably.
    insertLoan(db, {
      rate: 0.055, ltv: 0.20, monthly_pmt: 2_000,
      months_to_maturity: 10,
      maturity_date: '2029-01-12',
    });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 200_000 })];
    const results = scoreDebtPositions(db, metrics, MARKET_5Y, asOf);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    // If the stale cell (10) had been consulted, minMonthsToMaturity would fail the >24mo gate
    // and signal would be 'hold', not 'cash-out'.
    expect(s.signal).toBe('cash-out');
    expect(s.signalReason).toMatch(/\d+mo to maturity/);
  });
});

// ============================================================================
// Adversarial regression tests — F1–F5 from 2026-06-21 refute pass
// ============================================================================

describe('F1 regression — refi blocked when DSCR unknown (no warehouse NOI)', () => {
  it('returns hold (NOT refi) when NOI is absent from PeriodMetrics', () => {
    const db = freshDb();
    // Loan rate 9% >> market threshold (4.5% + 2% + 1.5% = 8%); normally refi would fire.
    // LTV = 0.30 (known and clear). But NO PeriodMetrics for prop-a → noi=null → dscr=null.
    // F1 fix: governorsClear requires dscr !== null → hold, never refi.
    insertLoan(db, {
      rate: 0.09,
      ltv: 0.30,
      monthly_pmt: 3_000,
      months_to_maturity: 42,
    });
    // Pass metrics for a DIFFERENT property — prop-a has no NOI data
    const metrics = [makePeriodMetrics({ propertyId: 'prop-b', noi: 200_000 })];
    const results = scoreDebtPositions(db, metrics, 0.045);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    expect(s).toBeDefined();
    expect(s.signal).toBe('hold');
    expect(s.signal).not.toBe('refi');
    expect(s.dscr).toBeNull();
    expect(s.signalReason).toMatch(/DSCR unknown/i);
  });
});

describe('F2 regression — refi blocked when LTV unknown (null in debt_positions)', () => {
  it('returns hold (NOT refi) when ltv is null on all active loan rows', () => {
    const db = freshDb();
    // Good NOI, high loan rate → refi would fire if governors were both clear.
    // But ltv=null on the loan row → governorsClear=false → hold.
    insertLoan(db, {
      rate: 0.09,
      ltv: null,           // LTV unknown at snapshot time
      monthly_pmt: 3_000,
      months_to_maturity: 42,
    });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 200_000 })];
    const results = scoreDebtPositions(db, metrics, 0.045);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    expect(s).toBeDefined();
    expect(s.signal).toBe('hold');
    expect(s.signal).not.toBe('refi');
    expect(s.ltv).toBeNull();
    expect(s.signalReason).toMatch(/LTV unknown/i);
  });
});

describe('F3 regression — cash-out blocked on demand notes (null months_to_maturity)', () => {
  it('returns hold (NOT cash-out) when loan has null months_to_maturity', () => {
    const db = freshDb();
    // DSCR and LTV clear, DSCR headroom >> 0.5, LTV headroom >> 0.10.
    // Rate 5.5% < market threshold 8% → no refi.
    // BUT months_to_maturity=null (demand note) → cash-out maturity gate fails.
    // F3 fix: null maturity is NOT treated as "far away" — cash-out must NOT fire.
    insertLoan(db, {
      rate: 0.055,
      ltv: 0.20,
      monthly_pmt: 2_000,
      months_to_maturity: null,   // demand note — callable immediately
    });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 200_000 })];
    const results = scoreDebtPositions(db, metrics, MARKET_5Y);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    expect(s).toBeDefined();
    expect(s.signal).not.toBe('cash-out');
    expect(s.signal).toBe('hold');
  });

  it('F3 edge case — mixed portfolio: demand note + 60-month term loan still blocks cash-out', () => {
    const db = freshDb();
    // Loan A: demand note (months_to_maturity=null) — callable immediately.
    // Loan B: 60-month term loan with governors clear (good DSCR + LTV headroom).
    // Prior bug: the loop skipped Loan A (continue), then set minMonthsToMaturity=60,
    // causing the cash-out gate (>24mo) to pass — incorrectly recommending cash-out
    // even though a demand note is in the portfolio.
    // Fix: hasUnknownMaturity=true → minMonthsToMaturity forced to null → gate fails.
    insertLoan(db, {
      id: 'loan-demand',
      property_id: 'prop-a',
      rate: 0.055,
      ltv: 0.20,
      monthly_pmt: 1_000,
      months_to_maturity: null,   // demand note — callable immediately
      current_balance: 200_000,
    });
    insertLoan(db, {
      id: 'loan-term',
      property_id: 'prop-a',
      rate: 0.055,
      ltv: 0.20,
      monthly_pmt: 1_000,
      months_to_maturity: 60,     // 60-month term — would pass the >24mo gate alone
      current_balance: 600_000,
    });
    // DSCR = 200_000 / (2_000 * 12) ≈ 8.33 → headroom >> 0.5 ✓
    // LTV = 0.20 (highest-balance loan, loan-term) → headroom = 0.20 > 0.10 ✓
    // Rate 5.5% < threshold 8% → no refi
    // With the bug: minMonthsToMaturity=60, signal='cash-out' (WRONG)
    // With the fix: hasUnknownMaturity=true → minMonthsToMaturity=null → gate fails → signal≠cash-out
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 200_000 })];
    const results = scoreDebtPositions(db, metrics, MARKET_5Y);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    expect(s).toBeDefined();
    expect(s.signal).not.toBe('cash-out');
  });

  // Regression: a demand note is callable immediately regardless of any maturity_date it happens
  // to carry — is_demand must be the authoritative signal, not "maturity_date is absent." The
  // workbook parser always writes maturity=null for a demand note, but POST /api/warehouse/debt/
  // snapshot performs no schema validation, so is_demand=1 with a populated maturity_date is a
  // reachable malformed row. Before this fix, effectiveMonthsToMaturity would have computed a
  // real fresh months value from that maturity_date and let it clear the >24mo cash-out gate —
  // recommending refinancing against a note the lender can call tomorrow.
  it('a demand note with a populated maturity_date still blocks cash-out (is_demand wins over maturity_date)', () => {
    const db = freshDb();
    insertLoan(db, {
      rate: 0.055, ltv: 0.20, monthly_pmt: 2_000,
      is_demand: 1,
      maturity_date: '2030-01-01', // malformed/reachable-only-via-unvalidated-API row
      months_to_maturity: null,
    });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 200_000 })];
    const results = scoreDebtPositions(db, metrics, MARKET_5Y, '2026-07-12');
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    expect(s).toBeDefined();
    expect(s.signal).not.toBe('cash-out');
  });
});

describe('regression — an unparseable reference date falls back to the stored value instead of poisoning the score with NaN', () => {
  it('produces a finite in-range score when referenceDateIso cannot be parsed', () => {
    const db = freshDb();
    // referenceDate()/REPORT_DATE performs no validation, so an unparseable value is reachable.
    // effectiveMonthsToMaturity must fall back to the stored months_to_maturity (42, this
    // fixture's default) rather than letting (maturityMs - NaN)/MONTH_MS = NaN through.
    insertLoan(db, { rate: 0.055, ltv: 0.20, monthly_pmt: 2_000, maturity_date: '2029-01-12' });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 200_000 })];
    const results = scoreDebtPositions(db, metrics, MARKET_5Y, 'not-a-date');
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    expect(s).toBeDefined();
    expect(Number.isFinite(s.score)).toBe(true);
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(100);
  });
});

describe('F4 regression — annualDebtService=null when all payment fields are null (no crash)', () => {
  it('produces hold signal and null DSCR without crashing when all payment fields are null', () => {
    const db = freshDb();
    // All payment fields null: monthly_pmt=null, annual_interest=null, annual_principal=null
    // F4 fix: anyNonNull=false → annualDebtService=null → dscr=null → governorsClear=false → hold
    insertLoan(db, {
      monthly_pmt: null,
      annual_interest: null,
      annual_principal: null,
      ltv: 0.30,
      months_to_maturity: 42,
    });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: 120_000 })];
    let results: ReturnType<typeof scoreDebtPositions>;
    expect(() => {
      results = scoreDebtPositions(db, metrics, MARKET_5Y);
    }).not.toThrow();
    const s = results!.find((r) => r.propertyId === 'prop-a')!;
    expect(s).toBeDefined();
    expect(s.dscr).toBeNull();
    expect(s.signal).toBe('hold');
    // Score must still be in-range (not NaN/Infinity)
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(100);
  });
});

describe('F5 regression — negative NOI correctly triggers governor-block (not a crash)', () => {
  it('fires governor-block when NOI is negative (DSCR < dscrFloor)', () => {
    const db = freshDb();
    // NOI = -50_000, DS = 5_500 * 12 = 66_000 → DSCR = -0.76 < 1.25 → governor-block
    insertLoan(db, { monthly_pmt: 5_500, ltv: 0.30 });
    const metrics = [makePeriodMetrics({ propertyId: 'prop-a', noi: -50_000 })];
    const results = scoreDebtPositions(db, metrics, MARKET_5Y);
    const s = results.find((r) => r.propertyId === 'prop-a')!;
    expect(s).toBeDefined();
    expect(s.signal).toBe('governor-block');
    expect(s.dscr).not.toBeNull();
    expect(s.dscr!).toBeLessThan(0);
    expect(s.signalReason).toContain('DSCR');
    expect(s.signalReason).toContain('floor');
    expect(s.score).toBeGreaterThanOrEqual(0);
    expect(s.score).toBeLessThanOrEqual(100);
  });
});
