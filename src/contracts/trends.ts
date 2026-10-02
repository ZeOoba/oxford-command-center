// Portfolio Trends Wave 2 — monthly snapshot history (GET /api/warehouse/analytics/trends/history).
// One point per property per calendar month, read from portfolio_month_snapshot.
import { z } from 'zod';

export const TrendsHistoryPointSchema = z.object({
  propertyId: z.string(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  capturedThrough: z.string(),
  totalSf: z.number().nonnegative(),
  leasedSf: z.number().nonnegative(),
  inPlaceRent: z.number().nonnegative(),
  leaseCount: z.number().int().nonnegative(),
  occPct: z.number().min(0).max(1).nullable(),
  frozen: z.boolean(),
});
export type TrendsHistoryPoint = z.infer<typeof TrendsHistoryPointSchema>;

export const TrendsHistoryResponseSchema = z.object({ points: z.array(TrendsHistoryPointSchema) });
export type TrendsHistoryResponse = z.infer<typeof TrendsHistoryResponseSchema>;
