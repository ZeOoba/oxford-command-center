import { describe, expect, it } from 'vitest';
import { applyScenario, portfolioKpis } from '../../src/analytics/engine';
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

  it('other holdings are never scenario-shocked: Upside/Downside otherHoldingsValue equals Base, tagged confirmed', () => {
    // Refute finding (2026-09-23): a residence has no revenue and no cap-rate exposure, so a revenue /
    // exit-cap shock cannot move its value. applyScenario leaves non-investment rows untouched and the
    // cell stays a workbook figure ('confirmed') in every scenario.
    const base = portfolioKpis(s, 'Base');
    expect(base.otherHoldingsValue.value).toBe(2_000_000);
    expect(base.otherHoldingsValue.prov.confidence).toBe('confirmed');
    for (const sc of ['Upside', 'Downside'] as const) {
      const shocked = applyScenario(s, sc);
      const k = portfolioKpis(shocked, sc);
      expect(k.otherHoldingsValue.value).toBe(2_000_000);
      expect(k.otherHoldingsValue.prov.confidence).toBe('confirmed');
      expect(k.otherHoldingsCount.prov.confidence).toBe('confirmed');
      // The residence row is passed through by reference — no phantom dscr/ltv/value recomputation.
      expect(shocked.properties.find((x) => x.id === 'res')).toBe(s.properties.find((x) => x.id === 'res'));
      // Investment rows ARE still shocked (the fix must not neuter the scenario for real assets).
      expect(k.value.value).not.toBe(base.value.value);
      expect(k.value.prov.confidence).toBe('derived');
    }
  });
});

describe('portfolioKpis — residence equity and debt are other holdings (ratified 2026-09-24)', () => {
  const s = {
    properties: [
      p({ id: 'a', oxfordValue: 10_000_000, equityInvested: 1_000_000, loanBalance: 2_000_000, lender: 'REDACTED-672' }),
      p({ id: 'res', type: 'Residence', oxfordValue: 2_000_000, equityInvested: 900_000, loanBalance: 400_000, lender: 'Wells' }),
    ],
    leases: [], cash: { totalCash: 0, history: [] }, meta: { asOf: '2026-09-24' },
  } as unknown as PortfolioSnapshot;
  it('equityInvested and totalDebt stay investment-only; the residence is carried as other holdings', () => {
    const k = portfolioKpis(s);
    expect(k.equityInvested.value).toBe(1_000_000);
    expect(k.otherHoldingsEquity.value).toBe(900_000);
    expect(k.totalDebt.value).toBe(2_000_000);
    expect(k.otherHoldingsDebt.value).toBe(400_000);
  });
});
