import { useMemo, useState, type ReactNode } from 'react';
import { useSnapshot } from '@/data/queries';
import { useSnapshotGate } from '@/shell/SnapshotGate';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { AreaChart } from '@/charts/AreaChart';
import { BarChart } from '@/charts/BarChart';
import { fmtUsdCompact, fmtPct, fmtSf } from '@analytics/index';
import { buildPortfolioTrend } from '@analytics/portfolio-trends';
import { kpiAt, rentSeries, vacancySeries, rentChangeBars } from './trends-chart-data';
import { mergeRecorded, recordedYoY, useTrendsHistory, type SourcedMonthPoint } from './trends-history';
import type { TrendsHistoryPoint } from '@contracts/trends';

const ALL = '__portfolio__';

/**
 * Workbook occupancy for the as-of month: single property -> that row's occPct; portfolio -> SF-weighted
 * average using totalSf. Null (line skipped) unless the as-of point is recorded and EVERY in-scope
 * property has a recorded row with a known occPct.
 */
function workbookOccupancy(
  recorded: TrendsHistoryPoint[],
  asOfMonth: string,
  propertyIds: string[],
  points: SourcedMonthPoint[],
): number | null {
  if (points.find((p) => p.month === asOfMonth)?.source !== 'recorded' || propertyIds.length === 0) return null;
  let sf = 0;
  let occSf = 0;
  for (const id of propertyIds) {
    const row = recorded.find((r) => r.month === asOfMonth && r.propertyId === id);
    if (!row || row.occPct === null) return null;
    sf += row.totalSf;
    occSf += row.totalSf * row.occPct;
  }
  if (propertyIds.length === 1) return recorded.find((r) => r.month === asOfMonth && r.propertyId === propertyIds[0])!.occPct;
  return sf > 0 ? occSf / sf : null;
}


export function TrendsView() {
  const { data } = useSnapshot();
  const gate = useSnapshotGate();
  const history = useTrendsHistory();
  const [scope, setScope] = useState<string>(ALL);

  const trend = useMemo(
    () => (data ? buildPortfolioTrend(data.snapshot.leases, data.snapshot.properties, { asOf: data.snapshot.meta.asOf }) : null),
    [data],
  );

  // A scope whose property vanished from the trend (snapshot refresh) falls back to the portfolio.
  const effectiveScope = trend && scope !== ALL && trend.byProperty[scope] ? scope : ALL;

  // Any history failure (warehouse unavailable, parse error, still loading) means "no recorded history":
  // the page stays the Wave 1 reconstruction, never an error banner.
  const recorded = useMemo(() => (history.isError ? [] : history.data?.points ?? []), [history.isError, history.data]);

  // Recorded months replace reconstructed ones; forecast months are never replaced.
  const points = useMemo(() => {
    if (!trend) return null;
    const base = effectiveScope === ALL ? trend.portfolio : trend.byProperty[effectiveScope]!;
    return mergeRecorded(base, recorded, {
      propertyIds: Object.keys(trend.byProperty),
      ...(effectiveScope === ALL ? {} : { propertyId: effectiveScope }),
    });
  }, [trend, recorded, effectiveScope]);

  if (gate) return gate;
  if (!data || !trend || !points) return null;

  // kpiAt falls back to 0 when the as-of month is absent — show an empty state instead of fake zeros.
  if (!points.some((p) => p.month === trend.asOfMonth)) {
    return (
      <Card>
        <CardHeader title="Trends" />
        <p className="p-4 text-sm" style={{ color: 'var(--text-tertiary)' }}>No trend data for the as-of month</p>
      </Card>
    );
  }
  const k = kpiAt(points, trend.asOfMonth);
  const names = data.snapshot.properties.filter((p) => trend.byProperty[p.id]);
  const bridge = effectiveScope === ALL ? trend.bridge : [];
  const forecastFlag = <Badge tone="amber">Contractual roll-off after {trend.asOfMonth} · no renewals assumed</Badge>;
  // Sparklines show history + as-of only; forward months are roll-off, not a trend.
  const histPoints = points.filter((p) => !p.isForecast);

  const recordedMonths = histPoints.filter((p) => p.source === 'recorded');
  const reconstructedLeft = histPoints.some((p) => p.source === 'reconstructed');
  const yoy = recordedYoY(points, trend.asOfMonth);
  const workbookOcc = workbookOccupancy(recorded, trend.asOfMonth, effectiveScope === ALL ? Object.keys(trend.byProperty) : [effectiveScope], points);

  const sinceMonth = recordedMonths[0]?.month;
  const rollOff = `Months after ${trend.asOfMonth} show contractual roll-off assuming NO renewals or re-leasing`;
  // Wording follows what is actually on screen: untouched Wave 1 text when nothing is recorded.
  const captionText =
    recordedMonths.length === 0
      ? `${rollOff}; history is reconstructed from current leases only.`
      : reconstructedLeft
        ? `${rollOff}. Months before ${sinceMonth} are reconstructed from current leases; ${sinceMonth} onward are recorded.`
        : `${rollOff}.`;
  const rentNote = recordedMonths.length === 0 ? 'reconstructed · excludes departed tenants' : reconstructedLeft ? 'reconstructed history excludes departed tenants' : undefined;
  // KpiStat's sublabel is a one-line nowrap/truncate flex row beside the delta: keep it to SHORT values only.
  // Explanatory notes render as full-width captions beneath their card instead.
  const vacSub = k.vacancyMoMPts === null ? undefined : `${k.vacancyMoMPts >= 0 ? '+' : ''}${k.vacancyMoMPts.toFixed(1)} pts MoM`;
  const Caption = ({ children }: { children: ReactNode }) => (
    <div className="num whitespace-normal px-1 text-2xs" style={{ color: 'var(--text-tertiary)' }}>{children}</div>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <select aria-label="Scope" value={effectiveScope} onChange={(e) => setScope(e.target.value)}>
          <option value={ALL}>Entire portfolio</option>
          {names.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        {recordedMonths.length > 0 && (
          <Badge tone="neutral">
            Recorded: {recordedMonths.length} {recordedMonths.length === 1 ? 'month' : 'months'} (since {recordedMonths[0]!.month})
          </Badge>
        )}
        {(recordedMonths.length === 0 || reconstructedLeft) && (
          <Badge tone="neutral">{recordedMonths.length > 0 ? 'Earlier months reconstructed from current leases' : 'Reconstructed from current leases'}</Badge>
        )}
        <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          {captionText}
        </span>
      </div>

      <div className={`grid grid-cols-2 items-start gap-3 ${yoy === null ? 'md:grid-cols-3' : 'md:grid-cols-4'}`}>
        <div className="flex flex-col gap-1">
          <KpiStat label="In-place rent / mo" value={k.rent} format={fmtUsdCompact} delta={k.rentMoM} deltaLabel="MoM" spark={histPoints.map((p) => p.inPlaceRent)} />
          {rentNote !== undefined && <Caption>{rentNote}</Caption>}
        </div>
        <div className="flex flex-col gap-1">
          <KpiStat
            label="Vacancy (lease-SF basis)"
            value={k.vacancyPct * 100}
            format={(n) => (n === null ? '—' : `${n.toFixed(1)}%`)}
            sublabel={vacSub}
            spark={histPoints.map((p) => p.vacancyPct)}
          />
          <Caption>lease-SF basis · may differ from workbook occupancy</Caption>
          {workbookOcc !== null && <Caption>Workbook occupancy: {(workbookOcc * 100).toFixed(1)}%</Caption>}
        </div>
        <div className="flex flex-col gap-1">
          <KpiStat label="Vacant SF" value={k.vacantSf} format={fmtSf} />
        </div>
        {yoy !== null && (
          <div className="flex flex-col gap-1">
            <KpiStat label="YoY (recorded)" value={yoy * 100} format={(n) => (n === null ? '—' : `${n.toFixed(1)}%`)} />
            <Caption>in-place rent · both months recorded</Caption>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
        <Card>
          <CardHeader title="Monthly in-place rent" trailing={forecastFlag} />
          <div className="p-3"><AreaChart data={rentSeries(points)} valueFormat={fmtUsdCompact} /></div>
        </Card>
        <Card>
          <CardHeader title="Vacancy (lease-SF basis)" trailing={forecastFlag} />
          <div className="p-3"><AreaChart data={vacancySeries(points)} color="var(--color-neg)" valueFormat={(n) => fmtPct(n / 100)} /></div>
        </Card>
      </div>

      {bridge.length > 0 && (
        <Card>
          <CardHeader title="Month-over-month rent change (escalations + new leases − expirations)" trailing={forecastFlag} />
          <div className="p-3"><BarChart data={rentChangeBars(bridge)} valueFormat={fmtUsdCompact} ariaLabel="Monthly rent change" /></div>
        </Card>
      )}
    </div>
  );
}
