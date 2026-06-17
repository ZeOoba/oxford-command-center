import type { PortfolioSnapshot } from '@contracts/index';
import type { AnalyticsBundle } from '@analytics/index';
import type { Insight } from '@analytics/types';

export interface DigestItem {
  id: string;
  kind: 'insight' | 'deal';
  rank: number; // 0 critical, 1 warning, 2 deal — sort key
  title: string;
  detail: string;
}

const ATTENTION_STAGES = new Set(['LOI/PSA', 'Closing']);

/** Items needing a principal's eye: critical/warning insights + deals in LOI/PSA or Closing.
 *  `anomalyInsights` (strategic-audit Fix #1) carries the bridged warehouse anomalies so a
 *  warehouse-detected expense spike / NOI decline shows on the Principal Home, not just the Intel
 *  module. Defaulted to [] so snapshot-only callers (and the pure-function tests) are unaffected. */
export function principalDigest(
  snapshot: PortfolioSnapshot,
  analytics: AnalyticsBundle,
  anomalyInsights: ReadonlyArray<Insight> = [],
): DigestItem[] {
  const items: DigestItem[] = [];

  for (const i of [...analytics.insights, ...anomalyInsights]) {
    if (i.severity === 'critical' || i.severity === 'warning') {
      items.push({ id: i.id, kind: 'insight', rank: i.severity === 'critical' ? 0 : 1, title: i.title, detail: i.detail });
    }
  }
  for (const d of snapshot.deals) {
    if (ATTENTION_STAGES.has(d.stage)) {
      items.push({ id: `deal-${d.id}`, kind: 'deal', rank: 2, title: d.shortName ?? d.name, detail: `${d.stage}${d.nextAction ? ` · ${d.nextAction}` : ''}` });
    }
  }
  return items.sort((a, b) => a.rank - b.rank);
}
