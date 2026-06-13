// src/modules/intel/property-intel.ts
//
// Pure, deterministic helpers backing PropertyIntelView — period labelling, the
// full-year metric set, the two latest FY periods the ΔNOI waterfall bridges, and the
// sparkline number arrays for the KPI tiles. No I/O, no React. The view is browser-
// verified; this logic is unit-tested (the only testable surface on the page). Every
// helper is null-safe so a no-SF / single-period / YTD-only property never crashes the
// view (pre-mortem #2).
import type { PeriodMetrics } from './analytics-hooks';

/** Human period label: full years → 'FY2024'; YTD → '2026 YTD'; unknown grain → bare. */
export function periodLabel(period: string, grainHint: string | null): string {
  if (grainHint === 'year') return `FY${period}`;
  if (grainHint === 'ytd') return `${period} YTD`;
  return period;
}

/** True iff the metric is a full-year (FY) period. The scoring/growth basis. */
export function isFullYear(m: PeriodMetrics): boolean {
  return m.grainHint === 'year';
}

/** The property's full-year metrics, ascending by period. YTD/partial rows excluded. */
export function fullYearPeriods(metrics: PeriodMetrics[]): PeriodMetrics[] {
  return metrics.filter(isFullYear).sort((a, b) => a.period.localeCompare(b.period));
}

/** The two latest full-year periods to bridge (ΔNOI from→to), or null when <2 exist
 *  (single-period or YTD-only property → no waterfall, "needs two full years"). */
export function pickDriverPeriods(metrics: PeriodMetrics[]): { from: string; to: string } | null {
  const fy = fullYearPeriods(metrics);
  if (fy.length < 2) return null;
  return { from: fy[fy.length - 2]!.period, to: fy[fy.length - 1]!.period };
}

/** A numeric series across a property's full-year periods (ascending), dropping nulls —
 *  feeds a KPI-tile Sparkline (which itself no-ops below 2 points). A null selector (e.g.
 *  null $/SF on a no-SF property) is omitted rather than coerced to 0. */
export function buildAnnualSeries(
  metrics: PeriodMetrics[],
  select: (m: PeriodMetrics) => number | null,
): number[] {
  const out: number[] = [];
  for (const m of fullYearPeriods(metrics)) {
    const v = select(m);
    if (v !== null && Number.isFinite(v)) out.push(v);
  }
  return out;
}
