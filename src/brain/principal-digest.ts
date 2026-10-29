import type { PortfolioSnapshot } from '@contracts/index';
import type { MergedInsight } from '@/modules/insights/insights.logic';
import { buildTiers } from '@/modules/insights/insights.logic';
import { signalCount } from '@/lib/tier-group';

export interface DigestItem {
  id: string;
  kind: 'insight' | 'deal';
  rank: number; // 0 critical, 1 warning, 2 deal — sort key
  title: string;
  detail: string;
  /** Underlying signals this row stands for (a rolled-up board row stands for all its members).
   *  Absent = 1. The Critical/Review counts sum this, so grouping never changes a KPI. */
  signals?: number;
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
 * Ordering: the Digest's critical/warning rows ARE `buildTiers()`'s Critical/Priority rows — the
 * same grouped, pinned-first order the board renders — so the Digest's top-3 (digestSummary's
 * `top`) is by construction the board's top-3, and the counts (summed `signals`) are the board's
 * signal totals. Deriving from the board, rather than re-sorting, is what keeps the two from
 * drifting when the board's grouping or pinning rules change (refute wf_75f08f8a-621).
 */
export function principalDigest(
  snapshot: PortfolioSnapshot,
  merged: ReadonlyArray<MergedInsight>,
): DigestItem[] {
  const items: DigestItem[] = [];

  const tiers = buildTiers([...merged]);
  for (const [key, rank] of [['critical', 0], ['priority', 1]] as const) {
    for (const row of tiers.find((t) => t.key === key)?.items ?? []) {
      items.push({ id: row.id, kind: 'insight', rank, title: row.title, detail: row.detail ?? '', signals: signalCount(row) });
    }
  }
  for (const d of snapshot.deals) {
    if (ATTENTION_STAGES.has(d.stage)) {
      items.push({ id: `deal-${d.id}`, kind: 'deal', rank: 2, title: d.shortName ?? d.name, detail: `${d.stage}${d.nextAction ? ` · ${d.nextAction}` : ''}` });
    }
  }
  return items.sort((a, b) => a.rank - b.rank);
}
