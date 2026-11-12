import { describe, it, expect } from 'vitest';
import type { AnalyticsBundle } from '../../src/analytics/index';
import { principalKpis } from '../../src/modules/principal/principal-kpis';

// The ANALYTICS CONTRACT puts confidence + provenance on every analytic. The Cash card was the one
// Principal-home KPI reading the raw snapshot number and dropping the provenance the analytics
// bundle already computed (engine.ts builds kpis.totalCash as a 'confirmed' cell from the very same
// source, so the displayed number is provably unchanged — the second test pins that).
function fixture(other: { count: number; value: number } = { count: 0, value: 0 }): AnalyticsBundle {
  return {
    kpis: {
      noi: { value: 2_684_150, prov: 'derived' },
      value: { value: 41_872_300, prov: 'derived' },
      occupancy: { value: 0.94, prov: 'derived' },
      totalCash: { value: 5_312_640, prov: 'confirmed' },
      propertyCount: { value: 13, prov: 'confirmed' },
      otherHoldingsCount: { value: other.count, prov: 'confirmed' },
      otherHoldingsValue: { value: other.value, prov: 'confirmed' },
    },
    insights: [],
  } as unknown as AnalyticsBundle;
}

describe('principal Portfolio value KPI reports other holdings (ratified 2026-09-23; refute review finding)', () => {
  it('carries the residence as a sublabel beside the investment-only headline when a residence row exists', () => {
    const pv = principalKpis(fixture({ count: 1, value: 2_000_000 })).find((x) => x.label === 'Portfolio value')!;
    expect(pv.value).toBe(41_872_300); // headline stays investment-only
    // I-1 (2026-09-23 review): now sourced from the shared otherHoldingsClause() helper
    // (other-holdings.ts) so the $ wording matches the Overview/Portfolio tiles exactly — the
    // "(residence)" suffix this used to hardcode is gone; the header title attribute now clarifies
    // the term on hover instead.
    expect(pv.sublabel).toBe('+$2.00M other holdings');
  });

  it('has no sublabel when there are no other holdings', () => {
    const pv = principalKpis(fixture()).find((x) => x.label === 'Portfolio value')!;
    expect(pv.sublabel).toBeUndefined();
    expect(principalKpis(fixture()).every((x) => x.sublabel === undefined)).toBe(true);
  });
});

describe('principal Cash KPI provenance (finding principal-cash-kpi-drops-provenance)', () => {
  it('carries the provenance the analytics bundle already computed', () => {
    const analytics = fixture();
    const cash = principalKpis(analytics).find((x) => x.label === 'Cash')!;
    expect(cash.prov).toBe(analytics.kpis.totalCash.prov);
  });

  it('displays the same number as before — only the provenance affordance changes', () => {
    const analytics = fixture();
    const cash = principalKpis(analytics).find((x) => x.label === 'Cash')!;
    expect(cash.value).toBe(5_312_640); // === kpis.totalCash.value, the cell built from snapshot.cash.totalCash
    expect(cash.format(cash.value)).toMatch(/\$5\.3/);
  });
});
