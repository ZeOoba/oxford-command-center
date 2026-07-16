import { useMemo } from 'react';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { useSnapshot, useAnalytics } from '@/data/queries';
import { useAnomalies } from '@/modules/intel/analytics-hooks';
import { ModuleLoading } from '@/shell/ModuleFallback';
import { principalDigest } from '@/brain/principal-digest';
import { anomaliesToInsights } from '@/brain/anomaly-insights';
import { principalKpis } from './principal-kpis';

export function PrincipalModule() {
  const { data } = useSnapshot();
  const { analytics } = useAnalytics();
  // Fix #1: bridge warehouse anomalies into the attention digest. The query errors to [] on the
  // static mirror / offline, so the digest degrades to snapshot conditions there.
  const anomalies = useAnomalies();
  const anomalyInsights = useMemo(() => {
    const nameById = new Map<string, string>();
    for (const p of data?.snapshot.properties ?? []) nameById.set(p.id, p.name);
    return anomaliesToInsights(anomalies.data ?? [], nameById);
  }, [anomalies.data, data]);
  if (!data || !analytics) return <ModuleLoading />;

  const kpis = principalKpis(analytics);
  const digest = principalDigest(data.snapshot, analytics, anomalyInsights);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
        {kpis.map((k) => (
          <KpiStat key={k.label} label={k.label} value={k.value} format={k.format} prov={k.prov} accentColor="var(--accent)" />
        ))}
      </div>

      <Card>
        <CardHeader title="Needs your attention" trailing={<Badge tone={digest.length ? 'amber' : 'green'}>{digest.length}</Badge>} />
        {digest.length === 0 ? (
          <div className="px-4 py-8 text-sm" style={{ color: 'var(--text-tertiary)' }}>Nothing needs a decision right now.</div>
        ) : (
          <ul className="flex flex-col">
            {digest.map((item) => (
              <li key={item.id} className="flex items-start justify-between gap-3 px-4 py-2.5 text-sm" style={{ borderTop: '1px solid var(--border-subtle)' }}>
                <span style={{ color: 'var(--text-secondary)' }}><strong style={{ color: 'var(--text-primary)' }}>{item.title}</strong> — {item.detail}</span>
                <Badge tone={item.kind === 'insight' ? (item.rank === 0 ? 'red' : 'amber') : 'neutral'}>{item.kind === 'deal' ? 'deal' : item.rank === 0 ? 'critical' : 'review'}</Badge>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}
