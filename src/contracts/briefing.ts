// src/contracts/briefing.ts
//
// Zod contract for the PFI Phase C Briefings + PDF Export feature.
// Spec: docs/superpowers/specs/2026-06-14-pfi-phase-c-briefings-pdf.md.
//
// This is the H6 read boundary for the briefing routes AND the single render input: the
// composer (server/briefing/compose.ts) maps EXISTING warehouse analytics → a BriefingModel
// here; the renderer (server/briefing/pdf.tsx) consumes ONLY a BriefingModel. The JSON sibling
// routes .parse() this envelope before c.json so the UI can preview the exact model the PDF is
// built from (no recompute, no drift between the screen and the page).
//
// Nothing here is a governor and nothing here is a confidential deal term: a BriefingModel is an
// ownership-FINANCIAL artifact (100%-basis NOI/score/benchmark figures keyed by the property slug),
// never a deal artifact. The composer must NEVER read seed-deals.ts or confidential-terms.json into
// this model; the confidentiality guard (server/briefing/confidential.ts) asserts that invariant.
import { z } from 'zod';
import {
  HealthBand,
  AttentionBand,
  CapitalAction,
  AnomalySeverity,
} from './warehouse';

// ── Shared primitives ────────────────────────────────────────────────────────────────────────
/** A unit-labeled figure: the formatted display string the PDF prints verbatim PLUS the raw value
 *  for tests/preview. `display` is ALWAYS a string — a null/absent figure renders as '—'/'n/a' so
 *  no section ever crashes or prints `NaN`/`null` (Behavior contract #4). `unit` documents the
 *  dimension ($, $/SF, %) so the renderer never has to re-derive a label. */
export const Figure = z.object({
  display: z.string(), // e.g. '$1,234,567', '$6.35 /SF', '58.2%', '—'
  value: z.number().nullable(), // the raw analytic value (null when not available)
  unit: z.enum(['usd', 'usd_per_sf', 'pct', 'count', 'none']),
});
export type Figure = z.infer<typeof Figure>;

/** One KPI tile in the per-property band. `spark` is the annual series feeding a vector sparkline
 *  (may be empty → the renderer draws no line, just the value). */
export const Kpi = z.object({
  label: z.string(),
  figure: Figure,
  spark: z.array(z.number()), // ascending full-year series; [] when <2 points
});
export type Kpi = z.infer<typeof Kpi>;

/** A ranked ΔNOI driver line for the per-property briefing (read straight off the drivers engine). */
export const DriverLine = z.object({
  category: z.string(),
  delta: Figure, // signed $ contribution
  contributionPct: Figure, // share of the net change ('—' when totalDelta ≈ 0)
});
export type DriverLine = z.infer<typeof DriverLine>;

/** An anomaly line for the per-property briefing. */
export const AnomalyLine = z.object({
  severity: AnomalySeverity,
  kind: z.string(),
  detail: z.string(),
});
export type AnomalyLine = z.infer<typeof AnomalyLine>;

/** The lease-run / rollover summary block (degrades to all-null when the engine has no terms). */
export const LeaseRunSummaryBlock = z.object({
  present: z.boolean(), // false → render the 'n/a' degraded block (no lease terms)
  tenant: z.string().nullable(),
  currentExpiry: z.string().nullable(), // ISO date or null
  stabilizedNoi: Figure,
  indicativeValue: Figure,
  belowMarket: z.boolean(),
  rolloverLabels: z.array(z.string()),
});
export type LeaseRunSummaryBlock = z.infer<typeof LeaseRunSummaryBlock>;

/** The footer / provenance stamp every page carries. `generatedDate` is INJECTED by the composer
 *  caller (never Date.now() inside the renderer) so the PDF is content-deterministic. */
export const BriefingMeta = z.object({
  generatedDate: z.string(), // ISO date (YYYY-MM-DD) — injected, not wall-clock
  workbookAsOf: z.string(), // the workbook's stated "As of" date (provenance)
  dataFreshness: z.string().nullable(), // latest committed import date, or null
  confidentialMarking: z.literal('CONFIDENTIAL — INTERNAL'),
  masthead: z.literal('OXFORD REALTY ADVISORS'),
});
export type BriefingMeta = z.infer<typeof BriefingMeta>;

// ── Per-property briefing model ────────────────────────────────────────────────────────────────
export const PropertyBriefingModel = z.object({
  kind: z.literal('property'),
  meta: BriefingMeta,
  subject: z.object({
    propertyId: z.string(),
    name: z.string().min(1), // display name; never blank ('—' when the master has none)
    market: z.string().nullable(),
    manager: z.string().nullable(),
    scoredPeriod: z.string().nullable(), // the FY period the score is based on ('—' label upstream)
  }),
  verdict: z.object({
    health: Figure, // 0..100
    healthBand: HealthBand,
    attentionBand: AttentionBand,
    capitalAction: CapitalAction,
    rootCause: z.string().nullable(), // the on-screen synthesized line (null when no waterfall)
    recommendation: z.string(), // the on-screen "DO" line
  }),
  kpis: z.array(Kpi), // NOI, margin, $/SF, since-acquisition NOI growth
  noiTrend: z.array(z.number()), // ascending FY NOI series for the headline sparkline
  drivers: z.array(DriverLine), // top ΔNOI drivers (may be empty → 'n/a' block)
  anomalies: z.array(AnomalyLine), // may be empty → 'none flagged' block
  leaseRun: LeaseRunSummaryBlock,
  benchmark: z.object({
    noiPerSfQuartile: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4)]).nullable(),
    cohortSize: z.number(),
    noiPerSf: Figure,
    cohortMedianNoiPerSf: Figure,
  }),
});
export type PropertyBriefingModel = z.infer<typeof PropertyBriefingModel>;

// ── Per-PM briefing model ────────────────────────────────────────────────────────────────────
/** One managed-property row in the PM roll-up. */
export const ManagedPropertyRow = z.object({
  propertyId: z.string(),
  name: z.string(),
  health: Figure,
  healthBand: HealthBand,
  noi: Figure,
  attentionBand: AttentionBand,
});
export type ManagedPropertyRow = z.infer<typeof ManagedPropertyRow>;

export const ManagerBriefingModel = z.object({
  kind: z.literal('manager'),
  meta: BriefingMeta,
  subject: z.object({
    managerId: z.string(), // URL-safe slug of the PM name (route param)
    name: z.string(), // the property_master.property_manager string
    contact: z.string().nullable(),
    propertyCount: z.number(),
    smallSample: z.boolean(),
  }),
  scorecard: z.object({
    avgNoiPerSf: Figure,
    avgNoiGrowth: Figure,
    avgExpenseGrowth: Figure,
  }),
  managedProperties: z.array(ManagedPropertyRow), // may be empty → 'n/a' block
  attentionItems: z.array(z.string()), // aggregate attention/anomaly call-outs
  actionList: z.array(z.string()), // ranked recommended actions
});
export type ManagerBriefingModel = z.infer<typeof ManagerBriefingModel>;

// ── Subject slug helpers (client + server share one implementation) ────────────────────────────
/**
 * Converts a manager name into a URL-safe slug suitable for use as a route parameter.
 *
 * @returns A URL-safe slug derived from the manager name.
 */
export function managerSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

// ── Discriminated union + route envelopes (H6) ─────────────────────────────────────────────────
export const BriefingModel = z.discriminatedUnion('kind', [
  PropertyBriefingModel,
  ManagerBriefingModel,
]);
export type BriefingModel = z.infer<typeof BriefingModel>;

// ── AI Narrative Briefings (Phase 2 · W2 · Step 7) ──────────────────────────────────────────────
// These schemas EXTEND the base models — the base PropertyBriefingModel / ManagerBriefingModel are
// NEVER modified. New schemas are additive-only. Spec: docs/superpowers/specs/
// 2026-06-21-phase-2-w2-ai-narrative-briefings.md.

/** The AI-generated narrative block injected into a briefing after the composeNarrative call.
 *  `model` records which Anthropic model produced the text (for audit / cost attribution). */
export const NarrativeBlock = z.object({
  headline: z.string(),
  summary: z.string(),
  bullets: z.array(z.string()),
  model: z.string(),
});
export type NarrativeBlock = z.infer<typeof NarrativeBlock>;

/** The narrative envelope added to every briefing response from the narrative routes.
 *  When `degraded` is true, `narrative` is null and the PDF/UI fall back gracefully. */
export const NarrativeEnvelope = z.object({
  narrative: NarrativeBlock.nullable(),
  degraded: z.boolean(),
});
export type NarrativeEnvelope = z.infer<typeof NarrativeEnvelope>;

/** PropertyBriefingModel extended with the narrative envelope (Step 9 route output). */
export const NarrativePropertyBriefingModel = PropertyBriefingModel.merge(NarrativeEnvelope);
export type NarrativePropertyBriefingModel = z.infer<typeof NarrativePropertyBriefingModel>;

/** ManagerBriefingModel extended with the narrative envelope (Step 9 route output). */
export const NarrativeManagerBriefingModel = ManagerBriefingModel.merge(NarrativeEnvelope);
export type NarrativeManagerBriefingModel = z.infer<typeof NarrativeManagerBriefingModel>;
