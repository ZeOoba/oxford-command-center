/** Display formatters. Numbers render in IBM Plex Mono with tabular figures. */

const usd0 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
const usd2 = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', minimumFractionDigits: 2, maximumFractionDigits: 2 });
const num0 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });

export function fmtUsd(n: number | null | undefined, cents = false): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return cents ? usd2.format(n) : usd0.format(n);
}

/** Compact money: $59.6M, $3.91M, $520K. */
export function fmtUsdCompact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1_000_000_000) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1_000_000) return `${sign}$${(abs / 1e6).toFixed(abs >= 10_000_000 ? 1 : 2)}M`;
  if (abs >= 1_000) return `${sign}$${(abs / 1e3).toFixed(0)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function fmtPct(n: number | null | undefined, digits = 1): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtNum(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return num0.format(n);
}

export function fmtSf(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${num0.format(n)} SF`;
}

export function fmtMultiple(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n.toFixed(2)}×`;
}

export function fmtYears(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${n.toFixed(1)} yr`;
}

export function fmtDate(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  // UTC, not local time: a bare YYYY-MM-DD string parses as UTC midnight, and every caller here
  // is displaying a calendar date (lease/loan/insurance/deal dates, snapshot "as of" stamps) —
  // never a moment where the viewer's local clock time matters. Without this, the date silently
  // renders one day early on any UTC-negative machine.
  return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
}

export function fmtMonths(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `${Math.round(n)} mo`;
}
