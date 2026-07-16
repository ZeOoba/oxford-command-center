import { describe, it, expect } from 'vitest';
import type { AnalyticsBundle } from '../../src/analytics/index';
import { principalKpis } from '../../src/modules/principal/principal-kpis';

// The ANALYTICS CONTRACT puts confidence + provenance on every analytic. The Cash card was the one
// Principal-home KPI reading the raw snapshot number and dropping the provenance the analytics
// bundle already computed (engine.ts builds kpis.totalCash as a 'confirmed' cell from the very same
// source, so the displayed number is provably unchanged — the second test pins that).
function fixture(): AnalyticsBundle {
  return {
    kpis: {
      noi: { value: 3_913_428, prov: 'derived' },
      value: { value: 59_597_565, prov: 'derived' },
      occupancy: { value: 0.94, prov: 'derived' },
      totalCash: { value: 7_829_033, prov: 'confirmed' },
    },
    insights: [],
  } as unknown as AnalyticsBundle;
}

describe('principal Cash KPI provenance (finding principal-cash-kpi-drops-provenance)', () => {
  it('carries the provenance the analytics bundle already computed', () => {
    const analytics = fixture();
    const cash = principalKpis(analytics).find((x) => x.label === 'Cash')!;
    expect(cash.prov).toBe(analytics.kpis.totalCash.prov);
  });

  it('displays the same number as before — only the provenance affordance changes', () => {
    const analytics = fixture();
    const cash = principalKpis(analytics).find((x) => x.label === 'Cash')!;
    expect(cash.value).toBe(7_829_033); // === kpis.totalCash.value, the cell built from snapshot.cash.totalCash
    expect(cash.format(cash.value)).toMatch(/\$7\.8/);
  });
});
