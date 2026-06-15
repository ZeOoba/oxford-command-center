/* eslint-disable react-refresh/only-export-components -- colocated widget registry + components */
import type { ComponentType } from 'react';
import { useSnapshot, useAnalytics } from '@/data/queries';
import { fmtUsdCompact, fmtSf, fmtPct, fmtYears, fmtNum } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { BarChart } from '@/charts/BarChart';
import { BarList } from '@/charts/BarList';
import { AreaChart } from '@/charts/AreaChart';
import { InsightList } from './InsightList';

export interface WidgetDef {
  id: string;
  title: string;
  span: 'full' | 'half';
  Component: ComponentType;
}

function KpiStripWidget() {
  const { data } = useSnapshot();
  const { analytics } = useAnalytics();
  if (!data || !analytics) return null;
  const k = analytics.kpis;
  const cashSpark = data.snapshot.cash.history.map((h) => h.total);
  const last = cashSpark.at(-1) ?? 0;
  const prev = cashSpark.at(-2) ?? last;
  const cashDelta = prev ? (last - prev) / prev : null;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <KpiStat label="Portfolio Value" value={k.value.value} format={fmtUsdCompact} prov={k.value.prov} sublabel={`${fmtNum(k.propertyCount.value)} properties`} />
      <KpiStat label="Net Operating Income" value={k.noi.value} format={fmtUsdCompact} prov={k.noi.prov} sublabel={`${fmtPct(k.weightedCapRate.value)} wtd cap`} accentColor="var(--color-pos)" />
      <KpiStat label="Portfolio SF" value={k.totalSf.value} format={fmtSf} prov={k.totalSf.prov} sublabel={`${fmtNum(k.tenantCount.value)} tenants`} accentColor="var(--color-info)" />
      <KpiStat label="Occupancy" value={k.occupancy.value === null ? null : k.occupancy.value * 100} format={(n) => (n === null ? '—' : `${n.toFixed(1)}%`)} prov={k.occupancy.prov} sublabel="weighted by SF" accentColor="var(--color-pos)" />
      <KpiStat label="WALT" value={k.walt.value} format={fmtYears} prov={k.walt.prov} sublabel="rent-weighted" accentColor="var(--color-accent2)" />
      <KpiStat label="Total Debt" value={k.totalDebt.value} format={fmtUsdCompact} prov={k.totalDebt.prov} sublabel={`${fmtPct(k.ltv.value)} LTV`} accentColor="var(--color-warn)" />
      <KpiStat label="Equity Invested" value={k.equityInvested.value} format={fmtUsdCompact} prov={k.equityInvested.prov} accentColor="var(--color-gold-400, #d8bd7e)" />
      <KpiStat label="Total Cash" value={k.totalCash.value} format={fmtUsdCompact} prov={k.totalCash.prov} spark={cashSpark} delta={cashDelta} deltaLabel="MoM" sparkColor="var(--color-pos)" accentColor="var(--color-pos)" />
    </div>
  );
}

function NoiByMarketWidget() {
  const { analytics } = useAnalytics();
  if (!analytics) return null;
  const marketData = analytics.marketByNoi.filter((m) => m.value > 0).map((m) => ({ label: m.market, value: m.value }));
  return (
    <Card>
      <CardHeader title="NOI by Market" trailing={<Badge tone="gold">{marketData.length} markets</Badge>} />
      <div className="px-3 pb-2 pt-3">
        <BarChart data={marketData} valueFormat={fmtUsdCompact} height={250} />
      </div>
    </Card>
  );
}

function TopTenantsWidget() {
  const { analytics } = useAnalytics();
  if (!analytics) return null;
  const topTenants = analytics.topTenants.slice(0, 6).map((t) => ({ label: t.company, value: t.annualRent, display: `${fmtUsdCompact(t.annualRent)} · ${fmtPct(t.share)}` }));
  return (
    <Card>
      <CardHeader title="Top Tenants by Annual Rent" trailing={<Badge tone="neutral">HHI {fmtNum(analytics.tenantHHI)}</Badge>} />
      <div className="p-3">
        <BarList items={topTenants} />
      </div>
    </Card>
  );
}

function CashTrendWidget() {
  const { data } = useSnapshot();
  if (!data) return null;
  const series = data.snapshot.cash.history.map((h) => ({ date: h.date, value: h.total }));
  return (
    <Card>
      <CardHeader title="Total Cash — 12-Month Trend" trailing={<Badge tone="neutral">{series.length} mo</Badge>} />
      <div className="px-3 pb-2 pt-3">
        <AreaChart data={series} valueFormat={fmtUsdCompact} height={230} color="var(--color-pos)" />
      </div>
    </Card>
  );
}

function LeaseRolloverWidget() {
  const { analytics } = useAnalytics();
  if (!analytics) return null;
  return (
    <Card>
      <CardHeader title="Lease Rollover" trailing={<Badge tone="neutral">rent expiring</Badge>} />
      <div className="px-3 pb-2 pt-3">
        <BarChart data={analytics.rollover.map((b) => ({ label: b.period, value: b.expiringRent }))} valueFormat={fmtUsdCompact} height={230} color="var(--color-info)" />
      </div>
    </Card>
  );
}

function InsightsWidget() {
  const { analytics } = useAnalytics();
  if (!analytics) return null;
  return (
    <Card accent>
      <CardHeader title="Insights & Alerts" trailing={<Badge tone={analytics.insights.some((i) => i.severity === 'critical') ? 'red' : 'amber'}>{analytics.insights.length} active</Badge>} />
      <InsightList insights={analytics.insights.slice(0, 7)} />
    </Card>
  );
}

/** Overview widget registry — drop a new entry here and it's available to the dashboard. */
export const OVERVIEW_WIDGETS: WidgetDef[] = [
  { id: 'kpis', title: 'Portfolio KPIs', span: 'full', Component: KpiStripWidget },
  { id: 'noi-market', title: 'NOI by Market', span: 'half', Component: NoiByMarketWidget },
  { id: 'top-tenants', title: 'Top Tenants', span: 'half', Component: TopTenantsWidget },
  { id: 'cash-trend', title: 'Cash Trend', span: 'half', Component: CashTrendWidget },
  { id: 'lease-rollover', title: 'Lease Rollover', span: 'half', Component: LeaseRolloverWidget },
  { id: 'insights', title: 'Insights & Alerts', span: 'full', Component: InsightsWidget },
];

export const DEFAULT_WIDGET_ORDER = OVERVIEW_WIDGETS.map((w) => w.id);
