// src/modules/property-condition/PropertyConditionModule.tsx
//
// Property Condition — standalone destination in the rail's Capital group (Capital itself is at the
// 5-tab house cap, so this is not a sixth Capital tab). Four KPIs + a 5-view SegmentedControl on `?view=`
// (Capex outlook / Replacement schedule / Estimate vs actual / Quotes & prices / Open items); only the
// selected view is mounted (R5: no nested tab strips).
//
// READ-ONLY. Phase 2 of docs/capital/2026-10-07-pca-capex-ledger-integration-plan.md: nothing here feeds
// scoring, governors, or capital-allocation (that wiring is Phase 4, behind refute-financial-change).
// "Current" = the most recent report we have per property — no age cutoff (Gabriel, 2026-10-07).
//
// States mirror taxes/TaxesModule.tsx: Skeleton while loading, an informational offline card when the
// warehouse routes are unreachable (static mirror — this route is not baked), a red error card on a real
// failure, and a distinct "not loaded" card when the warehouse is up but the register has not been imported.
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { SegmentedControl } from '@/primitives/SegmentedControl';
import { fmtUsdCompact } from '@analytics/index';
import { useTabParam } from '@/lib/useTabParam';
import { isWarehouseUnavailable } from '../intel/hooks';
import { usePropertyCondition } from './hooks';
import { PC_VIEWS, PC_VIEW_IDS, type PcViewId } from './views';
import { CapexOutlookView } from './CapexOutlookView';
import { ScheduleView } from './ScheduleView';
import { CalibrationView } from './CalibrationView';
import { PricesView } from './PricesView';
import { OpenItemsView } from './OpenItemsView';

const VIEW_OPTIONS = PC_VIEWS.map((v) => ({ value: v.id, label: v.label }));

export function PropertyConditionModule() {
  const [view, setView] = useTabParam<PcViewId>(PC_VIEW_IDS, 'outlook', 'view');
  const { data: report, isLoading, error } = usePropertyCondition();

  if (isLoading) return <Skeleton style={{ height: 320 }} />;

  if (isWarehouseUnavailable(error)) {
    return (
      <Card>
        <CardHeader title="Property Condition" trailing={<Badge tone="neutral">offline</Badge>} />
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Property condition data requires the live brain server.
          </div>
          <div className="text-2xs" style={{ color: 'var(--text-tertiary)', maxWidth: 420 }}>
            PCA reserves, install facts and contractor quotes are read from the warehouse. This deployed
            mirror does not include the live warehouse.
          </div>
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardHeader title="Property Condition" trailing={<Badge tone="red">error</Badge>} />
        <div className="px-4 py-6 text-sm" style={{ color: 'var(--text-neg)' }}>
          {error instanceof Error ? error.message : 'Failed to load property condition.'}
        </div>
      </Card>
    );
  }

  if (!report) return null;

  if (!report.loaded) {
    return (
      <Card>
        <CardHeader title="Property Condition" trailing={<Badge tone="amber">not loaded</Badge>} />
        <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
          <div className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            The PCA extraction register has not been imported into this warehouse.
          </div>
          <code className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            npm run warehouse:import-pca -- &lt;PCA-Extraction_Register.xlsx&gt;
          </code>
        </div>
      </Card>
    );
  }

  const { totals } = report;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat
          label="Immediate Repairs"
          value={totals.immediateUsd}
          format={fmtUsdCompact}
          accentColor="var(--color-warn)"
          sublabel="Σ most recent report per property"
        />
        <KpiStat
          label="Short-term (Yr 1–2)"
          value={totals.shortTermUsd}
          format={fmtUsdCompact}
          sublabel="Where the report separates it"
        />
        <KpiStat
          label="Capex Reserves"
          value={totals.reservesUninflUsd}
          format={fmtUsdCompact}
          sublabel="Uninflated · terms differ 10–12 yrs"
        />
        <KpiStat
          label="Properties With $ Figures"
          value={totals.propertiesWithFigures}
          format={(n) => `${n ?? 0} / ${totals.propertiesTotal}`}
          sublabel="Narrative-only reports carry none"
        />
      </div>

      <SegmentedControl options={VIEW_OPTIONS} value={view} onChange={setView} aria-label="Property condition views" />

      {view === 'outlook' && <CapexOutlookView properties={report.properties} />}
      {view === 'schedule' && <ScheduleView schedule={report.schedule} lifecycle={report.lifecycle} />}
      {view === 'calibration' && <CalibrationView rows={report.calibration} />}
      {view === 'prices' && <PricesView quotes={report.quotes} priceBook={report.priceBook} />}
      {view === 'open' && <OpenItemsView items={report.openItems} />}
    </div>
  );
}
