import { describe, expect, it } from 'vitest';
import { applyScenario, debtSummary, portfolioKpis } from '../../src/analytics/engine';
import type { Loan, PortfolioSnapshot, Property } from '../../src/contracts/index';

const p = (o: Partial<Property>) =>
  ({ id: 'x', name: 'x', sf: 0, occPct: 1, noi: 0, oxfordValue: 0, loanBalance: 0, equityInvested: 0, tenantCount: 0, type: 'Flex', lender: null, ...o }) as Property;
const loan = (o: Partial<Loan>) =>
  ({ id: 'n', name: 'n', counterparty: null, direction: 'borrower', absBalance: 0, currentBalance: 0, rate: null, monthlyPmt: null, maturity: null, balloon: false, lender: null, ...o }) as Loan;

describe('portfolioKpis — affiliate notes excluded from Total Debt and aggregate LTV (ratified 2026-09-24)', () => {
  const s = {
    properties: [
      p({ id: 'bank', oxfordValue: 10_000_000, loanBalance: 2_000_000, lender: 'REDACTED-672' }),
      p({ id: 'rarig', oxfordValue: 2_000_000, loanBalance: 1_000_000, lender: 'Oxford Capital' }),
    ],
    leases: [], cash: { totalCash: 0, history: [] }, meta: { asOf: '2026-09-24' },
  } as unknown as PortfolioSnapshot;

  it('totalDebt and ltv are third-party only; affiliateDebt carries the note; value is untouched', () => {
    const k = portfolioKpis(s);
    expect(k.totalDebt.value).toBe(2_000_000);
    expect(k.affiliateDebt.value).toBe(1_000_000);
    expect(k.ltv.value).toBeCloseTo(2_000_000 / 12_000_000, 12);
    expect(k.value.value).toBe(12_000_000);
  });

  it('no affiliate rows → affiliateDebt 0 and totalDebt = Σ loanBalance', () => {
    const k = portfolioKpis({ ...s, properties: [s.properties[0]!] } as PortfolioSnapshot);
    expect(k.totalDebt.value).toBe(2_000_000);
    expect(k.affiliateDebt.value).toBe(0);
  });

  it('the exclusion holds under a scenario (debt is never scenario-shocked)', () => {
    const k = portfolioKpis(applyScenario(s, 'Downside'), 'Downside');
    expect(k.totalDebt.value).toBe(2_000_000);
    expect(k.affiliateDebt.value).toBe(1_000_000);
  });
});

describe('debtSummary — External Debt is third-party only; affiliate notes carried separately', () => {
  const affName = 'REDACTED-676';
  const loans = [
    loan({ id: 'bank', absBalance: 2_000_000, rate: 0.05, monthlyPmt: 10_000, lender: 'REDACTED-672', counterparty: 'REDACTED-672', maturity: '2030-01-01' }),
    loan({ id: 'aff', absBalance: 400_000, rate: 0.06, monthlyPmt: 4_000, lender: affName, counterparty: affName, maturity: '2035-06-01' }),
    loan({ id: 'rcv', direction: 'lender', absBalance: 500_000, counterparty: 'REDACTED-013', maturity: '2027-02-20', balloon: true }),
    loan({ id: 'int', direction: 'internal', absBalance: 300_000, counterparty: 'REDACTED-493' }),
  ];

  it('externalDebt / annualDebtService / weightedAvgRate exclude the affiliate borrower loan', () => {
    const d = debtSummary(loans);
    expect(d.externalDebt).toBe(2_000_000);
    expect(d.annualDebtService).toBe(120_000);
    expect(d.weightedAvgRate).toBeCloseTo(0.05, 12);
    expect(d.affiliateDebt).toBe(400_000);
    expect(d.affiliateCount).toBe(1);
  });

  it('lender-direction notes naming Oxford Capital stay Capital Deployed; internal unchanged', () => {
    const d = debtSummary(loans);
    expect(d.lenderDeployed).toBe(500_000);
    expect(d.internalOutstanding).toBe(300_000);
  });

  it('the maturity ladder is a position view and keeps the affiliate note (2035 bucket); internal loans were never laddered', () => {
    // The ladder iterates borrowers + lenders only (engine.ts), so the internal row never reaches a bucket.
    expect(debtSummary(loans).ladder.map((b) => [b.period, b.balance])).toEqual([
      ['2027', 500_000],
      ['2030', 2_000_000],
      ['2035', 400_000],
    ]);
  });
});
