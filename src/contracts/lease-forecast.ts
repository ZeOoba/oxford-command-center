// src/contracts/lease-forecast.ts — Phase 3 Lease Forecast Engine contracts.
// All money is annual USD unless suffixed. All dates ISO YYYY-MM-DD.
// Mirrors the Insight/MarkToMarket patterns.
import { z } from 'zod';
import { NarrativeBlock } from './briefing';

// ── Expiration horizon bucket ─────────────────────────────────────────────────
export const ExpiryBucket = z.enum(['0-6m', '6-12m', '12-24m', '24m+', 'expired', 'unknown']);
export type ExpiryBucket = z.infer<typeof ExpiryBucket>;

// ── Renewal probability signal ────────────────────────────────────────────────
// DERIVED heuristic, NOT a governor. Bands, not a continuous score, to avoid
// false precision (we have tenure + stage + arrears, not a trained model).
export const RenewalLikelihood = z.enum(['likely', 'uncertain', 'at-risk', 'lapsing']);
export type RenewalLikelihood = z.infer<typeof RenewalLikelihood>;

export const RenewalSignal = z.object({
  leaseId: z.string(),
  tenantName: z.string(),
  propertyId: z.string().nullable(),
  propertyKey: z.string(),
  annualRent: z.number().nonnegative(),
  sf: z.number().nonnegative(),
  leaseEnd: z.string().nullable(),
  monthsToExpiry: z.number().nullable(),
  expiryBucket: ExpiryBucket,
  tenureMonths: z.number().nullable(),       // (asOf - leaseStart) in months; null if no leaseStart
  renewalStage: z.enum(['Expiring', 'Outreach', 'Negotiating', 'LOI', 'Executed']).nullable(), // from overlay
  arrearsUsd: z.number().nonnegative(),      // sum of overlay tenantArrears buckets; 0 when absent
  monthToMonth: z.boolean(),                 // leaseEnd in the past AND status not Expired → holdover/MTM
  likelihood: RenewalLikelihood,
  // Plain-English why-string for the UI/briefing. Derived from the same inputs as `likelihood`.
  rationale: z.string(),
});
export type RenewalSignal = z.infer<typeof RenewalSignal>;

// ── Leasing velocity (Spine B; warehouse-derived) ─────────────────────────────
// Per-property time-to-lease. v1 derives "days vacant→leased" from lease commencement
// gaps within the lease_terms table plus the new lease_events table; where warehouse
// lacks vacancy history it returns nulls (provenance 'absent') — NEVER a fabricated number.
export const LeasingVelocity = z.object({
  propertyId: z.string(),
  propertyName: z.string(),
  medianDaysToLease: z.number().nullable(),  // null when insufficient history
  leasingEventsN: z.number().int().nonnegative(),
  slowLeasing: z.boolean(),                   // medianDaysToLease > VELOCITY_SLOW_DAYS threshold
});
export type LeasingVelocity = z.infer<typeof LeasingVelocity>;

// ── Rent forecast scenario ────────────────────────────────────────────────────
export const RentScenario = z.enum(['renew_at_current', 'renew_at_market', 'vacancy_haircut']);
export type RentScenario = z.infer<typeof RentScenario>;

export const RentForecastInput = z.object({
  scenario: RentScenario,
  horizonMonths: z.union([z.literal(6), z.literal(12), z.literal(24)]).default(12),
  // vacancy_haircut only: fraction of expiring rent assumed not to renew. 0..1.
  vacancyPct: z.number().min(0).max(1).default(0),
});
export type RentForecastInput = z.infer<typeof RentForecastInput>;

export const RentForecastResult = z.object({
  scenario: RentScenario,
  horizonMonths: z.number(),
  inPlaceAnnualRent: z.number().nonnegative(),     // today's contractual rent roll (Spine A)
  projectedAnnualRent: z.number().nonnegative(),   // rent roll at horizon under the scenario
  deltaUsd: z.number(),                            // projected - inPlace (signed)
  // NOI impact uses the impactAnnualUsd pattern: rent delta flows ~1:1 to NOI on NNN
  // (no opex offset on net leases). Stated explicitly so the UI labels it correctly.
  noiImpactAnnualUsd: z.number(),
  expiringRentInHorizon: z.number().nonnegative(), // rent exposed to the scenario
  spine: z.literal('A'),                           // workbook rent roll basis
  assumptions: z.array(z.string()),                // human-readable assumption ledger
});
export type RentForecastResult = z.infer<typeof RentForecastResult>;

// ── Market-rent gap (extends existing MarkToMarket to the lease grain) ────────
// Uses user-supplied market rents from overlay (NO external API — overlay pattern only).
export const MarketRentGap = z.object({
  leaseId: z.string(),
  tenantName: z.string(),
  propertyKey: z.string(),
  currentRentPsf: z.number().nullable(),
  marketRentPsf: z.number().nullable(),            // from overlay.marketRents; null if unset
  gapPsf: z.number().nullable(),                   // market - current
  gapAnnualUsd: z.number().nullable(),             // gapPsf * sf
  underMarket: z.boolean(),                        // current < market AND both present
  provenance: z.enum(['real', 'derived', 'derived-asking', 'absent']), // derived-asking = lease-market feed (asking NNN-eq cell median)
});
export type MarketRentGap = z.infer<typeof MarketRentGap>;

// ── Expiry bucket summary ─────────────────────────────────────────────────────
export const ExpiryBucketSummary = z.object({
  bucket: ExpiryBucket,
  count: z.number().int().nonnegative(),
  annualRentAtRisk: z.number().nonnegative(),
  pctOfTotal: z.number().nonnegative(),
});
export type ExpiryBucketSummary = z.infer<typeof ExpiryBucketSummary>;

// ── Route envelopes ───────────────────────────────────────────────────────────
export const LeaseForecastResponse = z.object({
  asOf: z.string(),
  signals: z.array(RenewalSignal),
  velocity: z.array(LeasingVelocity),
  marketGaps: z.array(MarketRentGap),
  bucketTotals: z.array(z.object({
    bucket: ExpiryBucket,
    count: z.number().int().nonnegative(),
    expiringRent: z.number().nonnegative(),
    expiringSf: z.number().nonnegative(),
  })),
});
export type LeaseForecastResponse = z.infer<typeof LeaseForecastResponse>;

export const RentForecastResponse = z.object({
  asOf: z.string(),
  results: z.array(RentForecastResult), // one per requested scenario (or all three by default)
});
export type RentForecastResponse = z.infer<typeof RentForecastResponse>;

// ── Overlay write input ───────────────────────────────────────────────────────
export const MarketRentInput = z.object({ key: z.string().min(1), rentPsf: z.number().nonnegative() });
export type MarketRentInput = z.infer<typeof MarketRentInput>;

// ── AI Narrative Leasing Response (Phase 3 W3) ───────────────────────────────
// Envelope returned by GET /api/warehouse/leasing/narrative.
// When `degraded` is true, `narrative` is null and the UI degrades gracefully.
export const LeaseNarrativeResponse = z.object({
  asOf: z.string(),
  narrative: NarrativeBlock.nullable(),
  degraded: z.boolean(),
});
export type LeaseNarrativeResponse = z.infer<typeof LeaseNarrativeResponse>;

// ── Full summary (used by briefing/narrative pipeline) ───────────────────────
export const LeaseForecastSummary = z.object({
  asOf: z.string(),
  renewalSignals: z.array(RenewalSignal),
  expiryBuckets: z.array(ExpiryBucketSummary),
  marketRentGaps: z.array(MarketRentGap),
  rentForecast: z.array(RentForecastResult),
  totalAnnualRent: z.number().nonnegative(),
});
export type LeaseForecastSummary = z.infer<typeof LeaseForecastSummary>;
