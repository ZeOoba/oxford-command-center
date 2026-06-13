// tests/unit/intel-ownership-view.test.ts
//
// Pure helpers backing OwnershipView (the view itself is browser-verified, not
// jsdom-rendered). They roll the per-(property,period) metric rows into a portfolio band
// (count, Σ latest-FY NOI, Σ latest-FY Oxford-share NOI) and count the scores that need
// ownership attention (orange+red bands) / are disposition candidates. The synthesis
// transforms (rankByAttention, buildActionList, …) are tested in intel-synthesis.test.ts
// and are NOT retested here. Deterministic, null-safe.
import { describe, expect, it } from 'vitest';
import { attentionCounts, portfolioTotals } from '../../src/modules/intel/ownership-intel';
import type { PeriodMetrics, PropertyScore } from '../../src/modules/intel/analytics-hooks';

const pm = (
  propertyId: string,
  period: string,
  grainHint: string | null,
  over: Partial<PeriodMetrics> = {},
): PeriodMetrics => ({
  propertyId,
  propertyName: propertyId.toUpperCase(),
  period,
  grainHint,
  rentableSf: 10000,
  ownershipPct: 1,
  revenue: 100,
  opex: 40,
  noi: 60,
  noiMargin: 0.6,
  expenseRatio: 0.4,
  capex: 0,
  ti: 0,
  leasing: 0,
  categories: {},
  revenueCategories: {},
  revenuePerSf: 0.01,
  noiPerSf: 0.006,
  expensePerSf: 0.004,
  taxesPerSf: 0.001,
  insurancePerSf: 0.0005,
  repairsPerSf: 0.0008,
  oxfordNoi: 60,
  ...over,
});

const score = (id: string, attentionBand: string, capitalAction: string): PropertyScore =>
  ({
    propertyId: id,
    propertyName: id,
    period: '2025',
    health: 60,
    healthBand: 'good',
    attentionBand,
    capitalAction,
    subScores: {},
    noiPerSfQuartile: 2,
    reasons: [],
  }) as unknown as PropertyScore;

describe('portfolioTotals', () => {
  it('sums latest full-year NOI / Oxford NOI per property and counts properties', () => {
    const metrics: PeriodMetrics[] = [
      pm('a', '2023', 'year', { noi: 100, oxfordNoi: 100 }),
      pm('a', '2024', 'year', { noi: 120, oxfordNoi: 120 }), // a's latest FY
      pm('b', '2024', 'year', { noi: 200, oxfordNoi: 100, ownershipPct: 0.5 }), // b's latest FY
    ];
    const t = portfolioTotals(metrics);
    expect(t.propertyCount).toBe(2);
    expect(t.portfolioNoi).toBe(320); // 120 + 200
    expect(t.oxfordNoi).toBe(220); // 120 + 100
  });

  it('ignores YTD/partial rows — only full years count toward the band', () => {
    const metrics: PeriodMetrics[] = [
      pm('a', '2024', 'year', { noi: 120, oxfordNoi: 120 }),
      pm('a', '2026', 'ytd', { noi: 999, oxfordNoi: 999 }), // partial — excluded from the level
    ];
    const t = portfolioTotals(metrics);
    expect(t.propertyCount).toBe(1);
    expect(t.portfolioNoi).toBe(120);
    expect(t.oxfordNoi).toBe(120);
  });

  it('excludes a property with only YTD data from the count and totals', () => {
    const metrics: PeriodMetrics[] = [
      pm('a', '2024', 'year', { noi: 120, oxfordNoi: 120 }),
      pm('b', '2026', 'ytd', { noi: 50, oxfordNoi: 50 }), // no full year → not in the band
    ];
    const t = portfolioTotals(metrics);
    expect(t.propertyCount).toBe(1);
    expect(t.portfolioNoi).toBe(120);
  });

  it('is empty-safe', () => {
    expect(portfolioTotals([])).toEqual({ propertyCount: 0, portfolioNoi: 0, oxfordNoi: 0 });
  });
});

describe('attentionCounts', () => {
  it('counts orange+red as needing attention and disposition candidates separately', () => {
    const scores: PropertyScore[] = [
      score('a', 'green', 'hold'),
      score('b', 'orange', 'monitor'),
      score('c', 'red', 'disposition-candidate'),
      score('d', 'yellow', 'invest'),
    ];
    const c = attentionCounts(scores);
    expect(c.needingAttention).toBe(2); // orange + red
    expect(c.dispositionCandidates).toBe(1);
  });

  it('is empty-safe', () => {
    expect(attentionCounts([])).toEqual({ needingAttention: 0, dispositionCandidates: 0 });
  });
});
