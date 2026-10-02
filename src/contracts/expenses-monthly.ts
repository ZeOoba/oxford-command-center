// Portfolio Trends Wave 3B — monthly operating-expense feed (consumed by the Trends expense UI).
// Semantics:
//   - Operating-expense (opex) classification only; no capex, debt service or transfers.
//   - Amounts are dollars, expense-positive; refunds/credits may be negative.
//   - One row per (property, month, category); `category` is the warehouse normalized_category.
//   - `coverage` lets the UI say "N of M entities loaded": propertiesLoaded of propertiesExpected,
//     spanning firstMonth..lastMonth ('YYYY-MM', null when no data loaded).
import { z } from 'zod';

export const ExpenseBasis = z.enum(['cash', 'accrual']);

export const ExpenseMonthPointSchema = z.object({
  propertyId: z.string().min(1),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  category: z.string().min(1), // warehouse normalized_category, e.g. 'Repairs & Maintenance'
  amount: z.number().finite(), // dollars, expense-positive; refunds/credits may be negative
  basis: ExpenseBasis,
  sourceSystem: z.enum(['quickbooks', 'yardi', 'appfolio', 'rent-manager', 'unknown']),
});
export type ExpenseMonthPoint = z.infer<typeof ExpenseMonthPointSchema>;

export const ExpensesMonthlyResponseSchema = z.object({
  points: z.array(ExpenseMonthPointSchema),
  coverage: z.object({
    propertiesLoaded: z.number().int().nonnegative(),
    propertiesExpected: z.number().int().nonnegative(),
    firstMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).nullable(),
    lastMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/).nullable(),
  }),
});
export type ExpensesMonthlyResponse = z.infer<typeof ExpensesMonthlyResponseSchema>;
