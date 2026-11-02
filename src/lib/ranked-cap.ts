// Signal discipline — the surface ceiling and its coverage math (pure; no React).
//
// The rule: a first screen shows at most MAX_ITEMS ranked rows. Anything beyond is "held back"
// behind an explicit control — demoted, never destroyed. Coverage tells the reader how much of the
// quantified exposure the visible rows still account for, so a cap can never silently hide money.

/** Rows a ranked surface shows before the rest is held back. */
export const MAX_ITEMS = 10;

/** The Overview is the first screen, so it shows fewer rows than a destination (Gabriel, 2026-10-29). */
export const OVERVIEW_MAX_ITEMS = 7;

/** Each non-empty tier keeps at least this many rows, so a quiet tier never vanishes under a loud one. */
export const TIER_FLOOR = 2;

/**
 * Split a row budget across tiers (in display order). Pass 1 guarantees each tier up to `floor`
 * rows (earlier tiers win if the floors alone exceed the budget); pass 2 fills the remainder in tier
 * order. Never allocates more than a tier holds, nor more than `budget` in total.
 */
export function allocateBudget(counts: readonly number[], budget: number, floor = TIER_FLOOR): number[] {
  const total = counts.reduce((a, b) => a + b, 0);
  if (!Number.isFinite(budget) || total <= budget) return [...counts];

  const alloc = counts.map(() => 0);
  let remaining = budget;
  counts.forEach((count, i) => {
    const grant = Math.min(count, floor, remaining);
    alloc[i] = grant;
    remaining -= grant;
  });
  counts.forEach((count, i) => {
    const grant = Math.min(count - (alloc[i] ?? 0), remaining);
    alloc[i] = (alloc[i] ?? 0) + grant;
    remaining -= grant;
  });
  return alloc;
}

export interface CoverageRow {
  /** Annualized dollars at stake; null = not quantified (never treated as $0). */
  usd: number | null;
  /** Underlying signals this row stands for (a grouped row stands for several). */
  signals: number;
  shown: boolean;
}

export interface Coverage {
  signalsShown: number;
  signalsTotal: number;
  usdShown: number;
  usdTotal: number;
  /** Whole-number percent of quantified exposure on screen; null when nothing is quantified. */
  pct: number | null;
  /** Signals with no dollar figure, counted across shown and held-back rows. */
  unquantified: number;
}

export function coverage(rows: readonly CoverageRow[]): Coverage {
  let signalsShown = 0;
  let signalsTotal = 0;
  let usdShown = 0;
  let usdTotal = 0;
  let unquantified = 0;
  for (const r of rows) {
    signalsTotal += r.signals;
    if (r.shown) signalsShown += r.signals;
    if (r.usd === null) {
      unquantified += r.signals;
      continue;
    }
    usdTotal += r.usd;
    if (r.shown) usdShown += r.usd;
  }
  return {
    signalsShown,
    signalsTotal,
    usdShown,
    usdTotal,
    pct: usdTotal > 0 ? Math.round((usdShown / usdTotal) * 100) : null,
    unquantified,
  };
}
