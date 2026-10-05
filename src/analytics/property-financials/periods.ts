// src/analytics/property-financials/periods.ts
//
// Period definitions and the two rules every consumer of the Property Financials dataset must obey
// (data-dictionary.md "Periods" / "Known gaps"; plan pre-mortem #3):
//   1. A partial period (n_months below the period length) is DISPLAYED but never produces a YoY
//      and is never annualized.
//   2. A zero / negative / missing base never produces a percent.
// Both refusals come back as a MetricResult carrying a reason string for the tooltip, so the UI
// renders "n/m" with a why instead of a blank.
//
// Pure TypeScript: no React, no fs, no dataset import.
import type { PfComparisonId, PfPeriodId, StandardPeriodId } from '@contracts/property-financials';

export type PeriodFamily = 'FY' | 'TTM' | 'YTD' | 'ANNUAL_PARTIAL';

export interface PeriodDef {
  readonly id: PfPeriodId;
  readonly family: PeriodFamily;
  /** Month count of a complete period; n_months below this = partial. */
  readonly expectedMonths: number;
  /** Column label as the reference artifact prints it. */
  readonly label: string;
}

export const EXPECTED_MONTHS: Readonly<Record<PeriodFamily, number>> = {
  FY: 12,
  TTM: 12,
  YTD: 9,
  // Calendar 2026 through the last QuickBooks statement date: partial by construction.
  ANNUAL_PARTIAL: 12,
};

export const PERIOD_DEFS: Readonly<Record<PfPeriodId, PeriodDef>> = {
  FY2024: { id: 'FY2024', family: 'FY', expectedMonths: 12, label: 'FY24' },
  FY2025: { id: 'FY2025', family: 'FY', expectedMonths: 12, label: 'FY25' },
  YTD25: { id: 'YTD25', family: 'YTD', expectedMonths: 9, label: 'Jan-Sep 25' },
  YTD26: { id: 'YTD26', family: 'YTD', expectedMonths: 9, label: 'Jan-Sep 26' },
  TTM25: { id: 'TTM25', family: 'TTM', expectedMonths: 12, label: 'TTM Sep-25' },
  TTM26: { id: 'TTM26', family: 'TTM', expectedMonths: 12, label: 'TTM Sep-26' },
  'YTD26_partial_thru_2026-06-12': {
    id: 'YTD26_partial_thru_2026-06-12',
    family: 'ANNUAL_PARTIAL',
    expectedMonths: 12,
    label: '2026 YTD to 6/12',
  },
};

/** The three comparisons the dataset carries for monthly entities. */
export const COMPARISONS: Readonly<Record<PfComparisonId, { current: StandardPeriodId; prior: StandardPeriodId }>> = {
  FY2025_vs_FY2024: { current: 'FY2025', prior: 'FY2024' },
  TTM26_vs_TTM25: { current: 'TTM26', prior: 'TTM25' },
  YTD26_vs_YTD25: { current: 'YTD26', prior: 'YTD25' },
};

/** Family of an arbitrary period id, by prefix convention; null when unrecognised. */
export function periodFamily(id: string): PeriodFamily | null {
  const def = (PERIOD_DEFS as Record<string, PeriodDef | undefined>)[id];
  if (def) return def.family;
  if (/^FY\d{4}$/.test(id)) return 'FY';
  if (/^TTM\d{2}$/.test(id)) return 'TTM';
  if (/^YTD\d{2}_partial/.test(id)) return 'ANNUAL_PARTIAL';
  if (/^YTD\d{2}$/.test(id)) return 'YTD';
  return null;
}

export function expectedMonths(id: string): number | null {
  const fam = periodFamily(id);
  return fam === null ? null : EXPECTED_MONTHS[fam];
}

export function periodLabel(id: string): string {
  return (PERIOD_DEFS as Record<string, PeriodDef | undefined>)[id]?.label ?? id;
}

/** True when the window has fewer months of data than the period length (unknown period = partial). */
export function isPartialPeriod(id: string, nMonths: number): boolean {
  const expected = expectedMonths(id);
  if (expected === null) return true;
  return nMonths < expected - 1e-9;
}

/** Tooltip text for a partial period, or null when the period is complete. */
export function partialReason(id: string, nMonths: number): string | null {
  if (!isPartialPeriod(id, nMonths)) return null;
  const expected = expectedMonths(id);
  return expected === null
    ? `unrecognised period ${id}`
    : `partial period: ${formatMonths(nMonths)} of ${expected} months`;
}

function formatMonths(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

/** A computed figure, or a refusal with the reason the UI shows on hover. */
export type MetricResult = { readonly value: number; readonly reason: null } | { readonly value: null; readonly reason: string };

export function ok(value: number): MetricResult {
  return { value, reason: null };
}

export function notMeaningful(reason: string): MetricResult {
  return { value: null, reason };
}
