import { z } from 'zod';

export const QbMonthly = z.object({
  month: z.string(), // YYYY-MM
  income: z.number().default(0),
  expense: z.number().default(0),
  noi: z.number().default(0),
});
export type QbMonthly = z.infer<typeof QbMonthly>;

export const QbGlLine = z.object({ account: z.string(), amount: z.number() });
export type QbGlLine = z.infer<typeof QbGlLine>;

export const QbProperty = z.object({
  propertyKey: z.string(), // raw QB property/class name
  propertyId: z.string().nullable().default(null), // resolved to Property.id, best-effort
  annualIncome: z.number().default(0),
  annualExpense: z.number().default(0),
  annualNoi: z.number().default(0),
  monthly: z.array(QbMonthly).default([]),
  glExpense: z.array(QbGlLine).default([]),
});
export type QbProperty = z.infer<typeof QbProperty>;

/** Parsed QuickBooks actuals (server-attached, not from the workbook). Null when no export present. */
export const QbActuals = z.object({
  sourceFile: z.string().nullable().default(null),
  parsedAt: z.string(),
  properties: z.array(QbProperty).default([]),
});
export type QbActuals = z.infer<typeof QbActuals>;

/** POST /api/actions/noi-budget body. */
export const NoiBudgetInput = z.object({ propertyId: z.string().min(1), amount: z.number().nonnegative() });
export type NoiBudgetInput = z.infer<typeof NoiBudgetInput>;
