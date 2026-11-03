// src/modules/portfolio/scenario-spread.ts
//
// Scenario-spread band for the Trends forward months (roadmap 3.3). The forecast line is contractual
// roll-off — every lease ends on its date and nothing renews. The band spans from that to the other
// deterministic bound: every lease in effect at the as-of month renews on its current terms
// (escalations continue). Both ends come from the same buildPortfolioTrend engine; no renewal
// probability, market rent or downtime is assumed, so the band is a range between two named
// scenarios and is never labelled a confidence interval.
import type { Lease } from '@contracts/index';
import { leaseActive, monthOf, type MonthPoint } from '@analytics/portfolio-trends';
import type { Provenance, SpreadPoint } from '@/charts/series-provenance';
import type { MonthSource } from './trends-history';

export const SPREAD_LABEL = 'Scenario range: no renewals ↔ every lease renews on current terms (not a probability band)';

/** Leases in effect at the as-of month run on past their end date (renew on current terms). Leases
 *  already ended before the as-of month stay ended — renewal never resurrects history. */
export function renewAllLeases(leases: readonly Lease[], asOf: string): Lease[] {
  const asOfMonth = monthOf(asOf);
  return leases.map((l) => (l.leaseEnd != null && leaseActive(l, asOfMonth) ? { ...l, leaseEnd: null } : l));
}

/**
 * Per-point band for a metric: null on history months, lo = hi on the as-of month (so the band opens
 * from the last actual), then [min, max] of the two scenarios on each forecast month. Months are
 * matched by key; a month missing from either series gets no band.
 */
export function spreadBand(
  contractual: readonly MonthPoint[],
  renewAll: readonly MonthPoint[],
  metric: (p: MonthPoint) => number,
  asOfMonth: string,
): (SpreadPoint | null)[] {
  const alt = new Map(renewAll.map((p) => [p.month, p]));
  return contractual.map((p) => {
    if (p.month < asOfMonth) return null;
    const q = alt.get(p.month);
    if (!q) return null;
    const a = metric(p);
    const b = metric(q);
    return { lo: Math.min(a, b), hi: Math.max(a, b) };
  });
}

/** Provenance per point for the chart: forecast months first, else the merged source tag. */
export function pointProvenance(points: readonly { isForecast: boolean; source: MonthSource }[]): Provenance[] {
  return points.map((p) => (p.isForecast ? 'forecast' : p.source));
}
