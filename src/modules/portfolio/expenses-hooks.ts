// Portfolio Trends Wave 3B — monthly operating-expense feed hook (mirrors useTrendsHistory).
import { useQuery } from '@tanstack/react-query';
import { ExpensesMonthlyResponseSchema, type ExpensesMonthlyResponse } from '@contracts/expenses-monthly';
import { QUERY_OPTS, fetchParsedOrMirror } from '../intel/hooks';

export const EXPENSES_MONTHLY_KEY = ['warehouse', 'analytics', 'expenses', 'monthly'] as const;

/** Errors propagate; the consumer maps isWarehouseUnavailable to the empty state. */
export function useExpensesMonthly() {
  return useQuery({
    queryKey: EXPENSES_MONTHLY_KEY,
    queryFn: (): Promise<ExpensesMonthlyResponse> =>
      fetchParsedOrMirror('/api/warehouse/analytics/expenses/monthly', ExpensesMonthlyResponseSchema),
    ...QUERY_OPTS,
  });
}
