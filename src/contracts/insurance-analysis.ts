// src/contracts/insurance-analysis.ts
//
// Phase 4 — Insurance reasoning layer contracts (4a.3). Wire contract for
// GET /api/warehouse/insurance/analysis, produced by server/warehouse/insurance-analysis.ts.
//
// Doctrine (4a.2): the benchmark is an OWN-BOOK median, never a market rate — copy and
// basisNote MUST say "vs own-book median" everywhere, never "over market". An own-book
// median flags ~half the book by construction; `excessPremiumVsMedian` is dispersion, NOT a
// savings promise (no haircut factors, no invented capture rates — real savings claims wait
// for P4c quotes). Null-TIV policies are excluded from rate math (cohort
// 'excluded-null-tiv') but still listed so the register stays complete.
import { z } from 'zod';

// ── Per-policy economics ──────────────────────────────────────────────────────
export const InsuranceCohort = z.enum(['property-package', 'other', 'excluded-null-tiv']);
export type InsuranceCohort = z.infer<typeof InsuranceCohort>;

export const RenewalBucket = z.enum(['now-45', 'soon-90', 'later', 'expired', 'unknown']);
export type RenewalBucket = z.infer<typeof RenewalBucket>;

export const PolicyEconomics = z.object({
  policyId: z.string().min(1),
  property: z.string(),
  propertyId: z.string().nullable(),
  carrier: z.string().nullable(),
  policyType: z.string().nullable(),
  premium: z.number().nonnegative(),
  tiv: z.number().nonnegative().nullable(),
  ratePer100Tiv: z.number().nonnegative().nullable(),
  cohort: InsuranceCohort,
  /** premium/$100-TIV above the cohort median × tiv/100 — dispersion vs own-book median, not
   *  a market comparison. Null when the policy is excluded from rate math (null TIV). */
  excessPremiumVsMedian: z.number().nullable(),
  renewalBucket: RenewalBucket,
  daysToExpiry: z.number().nullable(),
});
export type PolicyEconomics = z.infer<typeof PolicyEconomics>;

// ── Book benchmark ────────────────────────────────────────────────────────────
/** Own-book median rate for the property/package cohort. `sufficient` gates display —
 *  n<5 renders as "insufficient cohort", never a false-precision median. */
export const BookBenchmark = z.object({
  cohort: z.literal('property-package'),
  medianRatePer100Tiv: z.number().nonnegative().nullable(),
  cohortN: z.number().int().nonnegative(),
  sufficient: z.boolean(),
  basisNote: z.string(),
});
export type BookBenchmark = z.infer<typeof BookBenchmark>;

// ── Report envelope ───────────────────────────────────────────────────────────
/** GET /api/warehouse/insurance/analysis response envelope (4a.3). */
export const InsuranceAnalysisReport = z.object({
  asOf: z.string(),
  premiumAnnualTotal: z.number().nonnegative(),
  policiesN: z.number().int().nonnegative(),
  tivKnownN: z.number().int().nonnegative(),
  benchmark: BookBenchmark,
  /** Sorted excessPremiumVsMedian DESC — the engine's ordering, not re-sorted client-side. */
  rebidCandidates: z.array(PolicyEconomics),
  /** Sorted by daysToExpiry ASC (soonest first). */
  renewalCalendar: z.array(PolicyEconomics),
  advisoryOnly: z.literal(true),
});
export type InsuranceAnalysisReport = z.infer<typeof InsuranceAnalysisReport>;
