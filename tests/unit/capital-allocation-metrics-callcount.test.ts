// @vitest-environment node
//
// G5 — Regression guard: propertyPeriodMetrics must be called AT MOST ONCE
// per buildCapitalAllocationReport invocation (memoize/call-once pattern).
//
// This test was written FIRST (TDD-RED) before the fix was applied. If it passes
// on the raw base, the code already complies and no source change is needed.

import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../server/macro/getMacro', () => ({ getMacro: vi.fn() }));
vi.mock('../../server/macro/market-benchmarks', () => ({ getMacroMarketBenchmarks: vi.fn() }));
vi.mock('../../server/macro/regional-macro', () => ({ getRegionalMacro: vi.fn() }));
vi.mock('../../server/warehouse/scores', () => ({ scoreProperties: vi.fn() }));
// Round 19g: capital-allocation.ts now calls scoreDebtPositionsWithTrust (one atomic read of
// scores + book trust — round 19f/19g fixed a CRITICAL/HIGH disagreement caused by callers
// re-deriving trust with a second, separate read). The mock must export it too, deriving trust
// from whatever scoreDebtPositions is configured to return (matching production for the
// non-empty case) and falling back to the REAL readDebtBookTrust for the empty-scores case, so
// tests that set up a real marker/unattributed-loan state still observe correct behavior.
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
vi.mock('../../server/warehouse/metrics', () => ({ propertyPeriodMetrics: vi.fn() }));
vi.mock('../../src/analytics/lease-forecast', () => ({
  renewalSignals: vi.fn().mockReturnValue([]),
  bucketExpiry: vi.fn().mockReturnValue({ critical: 0, watch: 0 }),
}));
// market-intelligence is not mocked — the real classifyCapRateBand and benchmarkKey
// are pure functions with no side effects; using the actual implementation is safe here.

import { openWarehouse } from '../../server/warehouse/db';
import { getMacro } from '../../server/macro/getMacro';
import { getMacroMarketBenchmarks } from '../../server/macro/market-benchmarks';
import { getRegionalMacro } from '../../server/macro/regional-macro';
import { scoreProperties } from '../../server/warehouse/scores';
import { scoreDebtPositions } from '../../server/warehouse/debt-scoring';
import { propertyPeriodMetrics } from '../../server/warehouse/metrics';

const mockGetMacro = vi.mocked(getMacro);
const mockGetBenchmarks = vi.mocked(getMacroMarketBenchmarks);
const mockGetRegional = vi.mocked(getRegionalMacro);
const mockScoreProperties = vi.mocked(scoreProperties);
const mockScoreDebt = vi.mocked(scoreDebtPositions);
const mockPeriodMetrics = vi.mocked(propertyPeriodMetrics);

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'g5-test-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

function makeSnapshot() {
  return {
    meta: { asOf: '2026-06-21', generatedAt: '2026-06-21T00:00:00Z', version: '1' },
    assumptions: { capRateDiscount: 0.01, vacancyRate: 0.05, managementFee: 0.05, capexReserve: 0.01 },
    properties: [],
    leases: [],
    loans: [],
    cash: { totalCash: 0, operatingReserve: 0, capexReserve: 0 },
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
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetMacro.mockResolvedValue({
    asOf: '2026-06-21', source: 'mock',
    indicators: [
      { id: 'DGS10', label: '10Y Treasury', value: 4.25, unit: '%', change: null },
      { id: 'CPIAUCSL', label: 'CPI (YoY)', value: 3.8, unit: '%', change: null },
    ],
    tenYearHistory: [],
  } as never);
  mockGetBenchmarks.mockResolvedValue({
    available: false, source: 'unavailable', asOf: null, benchmarks: [],
  } as never);
  mockGetRegional.mockResolvedValue(null as never);
  mockScoreProperties.mockReturnValue([]);
  mockScoreDebt.mockReturnValue([]);
  mockPeriodMetrics.mockReturnValue([]);
});

describe('G5 — propertyPeriodMetrics call-once guard', () => {
  it('G5-1: propertyPeriodMetrics called exactly once per buildCapitalAllocationReport invocation', async () => {
    const { buildCapitalAllocationReport } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    const snapshot = makeSnapshot();

    await buildCapitalAllocationReport(db, snapshot as never);

    expect(mockPeriodMetrics).toHaveBeenCalledTimes(1);
  });

  it('G5-2: two sequential invocations → exactly 2 total calls (not 4)', async () => {
    const { buildCapitalAllocationReport } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    const snapshot = makeSnapshot();

    await buildCapitalAllocationReport(db, snapshot as never);
    await buildCapitalAllocationReport(db, snapshot as never);

    expect(mockPeriodMetrics).toHaveBeenCalledTimes(2);
  });
});
