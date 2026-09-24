import type { ScatterPoint } from '@/charts/ScatterChart';
import type { SaleComp } from '@contracts/comps';
import type { CapitalAllocationEntry } from '@contracts/capital-allocation';

export function saleCompPoints(comps: SaleComp[]): ScatterPoint[] {
  return comps.flatMap((c, i) =>
    c.pricePerSf !== null && c.capRate !== null ? [{ id: `${c.address}-${i}`, x: c.pricePerSf, y: c.capRate, label: c.address }] : []);
}

export function allocationCapPoints(rows: CapitalAllocationEntry[]): ScatterPoint[] {
  return rows.flatMap((r) =>
    r.impliedCapRate !== null && r.capRateGap !== null
      ? [{ id: r.propertyId, x: r.impliedCapRate, y: r.capRateGap, label: r.propertyName ?? r.propertyId, tone: r.capRateGap >= 0 ? 'pos' as const : 'neg' as const }]
      : []);
}
