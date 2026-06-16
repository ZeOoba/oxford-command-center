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

  it('driver order is deterministic when two categories have equal |delta| — not dependent on key insertion order', () => {
    // Bug: sort((x,y) => |y.delta| - |x.delta|) has no tie-break. Equal-|delta| categories reorder
    // with the JS Set iteration order built from Object.keys(a) ++ Object.keys(b), which is not stable
    // across re-ingests. Fix: add || x.category.localeCompare(y.category) as a secondary key.
    // Insurance delta = +5000, Utilities delta = -5000 (equal magnitude).
    const aFwd = { 'Rental Revenue': 100000, Insurance: -8000, Utilities: -8000 };
    const bFwd = { 'Rental Revenue': 105000, Insurance: -3000, Utilities: -13000 };
    const d1 = decomposeNoiChange(aFwd, bFwd);

    // Same data but keys listed in reverse order — must produce identical driver ordering.
    const aRev = { Utilities: -8000, Insurance: -8000, 'Rental Revenue': 100000 };
    const bRev = { Utilities: -13000, Insurance: -3000, 'Rental Revenue': 105000 };
    const d2 = decomposeNoiChange(aRev, bRev);

    expect(d1.drivers.map((d) => d.category)).toEqual(d2.drivers.map((d) => d.category));
  });

  it('contributionPct is null when offsetting deltas net to a tiny totalDelta — low-signal, not ±500,000%', () => {
    // Bug: meaningful = |totalDelta| > 0.005 (absolute guard only). Revenue up $50k, costs up $49,990
    // → totalDelta = $10 > 0.005 → meaningful=true → contributionPct = 50000/10 = 5000 (+500,000%).
    // Fix: also require |totalDelta| / sum(|delta|) > 0.05 (relative floor); a 0.01% signal
    // within the gross movement is noise, not attribution.
    const a = { 'Rental Revenue': 100000, 'Repairs & Maintenance': -50000 };
    const b = { 'Rental Revenue': 150000, 'Repairs & Maintenance': -99990 };
    // totalDelta = (150000-99990) - (100000-50000) = 50010 - 50000 = 10
    const d = decomposeNoiChange(a, b);
    expect(Math.abs(d.totalDelta)).toBeCloseTo(10, 1);
    // Pre-fix: contributions are +5000 and -4999 (±500,000%). Post-fix: null.
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
