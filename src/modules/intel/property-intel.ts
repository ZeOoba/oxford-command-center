// src/modules/intel/property-intel.ts
//
// Pure, deterministic helpers backing PropertyIntelView — period labelling, the
// full-year metric set, the two latest FY periods the ΔNOI waterfall bridges, and the
// sparkline number arrays for the KPI tiles. No I/O, no React. The view is browser-
// verified; this logic is unit-tested (the only testable surface on the page). Every
// helper is null-safe so a no-SF / single-period / YTD-only property never crashes the
// view (pre-mortem #2).
import { fmtPct, fmtUsd } from '@analytics/index';
import type { NoiDecomposition, PeriodMetrics, PropertyScore } from './analytics-hooks';

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

/** The metric row for an explicit period (the module-level time control — PFI Phase B.3),
 *  falling back to the property's latest full year when that period is absent, then null.
 *  Null-safe: a no-period / empty / YTD-only-without-match property yields null → '—' tiles. */
export function pickPeriodMetrics(metrics: PeriodMetrics[], period: string | null): PeriodMetrics | null {
  if (period !== null) {
    const match = metrics.find((m) => m.period === period);
    if (match) return match;
  }
  const fy = fullYearPeriods(metrics);
  return fy[fy.length - 1] ?? null;
}

/** The one-line synthesized root-cause line for the answer-first verdict card (PFI Phase B.3
 *  item 2): names the largest |Δ| driver, its contribution share, the signed ΔNOI and the FY
 *  bridge — e.g. "Largest driver: Repairs & Maintenance, 83.3% of the −$30,000 change
 *  (FY2023→FY2024)." Returns null when there is no decomposition or no drivers (a single-
 *  period / YTD-only property), and an "essentially flat" line when ΔNOI ≈ 0 (null
 *  contribution by construction). Pure — uses the engine's `contributionPct`, not a re-derive. */
export function rootCauseLine(decomp: NoiDecomposition | null): string | null {
  if (decomp === null || decomp.drivers.length === 0) return null;
  // Name the largest driver moving IN the net direction — the line that EXPLAINS the change, not
  // an even-larger opposing line (which would render a confusing negative "% of the change"). Fall
  // back to the overall largest |Δ| only if nothing shares the net direction (degenerate).
  const directional = decomp.drivers.filter((d) =>
    decomp.totalDelta >= 0 ? d.delta > 0 : d.delta < 0,
  );
  const pool = directional.length > 0 ? directional : decomp.drivers;
  const largest = pool.reduce((a, b) => (Math.abs(b.delta) > Math.abs(a.delta) ? b : a));
  if (largest.contributionPct === null) return `NOI essentially flat FY${decomp.from}→FY${decomp.to}.`;
  const sign = decomp.totalDelta >= 0 ? '+' : '−';
  return `Largest driver: ${largest.category}, ${fmtPct(largest.contributionPct)} of the ${sign}${fmtUsd(
    Math.abs(decomp.totalDelta),
  )} change (FY${decomp.from}→FY${decomp.to}).`;
}

/** Capital-action → recommendation verb for the verdict card's "DO" line (PFI Phase B.3 item 2). */
const CAPITAL_VERB: Record<PropertyScore['capitalAction'], string> = {
  invest: 'Deploy capital',
  hold: 'Hold',
  monitor: 'Monitor closely',
  'disposition-candidate': 'Evaluate for disposition',
};

/** The recommended-action ("DO") line: the capital-action verb plus the leading score reason. */
export function recommendedAction(score: PropertyScore): string {
  const verb = CAPITAL_VERB[score.capitalAction];
  const reason = score.reasons[0];
  return reason ? `${verb} — ${reason}.` : `${verb}.`;
}
