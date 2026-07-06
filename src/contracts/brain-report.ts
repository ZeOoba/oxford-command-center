// src/contracts/brain-report.ts
//
// Phase 5 — Command Brain contracts (5a.2). Wire contract for the feedback write boundary
// (POST /api/warehouse/brain/feedback) and the composed report read boundary
// (GET /api/warehouse/brain/report), produced by server/warehouse/brain-report.ts.
//
// Rule (design goal): no invented accuracy, memory, or confidence — every figure derives
// from calibration/insights/DQ data or is absent (null), never fabricated. Months with
// resolvedN<5 render as gaps (AccuracyPoint.hitRate = null), never a theatrical zero.
import { z } from 'zod';

// ── Feedback (accept/dismiss loop over insights/alerts/allocations) ──────────
export const FeedbackSubjectKind = z.enum(['insight', 'alert', 'allocation']);
export type FeedbackSubjectKind = z.infer<typeof FeedbackSubjectKind>;

export const FeedbackDecisionKind = z.enum(['accept', 'dismiss']);
export type FeedbackDecisionKind = z.infer<typeof FeedbackDecisionKind>;

/** A persisted feedback row (`recommendation_feedback` table, append-only per 5a.1). */
export const FeedbackDecision = z.object({
  id: z.string().min(1),
  subjectKind: FeedbackSubjectKind,
  subjectId: z.string().min(1),
  decision: FeedbackDecisionKind,
  decidedAt: z.string(),
  note: z.string().nullable(),
});
export type FeedbackDecision = z.infer<typeof FeedbackDecision>;

/** POST /api/warehouse/brain/feedback request body. v1 is display-state only — no weight
 *  adaptation from dismissals (any such change is an INTEL/INSIGHT config ratification). */
export const FeedbackInput = z.object({
  subjectKind: FeedbackSubjectKind,
  subjectId: z.string().min(1),
  decision: FeedbackDecisionKind,
  note: z.string().nullable().optional(),
});
export type FeedbackInput = z.infer<typeof FeedbackInput>;

// ── Accuracy-over-time series ─────────────────────────────────────────────────
/** One month's rolling hit-rate bucket. `hitRate: null` when resolvedN < 5 — the honesty
 *  gate (mirrors stats.ts MIN_PAIRS ethos): a low-n month is a gap, not a misleading number. */
export const AccuracyPoint = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  resolvedN: z.number().int().nonnegative(),
  hitRate: z.number().nullable(),
});
export type AccuracyPoint = z.infer<typeof AccuracyPoint>;

// ── Confidence-by-cohort (coverage-based, NOT predictive skill) ──────────────
export const ConfidenceRow = z.object({
  key: z.string(),
  label: z.string(),
  sampleN: z.number().int().nonnegative(),
  coverageConfidence: z.number().min(0).max(1),
  basisNote: z.string(),
});
export type ConfidenceRow = z.infer<typeof ConfidenceRow>;

// ── Open questions (honest gap surfacing) ─────────────────────────────────────
export const OpenQuestionKind = z.enum(['data-quality', 'dormant-generator', 'floor-indeterminate']);
export type OpenQuestionKind = z.infer<typeof OpenQuestionKind>;

export const OpenQuestion = z.object({
  kind: OpenQuestionKind,
  title: z.string(),
  detail: z.string(),
  /** What data/action would close this question — never left implicit. */
  wouldClose: z.string(),
});
export type OpenQuestion = z.infer<typeof OpenQuestion>;

// ── Version log ────────────────────────────────────────────────────────────
export const VersionEventKind = z.enum(['config-change', 'inputs-version']);
export type VersionEventKind = z.infer<typeof VersionEventKind>;

export const VersionEvent = z.object({
  at: z.string(),
  kind: VersionEventKind,
  detail: z.string(),
});
export type VersionEvent = z.infer<typeof VersionEvent>;

// ── Track record ───────────────────────────────────────────────────────────
/** One resolved verdict as shown in the Brain's Track Record list. `outcome` mirrors
 *  calibration_outcome.hit (1/0/null) — there is no "partial" state in the schema; a partial
 *  notion would have to be a documented derivation from abs_error bands, never a free-floating
 *  fourth value. */
export const TrackRecordOutcome = z.enum(['hit', 'miss', 'not-scoreable']);
export type TrackRecordOutcome = z.infer<typeof TrackRecordOutcome>;

export const TrackRecordEntry = z.object({
  verdictId: z.string(),
  kind: z.string(),
  subject: z.string(),
  predictedBand: z.string(),
  realizedBand: z.string().nullable(),
  outcome: TrackRecordOutcome,
  resolvedAt: z.string().nullable(),
  predictedValue: z.number().nullable(),
  realizedValue: z.number().nullable(),
});
export type TrackRecordEntry = z.infer<typeof TrackRecordEntry>;

// ── Report envelope ───────────────────────────────────────────────────────────
/** GET /api/warehouse/brain/report response envelope (5a.2). */
export const BrainReport = z.object({
  asOf: z.string(),
  overallHitRate: z.number().nullable(),
  overallCi: z.object({ lo: z.number(), hi: z.number() }).nullable(),
  resolvedTotal: z.number().int().nonnegative(),
  watchedSignals: z.number().int().nonnegative(),
  /** COUNT(DISTINCT config_hash) − 1 over calibration_inputs_version — NOT the raw
   *  inputs_version count, which forks on every P&L import/code version. */
  recalibrations: z.number().int(),
  accuracySeries: z.array(AccuracyPoint),
  trackRecord: z.array(TrackRecordEntry),
  confidenceByMarket: z.array(ConfidenceRow),
  confidenceByManager: z.array(ConfidenceRow),
  openQuestions: z.array(OpenQuestion),
  versionLog: z.array(VersionEvent),
  advisoryOnly: z.literal(true),
});
export type BrainReport = z.infer<typeof BrainReport>;
