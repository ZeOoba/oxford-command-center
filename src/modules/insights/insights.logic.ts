// src/modules/insights/insights.logic.ts
//
// Pure, unit-testable functions backing the Insights module. No React here — the component
// (InsightsModule.tsx) only calls into these functions and renders their output.
//
// This module reconciles TWO independently-produced insight surfaces:
//   - Spine-A `Insight` (src/analytics/types.ts) — derived live from the PortfolioSnapshot
//     by src/analytics/conditions.ts. Carries entityType/entityId, no propertyId directly.
//   - Warehouse `InsightCandidate` (src/contracts/insights.ts) — the Phase 3 Insight Engine's
//     ranked output from GET /api/warehouse/insights. Carries propertyId directly (nullable)
//     plus generator provenance (attribution, confidence, family).
//
// Both surfaces can describe the SAME underlying signal (e.g. a below-market cap rate on a
// property may eventually be flagged by both a Spine-A condition and a warehouse generator).
// mergeInsightSources() reconciles that overlap; buildTiers()/buildSummary() present the
// reconciled set. See the basis-mixing doctrine in CLAUDE.md §1 — Spine A and Spine B dollar
// figures are NEVER silently combined into one number anywhere in this file.
import type { Insight, InsightSeverity } from '@analytics/types';
import type { InsightCandidate, InsightFamily } from '@contracts/insights';
import type { PortfolioSnapshot } from '@contracts/index';
import type { BadgeTone } from '@/primitives/Badge';
import type { Tier, TierItem, TierTotal } from '@/primitives/TierBoard';
import { spineLabel } from '@/lib/spine-label';

// ── Merged shape ──────────────────────────────────────────────────────────────────────────

export type MergedSpine = 'A' | 'B' | 'cross';

export interface MergedInsight {
  id: string;
  spine: MergedSpine;
  propertyId: string | null;
  title: string;
  detail: string;
  impactUsd: number | null;
  severity: InsightSeverity;
  category: string;
  advisoryOnly: boolean;
  confidence?: number;
}

export interface MergeResult {
  merged: MergedInsight[];
  /** Count of Spine-A insights dropped because a warehouse candidate produced the same
   *  dedup key (richer provenance wins). Never silently lost — always surfaced here. */
  supersededCount: number;
}

export interface CategoryCount {
  category: string;
  count: number;
}

export interface InsightsSummary {
  /** Sum of impactUsd for 'critical' + 'warning' severity items — downside/exposure framing. */
  riskImpactBySpine: TierTotal[];
  /** Sum of impactUsd for 'info' severity items — monitoring/context framing, not risk. */
  monitorImpactBySpine: TierTotal[];
  count: number;
}

// ── Category (Spine A) <-> Family (Spine B/candidate) correspondence table ─────────────────
//
// InsightCandidate.family is one of CF/DR/TE/TR/CR (src/contracts/insights.ts). Spine-A
// `Insight.category` is a free-form domain string (debt/lease/insurance/concentration/
// occupancy/cash/deal/data/anomaly/collections/capex). This table exists ONLY to let the dedup key
// (below) compare a Spine-A insight against a warehouse candidate on a common vocabulary — it
// is NEVER used to relabel or filter what the UI displays (MergedInsight.category always keeps
// each source's own native value: the raw Insight.category string for Spine-A-derived rows, the
// candidate's own `family` code for candidate-derived rows).
//
// Reasoning per category (this module's own judgment — not part of any wire contract):
//   debt          -> CF  capital-structure decisions (refi, balloon, leverage) are capital actions
//   deal          -> CF  acquisition/disposition signals are the clearest capital-allocation case
//   concentration -> CR  direct semantic match (concentration risk)
//   lease         -> TE  lease terms/renewals are tenant-initiated/tenant-facing actions
//   occupancy     -> TE  vacancy/occupancy shifts are driven by tenant move-in/move-out
//   collections   -> TE  AR aging/arrears reflect a tenant's payment behavior
//   insurance     -> DR  premium moves track external insurance-market repricing cycles
//   cash          -> DR  liquidity/treasury position read as a trailing data-driven trend
//   anomaly       -> DR  statistical anomaly detection is definitionally a data-driven signal
//   data          -> DR  data-quality flags are, by definition, about the data itself
//   capex         -> CF  PCA reserve / warranty signals drive capital-spend timing (a capital action)
// No Spine-A category maps to TR (track-record signals) today — Spine-A `Insight` objects are
// point-in-time snapshots, not the trailing multi-period trend the TR family is defined for.
// That's fine: the join spec only requires the table be consistent, not exhaustive over family.
export const CATEGORY_TO_FAMILY: Record<Insight['category'], InsightFamily> = {
  debt: 'CF',
  deal: 'CF',
  concentration: 'CR',
  lease: 'TE',
  occupancy: 'TE',
  collections: 'TE',
  insurance: 'DR',
  cash: 'DR',
  anomaly: 'DR',
  data: 'DR',
  capex: 'CF',
};

// ── Category -> badge tone (severity/status color-coding, threaded through TierBoard) ───────
const CATEGORY_TONE: Record<Insight['category'], BadgeTone> = {
  debt: 'red',
  deal: 'blue',
  concentration: 'amber',
  lease: 'green',
  occupancy: 'green',
  collections: 'amber',
  insurance: 'blue',
  cash: 'green',
  anomaly: 'red',
  data: 'neutral',
  capex: 'amber',
};

export function categoryTone(category: Insight['category']): BadgeTone {
  return CATEGORY_TONE[category];
}

// ── Join spec: resolve a Spine-A insight's entity reference to a propertyId ─────────────────

/**
 * Map a Spine-A Insight's entityType/entityId to a resolved propertyId, per the join spec:
 *   - entityType 'property' -> entityId IS the propertyId.
 *   - entityType 'loan'     -> look up snapshot.loans by id, use its collateralProperty.
 *   - entityType 'lease'    -> look up snapshot.leases by id, use its propertyId.
 *   - anything else (including no entityType at all, e.g. a portfolio-wide insight, or an
 *     entityType this join doesn't resolve like 'insurance'/'deal'/'cashEntity') -> null.
 */
export function resolveInsightPropertyId(insight: Insight, snapshot: PortfolioSnapshot): string | null {
  if (!insight.entityType || !insight.entityId) return null;
  switch (insight.entityType) {
    case 'property':
      return insight.entityId;
    case 'loan': {
      const loan = snapshot.loans.find((l) => l.id === insight.entityId);
      return loan?.collateralProperty ?? null;
    }
    case 'lease': {
      const lease = snapshot.leases.find((l) => l.id === insight.entityId);
      return lease?.propertyId ?? null;
    }
    default:
      return null;
  }
}

/** Dedup key: `${resolvedPropertyId ?? fallbackId}|${familyOrCategory}`. */
function dedupKey(propertyId: string | null, fallbackId: string, familyOrCategory: string): string {
  return `${propertyId ?? fallbackId}|${familyOrCategory}`;
}

// ── Candidate severity derivation ───────────────────────────────────────────────────────────
//
// InsightCandidateSchema carries no severity field — only `confidence` (0..1, the generator's
// self-assessed certainty) and `materialityUsd` (dollar magnitude, nullable). This heuristic is
// this module's own judgment (not part of the wire contract): a candidate reads as 'critical'
// only when the generator is BOTH highly confident (>=0.75) AND the signal is dollar-quantified
// (materialityUsd !== null) — an unquantified or lower-confidence signal cannot justify top-tier
// urgency. 'warning' covers moderate confidence (>=0.5). Everything else (low confidence, or a
// null-materiality qualitative signal) reads as 'info'.
export function candidateSeverity(candidate: InsightCandidate): InsightSeverity {
  if (candidate.confidence >= 0.75 && candidate.materialityUsd !== null) return 'critical';
  if (candidate.confidence >= 0.5) return 'warning';
  return 'info';
}

// ── mergeInsightSources ──────────────────────────────────────────────────────────────────────

export function mergeInsightSources(
  spineAInsights: Insight[],
  candidates: InsightCandidate[],
  snapshot: PortfolioSnapshot,
): MergeResult {
  const candidateMerged: MergedInsight[] = [];
  const candidateKeys = new Set<string>();

  for (const c of candidates) {
    candidateKeys.add(dedupKey(c.propertyId, c.id, c.family));
    candidateMerged.push({
      id: c.id,
      spine: c.spine,
      propertyId: c.propertyId,
      title: c.title,
      detail: c.discovery,
      impactUsd: c.materialityUsd,
      severity: candidateSeverity(c),
      category: c.family,
      advisoryOnly: c.advisoryOnly,
      confidence: c.confidence,
    });
  }

  let supersededCount = 0;
  const spineAMerged: MergedInsight[] = [];

  for (const insight of spineAInsights) {
    const propertyId = resolveInsightPropertyId(insight, snapshot);
    const family = CATEGORY_TO_FAMILY[insight.category];
    const fallbackId = insight.entityId ?? insight.id;
    const key = dedupKey(propertyId, fallbackId, family);

    if (candidateKeys.has(key)) {
      // A warehouse candidate already covers this property+family — it carries richer
      // provenance (generatorId, attribution.inputs, confidence). Drop the Spine-A duplicate
      // from output, but never silently: count it so callers/tests can assert it happened.
      supersededCount += 1;
      continue;
    }

    spineAMerged.push({
      id: insight.id,
      spine: insight.spine,
      propertyId,
      title: insight.title,
      detail: insight.detail,
      impactUsd: insight.impactAnnualUsd,
      severity: insight.severity,
      category: insight.category,
      // Insight (analytics/types.ts) carries no explicit advisoryOnly flag; the repo's doctrine
      // treats every Insight surfacing as advisory-only (AlertsModule/insightToDraft actions only
      // open drafts/entities — nothing auto-executes), so this is uniformly true.
      advisoryOnly: true,
    });
  }

  return { merged: [...spineAMerged, ...candidateMerged], supersededCount };
}

// ── buildTiers ────────────────────────────────────────────────────────────────────────────

const SEVERITY_TIERS: Array<{ severity: InsightSeverity; key: string; title: string; tone: Tier['tone'] }> = [
  { severity: 'critical', key: 'critical', title: 'Critical', tone: 'neg' },
  { severity: 'warning', key: 'priority', title: 'Priority', tone: 'warn' },
  { severity: 'info', key: 'monitor', title: 'Monitor', tone: 'info' },
];

/** Per-spine $ subtotal — NEVER a single combined sum (basis-mixing doctrine). */
export function totalsBySpine(items: MergedInsight[]): TierTotal[] {
  let spineA = 0;
  let spineBOrCross = 0;
  for (const m of items) {
    if (m.impactUsd === null) continue;
    if (m.spine === 'A') spineA += m.impactUsd;
    else spineBOrCross += m.impactUsd;
  }
  return [
    { label: 'Workbook basis', totalUsd: spineA },
    { label: 'Ledger & combined basis', totalUsd: spineBOrCross },
  ];
}

/** Exported so principalDigest (src/brain/principal-digest.ts) orders the Digest's critical/review
 *  items EXACTLY the way the Insights board orders its tiers — no re-implemented sort that could
 *  silently drift from this one. */
export function sortByImpactDesc(items: MergedInsight[]): MergedInsight[] {
  return [...items].sort((a, b) => {
    if (a.impactUsd === null && b.impactUsd === null) return 0;
    if (a.impactUsd === null) return 1; // nulls last
    if (b.impactUsd === null) return -1;
    return b.impactUsd - a.impactUsd;
  });
}

export function buildTiers(merged: MergedInsight[]): Tier[] {
  return SEVERITY_TIERS.map(({ severity, key, title, tone }) => {
    const sorted = sortByImpactDesc(merged.filter((m) => m.severity === severity));

    const items: TierItem[] = sorted.map((m, index) => ({
      id: m.id,
      rank: index + 1,
      category: m.category,
      // categoryTone drives the category badge's color in TierBoard. MergedInsight.category is a
      // loose `string`: Spine-A-derived rows carry one of the 10 real Insight categories, but
      // candidate-derived rows carry a warehouse FAMILY code (CF/DR/TE/TR/CR) that has no tone
      // mapping. Guard on CATEGORY_TO_FAMILY (keyed by exactly the 10 real categories) so we only
      // call categoryTone() for genuine categories; family-code rows stay undefined and TierBoard's
      // existing `?? 'neutral'` fallback applies unchanged (no crash, no wrong tone).
      categoryTone: m.category in CATEGORY_TO_FAMILY ? categoryTone(m.category as Insight['category']) : undefined,
      impactUsd: m.impactUsd,
      impactKind: severity === 'info' ? 'info' : 'risk',
      title: m.title,
      detail: m.detail,
      chips: [spineLabel(m.spine)],
    }));

    return {
      key,
      title,
      tone,
      items,
      totalsBySpine: totalsBySpine(sorted),
    };
  });
}

// ── buildCategoryCounts (for the filter pills) ──────────────────────────────────────────────

export function buildCategoryCounts(merged: MergedInsight[]): CategoryCount[] {
  const counts = new Map<string, number>();
  for (const m of merged) {
    counts.set(m.category, (counts.get(m.category) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => a.category.localeCompare(b.category));
}

// ── buildSummary (results banner) ───────────────────────────────────────────────────────────
//
// The banner shows total $ impact split by risk-framing (critical+warning) vs monitor-framing
// (info-only) — each split PER SPINE (never a blended Spine A + Spine B/cross number), plus a
// plain count. This mirrors the per-tier impactKind split in buildTiers (risk vs info) so the
// banner and the board never disagree about which items count as "risk".
export function buildSummary(merged: MergedInsight[]): InsightsSummary {
  const riskItems = merged.filter((m) => m.severity === 'critical' || m.severity === 'warning');
  const monitorItems = merged.filter((m) => m.severity === 'info');
  return {
    riskImpactBySpine: totalsBySpine(riskItems),
    monitorImpactBySpine: totalsBySpine(monitorItems),
    count: merged.length,
  };
}
