import { describe, expect, it } from 'vitest';
import { overviewTotalDebtSublabel, externalDebtSublabel } from '../../src/modules/debt/debt-sublabels';
import type { PortfolioKpis } from '../../src/analytics/index';

const cell = (value: number | null) => ({ value, prov: { source: 't', confidence: 'derived' as const } });
const k = (ltv: number, affiliate: number) => ({ ltv: cell(ltv), affiliateDebt: cell(affiliate) }) as unknown as PortfolioKpis;

describe('overviewTotalDebtSublabel — disclosure, then basis, then metric', () => {
  it('live shape: affiliate clause leads', () => {
    expect(overviewTotalDebtSublabel(k(0.1875677418875123, 1_111_111))).toBe('+$1.11M affiliate notes · property loan balances · 18.8% LTV');
  });
  it('no affiliate notes → basis leads', () => {
    expect(overviewTotalDebtSublabel(k(0.2, 0))).toBe('property loan balances · 20.0% LTV');
  });
});

describe('externalDebtSublabel', () => {
  it('live shape: 4 third-party loans + the 3883 affiliate note', () => {
    expect(externalDebtSublabel({ affiliateDebt: 333_333 }, 4)).toBe('+$333K affiliate notes · loan schedule · 4 third-party borrower loans');
  });
  it('singular, and no clause without affiliates', () => {
    expect(externalDebtSublabel({ affiliateDebt: 0 }, 1)).toBe('loan schedule · 1 third-party borrower loan');
  });
  it('tolerates a legacy/mocked summary with no affiliateDebt field', () => {
    expect(externalDebtSublabel({} as { affiliateDebt: number }, 2)).toBe('loan schedule · 2 third-party borrower loans');
  });
});
