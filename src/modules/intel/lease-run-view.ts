// src/modules/intel/lease-run-view.ts
//
// Pure presentation helpers backing LeaseRunView (the view itself is browser-verified, not
// jsdom-rendered — same discipline as PropertyIntelView). These shape the projection envelope
// into chart points, rollover markers, the mark-to-market chip text, and assumption-row display.
// Deterministic, null-safe — every helper is unit-tested.
import type {
  LeaseRunProjectionEnvelope,
  LeaseRunPeriod,
  MarkToMarket,
  RentStatus,
} from './analytics-hooks';

/** A point for the NOI trajectory chart (x = lease-year label, y = NOI). */
export interface NoiChartPoint {
  label: string;
  value: number;
  isAssumption: boolean;
  isRollover: boolean;
}

/** Lease-year labels where the rent STATUS changes — the rollover/option boundary markers. */
export function rolloverLabels(periods: LeaseRunPeriod[]): string[] {
  const labels: string[] = [];
  let prev: RentStatus | null = null;
  for (const p of periods) {
    if (prev !== null && p.status !== prev) labels.push(p.leaseYearLabel);
    prev = p.status;
  }
  return labels;
}

/** NOI trajectory points with assumption + rollover flags for the chart. */
export function noiChartPoints(periods: LeaseRunPeriod[]): NoiChartPoint[] {
  const rollovers = new Set(rolloverLabels(periods));
  return periods.map((p) => ({
    label: p.leaseYearLabel,
    value: p.noi,
    isAssumption: p.isAssumption,
    isRollover: rollovers.has(p.leaseYearLabel),
  }));
}

/** Human label + Badge tone for a rent-period status (UI flagging of data vs assumption). */
export function statusLabel(status: RentStatus): string {
  switch (status) {
    case 'contractual':
      return 'Contractual';
    case 'renewal_exercised':
      return 'Renewal (exercised)';
    case 'option_contractual':
      return 'Option (fixed rate)';
    case 'option_assumed':
      return 'Option (assumed)';
    default:
      return status;
  }
}

export type ChipTone = 'gold' | 'neutral';

export interface MarkToMarketChip {
  show: boolean;
  tone: ChipTone;
  label: string;
  /** A concise rollover-upside line, e.g. "in-place $5.10/SF vs $6.40/SF cohort — +25% rollover upside". */
  detail: string | null;
}

/** The below-market (rollover-upside) chip. Shows only when the engine flags belowMarket. */
export function markToMarketChip(mtm: MarkToMarket | null): MarkToMarketChip {
  if (!mtm || !mtm.belowMarket) {
    return { show: false, tone: 'neutral', label: '', detail: null };
  }
  const cur = mtm.currentBaseRentPsf;
  const med = mtm.cohortMedianPsf;
  const upside =
    mtm.upsidePct !== null ? ` — +${Math.round(mtm.upsidePct * 100)}% rollover upside` : '';
  const detail =
    cur !== null && med !== null
      ? `in-place $${cur.toFixed(2)}/SF vs $${med.toFixed(2)}/SF cohort${upside}`
      : null;
  return { show: true, tone: 'gold', label: 'Below market — rollover upside', detail };
}

/** Assumption rows the UI surfaces in the editable panel, with default-vs-overridden context. */
export interface AssumptionRow {
  key: string;
  label: string;
  value: number;
  format: 'pct' | 'usdPsf' | 'rate';
}

export function assumptionRows(envelope: LeaseRunProjectionEnvelope): AssumptionRow[] {
  const a = envelope.assumptions;
  return [
    { key: 'managementFeePct', label: 'Management fee (% of EGR)', value: a.managementFeePct, format: 'pct' },
    { key: 'roofStructuralReservePsf', label: 'Roof & structural reserve ($/SF)', value: a.roofStructuralReservePsf, format: 'usdPsf' },
    { key: 'vacancyCreditLossPct', label: 'Vacancy / credit loss', value: a.vacancyCreditLossPct, format: 'pct' },
    { key: 'renewalMarketGrowthPct', label: 'Renewal mkt growth (assumed options)', value: a.renewalMarketGrowthPct, format: 'pct' },
    { key: 'indicativeCapRate', label: 'Indicative cap rate', value: a.indicativeCapRate, format: 'rate' },
  ];
}

/** Count of flagged-assumption periods (drives the legend / "N assumption years" note). */
export function assumptionYearCount(periods: LeaseRunPeriod[]): number {
  return periods.filter((p) => p.isAssumption).length;
}
