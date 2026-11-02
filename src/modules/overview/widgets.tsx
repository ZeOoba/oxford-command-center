/* eslint-disable react-refresh/only-export-components -- colocated widget registry + components */
import type { ComponentType } from 'react';
import { useSnapshot, useAnalytics } from '@/data/queries';
import { useUi } from '@/brain/ui-context';
import { fmtUsdCompact, fmtSf, fmtPct, fmtYears, fmtNum } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
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
import { groupByCause, previewSubjects, signalCount } from '../../lib/tier-group';
import type { TierItem } from '@/primitives/TierBoard';
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
        <BarChart data={marketData} valueFormat={fmtUsdCompact} height={250} ariaLabel="NOI by market (workbook basis, Oxford share)" />
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
        <AreaChart data={series} valueFormat={fmtUsdCompact} height={230} color="var(--color-pos)" ariaLabel="Total cash balance, 12-month trend" />
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
// not twelve slots), and pinned safety alerts (lapsed coverage, DSCR / LTV breaches, reconciliation
// failure — see src/brain/alert-cause.ts) rank first: their impact is unquantified, so a pure dollar
// sort could never surface them here.
// The cap applies to UNPINNED rows only: a pinned row is never cut, even when pinned rows alone
// exceed `limit` (a cause collapses only at MIN_GROUP_SIZE, so two-member pinned causes stay separate
// rows and can outnumber the cap). `heldBack` counts what the cap did cut — rows and the signals they
// stand for — so an indicator built on it can never go negative or miss a held-back group's members.
// When a pinned warning / info row shows, no critical row may be held back behind it (#505, C4); the
// critical rows that do not fit fold into ONE expandable roll-up row (OVERFLOW_ROW_ID), so the board
// shows <= max(`limit`, pinned rows) + 1 rows — pinned rows are never cut, so they alone can exceed
// `limit` — and every critical signal is still on it (round 2, 2026-10-30).
export interface PriorityActionsTier extends Tier {
  heldBack: { rows: number; signals: number };
}

/** Id of the roll-up row that carries the critical rows beyond the cap (see buildPriorityActionsTier). */
export const OVERFLOW_ROW_ID = 'group:critical:overflow';

/** The underlying signal ids a row stands for, through nested roll-ups (the overflow row's members
 *  can themselves be cause groups). */
function leafIds(row: TierItem): string[] {
  return row.members ? row.members.flatMap(leafIds) : [row.id];
}

function overflowRow(rows: TierItem[]): TierItem {
  const quantified = rows.filter((r) => r.impactUsd !== null && r.impactUsd !== undefined);
  return {
    id: OVERFLOW_ROW_ID,
    category: 'critical',
    categoryTone: 'red',
    impactKind: 'risk',
    // Unquantified members stay unquantified: never a $0 figure.
    impactUsd: quantified.length > 0 ? quantified.reduce((n, r) => n + (r.impactUsd as number), 0) : null,
    title: `${rows.length} more critical`,
    detail: previewSubjects(rows),
    members: rows,
  };
}

export function buildPriorityActionsTier(merged: MergedInsight[], limit: number): PriorityActionsTier {
  // Ids are unique by construction (conditions.ts / mergeInsightSources); dedupe defensively so the
  // id-keyed subtotal below can never count a row that is not shown, or count one twice.
  const seen = new Set<string>();
  const unique = merged.filter((m) => !seen.has(m.id) && seen.add(m.id));
  // Group WITHIN each severity (as buildTiers does), then rank the rows together: `expiring-*` ids
  // are critical or warning under one cause, and a cross-severity group would fold a critical lease
  // into a warning roll-up and hide it from the top N (refute wf_42182077-678).
  const sorted = sortByImpactDesc(unique);
  // One ranked list per severity (pinned first, then dollars — groupByCause ranks within the scope),
  // concatenated critical → warning → info: that concatenation IS the display order.
  const tiers = (['critical', 'warning', 'info'] as const).map((severity) =>
    groupByCause(
      sorted.filter((m) => m.severity === severity).map((m, index) => mergedToTierItem(m, index + 1)),
      describeAlertCause,
      undefined,
      severity,
    ),
  );
  // Selection (adversarial review 2026-10-30, C4; round 2): every pinned row is shown (it may exceed
  // `limit` on its own). Free slots go to the other rows in display order, so critical rows take them
  // first. When a pinned row of a LESS severe tier shows, every critical row must stay reachable — a
  // pinned warning (DSCR covenant watch, LTV ceiling) must never push a critical dollar row (balloon,
  // arrears) off the surface — so the critical rows left without a slot fold into one roll-up row
  // instead of being held back. Clamped to the critical tier: an info-severity pinned id can force
  // critical rows, never the warning tier.
  const lowestPinnedTier = tiers.reduce((acc, rows, i) => (rows.some((row) => row.pinned) ? i : acc), -1);
  const forcedTiers = Math.min(lowestPinnedTier, 1); // tiers [0, forcedTiers) must stay reachable
  const display = tiers.flat();
  const selected = new Set(display.filter((row) => row.pinned));
  let free = Math.max(0, limit - selected.size);
  for (const row of display) {
    if (free === 0) break;
    if (selected.has(row)) continue;
    selected.add(row);
    free--;
  }
  let overflow = tiers.slice(0, Math.max(0, forcedTiers)).flat().filter((row) => !selected.has(row));
  if (overflow.length === 1) {
    // A one-row roll-up costs the same slot as the row itself: show the row.
    selected.add(overflow[0]!);
    overflow = [];
  }
  const inOverflow = new Set(overflow);
  const rollup = overflow.length > 0 ? [overflowRow(overflow)] : [];
  const items = [
    ...tiers[0]!.filter((row) => selected.has(row)),
    ...rollup,
    ...tiers.slice(1).flat().filter((row) => selected.has(row)),
  ].map((row, i) => ({ ...row, rank: i + 1 }));
  const held = display.filter((row) => !selected.has(row) && !inOverflow.has(row));
  const shownIds = new Set(items.flatMap(leafIds));
  const top = unique.filter((m) => shownIds.has(m.id));
  return {
    key: 'priority-actions',
    title: 'Priority Actions',
    subtitle: 'Critical first, safety alerts pinned, then by $ impact',
    tone: 'accent',
    items,
    totalsBySpine: totalsBySpine(top),
    heldBack: { rows: held.length, signals: held.reduce((n, row) => n + signalCount(row), 0) },
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
        <div className="flex items-center justify-end gap-2">
          {tier.heldBack.signals > 0 && (
            <span className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>
              {tier.heldBack.signals} more held back
            </span>
          )}
          <button
            type="button"
            onClick={() => ui.openTab('command-brain', 'insights')}
            className="text-2xs font-semibold"
            style={{ color: 'var(--accent)' }}
          >
            See all {merged.length} insights →
          </button>
        </div>
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

/** The June 3 – July 6 default, `['kpis','noi-market','top-tenants','cash-trend','lease-rollover',
 *  'insights']` with nothing hidden, AS NORMALIZED: useWorkspaces compares a saved layout after
 *  normalize() appends the widgets it has never seen (priority-actions, results-banner; neither is
 *  default-hidden, so `hidden` stays empty). Listing the raw June order would never match. */
const JUNE_DEFAULT_ORDER = ['kpis', 'noi-market', 'top-tenants', 'cash-trend', 'lease-rollover', 'insights', 'priority-actions', 'results-banner'];

/** Add a step (with the next `toVersion`) whenever the default layout changes. A saved workspace
 *  still equal to a previous shipped default (untouched) moves to the new default once; any layout
 *  the user arranged is kept. Each step lists the previous defaults it migrates, in normalized form,
 *  and applies only to states stamped below its `toVersion` (adversarial review 2026-10-30, C5): a
 *  v2 user who deliberately restored the legacy order after #514 is not overwritten by step 3.
 *  - v2 (#514): the default saved before Insights became default-hidden (nothing hidden) and the one
 *    with Insights hidden — a stored layout keeps the default it was created under.
 *  - v3: the June 3 – July 6 default, which v2 missed. */
export const OVERVIEW_LAYOUT_MIGRATION: LayoutMigration = {
  steps: [
    {
      toVersion: 2,
      defaults: [
        { order: LEGACY_ORDER, hidden: ['insights'] },
        { order: LEGACY_ORDER, hidden: [] },
      ],
    },
    { toVersion: 3, defaults: [{ order: JUNE_DEFAULT_ORDER, hidden: [] }] },
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
