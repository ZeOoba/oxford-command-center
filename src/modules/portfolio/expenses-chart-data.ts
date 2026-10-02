// Portfolio Trends Wave 3B — pure mappers from expense engine output to chart inputs and sentences.
// No Date.now, no I/O.
import type { ExpenseMonthPoint } from '@contracts/expenses-monthly';
import type { StackedBarDatum } from '@/charts/StackedBarChart';
import type { HeatCell } from '@/charts/Heatmap';
import { addMonths, monthRange, type MonthKey } from '../../analytics/portfolio-trends';
import {
  buildPropertySeries,
  MixedBasisError,
  sameMonthLastYear,
  varianceVsTrailing,
  type ExpenseMonthTotal,
  type ExpenseMover,
} from '../../analytics/expense-trends';
import { fmtPct, fmtUsd } from '../../analytics/format';

const ABBR = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const MINUS = '−';

/** 'YYYY-MM' -> "Oct '26". */
export function monthLabel(month: MonthKey): string {
  const mi = Number(month.slice(5, 7)) - 1;
  return `${ABBR[mi] ?? month.slice(5, 7)} '${month.slice(2, 4)}`;
}

/** 'YYYY-MM' -> single-letter initial (J F M A M J J A S O N D). */
export function monthInitial(month: MonthKey): string {
  const mi = Number(month.slice(5, 7)) - 1;
  return (ABBR[mi] ?? month.slice(5, 7)).charAt(0);
}

/** Heatmap column labels: 3-letter month abbreviations. The Heatmap clips column labels at narrow
 *  widths, so the view may pass `monthInitial` single letters on mobile instead. */
export function heatmapColLabels(months: MonthKey[]): string[] {
  return months.map((m) => ABBR[Number(m.slice(5, 7)) - 1] ?? m.slice(5, 7));
}

/** Ids (sorted asc) among `propertyIds` whose own points carry BOTH bases. Ids with no points are not reported. */
export function unavailablePropertyIds(points: ExpenseMonthPoint[], propertyIds: readonly string[]): string[] {
  const ids = new Set(propertyIds);
  const bases = new Map<string, Set<string>>();
  for (const p of points) {
    if (!ids.has(p.propertyId)) continue;
    let b = bases.get(p.propertyId);
    if (!b) bases.set(p.propertyId, (b = new Set()));
    b.add(p.basis);
  }
  return [...bases.entries()]
    .filter(([, b]) => b.size > 1)
    .map(([id]) => id)
    .sort();
}

/**
 * Top `n` categories by TRAILING-12 total (the 12 calendar months ending at the latest month present
 * for the supplied properties). Ties break by name asc. `Other` is NOT included; the caller appends it.
 */
export function topCategories(points: ExpenseMonthPoint[], propertyIds: readonly string[], n = 5): string[] {
  const ids = new Set(propertyIds);
  for (const id of unavailablePropertyIds(points, propertyIds)) ids.delete(id); // basis discipline
  const own = points.filter((p) => ids.has(p.propertyId));
  if (own.length === 0) return [];
  let latest = own[0]!.month;
  for (const p of own) if (p.month > latest) latest = p.month;
  const inWindow = new Set(monthRange(addMonths(latest, -11), latest));
  const sums = new Map<string, number>();
  for (const p of own) {
    if (!inWindow.has(p.month)) continue;
    sums.set(p.category, (sums.get(p.category) ?? 0) + p.amount);
  }
  return [...sums.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, Math.max(0, n))
    .map(([cat]) => cat);
}

/** One datum per month with data; segments in `keys` order. Categories not listed in `keys` fold into the
 *  `otherKey` bucket when `keys` contains it, else they are dropped. `otherKey` must not be a real category
 *  that is also listed in `keys` (the view picks a non-colliding key). */
export function stackedExpenseData(series: ExpenseMonthTotal[], keys: string[], otherKey = 'Other'): StackedBarDatum[] {
  const listed = new Set(keys.filter((k) => k !== otherKey));
  const hasOther = keys.includes(otherKey);
  const out: StackedBarDatum[] = [];
  for (const row of series) {
    if (Object.keys(row.byCategory).length === 0) continue;
    let other = 0;
    for (const [cat, amt] of Object.entries(row.byCategory)) if (!listed.has(cat)) other += amt;
    out.push({
      label: monthLabel(row.month),
      segments: keys.map((key) => ({ key, value: key === otherKey ? other : (row.byCategory[key] ?? 0) })),
    });
  }
  return hasOther ? out : out.map((d) => ({ ...d, segments: d.segments.filter((s) => s.key !== otherKey) }));
}

/** Same-month-last-year totals for each displayed month; months with no prior-year value are omitted. */
export function overlayLastYear(series: ExpenseMonthTotal[], months: MonthKey[]): Array<{ label: string; value: number }> {
  const out: Array<{ label: string; value: number }> = [];
  for (const m of months) {
    const prior = sameMonthLastYear(series, m);
    if (prior && Object.keys(prior.byCategory).length > 0) out.push({ label: monthLabel(m), value: prior.total });
  }
  return out;
}

/** Variance-vs-trailing heatmap cells. Properties with no data or mixed basis are skipped (the view
 *  shows them as unavailable). value = deltaPct, or null when the baseline is unavailable / zero. */
export function heatmapCells(
  points: ExpenseMonthPoint[],
  propertyIds: readonly string[],
  months: MonthKey[],
  window = 12,
): HeatCell[] {
  const cells: HeatCell[] = [];
  for (const id of new Set(propertyIds)) {
    let series;
    try {
      series = buildPropertySeries(points, id);
    } catch (err) {
      if (err instanceof MixedBasisError) continue;
      throw err;
    }
    if (!series) continue;
    for (const m of months) {
      cells.push({ row: id, col: m, value: varianceVsTrailing(series.months, m, window)?.deltaPct ?? null });
    }
  }
  return cells;
}

/** e.g. "Utilities at 1100 Rarig +$60 (+40.0%) vs trailing 12 mo". True minus for negatives. */
export function moverLines(movers: ExpenseMover[], propertyNames: Record<string, string>): string[] {
  return movers.map((m) => {
    const name = propertyNames[m.propertyId] ?? m.propertyId;
    // Sign the ROUNDED display value: never +$0 / -$0 / -0.0%.
    const absUsd = fmtUsd(Math.abs(m.delta));
    const money = absUsd === fmtUsd(0) ? absUsd : `${m.delta < 0 ? MINUS : '+'}${absUsd}`;
    let pct = '';
    if (m.deltaPct !== null) {
      const absPct = fmtPct(Math.abs(m.deltaPct));
      pct = ` (${absPct === fmtPct(0) ? absPct : `${m.deltaPct < 0 ? MINUS : '+'}${absPct}`})`;
    }
    return `${m.category} at ${name} ${money}${pct} vs trailing 12 mo`;
  });
}

/**
 * Like-for-like monthly totals: for each of `months`, the sum over `ids` — but ONLY when EVERY id has at
 * least one point in that month. Months where any entity is missing are absent from the result, so a
 * comparison never mixes different entity sets.
 */
export function completeMonthTotals(points: ExpenseMonthPoint[], ids: readonly string[], months: readonly MonthKey[]): Map<MonthKey, number> {
  const want = new Set(ids);
  const wanted = new Set(months);
  const sums = new Map<MonthKey, number>();
  const present = new Map<MonthKey, Set<string>>();
  for (const p of points) {
    if (!want.has(p.propertyId) || !wanted.has(p.month)) continue;
    sums.set(p.month, (sums.get(p.month) ?? 0) + p.amount);
    let s = present.get(p.month);
    if (!s) present.set(p.month, (s = new Set()));
    s.add(p.propertyId);
  }
  const out = new Map<MonthKey, number>();
  for (const [m, total] of sums) if ((present.get(m)?.size ?? 0) === want.size) out.set(m, total);
  return out;
}
