// tests/unit/intel-ownership-view.test.ts
//
// Pure helpers backing OwnershipView (the view itself is browser-verified, not
// jsdom-rendered). They roll the per-(property,period) metric rows into a portfolio band
// (count, Σ latest-FY NOI, Σ latest-FY Oxford-share NOI) and count the scores that need
// ownership attention (orange+red bands) / are disposition candidates. The synthesis
// transforms (rankByAttention, buildActionList, …) are tested in intel-synthesis.test.ts
// and are NOT retested here. Deterministic, null-safe.
import { describe, expect, it } from 'vitest';
import {
  attentionCounts,
  portfolioTotals,
  portfolioTotalsForPeriod,
  portfolioVerdict,
} from '../../src/modules/intel/ownership-intel';
import type { HealthBand, PeriodMetrics, PropertyScore } from '../../src/modules/intel/analytics-hooks';

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
  basis: 'cash',
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

const score = (
  id: string,
  attentionBand: string,
  capitalAction: string,
  healthBand: HealthBand = 'good',
): PropertyScore =>
  ({
    propertyId: id,
    propertyName: id,
    period: '2025',
    health: 60,
    healthBand,
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

describe('portfolioTotalsForPeriod', () => {
  it('sums only the rows for the chosen period and counts those properties', () => {
    const metrics: PeriodMetrics[] = [
      pm('a', '2023', 'year', { noi: 100, oxfordNoi: 100 }),
      pm('a', '2024', 'year', { noi: 120, oxfordNoi: 120 }),
      pm('b', '2024', 'year', { noi: 200, oxfordNoi: 100 }),
      pm('a', '2026', 'ytd', { noi: 999, oxfordNoi: 999 }),
    ];
    expect(portfolioTotalsForPeriod(metrics, '2024')).toEqual({
      propertyCount: 2,
      portfolioNoi: 320,
      oxfordNoi: 220,
    });
  });

  it('selects a YTD period by its exact period string', () => {
    const metrics: PeriodMetrics[] = [
      pm('a', '2024', 'year', { noi: 120, oxfordNoi: 120 }),
      pm('a', '2026', 'ytd', { noi: 999, oxfordNoi: 999 }),
    ];
    expect(portfolioTotalsForPeriod(metrics, '2026')).toEqual({
      propertyCount: 1,
      portfolioNoi: 999,
      oxfordNoi: 999,
    });
  });

  it('is empty/absent-period safe', () => {
    expect(portfolioTotalsForPeriod([], '2024')).toEqual({ propertyCount: 0, portfolioNoi: 0, oxfordNoi: 0 });
    expect(
      portfolioTotalsForPeriod([pm('a', '2024', 'year', { noi: 1, oxfordNoi: 1 })], '2099'),
    ).toEqual({ propertyCount: 0, portfolioNoi: 0, oxfordNoi: 0 });
  });
});

describe('portfolioVerdict', () => {
  it('states NOI, count, health posture, attention and disposition counts', () => {
    const scores: PropertyScore[] = [
      score('a', 'green', 'hold', 'excellent'),
      score('b', 'green', 'hold', 'good'),
      score('c', 'yellow', 'monitor', 'watch'),
      score('d', 'orange', 'monitor', 'concern'),
      score('e', 'red', 'disposition-candidate', 'concern'),
    ];
    const totals = { propertyCount: 5, portfolioNoi: 59_600_000, oxfordNoi: 50_000_000 };
    expect(portfolioVerdict(scores, totals)).toBe(
      '$59.6M portfolio NOI across 5 properties; 2 healthy, 1 on watch, 2 of concern. 2 need attention, 1 disposition candidate.',
    );
  });

  it('uses singular grammar for a single property / single flag', () => {
    const scores: PropertyScore[] = [score('a', 'red', 'monitor', 'concern')];
    const totals = { propertyCount: 1, portfolioNoi: 1_000_000, oxfordNoi: 1_000_000 };
    expect(portfolioVerdict(scores, totals)).toBe(
      '$1.00M portfolio NOI across 1 property; 0 healthy, 0 on watch, 1 of concern. 1 needs attention.',
    );
  });

  it('reads cleanly when nothing needs attention', () => {
    const scores: PropertyScore[] = [score('a', 'green', 'hold', 'good'), score('b', 'green', 'invest', 'excellent')];
    const totals = { propertyCount: 2, portfolioNoi: 5_000_000, oxfordNoi: 5_000_000 };
    expect(portfolioVerdict(scores, totals)).toBe(
      '$5.00M portfolio NOI across 2 properties; 2 healthy, 0 on watch, 0 of concern. No properties need attention.',
    );
  });

  it('is empty-safe', () => {
    expect(portfolioVerdict([], { propertyCount: 0, portfolioNoi: 0, oxfordNoi: 0 })).toBe('No scored properties yet.');
  });
});
