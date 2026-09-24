import { describe, expect, it } from 'vitest';
import { portfolioKpis } from '../../src/analytics/engine';
import type { PortfolioSnapshot, Property } from '../../src/contracts/index';

const p = (o: Partial<Property>) => ({ id: 'x', name: 'x', sf: 0, occPct: 1, noi: 0, oxfordValue: 0, loanBalance: 0, equityInvested: 0, tenantCount: 0, type: 'Flex', ...o }) as Property;

describe('portfolioKpis — residence excluded from investment metrics', () => {
  const s = {
    properties: [
      p({ id: 'a', sf: 10000, noi: 680_000, oxfordValue: 10_000_000, loanBalance: 2_000_000, tenantCount: 3 }),
      p({ id: 'res', type: 'Residence', sf: 6700, noi: 0, oxfordValue: 2_000_000 }),
    ],
    leases: [], cash: { totalCash: 0, history: [] }, meta: { asOf: '2026-09-23' },
  } as unknown as PortfolioSnapshot;

  it('value, cap rate, LTV and count exclude the residence; other holdings carry it', () => {
    const k = portfolioKpis(s);
    expect(k.value.value).toBe(10_000_000);
    expect(k.weightedCapRate.value).toBeCloseTo(0.068);
    expect(k.ltv.value).toBeCloseTo(0.2);
    expect(k.propertyCount.value).toBe(1);
    expect(k.totalSf.value).toBe(10000);
    expect(k.otherHoldingsValue.value).toBe(2_000_000);
    expect(k.otherHoldingsCount.value).toBe(1);
  });

  it('with no Residence rows, other holdings are 0/0 and investment cells are the full portfolio', () => {
    const inv = { ...s, properties: s.properties.filter((x) => x.type !== 'Residence') } as PortfolioSnapshot;
    const k = portfolioKpis(inv);
    expect(k.value.value).toBe(10_000_000);
    expect(k.propertyCount.value).toBe(1);
    expect(k.otherHoldingsValue.value).toBe(0);
    expect(k.otherHoldingsCount.value).toBe(0);
  });

  it('other-holdings value follows the scenario confidence convention (Base confirmed, shocked scenario derived)', () => {
    // applyScenario scales every property's oxfordValue, the residence included — so under a non-Base
    // scenario the cell is modeled, not a workbook figure, exactly like `value`.
    expect(portfolioKpis(s, 'Base').otherHoldingsValue.prov.confidence).toBe('confirmed');
    expect(portfolioKpis(s, 'Downside').otherHoldingsValue.prov.confidence).toBe('derived');
    expect(portfolioKpis(s, 'Downside').otherHoldingsCount.prov.confidence).toBe('confirmed');
  });
});
