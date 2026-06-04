import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { extendedInsights } from '../../server/brief/alerts';

function snap(over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  const base = {
    meta: { schemaVersion: '1.0.0', asOf: '2026-06-04', generatedAt: '2026-06-04T00:00:00.000Z', source: 't', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: '2026-06-04' },
    properties: [], leases: [], loans: [], deals: [], insurance: [], tasks: [], counterparties: [], dataQuality: [],
    cash: { asOf: '2026-06-04', totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
  };
  return { ...base, ...over } as unknown as PortfolioSnapshot;
}
const prop = (o: Record<string, unknown>) => ({ id: 'p1', index: 1, name: 'Prop One', address: null, city: null, state: null, market: 'Columbus OH', type: 'Flex', sf: 1000, tenantCount: 1, occPct: 1, acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 0, grossIncome: 0, expenses: 0, noi: 0, noiScenarioAdj: 0, debtService: 0, netCashFlow: 0, capRate: 0, dscr: 2, lender: null, loanBalance: 0, ltv: 0, valuePerSf: null, rentPerSf: null, equityInvested: 0, cashOnCash: null, holdYrs: null, encumbered: false, flags: [], ...o });
const dealOf = (o: Record<string, unknown>) => ({ id: 'd1', name: 'Deal', shortName: null, location: null, market: null, sf: null, buildings: null, stage: 'LOI/PSA', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null, lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null, confidential: false, estimatedFields: [], ...o });

describe('extendedInsights', () => {
  it('flags a property with DSCR below 1.25 (warning, category debt)', () => {
    const out = extendedInsights(snap({ properties: [prop({ id: 'p1', dscr: 1.1 })] as never }), {});
    const hit = out.find((i) => i.id === 'dscr-p1');
    expect(hit?.severity).toBe('warning');
    expect(hit?.category).toBe('debt');
  });

  it('does not flag DSCR when >= 1.25 or null', () => {
    const out = extendedInsights(snap({ properties: [prop({ id: 'p1', dscr: 1.25 }), prop({ id: 'p2', dscr: null })] as never }), {});
    expect(out.some((i) => i.id.startsWith('dscr-'))).toBe(false);
  });

  it('fires an LOI/PSA-deadline warning within 14 days for an LOI/PSA-stage deal', () => {
    const out = extendedInsights(snap({ deals: [dealOf({ id: 'd1', stage: 'LOI/PSA', targetCloseDate: '2026-06-10' })] as never }), {});
    expect(out.find((i) => i.id === 'loi-d1')?.severity).toBe('warning');
  });

  it('ignores LOI/PSA deadline beyond 14 days or with no date', () => {
    const out = extendedInsights(snap({ deals: [dealOf({ id: 'd1', targetCloseDate: '2026-09-01' }), dealOf({ id: 'd2', targetCloseDate: null })] as never }), {});
    expect(out.some((i) => i.id.startsWith('loi-'))).toBe(false);
  });

  it('reports deal-stage movement vs prior stages (info, category deal)', () => {
    const out = extendedInsights(snap({ deals: [dealOf({ id: 'd1', stage: 'Closing' })] as never }), { d1: 'Due Diligence' });
    const hit = out.find((i) => i.id === 'move-d1');
    expect(hit?.severity).toBe('info');
    expect(hit?.category).toBe('deal');
    expect(hit?.detail).toContain('Due Diligence');
    expect(hit?.detail).toContain('Closing');
  });

  it('suppresses movement on the first run (empty prior stages = baseline)', () => {
    const out = extendedInsights(snap({ deals: [dealOf({ id: 'd1', stage: 'Closing' })] as never }), {});
    expect(out.some((i) => i.id.startsWith('move-'))).toBe(false);
  });
});
