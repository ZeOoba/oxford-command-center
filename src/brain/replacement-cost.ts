import type { Deal } from '../contracts/index';

/**
 * ORA replacement-cost basis — firm range $85–$120/SF, building-class dependent (per markets.md;
 * per-market validated figures pending). Drives the deal-drawer Replacement Cost card.
 */
export const REPLACEMENT_COST_PSF = { low: 85, mid: 102.5, high: 120 } as const;

export type ReplacementVerdict = 'Discount to replacement' | 'Near replacement' | 'Premium to replacement';

export interface ReplacementCostAnalysis {
  sf: number;
  low: number; // sf × $85
  mid: number; // sf × $102.5
  high: number; // sf × $120
  estPrice: number | null;
  priceToReplacementMid: number | null; // estPrice ÷ mid
  verdict: ReplacementVerdict | null;
  basis: string;
}

/** Replacement-cost analysis for a deal. Null when SF is unknown (can't compute). */
export function replacementCostAnalysis(deal: Pick<Deal, 'sf' | 'estPrice'>): ReplacementCostAnalysis | null {
  if (deal.sf === null || deal.sf <= 0) return null;
  const sf = deal.sf;
  const low = sf * REPLACEMENT_COST_PSF.low;
  const mid = sf * REPLACEMENT_COST_PSF.mid;
  const high = sf * REPLACEMENT_COST_PSF.high;
  const estPrice = deal.estPrice;
  const priceToReplacementMid = estPrice !== null && mid > 0 ? estPrice / mid : null;
  const verdict: ReplacementVerdict | null =
    priceToReplacementMid === null
      ? null
      : priceToReplacementMid < 0.9
        ? 'Discount to replacement'
        : priceToReplacementMid <= 1.1
          ? 'Near replacement'
          : 'Premium to replacement';
  return { sf, low, mid, high, estPrice, priceToReplacementMid, verdict, basis: 'ORA $85–$120/SF (building-class dependent)' };
}
