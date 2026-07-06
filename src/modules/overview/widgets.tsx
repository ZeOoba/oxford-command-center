/* eslint-disable react-refresh/only-export-components -- colocated widget registry + components */
import type { ComponentType } from 'react';
import { useState } from 'react';
import { useSnapshot, useAnalytics } from '@/data/queries';
import { fmtUsdCompact, fmtSf, fmtPct, fmtYears, fmtNum } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { BarChart } from '@/charts/BarChart';
import { BarList } from '@/charts/BarList';
import { AreaChart } from '@/charts/AreaChart';
import { TierBoard, type Tier, type TierItem, type TierTotal } from '@/primitives/TierBoard';
import { InsightList } from './InsightList';
import { useWarehouseInsights } from '../insights/hooks';
import { mergeInsightSources, buildSummary, totalsBySpine, type MergedInsight } from '../insights/insights.logic';

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

// ── Results banner (reuses the P2 merged-insight feed's buildSummary) ──────────────────────
//
// The banner never computes risk/monitor $ totals itself — it calls mergeInsightSources() +
// buildSummary() from insights.logic.ts, the exact same functions InsightsModule.tsx uses. That
// guarantees this widget's numbers can never drift from the Insights module for the same input:
// there is only one place the sum is computed. Per the basis-mixing doctrine (CLAUDE.md §1),
// each total is shown split by spine — never blended into one combined figure.
function SpineSplitCell({
  label,
  totals,
  accentColor,
}: {
  label: string;
  totals: TierTotal[];
  accentColor: string;
}) {
  return (
    <div
      className="flex flex-col gap-2 rounded-[var(--radius-md)] p-3"
      style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="num text-2xs font-semibold uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>
        {label}
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1">
        {totals.map((t) => (
          <div key={t.label}>
            <div className="num text-base font-semibold leading-none" style={{ color: accentColor }}>
              {fmtUsdCompact(t.totalUsd)}
            </div>
            <div className="num mt-1 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
              {t.label}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ResultsBannerWidget() {
  const { data } = useSnapshot();
  const { analytics } = useAnalytics();
  const insightsQuery = useWarehouseInsights();
  if (!data || !analytics) return null;

  const candidates = insightsQuery.data?.candidates ?? [];
  const { merged } = mergeInsightSources(analytics.insights, candidates, data.snapshot);
  const summary = buildSummary(merged);

  return (
    <Card accent>
      <CardHeader
        title="Results"
        trailing={<Badge tone={summary.count > 0 ? 'amber' : 'neutral'}>{summary.count} open</Badge>}
      />
      <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-3">
        <SpineSplitCell label="Risk Impact" totals={summary.riskImpactBySpine} accentColor="var(--color-neg)" />
        <SpineSplitCell label="Monitor Impact" totals={summary.monitorImpactBySpine} accentColor="var(--color-info)" />
        <div
          className="flex flex-col justify-center gap-1 rounded-[var(--radius-md)] p-3"
          style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)' }}
        >
          <div className="num text-2xl font-semibold leading-none" style={{ color: 'var(--text-primary)' }}>
            {summary.count}
          </div>
          <div className="num text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            Open Actions
          </div>
        </div>
      </div>
    </Card>
  );
}

// ── Priority Actions (top-N across all severities, reusing the same merged feed) ────────────
//
// Unlike buildTiers() (which groups by severity into Critical/Priority/Monitor), this widget
// wants a single cross-severity ranking by raw $ impact — "what are the N biggest-dollar things
// happening right now, regardless of severity." That ranking isn't something insights.logic.ts
// exports (its buildTiers groups by severity on purpose), so the sort/slice lives here as a
// small presentation-only helper; the underlying merge + per-spine subtotal (totalsBySpine) are
// still the shared, reused functions — only the top-N selection is new.
const PRIORITY_ACTIONS_LIMIT = 6;

function sortMergedByImpactDesc(items: MergedInsight[]): MergedInsight[] {
  return [...items].sort((a, b) => {
    if (a.impactUsd === null && b.impactUsd === null) return 0;
    if (a.impactUsd === null) return 1; // nulls last
    if (b.impactUsd === null) return -1;
    return b.impactUsd - a.impactUsd;
  });
}

function buildPriorityActionsTier(merged: MergedInsight[], limit: number): Tier {
  const top = sortMergedByImpactDesc(merged).slice(0, limit);
  const items: TierItem[] = top.map((m, index) => ({
    id: m.id,
    rank: index + 1,
    category: m.category,
    impactUsd: m.impactUsd,
    impactKind: m.severity === 'info' ? 'info' : 'risk',
    title: m.title,
    detail: m.detail,
    chips: [m.spine === 'A' ? 'Spine A' : m.spine === 'B' ? 'Spine B' : 'Cross-spine'],
  }));
  return {
    key: 'priority-actions',
    title: 'Priority Actions',
    subtitle: 'Top items by $ impact, all severities',
    tone: 'accent',
    items,
    totalsBySpine: totalsBySpine(top),
  };
}

function PriorityActionsWidget() {
  const { data } = useSnapshot();
  const { analytics } = useAnalytics();
  const insightsQuery = useWarehouseInsights();
  if (!data || !analytics) return null;

  const candidates = insightsQuery.data?.candidates ?? [];
  const { merged } = mergeInsightSources(analytics.insights, candidates, data.snapshot);
  const tier = buildPriorityActionsTier(merged, PRIORITY_ACTIONS_LIMIT);

  // A single ranked tier — full 3-column TierBoard doesn't suit a summary-surface widget card,
  // so this passes just one Tier through the same primitive at its narrowest supported column
  // count (2; TierBoard's COLUMN_CLASS map doesn't offer 1).
  return <TierBoard tiers={[tier]} columns={2} />;
}

const INSIGHTS_INITIAL = 7;

function InsightsWidget() {
  const { analytics } = useAnalytics();
  const [showAll, setShowAll] = useState(false);
  if (!analytics) return null;
  const all = analytics.insights;
  const visible = showAll ? all : all.slice(0, INSIGHTS_INITIAL);
  const hidden = all.length - INSIGHTS_INITIAL;
  return (
    <Card accent>
      <CardHeader title="Insights & Alerts" trailing={<Badge tone={all.some((i) => i.severity === 'critical') ? 'red' : 'amber'}>{all.length} active</Badge>} />
      <InsightList insights={visible} />
      {!showAll && hidden > 0 && (
        <button
          onClick={() => setShowAll(true)}
          className="w-full py-2.5 text-xs font-medium"
          style={{ borderTop: '1px solid var(--border-subtle)', color: 'var(--text-secondary)', background: 'transparent', cursor: 'pointer' }}
        >
          Show {hidden} more
        </button>
      )}
    </Card>
  );
}

/** Overview widget registry — drop a new entry here and it's available to the dashboard. */
export const OVERVIEW_WIDGETS: WidgetDef[] = [
  { id: 'kpis', title: 'Portfolio KPIs', span: 'full', Component: KpiStripWidget },
  { id: 'results-banner', title: 'Results', span: 'full', Component: ResultsBannerWidget },
  { id: 'noi-market', title: 'NOI by Market', span: 'half', Component: NoiByMarketWidget },
  { id: 'top-tenants', title: 'Top Tenants', span: 'half', Component: TopTenantsWidget },
  { id: 'priority-actions', title: 'Priority Actions', span: 'half', Component: PriorityActionsWidget },
  { id: 'cash-trend', title: 'Cash Trend', span: 'half', Component: CashTrendWidget },
  { id: 'lease-rollover', title: 'Lease Rollover', span: 'half', Component: LeaseRolloverWidget },
  { id: 'insights', title: 'Insights & Alerts', span: 'full', Component: InsightsWidget },
];

export const DEFAULT_WIDGET_ORDER = OVERVIEW_WIDGETS.map((w) => w.id);
