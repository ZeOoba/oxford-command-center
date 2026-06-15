import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { respond } from '../../server/ai/respond';

/**
 * The deterministic, data-grounded responder used by the AI agent when no ANTHROPIC_API_KEY
 * is configured (server/ai/agent.ts → respond). These tests lock its intent routing and assert
 * it reports figures from the live snapshot rather than canned text.
 */
function makeSnap(): PortfolioSnapshot {
  const snap = {
    meta: { schemaVersion: '1.0.0', asOf: '2026-06-01', generatedAt: '2026-06-01T00:00:00.000Z', source: 't', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: '2026-06-01' },
    properties: [
      { id: 'p1', index: 1, name: '29000 Information Lane, Easton MD', address: '29000 Information Lane', city: null, state: null, market: 'Mid-Atlantic', type: 'Flex', sf: 48000, tenantCount: 1, occPct: 1, acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 7310000, grossIncome: 0, expenses: 0, noi: 511000, noiScenarioAdj: 511000, debtService: 0, netCashFlow: 0, capRate: 0.07, dscr: 2.45, lender: 'REDACTED-672', loanBalance: 2770000, ltv: 0.38, valuePerSf: null, rentPerSf: null, equityInvested: 1000000, cashOnCash: null, holdYrs: null, encumbered: true, flags: [] },
    ],
    leases: [
      { id: 'lease1', propertyKey: '29000', propertyId: 'p1', tenantName: 'REDACTED-659', unit: 'A', company: 'REDACTED-659, INC.', sf: 1000, monthlyRent: 8333.33, rentPerSf: null, leaseStart: null, leaseEnd: '2028-01-01', escalationDate: null, escalationPct: null, status: 'Active', annualRent: 100000, monthsToExpiry: 18, flags: [] },
    ],
    loans: [
      { id: 'l1', name: 'REDACTED-306', counterparty: 'Oxford Capital', direction: 'lender', originalPrincipal: null, currentBalance: -REDACTED-AMT, absBalance: REDACTED-AMT, rate: 0.09, monthlyPmt: -6268, annualInterest: null, annualPrincipal: null, loanType: 'Balloon', status: 'Balloon', isDemand: false, maturity: '2027-02-20', monthsToMaturity: 8, ltv: 0.785, lender: null, balloon: true, flags: [] },
    ],
    cash: { asOf: '2026-06-01', totalCash: REDACTED-AMT, activeEntities: 1, largestEntity: 'FVC', concentrationTopPct: 0.545, cagr: null, entities: [{ entity: 'FVC', id: 'fvc', currentBalance: 4000000, priorBalance: null, deltaDollar: null, deltaPct: null, avg3: null, minAllTime: null, maxAllTime: null, bal12moAgo: null, growth12Dollar: null, growth12Pct: null, pctOfPortfolio: 0.51, trend: 'up', flags: [] }], history: [] },
    insurance: [],
    deals: [],
    tasks: [],
    counterparties: [],
    renewalStages: {},
    tenantNotes: {},
    dealComps: {},
    noiBudgets: {},
    quickbooks: null,
    dataQuality: [],
  };
  return snap as unknown as PortfolioSnapshot;
}

describe('respond — deterministic AI fallback', () => {
  it('always reports the stub model', () => {
    expect(respond('anything', makeSnap()).model).toBe('stub');
  });

  it('prompts for a topic on an empty question with no sources', () => {
    const r = respond('   ', makeSnap());
    expect(r.sources).toEqual([]);
    expect(r.answer.toLowerCase()).toContain('ask me about the portfolio');
  });

  it('routes risk questions to the insights engine', () => {
    const r = respond('what is at risk right now?', makeSnap());
    expect(r.sources).toContain('Insights engine');
    expect(r.answer).toContain('active alerts');
  });

  it('routes balloon/refinance questions to the loan index and names the balloon', () => {
    const r = respond('any balloon maturities coming up?', makeSnap());
    expect(r.sources).toContain('Loan Index');
    expect(r.answer).toContain('REDACTED-306');
  });

  it('routes lease questions to the rent roll and reports WALT', () => {
    const r = respond('when do leases expire — what is the WALT?', makeSnap());
    expect(r.sources).toContain('Master Tenant Rent Roll');
    expect(r.answer).toContain('WALT');
  });

  it('routes tenant concentration questions and reports HHI', () => {
    const r = respond('tenant concentration / hhi?', makeSnap());
    expect(r.sources).toContain('Master Tenant Rent Roll');
    expect(r.answer).toContain('HHI');
  });

  it('routes cash questions to cash balances', () => {
    const r = respond('how much liquidity do we have?', makeSnap());
    expect(r.sources).toContain('Cash Balances');
    expect(r.answer).toContain('cash');
  });

  it('routes debt/LTV questions to the loan index', () => {
    const r = respond('what is portfolio leverage and LTV?', makeSnap());
    expect(r.sources).toContain('Loan Index');
    expect(r.answer).toContain('LTV');
  });

  it('falls back to a grounded portfolio summary for unmatched questions', () => {
    const r = respond('give me the lay of the land', makeSnap());
    expect(r.sources).toContain('Property NOI');
    expect(r.answer).toContain('Portfolio snapshot');
    expect(r.answer).toContain('2026-06-01');
  });
});
