// src/modules/data/DataModule.tsx
//
// Data destination (IA decongestion Phase 4a) — the warehouse data-ops surface plus the two
// corpus/feedback surfaces that used to be separate rail items:
//   Imports · Quality · Mappings   (formerly the data-ops tabs inside Property Financials/IntelModule)
//   Calibration                    (formerly the /calibration rail item)
//   Documents                      (formerly the /documents rail item)
// The data-ops KPI band renders above the strip on the three warehouse tabs only (R2). Calibration
// and Documents own inner switches; they render as a SegmentedControl on `?view=` (R5 — no nested
// tab strips). On the static mirror the /api/warehouse routes are absent, so the three warehouse
// tabs degrade to one informational card each — Calibration/Documents keep their own fallbacks.
import { lazy, Suspense, type ReactNode } from 'react';
import { Database } from 'lucide-react';
import { Card, CardHeader } from '@/primitives/Card';
import { Badge } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { Tabs, TabPanel } from '@/primitives/Tabs';
import { useTabParam, CLEAR_VIEW } from '@/lib/useTabParam';
import { ModuleLoading } from '@/shell/ModuleFallback';
import { warnIfTooManyTabs } from '@/shell/tab-types';
import { useTabSpecs } from '@/shell/tab-badges';
import {
  useWarehouseImports,
  useWarehouseIssues,
  useNoiMatrix,
  isWarehouseUnavailable,
  useWarehouseLive,
  useWarehouseFreshness,
} from '../intel/hooks';
import { ImportsView } from '../intel/ImportsView';
import { DataQualityView } from '../intel/DataQualityView';
import { MappingsView } from '../intel/MappingsView';
import { DataOpsKpiRow } from './DataOpsKpiRow';
import { latestPeriod } from './latestPeriod';
import { DATA_TABS, DATA_TAB_KEYS, DATA_OPS_TABS, type DataTab } from './tabs';

const CalibrationModule = lazy(() => import('../calibration/CalibrationModule').then((m) => ({ default: m.CalibrationModule })));
const DocumentsModule = lazy(() => import('../documents/DocumentsModule').then((m) => ({ default: m.DocumentsModule })));

function WarehouseOfflineCard({ what }: { what: string }) {
  return (
    <Card>
      <CardHeader title={what} trailing={<Badge tone="neutral">offline</Badge>} />
      <div className="flex flex-col items-center gap-2 px-4 py-12 text-center">
        <Database size={28} style={{ color: 'var(--text-tertiary)' }} />
        <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>{what} requires the live brain server.</div>
        <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 420 }}>
          The financial warehouse runs locally alongside the brain server. This deployed mirror is read-only and does not include it.
        </div>
      </div>
    </Card>
  );
}

export function DataModule() {
  warnIfTooManyTabs('data', DATA_TABS);
  const [tab, setTab] = useTabParam<DataTab>(DATA_TAB_KEYS, 'imports', 'tab', CLEAR_VIEW);
  // R4: badges declared on DATA_TABS reach the strip (useTabSpecs is the one mapping).
  const tabSpecs = useTabSpecs(DATA_TABS);
  const imports = useWarehouseImports();
  const issues = useWarehouseIssues();
  const noi = useNoiMatrix();
  const live = useWarehouseLive();
  const freshness = useWarehouseFreshness();

  const unavailable =
    isWarehouseUnavailable(imports.error) || isWarehouseUnavailable(noi.error) || isWarehouseUnavailable(issues.error);
  const loading = imports.isLoading || noi.isLoading || issues.isLoading;

  /** The three warehouse tabs share one offline / loading gate; the panels stay mounted-on-select. */
  const warehousePanel = (what: string, body: () => ReactNode) =>
    unavailable ? <WarehouseOfflineCard what={what} /> : loading ? <Skeleton style={{ height: 220 }} /> : body();

  return (
    <div className="flex flex-col gap-4">
      <Card>
        <CardHeader
          title="Data Operations"
          trailing={
            !live && (
              <Badge tone="neutral">
                {`Computed from snapshot${freshness.detail ? ` · ${freshness.detail}` : ''}`}
              </Badge>
            )
          }
        />
        {DATA_OPS_TABS.has(tab) && !unavailable && (
          <div className="px-4 py-3">
            <DataOpsKpiRow
              committed={(imports.data ?? []).filter((i) => i.status === 'committed').length}
              pending={(imports.data ?? []).filter((i) => i.status === 'pending-review').length}
              openIssues={issues.data?.length ?? 0}
              propertiesCovered={new Set((noi.data ?? []).map((c) => c.propertyId)).size}
              latestPeriod={latestPeriod(noi.data ?? [])}
            />
          </div>
        )}
      </Card>

      {/* keyboardActivation="manual" — every panel fires its own queries on mount (plan R9). */}
      <Tabs tabs={tabSpecs} selectedKey={tab} onSelectionChange={(k) => setTab(k as DataTab)} keyboardActivation="manual" aria-label="Data views">
        <TabPanel id="imports">
          {warehousePanel('Imports', () => <ImportsView imports={imports.data ?? []} />)}
        </TabPanel>
        <TabPanel id="quality">
          {warehousePanel('Data quality', () => <DataQualityView issues={issues.data ?? []} />)}
        </TabPanel>
        <TabPanel id="mappings">
          {warehousePanel('Mappings', () => <MappingsView imports={imports.data ?? []} />)}
        </TabPanel>
        <TabPanel id="calibration">
          <Suspense fallback={<ModuleLoading />}><CalibrationModule /></Suspense>
        </TabPanel>
        <TabPanel id="documents">
          <Suspense fallback={<ModuleLoading />}><DocumentsModule /></Suspense>
        </TabPanel>
      </Tabs>
    </div>
  );
}
