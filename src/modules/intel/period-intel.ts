// src/modules/intel/period-intel.ts
//
// Pure, deterministic helpers backing the module-level time control (PFI Phase B.3 item 3).
// The control governs which period's LEVELS/benchmarks the intelligence tabs display; scores,
// attention, capital actions and the verdict stay on the latest FULL YEAR regardless. The
// option list offers full years (latest first) then any YTD/partial period last; a YTD
// selection raises the persistent "YTD (partial)" banner so the cross-grain caveat is ambient.
// No I/O, no React, no clock; inputs are never mutated.
import type { PeriodMetrics } from './analytics-hooks';

export interface PeriodOption {
  /** The raw period string ('YYYY'). */
  period: string;
  /** 'year' | 'ytd' | null (unknown). */
  grainHint: string | null;
  /** True only for a YTD/partial period — drives the banner. */
  isYtd: boolean;
  /** Display label: 'FY2025' for full years, '2026 YTD' for YTD, bare period otherwise. */
  label: string;
}

/** Distinct periods present in metrics as selectable options: full years latest-first, then any
 *  YTD/partial period last. One option per distinct period string (first grain wins). Empty-safe. */
export function availablePeriods(metrics: PeriodMetrics[]): PeriodOption[] {
  const byPeriod = new Map<string, string | null>();
  for (const m of metrics) {
    if (!byPeriod.has(m.period)) byPeriod.set(m.period, m.grainHint);
  }
  const options: PeriodOption[] = [...byPeriod].map(([period, grainHint]) => ({
    period,
    grainHint,
    isYtd: grainHint === 'ytd',
    label: grainHint === 'year' ? `FY${period}` : grainHint === 'ytd' ? `${period} YTD` : period,
  }));
  // Full years (and unknown grain) first, latest period first; YTD/partial periods last.
  return options.sort((a, b) => (a.isYtd === b.isYtd ? b.period.localeCompare(a.period) : a.isYtd ? 1 : -1));
}

/** The default selection: the latest full year, else the latest available period, else null. */
export function defaultPeriod(options: PeriodOption[]): string | null {
  const latestFy = options.find((o) => !o.isYtd);
  return (latestFy ?? options[0])?.period ?? null;
}

/** Whether the given period is a YTD/partial period (drives the banner). False for unknown/null. */
export function isYtdPeriod(options: PeriodOption[], period: string | null): boolean {
  if (period === null) return false;
  return options.find((o) => o.period === period)?.isYtd ?? false;
}
