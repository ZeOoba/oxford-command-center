// src/contracts/insurance-loss.ts
//
// Phase 4c — Insurance LOSS reasoning layer contracts (P4c placeholder buildout).
// Wire contract for GET /api/warehouse/insurance/loss, produced by
// server/warehouse/insurance-loss.ts and consumed by the Insurance UI.
//
// Doctrine: DISPERSION / ARITHMETIC ONLY. Every figure here is a mechanical roll-up of
// observed loss runs and dec-page terms — expected annual loss (grossIncurred / observationYears),
// retained-vs-transferred split against the stated deductible/limit, and a simple loss ratio.
// There are NO risk-load, loss-development, or transfer-share constants — this layer does not
// price risk, credit loss development, or assert a savings/capture rate (real premium claims wait
// for P4c quotes; see insurance-analysis.ts own-book-median doctrine).
//
// PLACEHOLDER DISCRIMINATORS: `lossDataSource` and `decPageDataSource` (each 'warehouse' |
// 'placeholder' | 'absent') declare, per report, whether the loss runs and dec-page terms came
// from the warehouse or from placeholder fixtures. `decPageDataSource` is 'placeholder' if ANY
// policy fell back to blanket dec values. These flags gate the UI's placeholder banner.
//
// CALIBRATION WRITES ARE FORBIDDEN on placeholder inputs: nothing derived from placeholder loss
// runs or dec pages may be persisted back into the warehouse or used to calibrate any benchmark —
// this contract is advisory-only (`advisoryOnly: z.literal(true)`) and read-path exclusively.
import { z } from 'zod';
import { Provenance } from './common';

// ── Data-source discriminators ────────────────────────────────────────────────
/** Provenance of a loss/dec input: real warehouse data, placeholder fixture, or absent. */
export const LossDataSource = z.enum(['warehouse', 'placeholder', 'absent']);
export type LossDataSource = z.infer<typeof LossDataSource>;

// ── Per-property expected annual loss ─────────────────────────────────────────
/** Expected annual loss per property = grossIncurredTotal / observationYears (arithmetic mean,
 *  no development factors). `ealAnnual` is null and `indeterminate` true when the observation
 *  window is unknown/zero — never a false-precision zero. */
export const PropertyEal = z.object({
  propertyId: z.string().min(1),
  property: z.string(),
  eventsN: z.number().int().nonnegative(),
  grossIncurredTotal: z.number().nonnegative(),
  observationYears: z.number().int().nonnegative(),
  ealAnnual: z.number().nonnegative().nullable(), // null when indeterminate
  indeterminate: z.boolean(),
  prov: Provenance,
});
export type PropertyEal = z.infer<typeof PropertyEal>;

// ── Per-policy deductible / retention review ──────────────────────────────────
/** Retained-vs-transferred loss split against the stated deductible and limit — pure arithmetic
 *  bucketing of observed events, no risk-load. `lossRatio` is grossIncurredTotal / premium and is
 *  null when premium is 0. */
export const DeductibleReview = z.object({
  policyId: z.string().min(1),
  property: z.string(),
  propertyId: z.string().nullable(),
  deductible: z.number().nonnegative().nullable(),
  coverageLimit: z.number().nonnegative().nullable(),
  decSource: LossDataSource,
  eventsN: z.number().int().nonnegative(),
  lossesBelowDeductible: z.number().int().nonnegative(),
  lossesAboveDeductible: z.number().int().nonnegative(),
  retainedUsd: z.number().nonnegative(),
  transferredUsd: z.number().nonnegative(),
  overLimitUsd: z.number().nonnegative(),
  lossRatio: z.number().nonnegative().nullable(), // grossIncurredTotal / premium; null when premium 0
  prov: Provenance,
});
export type DeductibleReview = z.infer<typeof DeductibleReview>;

// ── Portfolio self-insure split ───────────────────────────────────────────────
/** Portfolio-level retained/transferred/over-limit roll-up plus premium and EAL totals. */
export const SelfInsureSplit = z.object({
  retainedUsd: z.number().nonnegative(),
  transferredUsd: z.number().nonnegative(),
  overLimitUsd: z.number().nonnegative(),
  premiumAnnualTotal: z.number().nonnegative(),
  portfolioEalAnnual: z.number().nonnegative().nullable(),
  observationYears: z.number().int().nonnegative(),
});
export type SelfInsureSplit = z.infer<typeof SelfInsureSplit>;

// ── Rebid pipeline ────────────────────────────────────────────────────────────
export const RebidStage = z.enum(['watch', 'quote', 'rebid']);
export type RebidStage = z.infer<typeof RebidStage>;

export const RebidPipelineItem = z.object({
  policyId: z.string().min(1),
  property: z.string(),
  stage: RebidStage,
  excessPremiumVsMedian: z.number().nullable(),
  renewalBucket: z.string(),
  reason: z.string(),
});
export type RebidPipelineItem = z.infer<typeof RebidPipelineItem>;

// ── Report envelope ───────────────────────────────────────────────────────────
/** GET /api/warehouse/insurance/loss response envelope (P4c). Advisory-only, read-path. */
export const InsuranceLossReport = z.object({
  asOf: z.string(),
  lossDataSource: LossDataSource,
  decPageDataSource: LossDataSource, // 'placeholder' if ANY policy fell back to blanket values
  droppedFixtureRows: z.number().int().nonnegative(),
  eal: z.array(PropertyEal),
  deductibleReviews: z.array(DeductibleReview),
  selfInsure: SelfInsureSplit,
  rebidPipeline: z.array(RebidPipelineItem),
  basisNote: z.string(),
  advisoryOnly: z.literal(true),
});
export type InsuranceLossReport = z.infer<typeof InsuranceLossReport>;
