import { z } from 'zod';
import { DataQualityFlag, IsoDateNullable } from './common';

export const InsuranceStatus = z.enum([
  'Current',
  'Renewing Soon',
  'Renew Now',
  'Expired',
  'Cancelled',
  'Unknown',
]);
export type InsuranceStatus = z.infer<typeof InsuranceStatus>;

/** A policy. Source: master workbook `Insurance Renewals` (24 active, ~$166K premium). */
export const InsurancePolicy = z.object({
  id: z.string(),
  property: z.string(),
  entity: z.string().nullable(),
  coverage: z.string().nullable(),
  effective: IsoDateNullable,
  expires: IsoDateNullable,
  policyNo: z.string().nullable(),
  carrier: z.string().nullable(),
  premium: z.number().nonnegative(),
  daysToExpiry: z.number().nullable(),
  status: InsuranceStatus,
  notes: z.string().nullable(),
  flags: z.array(DataQualityFlag).default([]),
  /**
   * Phase 4 TIV/deductible/limit framework (D3). All nullable-with-null-default (house
   * convention — see acquisition.ts/comps.ts/quickbooks.ts): the workbook `Insurance Renewals`
   * tab does not carry these columns yet, so existing producers that omit the key entirely
   * (pre-4a.1 parser output, existing fixtures) still parse; the parser will populate them
   * once Gabriel adds the columns (4a.1). Never invented — null + a DataQualityFlag, not a guess.
   */
  tiv: z.number().nonnegative().nullable().default(null),
  deductible: z.number().nonnegative().nullable().default(null),
  coverageLimit: z.number().nonnegative().nullable().default(null),
});
export type InsurancePolicy = z.infer<typeof InsurancePolicy>;
