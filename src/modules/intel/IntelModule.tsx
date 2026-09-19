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
import { useEffect, useMemo, useRef, useState } from 'react';
import { Database } from 'lucide-react';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { Tabs, TabPanel } from '@/primitives/Tabs';
import { useTabParam } from '@/lib/useTabParam';
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

const TAB_KEYS: readonly Tab[] = ['ownership', 'property', 'lease-run', 'benchmarks', 'managers', 'imports', 'quality', 'mappings'];

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
  // tab and is a shareable deep link, distinct from the global `/portfolio/:id` drawer. The tab
  // itself also lives in the URL via `?tab=` (IA decongestion Phase 1) — the two params compose
  // (`/intel/:propertyId?tab=...`). `defaultInitialTabRef` locks in, at mount only, whether this
  // load landed on a deep link: that becomes the `?tab=` fallback default forever after, so (a)
  // a deep-linked property tab shows immediately with no flash of Ownership, and (b) if the
  // property id later clears (e.g. closing back to bare /intel) an implicit (never explicitly
  // chosen) Property tab does NOT auto-revert to Ownership — matching the pre-Phase-1 local
  // useState behavior, which never reset `tab` on id-clear either.
  const ui = useUi();
  const defaultInitialTabRef = useRef<Tab>(ui.intelPropertyId ? 'property' : 'ownership');
  const [tab, setTab] = useTabParam<Tab>(TAB_KEYS, defaultInitialTabRef.current);
  // Ownership → Property navigation: push the property to the URL (shareable), which focuses the
  // Property tab via the explicit call below (and the effect, for links that bypass this fn).
  const openProperty = (id: string) => {
    ui.openIntelProperty(id);
    setTab('property');
  };
  // A deep link or any chip/tile/row click that changes the URL property lands on the Property tab.
  useEffect(() => {
    if (ui.intelPropertyId) setTab('property');
    // eslint-disable-next-line react-hooks/exhaustive-deps -- fires only on propertyId change, matching pre-Phase-1 behavior
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
            !live && (
              <Badge tone="neutral">
                {`Computed from snapshot${freshness.detail ? ` · ${freshness.detail}` : ''}`}
              </Badge>
            )
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
      ) : (
        // keyboardActivation="manual" — every tab here except Ownership mounts a view that fires
        // its own fresh warehouse/analytics query on mount (PropertyIntelView, LeaseRunView,
        // BenchmarksView, ManagersView, Imports/DataQuality/Mappings), so arrowing through the
        // strip shouldn't fan out queries (plan R9).
        <Tabs tabs={TABS} selectedKey={tab} onSelectionChange={(k) => setTab(k as Tab)} keyboardActivation="manual" aria-label="Property Financial Intelligence views">
          <TabPanel id="ownership">
            <OwnershipView onOpenProperty={openProperty} period={effectivePeriod} periodLabel={periodLabel} />
          </TabPanel>
          <TabPanel id="property">
            <PropertyIntelView
              propertyId={ui.intelPropertyId}
              onSelectProperty={ui.openIntelProperty}
              period={effectivePeriod}
              periodLabel={periodLabel}
            />
          </TabPanel>
          <TabPanel id="lease-run">
            <LeaseRunView propertyId={ui.intelPropertyId} />
          </TabPanel>
          <TabPanel id="benchmarks">
            <BenchmarksView onOpenProperty={openProperty} period={effectivePeriod} periodLabel={periodLabel} />
          </TabPanel>
          <TabPanel id="managers">
            <ManagersView />
          </TabPanel>
          <TabPanel id="imports">
            <ImportsView imports={imports.data ?? []} />
          </TabPanel>
          <TabPanel id="quality">
            <DataQualityView issues={issues.data ?? []} />
          </TabPanel>
          <TabPanel id="mappings">
            <MappingsView imports={imports.data ?? []} />
          </TabPanel>
        </Tabs>
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
  const warehouseProv = { source: 'Warehouse · committed imports', confidence: 'derived' as const, ...(latestPeriod ? { asOf: latestPeriod } : {}) };
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <KpiStat label="Committed Imports" value={committed} format={(n) => (n === null ? '—' : String(Math.round(n)))} accentColor="var(--color-pos)" sublabel={pending > 0 ? `${pending} pending review` : undefined} prov={warehouseProv} />
      <KpiStat label="Open DQ Issues" value={openIssues} format={(n) => (n === null ? '—' : String(Math.round(n)))} accentColor={openIssues > 0 ? 'var(--color-warn)' : 'var(--color-pos)'} prov={warehouseProv} />
      <KpiStat label="Properties Covered" value={propertiesCovered} format={(n) => (n === null ? '—' : String(Math.round(n)))} accentColor="var(--color-info)" prov={warehouseProv} />
      <KpiStat label="Latest Period" value={latestPeriod ? 1 : null} format={() => latestPeriod ?? '—'} accentColor="var(--accent)" prov={warehouseProv} />
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
