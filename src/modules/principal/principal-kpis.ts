import { fmtUsdCompact, noiGapText } from '@analytics/index';
import type { Provenance } from '@contracts/index';
import type { AnalyticsBundle } from '@analytics/index';
import { otherHoldingsClause } from '@/modules/overview/other-holdings';

export interface PrincipalKpi {
  label: string;
  value: number | null;
  format: (n: number | null) => string;
  prov?: Provenance;
  /** Optional one-line qualifier under the figure (e.g. the other-holdings disclosure on Portfolio value). */
  sublabel?: string;
}

const pctFmt = (n: number | null): string => (n === null ? '—' : `${n.toFixed(1)}%`);

/** Headline figures for the Principal home, in KpiStat's value+format shape. Pure (exported for tests).
 *  Every card reads the analytics bundle's provenanced cells — no raw-snapshot reads (the Cash card
 *  was the last one; audit finding principal-cash-kpi-drops-provenance). */
export function principalKpis(analytics: AnalyticsBundle): PrincipalKpi[] {
  const k = analytics.kpis;
  return [
    // A blank workbook NOI leaves Σ NOI incomplete: say so under the figure (follow-up to audit HIGH #2).
    { label: 'NOI', value: k.noi.value, format: fmtUsdCompact, prov: k.noi.prov, ...(noiGapText(k) ? { sublabel: noiGapText(k)! } : {}) },
    {
      label: 'Portfolio value',
      value: k.value.value,
      format: fmtUsdCompact,
      prov: k.value.prov,
      // Ratified 2026-09-23: the headline is investment-only; the residence is REPORTED beside it as
      // other holdings wherever the headline appears (never silently dropped) — same shared $ clause
      // wording as the Overview KPI strip and Portfolio strip (other-holdings.ts). Unlike those two
      // surfaces, Principal's tile has never shown a property count, so it stays clause-only, present
      // only when a residence row exists.
      ...(k.otherHoldingsCount.value ? { sublabel: otherHoldingsClause(k) } : {}),
    },
    { label: 'Occupancy', value: k.occupancy.value === null ? null : k.occupancy.value * 100, format: pctFmt, prov: k.occupancy.prov },
    { label: 'Cash', value: k.totalCash.value, format: fmtUsdCompact, prov: k.totalCash.prov },
  ];
}
