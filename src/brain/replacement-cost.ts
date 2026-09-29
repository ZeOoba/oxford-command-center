import type { Market } from '../contracts/common';

/**
 * ORA replacement cost — RCT v03 (ratified by Gabriel 2026-07-14; supersedes the flat
 * firm-wide $125/$137.50/$150 of config/replacement-cost.v1.json).
 *
 * The Basis floor divides by LOW. RCT_VERSION is pinned so a Basis score stays
 * reproducible. AUTHORITATIVE COPY: the `acquisition-underwriting` skill, "Replacement
 * Cost Table (RCT v03)". If this table and that one ever disagree, THAT ONE WINS and
 * this is the bug.
 *
 * Built from a primary source; each step is auditable:
 *   POINT = C&W hard cost (small tier) × shallow-bay size premium × soft/profit/fin × escalation
 *     1. C&W 2025 Industrial Construction Cost Guide, small tier (109,200 rsf)  [SOURCED]
 *     2. shallow-bay premium ~+43% at 40K SF, from C&W's OWN size curve         [SOURCED]
 *     3. soft + developer profit + financing  ×1.30                             [EST]
 *     4. escalation ×1.0487 (Turner BCI, lowest of three indices)               [SOURCED]
 *     5. band ±10%  ⇒  LOW = 0.90 × POINT
 *
 * WHY THE FLAT $125–150 WAS WRONG, not merely imprecise: it had no per-market variation
 * at all, and it sat at roughly HALF true all-in shallow-bay replacement cost. An
 * understated replacement cost makes computed discounts too small, so deals fail the
 * floor — i.e. it made ORA TOO STRICT, passing on deals that clear doctrine.
 */
export const RCT_VERSION = 'RCT v03' as const;

export interface RctEntry {
  /** Basis floor and Basis score divide by this. */
  low: number;
  point: number;
  high: number;
  /** The sourced C&W hard cost this row was built from — retained for the coherence check. */
  cwHardPsf: number;
  /** True when the C&W row is a stand-in from a neighbouring metro (always DENOMINATOR-SENSITIVE). */
  proxy: boolean;
}

/**
 * Keyed by the `Market` enum. The enum also carries 'Toledo OH' / 'Cleveland MSA' / 'Other' /
 * 'Unknown', which have no RCT row and are NOT priced — we do not invent a denominator. See
 * `marketCovered`.
 *
 * This table is a hand-maintained mirror of `config/replacement-cost.v3.json` (the server
 * engine's copy, both citing the `acquisition-underwriting` skill's RCT v03 table as the true
 * authoritative source — SKILL.md: "There is now ONE denominator: RCT v03. If you find a
 * second, it is a bug"). It previously covered only 4 of the then-9 ratified markets, silently
 * showing "basis cannot be scored" in the deal drawer for 5 markets the server engine could
 * already score — caught by cc-audit-army 2026-09-28 (OI-354), synced here to match the skill's
 * current 10-market table (incl. Louisville KY, added to the skill 2026-08-11). A test in
 * `tests/unit/replacement-cost-client-parity.test.ts` pins this object's keys and values to
 * `config/replacement-cost.v3.json` so the two cannot silently re-diverge.
 */
export const RCT_V03: Readonly<Partial<Record<Market, RctEntry>>> = {
  'Columbus OH': { low: 229.65, point: 255.16, high: 280.68, cwHardPsf: 130.51, proxy: false },
  'Cincinnati OH': { low: 251.46, point: 279.4, high: 307.34, cwHardPsf: 143.15, proxy: false },
  'Kansas City MO': { low: 227.9, point: 253.22, high: 278.54, cwHardPsf: 129.94, proxy: false },
  'Indianapolis IN': { low: 253.83, point: 282.03, high: 310.24, cwHardPsf: 143.46, proxy: false },
  // Mid-Atlantic == ORA's Maryland / Baltimore–DC cluster; priced off the C&W Baltimore row.
  'Mid-Atlantic': { low: 232.97, point: 258.85, high: 284.74, cwHardPsf: 133.7, proxy: false },
  'Madison WI': { low: 229.08, point: 254.53, high: 279.98, cwHardPsf: 130.05, proxy: true },
  'Grand Rapids MI': { low: 253.11, point: 281.23, high: 309.36, cwHardPsf: 143.64, proxy: true },
  'Richmond VA': { low: 232.97, point: 258.85, high: 284.74, cwHardPsf: 133.7, proxy: true },
  'Des Moines IA': { low: 231.66, point: 257.4, high: 283.14, cwHardPsf: 131.46, proxy: true },
  // SOURCED, not proxied (skill correction 2026-08-11) — present in the C&W 2025 guide directly.
  'Louisville KY': { low: 237.07, point: 263.41, high: 289.75, cwHardPsf: 135.28, proxy: false },
} as const;

/**
 * Basis is ALL-IN (price + closing + CapEx + lease-up carry). At engine level we know price
 * but not CapEx or carry, so this 2% closing load is a DELIBERATELY GENEROUS proxy — the
 * true basis is always worse than what we compute here.
 */
export const CLOSING_COST_LOAD = 1.02;

/**
 * Vintage ramp: 65% discount floor at ≤1995, sliding to 60% at ≥2005 (−0.5%/yr).
 *
 * ⚠️ The floor % and the denominator are a MATCHED PAIR. This ramp is calibrated to RCT v03
 * and must not be moved without re-solving the other. Against RCT v03 the legacy 25–30%
 * floor would let a Columbus deal pay ~$160/SF and "clear" — every candidate in the buy-box
 * passes. A floor that passes everything is not a floor.
 *
 * ORA buys at ~35–40% of TRUE all-in replacement cost. The legacy "25% discount" framing was
 * an artifact of an understated denominator, never the strategy.
 *
 * Unknown vintage resolves to 1995 — the STRICTEST floor. Never hand a building a looser
 * floor because we failed to look its year up.
 */
export function vintageFloor(yearBuilt: number | null | undefined): number {
  const y = yearBuilt ?? 1995;
  const clamped = Math.min(2005, Math.max(1995, y));
  return 0.65 - (clamped - 1995) * 0.005;
}

export type ReplacementVerdict = 'Clears basis floor' | 'Fails basis floor';

export interface ReplacementCostAnalysis {
  rctVersion: typeof RCT_VERSION;
  sf: number;
  /** False when the market has no RCT row — everything priced below is then null. */
  marketCovered: boolean;
  /** RCT row is a neighbouring-metro stand-in — always DENOMINATOR-SENSITIVE pre-LOI. */
  proxy: boolean;
  low: number | null;
  mid: number | null; // SF × POINT — kept under the old name for the deal-drawer card
  high: number | null;
  estPrice: number | null;
  /** (price × 1.02) ÷ SF — the all-in basis proxy the floor is tested against. */
  basisPsf: number | null;
  /** True when yearBuilt was unknown and 1995 (strictest) was assumed. */
  vintageAssumed: boolean;
  vintageFloorPct: number;
  /** RCT LOW × (1 − vintageFloorPct). Basis must be at or below this. */
  floorPsf: number | null;
  /** Max price that would clear the floor. */
  walkPrice: number | null;
  clearsFloor: boolean | null;
  /** Basis $/SF as a share of POINT replacement — ORA's real buy zone is ~0.35–0.40. */
  basisToPoint: number | null;
  priceToReplacementMid: number | null;
  verdict: ReplacementVerdict | null;
  basis: string;
}

/** Replacement-cost analysis for a deal. Null when SF is unknown (cannot compute a basis). */
export function replacementCostAnalysis(deal: {
  sf: number | null;
  estPrice: number | null;
  market?: Market | null;
  yearBuilt?: number | null;
}): ReplacementCostAnalysis | null {
  if (deal.sf === null || deal.sf <= 0) return null;
  const sf = deal.sf;
  const entry = deal.market ? RCT_V03[deal.market] : undefined;
  const vintageAssumed = deal.yearBuilt === null || deal.yearBuilt === undefined;
  const vintageFloorPct = vintageFloor(deal.yearBuilt);
  const estPrice = deal.estPrice;
  const basisPsf = estPrice !== null ? (estPrice * CLOSING_COST_LOAD) / sf : null;

  if (!entry) {
    return {
      rctVersion: RCT_VERSION,
      sf,
      marketCovered: false,
      proxy: false,
      low: null,
      mid: null,
      high: null,
      estPrice,
      basisPsf,
      vintageAssumed,
      vintageFloorPct,
      floorPsf: null,
      walkPrice: null,
      clearsFloor: null,
      basisToPoint: null,
      priceToReplacementMid: null,
      verdict: null,
      basis: `${RCT_VERSION} — no replacement cost for this market; basis cannot be scored`,
    };
  }

  const floorPsf = entry.low * (1 - vintageFloorPct);
  const walkPrice = (floorPsf * sf) / CLOSING_COST_LOAD;
  const clearsFloor = basisPsf !== null ? basisPsf <= floorPsf : null;
  const mid = sf * entry.point;

  return {
    rctVersion: RCT_VERSION,
    sf,
    marketCovered: true,
    proxy: entry.proxy,
    low: sf * entry.low,
    mid,
    high: sf * entry.high,
    estPrice,
    basisPsf,
    vintageAssumed,
    vintageFloorPct,
    floorPsf,
    walkPrice,
    clearsFloor,
    basisToPoint: basisPsf !== null ? basisPsf / entry.point : null,
    priceToReplacementMid: estPrice !== null && mid > 0 ? estPrice / mid : null,
    verdict: clearsFloor === null ? null : clearsFloor ? 'Clears basis floor' : 'Fails basis floor',
    basis: `${RCT_VERSION} ${deal.market} — LOW $${entry.low.toFixed(2)}/SF · floor ${(vintageFloorPct * 100).toFixed(1)}%${vintageAssumed ? ' (vintage assumed 1995)' : ''}${entry.proxy ? ' · [PROXY]' : ''}`,
  };
}
