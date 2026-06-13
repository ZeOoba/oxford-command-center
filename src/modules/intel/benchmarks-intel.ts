// src/modules/intel/benchmarks-intel.ts
//
// Pure, deterministic helpers backing BenchmarksView — the period selector's options and
// the per-metric value formatter. No I/O, no React, no clock; inputs are never mutated.
//
// The benchmark cohort is a FULL-YEAR cohort (the engine scores/ranks on full years), so
// the period selector offers only 'year'-grain periods and defaults to the LATEST one —
// never a 2026-YTD (pre-mortem #5/#7). The selector also offers only the 12 metric enum
// keys, so the route's `?period=&metric=` never 400s (pre-mortem #7). Each metric formats
// per its unit: dollar levels + $/SF as USD (cents on $/SF), ratios as percentages, null
// as an em-dash (never `.toFixed(null)` — pre-mortem #2).
import { fmtPct, fmtUsd } from '@analytics/index';
import type { NumericMetricKey, PeriodMetrics } from './analytics-hooks';

/** The 12 benchmarkable metric keys, in the order the engine's enum declares them. The
 *  selector offers exactly these (and only present full-year periods) so the route never
 *  400s on an out-of-enum metric. */
export const METRIC_KEYS: readonly NumericMetricKey[] = [
  'revenue',
  'opex',
  'noi',
  'oxfordNoi',
  'noiMargin',
  'expenseRatio',
  'revenuePerSf',
  'noiPerSf',
  'expensePerSf',
  'taxesPerSf',
  'insurancePerSf',
  'repairsPerSf',
] as const;

/** Friendly selector labels per metric key. */
export const METRIC_LABELS: Record<NumericMetricKey, string> = {
  revenue: 'Revenue',
  opex: 'Operating Expenses',
  noi: 'NOI',
  oxfordNoi: 'Oxford-Share NOI',
  noiMargin: 'NOI Margin',
  expenseRatio: 'Expense Ratio',
  revenuePerSf: 'Revenue / SF',
  noiPerSf: 'NOI / SF',
  expensePerSf: 'Expense / SF',
  taxesPerSf: 'Taxes / SF',
  insurancePerSf: 'Insurance / SF',
  repairsPerSf: 'Repairs / SF',
};

/** Ratio metrics render as percentages; the rest are dollars. */
const RATIO_METRICS: ReadonlySet<NumericMetricKey> = new Set(['noiMargin', 'expenseRatio']);

/** Per-SF metrics carry cents ($6.25); dollar levels are whole-dollar ($1,234,567). */
const PER_SF_METRICS: ReadonlySet<NumericMetricKey> = new Set([
  'revenuePerSf',
  'noiPerSf',
  'expensePerSf',
  'taxesPerSf',
  'insurancePerSf',
  'repairsPerSf',
]);

/** Distinct FULL-YEAR periods present in metrics, LATEST FIRST (so the default selection is
 *  the latest FY). YTD/partial rows are excluded — the benchmark cohort is full-year only. */
export function availableFyPeriods(metrics: PeriodMetrics[]): string[] {
  const set = new Set<string>();
  for (const m of metrics) {
    if (m.grainHint === 'year') set.add(m.period);
  }
  return [...set].sort((a, b) => b.localeCompare(a));
}

/** The value formatter for a metric: ratios → fmtPct, $/SF → fmtUsd with cents, other dollar
 *  levels → whole-dollar fmtUsd. Null / non-finite → em-dash (never coerced). */
export function metricFormatter(metric: NumericMetricKey): (n: number | null) => string {
  if (RATIO_METRICS.has(metric)) return (n) => fmtPct(n);
  if (PER_SF_METRICS.has(metric)) return (n) => fmtUsd(n, true);
  return (n) => fmtUsd(n);
}

/** Cross-basis benchmark warning (G2). The engine flags a cohort that mixes accounting bases
 *  (cash / accrual / tax) — comparing NOI or cost ratios across bases is not like-for-like. Returns
 *  the warning text to surface (naming the bases when known) or null for a single-basis cohort.
 *  Null-safe over a missing summary or omitted fields. */
export function mixedBasisNote(
  summary: { mixedBasis?: boolean; bases?: string[] } | null | undefined,
): string | null {
  if (!summary || !summary.mixedBasis) return null;
  const bases = (summary.bases ?? []).filter((b) => typeof b === 'string' && b.length > 0);
  return bases.length
    ? `Mixed accounting basis (${bases.join(' + ')}) — not like-for-like`
    : 'Mixed accounting basis — not like-for-like';
}
