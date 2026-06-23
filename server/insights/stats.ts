/**
 * server/insights/stats.ts
 *
 * Pure math utilities for the Insight Engine (Phase 2 UnitB).
 * No database access. No imports from warehouse or calibration modules.
 *
 * Honesty constants document the minimum evidence thresholds we require before
 * we assert a statistical relationship. Never lower these without a documented
 * rationale — they exist to prevent the engine from over-fitting to thin data.
 */

// ---------------------------------------------------------------------------
// Honesty constants
// ---------------------------------------------------------------------------

/** Minimum n for a meaningful correlation. Below this, pearson/spearman return null. */
export const MIN_PAIRS = 5;

/** Minimum overlapping periods for time-based comparisons (e.g. FRED series vs ledger). */
export const MIN_SHARED_PERIODS = 3;

/** Current portfolio size (number of properties). Used to size cross-property analyses. */
export const N_FULL = 14;

// ---------------------------------------------------------------------------
// Rank helpers (private)
// ---------------------------------------------------------------------------

/**
 * Assign ranks to an array of numbers using midpoint averaging for ties.
 * rank[i] is 1-based.
 */
function rankify(xs: number[]): number[] {
  const n = xs.length;
  // Build index-sorted pairs
  const indexed: Array<{ val: number; idx: number }> = xs.map((val, idx) => ({ val, idx }));
  indexed.sort((a, b) => a.val - b.val);

  const ranks = new Array<number>(n);
  let i = 0;
  while (i < n) {
    let j = i;
    // Find the run of equal values
    while (j < n - 1 && indexed[j + 1]!.val === indexed[j]!.val) j++;
    // Midpoint rank for all tied elements (1-based)
    const midRank = (i + 1 + j + 1) / 2;
    for (let k = i; k <= j; k++) {
      ranks[indexed[k]!.idx] = midRank;
    }
    i = j + 1;
  }
  return ranks;
}

// ---------------------------------------------------------------------------
// Pearson correlation
// ---------------------------------------------------------------------------

/**
 * Pearson product-moment correlation coefficient.
 *
 * Returns null when:
 *   - n < MIN_PAIRS (insufficient evidence)
 *   - the denominator is 0 (one or both arrays are constant)
 */
export function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n !== ys.length || n < MIN_PAIRS) return null;

  let sumX = 0;
  let sumY = 0;
  for (let i = 0; i < n; i++) {
    sumX += xs[i]!;
    sumY += ys[i]!;
  }
  const meanX = sumX / n;
  const meanY = sumY / n;

  let cov = 0;
  let varX = 0;
  let varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    cov += dx * dy;
    varX += dx * dx;
    varY += dy * dy;
  }

  const denom = Math.sqrt(varX * varY);
  if (denom === 0) return null;

  return cov / denom;
}

// ---------------------------------------------------------------------------
// Spearman rank correlation
// ---------------------------------------------------------------------------

/**
 * Spearman rank correlation coefficient.
 * Rank-transforms both arrays (midpoint average for ties), then computes
 * Pearson on the ranks.
 *
 * Returns null when n < MIN_PAIRS.
 */
export function spearman(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n !== ys.length || n < MIN_PAIRS) return null;

  const rx = rankify(xs);
  const ry = rankify(ys);
  return pearson(rx, ry);
}

// ---------------------------------------------------------------------------
// Wilson score interval
// ---------------------------------------------------------------------------

/**
 * Wilson score confidence interval for a proportion (95% CI, z=1.96).
 *
 * Formula is byte-for-byte identical to calibration.ts:940-949 — parity is
 * intentional. calibration.ts keeps its own private copy (architect-owned);
 * this export serves the insight engine exclusively.
 *
 * Returns { low: null, high: null } when n === 0.
 */
export function wilson(hits: number, n: number): { low: number | null; high: number | null } {
  if (n === 0) return { low: null, high: null };
  const z = 1.96;
  const phat = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (phat + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)) / denom;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}
