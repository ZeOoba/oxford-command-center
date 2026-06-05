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
});
