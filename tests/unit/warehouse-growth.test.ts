import { describe, expect, it } from 'vitest';
import { cagr, growthSeries, sinceAcquisition } from '../../server/warehouse/growth';
import type { PeriodMetrics } from '../../server/warehouse/metrics';

const M = (period: string, revenue: number, noi: number, noiPerSf: number | null) =>
  ({ propertyId: 'p', period, revenue, noi, noiPerSf } as unknown as PeriodMetrics);
const series = [M('2024', 100, 50, 5), M('2025', 110, 60, 6), M('2026', 99, 54, 5.4)];

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
});
