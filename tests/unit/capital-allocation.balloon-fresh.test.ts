// @vitest-environment node
//
// tests/unit/capital-allocation.balloon-fresh.test.ts
//
// TDD coverage for getBalloonMonthsByProperty (server/warehouse/capital-allocation.ts) — a
// private function reached only through buildCapitalAllocationReport's entries[].balloonMonths.
// Previously ZERO test exercised its SQL at all (capital-allocation.balloon.test.ts covers only
// the pure _buildDebtReasonImpacts helper), which is exactly how a real bug could ship undetected:
// a naive fresh-anchoring fix could let SQL's MIN(months_to_maturity) — the STALE workbook cell —
// pick the per-property row, and only then recompute a fresh value from THAT row's maturity_date.
// When the stale cells mis-order relative to true maturity dates (or tie), the fresh recompute
// would run on the wrong loan. These tests pin REPORT_DATE and assert balloonMonths against
// hand-computed expected values for exactly those scenarios.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi, beforeEach, beforeAll, afterAll } from 'vitest';

vi.mock('../../server/warehouse/scores', () => ({
  scoreProperties: vi.fn().mockReturnValue([]),
}));
// Round 19g: see capital-allocation-metrics-callcount.test.ts's note — capital-allocation.ts now
// calls scoreDebtPositionsWithTrust (one atomic read), and the mock must supply it too.
import type { WarehouseDb as WarehouseDbForMock } from '../../server/warehouse/db';
vi.mock('../../server/warehouse/debt-scoring', async () => {
  const { readDebtBookTrust } = await import('../../server/warehouse/debt-trust');
  const scoreDebtPositions = vi.fn();
  return {
    scoreDebtPositions,
    scoreDebtPositionsWithTrust: vi.fn((db: unknown, ...rest: unknown[]) => {
      const scores = scoreDebtPositions(db, ...rest);
      return { scores, bookTrust: scores[0]?.bookTrust ?? readDebtBookTrust(db as WarehouseDbForMock) };
    }),
  };
});
vi.mock('../../server/warehouse/metrics', () => ({
  propertyPeriodMetrics: vi.fn().mockReturnValue([]),
}));
vi.mock('../../src/analytics/lease-forecast', () => ({
  renewalSignals: vi.fn().mockReturnValue([]),
  bucketExpiry: vi.fn().mockReturnValue('24m+'),
}));
vi.mock('../../server/macro/getMacro', () => ({
  getMacro: vi.fn().mockRejectedValue(new Error('no macro in test')),
}));
vi.mock('../../server/macro/market-benchmarks', () => ({
  getMacroMarketBenchmarks: vi.fn().mockRejectedValue(new Error('no benchmarks in test')),
}));
vi.mock('../../server/macro/regional-macro', () => ({
  getRegionalMacro: vi.fn().mockRejectedValue(new Error('no regional in test')),
}));

import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { buildCapitalAllocationReport } from '../../server/warehouse/capital-allocation';
import { scoreDebtPositions } from '../../server/warehouse/debt-scoring';
import type { PortfolioSnapshot } from '../../src/contracts/index';

const ASOF = '2026-07-12';

// REPORT_DATE pins referenceDate() (server/config.ts) — the mechanism buildCapitalAllocationReport
// uses internally for its day-count anchor. beforeAll/afterAll restore hygiene mirrors
// capital-allocation.integration.test.ts / reference-date.test.ts's established pattern.
let priorReportDate: string | undefined;
beforeAll(() => { priorReportDate = process.env.REPORT_DATE; process.env.REPORT_DATE = ASOF; });
afterAll(() => { if (priorReportDate === undefined) delete process.env.REPORT_DATE; else process.env.REPORT_DATE = priorReportDate; });

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'balloon-fresh-test-'));
  const db = openWarehouse(join(dir, 'test.sqlite'));
  db.prepare(`
    INSERT OR IGNORE INTO property_master
      (id, name, market, financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status)
    VALUES (?, ?, 'Test Market', 'pnl', 10000, '2020-01-01', 1, 'active')
  `).run('prop-x', 'Test Property X');
  return db;
}

function insertLoan(
  db: WarehouseDb,
  overrides: {
    id: string;
    property_id?: string;
    maturity_date?: string | null;
    months_to_maturity?: number | null;
    is_demand?: number;
  },
): void {
  const row = {
    id: overrides.id,
    snapshot_date: ASOF,
    property_id: overrides.property_id ?? 'prop-x',
    loan_name: overrides.id,
    lender: 'Test Bank',
    original_principal: 1_000_000,
    current_balance: 800_000,
    rate: 0.065,
    loan_type: 'Amortizing',
    monthly_pmt: 5_500,
    annual_interest: null,
    annual_principal: null,
    is_demand: overrides.is_demand ?? 0,
    maturity_date: overrides.maturity_date ?? null,
    months_to_maturity: overrides.months_to_maturity ?? null,
    ltv: 0.3,
    balloon: 1,
    status: 'active',
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

function makeSnapshot(propertyId: string): PortfolioSnapshot {
  const property = {
    index: 1, id: propertyId, name: propertyId, address: propertyId, city: null, state: null,
    market: 'Columbus OH', type: 'Flex', tenantCount: 1, occPct: 1, acqDate: null,
    estValue100: 1_200_000, oxfordOwnPct: 1, oxfordValue: 1_200_000, noi: 80_000,
    noiScenarioAdj: 80_000, grossIncome: 85_000, expenses: 5_000, debtService: 0,
    netCashFlow: 80_000, sf: 5_000, tier: 'T2', leaseCount: 1, capRate: null, dscr: null,
    lender: null, loanBalance: 0, ltv: null, valuePerSf: null, rentPerSf: null,
    equityInvested: 0, cashOnCash: null, holdYrs: null, encumbered: false, flags: [],
  };
  return {
    meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: `${ASOF}T00:00:00.000Z`, source: 'test', scenario: 'Base' },
    assumptions: {
      activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1,
      thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: ASOF,
    },
    properties: [property as unknown as PortfolioSnapshot['properties'][number]],
    leases: [], loans: [],
    cash: { asOf: ASOF, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
    insurance: [], deals: [], tasks: [], counterparties: [], renewalStages: {}, tenantNotes: {},
    dealComps: {}, acquisitionInputs: {}, noiBudgets: {}, tenantArrears: {}, quickbooks: null,
    marketRents: {}, dataQuality: [],
  } as unknown as PortfolioSnapshot;
}

function makeDebtScore(propertyId: string) {
  return {
    propertyId, signal: 'hold' as const, score: 60, dscr: 1.5, ltv: null, loanBalance: null,
    loanRate: null, monthsToMaturity: null, marketRate: null, cashSavingsPct: null, band: 'hold' as const,
  };
}

describe('getBalloonMonthsByProperty (via buildCapitalAllocationReport entries[].balloonMonths)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    (scoreDebtPositions as ReturnType<typeof vi.fn>).mockReturnValue([]);
  });

  it('prefers a fresh recompute from maturity_date over the stale stored months_to_maturity for a single loan', async () => {
    const db = freshDb();
    (scoreDebtPositions as ReturnType<typeof vi.fn>).mockReturnValue([makeDebtScore('prop-x')]);
    // Stale cell says 3 months; true maturity (2027-09-12) is ~14 months out from asOf 2026-07-12.
    insertLoan(db, { id: 'loan-1', maturity_date: '2027-09-12', months_to_maturity: 3 });

    const report = await buildCapitalAllocationReport(db, makeSnapshot('prop-x'));
    const entry = report.entries.find((e) => e.propertyId === 'prop-x');

    expect(entry).toBeDefined();
    // (2027-09-12 - 2026-07-12) ≈ 14.02 months — NOT the stale 3.
    expect(entry!.balloonMonths).not.toBeNull();
    expect(entry!.balloonMonths!).toBeGreaterThan(13);
    expect(entry!.balloonMonths!).toBeLessThan(15);
  });

  it('picks the loan with the soonest FRESH maturity when two loans have inverted stale cells (the argmin-on-stale-column bug)', async () => {
    const db = freshDb();
    (scoreDebtPositions as ReturnType<typeof vi.fn>).mockReturnValue([makeDebtScore('prop-x')]);
    // loan-near: stale cell says 20 (looks far out), true maturity is ~1 month away.
    insertLoan(db, { id: 'loan-near', maturity_date: '2026-08-12', months_to_maturity: 20 });
    // loan-far: stale cell says 10 (looks nearer), true maturity is ~30 months away.
    insertLoan(db, { id: 'loan-far', maturity_date: '2029-01-12', months_to_maturity: 10 });

    const report = await buildCapitalAllocationReport(db, makeSnapshot('prop-x'));
    const entry = report.entries.find((e) => e.propertyId === 'prop-x');

    expect(entry).toBeDefined();
    // The true nearest balloon (loan-near, ~1 month out) must win — not loan-far via the stale MIN(10) < MIN(20).
    expect(entry!.balloonMonths).not.toBeNull();
    expect(entry!.balloonMonths!).toBeGreaterThan(0.5);
    expect(entry!.balloonMonths!).toBeLessThan(2);
  });

  it('the argmin (soonest fresh maturity) is order-independent when two loans share a stale cell but differ in true maturity date', async () => {
    const db1 = freshDb();
    (scoreDebtPositions as ReturnType<typeof vi.fn>).mockReturnValue([makeDebtScore('prop-x')]);
    // Both loans carry the SAME stale integer cell (8) but different true maturity dates —
    // their FRESH months differ, so this exercises the argmin/order-independence, not the
    // tie-break itself (see the dedicated tie-break test below for that).
    insertLoan(db1, { id: 'loan-a', maturity_date: '2027-03-01', months_to_maturity: 8 });
    insertLoan(db1, { id: 'loan-b', maturity_date: '2027-03-28', months_to_maturity: 8 });
    const report1 = await buildCapitalAllocationReport(db1, makeSnapshot('prop-x'));
    const entry1 = report1.entries.find((e) => e.propertyId === 'prop-x');

    const db2 = freshDb();
    (scoreDebtPositions as ReturnType<typeof vi.fn>).mockReturnValue([makeDebtScore('prop-x')]);
    // Reversed insertion order — result must be identical (the earlier bug was insertion-order-dependent).
    insertLoan(db2, { id: 'loan-b', maturity_date: '2027-03-28', months_to_maturity: 8 });
    insertLoan(db2, { id: 'loan-a', maturity_date: '2027-03-01', months_to_maturity: 8 });
    const report2 = await buildCapitalAllocationReport(db2, makeSnapshot('prop-x'));
    const entry2 = report2.entries.find((e) => e.propertyId === 'prop-x');

    expect(entry1!.balloonMonths).not.toBeNull();
    expect(entry1!.balloonMonths).toBeCloseTo(entry2!.balloonMonths!, 6);
    // The earlier (2027-03-01) maturity must win — that loan is closer.
    expect(entry1!.balloonMonths!).toBeLessThan(8);
  });

  it('breaks a genuine tie in FRESH months (identical maturity_date) deterministically via loan id, independent of insertion order', async () => {
    // Both loans share the IDENTICAL maturity_date, so their computed fresh months are exactly
    // equal — this is the only way to actually reach the tieKey comparison branch (a mere shared
    // stale cell with differing dates, as above, never ties on the fresh value).
    const db1 = freshDb();
    (scoreDebtPositions as ReturnType<typeof vi.fn>).mockReturnValue([makeDebtScore('prop-x')]);
    insertLoan(db1, { id: 'loan-a', maturity_date: '2027-03-01', months_to_maturity: 8 });
    insertLoan(db1, { id: 'loan-z', maturity_date: '2027-03-01', months_to_maturity: 8 });
    const report1 = await buildCapitalAllocationReport(db1, makeSnapshot('prop-x'));
    const entry1 = report1.entries.find((e) => e.propertyId === 'prop-x');

    const db2 = freshDb();
    (scoreDebtPositions as ReturnType<typeof vi.fn>).mockReturnValue([makeDebtScore('prop-x')]);
    insertLoan(db2, { id: 'loan-z', maturity_date: '2027-03-01', months_to_maturity: 8 });
    insertLoan(db2, { id: 'loan-a', maturity_date: '2027-03-01', months_to_maturity: 8 });
    const report2 = await buildCapitalAllocationReport(db2, makeSnapshot('prop-x'));
    const entry2 = report2.entries.find((e) => e.propertyId === 'prop-x');

    expect(entry1!.balloonMonths).not.toBeNull();
    // Identical maturity_date -> identical months regardless of which id wins the tie; the point
    // is that BOTH insertion orders agree (order-independence survives an actual tie).
    expect(entry1!.balloonMonths).toBeCloseTo(entry2!.balloonMonths!, 6);
  });

  it('includes a loan with a valid maturity_date but a NULL stored months_to_maturity (previously invisible)', async () => {
    const db = freshDb();
    (scoreDebtPositions as ReturnType<typeof vi.fn>).mockReturnValue([makeDebtScore('prop-x')]);
    insertLoan(db, { id: 'loan-blank-cell', maturity_date: '2026-08-12', months_to_maturity: null });

    const report = await buildCapitalAllocationReport(db, makeSnapshot('prop-x'));
    const entry = report.entries.find((e) => e.propertyId === 'prop-x');

    expect(entry).toBeDefined();
    expect(entry!.balloonMonths).not.toBeNull();
    expect(entry!.balloonMonths!).toBeGreaterThan(0.5);
    expect(entry!.balloonMonths!).toBeLessThan(2);
  });

  it('falls back to the stored months_to_maturity when maturity_date is NULL', async () => {
    const db = freshDb();
    (scoreDebtPositions as ReturnType<typeof vi.fn>).mockReturnValue([makeDebtScore('prop-x')]);
    insertLoan(db, { id: 'loan-no-date', maturity_date: null, months_to_maturity: 11 });

    const report = await buildCapitalAllocationReport(db, makeSnapshot('prop-x'));
    const entry = report.entries.find((e) => e.propertyId === 'prop-x');

    expect(entry).toBeDefined();
    expect(entry!.balloonMonths).toBe(11);
  });

  // Regression (adversarial review, 2026-07-12): balloon=1 does NOT imply is_demand=0 — the
  // workbook parser derives them independently, and the unvalidated POST /debt/snapshot ingest
  // writes both flags verbatim. Before this fix, a demand note with a populated maturity_date
  // got a real fresh-months recompute here (demonstrated live: 41.7 months of phantom runway)
  // while scoreDebtPositions correctly treated the identical row as unknown-maturity — silently
  // UNDERSTATING debtUrgency for paper the lender can call tomorrow.
  it('treats a demand note as callable-now (months=0, max urgency), not a fresh maturity_date recompute', async () => {
    const db = freshDb();
    (scoreDebtPositions as ReturnType<typeof vi.fn>).mockReturnValue([makeDebtScore('prop-x')]);
    insertLoan(db, {
      id: 'loan-demand',
      is_demand: 1,
      maturity_date: '2030-01-01', // far out — must NOT be used as a fresh-runway recompute.
      months_to_maturity: 42,
    });

    const report = await buildCapitalAllocationReport(db, makeSnapshot('prop-x'));
    const entry = report.entries.find((e) => e.propertyId === 'prop-x');

    expect(entry).toBeDefined();
    expect(entry!.balloonMonths).toBe(0);
  });

  it('a demand note yields the property\'s minimum (max urgency) even alongside a non-demand loan with a later maturity', async () => {
    const db = freshDb();
    (scoreDebtPositions as ReturnType<typeof vi.fn>).mockReturnValue([makeDebtScore('prop-x')]);
    insertLoan(db, { id: 'loan-demand', is_demand: 1, maturity_date: '2030-01-01', months_to_maturity: 42 });
    insertLoan(db, { id: 'loan-far', maturity_date: '2028-01-12', months_to_maturity: 5 });

    const report = await buildCapitalAllocationReport(db, makeSnapshot('prop-x'));
    const entry = report.entries.find((e) => e.propertyId === 'prop-x');

    expect(entry).toBeDefined();
    expect(entry!.balloonMonths).toBe(0);
  });
});
