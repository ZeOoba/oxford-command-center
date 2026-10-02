import { describe, expect, it } from 'vitest';
import { ExpenseMonthPointSchema, ExpensesMonthlyResponseSchema } from '../../src/contracts/expenses-monthly';

const point = {
  propertyId: 'p1',
  month: '2026-09',
  category: 'Repairs & Maintenance',
  amount: 1234.56,
  basis: 'cash',
  sourceSystem: 'quickbooks',
};
const zeroCoverage = { propertiesLoaded: 0, propertiesExpected: 0, firstMonth: null, lastMonth: null };

describe('expenses-monthly contract', () => {
  it('parses a valid point (negative refund amounts allowed)', () => {
    expect(ExpenseMonthPointSchema.safeParse(point).success).toBe(true);
    expect(ExpenseMonthPointSchema.safeParse({ ...point, amount: -50 }).success).toBe(true);
  });

  it('rejects bad month, empty propertyId/category, non-finite amount, unknown basis/sourceSystem', () => {
    for (const bad of [
      { ...point, month: '2026-13' },
      { ...point, month: '2026-00' },
      { ...point, propertyId: '' },
      { ...point, category: '' },
      { ...point, amount: NaN },
      { ...point, amount: Infinity },
      { ...point, amount: -Infinity },
      { ...point, basis: 'modified' },
      { ...point, sourceSystem: 'excel' },
    ]) {
      expect(ExpenseMonthPointSchema.safeParse(bad).success).toBe(false);
    }
  });

  it('parses an empty response with zero coverage', () => {
    expect(ExpensesMonthlyResponseSchema.safeParse({ points: [], coverage: zeroCoverage }).success).toBe(true);
  });

  it('rejects negative or fractional coverage counts', () => {
    for (const cov of [
      { ...zeroCoverage, propertiesLoaded: -1 },
      { ...zeroCoverage, propertiesExpected: -1 },
      { ...zeroCoverage, propertiesLoaded: 1.5 },
    ]) {
      expect(ExpensesMonthlyResponseSchema.safeParse({ points: [], coverage: cov }).success).toBe(false);
    }
  });

  it('coverage first/last month accept null or YYYY-MM and reject malformed', () => {
    const ok = { propertiesLoaded: 1, propertiesExpected: 2, firstMonth: '2025-01', lastMonth: '2026-09' };
    expect(ExpensesMonthlyResponseSchema.safeParse({ points: [point], coverage: ok }).success).toBe(true);
    for (const cov of [
      { ...ok, firstMonth: '2025-1' },
      { ...ok, lastMonth: 'Sept 2026' },
      { ...ok, firstMonth: '2025-13' },
    ]) {
      expect(ExpensesMonthlyResponseSchema.safeParse({ points: [], coverage: cov }).success).toBe(false);
    }
  });
});
