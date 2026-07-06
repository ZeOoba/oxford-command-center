// src/contracts/tax.ts
//
// Phase 6 — Taxes module contracts (property-tax assessments, appeals, opportunities).
// Filed returns + cost-seg are OUT of scope (cut list C2) — this is assessment/appeal only.
//
// Basis discipline (verified 6a.3): ledger `Taxes`, assessments, and millage are FULL-ASSET
// (metrics.ts proves the ledger is 100%-basis) while Spine-A property economics are
// Oxford-share. TaxOpportunity therefore carries BOTH `savingsFullAsset` and
// `savingsOxfordShare` — every cross-module ranked surface uses the Oxford-share figure;
// the full-asset figure is display-only in the assessments table with an explicit basis note.
// Nulls (missing millage/assessment) resolve to `indeterminate: true`, never a guessed $0.
import { z } from 'zod';
import { Provenance } from './common';

// ── Assessment ────────────────────────────────────────────────────────────────
// One jurisdiction's assessment of a property for one tax year. Source: assessor documents
// (D2), imported via scripts/import-assessments.ts. Nullable fields are genuinely absent in
// the source — never backfilled by inference.
export const TaxAssessment = z.object({
  propertyId: z.string().min(1),
  taxYear: z.number().int(),
  jurisdiction: z.string().nullable(),
  assessedValue: z.number().nonnegative().nullable(),
  assessmentRatio: z.number().min(0).max(1).nullable(),
  millageRate: z.number().nonnegative().nullable(),
  annualTaxBilled: z.number().nonnegative().nullable(),
  source: z.string().min(1),
  asOf: z.string().nullable(),
});
export type TaxAssessment = z.infer<typeof TaxAssessment>;

// ── Appeal ────────────────────────────────────────────────────────────────────
export const TaxAppealStatus = z.enum(['draft', 'filed', 'hearing', 'won', 'lost', 'withdrawn']);
export type TaxAppealStatus = z.infer<typeof TaxAppealStatus>;

export const TaxAppeal = z.object({
  id: z.string().min(1),
  propertyId: z.string().min(1),
  taxYear: z.number().int(),
  status: TaxAppealStatus,
  filedDate: z.string().nullable(),
  estSavingsAnnual: z.number().nullable(),
  realizedSavingsAnnual: z.number().nullable(),
  notes: z.string().nullable(),
});
export type TaxAppeal = z.infer<typeof TaxAppeal>;

/**
 * Write-boundary for POST /api/warehouse/tax/appeals (6a.5) — create/update subset.
 * `id` absent = create a new appeal; `id` present = update the existing row's status/fields.
 * Status transitions are validated CHECK-constraint-side (server/warehouse/migrations); this
 * schema only validates shape, not the transition graph.
 */
export const TaxAppealInput = z.object({
  id: z.string().min(1).optional(),
  propertyId: z.string().min(1),
  taxYear: z.number().int(),
  status: TaxAppealStatus.default('draft'),
  filedDate: z.string().nullable().default(null),
  estSavingsAnnual: z.number().nullable().default(null),
  realizedSavingsAnnual: z.number().nullable().default(null),
  notes: z.string().nullable().default(null),
});
export type TaxAppealInput = z.infer<typeof TaxAppealInput>;

// ── Opportunity ───────────────────────────────────────────────────────────────
export const TaxOpportunityKind = z.enum(['appeal', 'assessment-watch']);
export type TaxOpportunityKind = z.infer<typeof TaxOpportunityKind>;

/**
 * A single advisory tax opportunity surfaced by the analysis engine (6a.3). Never an
 * auto-executing recommendation — `advisoryOnly` is belt-and-suspenders alongside the
 * report-level flag (mirrors insights.ts InsightCandidateSchema).
 */
export const TaxOpportunity = z.object({
  propertyId: z.string().min(1),
  propertyName: z.string().nullable(),
  kind: TaxOpportunityKind,
  title: z.string(),
  detail: z.string(),
  /** Full-asset basis — matches the ledger/assessment basis. Null when indeterminate. */
  savingsFullAsset: z.number().nullable(),
  /** Oxford-share basis (savingsFullAsset × oxfordOwnPct) — the figure every cross-module
   *  ranked surface (strategy board, Overview actions) must use. Null when indeterminate. */
  savingsOxfordShare: z.number().nullable(),
  /** Explicit basis label, e.g. "full-asset assessment × Oxford 62.5% share". */
  basisNote: z.string(),
  effectiveRate: z.number().nullable(),
  cohortPercentile: z.number().nullable(),
  /** True when a required input (millage, assessed value, cohort data) was missing — the
   *  opportunity is surfaced as a watch item, never a guessed dollar figure. */
  indeterminate: z.boolean(),
  prov: Provenance,
  advisoryOnly: z.literal(true),
});
export type TaxOpportunity = z.infer<typeof TaxOpportunity>;

// ── Report envelope ───────────────────────────────────────────────────────────
/** GET /api/warehouse/tax/analysis response envelope (6a.4). */
export const TaxAnalysisReport = z.object({
  asOf: z.string(),
  propertiesCovered: z.number().int().nonnegative(),
  propertiesIndeterminate: z.number().int().nonnegative(),
  /** Spine-B ledger `Taxes` category sum for the reporting year (full-asset basis). Null when
   *  the warehouse has no `Taxes` classification rows for the period. */
  ledgerTaxAnnualUsd: z.number().nullable(),
  opportunities: z.array(TaxOpportunity),
  assessments: z.array(TaxAssessment),
  appeals: z.array(TaxAppeal),
  advisoryOnly: z.literal(true),
});
export type TaxAnalysisReport = z.infer<typeof TaxAnalysisReport>;
