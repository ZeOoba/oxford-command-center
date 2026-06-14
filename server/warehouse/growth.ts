// server/warehouse/growth.ts
// Pure, db-free growth analytics over PeriodMetrics[]. Compares only same-property
// periods, ascending. Growth is null when the prior base is <= 0 (can't take a % off
// zero/negative) — flag, never fabricate.
//
// GRAIN DISCIPLINE (spec §9): growth is only meaningful between two periods of the SAME
// grain. A partial-year YTD pull (~5 months) compared against a prior FULL year (12 months)
// would manufacture a spurious ≈−50% decline. So a consecutive pair whose grainHints differ
// is INCOMPARABLE: every growth metric is null and `comparable:false` marks it so downstream
// reads it as "no signal", not "flat" or "declining". Missing/null grains are treated as a
// single comparable cohort (legacy/year), so pre-grain data keeps working.
import type { PeriodMetrics } from './metrics';
// GrowthPoint + SinceAcquisition are single-sourced in the contract (H6); re-export under their
// local names so existing engine imports keep working. The schemas are the source of truth.
import type { GrowthPoint, SinceAcquisition } from '../../src/contracts/warehouse';

export type { GrowthPoint, SinceAcquisition };

/** Two periods share a grain when their grainHints match (null/undefined collapse to one cohort). */
function sameGrain(a: PeriodMetrics, b: PeriodMetrics): boolean {
  return (a.grainHint ?? null) === (b.grainHint ?? null);
}

/** % change vs a prior base; null when the base is missing or <= 0 (no % off zero/negative). */
export function pctChange(prev: number | null | undefined, cur: number | null | undefined): number | null {
  if (prev === null || prev === undefined || cur === null || cur === undefined) return null;
  return prev > 0 ? (cur - prev) / prev : null;
}

/** Compound annual growth rate; null off zero/negative endpoints or non-positive years. */
export function cagr(first: number | null | undefined, last: number | null | undefined, years: number): number | null {
  if (first === null || first === undefined || last === null || last === undefined) return null;
  return first > 0 && last > 0 && years > 0 ? (last / first) ** (1 / years) - 1 : null;
}

/**
 * Period-over-period growth for one property's series; null on the first (no prior) and on
 * any cross-grain pair. `comparable` is true only when a same-grain prior exists.
 */
export function growthSeries(metrics: PeriodMetrics[]): GrowthPoint[] {
  const sorted = [...metrics].sort((a, b) => a.period.localeCompare(b.period));
  const out: GrowthPoint[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const prev = i > 0 ? sorted[i - 1]! : null;
    const comparable = prev !== null && sameGrain(prev, cur);
    out.push({
      propertyId: cur.propertyId,
      period: cur.period,
      comparable,
      revenueGrowth: comparable ? pctChange(prev!.revenue, cur.revenue) : null,
      expenseGrowth: comparable ? pctChange(prev!.opex, cur.opex) : null,
      noiGrowth: comparable ? pctChange(prev!.noi, cur.noi) : null,
      noiPerSfGrowth: comparable ? pctChange(prev!.noiPerSf, cur.noiPerSf) : null,
    });
  }
  return out;
}

/**
 * Anchor on the earliest available period (data begins at ownership per canon) to the latest
 * period of the SAME grain as the anchor. When the true latest is a non-comparable YTD pull,
 * fall back to the latest full-year period so the spread isn't a 12-month-vs-partial illusion.
 * If no same-grain latest exists (e.g. only a single YTD period), report that endpoint but
 * mark `comparable:false` and leave growth null.
 */
export function sinceAcquisition(metrics: PeriodMetrics[]): SinceAcquisition {
  const sorted = [...metrics].sort((a, b) => a.period.localeCompare(b.period));
  const anchor = sorted[0];
  if (!anchor) {
    return {
      propertyId: null, anchorPeriod: null, latestPeriod: null, comparable: false,
      revenueGrowth: null, noiGrowth: null, noiPerSfGrowth: null,
      taxesGrowth: null, insuranceGrowth: null, revenuePerSfGrowth: null, noiCagr: null,
    };
  }
  // Latest period whose grain matches the anchor (and isn't the anchor itself).
  let comparableLatest: PeriodMetrics | null = null;
  for (let i = sorted.length - 1; i > 0; i--) {
    if (sameGrain(anchor, sorted[i]!)) { comparableLatest = sorted[i]!; break; }
  }

  if (!comparableLatest) {
    // No same-grain pair: report the true latest endpoint, but flag it incomparable.
    const latest = sorted[sorted.length - 1]!;
    return {
      propertyId: anchor.propertyId,
      anchorPeriod: anchor.period,
      latestPeriod: latest.period,
      comparable: false,
      revenueGrowth: null, noiGrowth: null, noiPerSfGrowth: null,
      taxesGrowth: null, insuranceGrowth: null, revenuePerSfGrowth: null, noiCagr: null,
    };
  }

  const latest = comparableLatest;
  const years = Number(latest.period) - Number(anchor.period);
  return {
    propertyId: anchor.propertyId,
    anchorPeriod: anchor.period,
    latestPeriod: latest.period,
    comparable: true,
    revenueGrowth: pctChange(anchor.revenue, latest.revenue),
    noiGrowth: pctChange(anchor.noi, latest.noi),
    noiPerSfGrowth: pctChange(anchor.noiPerSf, latest.noiPerSf),
    taxesGrowth: pctChange(anchor.taxesPerSf, latest.taxesPerSf),
    insuranceGrowth: pctChange(anchor.insurancePerSf, latest.insurancePerSf),
    revenuePerSfGrowth: pctChange(anchor.revenuePerSf, latest.revenuePerSf),
    noiCagr: cagr(anchor.noi, latest.noi, years),
  };
}
