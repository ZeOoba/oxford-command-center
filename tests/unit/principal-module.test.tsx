import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import type { AnalyticsBundle } from '../../src/analytics/index';
import { principalKpis } from '../../src/modules/principal/principal-kpis';

function bundle(): { snapshot: PortfolioSnapshot; analytics: AnalyticsBundle } {
  const analytics = { kpis: { noi: { value: REDACTED-AMT, prov: 'derived' }, value: { value: REDACTED-AMT, prov: 'derived' }, occupancy: { value: 0.94, prov: 'derived' }, totalCash: { value: REDACTED-AMT, prov: 'confirmed' }, propertyCount: { value: 14, prov: 'confirmed' }, otherHoldingsCount: { value: 0, prov: 'confirmed' }, otherHoldingsValue: { value: 0, prov: 'confirmed' } }, insights: [] } as unknown as AnalyticsBundle;
  const snapshot = { cash: { totalCash: REDACTED-AMT } } as unknown as PortfolioSnapshot;
  return { snapshot, analytics };
}

// KpiStat renders format(value), so a KPI must carry a non-null value + a formatter (a null value
// short-circuits KpiStat to "—"). We assert the formatted output the card will actually show.
describe('principalKpis', () => {
  it('carries value+format that produce the headline figures', () => {
    const { analytics } = bundle();
    const k = principalKpis(analytics);
    const get = (label: string) => { const x = k.find((y) => y.label === label)!; return x.format(x.value); };
    expect(get('NOI')).toMatch(/\$3\.9/);
    expect(get('Occupancy')).toBe('94.0%'); // 0.94 → ×100 → "94.0%"
    expect(get('Cash')).toMatch(/\$7\.8/);
    expect(k.every((x) => x.value !== null)).toBe(true); // none would render "—"
  });
});
