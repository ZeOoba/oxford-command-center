import { fmtUsdCompact } from '@analytics/index';
import type { PortfolioSnapshot, Provenance } from '@contracts/index';
import type { AnalyticsBundle } from '@analytics/index';

export interface PrincipalKpi {
  label: string;
  value: number | null;
  format: (n: number | null) => string;
  prov?: Provenance;
}

const pctFmt = (n: number | null): string => (n === null ? '—' : `${n.toFixed(1)}%`);

/** Headline figures for the Principal home, in KpiStat's value+format shape. Pure (exported for tests). */
export function principalKpis(snapshot: PortfolioSnapshot, analytics: AnalyticsBundle): PrincipalKpi[] {
  const k = analytics.kpis;
  return [
    { label: 'NOI', value: k.noi.value, format: fmtUsdCompact, prov: k.noi.prov },
    { label: 'Portfolio value', value: k.value.value, format: fmtUsdCompact, prov: k.value.prov },
    { label: 'Occupancy', value: k.occupancy.value === null ? null : k.occupancy.value * 100, format: pctFmt, prov: k.occupancy.prov },
    { label: 'Cash', value: k.totalCash.value, format: fmtUsdCompact, prov: k.totalCash.prov },
  ];
}
