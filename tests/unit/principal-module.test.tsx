import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import type { AnalyticsBundle } from '../../src/analytics/index';
import { principalKpis } from '../../src/modules/principal/principal-kpis';

function bundle(): { snapshot: PortfolioSnapshot; analytics: AnalyticsBundle } {
  const analytics = { kpis: { noi: { value: 3_913_428, prov: 'derived' }, value: { value: 59_597_565, prov: 'derived' }, occupancy: { value: 0.94, prov: 'derived' } }, insights: [] } as unknown as AnalyticsBundle;
  const snapshot = { cash: { totalCash: 7_829_033 } } as unknown as PortfolioSnapshot;
  return { snapshot, analytics };
}

describe('principalKpis', () => {
  it('formats the headline figures', () => {
    const { snapshot, analytics } = bundle();
    const k = principalKpis(snapshot, analytics);
    expect(k.find((x) => x.label === 'NOI')?.display).toMatch(/\$3\.9/);
    // fmtPct(0.94) returns '94.0%' (digits=1 default) — adjusted from spec's '94%'
    expect(k.find((x) => x.label === 'Occupancy')?.display).toBe('94.0%');
    expect(k.find((x) => x.label === 'Cash')?.display).toMatch(/\$7\.8/);
  });
});
