// server/warehouse/growth.ts
// Pure, db-free growth analytics over PeriodMetrics[]. Compares only same-property
// periods, ascending. Growth is null when the prior base is <= 0 (can't take a % off
// zero/negative) — flag, never fabricate.
import type { PeriodMetrics } from './metrics';

export interface GrowthPoint {
  propertyId: string;
  period: string;
  revenueGrowth: number | null;
  expenseGrowth: number | null;
  noiGrowth: number | null;
  noiPerSfGrowth: number | null;
}

export interface SinceAcquisition {
  propertyId: string | null;
  anchorPeriod: string | null;
  latestPeriod: string | null;
  revenueGrowth: number | null;
  noiGrowth: number | null;
  noiPerSfGrowth: number | null;
  taxesGrowth: number | null;
  insuranceGrowth: number | null;
  revenuePerSfGrowth: number | null;
  noiCagr: number | null;
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

/** Period-over-period growth for one property's series; null on the first (no prior). */
export function growthSeries(metrics: PeriodMetrics[]): GrowthPoint[] {
  const sorted = [...metrics].sort((a, b) => a.period.localeCompare(b.period));
  const out: GrowthPoint[] = [];
  for (let i = 0; i < sorted.length; i++) {
    const cur = sorted[i]!;
    const prev = i > 0 ? sorted[i - 1]! : null;
    out.push({
      propertyId: cur.propertyId,
      period: cur.period,
      revenueGrowth: prev ? pctChange(prev.revenue, cur.revenue) : null,
      expenseGrowth: prev ? pctChange(prev.opex, cur.opex) : null,
      noiGrowth: prev ? pctChange(prev.noi, cur.noi) : null,
      noiPerSfGrowth: prev ? pctChange(prev.noiPerSf, cur.noiPerSf) : null,
    });
  }
  return out;
}

/** Anchor on the earliest available period (data begins at ownership per canon) to the latest. */
export function sinceAcquisition(metrics: PeriodMetrics[]): SinceAcquisition {
  const sorted = [...metrics].sort((a, b) => a.period.localeCompare(b.period));
  const anchor = sorted[0];
  const latest = sorted[sorted.length - 1];
  if (!anchor || !latest) {
    return {
      propertyId: null, anchorPeriod: null, latestPeriod: null,
      revenueGrowth: null, noiGrowth: null, noiPerSfGrowth: null,
      taxesGrowth: null, insuranceGrowth: null, revenuePerSfGrowth: null, noiCagr: null,
    };
  }
  const years = Number(latest.period) - Number(anchor.period);
  return {
    propertyId: anchor.propertyId,
    anchorPeriod: anchor.period,
    latestPeriod: latest.period,
    revenueGrowth: pctChange(anchor.revenue, latest.revenue),
    noiGrowth: pctChange(anchor.noi, latest.noi),
    noiPerSfGrowth: pctChange(anchor.noiPerSf, latest.noiPerSf),
    taxesGrowth: pctChange(anchor.taxesPerSf, latest.taxesPerSf),
    insuranceGrowth: pctChange(anchor.insurancePerSf, latest.insurancePerSf),
    revenuePerSfGrowth: pctChange(anchor.revenuePerSf, latest.revenuePerSf),
    noiCagr: cagr(anchor.noi, latest.noi, years),
  };
}
