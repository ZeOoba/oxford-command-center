import { Market } from '../contracts/common';
import { RCT_VERSION as RCT_CONFIG_VERSION } from '../contracts/acquisition';
// The ratified configs the SERVER engine scores with (server/warehouse/acquisition.ts). Read here, never re-typed, so the
// deal-drawer badge cannot drift from the engine's verdict (audit 2026-11-08, client-basis-floor-engine-hardcodes-ruleset).
import rulesetJson from '../../config/acquisition-ruleset.v1.json';
import rctJson from '../../config/replacement-cost.v3.json';

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
 * The RCT table, built from `config/replacement-cost.v3.json`, the SAME file the server engine divides by (both cite the
 * `acquisition-underwriting` skill's RCT v03 table as the true authoritative source — SKILL.md: "There is now ONE
 * denominator: RCT v03. If you find a second, it is a bug"). It used to be a hand-maintained copy of that file
 * (OI-354 caught it covering 4 of 9 markets; the 2026-11-08 audit caught the copy as a drift risk), so it is now read
 * from the config instead of re-typed. Mirrors the server's rule: an RCT that is not ratified AND signed prices nothing.
 * `tests/unit/replacement-cost-ruleset-source.test.ts` pins the values to the pre-change table (no value moved).
 */
export function rctFromConfig(cfg: unknown): Readonly<Partial<Record<Market, RctEntry>>> {
  const out: Partial<Record<Market, RctEntry>> = {};
  if (typeof cfg !== 'object' || cfg === null) return out;
  const c = cfg as { rctVersion?: unknown; ratification?: unknown; ratifiedBy?: unknown; ratifiedDate?: unknown; markets?: unknown };
  // Same version the server's ReplacementCostTable contract accepts (z.literal(RCT_VERSION)); a bumped config the server
  // refuses must not keep pricing the drawer under the old label (refute wf_3d47a7eb-3e0).
  if (c.rctVersion !== RCT_CONFIG_VERSION) return out;
  const signed = c.ratification === 'ratified'
    && typeof c.ratifiedBy === 'string' && c.ratifiedBy !== ''
    && typeof c.ratifiedDate === 'string' && c.ratifiedDate !== '';
  if (!signed || typeof c.markets !== 'object' || c.markets === null) return out;
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  for (const [key, row] of Object.entries(c.markets as Record<string, unknown>)) {
    const market = Market.safeParse(key);
    if (!market.success || typeof row !== 'object' || row === null) continue;
    const r = row as Record<string, unknown>;
    if (!fin(r.low) || !fin(r.point) || !fin(r.high) || !fin(r.cwHardPsf) || typeof r.proxy !== 'boolean') continue;
    out[market.data] = { low: r.low, point: r.point, high: r.high, cwHardPsf: r.cwHardPsf, proxy: r.proxy };
  }
  return out;
}

/** Keyed by the `Market` enum. The enum also carries 'Toledo OH' / 'Cleveland MSA' / 'Other' / 'Unknown', which have no
 *  RCT row and are NOT priced — we do not invent a denominator. See `marketCovered`. */
export const RCT_V03: Readonly<Partial<Record<Market, RctEntry>>> = rctFromConfig(rctJson);

/**
 * Basis is ALL-IN (price + closing + CapEx + lease-up carry). At engine level we know price
 * but not CapEx or carry, so this 2% closing load is a DELIBERATELY GENEROUS proxy — the
 * true basis is always worse than what we compute here.
 */
export const CLOSING_COST_LOAD = 1.02;

/** The ratified Basis vintage-ramp inputs (`config/acquisition-ruleset.v1.json` `floors`). */
export interface BasisVintageFloors {
  basisDiscountMinPreMillennium: number;
  basisDiscountMinPostMillennium: number;
  basisVintageRampStartYear: number;
  basisVintageCutoffYear: number;
}

/** Same formula as the server engine's `basisVintageFloor` (server/warehouse/acquisition.ts), over any floors. */
export function vintageFloorFor(yearBuilt: number | null | undefined, floors: BasisVintageFloors): number {
  const strict = floors.basisDiscountMinPreMillennium;
  const loose = floors.basisDiscountMinPostMillennium;
  const start = floors.basisVintageRampStartYear;
  const end = floors.basisVintageCutoffYear;
  if (yearBuilt === null || yearBuilt === undefined) return strict;
  if (end <= start) return yearBuilt >= end ? loose : strict; // degenerate config ⇒ behave as a cliff
  const clamped = Math.min(end, Math.max(start, yearBuilt));
  return strict + ((clamped - start) / (end - start)) * (loose - strict);
}

/** The vintage-ramp floors from a ruleset config, or null unless it is ratified AND signed with four finite floor values.
 *  Mirrors rctFromConfig and the server's assertProductionRuleset (refute wf_6e927240-7cc low): an unratified ruleset
 *  must not drive a basis verdict, so the drawer fails closed (basis not scored) instead of reading it anyway. */
export function floorsFromRuleset(cfg: unknown): BasisVintageFloors | null {
  if (typeof cfg !== 'object' || cfg === null) return null;
  const c = cfg as { ratification?: unknown; ratifiedBy?: unknown; ratifiedDate?: unknown; floors?: unknown };
  const signed = c.ratification === 'ratified'
    && typeof c.ratifiedBy === 'string' && c.ratifiedBy !== ''
    && typeof c.ratifiedDate === 'string' && c.ratifiedDate !== '';
  if (!signed || typeof c.floors !== 'object' || c.floors === null) return null;
  const f = c.floors as Record<string, unknown>;
  const fin = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
  if (!fin(f.basisDiscountMinPreMillennium) || !fin(f.basisDiscountMinPostMillennium)
    || !fin(f.basisVintageRampStartYear) || !fin(f.basisVintageCutoffYear)) return null;
  return {
    basisDiscountMinPreMillennium: f.basisDiscountMinPreMillennium,
    basisDiscountMinPostMillennium: f.basisDiscountMinPostMillennium,
    basisVintageRampStartYear: f.basisVintageRampStartYear,
    basisVintageCutoffYear: f.basisVintageCutoffYear,
  };
}

const RATIFIED_FLOORS: BasisVintageFloors | null = floorsFromRuleset(rulesetJson);

/**
 * Vintage ramp, read from the ratified ruleset (today: 65% discount floor at ≤1995, sliding to 60% at ≥2005).
 *
 * ⚠️ The floor % and the denominator are a MATCHED PAIR. This ramp is calibrated to RCT v03
 * and must not be moved without re-solving the other. Against RCT v03 the legacy 25–30%
 * floor would let a Columbus deal pay ~$160/SF and "clear" — every candidate in the buy-box
 * passes. A floor that passes everything is not a floor.
 *
 * ORA buys at ~35–40% of TRUE all-in replacement cost. The legacy "25% discount" framing was
 * an artifact of an understated denominator, never the strategy.
 *
 * Unknown vintage resolves to the STRICTEST floor (the ramp start). Never hand a building a
 * looser floor because we failed to look its year up. Null when the ruleset is not ratified and signed (fail closed).
 */
export function vintageFloor(yearBuilt: number | null | undefined): number | null {
  return RATIFIED_FLOORS === null ? null : vintageFloorFor(yearBuilt, RATIFIED_FLOORS);
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
  /** True when yearBuilt was unknown and the ramp start (strictest floor) was assumed. */
  vintageAssumed: boolean;
  /** The year assumed for an unknown vintage (the ratified ramp start); null when the vintage is known or no floor is scored. */
  assumedVintageYear: number | null;
  /** Null when the ruleset is not ratified and signed: the basis is then not scored (fail closed). */
  vintageFloorPct: number | null;
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

interface RcDeal {
  sf: number | null;
  estPrice: number | null;
  market?: Market | null;
  yearBuilt?: number | null;
}

/** Replacement-cost analysis for a deal. Null when SF is unknown (cannot compute a basis). */
export function replacementCostAnalysis(deal: RcDeal): ReplacementCostAnalysis | null {
  return replacementCostAnalysisWith(deal, RATIFIED_FLOORS);
}

/** replacementCostAnalysis over explicit floors (null = ruleset not ratified/signed: basis not scored). Exported for tests. */
export function replacementCostAnalysisWith(deal: RcDeal, floors: BasisVintageFloors | null): ReplacementCostAnalysis | null {
  if (deal.sf === null || deal.sf <= 0) return null;
  const sf = deal.sf;
  const entry = deal.market ? RCT_V03[deal.market] : undefined;
  const vintageAssumed = deal.yearBuilt === null || deal.yearBuilt === undefined;
  const assumedVintageYear = vintageAssumed && floors !== null ? floors.basisVintageRampStartYear : null;
  const vintageFloorPct = floors === null ? null : vintageFloorFor(deal.yearBuilt, floors);
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
      assumedVintageYear,
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

  if (floors === null || vintageFloorPct === null) {
    // Fail closed: the RCT is priced, but no ratified floor exists to test the basis against.
    return {
      rctVersion: RCT_VERSION, sf, marketCovered: true, proxy: entry.proxy,
      low: sf * entry.low, mid: sf * entry.point, high: sf * entry.high, estPrice, basisPsf, vintageAssumed, assumedVintageYear: null,
      vintageFloorPct: null, floorPsf: null, walkPrice: null, clearsFloor: null,
      basisToPoint: basisPsf !== null ? basisPsf / entry.point : null,
      priceToReplacementMid: estPrice !== null && entry.point > 0 ? estPrice / (sf * entry.point) : null,
      verdict: null,
      basis: `${RCT_VERSION} ${deal.market} — acquisition ruleset not ratified and signed; basis floor not scored`,
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
    assumedVintageYear,
    vintageFloorPct,
    floorPsf,
    walkPrice,
    clearsFloor,
    basisToPoint: basisPsf !== null ? basisPsf / entry.point : null,
    priceToReplacementMid: estPrice !== null && mid > 0 ? estPrice / mid : null,
    verdict: clearsFloor === null ? null : clearsFloor ? 'Clears basis floor' : 'Fails basis floor',
    basis: `${RCT_VERSION} ${deal.market} — LOW $${entry.low.toFixed(2)}/SF · floor ${(vintageFloorPct * 100).toFixed(1)}%${vintageAssumed ? ` (vintage assumed ${assumedVintageYear})` : ''}${entry.proxy ? ' · [PROXY]' : ''}`,
  };
}
