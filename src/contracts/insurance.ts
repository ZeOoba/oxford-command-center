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
});
export type InsurancePolicy = z.infer<typeof InsurancePolicy>;
