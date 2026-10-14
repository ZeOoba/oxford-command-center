import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { noiVariance } from '../../src/brain/noi-variance';

const snap = {
  properties: [
    { id: 'a', name: 'Prop A' },
    { id: 'b', name: 'Prop B' },
    { id: 'c', name: 'Prop C' },
  ],
  noiBudgets: { a: 100000, b: 50000 }, // c has no budget
  quickbooks: {
    sourceFile: null, parsedAt: '2026-06-05T00:00:00.000Z',
    properties: [
      { propertyKey: 'Prop A', propertyId: 'a', annualIncome: 130000, annualExpense: 40000, annualNoi: 90000, monthly: [], glExpense: [] },
      { propertyKey: 'Prop B', propertyId: 'b', annualIncome: 70000, annualExpense: 10000, annualNoi: 60000, monthly: [], glExpense: [] },
    ],
  },
} as unknown as PortfolioSnapshot;

describe('noiVariance', () => {
  const v = noiVariance(snap);

  it('computes per-property budget/actual/variance for budgeted+actual rows', () => {
    const a = v.rows.find((r) => r.propertyId === 'a')!;
    expect(a.budget).toBe(100000);
    expect(a.actual).toBe(90000);
    expect(a.variance).toBe(-10000); // under budget
    expect(a.belowBudget).toBe(true);
    const b = v.rows.find((r) => r.propertyId === 'b')!;
    expect(b.variance).toBe(10000); // over budget (favorable)
    expect(b.belowBudget).toBe(false);
  });

  it('includes properties with a budget but no actual (actual null)', () => {
    const c = v.rows.find((r) => r.propertyId === 'c')!;
    expect(c.budget).toBeNull();
    expect(c.actual).toBeNull();
  });

  it('totals portfolio budget/actual/variance and counts below-budget', () => {
    expect(v.totalBudget).toBe(150000);
    expect(v.totalActual).toBe(150000); // 90k + 60k
    expect(v.belowBudgetCount).toBe(1); // only A
  });

  it('computes a portfolio expense ratio from QB actuals', () => {
    // total expense 50k / total income 200k = 0.25
    expect(v.expenseRatio).toBeCloseTo(0.25, 4);
  });

  it('is null-safe when quickbooks is absent', () => {
    const noQb = { properties: [{ id: 'a', name: 'A' }], noiBudgets: { a: 1 }, quickbooks: null } as unknown as PortfolioSnapshot;
    const r = noiVariance(noQb);
    expect(r.totalActual).toBe(0);
    expect(r.rows.find((x) => x.propertyId === 'a')!.actual).toBeNull();
  });

  it('totals exclude budgeted properties with no actual — no phantom shortfall (H5)', () => {
    // Realistic partial-QB-rollout state: 'd' has a budget but QB has not posted its actual yet.
    const partial = {
      properties: [{ id: 'a', name: 'A' }, { id: 'd', name: 'D' }],
      noiBudgets: { a: 100000, d: 200000 }, // d budgeted, no QB actual
      quickbooks: {
        sourceFile: null, parsedAt: '2026-06-05T00:00:00.000Z',
        properties: [
          { propertyKey: 'A', propertyId: 'a', annualIncome: 130000, annualExpense: 40000, annualNoi: 90000, monthly: [], glExpense: [] },
        ],
      },
    } as unknown as PortfolioSnapshot;
    const r = noiVariance(partial);
    // Only the PAIRED property (a) contributes to the totals; d's unmatched 200k budget must NOT
    // manufacture a -200k phantom shortfall.
    expect(r.totalBudget).toBe(100000);
    expect(r.totalActual).toBe(90000);
    expect(r.totalVariance).toBe(-10000); // a's variance alone, not -210000
    // Consistency: portfolio variance equals the sum of per-row (paired) variances.
    const sumRowVar = r.rows.reduce((n, x) => n + (x.variance ?? 0), 0);
    expect(r.totalVariance).toBe(sumRowVar);
    // Coverage counts must tell paired apart from budgeted/actual: 2 budgeted, 1 actual, 1 paired.
    expect(r.pairedCount).toBe(1);
    expect(r.budgetedCount).toBe(2);
    expect(r.actualCount).toBe(1);
  });

  it('reports paired/budgeted/actual coverage counts alongside the (unchanged) totals', () => {
    // fixture: a, b paired; c has neither budget nor actual
    expect(v.pairedCount).toBe(2);
    expect(v.budgetedCount).toBe(2);
    expect(v.actualCount).toBe(2);
    expect(v.rows).toHaveLength(3);
  });

  it('QB actuals with zero budgets yields pairedCount 0 (a 0 variance must not read as on-budget)', () => {
    const noBudgets = {
      properties: [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      noiBudgets: {},
      quickbooks: {
        sourceFile: null, parsedAt: '2026-06-05T00:00:00.000Z',
        properties: [
          { propertyKey: 'A', propertyId: 'a', annualIncome: 130000, annualExpense: 40000, annualNoi: 90000, monthly: [], glExpense: [] },
          { propertyKey: 'B', propertyId: 'b', annualIncome: 70000, annualExpense: 10000, annualNoi: 60000, monthly: [], glExpense: [] },
        ],
      },
    } as unknown as PortfolioSnapshot;
    const r = noiVariance(noBudgets);
    expect(r.pairedCount).toBe(0);
    expect(r.budgetedCount).toBe(0);
    expect(r.actualCount).toBe(2);
    // existing numeric fields keep their values and type
    expect(r.totalVariance).toBe(0);
    expect(r.totalBudget).toBe(0);
    expect(r.totalActual).toBe(0);
  });
});
