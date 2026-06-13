// src/modules/intel/IntelModule.tsx
//
// Property Financial Intelligence — the warehouse front door. Four internal tabs:
//   Overview  · KpiStat row + NOI-by-property matrix (periods as columns)
//   Imports   · audit trail + approve/reject review queue (ImportsView)
//   Quality   · open data-quality issues + resolution (DataQualityView)
//   Mappings  · manual override surface (MappingsView)
// On the static mirror the /api/warehouse routes are absent, so the hooks surface
// `isUnavailable` and the whole module degrades to one informational Card.
import { useMemo, useState } from 'react';
import { Database } from 'lucide-react';
import { fmtUsd } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { cn } from '@/lib/cn';
import {
  useWarehouseImports,
  useWarehouseIssues,
  useNoiMatrix,
  groupNoiByProperty,
  isWarehouseUnavailable,
  type NoiMatrixCell,
} from './hooks';
import { ImportsView } from './ImportsView';
import { DataQualityView } from './DataQualityView';
import { MappingsView } from './MappingsView';

type Tab = 'overview' | 'imports' | 'quality' | 'mappings';

const TABS: Array<{ id: Tab; label: string }> = [
  { id: 'overview', label: 'Overview' },
  { id: 'imports', label: 'Imports' },
  { id: 'quality', label: 'Data Quality' },
  { id: 'mappings', label: 'Mappings' },
];

export function IntelModule() {
  const [tab, setTab] = useState<Tab>('overview');
  const imports = useWarehouseImports();
  const issues = useWarehouseIssues();
  const noi = useNoiMatrix();

  // Any query reporting the unavailable sentinel means the warehouse routes are absent.
  const unavailable =
    isWarehouseUnavailable(imports.error) || isWarehouseUnavailable(noi.error) || isWarehouseUnavailable(issues.error);

  if (unavailable) {
    return (
      <Card>
        <CardHeader title="Property Financial Intelligence" trailing={<Badge tone="neutral">offline</Badge>} />
        <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
          <Database size={28} style={{ color: 'var(--text-tertiary)' }} />
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>Property financials require the live brain server.</div>
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 420 }}>
            The financial warehouse runs locally alongside the brain server. This deployed mirror is read-only and does not include it.
          </div>
        </div>
      </Card>
    );
  }

  const loading = imports.isLoading || noi.isLoading || issues.isLoading;

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Property Financial Intelligence"
          trailing={
            <div className="flex items-center gap-1.5">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={cn(
                    'num rounded-full px-2.5 py-0.5 text-2xs font-semibold uppercase transition-colors',
                    tab === t.id ? 'cursor-default' : 'cursor-pointer',
                  )}
                  style={
                    tab === t.id
                      ? { background: 'color-mix(in oklab, var(--accent) 16%, transparent)', color: 'var(--accent)', border: '1px solid color-mix(in oklab, var(--accent) 45%, transparent)', letterSpacing: '0.06em' }
                      : { background: 'transparent', color: 'var(--text-tertiary)', border: '1px solid transparent', letterSpacing: '0.06em' }
                  }
                >
                  {t.label}
                </button>
              ))}
            </div>
          }
        />
        <div className="px-4 py-3">
          <KpiRow
            committed={(imports.data ?? []).filter((i) => i.status === 'committed').length}
            pending={(imports.data ?? []).filter((i) => i.status === 'pending-review').length}
            openIssues={issues.data?.length ?? 0}
            propertiesCovered={new Set((noi.data ?? []).map((c) => c.propertyId)).size}
            latestPeriod={latestPeriod(noi.data ?? [])}
          />
        </div>
      </Card>

      {loading ? (
        <div className="grid grid-cols-1 gap-3">
          <Skeleton style={{ height: 220 }} />
        </div>
      ) : tab === 'overview' ? (
        <NoiMatrixTable matrix={noi.data ?? []} />
      ) : tab === 'imports' ? (
        <ImportsView imports={imports.data ?? []} />
      ) : tab === 'quality' ? (
        <DataQualityView issues={issues.data ?? []} />
      ) : (
        <MappingsView imports={imports.data ?? []} />
      )}
    </div>
  );
}

function KpiRow({ committed, pending, openIssues, propertiesCovered, latestPeriod }: {
  committed: number;
  pending: number;
  openIssues: number;
  propertiesCovered: number;
  latestPeriod: string | null;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <KpiStat label="Committed Imports" value={committed} format={(n) => (n === null ? '—' : String(Math.round(n)))} accentColor="var(--color-pos)" sublabel={pending > 0 ? `${pending} pending review` : undefined} />
      <KpiStat label="Open DQ Issues" value={openIssues} format={(n) => (n === null ? '—' : String(Math.round(n)))} accentColor={openIssues > 0 ? 'var(--color-warn)' : 'var(--color-pos)'} />
      <KpiStat label="Properties Covered" value={propertiesCovered} format={(n) => (n === null ? '—' : String(Math.round(n)))} accentColor="var(--color-info)" />
      <KpiStat label="Latest Period" value={latestPeriod ? 1 : null} format={() => latestPeriod ?? '—'} accentColor="var(--accent)" />
    </div>
  );
}

function NoiMatrixTable({ matrix }: { matrix: NoiMatrixCell[] }) {
  const { periods, rows } = useMemo(() => groupNoiByProperty(matrix), [matrix]);

  return (
    <Card>
      <CardHeader title="NOI by Property" trailing={<Badge tone="gold">{rows.length} properties</Badge>} />
      {rows.length === 0 ? (
        <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
          No committed financials yet. Run the warehouse backfill or approve a pending import.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full border-collapse" style={{ minWidth: 480 }}>
            <thead>
              <tr>
                <th className="px-3 py-2 text-left text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-strong)' }}>Property</th>
                {periods.map((p) => (
                  <th key={p} className="num px-3 py-2 text-right text-2xs font-semibold uppercase" style={{ letterSpacing: '0.08em', color: 'var(--text-tertiary)', borderBottom: '1px solid var(--border-strong)' }}>{p}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.propertyId} style={{ borderBottom: '1px solid var(--border-subtle)' }}>
                  <td className="px-3 py-2 text-sm" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{r.propertyName}</td>
                  {periods.map((p) => {
                    const v = r.byPeriod[p];
                    return (
                      <td key={p} className="num px-3 py-2 text-right text-xs" style={{ color: v === undefined ? 'var(--text-tertiary)' : 'var(--text-primary)' }}>
                        {v === undefined ? '—' : fmtUsd(v)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}

/** The maximum period label across the matrix (string-sortable: YYYY / YYYY-MM). */
function latestPeriod(matrix: NoiMatrixCell[]): string | null {
  let max: string | null = null;
  for (const c of matrix) {
    if (max === null || c.period.localeCompare(max) > 0) max = c.period;
  }
  return max;
}
