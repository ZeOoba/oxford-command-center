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

import { getMacro } from '../../server/macro/getMacro';
import { scoreProperties } from '../../server/warehouse/scores';
import { scoreDebtPositions } from '../../server/warehouse/debt-scoring';
import type { PropertyScore } from '../../src/contracts/warehouse';
import type { DebtScore } from '../../src/contracts/debt';

const mockGetMacro = vi.mocked(getMacro);
const mockScoreProperties = vi.mocked(scoreProperties);
const mockScoreDebt = vi.mocked(scoreDebtPositions);

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


beforeEach(() => {
  mockGetMacro.mockResolvedValue(makeMacro(4.18) as never);
  mockScoreProperties.mockReturnValue([]);
  mockScoreDebt.mockReturnValue([]);
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
    expect(result.advisoryOnly).toBe(true);  // ratification='proposed' in cold DB
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
