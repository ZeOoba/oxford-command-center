// src/analytics/property-financials/format.ts
//
// Display formatters matching the reference artifact's usd / pc / pl helpers exactly, so the module
// renders the same strings the review artifact did. K and M compaction is for axis / KPI use only;
// table cells use the plain or 'f' (full) form. Null / NaN print as an en dash; a refused metric
// prints 'n/m'.
import type { MetricResult } from './periods';

export const DASH = '–';
export const NM = 'n/m';

const grouped0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const grouped1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });

function missing(x: number | null | undefined): x is null | undefined {
  return x === null || x === undefined || !Number.isFinite(x);
}

/**
 * USD. Default: whole dollars, compacted to $X.XXM at or above $1M. 'f' = full (never compacted).
 * 'k' = thousands with one decimal ($12.3K) — axes and KPI deltas only.
 */
export function usd(x: number | null | undefined, mode?: 'k' | 'f'): string {
  if (missing(x)) return DASH;
  const a = Math.abs(x);
  const s = x < 0 ? '-' : '';
  if (mode === 'k') return `${s}$${grouped1.format(a / 1000)}K`;
  if (a >= 1e6 && mode !== 'f') return `${s}$${(a / 1e6).toFixed(2)}M`;
  return `${s}$${grouped0.format(Math.round(a))}`;
}

/** Signed percent change: +2.6% / -8.0% / 0.0%. */
export function pct(x: number | null | undefined, digits = 1): string {
  if (missing(x)) return DASH;
  return `${x > 0 ? '+' : ''}${(x * 100).toFixed(digits)}%`;
}

/** Unsigned percent level: 58% / 4.0%. */
export function pctLevel(x: number | null | undefined, digits = 0): string {
  if (missing(x)) return DASH;
  return `${(x * 100).toFixed(digits)}%`;
}

/** Axis / KPI compaction: $1.23M / $520K / $120 (the artifact's kfmt). */
export function axisUsd(x: number | null | undefined): string {
  if (missing(x)) return DASH;
  const a = Math.abs(x);
  const s = x < 0 ? '-' : '';
  if (a >= 1e6) return `${s}$${(a / 1e6).toFixed(2)}M`;
  if (a >= 1000) return `${s}$${Math.round(a / 1000)}K`;
  return `${s}$${Math.round(a)}`;
}

/** Render a MetricResult: the formatted value, or 'n/m' when refused. */
export function fmtResult(r: MetricResult, format: (value: number) => string): string {
  return r.value === null ? NM : format(r.value);
}
