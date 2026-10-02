// Portfolio > Expenses tab (Trends Wave 3B). Monthly operating-expense trends from the warehouse feed.
// Read-only reporting: never feeds scoring or capital-allocation. Missing values render "—", never 0.
import { useMemo, useState, type ReactNode } from 'react';
import { useMeasure } from '@/lib/useMeasure';
import type { HeatCell } from '@/charts/Heatmap';
import { useSnapshot } from '@/data/queries';
import { useSnapshotGate } from '@/shell/SnapshotGate';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { Button } from '@/primitives/Button';
import { Skeleton } from '@/primitives/Skeleton';
import { StackedBarChart } from '@/charts/StackedBarChart';
import { Heatmap } from '@/charts/Heatmap';
import { Sparkline } from '@/charts/Sparkline';
import { colorAt } from '@/charts/theme';
import { isWarehouseUnavailable } from '@/modules/intel/hooks';
import { fmtPct, fmtUsd, fmtUsdCompact, isInvestmentProperty } from '@analytics/index';
import { addMonths, monthRange, type MonthKey } from '@analytics/portfolio-trends';
import {
  buildPortfolioSeries,
  buildPropertySeries,
  MixedBasisError,
  sameMonthLastYear,
  topMovers,
  varianceVsTrailing,
  type ExpenseMonthTotal,
} from '@analytics/expense-trends';
import {
  completeMonthTotals,
  heatmapCells,
  heatmapColLabels,
  monthLabel,
  moverLines,
  overlayLastYear,
  stackedExpenseData,
  topCategories,
  unavailablePropertyIds,
} from './expenses-chart-data';
import { useExpensesMonthly } from './expenses-hooks';

const ALL = '__portfolio__';
const WINDOW = 12;
const MINUS = '−';

/** Signed percent from a FRACTION: +13.9% / −3.2% / 0.0%; null -> em dash (never 0). */
function fmtSigned(f: number | null): string {
  if (f === null || !Number.isFinite(f)) return '—';
  const abs = fmtPct(Math.abs(f));
  return abs === fmtPct(0) ? abs : `${f < 0 ? MINUS : '+'}${abs}`;
}
const pctChange = (now: number, prior: number | undefined | null): number | null =>
  prior === undefined || prior === null || prior === 0 ? null : (now - prior) / prior;
/** KpiStat takes a number; percent tiles pass the PERCENT value and format it back to signed text. */
const fmtPctTile = (n: number | null): string => (n === null ? '—' : fmtSigned(n / 100));

function Caption({ children, testId }: { children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="num whitespace-normal px-1 text-2xs" style={{ color: 'var(--text-tertiary)' }}>{children}</div>
  );
}

/** Below this width the Heatmap's column labels clip to one or two characters, so month NAMES become
 *  month NUMBERS (unique, <= 2 chars). Unmeasured (width 0) is treated as wide. */
const NARROW_HEATMAP_PX = 520;

function MonthHeatmap({ cells, rows, rowLabels, months }: { cells: HeatCell[]; rows: string[]; rowLabels: Record<string, string>; months: MonthKey[] }) {
  const [ref, width] = useMeasure<HTMLDivElement>();
  const narrow = width > 0 && width < NARROW_HEATMAP_PX;
  const labels = narrow ? months.map((m) => String(Number(m.slice(5, 7)))) : heatmapColLabels(months);
  const labelOf = new Map(months.map((m, i) => [m, labels[i]!]));
  return (
    <div ref={ref}>
      <Heatmap
        cells={cells.map((c) => ({ ...c, col: labelOf.get(c.col) ?? c.col }))}
        rows={rows}
        rowLabels={rowLabels}
        cols={labels}
        height={Math.min(420, 30 + 28 * rows.length)}
        valueFormat={fmtSigned}
        ariaLabel="Property by month operating expense variance versus trailing 12-month average"
      />
      {narrow && <p className="num mt-1 text-2xs" style={{ color: 'var(--text-tertiary)' }}>Columns are months (1 = Jan, 12 = Dec).</p>}
    </div>
  );
}

interface SparkCardModel {
  id: string;
  name: string;
  unavailable: boolean;
  latest: number | null;
  latestMonth: MonthKey | null;
  yoy: number | null;
  variance: number | null;
  spark: number[];
}

export function ExpensesView() {
  const { data: snap } = useSnapshot();
  const gate = useSnapshotGate();
  const q = useExpensesMonthly();
  const [scope, setScope] = useState<string>(ALL);

  const feed = q.data;
  const model = useMemo(() => {
    if (!snap || !feed || feed.points.length === 0) return null;
    const points = feed.points;
    const investment = snap.snapshot.properties.filter(isInvestmentProperty);
    const names: Record<string, string> = {};
    for (const p of investment) names[p.id] = p.name;
    const hasPoints = new Set(points.map((p) => p.propertyId));
    const loadedIds = investment.filter((p) => hasPoints.has(p.id)).map((p) => p.id);
    const effectiveScope = scope !== ALL && names[scope] !== undefined ? scope : ALL;
    // Points exist but none belong to an investment property: same state as an empty feed.
    if (effectiveScope === ALL && loadedIds.length === 0) return null;
    const scopeIds = effectiveScope === ALL ? loadedIds : [effectiveScope];

    const port = buildPortfolioSeries(points, scopeIds, { skipMixedBasis: true });
    const unavailable = [...new Set([...port.excluded, ...unavailablePropertyIds(points, scopeIds)])];
    // Portfolio-wide count of mixed-basis entities (for the coverage badge, whatever the scope).
    const excludedAll = unavailablePropertyIds(points, loadedIds).length;
    // "Latest month" = latest month EVERY contributing (in-scope, non-excluded, with data) entity has.
    const feedLast = port.months.at(-1)?.month ?? null;
    const contributing = scopeIds.filter((id) => hasPoints.has(id) && !unavailable.includes(id));
    let common: MonthKey[] | null = null;
    for (const id of contributing) {
      const months = new Set(points.filter((p) => p.propertyId === id).map((p) => p.month));
      common = common === null ? [...months] : common.filter((m: MonthKey) => months.has(m));
    }
    const latest: MonthKey | null = common && common.length > 0 ? [...common].sort().at(-1)! : null;
    return { points, investment, names, loadedIds, effectiveScope, scopeIds, port, unavailable, latest, feedLast, excludedAll };
  }, [snap, feed, scope]);

  if (gate) return gate;
  if (!snap) return null;

  if (!model) {
    if (q.isLoading && !feed) {
      return (
        <div data-testid="expenses-loading" className="flex flex-col gap-4">
          <div className="grid grid-cols-2 items-start gap-3 md:grid-cols-4">
            {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-24" />)}
          </div>
          <Skeleton className="h-64" />
        </div>
      );
    }
    if (q.isError && !isWarehouseUnavailable(q.error)) {
      const msg = q.error instanceof Error ? q.error.message : 'Request failed';
      return (
        <Card>
          <CardHeader title="Expenses" />
          <div className="flex flex-wrap items-center gap-3 p-4">
            <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>Monthly expenses could not be loaded: {msg}</p>
            <Button size="sm" onPress={() => { void q.refetch(); }}>Retry</Button>
          </div>
        </Card>
      );
    }
    return (
      <Card>
        <CardHeader title="Expenses" />
        <div className="p-4">
          <p className="text-sm font-semibold" style={{ color: 'var(--text-secondary)' }}>Monthly P&L data has not been loaded yet</p>
          <p className="mt-1 text-xs" style={{ color: 'var(--text-tertiary)' }}>
            Monthly P&L exports have to be ingested into the warehouse before expense trends can be shown.
          </p>
        </div>
      </Card>
    );
  }

  const { points, investment, names, loadedIds, effectiveScope, scopeIds, port, unavailable, latest, feedLast, excludedAll } = model;
  const isAll = effectiveScope === ALL;
  const coverage = feed!.coverage;
  const partial = coverage.propertiesLoaded < coverage.propertiesExpected;
  // Badge counts entities actually contributing to totals (mixed-basis ones are excluded).
  const contributingCount = Math.max(0, coverage.propertiesLoaded - excludedAll);
  const mixedAcross = isAll && port.mixedBasis;

  const header = (
    <div className="flex flex-wrap items-center gap-3">
      <select aria-label="Scope" value={effectiveScope} onChange={(e) => setScope(e.target.value)}>
        <option value={ALL}>Entire portfolio</option>
        {investment.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
      </select>
      {partial && <Badge tone="amber">{contributingCount} of {coverage.propertiesExpected} entities loaded</Badge>}
    </div>
  );
  const notes = (
    <div className="flex flex-col gap-1">
      {partial && <Caption>Totals cover loaded entities only.{excludedAll > 0 ? ` (plus ${excludedAll} excluded (mixed basis))` : ''}</Caption>}
      {unavailable.length > 0 && (
        <Caption>
          {unavailable.length} {unavailable.length === 1 ? 'entity' : 'entities'} excluded from totals — mixed cash/accrual basis
        </Caption>
      )}
      {mixedAcross && (
        <Caption>
          {port.basisMix.cash} {port.basisMix.cash === 1 ? 'entity' : 'entities'} on cash, {port.basisMix.accrual} on accrual — totals add figures from both bases.
        </Caption>
      )}
    </div>
  );

  // Nothing summable for this scope (e.g. the single selected entity is mixed-basis, or has no points).
  if (feedLast === null) {
    const msg = unavailable.length > 0 ? 'unavailable — mixed basis' : 'No monthly P&L loaded for this entity';
    return (
      <div className="flex flex-col gap-4">
        {header}
        {notes}
        <Card>
          <CardHeader title={isAll ? 'Expenses' : (names[effectiveScope] ?? 'Expenses')} />
          <p className="p-4 text-sm" style={{ color: 'var(--text-tertiary)' }}>{msg}</p>
        </Card>
      </div>
    );
  }

  if (latest === null) {
    return (
      <div className="flex flex-col gap-4">
        {header}
        {notes}
        <div data-testid="kpi-grid" className="grid grid-cols-2 items-start gap-3 md:grid-cols-4">
          {['Latest opex', 'MoM change', 'YoY (same month)', 'Trailing-12 avg'].map((label) => (
            <div key={label} className="flex flex-col gap-1"><KpiStat label={label} value={null} format={fmtUsdCompact} /></div>
          ))}
        </div>
        <Caption>Entities have no common month yet</Caption>
      </div>
    );
  }

  const series = port.months;
  const byMonth = new Map(series.map((s) => [s.month, s]));
  const latestRow = byMonth.get(latest)!;
  // Comparisons are like-for-like: only the entities contributing at `latest`, and only months in which
  // EVERY one of them has data. A missing comparison month yields null (rendered as an em dash).
  const kpiSet = scopeIds.filter((id) => !unavailable.includes(id) && points.some((p) => p.propertyId === id && p.month === latest));
  const prevMonth = addMonths(latest, -1);
  const yoyMonth = addMonths(latest, -12);
  const t12Months = monthRange(addMonths(latest, -(WINDOW - 1)), latest);
  const like = completeMonthTotals(points, kpiSet, [...new Set([prevMonth, yoyMonth, ...t12Months])]);
  const latestTotal = like.get(latest) ?? latestRow.total;
  const prevTotal = like.get(prevMonth);
  const yoyTotal = like.get(yoyMonth);
  const t12 = t12Months.every((m) => like.has(m)) ? t12Months.reduce((a, m) => a + like.get(m)!, 0) / WINDOW : null;
  const mom = pctChange(latestTotal, prevTotal);
  const yoy = pctChange(latestTotal, yoyTotal);
  const NEEDS_SAME = 'needs the same entities for comparison';
  const momNote = prevTotal !== undefined ? `vs ${monthLabel(prevMonth)} · higher is more spend` : byMonth.has(prevMonth) ? NEEDS_SAME : 'no prior month';
  const yoyNote = yoyTotal !== undefined ? `vs ${monthLabel(yoyMonth)}` : byMonth.has(yoyMonth) ? NEEDS_SAME : 'no same month last year';
  const t12Note =
    t12 !== null ? `mean of 12 months to ${monthLabel(latest)}` : t12Months.every((m) => byMonth.has(m)) ? NEEDS_SAME : 'needs 12 consecutive months';

  const windowMonths = monthRange(addMonths(latest, -(WINDOW - 1)), latest);
  const inWindow = new Set(windowMonths);
  const windowSeries = series.filter((s) => inWindow.has(s.month));
  const top = topCategories(points, scopeIds, 5);
  const windowCats = new Set(windowSeries.flatMap((s) => Object.keys(s.byCategory)));
  // The fold bucket must never collide with a real category that ranks in the top 5.
  let otherKey = 'Other';
  while (top.includes(otherKey)) otherKey += ' (rest)';
  const keys = windowCats.size > top.length ? [...top, otherKey] : top;
  const stacked = stackedExpenseData(windowSeries, keys, otherKey);
  const overlay = overlayLastYear(series, windowMonths);

  const scopeName = isAll ? 'portfolio' : (names[effectiveScope] ?? effectiveScope);
  const movers = topMovers(points, scopeIds, latest, 5).filter((m) => m.delta !== 0);
  const moverText = moverLines(movers, names);

  // Portfolio-only views: heatmap + small-multiples.
  let cards: SparkCardModel[] = [];
  let heatRows: string[] = [];
  let heatLabels: Record<string, string> = {};
  let heatData: ReturnType<typeof heatmapCells> = [];
  if (isAll) {
    for (const id of loadedIds) {
      const name = names[id] ?? id;
      let s;
      try {
        s = buildPropertySeries(points, id);
      } catch (err) {
        if (err instanceof MixedBasisError) {
          cards.push({ id, name, unavailable: true, latest: null, latestMonth: null, yoy: null, variance: null, spark: [] });
          continue;
        }
        throw err;
      }
      if (!s) continue;
      const own = s.months.at(-1)!;
      cards.push({
        id,
        name,
        unavailable: false,
        latest: own.total,
        latestMonth: own.month,
        yoy: pctChange(own.total, sameMonthLastYear(s.months, own.month)?.total),
        variance: varianceVsTrailing(s.months, latest, WINDOW)?.deltaPct ?? null,
        spark: s.months.filter((m: ExpenseMonthTotal) => inWindow.has(m.month)).map((m) => m.total),
      });
    }
    // Worst-first: largest positive variance first, nulls last, then name.
    const rank = (c: SparkCardModel) => (c.unavailable || c.variance === null ? null : c.variance);
    cards = cards.sort((a, b) => {
      const ra = rank(a);
      const rb = rank(b);
      if (ra === null && rb === null) return Number(a.unavailable) - Number(b.unavailable) || a.name.localeCompare(b.name);
      if (ra === null) return 1;
      if (rb === null) return -1;
      return rb - ra || a.name.localeCompare(b.name);
    });
    const live = cards.filter((c) => !c.unavailable);
    heatRows = live.map((c) => c.id);
    heatLabels = Object.fromEntries(live.map((c) => [c.id, c.name]));
    heatData = heatmapCells(points, live.map((c) => c.id), windowMonths, WINDOW);
  }

  const latestLabel = monthLabel(latest);
  const kpiGrid = 'grid grid-cols-2 items-start gap-3 md:grid-cols-4';

  return (
    <div className="flex flex-col gap-4">
      {header}
      {notes}

      <div data-testid="kpi-grid" className={kpiGrid}>
        <div className="flex flex-col gap-1">
          <KpiStat label="Latest opex" value={latestTotal} format={fmtUsdCompact} />
          <Caption>{latestLabel} · {isAll ? (partial ? 'loaded entities only' : 'all loaded entities') : scopeName}</Caption>
        </div>
        <div className="flex flex-col gap-1">
          <KpiStat label="MoM change" value={mom === null ? null : mom * 100} format={fmtPctTile} />
          <Caption>{momNote}</Caption>
        </div>
        <div className="flex flex-col gap-1">
          <KpiStat label="YoY (same month)" value={yoy === null ? null : yoy * 100} format={fmtPctTile} />
          <Caption>{yoyNote}</Caption>
        </div>
        <div className="flex flex-col gap-1">
          <KpiStat label="Trailing-12 avg" value={t12} format={fmtUsdCompact} />
          <Caption>{t12Note}</Caption>
        </div>
      </div>
      {feedLast !== null && feedLast > latest && (
        <Caption>Latest complete month: {latestLabel} (some entities report through {monthLabel(feedLast)})</Caption>
      )}

      <Card>
        <CardHeader
          title="Opex by category"
          trailing={mixedAcross ? <Badge tone="amber">Mixed basis (cash + accrual)</Badge> : undefined}
        />
        <div className="p-3">
          <ul data-testid="expense-legend" className="mb-2 flex flex-wrap gap-x-4 gap-y-1 text-2xs" style={{ color: 'var(--text-secondary)' }}>
            {keys.map((k, i) => (
              <li key={k} className="inline-flex items-center gap-1.5">
                <span aria-hidden className="inline-block h-2.5 w-2.5 rounded-[2px]" style={{ background: colorAt(i) }} />
                {k}
              </li>
            ))}
          </ul>
          <StackedBarChart data={stacked} keys={keys} valueFormat={fmtUsdCompact} ariaLabel="Monthly operating expenses by category" overlay={overlay} />
        </div>
      </Card>
      <Caption>Last 12 months, top 5 categories by trailing-12 spend; the line is the same month one year earlier.</Caption>

      {isAll && (
        <>
          <Card>
            <CardHeader title="Variance vs own trailing-12 average" />
            <div className="p-3">
              <MonthHeatmap cells={heatData} rows={heatRows} rowLabels={heatLabels} months={windowMonths} />
            </div>
          </Card>
          <Caption>Red = above own trailing-12 average (more spend), green = below; hatched = not enough history.</Caption>

          <div className="grid grid-cols-1 items-start gap-3 sm:grid-cols-2 xl:grid-cols-3">
            {cards.map((c) => (
              <Card key={c.id}>
                <div data-testid="spark-card" data-property={c.id} className="flex flex-col gap-2 p-3">
                  <div className="truncate text-sm font-semibold" style={{ color: 'var(--text-primary)' }} title={c.name}>{c.name}</div>
                  {c.unavailable ? (
                    <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>unavailable — mixed basis</p>
                  ) : (
                    <div className="flex items-end justify-between gap-3">
                      <div className="min-w-0">
                        <div className="num text-lg font-semibold leading-none" style={{ color: 'var(--text-primary)' }}>{fmtUsdCompact(c.latest)}</div>
                        <div className="num mt-1 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
                          {c.latestMonth ? monthLabel(c.latestMonth) : '—'} · YoY {fmtSigned(c.yoy)}
                        </div>
                      </div>
                      <div className="shrink-0"><Sparkline data={c.spark} width={110} color="var(--color-neg)" /></div>
                    </div>
                  )}
                </div>
              </Card>
            ))}
          </div>
          <Caption>Sorted worst-first by latest-month variance. Entities with mixed cash and accrual books are excluded from every total.</Caption>
        </>
      )}

      <Card>
        <CardHeader title={`Top movers · ${latestLabel}`} />
        <div className="p-3" data-testid="movers">
          {moverText.length === 0 ? (
            <p className="text-xs" style={{ color: 'var(--text-tertiary)' }}>No movers: each category needs 12 prior months of history.</p>
          ) : (
            <ul className="flex list-disc flex-col gap-1.5 pl-4 text-sm" style={{ color: 'var(--text-secondary)' }}>
              {moverText.map((t) => <li key={t}>{t}</li>)}
            </ul>
          )}
        </div>
      </Card>
      <Caption>Largest dollar changes by category versus the trailing-12-month average, {scopeName}. Total {fmtUsd(latestRow.total)} in {latestLabel}.</Caption>
    </div>
  );
}
