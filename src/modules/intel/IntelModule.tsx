// src/modules/intel/IntelModule.tsx
//
// Property Financial Intelligence — the warehouse front door. Seven internal tabs in two
// groups, the intelligence layer first, the data-ops layer (a subtle divider apart) last:
//   INTELLIGENCE
//     Ownership   · the DEFAULT home — Ownership Intelligence Center: action list +
//                   attention matrix + capital allocation + risks + PM snapshot (OwnershipView)
//     Property    · per-property verdict → root cause → recommendation (PropertyIntelView)
//     Benchmarks  · period/metric cohort, rankings + quartiles + NOI-by-property matrix (BenchmarksView)
//     Managers    · PM scorecards with the small-sample caveat (ManagersView)
//   DATA-OPS
//     Imports     · audit trail + approve/reject review queue (ImportsView)
//     Data Quality· open data-quality issues + resolution (DataQualityView)
//     Mappings    · manual override surface (MappingsView)
// The selected property is lifted here so it persists across tab switches and so an
// Ownership action / attention-matrix row / Benchmarks ranking row click can switch to the
// Property tab focused on that id. The portfolio data-ops KpiRow band shows ONLY on the
// data-ops tabs; each intelligence tab carries its own KPI band. The legacy standalone
// 'overview' NOI matrix now lives inside Benchmarks.
// On the static mirror the /api/warehouse routes are absent, so the hooks surface
// `isUnavailable` and the whole module degrades to one informational Card.
import { useEffect, useMemo, useState } from 'react';
import { Database } from 'lucide-react';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { cn } from '@/lib/cn';
import { useUi } from '@/brain/ui-context';
import {
  useWarehouseImports,
  useWarehouseIssues,
  useNoiMatrix,
  isWarehouseUnavailable,
  useWarehouseLive,
  useWarehouseFreshness,
  type NoiMatrixCell,
} from './hooks';
import { useMetrics } from './analytics-hooks';
import { availablePeriods, defaultPeriod, isYtdPeriod } from './period-intel';
import { ImportsView } from './ImportsView';
import { DataQualityView } from './DataQualityView';
import { MappingsView } from './MappingsView';
import { PropertyIntelView } from './PropertyIntelView';
import { OwnershipView } from './OwnershipView';
import { BenchmarksView } from './BenchmarksView';
import { ManagersView } from './ManagersView';
import { LeaseRunView } from './LeaseRunView';

// Final IA (PFI Phase B.2): intelligence tabs first, then a subtle divider, then data-ops.
// `group` drives the divider in the tab strip and the KpiRow gating below.
type Tab = 'ownership' | 'property' | 'lease-run' | 'benchmarks' | 'managers' | 'imports' | 'quality' | 'mappings';
type TabGroup = 'intelligence' | 'data-ops';

const TABS: Array<{ id: Tab; label: string; group: TabGroup }> = [
  { id: 'ownership', label: 'Ownership', group: 'intelligence' },
  { id: 'property', label: 'Property', group: 'intelligence' },
  { id: 'lease-run', label: 'Lease Run', group: 'intelligence' },
  { id: 'benchmarks', label: 'Benchmarks', group: 'intelligence' },
  { id: 'managers', label: 'Managers', group: 'intelligence' },
  { id: 'imports', label: 'Imports', group: 'data-ops' },
  { id: 'quality', label: 'Data Quality', group: 'data-ops' },
  { id: 'mappings', label: 'Mappings', group: 'data-ops' },
];

/** The data-ops tabs carry the portfolio data-ops KpiRow band; the intelligence tabs have
 *  their own KPI bands and suppress it. */
const DATA_OPS_TABS: ReadonlySet<Tab> = new Set<Tab>(['imports', 'quality', 'mappings']);

export function IntelModule() {
  // Selection is URL-driven (PFI Phase B.3 item 5): `/intel/:propertyId` focuses the Property
  // tab and is a shareable deep link, distinct from the global `/portfolio/:id` drawer.
  const ui = useUi();
  const [tab, setTab] = useState<Tab>(ui.intelPropertyId ? 'property' : 'ownership');
  // Ownership → Property navigation: push the property to the URL (shareable), which focuses the
  // Property tab via the effect below.
  const openProperty = (id: string) => {
    ui.openIntelProperty(id);
    setTab('property');
  };
  // A deep link or any chip/tile/row click that changes the URL property lands on the Property tab.
  useEffect(() => {
    if (ui.intelPropertyId) setTab('property');
  }, [ui.intelPropertyId]);
  const imports = useWarehouseImports();
  const issues = useWarehouseIssues();
  const noi = useNoiMatrix();
  // Metrics also feed the module-level time control (PFI Phase B.3 item 3). The same query is
  // shared (deduped) with the intelligence views, so this adds no extra fetch.
  const metrics = useMetrics();
  // Live workstation vs. baked mirror — drives the honest freshness badge (never "Live") and the
  // read-only write-hiding in the data-ops views (Phase 1b).
  const live = useWarehouseLive();
  const freshness = useWarehouseFreshness();

  // Module-level period selection: the control governs which period's LEVELS/benchmarks the
  // intelligence tabs show; scores stay on the latest full year regardless. Default = latest FY.
  const [selectedPeriod, setSelectedPeriod] = useState<string | null>(null);
  const periodOptions = useMemo(() => availablePeriods(metrics.data ?? []), [metrics.data]);
  const effectivePeriod =
    selectedPeriod && periodOptions.some((o) => o.period === selectedPeriod)
      ? selectedPeriod
      : defaultPeriod(periodOptions);
  const periodLabel = periodOptions.find((o) => o.period === effectivePeriod)?.label ?? null;
  const showYtdBanner = isYtdPeriod(periodOptions, effectivePeriod);

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
              {!live && (
                <Badge tone="neutral">
                  {`Computed from snapshot${freshness.detail ? ` · ${freshness.detail}` : ''}`}
                </Badge>
              )}
              {TABS.map((t, i) => {
                // A subtle divider before the first data-ops tab separates the intelligence
                // layer from the data-warehouse layer (IA clarity; tokens only).
                const prev = TABS[i - 1];
                const startsDataOps = t.group === 'data-ops' && prev?.group === 'intelligence';
                return (
                  <span key={t.id} className="flex items-center gap-1.5">
                    {startsDataOps && (
                      <span
                        aria-hidden
                        className="mx-1 h-3.5 w-px"
                        style={{ background: 'var(--border-strong)', opacity: 0.6 }}
                      />
                    )}
                    <button
                      onClick={() => setTab(t.id)}
                      className={cn(
                        'num rounded-full px-2.5 py-0.5 text-2xs font-semibold uppercase transition-colors',
                        tab === t.id ? 'cursor-default' : 'cursor-pointer',
                      )}
                      style={
                        tab === t.id
                          ? { background: 'color-mix(in oklab, var(--accent) 16%, transparent)', color: 'var(--accent)', border: '1px solid color-mix(in oklab, var(--accent) 45%, transparent)', letterSpacing: '0.06em' }
                          : {
                              background: 'transparent',
                              color: 'var(--text-tertiary)',
                              border: '1px solid transparent',
                              letterSpacing: '0.06em',
                              // The data-ops tabs read one notch quieter than the intelligence
                              // tabs so the intelligence layer leads visually.
                              opacity: t.group === 'data-ops' ? 0.82 : 1,
                            }
                      }
                    >
                      {t.label}
                    </button>
                  </span>
                );
              })}
            </div>
          }
        />
        {/* The portfolio data-ops KPI band anchors the data-warehouse tabs only; each
            intelligence tab (Ownership / Property / Benchmarks / Managers) carries its own
            KPI band, so suppress this row there. */}
        {DATA_OPS_TABS.has(tab) && (
          <div className="px-4 py-3">
            <KpiRow
              committed={(imports.data ?? []).filter((i) => i.status === 'committed').length}
              pending={(imports.data ?? []).filter((i) => i.status === 'pending-review').length}
              openIssues={issues.data?.length ?? 0}
              propertiesCovered={new Set((noi.data ?? []).map((c) => c.propertyId)).size}
              latestPeriod={latestPeriod(noi.data ?? [])}
            />
          </div>
        )}
        {/* Time as a first-class control (PFI Phase B.3 item 3): the intelligence tabs share one
            period selector; a persistent banner keeps the YTD-partial caveat ambient. */}
        {!DATA_OPS_TABS.has(tab) && periodOptions.length > 0 && (
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
            <label className="flex items-center gap-2">
              <span className="num text-2xs font-semibold uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>
                Period
              </span>
              <select
                value={effectivePeriod ?? ''}
                onChange={(e) => setSelectedPeriod(e.target.value)}
                className="num rounded-md px-2.5 py-1 text-xs"
                style={{ background: 'var(--surface-raised)', color: 'var(--text-primary)', border: '1px solid var(--border-strong)' }}
              >
                {periodOptions.map((o) => (
                  <option key={o.period} value={o.period}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            {showYtdBanner && (
              <span className="flex items-center gap-2">
                <Badge tone="amber" dot>
                  YTD (partial)
                </Badge>
                <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>
                  Partial-year levels — scores remain on the latest full year.
                </span>
              </span>
            )}
          </div>
        )}
      </Card>

      {loading ? (
        <div className="grid grid-cols-1 gap-3">
          <Skeleton style={{ height: 220 }} />
        </div>
      ) : tab === 'ownership' ? (
        <OwnershipView onOpenProperty={openProperty} period={effectivePeriod} periodLabel={periodLabel} />
      ) : tab === 'property' ? (
        <PropertyIntelView
          propertyId={ui.intelPropertyId}
          onSelectProperty={ui.openIntelProperty}
          period={effectivePeriod}
          periodLabel={periodLabel}
        />
      ) : tab === 'lease-run' ? (
        <LeaseRunView propertyId={ui.intelPropertyId} />
      ) : tab === 'benchmarks' ? (
        <BenchmarksView onOpenProperty={openProperty} period={effectivePeriod} periodLabel={periodLabel} />
      ) : tab === 'managers' ? (
        <ManagersView />
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

/** The maximum period label across the matrix (string-sortable: YYYY / YYYY-MM). */
function latestPeriod(matrix: NoiMatrixCell[]): string | null {
  let max: string | null = null;
  for (const c of matrix) {
    if (max === null || c.period.localeCompare(max) > 0) max = c.period;
  }
  return max;
}
