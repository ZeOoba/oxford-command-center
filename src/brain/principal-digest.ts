import type { PortfolioSnapshot } from '@contracts/index';
import type { MergedInsight } from '@/modules/insights/insights.logic';
import { sortByImpactDesc } from '@/modules/insights/insights.logic';

export interface DigestItem {
  id: string;
  kind: 'insight' | 'deal';
  rank: number; // 0 critical, 1 warning, 2 deal — sort key
  title: string;
  detail: string;
}

const ATTENTION_STAGES = new Set(['LOI/PSA', 'Closing']);

/**
 * Items needing a principal's eye: critical/warning items from the SAME merged insight set the
 * Insights board renders (`mergeInsightSources()` output — Spine-A insights + warehouse
 * candidates, with superseded Spine-A duplicates already dropped) + deals in LOI/PSA or Closing.
 *
 * Ratified "one home per attention list" (2026-09-23 review, gap #1): the Digest is a COUNT
 * SUMMARY of the Insights board, so its Critical/Review counts must equal what a click through
 * "Open Insights →" actually shows. Before this fix the Digest instead counted raw
 * `analytics.insights` (never deduped against a richer warehouse candidate) plus bridged
 * warehouse anomalies — a number the board itself never displayed, so the two surfaces disagreed.
 *
 * Warehouse anomalies are deliberately EXCLUDED from `merged` here: the Insights board doesn't
 * show them either (`mergeInsightSources` never includes them), so folding them into this count
 * would reintroduce the same drift. They get their own labelled line on the Principal Home
 * (PrincipalModule) that links to Worklist › Alerts, where `useAlertView` already bridges them in.
 *
 * Ordering (review follow-up): critical/warning items are sorted by `sortByImpactDesc` — the
 * SAME sort `buildTiers()` applies to the board's Critical/Priority tiers — so the Digest's top-3
 * (digestSummary's `top`) is never a different top-3 than the board's Critical tier shows.
 */
export function principalDigest(
  snapshot: PortfolioSnapshot,
  merged: ReadonlyArray<MergedInsight>,
): DigestItem[] {
  const items: DigestItem[] = [];

  const critical = sortByImpactDesc(merged.filter((m) => m.severity === 'critical'));
  const warning = sortByImpactDesc(merged.filter((m) => m.severity === 'warning'));
  for (const m of [...critical, ...warning]) {
    items.push({ id: m.id, kind: 'insight', rank: m.severity === 'critical' ? 0 : 1, title: m.title, detail: m.detail });
  }
  for (const d of snapshot.deals) {
    if (ATTENTION_STAGES.has(d.stage)) {
      items.push({ id: `deal-${d.id}`, kind: 'deal', rank: 2, title: d.shortName ?? d.name, detail: `${d.stage}${d.nextAction ? ` · ${d.nextAction}` : ''}` });
    }
  }
  return items.sort((a, b) => a.rank - b.rank);
}
