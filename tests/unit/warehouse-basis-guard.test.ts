import { describe, expect, it } from 'vitest';
import { benchmarkMetric } from '../../server/warehouse/benchmarks';
import type { PeriodMetrics } from '../../server/warehouse/metrics';

// Synthetic PeriodMetrics — only the fields benchmarkMetric reads matter (cast convention).
const m = (propertyId: string, basis: string, noiPerSf: number) =>
  ({ propertyId, period: '2025', basis, noiPerSf } as unknown as PeriodMetrics);

describe('benchmark cross-basis discipline (integrity risk #2 — never silently compare bases)', () => {
  it('flags a cohort that mixes accounting bases (cash vs accrual)', () => {
    const metrics = [m('a', 'cash', 5), m('b', 'accrual', 6)];
    const bm = benchmarkMetric(metrics, '2025', 'noiPerSf');
    expect(bm.mixedBasis).toBe(true);
    expect(bm.bases).toEqual(['accrual', 'cash']); // distinct, sorted
  });

  it('does not flag a single-basis cohort', () => {
    const metrics = [m('a', 'cash', 5), m('b', 'cash', 6)];
    const bm = benchmarkMetric(metrics, '2025', 'noiPerSf');
    expect(bm.mixedBasis).toBe(false);
    expect(bm.bases).toEqual(['cash']);
  });

  it('treats unknown basis as its own basis — cash+unknown is still mixed (conservative)', () => {
    const metrics = [m('a', 'cash', 5), m('b', 'unknown', 6)];
    const bm = benchmarkMetric(metrics, '2025', 'noiPerSf');
    expect(bm.mixedBasis).toBe(true);
    expect(bm.bases).toEqual(['cash', 'unknown']);
  });

  it('only counts bases of properties that contribute a finite value to the cohort', () => {
    // The accrual property has a null metric → it does not enter the cohort, so no mix.
    const metrics = [m('a', 'cash', 5), { propertyId: 'b', period: '2025', basis: 'accrual', noiPerSf: null } as unknown as PeriodMetrics];
    const bm = benchmarkMetric(metrics, '2025', 'noiPerSf');
    expect(bm.mixedBasis).toBe(false);
    expect(bm.bases).toEqual(['cash']);
  });
});
