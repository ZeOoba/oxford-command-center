// @vitest-environment node
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';

vi.mock('../../server/macro/getMacro', () => ({ getMacro: vi.fn() }));
vi.mock('../../server/warehouse/scores', () => ({ scoreProperties: vi.fn() }));
vi.mock('../../server/warehouse/debt-scoring', () => ({ scoreDebtPositions: vi.fn() }));
// Preserve latestFullYearPeriod/isOperatingRealEstate (real implementations, used by
// capital-allocation.ts's currentSpineBNoi helper) — only propertyPeriodMetrics is mocked,
// so C-4 tests can hand a controlled Spine-B fixture without a real ledger ingest.
import type * as MetricsModule from '../../server/warehouse/metrics';

vi.mock('../../server/warehouse/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof MetricsModule>();
  return { ...actual, propertyPeriodMetrics: vi.fn() };
});

import { getMacro } from '../../server/macro/getMacro';
import { scoreProperties } from '../../server/warehouse/scores';
import { scoreDebtPositions } from '../../server/warehouse/debt-scoring';
import { propertyPeriodMetrics } from '../../server/warehouse/metrics';
import type { PropertyScore } from '../../src/contracts/warehouse';
import type { DebtScore } from '../../src/contracts/debt';
import type { PeriodMetrics } from '../../src/contracts/warehouse';
import type { PortfolioSnapshot, Property } from '../../src/contracts/index';
import { _projectUnleveredReturn, PROJECTION_ASSUMPTIONS } from '../../server/warehouse/capital-allocation';

const mockGetMacro = vi.mocked(getMacro);
const mockScoreProperties = vi.mocked(scoreProperties);
const mockScoreDebt = vi.mocked(scoreDebtPositions);
const mockPropertyPeriodMetrics = vi.mocked(propertyPeriodMetrics);

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'cap-alloc-test-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

function makeMacro(dgs5: number | null) {
  return {
    asOf: '2026-06-21', source: 'mock' as const,
    indicators: [
      { id: 'DGS5', label: '5Y Treasury', value: dgs5, unit: '%', change: null },
      { id: 'CPIAUCSL', label: 'CPI (YoY)', value: 3.8, unit: '%', change: null },
    ],
    tenYearHistory: [],
  };
}

function makePropertyScore(overrides: Partial<PropertyScore> = {}): PropertyScore {
  return {
    propertyId: 'prop-test',
    propertyName: 'Test Property',
    period: '2025',
    health: 70,
    healthBand: 'good',
    attentionBand: 'yellow',
    capitalAction: 'hold',
    subScores: { noi: 70, growth: 60, efficiency: 65 },
    noiPerSfQuartile: 2,
    benchmarkCohortSize: 5,
    reasons: ['Test property'],
    ...overrides,
  };
}

function makeDebtScore(overrides: Partial<DebtScore> = {}): DebtScore {
  return {
    propertyId: 'prop-test',
    propertyName: 'Test Property',
    noiBasis: 'ledger',
    dscr: 1.45,
    dscrHeadroom: 0.20,
    ltv: 0.30,
    ltvHeadroom: 0.10,
    debtYield: 0.10,
    signal: 'hold',
    signalReason: null,
    score: 75,
    scoreBand: 'strong',
    capitalConfigVersion: 1,
    ...overrides,
  };
}


function makePeriodMetrics(overrides: Partial<PeriodMetrics> = {}): PeriodMetrics {
  return {
    propertyId: 'prop-test',
    propertyName: 'Test Property',
    period: '2025',
    grainHint: 'year',
    basis: 'accrual',
    rentableSf: 20000,
    ownershipPct: 1,
    revenue: 150000,
    opex: 75000,
    noi: 75000,
    noiMargin: 0.5,
    expenseRatio: 0.5,
    capex: 0,
    ti: 0,
    leasing: 0,
    categories: {},
    revenueCategories: {},
    revenuePerSf: 7.5,
    noiPerSf: 3.75,
    expensePerSf: 3.75,
    taxesPerSf: null,
    insurancePerSf: null,
    repairsPerSf: null,
    oxfordNoi: 75000,
    ...overrides,
  };
}

function makeProperty(overrides: Partial<Property> & { id: string }): Property {
  return {
    index: 1,
    name: overrides.id,
    address: overrides.id,
    city: null,
    state: null,
    market: 'Columbus OH',
    type: 'Flex',
    sf: 20000,
    tenantCount: 1,
    occPct: 1,
    acqDate: null,
    estValue100: 1000000,
    oxfordOwnPct: 1,
    oxfordValue: 1000000,
    grossIncome: 150000,
    expenses: 75000,
    noi: 75000,
    noiScenarioAdj: 75000,
    debtService: 0,
    netCashFlow: 75000,
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
    ...overrides,
  };
}

function makeSnapshot(properties: Property[]): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: '2026-06-21', generatedAt: '2026-06-21T00:00:00.000Z', source: 'test', scenario: 'Base' },
    assumptions: {
      activeScenario: 'Base',
      revenueFactor: 1,
      vacancyFactor: 1,
      exitCapFactor: 1,
      thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 },
      asOf: '2026-06-21',
    },
    properties,
    leases: [],
    loans: [],
    cash: { asOf: '2026-06-21', totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
    insurance: [],
    deals: [],
    tasks: [],
    counterparties: [],
    renewalStages: {},
    tenantNotes: {},
    dealComps: {},
    noiBudgets: {},
    tenantArrears: {},
    acquisitionInputs: {},
    marketRents: {},
    quickbooks: null,
    dataQuality: [],
  } as unknown as PortfolioSnapshot;
}

beforeEach(() => {
  mockGetMacro.mockResolvedValue(makeMacro(4.18) as never);
  mockScoreProperties.mockReturnValue([]);
  mockScoreDebt.mockReturnValue([]);
  mockPropertyPeriodMetrics.mockReturnValue([]);
});

describe('buildPortfolioAllocation', () => {
  it('A-1: empty warehouse — returns valid PortfolioAllocation with 0 verdicts', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    expect(result.verdicts).toHaveLength(0);
    expect(result.pipeline).toHaveLength(0);
    expect(result.asOf).toBe('2026-06-21');
    expect(result.hurdleRatePct).toBeCloseTo(0.08, 5);
    expect(result.advisoryOnly).toBe(false);  // ratification='ratified' in cold DB (ratified 2026-06-22)
    expect(result.actionCounts).toMatchObject({ buy: 0, hold: 0, sell: 0, refinance: 0, improve: 0 });
  });

  it('A-2: disposition-candidate → action=sell, riskBand=high', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    mockScoreProperties.mockReturnValue([
      makePropertyScore({ propertyId: 'prop-sell', capitalAction: 'disposition-candidate', healthBand: 'concern' }),
    ]);
    mockScoreDebt.mockReturnValue([
      makeDebtScore({ propertyId: 'prop-sell', signal: 'hold' }),
    ]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    expect(result.verdicts).toHaveLength(1);
    const v = result.verdicts[0]!;
    expect(v.action).toBe('sell');
    expect(v.riskBand).toBe('high');
    expect(v.timelineMonths).toBe(9); // I-2: sell timeline aligned to spec TIMELINE table (was 12)
    expect(v.inputs.capitalAction).toBe('disposition-candidate');
  });

  it('A-3: healthy property (good+hold) → NOT sell (no false positive); cash-out signal → refinance', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    mockScoreProperties.mockReturnValue([
      makePropertyScore({ propertyId: 'prop-healthy', capitalAction: 'hold', healthBand: 'good' }),
    ]);
    mockScoreDebt.mockReturnValue([
      makeDebtScore({ propertyId: 'prop-healthy', signal: 'cash-out' }),
    ]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    expect(result.verdicts).toHaveLength(1);
    // capitalAction='hold' → cannot be 'sell' even with cash-out signal
    expect(result.verdicts[0]!.action).not.toBe('sell');
    // cash-out signal → refinance (not sell, not hold)
    expect(result.verdicts[0]!.action).toBe('refinance');
  });

  it('A-4: forecastInputs absent → all verdicts have horizonPeriods=0 and confidence01 ≤ 0.65', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    mockScoreProperties.mockReturnValue([makePropertyScore()]);
    mockScoreDebt.mockReturnValue([makeDebtScore()]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    expect(result.verdicts.length).toBeGreaterThan(0);
    for (const v of result.verdicts) {
      expect(v.horizonPeriods).toBe(0);
      expect(v.confidence01).toBeLessThanOrEqual(0.65);
    }
  });

  it('A-5: forecastInputs provided → horizonPeriods = forecastInputs.periods', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    mockScoreProperties.mockReturnValue([makePropertyScore()]);
    mockScoreDebt.mockReturnValue([makeDebtScore()]);
    const result = await buildPortfolioAllocation(db, '2026-06-21', { periods: 8 });
    expect(result.verdicts.length).toBeGreaterThan(0);
    for (const v of result.verdicts) {
      expect(v.horizonPeriods).toBe(8);
    }
  });

  it('A-6: debtSignal=governor-block → action=hold (not refinance)', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    mockScoreProperties.mockReturnValue([
      makePropertyScore({ propertyId: 'prop-govblock', capitalAction: 'hold', healthBand: 'watch' }),
    ]);
    mockScoreDebt.mockReturnValue([
      makeDebtScore({ propertyId: 'prop-govblock', signal: 'governor-block', scoreBand: 'critical' }),
    ]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    expect(result.verdicts).toHaveLength(1);
    const v = result.verdicts[0]!;
    expect(v.action).toBe('hold');
    expect(v.action).not.toBe('refinance');
    expect(v.inputs.debtSignal).toBe('governor-block');
  });

  it('A-7: actionCounts sums to verdicts.length (buy always 0)', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    mockScoreProperties.mockReturnValue([
      makePropertyScore({ propertyId: 'p1', capitalAction: 'hold' }),
      makePropertyScore({ propertyId: 'p2', capitalAction: 'disposition-candidate', healthBand: 'concern' }),
    ]);
    mockScoreDebt.mockReturnValue([
      makeDebtScore({ propertyId: 'p1', signal: 'hold' }),
      makeDebtScore({ propertyId: 'p2', signal: 'hold' }),
    ]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    const total = Object.values(result.actionCounts).reduce((a, b) => a + b, 0);
    // buy is always 0 in actionCounts (buy verdicts are in pipeline[])
    expect(result.actionCounts.buy).toBe(0);
    expect(total).toBe(result.verdicts.length);
    expect(result.verdicts.length).toBe(2);
  });

  it('A-8: pipeline shows active acq_candidates; status=archived excluded', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    // Seed one active and one archived candidate
    const now = '2026-06-21T00:00:00Z';
    db.prepare(`INSERT INTO acq_candidates (id, source, status, created_at, updated_at)
      VALUES ('cand-active', 'manual', 'active', ?, ?)`).run(now, now);
    db.prepare(`INSERT INTO acq_candidates (id, source, status, created_at, updated_at)
      VALUES ('cand-archived', 'manual', 'archived', ?, ?)`).run(now, now);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    const ids = result.pipeline.map(p => p.candidateId);
    expect(ids).toContain('cand-active');
    expect(ids).not.toContain('cand-archived');
  });

  it('A-9: returnAboveHurdle is null when expectedReturnPct is null', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    mockScoreProperties.mockReturnValue([makePropertyScore({ capitalAction: 'hold' })]);
    mockScoreDebt.mockReturnValue([makeDebtScore({ signal: 'hold' })]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    expect(result.verdicts.length).toBeGreaterThan(0);
    for (const v of result.verdicts) {
      if (v.expectedReturnPct === null) {
        expect(v.returnAboveHurdle).toBeNull();
      }
    }
  });

  it('A-10: getMacro failure (FRED down) is non-fatal — result still returned with dscr signal as hold', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    mockGetMacro.mockRejectedValue(new Error('FRED API timeout'));
    const db = freshDb();
    // Should not throw
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    expect(result).toBeDefined();
    expect(result.verdicts).toBeDefined();
    expect(Array.isArray(result.verdicts)).toBe(true);
    // When macro is unavailable (FRED down), dgs5 defaults to null; engine must not throw.
    // All verdicts that exist must have valid action and numeric timelineMonths.
    if (result.verdicts.length > 0) {
      const firstVerdict = result.verdicts[0]!;
      expect(typeof firstVerdict.timelineMonths).toBe('number');
      expect(['hold', 'sell', 'refi', 'acquire']).toContain(firstVerdict.action);
    }
  });

  it('A-2-neg: disposition-candidate but healthBand=good → NOT sell (C-1 independent guard)', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    // capitalAction flags disposition, but health is NOT 'concern' → sell guard must NOT fire.
    mockScoreProperties.mockReturnValue([
      makePropertyScore({ propertyId: 'prop-dispo-healthy', capitalAction: 'disposition-candidate', healthBand: 'good' }),
    ]);
    mockScoreDebt.mockReturnValue([
      makeDebtScore({ propertyId: 'prop-dispo-healthy', signal: 'hold' }),
    ]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    expect(result.verdicts).toHaveLength(1);
    const v = result.verdicts[0]!;
    // C-1: sell requires capitalAction='disposition-candidate' AND healthBand='concern'.
    expect(v.action).not.toBe('sell');
    // Falls through to default hold (no refi/invest signal present).
    expect(v.action).toBe('hold');
    expect(v.inputs.capitalAction).toBe('disposition-candidate');
    expect(v.inputs.healthBand).toBe('good');
  });

  it('A-3-neg: debtSignal=hold → NOT refinance (Phase 5 v1: refi gates on signal, not savings)', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    // Phase 5 v1: refinance fires ONLY on signal in ('refi','cash-out'). A plain 'hold'
    // (or 'no-debt') signal must NOT produce refinance. Phase 5 v2 will add a
    // refiCashSavingsPct() savings gate on top of the signal (C-2 deferral).
    mockScoreProperties.mockReturnValue([
      makePropertyScore({ propertyId: 'prop-no-refi', capitalAction: 'hold', healthBand: 'good' }),
    ]);
    mockScoreDebt.mockReturnValue([
      makeDebtScore({ propertyId: 'prop-no-refi', signal: 'hold' }),
    ]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    expect(result.verdicts).toHaveLength(1);
    const v = result.verdicts[0]!;
    expect(v.action).not.toBe('refinance');
    expect(v.action).toBe('hold');
    expect(v.inputs.debtSignal).toBe('hold');
  });

  it('A-4-neg: empty acq_candidates → zero buy verdicts (C-3: buy emission deferred to v2)', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    // No acq_candidates seeded. One ordinary hold property exists.
    mockScoreProperties.mockReturnValue([
      makePropertyScore({ propertyId: 'prop-hold', capitalAction: 'hold' }),
    ]);
    mockScoreDebt.mockReturnValue([
      makeDebtScore({ propertyId: 'prop-hold', signal: 'hold' }),
    ]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    // Phase 5 v1 (C-3): no buy AllocationVerdict is ever emitted; buy count stays 0.
    expect(result.pipeline).toHaveLength(0);
    expect(result.actionCounts.buy).toBe(0);
    expect(result.verdicts.every((v) => v.action !== 'buy')).toBe(true);
  });
});

describe('_projectUnleveredReturn (C-4: unlevered IRR projection)', () => {
  it('C4-1: returns a rate whose reconstructed NPV over the same cash-flow series is ~0', () => {
    const entryValue = 1_000_000;
    const currentNoi = 75_000; // 7.5% going-in yield — matches the exit cap rate assumption
    const irr = _projectUnleveredReturn(entryValue, currentNoi);
    expect(irr).not.toBeNull();

    const { holdYears, noiGrowthPct, exitCapRate } = PROJECTION_ASSUMPTIONS;
    let npv = -entryValue;
    for (let year = 1; year <= holdYears; year++) {
      const noiThisYear = currentNoi * (1 + noiGrowthPct) ** year;
      const cf = year < holdYears
        ? noiThisYear
        : noiThisYear + (currentNoi * (1 + noiGrowthPct) ** (holdYears + 1)) / exitCapRate;
      npv += cf / (1 + irr!) ** year;
    }
    expect(Math.abs(npv)).toBeLessThan(1); // within $1 on ~$1M+ cash flows
  });

  it('C4-2: flat-cap scenario (entry yield = exit cap rate) lands near cap-rate + growth-rate', () => {
    // Standard real-estate approximation when the cap rate doesn't move over the hold:
    // unlevered IRR ≈ going-in cap rate + NOI CAGR = 7.5% + 3% ≈ 10.5%. Not exact (the
    // approximation ignores compounding/terminal-year effects), so assert a band, not
    // an exact value — this catches gross errors (sign flips, wrong exponents) without
    // being brittle to the approximation's known slack.
    const irr = _projectUnleveredReturn(1_000_000, 75_000);
    expect(irr).not.toBeNull();
    expect(irr!).toBeGreaterThan(0.09);
    expect(irr!).toBeLessThan(0.12);
  });

  it('C4-3: higher going-in yield (same growth/exit assumptions) produces a higher IRR', () => {
    const lowYield = _projectUnleveredReturn(1_000_000, 60_000); // 6% going-in
    const highYield = _projectUnleveredReturn(1_000_000, 90_000); // 9% going-in
    expect(lowYield).not.toBeNull();
    expect(highYield).not.toBeNull();
    expect(highYield!).toBeGreaterThan(lowYield!);
  });

  it('C4-4: non-positive or non-finite entryValue returns null (never throws/NaN)', () => {
    expect(_projectUnleveredReturn(0, 75_000)).toBeNull();
    expect(_projectUnleveredReturn(-1_000_000, 75_000)).toBeNull();
    expect(_projectUnleveredReturn(Infinity, 75_000)).toBeNull();
    expect(_projectUnleveredReturn(NaN, 75_000)).toBeNull();
  });

  it('C4-5: non-positive or non-finite currentNoi returns null (never throws/NaN)', () => {
    expect(_projectUnleveredReturn(1_000_000, 0)).toBeNull();
    expect(_projectUnleveredReturn(1_000_000, -75_000)).toBeNull();
    expect(_projectUnleveredReturn(1_000_000, Infinity)).toBeNull();
    expect(_projectUnleveredReturn(1_000_000, NaN)).toBeNull();
  });

  it('C4-6: extreme-but-valid inputs never throw and never return NaN/Infinity', () => {
    expect(() => _projectUnleveredReturn(1, 1_000_000_000)).not.toThrow();
    const extreme = _projectUnleveredReturn(1, 1_000_000_000);
    expect(extreme === null || Number.isFinite(extreme)).toBe(true);
  });
});

describe('buildPortfolioAllocation — expectedReturnPct wiring (C-4)', () => {
  it('C4-7: with a snapshot + Spine-B NOI, expectedReturnPct and returnAboveHurdle populate', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    mockScoreProperties.mockReturnValue([makePropertyScore({ propertyId: 'prop-wired', capitalAction: 'hold' })]);
    mockScoreDebt.mockReturnValue([makeDebtScore({ propertyId: 'prop-wired', signal: 'hold' })]);
    mockPropertyPeriodMetrics.mockReturnValue([
      makePeriodMetrics({ propertyId: 'prop-wired', period: '2025', oxfordNoi: 75_000 }),
    ]);
    const snapshot = makeSnapshot([makeProperty({ id: 'prop-wired', oxfordValue: 1_000_000 })]);

    const result = await buildPortfolioAllocation(db, '2026-06-21', undefined, snapshot);
    expect(result.verdicts).toHaveLength(1);
    const v = result.verdicts[0]!;
    expect(v.expectedReturnPct).not.toBeNull();
    expect(v.expectedReturnPct!).toBeGreaterThan(0.09);
    expect(v.expectedReturnPct!).toBeLessThan(0.12);
    // returnAboveHurdle must be the direct comparison against the report's own hurdleRatePct —
    // not just "some boolean" (a real assertion, not a tautology).
    expect(v.returnAboveHurdle).toBe(v.expectedReturnPct! >= result.hurdleRatePct);
    expect(v.dataQuality).toHaveLength(0);
  });

  it('C4-8: latest FULL-YEAR period is used, not a more-recent YTD partial (basis-consistency with scores.ts)', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    mockScoreProperties.mockReturnValue([makePropertyScore({ propertyId: 'prop-fy', capitalAction: 'hold' })]);
    mockScoreDebt.mockReturnValue([makeDebtScore({ propertyId: 'prop-fy', signal: 'hold' })]);
    mockPropertyPeriodMetrics.mockReturnValue([
      makePeriodMetrics({ propertyId: 'prop-fy', period: '2025', grainHint: 'year', oxfordNoi: 75_000 }),
      // A later but YTD (non-full-year) partial with a very different NOI — must be ignored.
      makePeriodMetrics({ propertyId: 'prop-fy', period: '2026-05', grainHint: 'month', oxfordNoi: 999_999 }),
    ]);
    const snapshot = makeSnapshot([makeProperty({ id: 'prop-fy', oxfordValue: 1_000_000 })]);

    const result = await buildPortfolioAllocation(db, '2026-06-21', undefined, snapshot);
    const v = result.verdicts[0]!;
    // If the YTD partial (oxfordNoi=999,999) leaked in, the resulting IRR would be absurdly
    // high (well above the flat-cap band asserted below).
    expect(v.expectedReturnPct!).toBeGreaterThan(0.09);
    expect(v.expectedReturnPct!).toBeLessThan(0.12);
  });

  it('C4-8b: property with ONLY sub-annual (YTD/month) coverage — no full-year period at all — ' +
     'must stay null, never annualize a partial NOI (adversarial-refute regression, 2026-07-07)', async () => {
    // This is the exact defect the mandatory refute-financial-change pass caught before commit:
    // an earlier revision fell back to the latest RAW row (sorted[sorted.length-1]) when no
    // full-year period existed, then fed that sub-annual figure into _projectUnleveredReturn
    // as if it were an annual NOI — understating a newly onboarded property's return by
    // roughly the periods-per-year factor (~12x for a single month) instead of abstaining.
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    mockScoreProperties.mockReturnValue([makePropertyScore({ propertyId: 'prop-ytd-only', capitalAction: 'hold' })]);
    mockScoreDebt.mockReturnValue([makeDebtScore({ propertyId: 'prop-ytd-only', signal: 'hold' })]);
    mockPropertyPeriodMetrics.mockReturnValue([
      // Only a single month's worth of Spine-B data — no 'year'-grain row exists anywhere.
      // A true ~$180k/yr run-rate property would show ~$75,000 across just 5 YTD months;
      // the buggy fallback would treat this figure itself as the FULL annual NOI.
      makePeriodMetrics({ propertyId: 'prop-ytd-only', period: '2026-05', grainHint: 'month', oxfordNoi: 75_000 }),
    ]);
    const snapshot = makeSnapshot([makeProperty({ id: 'prop-ytd-only', oxfordValue: 2_000_000 })]);

    const result = await buildPortfolioAllocation(db, '2026-06-21', undefined, snapshot);
    const v = result.verdicts[0]!;
    // Must abstain (null), not fabricate a deeply negative/understated IRR from a partial NOI.
    expect(v.expectedReturnPct).toBeNull();
    expect(v.returnAboveHurdle).toBeNull();
    expect(v.dataQuality).toHaveLength(1);
    expect(v.dataQuality[0]!.field).toBe('expectedReturnPct');
  });

  it('C4-9: no snapshot supplied → expectedReturnPct stays null (pre-v2 backward compatibility)', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    mockScoreProperties.mockReturnValue([makePropertyScore({ propertyId: 'prop-nosnap', capitalAction: 'hold' })]);
    mockScoreDebt.mockReturnValue([makeDebtScore({ propertyId: 'prop-nosnap', signal: 'hold' })]);
    mockPropertyPeriodMetrics.mockReturnValue([
      makePeriodMetrics({ propertyId: 'prop-nosnap', period: '2025', oxfordNoi: 75_000 }),
    ]);
    // No snapshot argument — Spine-B NOI exists, but there's no entry value to discount against.
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    const v = result.verdicts[0]!;
    expect(v.expectedReturnPct).toBeNull();
    expect(v.returnAboveHurdle).toBeNull();
    expect(v.dataQuality).toHaveLength(1);
    expect(v.dataQuality[0]!.field).toBe('expectedReturnPct');
  });

  it('C4-10: snapshot present but oxfordValue non-positive → expectedReturnPct stays null', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    mockScoreProperties.mockReturnValue([makePropertyScore({ propertyId: 'prop-zerovalue', capitalAction: 'hold' })]);
    mockScoreDebt.mockReturnValue([makeDebtScore({ propertyId: 'prop-zerovalue', signal: 'hold' })]);
    mockPropertyPeriodMetrics.mockReturnValue([
      makePeriodMetrics({ propertyId: 'prop-zerovalue', period: '2025', oxfordNoi: 75_000 }),
    ]);
    const snapshot = makeSnapshot([makeProperty({ id: 'prop-zerovalue', oxfordValue: 0 })]);

    const result = await buildPortfolioAllocation(db, '2026-06-21', undefined, snapshot);
    const v = result.verdicts[0]!;
    expect(v.expectedReturnPct).toBeNull();
  });
});
