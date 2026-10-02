import { useMemo, useState } from 'react';
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

const ALL = '__portfolio__';

export function TrendsView() {
  const { data } = useSnapshot();
  const gate = useSnapshotGate();
  const [scope, setScope] = useState<string>(ALL);

  const trend = useMemo(
    () => (data ? buildPortfolioTrend(data.snapshot.leases, data.snapshot.properties, { asOf: data.snapshot.meta.asOf }) : null),
    [data],
  );
  if (gate) return gate;
  if (!data || !trend) return null;

  // A scope whose property vanished from the trend (snapshot refresh) falls back to the portfolio.
  const effectiveScope = scope !== ALL && trend.byProperty[scope] ? scope : ALL;
  const points = effectiveScope === ALL ? trend.portfolio : trend.byProperty[effectiveScope]!;
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

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <select aria-label="Scope" value={effectiveScope} onChange={(e) => setScope(e.target.value)}>
          <option value={ALL}>Entire portfolio</option>
          {names.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
        </select>
        <Badge tone="neutral">Reconstructed from current leases</Badge>
        <span className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          Months after {trend.asOfMonth} show contractual roll-off assuming NO renewals or re-leasing; history is reconstructed from current leases only.
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3">
        <KpiStat label="In-place rent / mo" value={k.rent} format={fmtUsdCompact} delta={k.rentMoM} deltaLabel="MoM" sublabel="reconstructed · excludes departed tenants" spark={histPoints.map((p) => p.inPlaceRent)} />
        <KpiStat label="Vacancy (lease-SF basis)" value={k.vacancyPct * 100} format={(n) => (n === null ? '—' : `${n.toFixed(1)}%`)} sublabel={`${k.vacancyMoMPts === null ? '' : `${k.vacancyMoMPts >= 0 ? '+' : ''}${k.vacancyMoMPts.toFixed(1)} pts MoM · `}may differ from workbook occupancy`} spark={histPoints.map((p) => p.vacancyPct)} />
        <KpiStat label="Vacant SF" value={k.vacantSf} format={fmtSf} />
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
