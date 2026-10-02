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

/**
 * Top `n` categories by TRAILING-12 total (the 12 calendar months ending at the latest month present
 * for the supplied properties). Ties break by name asc. `Other` is NOT included; the caller appends it.
 */
export function topCategories(points: ExpenseMonthPoint[], propertyIds: readonly string[], n = 5): string[] {
  const ids = new Set(propertyIds);
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

/** One datum per month with data; segments in `keys` order. Unlisted categories fold into `Other` only
 *  when `keys` contains 'Other', else they are dropped. */
export function stackedExpenseData(series: ExpenseMonthTotal[], keys: string[]): StackedBarDatum[] {
  const listed = new Set(keys);
  const hasOther = listed.has('Other');
  const out: StackedBarDatum[] = [];
  for (const row of series) {
    if (Object.keys(row.byCategory).length === 0) continue;
    let other = 0;
    for (const [cat, amt] of Object.entries(row.byCategory)) if (!listed.has(cat)) other += amt;
    out.push({
      label: monthLabel(row.month),
      segments: keys.map((key) =>
        key === 'Other' ? { key, value: (row.byCategory['Other'] ?? 0) + other } : { key, value: row.byCategory[key] ?? 0 },
      ),
    });
  }
  return hasOther ? out : out.map((d) => ({ ...d, segments: d.segments.filter((s) => s.key !== 'Other') }));
}

/** Same-month-last-year totals for each displayed month; months with no prior-year value are omitted. */
export function overlayLastYear(series: ExpenseMonthTotal[], months: MonthKey[]): Array<{ label: string; value: number }> {
  const out: Array<{ label: string; value: number }> = [];
  for (const m of months) {
    const prior = sameMonthLastYear(series, m);
    if (prior) out.push({ label: monthLabel(m), value: prior.total });
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
    const neg = m.delta < 0;
    const money = `${neg ? MINUS : '+'}${fmtUsd(Math.abs(m.delta))}`;
    const pct =
      m.deltaPct === null ? '' : ` (${m.deltaPct < 0 ? MINUS : '+'}${fmtPct(Math.abs(m.deltaPct))})`;
    return `${m.category} at ${name} ${money}${pct} vs trailing 12 mo`;
  });
}
