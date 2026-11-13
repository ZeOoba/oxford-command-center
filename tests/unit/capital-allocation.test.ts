// @vitest-environment node
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';

vi.mock('../../server/macro/getMacro', () => ({ getMacro: vi.fn() }));
vi.mock('../../server/warehouse/scores', () => ({ scoreProperties: vi.fn() }));
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
import { persistAndLogScore } from '../../server/warehouse/acq-engine';
import { parseRuleset, loadRatifiedRct } from '../../server/warehouse/acquisition';
import { AcquisitionInput } from '../../src/contracts/acquisition';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

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
    refiCashSavingsPct: 0.05,
    bookTrust: 'trusted', // round 19 — these fixtures model a healthy book unless a test overrides
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

  it('A-7: actionCounts sums to verdicts.length (no acq_candidates seeded here → buy stays 0)', async () => {
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
    // C-3: buy is gated on buyable.length > 0 (§3.5). This test seeds no acq_candidates at all,
    // so the buyable list is empty and buy correctly stays 0 — see the C3-buy* tests for the
    // populated-pipeline cases.
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

  it('A-3-neg: debtSignal=hold → NOT refinance (refi gates on signal + drivable savings)', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    // Refinance fires only on signal in ('refi','cash-out') AND a drivable refiCashSavingsPct.
    // A plain 'hold' (or 'no-debt') signal must NOT produce refinance regardless of savings.
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

  it('A-4-neg: empty acq_candidates → zero buy verdicts (empty pipeline ⇒ empty buyable list)', async () => {
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
    // C-3: buy is gated on buyable.length > 0 (§3.5) — an empty pipeline can never satisfy that.
    expect(result.pipeline).toHaveLength(0);
    expect(result.actionCounts.buy).toBe(0);
    expect(result.verdicts.every((v) => v.action !== 'buy')).toBe(true);
  });

  it('C2-A3: signal=refi with a drivable refiCashSavingsPct → action=refinance', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    mockScoreProperties.mockReturnValue([
      makePropertyScore({ propertyId: 'prop-refi-ok', capitalAction: 'hold', healthBand: 'good' }),
    ]);
    mockScoreDebt.mockReturnValue([
      makeDebtScore({ propertyId: 'prop-refi-ok', signal: 'refi', refiCashSavingsPct: 0.02 }),
    ]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0]!.action).toBe('refinance');
  });

  it('C2-A3-neg: signal=refi but refiCashSavingsPct=null (undrivable) → NOT refinance, falls to hold', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    mockScoreProperties.mockReturnValue([
      makePropertyScore({ propertyId: 'prop-refi-undrivable', capitalAction: 'hold', healthBand: 'good' }),
    ]);
    mockScoreDebt.mockReturnValue([
      makeDebtScore({ propertyId: 'prop-refi-undrivable', signal: 'refi', refiCashSavingsPct: null }),
    ]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    expect(result.verdicts).toHaveLength(1);
    const v = result.verdicts[0]!;
    expect(v.action).not.toBe('refinance');
    expect(v.action).toBe('hold');
    expect(v.reasons.some((r) => /savings undrivable/i.test(r))).toBe(true);
  });

  it('C2-cashout-neg: signal=cash-out but refiCashSavingsPct=null (undrivable) → NOT refinance', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    mockScoreProperties.mockReturnValue([
      makePropertyScore({ propertyId: 'prop-cashout-undrivable', capitalAction: 'hold', healthBand: 'good' }),
    ]);
    mockScoreDebt.mockReturnValue([
      makeDebtScore({ propertyId: 'prop-cashout-undrivable', signal: 'cash-out', refiCashSavingsPct: null }),
    ]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    expect(result.verdicts).toHaveLength(1);
    expect(result.verdicts[0]!.action).not.toBe('refinance');
  });

  // C3-* portfolio BUY-gate tests moved to capital-allocation.buy-gate.test.ts (audit 2026-10-13
  // G2): they now seed REAL persistAndLogScore output instead of hand-written score_json.
});

describe('buildPortfolioAllocation — stale governor regime (refute wf_f5f45202-de8)', () => {
  const ratifiedJson = JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8'));
  const RULESET = parseRuleset(ratifiedJson);
  const RCT = loadRatifiedRct();
  // Strong deal: DSCR proxy = 0.12 / (0.40 x 0.085) = 3.53 -> clears dscr_floor 1.25, fails 4.0.
  const STRONG = AcquisitionInput.parse({
    dealId: 'stale-strong', price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
    productType: 'shallow-bay-multi', officePct: 0.1, clearHeightFt: 28, hasDriveIn: true, hasDock: true,
    dockCount: 6, driveInCount: 6, multiStory: false, truckCourtFt: 120,
    constructionType: 'block-tilt-brick', yearBuilt: 2005, sfhaOnPad: false, allInBasis: 3_600_000,
    stabilizedYoc: 0.12, leveredIrr: 0.18, unleveredIrr10yr: 0.12, underwriteHorizonYrs: 5, clusterTier: 'owned-submarket',
    sellerMotivationScore: 0.8, isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5,
    valueAddScore: 0.5, ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
  });

  function addConfigVersion(db: WarehouseDb, version: number, dscrFloor: number): void {
    db.prepare(`INSERT INTO capital_config
      (version, effective_from, dscr_floor, ltv_ceiling, disposition_cap_rate, hold_cap_rate, acq_irr,
       capex_irr, refi_trigger_bps, payout_pct, notes)
      SELECT ?, '2026-10-13', ?, ltv_ceiling, disposition_cap_rate, hold_cap_rate, acq_irr, capex_irr,
             refi_trigger_bps, payout_pct, 'test regime change'
      FROM capital_config WHERE version = 1`).run(version, dscrFloor);
  }

  async function scoreReal(db: WarehouseDb, id: string): Promise<void> {
    db.prepare(`INSERT OR IGNORE INTO acq_candidates (id, source, market, status) VALUES (?, 'manual', 'owned-submarket', 'active')`).run(id);
    await persistAndLogScore(db, id, STRONG, RULESET, RCT);
  }

  /** An older governor regime stamp (capital_config version 0 never exists in a fresh warehouse). */
  const OLD_REGIME = '0:1.25:0.4:0.085';

  /**
   * Rewrite a candidate's latest REAL acq_scores row (written by persistAndLogScore) into a legacy /
   * corrupt shape — the same pattern as capital-allocation.buy-gate.test.ts mutateLatest. Replaces the
   * former hand-written seedCandidate fixture (advisory_only=1, null yield actual, input_json '{}',
   * DSCR NULL), which the audit 2026-10-13 G1/G2 BUY gate can never admit.
   *   regime: null removes score_json.governorRegime; a string overwrites it.
   */
  function mutateLatestScore(
    db: WarehouseDb,
    id: string,
    o: {
      regime?: string | null;
      verdict?: 'PURSUE' | 'WATCH' | 'PASS' | 'KILLED';
      dscr?: 0 | 1 | null;
      composite?: number;
      basis?: { passed: boolean; actual: number };
    },
  ): void {
    const row = db
      .prepare('SELECT id, score_json FROM acq_scores WHERE candidate_id = ? ORDER BY scored_at DESC, id DESC LIMIT 1')
      .get(id) as { id: number; score_json: string };
    const blob = JSON.parse(row.score_json) as Record<string, unknown> & { floors: Array<Record<string, unknown>> };
    if (o.regime === null) delete blob['governorRegime'];
    else if (o.regime !== undefined) blob['governorRegime'] = o.regime;
    if (o.verdict !== undefined) blob['verdict'] = o.verdict;
    if (o.composite !== undefined) blob['composite'] = o.composite;
    if (o.basis !== undefined) blob.floors = blob.floors.map((f) => (f['id'] === 'basis' ? { ...f, ...o.basis } : f));
    db.prepare('UPDATE acq_scores SET score_json = ? WHERE id = ?').run(JSON.stringify(blob), row.id);
    if (o.verdict !== undefined) db.prepare('UPDATE acq_scores SET verdict = ? WHERE id = ?').run(o.verdict, row.id);
    if (o.composite !== undefined) db.prepare('UPDATE acq_scores SET composite = ? WHERE id = ?').run(o.composite, row.id);
    if (o.dscr !== undefined) db.prepare('UPDATE acq_scores SET governor_dscr_cleared = ? WHERE id = ?').run(o.dscr, row.id);
  }

  beforeEach(() => {
    mockScoreProperties.mockReturnValue([]);
    mockScoreDebt.mockReturnValue([]);
  });

  it('control: a strong candidate scored under the CURRENT governors still emits BUY', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    await scoreReal(db, 'cand-fresh');
    const result = await buildPortfolioAllocation(db, '2026-10-13');
    expect(result.actionCounts.buy).toBe(1);
  });

  it('REPRO: score under v1 (dscr 1.25), raise dscr_floor to 4.0 (proxy now fails), no re-score -> NO buy', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    await scoreReal(db, 'cand-stale');
    addConfigVersion(db, 2, 4.0);
    const result = await buildPortfolioAllocation(db, '2026-10-13');
    expect(result.actionCounts.buy).toBe(0);
  });

  it('fail-closed by regime, not value: a looser-or-equal-passing v2 floor (1.30) still blocks until re-scored', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    await scoreReal(db, 'cand-stale-pass');
    addConfigVersion(db, 2, 1.3);
    expect((await buildPortfolioAllocation(db, '2026-10-13')).actionCounts.buy).toBe(0);
    // Re-score under v2: new inputs_version row becomes the latest and is current -> BUY returns.
    await scoreReal(db, 'cand-stale-pass');
    expect((await buildPortfolioAllocation(db, '2026-10-13')).actionCounts.buy).toBe(1);
  });

  it('re-score under the raised floor demotes the verdict (governor fails) -> still no buy', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    await scoreReal(db, 'cand-rescored-fail');
    addConfigVersion(db, 2, 4.0);
    await scoreReal(db, 'cand-rescored-fail');
    expect((await buildPortfolioAllocation(db, '2026-10-13')).actionCounts.buy).toBe(0);
  });

  it('legacy row with no governorRegime stamp is BUY-ineligible until re-scored (real score, stamp removed)', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    await scoreReal(db, 'cand-legacy');
    expect((await buildPortfolioAllocation(db, '2026-10-13')).actionCounts.buy).toBe(1); // control: buyable as scored
    mutateLatestScore(db, 'cand-legacy', { regime: null });
    expect((await buildPortfolioAllocation(db, '2026-10-13')).actionCounts.buy).toBe(0);
  });

  it('re-score of UNCHANGED inputs backfills a missing stamp (legacy post-#213 row under the current regime)', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    await scoreReal(db, 'cand-backfill');
    db.prepare(`UPDATE acq_scores SET score_json = json_remove(score_json, '$.governorRegime') WHERE candidate_id = ?`).run('cand-backfill');
    expect((await buildPortfolioAllocation(db, '2026-10-13')).actionCounts.buy).toBe(0);
    await scoreReal(db, 'cand-backfill'); // same inputs + regime => same inputs_version => INSERT OR IGNORE no-op
    expect(db.prepare('SELECT COUNT(*) AS n FROM acq_scores WHERE candidate_id = ?').get('cand-backfill')).toEqual({ n: 1 });
    expect((await buildPortfolioAllocation(db, '2026-10-13')).actionCounts.buy).toBe(1);
  });

  it('backfill never overwrites an existing (older-regime) stamp', async () => {
    const db = freshDb();
    await scoreReal(db, 'cand-keep');
    db.prepare(`UPDATE acq_scores SET score_json = json_set(score_json, '$.governorRegime', '0:old') WHERE candidate_id = ?`).run('cand-keep');
    await scoreReal(db, 'cand-keep');
    const row = db.prepare(`SELECT json_extract(score_json, '$.governorRegime') AS r FROM acq_scores WHERE candidate_id = ?`).get('cand-keep') as { r: string };
    expect(row.r).toBe('0:old');
  });

  // Option A merge: #463's backfill guard still refuses to certify a drifted output, but on this
  // branch a drifted same-key row is SUPERSEDED by the live engine output (audit W2a X1) instead of
  // being left in place. The drifted composite is therefore never stamped; the row ends up carrying
  // the FRESH output with the FRESH stamp. Formerly asserted stamp null + BUY withheld (no supersede).
  it('backfill never stamps a drifted row: the drifted output is superseded by the live output + fresh stamp', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    await scoreReal(db, 'cand-drift');
    const original = db.prepare(`SELECT composite, json_extract(score_json, '$.governorRegime') AS r FROM acq_scores WHERE candidate_id = ?`).get('cand-drift') as { composite: number; r: string };
    db.prepare(`UPDATE acq_scores SET composite = composite + 5, score_json = json_remove(score_json, '$.governorRegime') WHERE candidate_id = ?`).run('cand-drift');
    expect((await buildPortfolioAllocation(db, '2026-10-13')).actionCounts.buy).toBe(0); // drifted + unstamped: withheld
    const res = await persistAndLogScore(db, 'cand-drift', STRONG, RULESET, RCT);
    expect(res.persisted).toBe('superseded');
    const row = db.prepare(`SELECT composite, json_extract(score_json, '$.governorRegime') AS r FROM acq_scores WHERE candidate_id = ?`).get('cand-drift') as { composite: number; r: string | null };
    expect(row.composite).toBe(original.composite); // the drifted +5 was not kept, let alone stamped
    expect(row.r).toBe(original.r);                 // fresh stamp = the live regime
    expect((await buildPortfolioAllocation(db, '2026-10-13')).actionCounts.buy).toBe(1);
  });

  it('stale disclosure includes a governor-demoted PASS (old regime) with T1 tier (real score, legacy pre-alignment shape)', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    await scoreReal(db, 'cand-old-demoted');
    // Pre-tier-alignment legacy shape: tier T1 next to a governor-demoted PASS, under an older regime.
    mutateLatestScore(db, 'cand-old-demoted', { regime: OLD_REGIME, verdict: 'PASS', dscr: 0 });
    const result = await buildPortfolioAllocation(db, '2026-10-13');
    expect(result.actionCounts.buy).toBe(0);
    expect(result.dataQuality.find((f) => f.field === 'governorRegime')?.issue).toMatch(/cand-old-demoted/);
  });

  it('all would-be-buyable candidates stale => no BUY but portfolio-level dataQuality warn names them (real score, older stamp)', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    await scoreReal(db, 'cand-all-stale');
    mutateLatestScore(db, 'cand-all-stale', { regime: OLD_REGIME });
    const result = await buildPortfolioAllocation(db, '2026-10-13');
    expect(result.actionCounts.buy).toBe(0);
    const flag = result.dataQuality.find((f) => f.field === 'governorRegime');
    expect(flag?.severity).toBe('warn');
    expect(flag?.issue).toMatch(/cand-all-stale/);
  });

  it('stale disclosure excludes candidates that fail BUY anyway (basis floor, governor already failed, below composite floor) (real scores)', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    await scoreReal(db, 'cand-thin');
    mutateLatestScore(db, 'cand-thin', { regime: OLD_REGIME, basis: { passed: false, actual: 0.02 } });
    await scoreReal(db, 'cand-govfail');
    mutateLatestScore(db, 'cand-govfail', { regime: OLD_REGIME, dscr: 0 });
    await scoreReal(db, 'cand-lowcomp');
    mutateLatestScore(db, 'cand-lowcomp', { regime: OLD_REGIME, composite: 50 });
    const result = await buildPortfolioAllocation(db, '2026-10-13');
    expect(result.actionCounts.buy).toBe(0);
    expect(result.dataQuality).toEqual([]);
  });

  it('a stale top-ranked candidate is skipped for the next fresh one, and the portfolio dataQuality discloses the exclusion (real scores)', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    // Identical real scores: absent staleness the candidateId tie-break would pick cand-a-top-stale.
    await scoreReal(db, 'cand-a-top-stale');
    await scoreReal(db, 'cand-b-next-fresh');
    expect((await buildPortfolioAllocation(db, '2026-10-13')).verdicts.find((v) => v.action === 'buy')?.propertyId)
      .toBe('pipeline:cand-a-top-stale'); // control
    mutateLatestScore(db, 'cand-a-top-stale', { regime: OLD_REGIME });
    const result = await buildPortfolioAllocation(db, '2026-10-13');
    const buy = result.verdicts.find((v) => v.action === 'buy')!;
    expect(buy.propertyId).toBe('pipeline:cand-b-next-fresh');
    expect(buy.dataQuality.find((f) => f.field === 'governorRegime')).toBeUndefined(); // single home: portfolio-level
    const flag = result.dataQuality.find((f) => f.field === 'governorRegime');
    expect(flag?.severity).toBe('warn');
    expect(flag?.issue).toMatch(/cand-a-top-stale/);
    expect(flag?.issue).not.toMatch(/cand-b-next-fresh/);
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
    // Round 19e: dataQuality may ALSO carry a 'debtBook' flag now — book-level trust is derived
    // from the real (unseeded, empty) debt_positions table, independent of this test's mocked
    // scoreDebtPositions return value (the D1 fix: the two must not be able to disagree). This
    // test's own subject is expectedReturnPct, so exclude the unrelated 'debtBook' flag rather
    // than asserting only on the one field — a stray THIRD, unrelated dataQuality entry (a future
    // regression) would otherwise go unnoticed (round 19f tightening).
    expect(v.dataQuality.filter((f) => f.field !== 'debtBook')).toHaveLength(0);
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
    // Round 19e/19f: see the C4-7 note above — dataQuality may also carry an unrelated 'debtBook'
    // flag from the real (unseeded) debt book; excluded rather than merely checked-for so a stray
    // extra/duplicate expectedReturnPct flag would still be caught.
    expect(v.dataQuality.filter((f) => f.field !== 'debtBook')).toEqual([
      expect.objectContaining({ field: 'expectedReturnPct' }),
    ]);
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
    expect(v.dataQuality.filter((f) => f.field !== 'debtBook')).toEqual([
      expect.objectContaining({ field: 'expectedReturnPct' }),
    ]);
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

// ── Improve action + capexIrr proxy gate ─────────────────────────────────────────
//
// capexIrrEstimate is a PROXY, not a real capex-cost data source (deferred to a real
// data source per the original Phase 5 v2 handoff): it assumes an ASSUMED_CAPEX_PSF
// spend fully closes the gap between a property's noiPerSf and the portfolio median,
// then checks whether the implied yield on that assumed spend clears the hurdle. It
// gates ONLY the action selection (improve vs. degrade-to-hold) — per Gabriel's decision
// (2026-07-07), the verdict's expectedReturnPct continues to reuse the same general
// C-4 unlevered-return figure computed upstream, not a separate capex-specific number.
describe('buildPortfolioAllocation — improve action / capexIrr proxy', () => {
  it('C5-improve: capitalAction=invest, noiPerSf well below portfolio median, proxy clears hurdle → action=improve', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    // rentableSf=10_000 for all three → noiPerSf = 15, 10, 5. Median = 10.
    // gap = 10 - 5 = 5; capexIrrEstimate = 5 / ASSUMED_CAPEX_PSF(10) = 0.5 (50%) >> hurdle (8%).
    mockScoreProperties.mockReturnValue([
      makePropertyScore({ propertyId: 'prop-a', capitalAction: 'hold', healthBand: 'good' }),
      makePropertyScore({ propertyId: 'prop-b', capitalAction: 'hold', healthBand: 'good' }),
      makePropertyScore({ propertyId: 'prop-invest', capitalAction: 'invest', healthBand: 'watch' }),
    ]);
    mockScoreDebt.mockReturnValue([
      makeDebtScore({ propertyId: 'prop-a', signal: 'hold' }),
      makeDebtScore({ propertyId: 'prop-b', signal: 'hold' }),
      makeDebtScore({ propertyId: 'prop-invest', signal: 'hold' }),
    ]);
    mockPropertyPeriodMetrics.mockReturnValue([
      makePeriodMetrics({ propertyId: 'prop-a', rentableSf: 10_000, noi: 150_000, noiPerSf: 15 }),
      makePeriodMetrics({ propertyId: 'prop-b', rentableSf: 10_000, noi: 100_000, noiPerSf: 10 }),
      makePeriodMetrics({ propertyId: 'prop-invest', rentableSf: 10_000, noi: 50_000, noiPerSf: 5 }),
    ]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    const v = result.verdicts.find((r) => r.propertyId === 'prop-invest')!;
    expect(v.action).toBe('improve');
    expect(v.timelineMonths).toBe(12); // spec TIMELINE table: improve = 12
  });

  it('C5-improve-neg-hurdle: proxy gap too small to clear hurdle → stays hold', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    // noiPerSf = 15, 10, 9.7 → median = 10. gap = 0.3; capexIrrEstimate = 0.03 (3%) < 8% hurdle.
    mockScoreProperties.mockReturnValue([
      makePropertyScore({ propertyId: 'prop-a', capitalAction: 'hold' }),
      makePropertyScore({ propertyId: 'prop-b', capitalAction: 'hold' }),
      makePropertyScore({ propertyId: 'prop-invest', capitalAction: 'invest' }),
    ]);
    mockScoreDebt.mockReturnValue([
      makeDebtScore({ propertyId: 'prop-a', signal: 'hold' }),
      makeDebtScore({ propertyId: 'prop-b', signal: 'hold' }),
      makeDebtScore({ propertyId: 'prop-invest', signal: 'hold' }),
    ]);
    mockPropertyPeriodMetrics.mockReturnValue([
      makePeriodMetrics({ propertyId: 'prop-a', rentableSf: 10_000, noi: 150_000, noiPerSf: 15 }),
      makePeriodMetrics({ propertyId: 'prop-b', rentableSf: 10_000, noi: 100_000, noiPerSf: 10 }),
      makePeriodMetrics({ propertyId: 'prop-invest', rentableSf: 10_000, noi: 97_000, noiPerSf: 9.7 }),
    ]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    const v = result.verdicts.find((r) => r.propertyId === 'prop-invest')!;
    expect(v.action).not.toBe('improve');
    expect(v.action).toBe('hold');
  });

  it('C5-improve-neg-thin-cohort: fewer than 3 properties have noiPerSf → median null → improve never fires', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    // Only 2 properties total — portfolioNoiPerSfMedian cannot be computed (spec: needs ≥3).
    mockScoreProperties.mockReturnValue([
      makePropertyScore({ propertyId: 'prop-b', capitalAction: 'hold' }),
      makePropertyScore({ propertyId: 'prop-invest', capitalAction: 'invest' }),
    ]);
    mockScoreDebt.mockReturnValue([
      makeDebtScore({ propertyId: 'prop-b', signal: 'hold' }),
      makeDebtScore({ propertyId: 'prop-invest', signal: 'hold' }),
    ]);
    mockPropertyPeriodMetrics.mockReturnValue([
      makePeriodMetrics({ propertyId: 'prop-b', rentableSf: 10_000, noi: 100_000, noiPerSf: 10 }),
      // Huge gap — would clear any hurdle if the median were computed, but must not fire.
      makePeriodMetrics({ propertyId: 'prop-invest', rentableSf: 10_000, noi: 10_000, noiPerSf: 1 }),
    ]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    const v = result.verdicts.find((r) => r.propertyId === 'prop-invest')!;
    expect(v.action).not.toBe('improve');
    expect(v.action).toBe('hold');
  });

  it('C5-improve-neg-no-metrics: invest property has no PeriodMetrics at all → noiPerSf undrivable → hold', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    mockScoreProperties.mockReturnValue([
      makePropertyScore({ propertyId: 'prop-a', capitalAction: 'hold' }),
      makePropertyScore({ propertyId: 'prop-b', capitalAction: 'hold' }),
      makePropertyScore({ propertyId: 'prop-invest', capitalAction: 'invest' }),
    ]);
    mockScoreDebt.mockReturnValue([
      makeDebtScore({ propertyId: 'prop-a', signal: 'hold' }),
      makeDebtScore({ propertyId: 'prop-b', signal: 'hold' }),
      makeDebtScore({ propertyId: 'prop-invest', signal: 'hold' }),
    ]);
    mockPropertyPeriodMetrics.mockReturnValue([
      makePeriodMetrics({ propertyId: 'prop-a', rentableSf: 10_000, noi: 150_000, noiPerSf: 15 }),
      makePeriodMetrics({ propertyId: 'prop-b', rentableSf: 10_000, noi: 100_000, noiPerSf: 10 }),
      // prop-invest deliberately absent — no ledger data for it at all.
    ]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    const v = result.verdicts.find((r) => r.propertyId === 'prop-invest')!;
    expect(v.action).not.toBe('improve');
    expect(v.action).toBe('hold');
  });

  it('C5-improve-neg-above-median: capitalAction=invest but noiPerSf already at/above median → stays hold', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    // prop-invest's noiPerSf (15) is the TOP of the cohort, not below the median (10).
    mockScoreProperties.mockReturnValue([
      makePropertyScore({ propertyId: 'prop-invest', capitalAction: 'invest' }),
      makePropertyScore({ propertyId: 'prop-b', capitalAction: 'hold' }),
      makePropertyScore({ propertyId: 'prop-c', capitalAction: 'hold' }),
    ]);
    mockScoreDebt.mockReturnValue([
      makeDebtScore({ propertyId: 'prop-invest', signal: 'hold' }),
      makeDebtScore({ propertyId: 'prop-b', signal: 'hold' }),
      makeDebtScore({ propertyId: 'prop-c', signal: 'hold' }),
    ]);
    mockPropertyPeriodMetrics.mockReturnValue([
      makePeriodMetrics({ propertyId: 'prop-invest', rentableSf: 10_000, noi: 150_000, noiPerSf: 15 }),
      makePeriodMetrics({ propertyId: 'prop-b', rentableSf: 10_000, noi: 100_000, noiPerSf: 10 }),
      makePeriodMetrics({ propertyId: 'prop-c', rentableSf: 10_000, noi: 50_000, noiPerSf: 5 }),
    ]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    const v = result.verdicts.find((r) => r.propertyId === 'prop-invest')!;
    expect(v.action).not.toBe('improve');
    expect(v.action).toBe('hold');
  });

  it('C5-improve-reuses-c4-return: improve verdict expectedReturnPct is the same general unlevered-return figure, not a separate capex number', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    mockScoreProperties.mockReturnValue([
      makePropertyScore({ propertyId: 'prop-a', capitalAction: 'hold' }),
      makePropertyScore({ propertyId: 'prop-b', capitalAction: 'hold' }),
      makePropertyScore({ propertyId: 'prop-invest', capitalAction: 'invest' }),
    ]);
    mockScoreDebt.mockReturnValue([
      makeDebtScore({ propertyId: 'prop-a', signal: 'hold' }),
      makeDebtScore({ propertyId: 'prop-b', signal: 'hold' }),
      makeDebtScore({ propertyId: 'prop-invest', signal: 'hold' }),
    ]);
    mockPropertyPeriodMetrics.mockReturnValue([
      makePeriodMetrics({ propertyId: 'prop-a', rentableSf: 10_000, noi: 150_000, noiPerSf: 15, oxfordNoi: 150_000 }),
      makePeriodMetrics({ propertyId: 'prop-b', rentableSf: 10_000, noi: 100_000, noiPerSf: 10, oxfordNoi: 100_000 }),
      makePeriodMetrics({ propertyId: 'prop-invest', rentableSf: 10_000, noi: 50_000, noiPerSf: 5, oxfordNoi: 50_000 }),
    ]);
    const snapshot = makeSnapshot([makeProperty({ id: 'prop-invest', oxfordValue: 1_000_000 })]);
    const result = await buildPortfolioAllocation(db, '2026-06-21', undefined, snapshot);
    const v = result.verdicts.find((r) => r.propertyId === 'prop-invest')!;
    expect(v.action).toBe('improve');
    // Same _projectUnleveredReturn(oxfordValue, oxfordNoi) figure C-4 computes for every action.
    expect(v.expectedReturnPct).not.toBeNull();
    expect(v.expectedReturnPct!).toBeCloseTo(_projectUnleveredReturn(1_000_000, 50_000)!, 6);
  });

  it('C5-improve-basis-discipline: a cash-basis outlier must NOT pollute the accrual-basis peer median (G3 cross-basis discipline)', async () => {
    // Only 2 accrual-basis properties exist (prop-a, prop-invest) — same-basis peer count is
    // below the 3-peer floor, so the median must be null and improve must NOT fire, even though
    // a THIRD (cash-basis) property exists that would push the pooled count to 3 if basis were
    // ignored. This is the exact G3 discipline scores.ts already enforces (rankProperties/
    // population partition by basis) — the capexIrr proxy must not silently reintroduce a
    // cross-basis comparison the rest of the engine was hardened against.
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    mockScoreProperties.mockReturnValue([
      makePropertyScore({ propertyId: 'prop-a', capitalAction: 'hold' }),
      makePropertyScore({ propertyId: 'prop-invest', capitalAction: 'invest' }),
      makePropertyScore({ propertyId: 'prop-cash-outlier', capitalAction: 'hold' }),
    ]);
    mockScoreDebt.mockReturnValue([
      makeDebtScore({ propertyId: 'prop-a', signal: 'hold' }),
      makeDebtScore({ propertyId: 'prop-invest', signal: 'hold' }),
      makeDebtScore({ propertyId: 'prop-cash-outlier', signal: 'hold' }),
    ]);
    mockPropertyPeriodMetrics.mockReturnValue([
      makePeriodMetrics({ propertyId: 'prop-a', basis: 'accrual', rentableSf: 10_000, noi: 150_000, noiPerSf: 15 }),
      makePeriodMetrics({ propertyId: 'prop-invest', basis: 'accrual', rentableSf: 10_000, noi: 50_000, noiPerSf: 5 }),
      // Extreme cash-basis outlier: if pooled cross-basis, this would push the pooled sample
      // to 3 values and produce a spurious median (and a spurious 'improve' fire). Must be
      // excluded from prop-invest's (accrual-basis) peer group entirely.
      makePeriodMetrics({ propertyId: 'prop-cash-outlier', basis: 'cash', rentableSf: 10_000, noi: 10_000_000, noiPerSf: 1000 }),
    ]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    const v = result.verdicts.find((r) => r.propertyId === 'prop-invest')!;
    expect(v.action).not.toBe('improve');
    expect(v.action).toBe('hold');
  });

  it('C5-improve-dataquality-flag: a drivable capexIrr (fired or not) gets a structured DataQualityFlag, matching the expectedReturnPct/basisDiscountPct precedent', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    mockScoreProperties.mockReturnValue([
      makePropertyScore({ propertyId: 'prop-a', capitalAction: 'hold' }),
      makePropertyScore({ propertyId: 'prop-b', capitalAction: 'hold' }),
      makePropertyScore({ propertyId: 'prop-invest', capitalAction: 'invest' }),
    ]);
    mockScoreDebt.mockReturnValue([
      makeDebtScore({ propertyId: 'prop-a', signal: 'hold' }),
      makeDebtScore({ propertyId: 'prop-b', signal: 'hold' }),
      makeDebtScore({ propertyId: 'prop-invest', signal: 'hold' }),
    ]);
    mockPropertyPeriodMetrics.mockReturnValue([
      makePeriodMetrics({ propertyId: 'prop-a', rentableSf: 10_000, noi: 150_000, noiPerSf: 15 }),
      makePeriodMetrics({ propertyId: 'prop-b', rentableSf: 10_000, noi: 100_000, noiPerSf: 10 }),
      makePeriodMetrics({ propertyId: 'prop-invest', rentableSf: 10_000, noi: 50_000, noiPerSf: 5 }),
    ]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    const v = result.verdicts.find((r) => r.propertyId === 'prop-invest')!;
    expect(v.action).toBe('improve');
    expect(v.dataQuality.some((f) => f.field === 'capexIrr' && f.severity === 'info')).toBe(true);
  });

  it('C5-improve-dataquality-no-flag: no drivable capexIrr → no capexIrr DataQualityFlag (nothing to disclose)', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    mockScoreProperties.mockReturnValue([
      makePropertyScore({ propertyId: 'prop-hold', capitalAction: 'hold' }),
    ]);
    mockScoreDebt.mockReturnValue([
      makeDebtScore({ propertyId: 'prop-hold', signal: 'hold' }),
    ]);
    mockPropertyPeriodMetrics.mockReturnValue([
      makePeriodMetrics({ propertyId: 'prop-hold', rentableSf: 10_000, noi: 100_000, noiPerSf: 10 }),
    ]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    const v = result.verdicts.find((r) => r.propertyId === 'prop-hold')!;
    expect(v.dataQuality.some((f) => f.field === 'capexIrr')).toBe(false);
  });
});
