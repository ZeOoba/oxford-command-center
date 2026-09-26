import { describe, expect, it } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { runTool } from '../../server/ai/tools';

const prop = (o: Record<string, unknown>) => ({
  id: 'p', index: 1, name: 'P', address: 'a', city: null, state: null, market: 'Columbus OH', type: 'Flex', sf: 1000,
  tenantCount: 1, occPct: 1, acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 2_000_000, grossIncome: 0,
  expenses: 0, noi: 100_000, noiScenarioAdj: 100_000, debtService: 0, netCashFlow: 0, capRate: 0.05, dscr: null,
  lender: null, loanBalance: 0, ltv: null, valuePerSf: null, rentPerSf: null, equityInvested: 0, cashOnCash: null,
  holdYrs: null, encumbered: false, flags: [], ...o,
});

function aiSnap(over: Record<string, unknown> = {}): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: '2026-09-13', generatedAt: '2026-09-14T00:00:00.000Z', source: 't', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: '2026-09-13' },
    properties: [
      prop({ id: 'rarig', name: '1100 Rarig Ave, Columbus OH', lender: 'Oxford Capital', loanBalance: 1_095_582, ltv: 0.4614, oxfordValue: 2_374_719 }),
      prop({ id: 'easton', name: '29000 Information Lane, Easton MD', lender: 'Symetra', loanBalance: 2_760_611.91, ltv: 0.3896, oxfordValue: 7_086_263 }),
    ],
    leases: [], loans: [], deals: [], insurance: [], tasks: [], counterparties: [],
    renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, quickbooks: null, dataQuality: [],
    cash: { asOf: '2026-09-13', totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
    ...over,
  } as unknown as PortfolioSnapshot;
}

describe('get_property — per-property LTV on the investment basis', () => {
  it('an affiliate-note property reports "affiliate note", not 46.1%', () => {
    const rows = runTool('get_property', aiSnap(), { query: 'rarig' }).data as Array<{ ltv: string; affiliateNote: boolean }>;
    expect(rows[0]).toMatchObject({ ltv: 'affiliate note', affiliateNote: true });
  });
  it('a third-party-debt property reports its LTV', () => {
    const rows = runTool('get_property', aiSnap(), { query: 'easton' }).data as Array<{ ltv: string; affiliateNote: boolean }>;
    expect(rows[0]).toMatchObject({ ltv: '39.0%', affiliateNote: false });
  });
});
