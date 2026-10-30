/* eslint-disable react-refresh/only-export-components -- colocated widget registry + components */
import type { ComponentType } from 'react';
import { useSnapshot, useAnalytics } from '@/data/queries';
import { useUi } from '@/brain/ui-context';
import { fmtUsdCompact, fmtSf, fmtPct, fmtYears, fmtNum } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { AsOfChip } from '@/primitives/AsOfChip';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { BarChart } from '@/charts/BarChart';
import { BarList } from '@/charts/BarList';
import { RolloverChart } from '../leasing/RolloverChart';
import { AreaChart } from '@/charts/AreaChart';
import { TierBoard, type Tier, type TierTotal } from '@/primitives/TierBoard';
import { investmentPropertiesSublabel } from './other-holdings';
import { overviewTotalDebtSublabel } from '../debt/debt-sublabels';
import { useWarehouseInsights } from '../insights/hooks';
import { mergeInsightSources, buildSummary, buildTiers, mergedToTierItem, sortByImpactDesc, totalsBySpine, type MergedInsight } from '../insights/insights.logic';
import { groupByCause, rankRows } from '../../lib/tier-group';
import { OVERVIEW_MAX_ITEMS } from '../../lib/ranked-cap';
import type { LayoutMigration } from '@/brain/useWorkspaces';
import { describeAlertCause } from '../alerts/cause-labels';

export interface WidgetDef {
  id: string;
  title: string;
  span: 'full' | 'half';
  Component: ComponentType;
  /** Whether a NEW/default layout shows this widget out of the box. Omitted/true = shown.
   *  Feeds two things: DEFAULT_WIDGET_ORDER (the documented/tested "visible by default" subset)
   *  and DEFAULT_HIDDEN_WIDGET_IDS, which OverviewModule passes to useWorkspaces as its
   *  `defaultHidden` list. A `defaultOn: false` widget is still part of every layout's `order` —
   *  it's addable via Edit layout — it just starts in `hidden`. A layout that has already made an
   *  explicit visible/hidden choice for the id (its own saved order already contains it) keeps
   *  that choice; this flag only decides what happens the FIRST time a layout meets the id. */
  defaultOn?: boolean;
}

function KpiStripWidget() {
  const { data } = useSnapshot();
  const { analytics } = useAnalytics();
  const ui = useUi();
  if (!data || !analytics) return null;
  const k = analytics.kpis;
  const cashSpark = data.snapshot.cash.history.map((h) => h.total);
  const last = cashSpark.at(-1) ?? 0;
  const prev = cashSpark.at(-2) ?? last;
  const cashDelta = prev ? (last - prev) / prev : null;
  const goTo = (id: string) => () => ui.setActiveModule(id);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <KpiStat label="Portfolio Value" value={k.value.value} format={fmtUsdCompact} prov={k.value.prov} sublabel={investmentPropertiesSublabel(k)} onPress={goTo('portfolio')} />
      <KpiStat label="Net Operating Income" value={k.noi.value} format={fmtUsdCompact} prov={k.noi.prov} sublabel={`Oxford share · workbook · ${fmtPct(k.weightedCapRate.value)} wtd cap`} accentColor="var(--color-pos)" onPress={goTo('intel')} />
      <KpiStat label="Portfolio SF" value={k.totalSf.value} format={fmtSf} prov={k.totalSf.prov} sublabel={`${fmtNum(k.tenantCount.value)} tenants`} accentColor="var(--color-info)" onPress={goTo('portfolio')} />
      <KpiStat label="Occupancy" value={k.occupancy.value === null ? null : k.occupancy.value * 100} format={(n) => (n === null ? '—' : `${n.toFixed(1)}%`)} prov={k.occupancy.prov} sublabel="weighted by SF" accentColor="var(--color-pos)" onPress={goTo('leases')} />
      <KpiStat label="WALT" value={k.walt.value} format={fmtYears} prov={k.walt.prov} sublabel="rent-weighted" accentColor="var(--color-accent2)" onPress={goTo('leases')} />
      <KpiStat label="Total Debt" value={k.totalDebt.value} format={fmtUsdCompact} prov={k.totalDebt.prov} sublabel={overviewTotalDebtSublabel(k)} accentColor="var(--color-warn)" onPress={goTo('debt')} />
      <KpiStat label="Equity Invested" value={k.equityInvested.value} format={fmtUsdCompact} prov={k.equityInvested.prov} accentColor="var(--accent)" />
      <KpiStat label="Total Cash" value={k.totalCash.value} format={fmtUsdCompact} prov={k.totalCash.prov} spark={cashSpark} delta={cashDelta} deltaLabel="MoM" sparkColor="var(--color-pos)" accentColor="var(--color-pos)" onPress={goTo('cash')} />
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
      <CardHeader
        title="Total Cash — 12-Month Trend"
        trailing={
          <span className="inline-flex items-center gap-2">
            <AsOfChip asOf={data.snapshot.cash.asOf} source="Cash Balances" />
            <Badge tone="neutral">{series.length} mo</Badge>
          </span>
        }
      />
      <div className="px-3 pb-2 pt-3">
        <AreaChart data={series} valueFormat={fmtUsdCompact} height={230} color="var(--color-pos)" />
      </div>
    </Card>
  );
}

function LeaseRolloverWidget() {
  return <RolloverChart />;
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
          <div key={t.label} title={t.hint} style={{ cursor: t.hint ? 'help' : undefined }}>
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
        <SpineSplitCell label="Risk Impact" totals={summary.riskImpactBySpine} accentColor="var(--text-neg)" />
        <SpineSplitCell label="Monitor Impact" totals={summary.monitorImpactBySpine} accentColor="var(--text-info)" />
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
// wants a single cross-severity ranking by $ impact — "what are the N biggest things happening
// right now, regardless of severity." That ranking isn't something insights.logic.ts exports
// (its buildTiers groups by severity on purpose), so the sort/group/slice lives here as a small
// presentation-only helper; the merge, row shape (mergedToTierItem), grouping (groupByCause) and
// per-spine subtotal (totalsBySpine) are the shared, reused functions — only the top-N selection
// is new.
// Same-cause alerts roll into one row BEFORE the cut to N (twelve lapsed policies are one decision,
// not twelve slots), and lapsed coverage is pinned first — its impact is unquantified, so a pure
// dollar sort could never surface it here.
export function buildPriorityActionsTier(merged: MergedInsight[], limit: number): Tier {
  // Ids are unique by construction (conditions.ts / mergeInsightSources); dedupe defensively so the
  // id-keyed subtotal below can never count a row that is not shown, or count one twice.
  const seen = new Set<string>();
  const unique = merged.filter((m) => !seen.has(m.id) && seen.add(m.id));
  // Group WITHIN each severity (as buildTiers does), then rank the rows together: `expiring-*` ids
  // are critical or warning under one cause, and a cross-severity group would fold a critical lease
  // into a warning roll-up and hide it from the top N (refute wf_42182077-678).
  const sorted = sortByImpactDesc(unique);
  const rows = (['critical', 'warning', 'info'] as const).flatMap((severity) =>
    groupByCause(
      sorted.filter((m) => m.severity === severity).map((m, index) => mergedToTierItem(m, index + 1)),
      describeAlertCause,
      undefined,
      severity,
    ),
  );
  const items = rankRows(rows).slice(0, limit);
  const shownIds = new Set(items.flatMap((row) => (row.members ?? [row]).map((r) => r.id)));
  const top = unique.filter((m) => shownIds.has(m.id));
  return {
    key: 'priority-actions',
    title: 'Priority Actions',
    subtitle: 'Top items by $ impact; lapsed coverage pinned first',
    tone: 'accent',
    items,
    totalsBySpine: totalsBySpine(top),
  };
}

function PriorityActionsWidget() {
  const { data } = useSnapshot();
  const { analytics } = useAnalytics();
  const insightsQuery = useWarehouseInsights();
  const ui = useUi();
  if (!data || !analytics) return null;

  const candidates = insightsQuery.data?.candidates ?? [];
  const { merged } = mergeInsightSources(analytics.insights, candidates, data.snapshot);
  const tier = buildPriorityActionsTier(merged, OVERVIEW_MAX_ITEMS);

  // A single ranked tier — full width, one column, so the card doesn't render half-empty. "See
  // all" is the one link out to the full Insights tier board (Brain › Insights) — the ratified
  // "one home per attention list" IA (global-constraints.md): Overview stays a compact top-7,
  // the full board lives in one place. Navigates via useUi().openTab — the app's existing
  // module+tab nav hook (used by the command palette's "Destination > Tab" entries) — rather than
  // a react-router-dom <Link>, since 'insights' is a legacy-aliased tab id (routing.ts
  // LEGACY_ALIASES) that resolves to /command-brain?tab=insights, and openTab already carries the
  // current ?scenario/?still params the way a bare <Link to="..."> would not.
  return (
    <div className="flex flex-col gap-2">
      <TierBoard tiers={[tier]} columns={1} />
      {merged.length > 0 && (
        <button
          type="button"
          onClick={() => ui.openTab('command-brain', 'insights')}
          className="self-end text-2xs font-semibold"
          style={{ color: 'var(--accent)' }}
        >
          See all {merged.length} insights →
        </button>
      )}
    </div>
  );
}

// Reshaped to the same tier-board pattern as InsightsModule.tsx / ResultsBannerWidget /
// PriorityActionsWidget above — reuses mergeInsightSources()/buildTiers() rather than rendering
// analytics.insights as its own flat, independently-paginated list (design-parity finding #2:
// the no-long-lists rule bans a ranked, $-quantified feed as a plain <ul>).
function InsightsWidget() {
  const { data } = useSnapshot();
  const { analytics } = useAnalytics();
  const insightsQuery = useWarehouseInsights();
  if (!data || !analytics) return null;

  const candidates = insightsQuery.data?.candidates ?? [];
  const { merged } = mergeInsightSources(analytics.insights, candidates, data.snapshot);
  const tiers = buildTiers(merged);

  return (
    <Card accent>
      <CardHeader
        title="Insights & Alerts"
        trailing={<Badge tone={merged.some((m) => m.severity === 'critical') ? 'red' : 'amber'}>{merged.length} active</Badge>}
      />
      <div className="p-3">
        <TierBoard tiers={tiers} columns={3} />
      </div>
    </Card>
  );
}

/** Overview widget registry — drop a new entry here and it's available to the dashboard. Registry
 *  order IS the default layout order: KPIs, then what needs a decision, descriptive charts after (or
 *  off by default and addable via Edit layout). KPIs stay first until Priority Actions has compact
 *  rows (design step 4); full-width tall cards would otherwise push them ~1,400px down. */
export const OVERVIEW_WIDGETS: WidgetDef[] = [
  { id: 'kpis', title: 'Portfolio KPIs', span: 'full', Component: KpiStripWidget },
  { id: 'priority-actions', title: 'Priority Actions', span: 'full', Component: PriorityActionsWidget },
  { id: 'results-banner', title: 'Results', span: 'full', Component: ResultsBannerWidget },
  { id: 'cash-trend', title: 'Cash Trend', span: 'half', Component: CashTrendWidget },
  { id: 'lease-rollover', title: 'Lease Rollover', span: 'half', Component: LeaseRolloverWidget },
  { id: 'noi-market', title: 'NOI by Market', span: 'half', Component: NoiByMarketWidget, defaultOn: false },
  { id: 'top-tenants', title: 'Top Tenants', span: 'half', Component: TopTenantsWidget, defaultOn: false },
  { id: 'insights', title: 'Insights & Alerts', span: 'full', Component: InsightsWidget, defaultOn: false },
];

const LEGACY_ORDER = ['kpis', 'results-banner', 'noi-market', 'top-tenants', 'priority-actions', 'cash-trend', 'lease-rollover', 'insights'];

/** Bump `version` whenever the default layout changes. A saved workspace still equal to a previous
 *  shipped default (untouched) moves to the new default once; any layout the user arranged is kept.
 *  Two previous defaults exist: the current one (Insights hidden) and the one saved before Insights
 *  became default-hidden (nothing hidden) — a stored layout keeps the default it was created under. */
export const OVERVIEW_LAYOUT_MIGRATION: LayoutMigration = {
  version: 2,
  legacyDefaults: [
    { order: LEGACY_ORDER, hidden: ['insights'] },
    { order: LEGACY_ORDER, hidden: [] },
  ],
};

/** The subset of widgets a brand-new layout shows VISIBLE out of the box — every widget except
 *  those opted out via `defaultOn: false` (currently just the full Insights tier board, whose
 *  "one home" is Brain › Insights — PriorityActionsWidget's "See all" link gets there). This is
 *  documentation/test surface only; it is NOT passed to useWorkspaces as `allIds` (that must be
 *  every widget id, `insights` included, or the id could never be re-added via Edit layout — see
 *  DEFAULT_HIDDEN_WIDGET_IDS below, which is what actually keeps it addable-but-hidden). */
export const DEFAULT_WIDGET_ORDER = OVERVIEW_WIDGETS.filter((w) => w.defaultOn !== false).map((w) => w.id);

/** Every widget id, as a single stable module-level reference — passed to useWorkspaces as
 *  `allIds` so its memoized `activeCfg`/`visibleOrder` don't recompute on every OverviewModule
 *  render just because `OVERVIEW_WIDGETS.map(...)` created a fresh array identity each time. */
export const ALL_WIDGET_IDS = OVERVIEW_WIDGETS.map((w) => w.id);

/** Ids that start hidden the first time a layout meets them, passed to useWorkspaces as
 *  `defaultHidden` alongside the FULL id list (OVERVIEW_WIDGETS.map((w) => w.id)) as `allIds`.
 *  Keeping the widget in `allIds` (rather than filtering it out, as DEFAULT_WIDGET_ORDER does)
 *  is what keeps it in every layout's `order` and reachable via Edit layout's "+ <widget>"
 *  affordance — only `hidden` decides whether it's rendered. */
export const DEFAULT_HIDDEN_WIDGET_IDS = OVERVIEW_WIDGETS.filter((w) => w.defaultOn === false).map((w) => w.id);
