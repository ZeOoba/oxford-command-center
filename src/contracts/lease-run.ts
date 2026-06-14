// src/contracts/lease-run.ts
//
// Zod contract for the PFI Lease-Run Pro Forma feature (forward lease-cashflow projection).
// Spec: docs/superpowers/specs/2026-06-14-pfi-lease-run-proforma-feature.md.
//
// This is the H6 read boundary for the lease-run routes: the SAME schemas the server
// .parse()s before c.json and the client .parse()s after fetchJson. Each payload schema
// mirrors ONE engine return type EXACTLY (no field added/dropped) — a behavior-preserving
// boundary, not a data change. Nothing here is a governor; nothing here is a confidential
// deal term (the two v1 properties are owned ORA assets, ratified in the property master).
import { z } from 'zod';

// ── Lease structure & rent-period status ──────────────────────────────────────────────────
// NNN-family structures are net-to-landlord (the engine never models reimbursement income or
// opex for them). modified_gross/gross are declared for the schema's future but UNSUPPORTED in
// v1 — the engine throws on them rather than silently mis-modeling (Behavior contract #2).
export const LeaseStructure = z.enum(['absolute_nnn', 'nnn', 'modified_gross', 'gross']);
export type LeaseStructure = z.infer<typeof LeaseStructure>;

/** Per-period provenance of the base rent:
 *  - contractual        : hard data from the in-place lease/amendments.
 *  - renewal_exercised  : hard data, locked by an exercised renewal notice.
 *  - option_contractual : an unexercised renewal option, but at FIXED pre-agreed rates → data.
 *  - option_assumed     : an unexercised option with NO fixed rate → modeled (grown) ASSUMPTION. */
export const RentStatus = z.enum([
  'contractual',
  'renewal_exercised',
  'option_contractual',
  'option_assumed',
]);
export type RentStatus = z.infer<typeof RentStatus>;

/** Whether a status is hard data (true) or a flagged assumption (false). The single source of
 *  truth for "is this row data?" — the engine, the envelope, and the UI all defer to it. */
export const HARD_DATA_STATUSES: ReadonlySet<RentStatus> = new Set<RentStatus>([
  'contractual',
  'renewal_exercised',
  'option_contractual',
]);
export function isAssumptionStatus(status: RentStatus): boolean {
  return !HARD_DATA_STATUSES.has(status);
}

// ── Source rent schedule (as ingested / seeded) ───────────────────────────────────────────
// `annualBaseRent` is null ONLY for an option_assumed row whose rent is derived from the prior
// period × (1 + renewalMarketGrowthPct) at projection time. All hard-data rows carry a number.
export const RentScheduleEntry = z.object({
  periodStart: z.string(), // ISO date 'YYYY-MM-DD'
  periodEnd: z.string(), // ISO date 'YYYY-MM-DD'
  leaseYearLabel: z.string(), // e.g. "LY '27"
  annualBaseRent: z.number().nullable(),
  status: RentStatus,
});
export type RentScheduleEntry = z.infer<typeof RentScheduleEntry>;

export const RenewalOption = z.object({
  termYears: z.number().int().positive(),
  rentBasis: z.enum(['fixed', 'frv_or_floor']),
  floorAnnual: z.number().nullable().optional(),
  notice: z.string().nullable().optional(),
});
export type RenewalOption = z.infer<typeof RenewalOption>;

/** Per-field provenance, matching the warehouse ingestion contract (source lease file + abstract
 *  date). Optional so seed rows that share one provenance need not repeat it per field. */
export const LeaseProvenance = z.object({
  sourceFile: z.string(),
  abstractDate: z.string(), // ISO date
  note: z.string().nullable().optional(),
});
export type LeaseProvenance = z.infer<typeof LeaseProvenance>;

export const LeaseTerm = z.object({
  propertyId: z.string(),
  suite: z.string().nullable(), // null for single-tenant (v1); admits multi-tenant later
  tenant: z.string(),
  rentableSf: z.number().positive(),
  structure: LeaseStructure,
  commencement: z.string(), // ISO date
  currentExpiry: z.string(), // ISO date
  rentSchedule: z.array(RentScheduleEntry),
  renewalOptions: z.array(RenewalOption).default([]),
  diligenceNotes: z.array(z.string()).default([]),
  provenance: LeaseProvenance.nullable().default(null),
});
export type LeaseTerm = z.infer<typeof LeaseTerm>;

// ── Assumptions (overlay-overridable; defaults below) ─────────────────────────────────────
export const LeaseRunAssumptions = z.object({
  managementFeePct: z.number().min(0).max(1),
  roofStructuralReservePsf: z.number().min(0),
  vacancyCreditLossPct: z.number().min(0).max(1),
  renewalMarketGrowthPct: z.number(), // applies ONLY to option_assumed periods
  indicativeCapRate: z.number().positive(),
});
export type LeaseRunAssumptions = z.infer<typeof LeaseRunAssumptions>;

/** Partial overlay write — every field optional so the UI can patch one assumption at a time.
 *  Merged onto DEFAULT_LEASE_RUN_ASSUMPTIONS in the engine. */
export const LeaseRunAssumptionsInput = z.object({
  propertyId: z.string().min(1),
  managementFeePct: z.number().min(0).max(1).optional(),
  roofStructuralReservePsf: z.number().min(0).optional(),
  vacancyCreditLossPct: z.number().min(0).max(1).optional(),
  renewalMarketGrowthPct: z.number().optional(),
  indicativeCapRate: z.number().positive().optional(),
});
export type LeaseRunAssumptionsInput = z.infer<typeof LeaseRunAssumptionsInput>;

// ── Engine output ─────────────────────────────────────────────────────────────────────────
export const LeaseRunPeriod = z.object({
  leaseYearLabel: z.string(),
  periodStart: z.string(),
  periodEnd: z.string(),
  status: RentStatus,
  isAssumption: z.boolean(), // derived from status (UI flag)
  baseRent: z.number(),
  baseRentPsf: z.number(),
  egr: z.number(),
  managementFee: z.number(), // negative
  reserve: z.number(), // negative
  noi: z.number(),
  noiPsf: z.number(),
  noiGrowthYoY: z.number().nullable(), // null for the first period
});
export type LeaseRunPeriod = z.infer<typeof LeaseRunPeriod>;

export const LeaseRunProjection = z.object({
  propertyId: z.string(),
  tenant: z.string().nullable(),
  rentableSf: z.number().nullable(),
  structure: LeaseStructure.nullable(),
  currentExpiry: z.string().nullable(),
  assumptions: LeaseRunAssumptions,
  assumptionsAreDefault: z.boolean(), // false once an overlay override is applied
  periods: z.array(LeaseRunPeriod),
  stabilizedNoi: z.number().nullable(), // first FULL forward lease-year NOI
  stabilizedYearLabel: z.string().nullable(),
  indicativeValue: z.number().nullable(),
  indicativeValuePsf: z.number().nullable(),
  diligenceNotes: z.array(z.string()),
  isEmpty: z.boolean(), // true when the property has no lease terms
});
export type LeaseRunProjection = z.infer<typeof LeaseRunProjection>;

// ── Mark-to-market (below-market rollover) flag ───────────────────────────────────────────
export const MarkToMarket = z.object({
  propertyId: z.string(),
  currentBaseRentPsf: z.number().nullable(),
  cohortMedianPsf: z.number().nullable(),
  cohortP25Psf: z.number().nullable(),
  cohortN: z.number(),
  belowMarket: z.boolean(),
  // upside as a fraction: (cohortMedian - current) / current; null if not computable
  upsidePct: z.number().nullable(),
});
export type MarkToMarket = z.infer<typeof MarkToMarket>;

// ── Route envelopes (H6) ──────────────────────────────────────────────────────────────────
export const LeaseRunProjectionEnvelope = LeaseRunProjection.extend({
  markToMarket: MarkToMarket.nullable(),
});
export type LeaseRunProjectionEnvelope = z.infer<typeof LeaseRunProjectionEnvelope>;

/** Per-property summary row for the ownership-level rollup. */
export const LeaseRunSummary = z.object({
  propertyId: z.string(),
  tenant: z.string().nullable(),
  rentableSf: z.number().nullable(),
  stabilizedNoi: z.number().nullable(),
  indicativeValue: z.number().nullable(),
  currentExpiry: z.string().nullable(),
  belowMarket: z.boolean(),
  // rollover markers across the run: lease-year labels where a status boundary occurs
  rolloverLabels: z.array(z.string()),
});
export type LeaseRunSummary = z.infer<typeof LeaseRunSummary>;

export const LeaseRunRollupResponse = z.object({
  summaries: z.array(LeaseRunSummary),
  totalStabilizedNoi: z.number(),
  totalIndicativeValue: z.number(),
});
export type LeaseRunRollupResponse = z.infer<typeof LeaseRunRollupResponse>;
