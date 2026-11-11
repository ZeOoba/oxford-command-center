import { describe, expect, it } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { runTool } from '../../server/ai/tools';
import { respond } from '../../server/ai/respond';

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
      prop({ id: 'rarig', name: '1100 Rarig Ave, Columbus OH', lender: 'Oxford Capital', loanBalance: REDACTED-AMT, ltv: 0.4614, oxfordValue: 2_374_719 }),
      prop({ id: 'easton', name: '29000 Information Lane, Easton MD', lender: 'Firm 03', loanBalance: REDACTED-AMT, ltv: 0.3896, oxfordValue: 7_086_263 }),
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

const basisFlag = { entity: 'debt', field: 'debt.basis.property.easton', issue: '29000 Information Lane, Easton MD: … gap $39,388', severity: 'warn' };
const loans = [
  { id: 'b-easton', name: '29000 Information Lane', counterparty: 'Firm 03', direction: 'borrower', absBalance: REDACTED-AMT, currentBalance: -REDACTED-AMT, rate: 0.045, monthlyPmt: 17_362, lender: 'Firm 03', maturity: '2031-01-01', balloon: false, isDemand: false, collateralProperty: '29000 Information Lane, Easton MD' },
  { id: 'b-3883', name: '3883 from Oxford (50%)', counterparty: 'Lender 05 / Oxford Capital — Oxford 50% share', direction: 'borrower', absBalance: REDACTED-AMT, currentBalance: -REDACTED-AMT, rate: 0.06, monthlyPmt: 3_991, lender: 'Lender 05 / Oxford Capital — Oxford 50% share', maturity: '2035-06-01', balloon: false, isDemand: false, collateralProperty: '3875-3883 E Livingston Ave, Columbus OH' },
];

describe('AI tools — each debt figure carries its basis; the gap is surfaced (item 13)', () => {
  it('get_portfolio_summary states the Total Debt basis, the excluded affiliate notes and any basis flags', () => {
    const d = runTool('get_portfolio_summary', aiSnap({ dataQuality: [basisFlag] }), {}).data as Record<string, unknown>;
    expect(d.totalDebtBasis).toBe('Σ investment-property loan balances (Property NOI sheet); Oxford-affiliate notes excluded');
    expect(d.affiliateNotesExcluded).toBe('$1.10M');
    expect(d.debtBasisFlags).toEqual([basisFlag.issue]);
  });
  it('get_loans states the External Debt basis and the excluded affiliate note', () => {
    const d = runTool('get_loans', aiSnap({ loans }), {}).data as Record<string, unknown>;
    expect(d.externalDebt).toBe('$2.76M');
    expect(d.externalDebtBasis).toBe('Σ third-party borrower loans (loan schedule); Oxford-affiliate notes excluded');
    expect(d.affiliateNotesExcluded).toBe('$385K');
    expect(d).not.toHaveProperty('debtBasisFlags'); // none on this snapshot
  });
});

describe('respond (deterministic) — never two debt bases in one sentence (item 13)', () => {
  it('the debt answer puts External Debt and LTV in separate sentences, each with its basis, plus the basis note', () => {
    const r = respond('what is our debt and ltv?', aiSnap({ loans, dataQuality: [basisFlag] }));
    const lines = r.answer.split('\n');
    const ext = lines.find((l) => l.startsWith('External debt'))!;
    const ltv = lines.find((l) => l.startsWith('Portfolio LTV'))!;
    expect(ext).toContain('(loan schedule, third-party borrower loans)');
    expect(ext).toContain('Oxford-affiliate notes of $385K are excluded');
    expect(ext).not.toContain('LTV');
    expect(ltv).toContain('property loan balances');
    expect(ltv).not.toContain('External');
    expect(lines).toContain('Basis note: the loan schedule and the property loan balances disagree on 1 row — see System Health › Reconciliation.');
  });
  it('an aggregate flag (the live affiliate gap) is reported as an aggregate total, not a row', () => {
    // Live data (2026-09-26): checkDebtBasis emits only `debt.basis.affiliate` — property rows $REDACTED-AMT vs
    // loan schedule $REDACTED-AMT. That is a ratified, real difference (Rarig's note is real), not a row mismatch.
    const affiliateFlag = { entity: 'debt', field: 'debt.basis.affiliate', issue: 'Affiliate notes: Property NOI sheet $REDACTED-AMT vs loan schedule $REDACTED-AMT — gap $REDACTED-AMT', severity: 'warn' };
    const r = respond('debt?', aiSnap({ loans, dataQuality: [affiliateFlag] }));
    expect(r.answer.split('\n')).toContain('Basis note: the loan schedule and the property loan balances disagree on 1 aggregate total — see System Health › Reconciliation.');
    const both = respond('debt?', aiSnap({ loans, dataQuality: [basisFlag, affiliateFlag] }));
    expect(both.answer).toContain('disagree on 1 row and 1 aggregate total');
    const summary = respond('lay of the land', aiSnap({ loans, dataQuality: [affiliateFlag] }));
    expect(summary.answer).toContain('• Debt $2.76M (property loan balances; LTV');
    expect(summary.answer).toContain('• Basis note: the loan schedule and the property loan balances disagree on 1 aggregate total');
  });
  it('no basis note when there is no debt-basis flag', () => {
    expect(respond('debt?', aiSnap({ loans })).answer).not.toContain('Basis note');
  });
});
