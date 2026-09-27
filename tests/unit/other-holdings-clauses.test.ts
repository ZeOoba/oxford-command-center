// Refute wf_fc63f5bf-8e7 (low): the other-holdings equity/debt clauses must be sign-symmetric —
// mirror affiliateNotesClause: '' unless finite and non-zero; '+' only when positive.
import { describe, expect, it } from 'vitest';
import { otherHoldingsEquityClause, otherHoldingsDebtClause } from '../../src/modules/overview/other-holdings';
import type { PortfolioKpis } from '../../src/analytics/index';

const cell = (value: number | null) => ({ value, prov: { source: 't', confidence: 'confirmed' as const } });
const k = (v: number | null, count = 1) =>
  ({ otherHoldingsCount: cell(count), otherHoldingsEquity: cell(v), otherHoldingsDebt: cell(v) }) as unknown as PortfolioKpis;

describe('otherHoldingsEquityClause / otherHoldingsDebtClause — sign-symmetric', () => {
  it('positive: leading plus', () => {
    expect(otherHoldingsEquityClause(k(900_000))).toBe('+$900K other holdings');
    expect(otherHoldingsDebtClause(k(400_000))).toBe('+$400K other-holdings debt');
  });
  it("negative: no '+', the formatter's minus stands", () => {
    expect(otherHoldingsEquityClause(k(-50_000))).toBe('-$50K other holdings');
    expect(otherHoldingsDebtClause(k(-50_000))).toBe('-$50K other-holdings debt');
  });
  it('zero, null, non-finite, or no residence row → empty', () => {
    for (const v of [0, null, Infinity, NaN]) {
      expect(otherHoldingsEquityClause(k(v))).toBe('');
      expect(otherHoldingsDebtClause(k(v))).toBe('');
    }
    expect(otherHoldingsEquityClause(k(900_000, 0))).toBe('');
    expect(otherHoldingsDebtClause(k(400_000, 0))).toBe('');
  });
});
