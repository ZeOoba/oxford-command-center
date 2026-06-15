// src/modules/calibration/format.ts
//
// Pure display helpers for the calibration panel — unit-tested, no React. Every numeric formatter is
// null/empty-safe: the panel renders on EMPTY data (the normal Phase-2 state until outcomes accrue),
// so a null rate, a 0-of-0 scoreable count, and a missing Wilson bound must all render as an explicit
// dash — never NaN, never "0%", never a crash.
import type { BadgeTone } from '@/primitives/Badge';
import type { CalibrationLogRow, CalibrationReportResponse } from '@contracts/warehouse';

/** A rate in [0,1] → "NN%"; null (nothing scoreable) → an em-dash. NEVER NaN. */
export function fmtRate(rate: number | null | undefined): string {
  if (rate === null || rate === undefined || Number.isNaN(rate)) return '—';
  return `${Math.round(rate * 100)}%`;
}

/** A Wilson interval → "[lo–hi]"; either bound null → an em-dash. */
export function fmtInterval(low: number | null | undefined, high: number | null | undefined): string {
  if (low === null || low === undefined || high === null || high === undefined) return '—';
  return `${Math.round(low * 100)}–${Math.round(high * 100)}%`;
}

/** A signed numeric (bias / NOI growth) → "+N.NN" / "−N.NN"; null → em-dash. */
export function fmtSigned(n: number | null | undefined, digits = 2): string {
  if (n === null || n === undefined || Number.isNaN(n)) return '—';
  const s = n.toFixed(digits);
  return n > 0 ? `+${s}` : s;
}

/** Hit cell: 1 → "hit", 0 → "miss", null → "—" (not scoreable). */
export function fmtHit(hit: 0 | 1 | null): string {
  return hit === 1 ? 'hit' : hit === 0 ? 'miss' : '—';
}

/** Badge tone for a verdict's resolution state / hit. */
export function hitTone(hit: 0 | 1 | null, resolved: boolean): BadgeTone {
  if (!resolved) return 'neutral';
  return hit === 1 ? 'green' : hit === 0 ? 'red' : 'gold';
}

/** Badge tone per verdict kind — stable, distinct, accessible (not just color-coding meaning). */
export function kindTone(kind: string): BadgeTone {
  switch (kind) {
    case 'health-band': return 'blue';
    case 'attention': return 'amber';
    case 'capital-action': return 'purple';
    case 'anomaly': return 'red';
    default: return 'neutral';
  }
}

/** True when the report carries no scoreable resolved outcomes yet — the panel's empty state. */
export function reportIsEmpty(report: CalibrationReportResponse | undefined): boolean {
  return !report || report.scoreableVerdicts === 0;
}

/** A short subject + kind label for a log row, used in the resolve dialog header and the table. */
export function verdictLabel(row: CalibrationLogRow): string {
  const sub = row.verdictSubkind ? `/${row.verdictSubkind}` : '';
  const band = row.predictedBand ? ` → ${row.predictedBand}` : '';
  return `${row.subjectId} · ${row.verdictKind}${sub}${band} @ ${row.asOfPeriod}`;
}
