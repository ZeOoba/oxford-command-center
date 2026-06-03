import { z } from 'zod';
import { DataQualityFlag, IsoDateNullable, Market, PropertyType } from './common';

/**
 * A portfolio asset. Source of truth: master workbook `Property NOI` sheet
 * (14 income-producing entries, Oxford-share economics).
 */
export const Property = z.object({
  id: z.string(),
  index: z.number().int().nullable(), // workbook row # (1..15, gaps preserved)
  name: z.string(),
  address: z.string(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  market: Market,
  type: PropertyType,
  sf: z.number().nonnegative(),
  tenantCount: z.number().int().nonnegative(),
  occPct: z.number().min(0).max(1),
  acqDate: IsoDateNullable,

  // Valuation & ownership
  estValue100: z.number(), // 100% basis
  oxfordOwnPct: z.number().min(0).max(1),
  oxfordValue: z.number(),

  // Income statement (Oxford share)
  grossIncome: z.number(),
  expenses: z.number(),
  noi: z.number(),
  noiScenarioAdj: z.number(),
  debtService: z.number(),
  netCashFlow: z.number(),

  // Returns & leverage
  capRate: z.number().nullable(),
  dscr: z.number().nullable(),
  lender: z.string().nullable(),
  loanBalance: z.number(),
  ltv: z.number().nullable(),
  valuePerSf: z.number().nullable(),
  rentPerSf: z.number().nullable(),
  equityInvested: z.number(),
  cashOnCash: z.number().nullable(),
  holdYrs: z.number().nullable(),

  // Derived/structural
  encumbered: z.boolean(),
  flags: z.array(DataQualityFlag).default([]),
});
export type Property = z.infer<typeof Property>;
