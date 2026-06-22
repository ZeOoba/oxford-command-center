// @vitest-environment node
//
// tests/unit/capital-allocation.test.ts
//
// Phase 5 — Capital Allocation Capstone unit tests.
// Written TDD-first: tests run BEFORE implementation and are expected to FAIL
// until server/warehouse/capital-allocation.ts is implemented.
//
// Test strategy:
//   1. Priority score formula edge cases (pure math, no DB needed)
//   2. Contract validation (Zod parse/reject)
//   3. Integration test with mocked dependencies (scores, debt, leasing, macro)
//
// Vi.mock paths use the ACTUAL module paths relative to the test file location
// (tests/unit/) so that vitest resolves them correctly.
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { CapitalAllocationEntry, MacroContext, CapitalAllocationReport } from '../../src/contracts/capital-allocation';

// ── Pure formula helpers (extracted to test the math independently) ────────────────────────
// These mirror exactly the formula in capital-allocation.ts so that tests serve as
// an independent oracle on the arithmetic. The engine implementation must match these.

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

function attentionBandScore(band: string | null | undefined): number {
  if (band === 'red') return 100;
  if (band === 'orange') return 66;
  if (band === 'yellow') return 33;
  return 0;
}

function computePriorityScore(opts: {
  healthScore: number | null;
  attentionBand: string | null;
  nearTermExpiryRent: number;
  atRiskLikelihoodCount: number;
  noi: number;
  balloonMonths: number | null;
  dscr: number | null;
}): number {
  const { healthScore, attentionBand, nearTermExpiryRent, atRiskLikelihoodCount, noi, balloonMonths, dscr } = opts;
  const healthVal = healthScore ?? 50;
  const attentionVal = attentionBandScore(attentionBand);

  const leasingRisk =
    noi > 0
      ? Math.min(100, (nearTermExpiryRent / noi) * 100 + atRiskLikelihoodCount * 10)
      : Math.min(50, atRiskLikelihoodCount * 10);

  const debtUrgency =
    balloonMonths === null
      ? 0
      : clamp(Math.max(0, 100 - (balloonMonths / 12) * 10) + (dscr !== null && dscr < 1.25 ? 30 : 0), 0, 100);

  const raw = (100 - healthVal) * 0.35 + attentionVal * 0.30 + leasingRisk * 0.20 + debtUrgency * 0.15;
  return Math.max(0, Math.min(100, raw));
}

// ── Priority score formula unit tests ──────────────────────────────────────────────────────

describe('priorityScore formula', () => {
  it('health=20 attention=red produces high score', () => {
    const score = computePriorityScore({
      healthScore: 20,
      attentionBand: 'red',
      nearTermExpiryRent: 0,
      atRiskLikelihoodCount: 0,
      noi: 100_000,
      balloonMonths: null,
      dscr: null,
    });
    // (100-20)*0.35 + 100*0.30 + 0 + 0 = 28 + 30 = 58
    expect(score).toBeCloseTo(58, 1);
    expect(score).toBeGreaterThan(50);
  });

  it('health=90 attention=green no leasing no debt produces low score', () => {
    const score = computePriorityScore({
      healthScore: 90,
      attentionBand: 'green',
      nearTermExpiryRent: 0,
      atRiskLikelihoodCount: 0,
      noi: 100_000,
      balloonMonths: null,
      dscr: null,
    });
    // (100-90)*0.35 + 0 + 0 + 0 = 3.5
    expect(score).toBeCloseTo(3.5, 1);
    expect(score).toBeLessThan(10);
  });

  it('null health treated as 50 (neutral)', () => {
    const scoreWithNull = computePriorityScore({
      healthScore: null,
      attentionBand: 'green',
      nearTermExpiryRent: 0,
      atRiskLikelihoodCount: 0,
      noi: 100_000,
      balloonMonths: null,
      dscr: null,
    });
    const scoreWith50 = computePriorityScore({
      healthScore: 50,
      attentionBand: 'green',
      nearTermExpiryRent: 0,
      atRiskLikelihoodCount: 0,
      noi: 100_000,
      balloonMonths: null,
      dscr: null,
    });
    expect(scoreWithNull).toBeCloseTo(scoreWith50, 5);
  });

  it('null attentionBand treated as 0 (green equivalent)', () => {
    const scoreNull = computePriorityScore({
      healthScore: 50,
      attentionBand: null,
      nearTermExpiryRent: 0,
      atRiskLikelihoodCount: 0,
      noi: 100_000,
      balloonMonths: null,
      dscr: null,
    });
    const scoreGreen = computePriorityScore({
      healthScore: 50,
      attentionBand: 'green',
      nearTermExpiryRent: 0,
      atRiskLikelihoodCount: 0,
      noi: 100_000,
      balloonMonths: null,
      dscr: null,
    });
    expect(scoreNull).toBeCloseTo(scoreGreen, 5);
  });

  it('leasingRisk capped at 50 when noi=0', () => {
    // With noi=0 and atRiskLikelihoodCount=10, leasingRisk = min(50, 100) = 50
    const score = computePriorityScore({
      healthScore: 50,
      attentionBand: 'green',
      nearTermExpiryRent: 999_999,
      atRiskLikelihoodCount: 10,
      noi: 0,
      balloonMonths: null,
      dscr: null,
    });
    // (100-50)*0.35 + 0 + 50*0.20 + 0 = 17.5 + 10 = 27.5
    expect(score).toBeCloseTo(27.5, 1);
  });

  it('debtUrgency is 0 when balloonMonths is null (no debt)', () => {
    const scoreNoDebt = computePriorityScore({
      healthScore: 50,
      attentionBand: 'green',
      nearTermExpiryRent: 0,
      atRiskLikelihoodCount: 0,
      noi: 100_000,
      balloonMonths: null,
      dscr: null,
    });
    const scoreWithDebt = computePriorityScore({
      healthScore: 50,
      attentionBand: 'green',
      nearTermExpiryRent: 0,
      atRiskLikelihoodCount: 0,
      noi: 100_000,
      balloonMonths: 60,     // 5 years out → low urgency
      dscr: 2.0,             // healthy DSCR
    });
    expect(scoreNoDebt).toBeLessThan(scoreWithDebt);
  });

  it('balloonMonths=0 dscr=1.0 produces max debt urgency component', () => {
    // debtUrgency = clamp(max(0, 100 - 0) + 30, 0, 100) = clamp(130, 0, 100) = 100
    const score = computePriorityScore({
      healthScore: 50,
      attentionBand: 'green',
      nearTermExpiryRent: 0,
      atRiskLikelihoodCount: 0,
      noi: 100_000,
      balloonMonths: 0,
      dscr: 1.0,
    });
    // (100-50)*0.35 + 0 + 0 + 100*0.15 = 17.5 + 15 = 32.5
    expect(score).toBeCloseTo(32.5, 1);
  });

  it('DSCR exactly at 1.25 does NOT add the 30-point penalty', () => {
    const scoreAt125 = computePriorityScore({
      healthScore: 50,
      attentionBand: 'green',
      nearTermExpiryRent: 0,
      atRiskLikelihoodCount: 0,
      noi: 100_000,
      balloonMonths: 12,
      dscr: 1.25,
    });
    const scoreBelow125 = computePriorityScore({
      healthScore: 50,
      attentionBand: 'green',
      nearTermExpiryRent: 0,
      atRiskLikelihoodCount: 0,
      noi: 100_000,
      balloonMonths: 12,
      dscr: 1.24,
    });
    expect(scoreBelow125).toBeGreaterThan(scoreAt125);
  });

  it('result is always in [0, 100]', () => {
    // Worst case: health=0, attention=red, full leasing risk, max debt urgency
    const score = computePriorityScore({
      healthScore: 0,
      attentionBand: 'red',
      nearTermExpiryRent: 1_000_000,
      atRiskLikelihoodCount: 10,
      noi: 50_000,
      balloonMonths: 0,
      dscr: 0.5,
    });
    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(100);
  });

  it('attentionBandScore maps correctly', () => {
    expect(attentionBandScore('red')).toBe(100);
    expect(attentionBandScore('orange')).toBe(66);
    expect(attentionBandScore('yellow')).toBe(33);
    expect(attentionBandScore('green')).toBe(0);
    expect(attentionBandScore(null)).toBe(0);
    expect(attentionBandScore(undefined)).toBe(0);
    expect(attentionBandScore('unknown')).toBe(0);
  });
});

// ── Contract validation tests ──────────────────────────────────────────────────────────────

describe('CapitalAllocationReport contract', () => {
  it('rejects portfolioNoBasis !== spine-a', () => {
    const invalid = {
      asOf: '2026-06-21',
      propertyCount: 0,
      entries: [],
      portfolioNoi: 0,
      portfolioNoBasis: 'spine-b',   // WRONG
      investCount: 0,
      holdCount: 0,
      monitorCount: 0,
      dispositionCount: 0,
      macro: { tenYearRate: null, cpi: null, source: 'mock', asOf: null },
    };
    const result = CapitalAllocationReport.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  it('accepts portfolioNoBasis === spine-a', () => {
    const valid = {
      asOf: '2026-06-21',
      propertyCount: 1,
      entries: [],
      portfolioNoi: 100_000,
      portfolioNoBasis: 'spine-a',
      investCount: 0,
      holdCount: 1,
      monitorCount: 0,
      dispositionCount: 0,
      macro: { tenYearRate: 4.47, cpi: 3.8, source: 'fred', asOf: '2026-06-21' },
    };
    const result = CapitalAllocationReport.safeParse(valid);
    expect(result.success).toBe(true);
  });
});

describe('MacroContext contract', () => {
  it('parses with source:fred + numbers', () => {
    const result = MacroContext.safeParse({
      tenYearRate: 4.47,
      cpi: 3.8,
      source: 'fred',
      asOf: '2026-06-21',
    });
    expect(result.success).toBe(true);
  });

  it('parses with source:mock + nulls', () => {
    const result = MacroContext.safeParse({
      tenYearRate: null,
      cpi: null,
      source: 'mock',
      asOf: null,
    });
    expect(result.success).toBe(true);
  });

  it('rejects unknown source enum', () => {
    const result = MacroContext.safeParse({
      tenYearRate: null,
      cpi: null,
      source: 'live',    // invalid
      asOf: null,
    });
    expect(result.success).toBe(false);
  });
});

describe('CapitalAllocationEntry contract', () => {
  const validEntry = {
    propertyId: 'PROP-001',
    propertyName: 'Test Property',
    market: 'Columbus',
    sf: 20_000,
    capitalAction: 'hold',
    priorityScore: 25,
    healthScore: 70,
    attentionScore: 33,
    nearTermExpiryRent: 50_000,
    atRiskLikelihoodCount: 0,
    debtScore: 80,
    balloonMonths: 36,
    dscr: 1.5,
    rationale: ['Health score 70/100', 'No near-term expirations'],
    noi: 200_000,
    noiPerSf: 10,
    noiBasis: 'spine-a' as const,
  };

  it('accepts a valid entry', () => {
    expect(CapitalAllocationEntry.safeParse(validEntry).success).toBe(true);
  });

  it('rejects noiBasis=spine-b', () => {
    const invalid = { ...validEntry, noiBasis: 'spine-b' };
    expect(CapitalAllocationEntry.safeParse(invalid).success).toBe(false);
  });

  it('rejects priorityScore outside [0,100]', () => {
    const over = { ...validEntry, priorityScore: 101 };
    const under = { ...validEntry, priorityScore: -1 };
    expect(CapitalAllocationEntry.safeParse(over).success).toBe(false);
    expect(CapitalAllocationEntry.safeParse(under).success).toBe(false);
  });

  it('rejects rationale with more than 3 entries', () => {
    const tooMany = { ...validEntry, rationale: ['a', 'b', 'c', 'd'] };
    expect(CapitalAllocationEntry.safeParse(tooMany).success).toBe(false);
  });

  it('accepts null optional fields', () => {
    const minimal = {
      ...validEntry,
      propertyName: null,
      market: null,
      healthScore: null,
      attentionScore: null,
      debtScore: null,
      balloonMonths: null,
      dscr: null,
      noiPerSf: null,
    };
    expect(CapitalAllocationEntry.safeParse(minimal).success).toBe(true);
  });
});

// ── Integration tests with mocked dependencies ──────────────────────────────────────────────
// These tests mock the heavy dependencies (scores, debt-scoring, brain, getMacro)
// and focus on the composition logic in buildCapitalAllocationReport.

vi.mock('../../server/macro/getMacro', () => ({
  getMacro: vi.fn(),
}));

vi.mock('../../server/warehouse/scores', () => ({
  scoreProperties: vi.fn(),
}));

vi.mock('../../server/warehouse/debt-scoring', () => ({
  scoreDebtPositions: vi.fn(),
}));

vi.mock('../../server/warehouse/metrics', () => ({
  propertyPeriodMetrics: vi.fn(),
}));

describe('buildCapitalAllocationReport integration', () => {
  // Dynamic import after mocks are set up
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let buildCapitalAllocationReport: (db: any, snapshot: any) => Promise<any>;
  let getMacroMock: ReturnType<typeof vi.fn>;
  let scorePropertiesMock: ReturnType<typeof vi.fn>;
  let scoreDebtPositionsMock: ReturnType<typeof vi.fn>;
  let propertyPeriodMetricsMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.resetModules();
    const macroMod = await import('../../server/macro/getMacro');
    const scoresMod = await import('../../server/warehouse/scores');
    const debtMod = await import('../../server/warehouse/debt-scoring');
    const metricsMod = await import('../../server/warehouse/metrics');

    getMacroMock = vi.mocked(macroMod.getMacro);
    scorePropertiesMock = vi.mocked(scoresMod.scoreProperties);
    scoreDebtPositionsMock = vi.mocked(debtMod.scoreDebtPositions);
    propertyPeriodMetricsMock = vi.mocked(metricsMod.propertyPeriodMetrics);

    const mod = await import('../../server/warehouse/capital-allocation');
    buildCapitalAllocationReport = mod.buildCapitalAllocationReport;
  });

  /** Mock DB with a stub prepare() that returns an empty .all() (no balloon debt positions). */
  function makeMockDb(balloonRows: Array<{ property_id: string; months_to_maturity: number | null }> = []) {
    return {
      prepare: () => ({
        all: () => balloonRows,
      }),
    };
  }

  /** Minimal mock snapshot with 3 properties and leases. */
  function makeSnapshot() {
    return {
      meta: { asOf: '2026-06-21' },
      properties: [
        { id: 'PROP-A', name: 'Alpha Warehouse', market: 'Columbus', rentableSf: 20_000, noi: 200_000 },
        { id: 'PROP-B', name: 'Beta Flex', market: 'Cincinnati', rentableSf: 15_000, noi: 120_000 },
        { id: 'PROP-C', name: 'Gamma Industrial', market: 'Columbus', rentableSf: 10_000, noi: 80_000 },
      ],
      leases: [
        // PROP-A: 2 leases in ≤12m bucket, one at-risk
        {
          id: 'L-1', propertyId: 'PROP-A', annualRent: 80_000, sf: 10_000,
          monthsToExpiry: 3, leaseEnd: '2026-09-30', status: 'Active',
          leaseStart: '2021-09-30', company: 'Tenant A', tenantName: 'Tenant A',
          monthToMonth: false,
        },
        {
          id: 'L-2', propertyId: 'PROP-A', annualRent: 60_000, sf: 8_000,
          monthsToExpiry: 10, leaseEnd: '2027-04-30', status: 'Active',
          leaseStart: '2022-04-30', company: 'Tenant B', tenantName: 'Tenant B',
          monthToMonth: false,
        },
        // PROP-B: 1 lease, 24m+ (no near-term risk)
        {
          id: 'L-3', propertyId: 'PROP-B', annualRent: 90_000, sf: 15_000,
          monthsToExpiry: 30, leaseEnd: '2028-12-31', status: 'Active',
          leaseStart: '2020-01-01', company: 'Tenant C', tenantName: 'Tenant C',
          monthToMonth: false,
        },
        // PROP-C: 1 lease, expired (lapsing)
        {
          id: 'L-4', propertyId: 'PROP-C', annualRent: 70_000, sf: 10_000,
          monthsToExpiry: -1, leaseEnd: '2026-01-31', status: 'Active',   // past end, not 'Expired'
          leaseStart: '2021-02-01', company: 'Tenant D', tenantName: 'Tenant D',
          monthToMonth: false,
        },
      ],
      renewalStages: {},
      tenantArrears: {},
      marketRents: {},
    };
  }

  function makePropertyScores() {
    return [
      {
        propertyId: 'PROP-A',
        propertyName: 'Alpha Warehouse',
        period: '2025',
        health: 30,
        healthBand: 'concern',
        attentionBand: 'red',
        capitalAction: 'monitor',
        subScores: {},
        noiPerSfQuartile: 3,
        benchmarkCohortSize: 5,
        reasons: [],
      },
      {
        propertyId: 'PROP-B',
        propertyName: 'Beta Flex',
        period: '2025',
        health: 75,
        healthBand: 'good',
        attentionBand: 'green',
        capitalAction: 'invest',
        subScores: {},
        noiPerSfQuartile: 2,
        benchmarkCohortSize: 5,
        reasons: [],
      },
      {
        propertyId: 'PROP-C',
        propertyName: 'Gamma Industrial',
        period: '2025',
        health: 55,
        healthBand: 'watch',
        attentionBand: 'yellow',
        capitalAction: 'hold',
        subScores: {},
        noiPerSfQuartile: 3,
        benchmarkCohortSize: 5,
        reasons: [],
      },
    ];
  }

  function makeDebtScores() {
    return [
      // PROP-A: has debt, balloon soon, DSCR below governor
      {
        propertyId: 'PROP-A',
        propertyName: 'Alpha Warehouse',
        noiBasis: 'spine-b/warehouse-ledger',
        dscr: 1.1,
        dscrHeadroom: -0.15,
        ltv: 0.35,
        ltvHeadroom: 0.05,
        debtYield: 0.08,
        signal: 'hold',
        signalReason: null,
        score: 45,
        scoreBand: 'watch',
        capitalConfigVersion: 1,
      },
      // PROP-B: no debt
      {
        propertyId: 'PROP-B',
        propertyName: 'Beta Flex',
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
        capitalConfigVersion: 1,
      },
    ];
  }

  it('returns 3 entries sorted DESC by priorityScore', async () => {
    getMacroMock.mockResolvedValue({
      asOf: '2026-06-21',
      source: 'fred',
      indicators: [
        { id: 'DGS10', label: '10Y Treasury', value: 4.47, unit: '%', change: null },
        { id: 'CPIAUCSL', label: 'CPI (YoY)', value: 3.8, unit: '%', change: null },
      ],
      tenYearHistory: [],
    });
    scorePropertiesMock.mockReturnValue(makePropertyScores());
    scoreDebtPositionsMock.mockReturnValue(makeDebtScores());
    propertyPeriodMetricsMock.mockReturnValue([]);

    const report = await buildCapitalAllocationReport(makeMockDb() as never, makeSnapshot()) as typeof CapitalAllocationReport._type;

    expect(report.propertyCount).toBe(3);
    expect(report.entries).toHaveLength(3);
    expect(report.portfolioNoBasis).toBe('spine-a');

    // Sorted DESC by priorityScore
    const scores = report.entries.map((e: { priorityScore: number }) => e.priorityScore) as number[];
    for (let i = 0; i < scores.length - 1; i++) {
      expect(scores[i]!).toBeGreaterThanOrEqual(scores[i + 1]!);
    }
  });

  it('getMacro throws → macro falls back to mock/null', async () => {
    getMacroMock.mockRejectedValue(new Error('FRED unavailable'));
    scorePropertiesMock.mockReturnValue([]);
    scoreDebtPositionsMock.mockReturnValue([]);
    propertyPeriodMetricsMock.mockReturnValue([]);

    const report = await buildCapitalAllocationReport(makeMockDb() as never, makeSnapshot()) as typeof CapitalAllocationReport._type;

    expect(report.macro.source).toBe('mock');
    expect(report.macro.tenYearRate).toBeNull();
    expect(report.macro.cpi).toBeNull();
    expect(report.macro.asOf).toBeNull();
  });

  it('property with no debt in scoreDebtPositions → debtScore null, balloonMonths null', async () => {
    getMacroMock.mockResolvedValue({
      asOf: '2026-06-21',
      source: 'fred',
      indicators: [
        { id: 'DGS10', value: 4.47, label: '10Y', unit: '%', change: null },
        { id: 'CPIAUCSL', value: 3.8, label: 'CPI', unit: '%', change: null },
      ],
      tenYearHistory: [],
    });
    scorePropertiesMock.mockReturnValue([{
      propertyId: 'PROP-B',
      propertyName: 'Beta Flex',
      period: '2025',
      health: 75,
      healthBand: 'good',
      attentionBand: 'green',
      capitalAction: 'invest',
      subScores: {},
      noiPerSfQuartile: 2,
      benchmarkCohortSize: 5,
      reasons: [],
    }]);
    // No debt score for PROP-B
    scoreDebtPositionsMock.mockReturnValue([]);
    propertyPeriodMetricsMock.mockReturnValue([]);

    // Use a snapshot with only PROP-B
    const snap = {
      ...makeSnapshot(),
      properties: [{ id: 'PROP-B', name: 'Beta Flex', market: 'Cincinnati', rentableSf: 15_000, noi: 120_000 }],
      leases: makeSnapshot().leases.filter((l) => l.propertyId === 'PROP-B'),
    };

    const report = await buildCapitalAllocationReport(makeMockDb() as never, snap) as typeof CapitalAllocationReport._type;
    const entry = report.entries[0] as typeof report.entries[number] | undefined;
    expect(entry).toBeDefined();
    if (!entry) throw new Error('entry must be defined');
    expect(entry.debtScore).toBeNull();
    expect(entry.balloonMonths).toBeNull();
    expect(entry.dscr).toBeNull();
  });

  it('counts action types correctly', async () => {
    getMacroMock.mockResolvedValue({
      asOf: '2026-06-21',
      source: 'mock',
      indicators: [],
      tenYearHistory: [],
    });
    scorePropertiesMock.mockReturnValue(makePropertyScores());
    scoreDebtPositionsMock.mockReturnValue(makeDebtScores());
    propertyPeriodMetricsMock.mockReturnValue([]);

    const report = await buildCapitalAllocationReport(makeMockDb() as never, makeSnapshot()) as typeof CapitalAllocationReport._type;

    // PROP-A → monitor, PROP-B → invest, PROP-C → hold
    expect(report.investCount).toBe(1);
    expect(report.holdCount).toBe(1);
    expect(report.monitorCount).toBe(1);
    expect(report.dispositionCount).toBe(0);
  });

  it('portfolioNoi is sum of Spine A property NOI', async () => {
    getMacroMock.mockResolvedValue({
      asOf: '2026-06-21', source: 'mock', indicators: [], tenYearHistory: [],
    });
    scorePropertiesMock.mockReturnValue(makePropertyScores());
    scoreDebtPositionsMock.mockReturnValue(makeDebtScores());
    propertyPeriodMetricsMock.mockReturnValue([]);

    const report = await buildCapitalAllocationReport(makeMockDb() as never, makeSnapshot()) as typeof CapitalAllocationReport._type;
    // 200_000 + 120_000 + 80_000 = 400_000
    expect(report.portfolioNoi).toBe(400_000);
  });
});
