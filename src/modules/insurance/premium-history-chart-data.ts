// src/modules/insurance/premium-history-chart-data.ts
//
// Pure chart-data builder for PremiumHistoryCard's policy-year bar chart (2026-09-23 review,
// I-3). Two problems with the raw byYear rows as bar data: (1) a bar's dollar total mixes
// whatever coverage happened to be captured that year with no indication of HOW MANY policy
// lines fed it (byYear[].lines), so a thin one-line year reads identically to a portfolio-wide
// total; (2) the current calendar year's total can only ever be partial — the year isn't over —
// but reads as a complete prior year with no visual cue.
//
// Lives in its own .ts file, not PremiumHistoryCard.tsx — react-refresh/only-export-components
// forbids a non-component export from a component .tsx file (repo convention; see
// assessment-history.ts's header for the identical rule and its Task-25 precedent).
import type { BarDatum } from '@/charts/BarChart';
import type { PremiumHistoryReport } from '@contracts/insurance-analysis';

/**
 * One bar per policy year: value = summed premium, label = "YYYY · N lines" so the line count
 * travels with the bar (BarChart's own tooltip shows the label in full; only the x-axis tick
 * truncates it past 14 chars). The current calendar year (by `now`, defaulting to the real
 * wall clock) is additionally marked "(partial)".
 */
export function premiumHistoryBars(byYear: PremiumHistoryReport['byYear'], now: Date = new Date()): BarDatum[] {
  const currentYear = now.getUTCFullYear();
  return byYear.map((y) => ({
    label: `${y.year}${y.year === currentYear ? ' (partial)' : ''} · ${y.lines} line${y.lines === 1 ? '' : 's'}`,
    value: y.premium,
  }));
}
