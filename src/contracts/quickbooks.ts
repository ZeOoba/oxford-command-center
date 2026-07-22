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

/**
 * Per-lease AR aging (audit Fix #2 — collections monitoring). Dollars in each past-due bucket,
 * keyed by Lease.id in PortfolioSnapshot.tenantArrears. Overlay-sourced like noiBudgets: the
 * workbook carries no receivables, so this is populated out-of-band (QuickBooks Desktop AR aging
 * export, or manual entry) until a live QB feed lands. d90plus is 90+ days past due.
 */
export const TenantArrears = z.object({
  d30: z.number().nonnegative().default(0),     // 1–30 days past due
  d60: z.number().nonnegative().default(0),     // 31–60 days past due
  d90: z.number().nonnegative().default(0),     // 61–90 days past due
  d90plus: z.number().nonnegative().default(0), // 90+ days past due
  asOfDate: z.coerce.date().nullable().optional(),
  sourceFile: z.string().nullable().optional(),
});
export type TenantArrears = z.infer<typeof TenantArrears>;

/** POST /api/actions/tenant-arrears body. */
export const TenantArrearsInput = z.object({ leaseId: z.string().min(1), arrears: TenantArrears });
export type TenantArrearsInput = z.infer<typeof TenantArrearsInput>;

/**
 * Denormalized, brief-friendly projection of one lease's AR arrears — the read model the daily
 * brief's 4c (and any flat-JSON consumer) reads WITHOUT a leaseId→lease join. Derived at
 * snapshot-build time from PortfolioSnapshot.tenantArrears + leases (see
 * server/ar/derive-ar-balances). total = d30+d60+d90+d90plus. An all-zero entry means
 * "checked, current" — distinct from an ABSENT entry, which means "no AR data". Never overlay
 * state: always recomputed each derive, so it can't drift from tenantArrears.
 */
export const ArBalance = z.object({
  leaseId: z.string(),
  tenantName: z.string(),
  company: z.string().nullable().default(null),
  unit: z.string().nullable().default(null),
  propertyKey: z.string(),
  propertyId: z.string().nullable().default(null),
  d30: z.number().nonnegative().default(0),     // 1–30 days past due
  d60: z.number().nonnegative().default(0),     // 31–60 days past due
  d90: z.number().nonnegative().default(0),     // 61–90 days past due
  d90plus: z.number().nonnegative().default(0), // 90+ days past due
  total: z.number().nonnegative(),
  asOfDate: z.coerce.date().nullable().optional(),
  sourceFile: z.string().nullable().optional(),
});
export type ArBalance = z.infer<typeof ArBalance>;
