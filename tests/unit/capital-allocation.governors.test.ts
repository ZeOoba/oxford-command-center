// @vitest-environment node
//
// tests/unit/capital-allocation.governors.test.ts
//
// TDD test for H1: DSCR floor sourced from loadGovernors(db) in buildCapitalAllocationReport.
//
// Strategy:
//   Stub loadGovernors to return dscrFloor=1.30 (not 1.25) — the test proves that the
//   engine reads the governor from the stub, NOT from a hardcoded 1.25 literal.
//
//   If the engine still uses bare 1.25:
//     - A property with dscr=1.29 would NOT trigger debtUrgency (1.29 >= 1.25)
//     - The reason string would say "below 1.25x governor"
//
//   If the engine reads from loadGovernors:
//     - A property with dscr=1.29 WOULD trigger debtUrgency (1.29 < 1.30 stub)
//     - The reason string would say "below 1.30x governor"
//
// Written TDD-first: this test must be RED before the source edit and GREEN after.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// ── Module mocks (hoisted above imports) ──────────────────────────────────────────────────────

// Stub loadGovernors to return dscrFloor=1.30 — deliberately NOT 1.25
vi.mock('../../server/warehouse/governors', () => ({
  loadGovernors: vi.fn().mockReturnValue({
    version: 99,
    effectiveFrom: '2099-01-01',
    dscrFloor: 1.30,   // KEY: higher than the bare literal 1.25
    ltvCeiling: 0.40,
    dispositionCapRate: 0.065,
    holdCapRate: 0.075,
    acqIrr: 0.12,
    capexIrr: 0.15,
    refiTriggerBps: 150,
    payoutPct: 0,
    notes: 'stub for H1 governor test',
  }),
}));

// Stub all the external engines so we control exactly what data flows in
vi.mock('../../server/warehouse/scores', () => ({
  scoreProperties: vi.fn().mockReturnValue([]),
}));

vi.mock('../../server/warehouse/debt-scoring', () => ({
  scoreDebtPositions: vi.fn().mockReturnValue([]),
}));

vi.mock('../../server/warehouse/metrics', () => ({
  propertyPeriodMetrics: vi.fn().mockReturnValue([]),
}));

vi.mock('../../src/analytics/lease-forecast', () => ({
  renewalSignals: vi.fn().mockReturnValue([]),
  bucketExpiry: vi.fn().mockReturnValue('12m+'),
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

// ── Imports (after vi.mock declarations) ─────────────────────────────────────────────────────
import { openWarehouse } from '../../server/warehouse/db';
import { buildCapitalAllocationReport } from '../../server/warehouse/capital-allocation';
import { scoreDebtPositions } from '../../server/warehouse/debt-scoring';
import { scoreProperties } from '../../server/warehouse/scores';
import type { PortfolioSnapshot } from '../../src/contracts/index';

// ── Helpers ───────────────────────────────────────────────────────────────────────────────────

// openWarehouse runs migrations automatically; no seed needed since all warehouse engines are mocked.
function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'h1-test-'));
  const dbPath = join(dir, 'finance.sqlite');
  return openWarehouse(dbPath);
}

function makeSnapshot(overrides: { id: string; noi?: number; sf?: number; oxfordOwnPct?: number; oxfordValue?: number }): PortfolioSnapshot {
  const property = {
    index: 1,
    id: overrides.id,
    name: overrides.id,
    address: overrides.id,
    city: null,
    state: null,
    market: 'Columbus OH',
    type: 'Flex',
    tenantCount: 1,
    occPct: 1,
    acqDate: null,
    estValue100: 1_200_000,
    oxfordOwnPct: overrides.oxfordOwnPct ?? 1,
    oxfordValue: overrides.oxfordValue ?? 1_200_000,
    noi: overrides.noi ?? 80_000,
    noiScenarioAdj: overrides.noi ?? 80_000,
    grossIncome: (overrides.noi ?? 80_000) + 5_000,
    expenses: 5_000,
    debtService: 0,
    netCashFlow: overrides.noi ?? 80_000,
    sf: overrides.sf ?? 5_000,
    tier: 'T2',
    leaseCount: 1,
    capRate: null,
    dscr: null,
    lender: null,
    loanBalance: 0,
    ltv: null,
    valuePerSf: null,
    rentPerSf: null,
    equityInvested: 0,
    cashOnCash: null,
    holdYrs: null,
    encumbered: false,
    flags: [],
  };
  return {
    meta: { schemaVersion: '1.0.0', asOf: '2026-06-22', generatedAt: '2026-06-22T00:00:00.000Z', source: 'test', scenario: 'Base' },
    assumptions: {
      activeScenario: 'Base',
      revenueFactor: 1,
      vacancyFactor: 1,
      exitCapFactor: 1,
      thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 },
      asOf: '2026-06-22',
    },
    properties: [property as unknown as PortfolioSnapshot['properties'][number]],
    leases: [],
    loans: [],
    cash: { asOf: '2026-06-22', totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
    insurance: [],
    deals: [],
    tasks: [],
    counterparties: [],
    renewalStages: {},
    tenantNotes: {},
    dealComps: {},
    acquisitionInputs: {},
    noiBudgets: {},
    tenantArrears: {},
    quickbooks: null,
    marketRents: {},
    dataQuality: [],
  } as unknown as PortfolioSnapshot;
}

// A mock DebtScore shape (what scoreDebtPositions returns)
function makeDebtScore(propertyId: string, dscr: number) {
  return {
    propertyId,
    signal: 'hold' as const,
    score: 60,
    dscr,
    ltv: null,
    loanBalance: null,
    loanRate: null,
    monthsToMaturity: null,
    marketRate: null,
    cashSavingsPct: null,
    band: 'hold' as const,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────

describe('H1: buildCapitalAllocationReport reads dscrFloor from loadGovernors', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset scores to empty — debt scores are set per-test
    (scoreProperties as ReturnType<typeof vi.fn>).mockReturnValue([]);
  });

  it('debtUrgency fires at dscr=1.29 when dscrFloor stub is 1.30 (would NOT fire with bare 1.25)', async () => {
    const db = freshDb();
    const snapshot = makeSnapshot({ id: 'prop-dscr-test', noi: 100_000, sf: 5_000 });

    // Wire a debt score with dscr=1.29 — below stub 1.30, above bare literal 1.25
    (scoreDebtPositions as ReturnType<typeof vi.fn>).mockReturnValue([
      makeDebtScore('prop-dscr-test', 1.29),
    ]);

    const report = await buildCapitalAllocationReport(db, snapshot);
    const entry = report.entries.find((e) => e.propertyId === 'prop-dscr-test');

    expect(entry).toBeDefined();
    // If the engine uses bare 1.25: dscr=1.29 >= 1.25 → debtUrgency component = 0 → no DSCR reason
    // If the engine uses loadGovernors (dscrFloor=1.30): dscr=1.29 < 1.30 → debtUrgency += 30 → DSCR reason emitted
    const hasDscrReason = entry!.rationale.some((r) => r.includes('DSCR') || r.includes('governor'));
    expect(hasDscrReason).toBe(true);
  });

  it('reason string interpolates the live dscrFloor value (1.30) not the literal 1.25', async () => {
    const db = freshDb();
    const snapshot = makeSnapshot({ id: 'prop-reason-test', noi: 100_000, sf: 5_000 });

    (scoreDebtPositions as ReturnType<typeof vi.fn>).mockReturnValue([
      makeDebtScore('prop-reason-test', 1.29),
    ]);

    const report = await buildCapitalAllocationReport(db, snapshot);
    const entry = report.entries.find((e) => e.propertyId === 'prop-reason-test');

    expect(entry).toBeDefined();
    const dscrReason = entry!.rationale.find((r) => r.includes('governor'));
    expect(dscrReason).toBeDefined();
    // The reason must reference the live floor (1.30) interpolated from loadGovernors
    expect(dscrReason).toMatch(/1\.30/);
    // It must NOT hard-code the old literal 1.25
    expect(dscrReason).not.toMatch(/1\.25/);
  });

  it('dscr=1.31 (above stub 1.30) does NOT trigger the DSCR reason', async () => {
    const db = freshDb();
    const snapshot = makeSnapshot({ id: 'prop-safe-test', noi: 100_000, sf: 5_000 });

    (scoreDebtPositions as ReturnType<typeof vi.fn>).mockReturnValue([
      makeDebtScore('prop-safe-test', 1.31),
    ]);

    const report = await buildCapitalAllocationReport(db, snapshot);
    const entry = report.entries.find((e) => e.propertyId === 'prop-safe-test');

    expect(entry).toBeDefined();
    // 1.31 >= 1.30 stub → no DSCR reason emitted
    const hasDscrReason = entry!.rationale.some((r) => r.includes('governor'));
    expect(hasDscrReason).toBe(false);
  });
});
