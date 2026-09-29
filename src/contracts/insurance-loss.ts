// src/contracts/insurance-loss.ts
//
// Phase 4c — Insurance LOSS reasoning layer contracts (P4c placeholder buildout).
// Wire contract for GET /api/warehouse/insurance/loss, produced by
// server/warehouse/insurance-loss-analysis.ts and consumed by the Insurance UI.
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
//
// DATA QUALITY (2026-09-24): `unmatchedPolicyRefs` lists loss events whose policy_ref names no
// policy on file at their property (a loss-run typo or a register gap). Visibility only — it never
// changes attachment; `.default([])` keeps a payload produced before this field existed (a stale
// server process, a cached response) parseable on a newer client. (This route is never baked:
// it is absent from scripts/bake-warehouse.ts FIXED_ROUTES, so a mirror is not the reason.)
// WAREHOUSE-ONLY: it is computed solely when `lossDataSource` is 'warehouse' — the placeholder
// fixture's refs are the synthetic 'PLACEHOLDER' sentinel, never a typo, so it is [] otherwise.
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

// ── Unmatched policy refs (data quality) ──────────────────────────────────────
/** A loss event whose non-blank policy_ref matches neither any policy's own number nor any
 *  number its line carried among ALL policies at the event's property (any line). The engine
 *  ignored the ref and attached the event by loss date (or left it EAL-only for a third-party
 *  cause) — this row only makes that visible. `policyRef` is the RAW loss-run value, not the
 *  normalized form, so the typo is legible; `property` uses the same display-name fallback as
 *  PropertyEal (register name, else the id). `eventId` is display-only and deliberately NOT
 *  min(1): both loss-event loaders admit id '' (the warehouse mapper also coerces a NULL id —
 *  migration 022's TEXT PRIMARY KEY lacks NOT NULL — to ''), so '' can repeat; it is a sort
 *  tiebreak, not a unique key. The engine parses its own output — a stricter rule would 500 the
 *  whole loss report on one blank id (refute wf_dd1d6f45-da0, wf_5326581d-04f). */
export const UnmatchedPolicyRef = z.object({
  eventId: z.string(),
  propertyId: z.string().min(1),
  property: z.string(),
  policyRef: z.string().min(1),
  lossDate: z.string(),
  cause: z.string().nullable(),
  grossIncurred: z.number().nonnegative(), // loader-guaranteed ≥ 0: resolveLossEvents coerces (the 022 CHECK does not stop a BLOB); the fixture parser drops
});
export type UnmatchedPolicyRef = z.infer<typeof UnmatchedPolicyRef>;

// ── Report envelope ───────────────────────────────────────────────────────────
/** GET /api/warehouse/insurance/loss response envelope (P4c). Advisory-only, read-path. */
export const InsuranceLossReport = z.object({
  asOf: z.string(),
  lossDataSource: LossDataSource,
  decPageDataSource: LossDataSource, // 'placeholder' if ANY policy fell back to blanket values
  droppedFixtureRows: z.number().int().nonnegative(),
  // `.default([])` is REQUIRED: a payload produced before this field existed (a stale server
  // process still running older code, or a cached response) must still parse on a newer client.
  // Not a bake concern — /insurance/loss is not in scripts/bake-warehouse.ts FIXED_ROUTES.
  unmatchedPolicyRefs: z.array(UnmatchedPolicyRef).default([]),
  // DATA QUALITY (2026-09-27): warehouse loss-event rows KEPT with a value coerced away by the
  // loader — a loss_date that is not a real ISO YYYY-MM-DD (→ no date: counted in eventsN/gross,
  // not in observation years) or a present gross_incurred that is non-numeric, non-finite or above
  // the $1T ceiling (→ $0). The importer shares the loader's rules (isIsoCalendarDate,
  // MAX_LOSS_EVENT_USD) and rejects all of these, so new rows arrive only via raw SQL — but a row
  // imported before 2026-09-27 under the old regex-only date rule (e.g. '2023-02-29') is counted too.
  // Always 0 on the placeholder path (the fixture parser drops rows into droppedFixtureRows).
  // `.default(0)` for the same stale-payload reason as unmatchedPolicyRefs.
  coercedLossEventRows: z.number().int().nonnegative().default(0),
  eal: z.array(PropertyEal),
  deductibleReviews: z.array(DeductibleReview),
  selfInsure: SelfInsureSplit,
  rebidPipeline: z.array(RebidPipelineItem),
  basisNote: z.string(),
  advisoryOnly: z.literal(true),
});
export type InsuranceLossReport = z.infer<typeof InsuranceLossReport>;
