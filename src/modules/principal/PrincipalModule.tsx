import { useMemo } from 'react';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { useSnapshot, useAnalytics } from '@/data/queries';
import { useAnomalies } from '@/modules/intel/analytics-hooks';
import { useWarehouseInsights } from '@/modules/insights/hooks';
import { mergeInsightSources } from '@/modules/insights/insights.logic';
import { useUi } from '@/brain/ui-context';
import { fmtNum } from '@analytics/index';
import { ModuleLoading } from '@/shell/ModuleFallback';
import { principalDigest } from '@/brain/principal-digest';
import { anomaliesToInsights } from '@/brain/anomaly-insights';
import { principalKpis } from './principal-kpis';
import { digestSummary } from './digest-summary';

export function PrincipalModule() {
  const { data } = useSnapshot();
  const { analytics } = useAnalytics();
  const ui = useUi();
  // Same merge the Insights board renders (InsightsModule/widgets.tsx) — Spine-A insights +
  // warehouse candidates, superseded Spine-A duplicates dropped — so the Digest's Critical/Review
  // counts equal what "Open Insights →" actually shows (2026-09-23 review, gap #1).
  const insightsQuery = useWarehouseInsights();
  const candidates = useMemo(() => insightsQuery.data?.candidates ?? [], [insightsQuery.data]);
  const merged = useMemo(
    () => (data && analytics ? mergeInsightSources(analytics.insights, candidates, data.snapshot).merged : []),
    [data, analytics, candidates],
  );

  // Warehouse anomalies get their OWN labelled line below, never folded into the merged set above
  // — the Insights board doesn't show them, so counting them here would reintroduce the same
  // count-vs-board drift the fix above removes. The query errors to [] on the static mirror /
  // offline, so this line just disappears there.
  const anomalies = useAnomalies();
  const anomalyInsights = useMemo(() => {
    const nameById = new Map<string, string>();
    for (const p of data?.snapshot.properties ?? []) nameById.set(p.id, p.name);
    return anomaliesToInsights(anomalies.data ?? [], nameById);
  }, [anomalies.data, data]);
  const anomalyAttentionCount = useMemo(
    () => anomalyInsights.filter((i) => i.severity === 'critical' || i.severity === 'warning').length,
    [anomalyInsights],
  );

  if (!data || !analytics) return <ModuleLoading />;

  const kpis = principalKpis(analytics);
  const digest = principalDigest(data.snapshot, merged);
  const summary = digestSummary(digest);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <KpiStat key={k.label} label={k.label} value={k.value} format={k.format} prov={k.prov} sublabel={k.sublabel} accentColor="var(--accent)" />
        ))}
      </div>

      <Card>
        <CardHeader title="Needs your attention" trailing={<Badge tone={digest.length ? 'amber' : 'green'}>{digest.length}</Badge>} />
        {digest.length === 0 ? (
          <div className="px-4 py-8 text-sm" style={{ color: 'var(--text-tertiary)' }}>Nothing needs a decision right now.</div>
        ) : (
          <div className="flex flex-col gap-3 p-4">
            <div className="grid grid-cols-3 gap-3">
              <KpiStat label="Critical" value={summary.critical} format={fmtNum} accentColor="var(--color-neg)" />
              <KpiStat label="Review" value={summary.review} format={fmtNum} accentColor="var(--color-warn)" />
              <KpiStat label="Deals" value={summary.deals} format={fmtNum} accentColor="var(--accent)" />
            </div>
            {summary.top.length > 0 && (
              <ul className="flex flex-col">
                {summary.top.map((item) => (
                  <li key={item.id} className="flex items-start justify-between gap-3 py-2.5 text-sm" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                    <span style={{ color: 'var(--text-secondary)' }}><strong style={{ color: 'var(--text-primary)' }}>{item.title}</strong> — {item.detail}</span>
                    <Badge tone="red">critical</Badge>
                  </li>
                ))}
              </ul>
            )}
            <button
              type="button"
              onClick={() => ui.openTab('command-brain', 'insights')}
              className="self-end text-2xs font-semibold"
              style={{ color: 'var(--accent)' }}
            >
              Open Insights →
            </button>
          </div>
        )}
        {anomalyAttentionCount > 0 && (
          <div
            className="flex items-center justify-between gap-3 px-4 py-2.5 text-2xs"
            style={{ borderTop: '1px solid var(--border-subtle)', color: 'var(--text-tertiary)' }}
          >
            <span>
              {anomalyAttentionCount} ledger anomal{anomalyAttentionCount === 1 ? 'y' : 'ies'} flagged (tracked in Worklist › Alerts)
            </span>
            <button
              type="button"
              onClick={() => ui.openTab('worklist', 'alerts')}
              className="font-semibold"
              style={{ color: 'var(--accent)' }}
            >
              Worklist › Alerts →
            </button>
          </div>
        )}
      </Card>
    </div>
  );
}
