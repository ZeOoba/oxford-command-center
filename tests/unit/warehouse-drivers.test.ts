import { describe, expect, it } from 'vitest';
import { decomposeNoiChange, noiImpactByCategory } from '../../server/warehouse/drivers';
import type { PeriodMetrics } from '../../server/warehouse/metrics';

// noiImpactByCategory: revenue cats positive, opex cats negative
const A = { 'Rental Revenue': 100000, Insurance: -10000, Taxes: -20000 };
const B = { 'Rental Revenue': 105000, Insurance: -12200, Taxes: -20000 };

describe('drivers', () => {
  it('decomposes ΔNOI and contributions sum to 100%', () => {
    const d = decomposeNoiChange(A, B);
    expect(d.totalDelta).toBeCloseTo(2800, 6); // (105000-12200-20000) - (100000-10000-20000) = 72800-70000
    const ins = d.drivers.find((x) => x.category === 'Insurance')!;
    expect(ins.delta).toBeCloseTo(-2200, 6);
    expect(ins.contributionPct).toBeCloseTo(-2200 / 2800, 6);
    const rev = d.drivers.find((x) => x.category === 'Rental Revenue')!;
    expect(rev.delta).toBeCloseTo(5000, 6);
    expect(d.drivers.reduce((s, x) => s + x.delta, 0)).toBeCloseTo(d.totalDelta, 6);
    expect(d.drivers[0]!.category).toBe('Rental Revenue'); // ranked by |delta|
  });

  it('drivers deltas sum EXACTLY to totalDelta (invariant)', () => {
    const a = { 'Rental Revenue': 88000, Insurance: -7300, Taxes: -19450, 'Repairs & Maintenance': -4120 };
    const b = { 'Rental Revenue': 91250, Insurance: -8010, Utilities: -3300, Taxes: -19450 };
    const d = decomposeNoiChange(a, b);
    const summed = d.drivers.reduce((s, x) => s + x.delta, 0);
    expect(summed).toBe(d.totalDelta); // exact, not just close
  });

  it('null contributions when ΔNOI≈0', () => {
    const d = decomposeNoiChange({ A: 100 }, { A: 100 });
    expect(d.totalDelta).toBeCloseTo(0, 6);
    expect(d.drivers.every((x) => x.contributionPct === null)).toBe(true);
  });

  it('noiImpactByCategory merges revenue (+) and opex (−)', () => {
    const m = {
      revenueCategories: { 'Rental Revenue': 100000, Recoveries: 5000 },
      categories: { Insurance: 10000, Taxes: 20000 },
    } as unknown as PeriodMetrics;
    const impact = noiImpactByCategory(m);
    expect(impact['Rental Revenue']).toBe(100000);
    expect(impact.Recoveries).toBe(5000);
    expect(impact.Insurance).toBe(-10000);
    expect(impact.Taxes).toBe(-20000);
    // NOI from the impact map equals revenue − opex
    const noi = Object.values(impact).reduce((s, v) => s + v, 0);
    expect(noi).toBe(100000 + 5000 - 10000 - 20000);
  });
});
