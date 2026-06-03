import { z } from 'zod';
import { DataQualityFlag, trend } from './common';

/** Per-entity cash position. Source: master workbook `Cash Balances`. */
export const CashEntity = z.object({
  entity: z.string(),
  id: z.string(),
  currentBalance: z.number(),
  priorBalance: z.number().nullable(),
  deltaDollar: z.number().nullable(),
  deltaPct: z.number().nullable(),
  avg3: z.number().nullable(),
  minAllTime: z.number().nullable(),
  maxAllTime: z.number().nullable(),
  bal12moAgo: z.number().nullable(),
  growth12Dollar: z.number().nullable(),
  growth12Pct: z.number().nullable(),
  pctOfPortfolio: z.number().nullable(),
  trend,
  flags: z.array(DataQualityFlag).default([]),
});
export type CashEntity = z.infer<typeof CashEntity>;

/** One month of the historical cash matrix. */
export const CashHistoryPoint = z.object({
  date: z.string(), // ISO
  total: z.number(),
  balances: z.record(z.string(), z.number()), // entity -> balance
});
export type CashHistoryPoint = z.infer<typeof CashHistoryPoint>;

export const CashSnapshot = z.object({
  asOf: z.string(),
  totalCash: z.number(),
  activeEntities: z.number().int(),
  largestEntity: z.string().nullable(),
  concentrationTopPct: z.number().nullable(),
  cagr: z.number().nullable(),
  entities: z.array(CashEntity),
  history: z.array(CashHistoryPoint),
});
export type CashSnapshot = z.infer<typeof CashSnapshot>;
