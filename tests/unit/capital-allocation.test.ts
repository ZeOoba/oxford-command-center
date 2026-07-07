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

/** Seed a full active acq_candidates + acq_score_inputs + acq_scores chain for C-3 pipeline tests. */
function seedCandidate(
  db: WarehouseDb,
  opts: {
    id: string;
    market?: 'owned-submarket' | 'established' | 'entry' | 'satellite' | 'none';
    composite: number;
    tier: 'T1' | 'T2' | 'PASS' | 'KILLED';
    leveredIrr?: number | null;
    basisDiscountPct?: number | null;
  },
): void {
  const now = '2026-06-21T00:00:00Z';
  db.prepare(`INSERT INTO acq_candidates (id, source, market, status, created_at, updated_at)
    VALUES (?, 'manual', ?, 'active', ?, ?)`).run(opts.id, opts.market ?? 'established', now, now);
  const inputsVersion = `iv-${opts.id}`;
  db.prepare(`
    INSERT INTO acq_score_inputs (candidate_id, inputs_version, input_json, ruleset_version, rct_version)
    VALUES (?, ?, '{}', '1.0.0', 'replacement-cost.v1')
  `).run(opts.id, inputsVersion);
  const scoreInputId = (
    db.prepare('SELECT id FROM acq_score_inputs WHERE candidate_id = ? AND inputs_version = ?')
      .get(opts.id, inputsVersion) as { id: number }
  ).id;
  const scoreJson = JSON.stringify({
    leveredIrr: opts.leveredIrr ?? null,
    basisDiscountPct: opts.basisDiscountPct ?? null,
  });
  db.prepare(`
    INSERT INTO acq_scores (candidate_id, score_input_id, inputs_version, composite, tier, verdict,
      advisory_only, capped_at_t2, gates_passed, floors_passed, floor_indeterminate, score_json)
    VALUES (?, ?, ?, ?, ?, 'PURSUE', 1, 0, 1, 1, 0, ?)
  `).run(opts.id, scoreInputId, inputsVersion, opts.composite, opts.tier, scoreJson);
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

  it('C3-buy: a single buyable T1 candidate (composite≥70, basis discount clears floor) emits a buy verdict', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    seedCandidate(db, { id: 'cand-buy-1', composite: 80, tier: 'T1', basisDiscountPct: 0.10 });
    mockScoreProperties.mockReturnValue([]);
    mockScoreDebt.mockReturnValue([]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    expect(result.actionCounts.buy).toBe(1);
    const buyVerdicts = result.verdicts.filter((v) => v.action === 'buy');
    expect(buyVerdicts).toHaveLength(1);
    expect(buyVerdicts[0]!.propertyId).toBe('pipeline:cand-buy-1');
  });

  it('C3-buy-basisdiscount-null-ok: null basisDiscountPct does not block a buy verdict', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    seedCandidate(db, { id: 'cand-buy-null-basis', composite: 75, tier: 'T2', basisDiscountPct: null });
    mockScoreProperties.mockReturnValue([]);
    mockScoreDebt.mockReturnValue([]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    expect(result.actionCounts.buy).toBe(1);
  });

  it('C3-basisdiscount-null-flagged: null basisDiscountPct passing the gate is surfaced as a dataQuality warning', async () => {
    // basisDiscountPct===null is indistinguishable between "genuinely N/A" and "score never
    // computed it" (score_json may simply lack the key). Since null passes the buyable gate
    // (per spec), that ambiguity must be visible downstream, not silently invisible.
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    seedCandidate(db, { id: 'cand-null-basis-flag', composite: 75, tier: 'T2', basisDiscountPct: null });
    mockScoreProperties.mockReturnValue([]);
    mockScoreDebt.mockReturnValue([]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    const buyVerdict = result.verdicts.find((v) => v.action === 'buy')!;
    expect(buyVerdict.dataQuality.some((f) => f.field === 'basisDiscountPct' && f.severity === 'warn')).toBe(true);
  });

  it('C3-basisdiscount-known-not-flagged: a known basisDiscountPct raises no ambiguity warning', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    seedCandidate(db, { id: 'cand-known-basis', composite: 75, tier: 'T2', basisDiscountPct: 0.10 });
    mockScoreProperties.mockReturnValue([]);
    mockScoreDebt.mockReturnValue([]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    const buyVerdict = result.verdicts.find((v) => v.action === 'buy')!;
    expect(buyVerdict.dataQuality.some((f) => f.field === 'basisDiscountPct')).toBe(false);
  });

  it('C3-buy-topranked: buy verdict references the highest-composite buyable candidate', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    seedCandidate(db, { id: 'cand-lower', composite: 75, tier: 'T1', basisDiscountPct: 0.10 });
    seedCandidate(db, { id: 'cand-higher', composite: 90, tier: 'T2', basisDiscountPct: 0.10 });
    mockScoreProperties.mockReturnValue([]);
    mockScoreDebt.mockReturnValue([]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    expect(result.actionCounts.buy).toBe(1);
    const buyVerdict = result.verdicts.find((v) => v.action === 'buy')!;
    expect(buyVerdict.propertyId).toBe('pipeline:cand-higher');
  });

  it('C3-floor-neg: composite below 70 → NOT buyable, no buy verdict', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    seedCandidate(db, { id: 'cand-low-composite', composite: 65, tier: 'T1', basisDiscountPct: 0.10 });
    mockScoreProperties.mockReturnValue([]);
    mockScoreDebt.mockReturnValue([]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    expect(result.actionCounts.buy).toBe(0);
    expect(result.verdicts.every((v) => v.action !== 'buy')).toBe(true);
  });

  it('C3-basisdiscount-neg: basis discount below the 5% floor → NOT buyable, no buy verdict', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    seedCandidate(db, { id: 'cand-thin-basis', composite: 85, tier: 'T1', basisDiscountPct: 0.02 });
    mockScoreProperties.mockReturnValue([]);
    mockScoreDebt.mockReturnValue([]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    expect(result.actionCounts.buy).toBe(0);
  });

  it('C3-tier-neg: PASS/KILLED tier never buyable regardless of composite', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    seedCandidate(db, { id: 'cand-passed', composite: 95, tier: 'PASS', basisDiscountPct: 0.10 });
    seedCandidate(db, { id: 'cand-killed', composite: 95, tier: 'KILLED', basisDiscountPct: 0.10 });
    mockScoreProperties.mockReturnValue([]);
    mockScoreDebt.mockReturnValue([]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    expect(result.actionCounts.buy).toBe(0);
  });

  it('C3-inputs-placeholder: buy verdict.inputs uses documented neutral placeholders, not fabricated real data', async () => {
    const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
    const db = freshDb();
    seedCandidate(db, { id: 'cand-inputs-check', composite: 80, tier: 'T1', basisDiscountPct: 0.10 });
    mockScoreProperties.mockReturnValue([]);
    mockScoreDebt.mockReturnValue([]);
    const result = await buildPortfolioAllocation(db, '2026-06-21');
    const buyVerdict = result.verdicts.find((v) => v.action === 'buy')!;
    expect(buyVerdict.inputs.dscr).toBeNull();
    expect(buyVerdict.inputs.ltv).toBeNull();
    expect(buyVerdict.inputs.noiPerSf).toBeNull();
    expect(buyVerdict.expectedReturnPct).toBeNull(); // C-4 deferred
    expect(buyVerdict.reasons.some((r) => /not applicable/i.test(r))).toBe(true);
  });
});
