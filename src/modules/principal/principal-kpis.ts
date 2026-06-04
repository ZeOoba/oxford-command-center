import { fmtUsdCompact, fmtPct } from '@analytics/index';
import type { PortfolioSnapshot } from '@contracts/index';
import type { AnalyticsBundle } from '@analytics/index';

export interface PrincipalKpi { label: string; display: string }

/** Headline figures for the Principal home. Pure (exported for tests). */
export function principalKpis(snapshot: PortfolioSnapshot, analytics: AnalyticsBundle): PrincipalKpi[] {
  return [
    { label: 'NOI', display: fmtUsdCompact(analytics.kpis.noi.value) },
    { label: 'Portfolio value', display: fmtUsdCompact(analytics.kpis.value.value) },
    { label: 'Occupancy', display: fmtPct(analytics.kpis.occupancy.value) },
    { label: 'Cash', display: fmtUsdCompact(snapshot.cash.totalCash) },
  ];
}
