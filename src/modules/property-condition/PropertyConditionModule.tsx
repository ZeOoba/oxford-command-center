// src/modules/property-condition/PropertyConditionModule.tsx
//
// Property Condition — standalone destination in the rail's Capital group (Capital itself is at the
// 5-tab house cap, so this is not a sixth Capital tab). Four KPIs + an 8-view SegmentedControl on `?view=`
// (Capex outlook / Replacement schedule / Estimate vs actual / Quotes & prices / Open items / 29000 Info Ln / Building specs / Cost seg); only the
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
import { STALE_BEFORE_YEAR, applyPcaOverlay, currencyAlerts, monthsSince, nearTermRollup } from '@/analytics/pca-intelligence';
import { useTabParam } from '@/lib/useTabParam';
import { isWarehouseUnavailable } from '../intel/hooks';
import { usePropertyCondition } from './hooks';
import { PC_VIEWS, PC_VIEW_IDS, type PcViewId } from './views';
import { CapexOutlookView } from './CapexOutlookView';
import { ScheduleView } from './ScheduleView';
import { CalibrationView } from './CalibrationView';
import { PricesView } from './PricesView';
import { OpenItemsView } from './OpenItemsView';
import { IssuesQueue } from './IssuesQueue';
import { AlertsBanner } from './AlertsBanner';
import { InfoLaneView } from './InfoLaneView';
import { SpecsPanel } from './SpecsView';
import { CostSegPanel } from './CostSegView';
import { buildClockRows } from './clock';
import { EXTRA_ASSET_FACTS, INFO_LANE_DETAIL, PCA_OVERLAY } from './pca-overlay';
import { CALIBRATION_LEDGER, CALIBRATION_PENDING } from './calibration-data';

/** Reports dated before 2024 are history only — their lifecycle lines are not projected as forecasts. Judged on the RAW
 *  register date on purpose: lifecycle rows carry that raw date and a dueYear computed from it, so a report the overlay
 *  re-dates must stay hidden here rather than show a forecast year that is off by the correction (refute wf_d6c1bdd5-8b6). */
const isStaleDate = (d: string | null): boolean => d === null || Number(d.slice(0, 4)) < STALE_BEFORE_YEAR;

/** Today as YYYY-MM-DD — years-left, report age and rent-roll age are all computed from this at render. */
function todayIso(): string {
  return new Date().toLocaleDateString('en-CA'); // local YYYY-MM-DD
}

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

  // Curated corrections + data-quality flags, then everything time-dependent is derived from today.
  const today = todayIso();
  const adjusted = applyPcaOverlay(report, PCA_OVERLAY);
  const { totals } = adjusted;
  const rollup = nearTermRollup(adjusted.properties);
  const alerts = currencyAlerts(adjusted.properties, today, PCA_OVERLAY);
  const staleReportIds = new Set(adjusted.properties.filter((p) => p.status === 'STALE').map((p) => p.current.reportId));
  const clockRows = buildClockRows(report.schedule, EXTRA_ASSET_FACTS, today);

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat
          label="Immediate Repairs"
          value={totals.immediateUsd}
          format={fmtUsdCompact}
          accentColor="var(--color-warn)"
          sublabel="Σ current + draft reports · excl. stale (pre-2024, undated or flagged)"
        />
        <KpiStat
          label="Short-term"
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
          sublabel="Stale and narrative-only reports excluded"
        />
      </div>

      <AlertsBanner alerts={alerts} />

      <SegmentedControl options={VIEW_OPTIONS} value={view} onChange={setView} aria-label="Property condition views" />

      {view === 'outlook' && <CapexOutlookView properties={adjusted.properties} rollup={rollup} />}
      {view === 'schedule' && <ScheduleView schedule={clockRows} lifecycle={report.lifecycle.filter((l) => !isStaleDate(l.reportDate) && !staleReportIds.has(l.reportId))} />}
      {view === 'calibration' && <CalibrationView ledger={CALIBRATION_LEDGER} pending={CALIBRATION_PENDING} />}
      {view === 'prices' && <PricesView quotes={report.quotes} priceBook={report.priceBook} />}
      {view === 'open' && (
        <div className="flex flex-col gap-4">
          <IssuesQueue />
          <OpenItemsView items={report.openItems} />
        </div>
      )}
      {view === 'specs' && <SpecsPanel enabled />}
      {view === 'costseg' && <CostSegPanel registerSf={Object.fromEntries(adjusted.properties.map((p) => [p.propertyKey, p.current.sf]))} registerStatus={Object.fromEntries(adjusted.properties.map((p) => [p.propertyKey, p.status]))} />}
      {view === 'infolane' && <InfoLaneView rentRollMonths={monthsSince(INFO_LANE_DETAIL.rentRoll.asOf, today)} />}
    </div>
  );
}
