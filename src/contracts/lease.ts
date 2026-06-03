import { z } from 'zod';
import { DataQualityFlag, IsoDateNullable } from './common';

export const LeaseStatus = z.enum(['Active', 'Expiring Soon', 'Expired', 'Vacant', 'Unknown']);
export type LeaseStatus = z.infer<typeof LeaseStatus>;

/**
 * A single tenancy. Source of truth: master workbook `Master Tenant Rent Roll`
 * (137 tenants, $5.7M annualized rent, WALT ~2.3 yrs).
 */
export const Lease = z.object({
  id: z.string(),
  propertyKey: z.string(), // raw property label from rent roll (e.g. "1100 Rarig")
  propertyId: z.string().nullable(), // resolved link to Property.id when matchable
  tenantName: z.string(),
  unit: z.string().nullable(),
  company: z.string().nullable(),
  sf: z.number().nonnegative(),
  monthlyRent: z.number().nonnegative(),
  rentPerSf: z.number().nullable(),
  leaseStart: IsoDateNullable,
  leaseEnd: IsoDateNullable,
  escalationDate: IsoDateNullable,
  escalationPct: z.number().nullable(),
  status: LeaseStatus,
  annualRent: z.number().nonnegative(),
  monthsToExpiry: z.number().nullable(),
  flags: z.array(DataQualityFlag).default([]),
});
export type Lease = z.infer<typeof Lease>;
