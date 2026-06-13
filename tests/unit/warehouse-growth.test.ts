import { describe, expect, it } from 'vitest';
import { cagr, growthSeries, sinceAcquisition } from '../../server/warehouse/growth';
import type { PeriodMetrics } from '../../server/warehouse/metrics';

const M = (period: string, revenue: number, noi: number, noiPerSf: number | null) =>
  ({ propertyId: 'p', period, revenue, noi, noiPerSf } as unknown as PeriodMetrics);
const series = [M('2024', 100, 50, 5), M('2025', 110, 60, 6), M('2026', 99, 54, 5.4)];

// Grain-aware fixture: full-year 2024/2025 + a partial-year 2026 YTD (≈half a year).
// The YTD level is genuinely lower (partial pull) — it must NOT read as a decline.
const MGrain = (
  period: string,
  grainHint: 'year' | 'ytd',
  revenue: number,
  noi: number,
  noiPerSf: number | null,
) =>
  ({
    propertyId: 'p',
    period,
    grainHint,
    revenue,
    noi,
    noiPerSf,
    revenuePerSf: noiPerSf,
    taxesPerSf: null,
    insurancePerSf: null,
  } as unknown as PeriodMetrics);
const grainSeries = [
  MGrain('2024', 'year', 100, 50, 5),
  MGrain('2025', 'year', 110, 60, 6),
  MGrain('2026', 'ytd', 55, 30, 3), // partial-year — ~half; comparing to 2025 'year' is spurious
];

describe('growth', () => {
  it('period-over-period growth', () => {
    const g = growthSeries(series);
    expect(g[1]!.revenueGrowth).toBeCloseTo(0.10, 6);
    expect(g[1]!.noiGrowth).toBeCloseTo(0.20, 6);
    expect(g[2]!.revenueGrowth).toBeCloseTo(-0.10, 6);   // 110→99
    expect(g[0]!.revenueGrowth).toBeNull();              // no prior
  });
  it('cagr over the span (annual)', () => {
    expect(cagr(100, 121, 2)).toBeCloseTo(0.10, 6);       // 100→121 over 2 yrs = 10%
    expect(cagr(0, 121, 2)).toBeNull();                    // undefined off zero
    expect(cagr(100, -50, 2)).toBeNull();                  // sign flip
  });
  it('since-acquisition anchors on earliest available period', () => {
    const sa = sinceAcquisition(series);
    expect(sa.anchorPeriod).toBe('2024');
    expect(sa.latestPeriod).toBe('2026');
    expect(sa.noiGrowth).toBeCloseTo((54 - 50) / 50, 6);
    expect(sa.noiPerSfGrowth).toBeCloseTo((5.4 - 5) / 5, 6);
  });

  it('only computes growth between same-grain consecutive periods (no YTD vs full-year)', () => {
    const g = growthSeries(grainSeries);
    // 2025 vs 2024 are both 'year' → comparable, computed.
    expect(g[1]!.period).toBe('2025');
    expect(g[1]!.comparable).toBe(true);
    expect(g[1]!.noiGrowth).toBeCloseTo(0.20, 6); // 50→60
    expect(g[1]!.revenueGrowth).toBeCloseTo(0.10, 6);
    // 2026 'ytd' vs 2025 'year' → incomparable: growth null, flagged (NOT a −50% decline).
    expect(g[2]!.period).toBe('2026');
    expect(g[2]!.comparable).toBe(false);
    expect(g[2]!.noiGrowth).toBeNull();
    expect(g[2]!.revenueGrowth).toBeNull();
    expect(g[2]!.expenseGrowth).toBeNull();
    expect(g[2]!.noiPerSfGrowth).toBeNull();
  });

  it('since-acquisition prefers the latest FULL-YEAR period when the true latest is YTD', () => {
    const sa = sinceAcquisition(grainSeries);
    expect(sa.anchorPeriod).toBe('2024');
    // latest comparable full-year is 2025 — NOT the 2026 YTD partial.
    expect(sa.latestPeriod).toBe('2025');
    expect(sa.comparable).toBe(true);
    expect(sa.noiGrowth).toBeCloseTo((60 - 50) / 50, 6); // anchor 2024 → 2025, both 'year'
  });

  it('since-acquisition reports YTD but marks incomparable when only a YTD period exists', () => {
    const ytdOnly = [MGrain('2026', 'ytd', 55, 30, 3)];
    const sa = sinceAcquisition(ytdOnly);
    expect(sa.anchorPeriod).toBe('2026');
    expect(sa.latestPeriod).toBe('2026');
    expect(sa.comparable).toBe(false);
  });
});
