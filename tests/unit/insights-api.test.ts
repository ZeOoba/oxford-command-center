// tests/unit/insights-api.test.ts
//
// Lane L2c — insights-api.ts sub-router tests.
//
// Pattern mirrors two existing suites:
//   - tests/unit/capital-allocation-api.test.ts   (freshDb via openWarehouse + seedPropertyMaster)
//   - tests/unit/capital-allocation.governors.test.ts (mocking the network-dependent macro
//     modules for determinism)
//
// server/brain.ts is mocked wholesale (it has real fs/chokidar side effects at module scope)
// so each test can control brain.getSnapshot() directly — this exercises the exact same
// dynamic `await import('../brain')` acquisition pattern used by GET /capital-allocation in
// server/warehouse/api.ts, just with the snapshot fully under test control.
import { describe, it, expect, vi, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse } from '../../server/warehouse/db';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { InsightReportSchema } from '../../src/contracts/insights';
import type { PortfolioSnapshot, Property } from '../../src/contracts/index';

// ── Module mocks (hoisted above imports) ──────────────────────────────────────────────────────

vi.mock('../../server/brain', () => ({
  brain: { getSnapshot: vi.fn() },
}));

vi.mock('../../server/macro/getMacro', () => ({
  getMacro: vi.fn().mockRejectedValue(new Error('no macro in test')),
}));

// One benchmark covering the 'Columbus OH' / 'Flex' fixture properties below, with a p50
// comfortably above the fixtures' implied cap rates so the CF-1 generator fires deterministically.
vi.mock('../../server/macro/market-benchmarks', () => ({
  getMacroMarketBenchmarks: vi.fn().mockResolvedValue({
    available: true,
    source: 'seed',
    asOf: '2026-06-22',
    benchmarks: [
      {
        market: 'Columbus OH',
        propertyType: 'Flex',
        capRateP25: 0.05,
        capRateP50: 0.07,
        capRateP75: 0.09,
        source: 'seed',
        asOf: '2026-06-22',
      },
    ],
  }),
}));

vi.mock('../../server/macro/regional-macro', () => ({
  getRegionalMacro: vi.fn().mockRejectedValue(new Error('no regional in test')),
}));

// ── Imports (after vi.mock declarations) ─────────────────────────────────────────────────────

import { insightsApi } from '../../server/warehouse/insights-api';
import { brain } from '../../server/brain';

// ── Fixture helpers ──────────────────────────────────────────────────────────────────────────

const openedDbs: ReturnType<typeof openWarehouse>[] = [];

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'insights-api-test-'));
  const db = openWarehouse(join(dir, 'test.sqlite'));
  seedPropertyMaster(db);
  openedDbs.push(db);
  return db;
}

/** Minimal Property fixture — 'hold' capitalAction is the natural default in these tests
 *  since scoreProperties(db, metrics) has no ledger data to score against (propScore
 *  undefined → buildCapitalAllocationReport's `propScore?.capitalAction ?? 'hold'`). */
function makeProperty(overrides: { id: string; noi: number; oxfordValue: number }): Property {
  return {
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
    estValue100: overrides.oxfordValue,
    oxfordOwnPct: 1,
    oxfordValue: overrides.oxfordValue,
    grossIncome: overrides.noi + 5_000,
    expenses: 5_000,
    noiScenarioAdj: overrides.noi,
    debtService: 0,
    netCashFlow: overrides.noi,
    sf: 20_000,
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
    noi: overrides.noi,
  } as unknown as Property;
}

function makeSnapshot(properties: Property[]): PortfolioSnapshot {
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
    properties,
    leases: [],
    loans: [],
    cash: {
      asOf: '2026-06-22',
      totalCash: 0,
      activeEntities: 0,
      largestEntity: null,
      concentrationTopPct: null,
      cagr: null,
      entities: [],
      history: [],
    },
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

// Two properties trailing the mocked 0.07 market-median cap rate by different margins, so
// the CF-1 generator emits two candidates with distinguishable novelty/materiality —
// enough for rankCandidates to produce a non-trivial (but here unasserted-on-value)
// order that must still be IDENTICAL across repeated calls.
function twoHoldSnapshot(): PortfolioSnapshot {
  return makeSnapshot([
    makeProperty({ id: 'prop-a', noi: 600_000, oxfordValue: 10_000_000 }), // implied 0.06
    makeProperty({ id: 'prop-b', noi: 440_000, oxfordValue: 8_000_000 }), // implied 0.055
  ]);
}

describe('insightsApi', () => {
  afterEach(() => {
    for (const db of openedDbs) db.close();
    openedDbs.length = 0;
    vi.clearAllMocks();
  });

  it('R-1: warehouse unavailable → 503', async () => {
    const router = insightsApi(() => {
      throw new Error('no warehouse');
    });
    const res = await router.fetch(new Request('http://localhost/'));
    expect(res.status).toBe(503);
  });

  it('R-2: no snapshot → 200 with a Zod-valid report; CF dormant + empty candidates (not an error)', async () => {
    (brain.getSnapshot as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const db = freshDb();
    const router = insightsApi(() => db);

    const res = await router.fetch(new Request('http://localhost/'));
    expect(res.status).toBe(200);

    const body = InsightReportSchema.parse(await res.json());
    expect(body.advisoryOnly).toBe(true);
    expect(body.candidates).toEqual([]);

    const cf = body.dataReadiness.find((d) => d.generatorId === 'cf-hurdle-drag');
    expect(cf).toBeDefined();
    expect(cf!.status).not.toBe('live');
    expect(cf!.sampleN).toBeNull();
  });

  it('R-3: dataReadiness lists exactly one entry per family (CF, DR, TE, TR, CR) — no invention', async () => {
    (brain.getSnapshot as ReturnType<typeof vi.fn>).mockReturnValue(null);
    const db = freshDb();
    const router = insightsApi(() => db);

    const res = await router.fetch(new Request('http://localhost/'));
    const body = InsightReportSchema.parse(await res.json());

    expect(body.dataReadiness).toHaveLength(5);

    const nonCf = body.dataReadiness.filter((d) => d.generatorId !== 'cf-hurdle-drag');
    expect(nonCf).toHaveLength(4);
    for (const entry of nonCf) {
      expect(entry.status).toBe('dormant-no-outcomes');
      expect(entry.sampleN).toBeNull();
    }
  });

  it('R-4: snapshot present with hold entries trailing the market → 200 Zod-valid report, CF live', async () => {
    (brain.getSnapshot as ReturnType<typeof vi.fn>).mockReturnValue(twoHoldSnapshot());
    const db = freshDb();
    const router = insightsApi(() => db);

    const res = await router.fetch(new Request('http://localhost/'));
    expect(res.status).toBe(200);

    const body = InsightReportSchema.parse(await res.json());
    expect(body.candidates).toHaveLength(2);
    for (const candidate of body.candidates) {
      expect(candidate.family).toBe('CF');
      expect(candidate.spine).toBe('A');
      expect(candidate.advisoryOnly).toBe(true);
    }

    const cf = body.dataReadiness.find((d) => d.generatorId === 'cf-hurdle-drag');
    expect(cf!.status).toBe('live');
    expect(cf!.sampleN).toBe(2);
  });

  it('R-5: rank order is stable/deterministic across two calls', async () => {
    (brain.getSnapshot as ReturnType<typeof vi.fn>).mockReturnValue(twoHoldSnapshot());
    const db = freshDb();
    const router = insightsApi(() => db);

    const res1 = await router.fetch(new Request('http://localhost/'));
    const body1 = InsightReportSchema.parse(await res1.json());

    const res2 = await router.fetch(new Request('http://localhost/'));
    const body2 = InsightReportSchema.parse(await res2.json());

    expect(body1.candidates.length).toBeGreaterThan(0);
    expect(body1.candidates.map((c) => c.id)).toEqual(body2.candidates.map((c) => c.id));
    // Full candidate + dataReadiness equality, excluding the wall-clock generatedAt stamp.
    expect(body1.candidates).toEqual(body2.candidates);
    expect(body1.dataReadiness).toEqual(body2.dataReadiness);
  });
});
