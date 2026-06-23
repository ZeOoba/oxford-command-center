// src/contracts/insights.ts
//
// Wire contract for the Oxford Command Center Insight Engine (Phase 2 Unit A).
// Every Phase 3 generator must produce objects that parse cleanly against
// InsightCandidateSchema and aggregate them into an InsightReport.
//
// Design decisions:
//   - `advisoryOnly: z.literal(true)` appears on BOTH InsightCandidateSchema and
//     InsightReportSchema — belt-and-suspenders: neither a rogue candidate nor a
//     rogue report envelope can drop the advisory flag.
//   - `spine === 'cross'` requires `attribution.method` (documented basis-match
//     note) enforced via .superRefine() — no silent cross-spine aggregation.
//   - No routes, no engine code, no financial constants — contract only.
//   - Imports Provenance from common.ts (single provenance primitive; do NOT
//     redefine here).
//
// Spec: docs/superpowers/plans/2026-06-22-insight-engine-and-remediation-master-plan.md

import { z } from 'zod';
import { Provenance } from './common';

// ── InsightFamily ─────────────────────────────────────────────────────────────

/**
 * Coarse classification of what economic phenomenon a candidate describes.
 *
 * CF — capital / acquisition signals
 * DR — data-driven regime shifts
 * TE — tenant-action effects
 * TR — track-record signals
 * CR — concentration risk
 */
export const InsightFamilySchema = z.enum(['CF', 'DR', 'TE', 'TR', 'CR']);
export type InsightFamily = z.infer<typeof InsightFamilySchema>;

// ── InsightCandidateSchema ────────────────────────────────────────────────────

/**
 * A single insight emitted by one generator for one property (or the portfolio).
 *
 * Key invariants:
 *  - `id` must be stable across runs for the same property+generator pair so
 *    that downstream dedup logic can suppress re-presentations.
 *  - `spine` documents which data source(s) produced the signal.  When both
 *    spines contribute (`'cross'`), `attribution.method` is REQUIRED — it must
 *    name the basis-matching approach so reviewers can verify comparability.
 *  - `advisoryOnly: z.literal(true)` — no insight may auto-execute.
 */
export const InsightCandidateSchema = z
  .object({
    /** Stable dedup key — same property + generator = same id across runs.
     *  Recommended format: `<generatorId>::<propertyId>` or
     *  `<generatorId>::portfolio` for portfolio-level insights. */
    id: z.string(),

    family: InsightFamilySchema,

    /** Identifies the generator that produced this candidate, e.g. 'cf-hurdle-drag'. */
    generatorId: z.string(),

    /** Property this insight applies to; null for portfolio-level insights. */
    propertyId: z.string().nullable(),

    /**
     * Which data spine produced this signal.
     *
     * 'A'     = Master Workbook / PortfolioSnapshot (live current-state spine)
     * 'B'     = warehouse SQLite / P&L analytics (historical time-dimension spine)
     * 'cross' = both spines combined — REQUIRES attribution.method to document
     *           the basis-comparability proof (enforced via superRefine).
     */
    spine: z.enum(['A', 'B', 'cross']),

    /**
     * Lineage — every input the generator consumed, keyed by name.
     * `method` is optional for single-spine insights; REQUIRED for 'cross' (see superRefine).
     */
    attribution: z.object({
      inputs: z.record(z.unknown()),
      method: z.string().optional(),
    }),

    /** Generator's self-assessed confidence: 0.0 (pure speculation) to 1.0 (confirmed). */
    confidence: z.number().min(0).max(1),

    /**
     * ORA priority goal this insight serves.
     * 1 = acquisition velocity · 2 = operational optimization
     * 3 = institutional quality · 4 = comms/brand · 5 = knowledge capture
     */
    goal: z.number().int().min(1).max(5),

    /** Dollar magnitude of the insight (annual run-rate where applicable). null for
     *  non-dollar insights (e.g. data-quality flags, concentration narrative). */
    materialityUsd: z.number().nullable(),

    /** Short human-readable label for display in alerts / IC memos. */
    title: z.string(),

    /**
     * Deterministic fallback narrative — must be self-contained and render
     * meaningfully WITHOUT an LLM.  The AI narrative layer may enrich this but
     * must never be a prerequisite for reading the insight.
     */
    discovery: z.string(),

    /** Provenance stamp — sourced from common.ts. */
    prov: Provenance,

    /** Belt-and-suspenders advisory flag.  Literal true — never omit or override. */
    advisoryOnly: z.literal(true),
  })
  .superRefine((candidate, ctx) => {
    // When both spines contribute, the generator MUST document the basis-matching
    // approach in attribution.method so reviewers can verify NOI/figure comparability.
    if (candidate.spine === 'cross' && !candidate.attribution.method) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['attribution', 'method'],
        message:
          "attribution.method is required when spine === 'cross' — document the basis-match approach (e.g. \"NOI basis-matched: both legs use Oxford-share oxfordNoi\")",
      });
    }
  });

export type InsightCandidate = z.infer<typeof InsightCandidateSchema>;

// ── DataReadinessEntrySchema ──────────────────────────────────────────────────

/**
 * Declares whether a generator has sufficient data to produce live signals.
 *
 * 'live'                — generator fires in normal operation
 * 'dormant-low-n'       — not enough samples yet (sampleN < threshold)
 * 'dormant-no-outcomes' — data exists but outcomes needed for calibration are absent
 */
export const DataReadinessEntrySchema = z.object({
  generatorId: z.string(),
  status: z.enum(['live', 'dormant-low-n', 'dormant-no-outcomes']),
  /** Count of qualifying data points available. null when uncountable or unknown. */
  sampleN: z.number().int().nonnegative().nullable(),
});

export type DataReadinessEntry = z.infer<typeof DataReadinessEntrySchema>;

// ── InsightReportSchema ───────────────────────────────────────────────────────

/**
 * Top-level report envelope — the payload returned by the insight engine's
 * aggregate route.
 *
 * `advisoryOnly: z.literal(true)` at the report level mirrors the per-candidate
 * flag so consumers can gate on one check rather than iterating candidates.
 */
export const InsightReportSchema = z.object({
  candidates: z.array(InsightCandidateSchema),
  dataReadiness: z.array(DataReadinessEntrySchema),
  /** ISO 8601 timestamp of generation (wall-clock injected by the route, not the engine). */
  generatedAt: z.string().datetime(),
  advisoryOnly: z.literal(true),
});

export type InsightReport = z.infer<typeof InsightReportSchema>;
