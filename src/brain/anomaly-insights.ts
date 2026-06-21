// src/brain/anomaly-insights.ts
//
// The anomaly-to-alert bridge (strategic-audit Fix #1). The warehouse (Spine B) detects
// per-property anomalies — expense spikes, NOI/revenue declines, new cost categories — via
// detectAnomalies() in server/warehouse/anomalies.ts. Those flags surface in the Intel module's
// Ownership/Property views but never crossed into the alert pipeline (evaluateConditions, which is
// pure over the Spine A snapshot and has no warehouse data). A 40% utility spike fired in the
// engine and was invisible on the Principal Home and the Alerts inbox.
//
// This pure converter is the bridge: AnomalyFlag[] (warehouse) → Insight[] (alert pipeline). The
// two warehouse-aware consumers (useAlertView, PrincipalModule) fetch anomalies via the existing
// /api/warehouse/analytics/anomalies hook and merge the converted insights with the snapshot-derived
// conditions. evaluateConditions stays snapshot-pure — the merge happens at the consumption layer,
// matching how the rest of the warehouse data is wired into the UI.
import type { AnomalyFlag, AnomalyKind } from '@contracts/warehouse';
import type { Insight, InsightSeverity } from '@analytics/types';

/** Anomaly severity → alert severity. 'low' is intentionally absent — low-severity anomalies are
 *  noise in an actionable alert inbox; they remain visible in the Intel module's per-property view. */
const SEVERITY_MAP: Partial<Record<AnomalyFlag['severity'], InsightSeverity>> = {
  critical: 'critical',
  high: 'warning',
  moderate: 'info',
};

/** Human-readable label per anomaly kind (the title prefix before the property name). */
const KIND_LABEL: Record<AnomalyKind, string> = {
  'expense-growth': 'Expense growth',
  'revenue-decline': 'Revenue decline',
  'noi-decline': 'NOI decline',
  'noi-per-sf-decline': 'NOI/SF decline',
  'new-category': 'New expense category',
  'category-spike': 'Expense spike',
};

/** Turn a property slug into a readable title fragment: '9050-red-branch-rd' → '9050 Red Branch Rd'. */
function humanizeSlug(slug: string): string {
  return slug
    .split('-')
    .map((w) => (w.length > 0 ? w[0]!.toUpperCase() + w.slice(1) : w))
    .join(' ');
}

/**
 * Pure bridge: convert warehouse anomaly flags into alert-pipeline insights.
 * `nameById` (optional) resolves a property slug to its friendly name from the snapshot; absent it,
 * the slug is humanized. Low-severity anomalies are dropped.
 */
export function anomaliesToInsights(
  anomalies: ReadonlyArray<AnomalyFlag>,
  nameById?: ReadonlyMap<string, string>,
): Insight[] {
  const out: Insight[] = [];
  for (const a of anomalies) {
    const severity = SEVERITY_MAP[a.severity];
    if (severity === undefined) continue; // low-severity → dropped
    const name = nameById?.get(a.propertyId) ?? humanizeSlug(a.propertyId);
    out.push({
      // The subkey (spiking/new category for category-spike/new-category; '' otherwise) is part of
      // the id so two co-occurring same-kind anomalies on one property+period get DISTINCT ids —
      // otherwise they share read/snooze state and one silently buries the other (refute F1). The id
      // is opaque (a state/React key, never parsed), so the raw category is safe and guarantees
      // uniqueness; subkey='' keeps the property-level kinds' ids byte-for-byte state-stable.
      id: `anomaly-${a.propertyId}-${a.period}-${a.kind}${a.subkey ? `-${a.subkey}` : ''}`,
      severity,
      category: 'anomaly',
      title: `${KIND_LABEL[a.kind]} — ${name}`,
      detail: `${a.detail} · ${a.period}`,
      entityType: 'property',
      entityId: a.propertyId,
      impactAnnualUsd: null,
      spine: 'B',
      provenance: 'absent',
    });
  }
  return out;
}
