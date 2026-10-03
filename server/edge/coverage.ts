// server/edge/coverage.ts
//
// Per-series coverage for the Data health card (spec §5.2, §8.5). A cell counts as FILLED iff
// value !== null AND status ∈ {actual, estimated, nowcast}. A cell whose value and status disagree
// (a value under 'null'/guide_only, or null under an observed status) is NOT filled and is listed in
// `inconsistent`. allPlaceholder = the series has cells but none is filled (storage/mfgInvest/ios today).
import {
  EDGE_OBSERVED_STATUSES, EDGE_SERIES,
  type EdgeCoverageRow, type EdgeMarket, type EdgeStatus,
} from '../../src/contracts/edge';

export function computeCoverage(markets: readonly EdgeMarket[], years: readonly number[]): EdgeCoverageRow[] {
  return EDGE_SERIES.map((field) => {
    const byYear = years.map(() => 0);
    const statusCounts: Record<EdgeStatus, number> = { actual: 0, estimated: 0, nowcast: 0, guide_only: 0, null: 0 };
    const inconsistent: Array<{ marketId: string; year: number }> = [];
    let filled = 0;
    for (const m of markets) {
      const c = m.series[field];
      years.forEach((year, i) => {
        const status: EdgeStatus = c.status[i] ?? 'null';
        const value = c.values[i] ?? null;
        statusCounts[status] += 1;
        const observedStatus = EDGE_OBSERVED_STATUSES.includes(status);
        if (observedStatus && value !== null) {
          filled += 1;
          byYear[i] = (byYear[i] ?? 0) + 1;
        } else if (observedStatus !== (value !== null)) {
          inconsistent.push({ marketId: m.id, year });
        }
      });
    }
    const total = markets.length * years.length;
    return {
      field,
      filled,
      total,
      pct: total === 0 ? 0 : filled / total,
      byYear,
      allPlaceholder: total > 0 && filled === 0,
      statusCounts,
      inconsistent,
    };
  });
}
