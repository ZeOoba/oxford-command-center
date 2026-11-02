// Ruling 2026-10-30: an NNN-not-absolute property whose expenses are $0/blank overstates NOI and cap
// rate by the landlord's roof, structure and paving costs. The AI tools must say so, not just the UI.
import { describe, expect, it } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { runTool } from '../../server/ai/tools';
import { LANDLORD_COSTS_NOT_SOURCED_FIELD } from '../../src/analytics/property-basis';

const flag = (entity: string) => ({ entity, field: LANDLORD_COSTS_NOT_SOURCED_FIELD, issue: 'x', severity: 'info' as const });
const prop = (o: Record<string, unknown>) => ({
  id: 'p', index: 1, name: 'P', address: 'a', city: null, state: null, market: 'Columbus OH', type: 'Flex', sf: 1000,
  tenantCount: 1, occPct: 1, acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 2_000_000, grossIncome: 100_000,
  expenses: 0, noi: 100_000, noiScenarioAdj: 100_000, debtService: 0, netCashFlow: 0, capRate: 0.05, dscr: null,
  lender: null, loanBalance: 0, ltv: null, valuePerSf: null, rentPerSf: null, equityInvested: 0, cashOnCash: null,
  holdYrs: null, encumbered: false, flags: [], ...o,
});
const snap = {
  meta: { schemaVersion: '1.0.0', asOf: '2026-10-23', generatedAt: '2026-10-26T00:00:00.000Z', source: 't', scenario: 'Base' },
  assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: '2026-10-23' },
  properties: [
    prop({ id: 'nnn', name: '55 Fixture Ct', flags: [flag('nnn')] }),
    prop({ id: 'full', name: '29000 Fixture Ln', expenses: 50_000, noi: 50_000 }),
  ],
  leases: [], loans: [], deals: [], insurance: [], tasks: [], counterparties: [],
  renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, quickbooks: null, dataQuality: [],
  cash: { asOf: '2026-10-23', totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
} as unknown as PortfolioSnapshot;

describe('AI tools carry the NNN landlord-cost caveat', () => {
  it('get_property adds noiCaveat only on the flagged property', () => {
    const rows = runTool('get_property', snap, { query: 'fixture' }).data as Array<{ name: string; noiCaveat?: string }>;
    expect(rows.find((r) => r.name === '55 Fixture Ct')!.noiCaveat).toMatch(/not sourced/);
    expect(rows.find((r) => r.name === '29000 Fixture Ln')!.noiCaveat).toBeUndefined();
  });
  it('get_portfolio_summary notes how many properties overstate NOI', () => {
    const d = runTool('get_portfolio_summary', snap, {}).data as { note: string };
    expect(d.note).toMatch(/include 1 NNN property whose landlord-paid roof, structure and paving costs are not sourced/);
  });
});
