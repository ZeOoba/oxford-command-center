import { Market } from '../contracts/common';
import type { AcquisitionInput } from '../contracts/acquisition';
import type { Deal } from '../contracts/deal';
import { RCT_VERSION as RCT_CONFIG_VERSION } from '../contracts/acquisition';
// The ratified configs the SERVER engine scores with (server/warehouse/acquisition.ts). Read here, never re-typed, so the
// deal-drawer badge cannot drift from the engine's verdict (audit 2026-11-08, client-basis-floor-engine-hardcodes-ruleset).
import rulesetJson from '../../config/acquisition-ruleset.v1.json';
import rctJson from '../../config/replacement-cost.v3.json';
import {
  adderTotal, adjustBand, basisClearsFloor, basisDiscount, constructionMultiplier, RCT_ADDER_IDS, tiltSfFor,
  type AdderSchedule, type ConstructionSchedule, type RctAdderId, type RctConstructionType,
} from '../lib/rct-adjust';

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

/** The engine's conservative firm-wide fallback band (config `psf`: the cheapest market, the strictest floor), under the
 *  same version/ratified/signed gate; null when the config does not carry a finite, positive band. */
export function fallbackFromConfig(cfg: unknown): RctEntry | null {
  if (Object.keys(rctFromConfig(cfg)).length === 0) return null; // same gate (version, ratified, signed)
  const p = (cfg as { psf?: Record<string, unknown> }).psf;
  const pos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
  if (typeof p !== 'object' || p === null || !pos(p.low) || !pos(p.mid) || !pos(p.high)) return null;
  return { low: p.low, point: p.mid, high: p.high, cwHardPsf: Number.NaN, proxy: false };
}

export const RCT_FALLBACK: RctEntry | null = fallbackFromConfig(rctJson);

export interface RctSchedule { constructionMultipliers: ConstructionSchedule; adders: AdderSchedule }

/** The construction-type multiplier and adder schedules from the same ratified config, or null (fail closed: the drawer
 *  then prices nothing) unless the config is the engine's version, ratified and signed, with every value finite and > 0
 *  (adders >= 0). Same gate as rctFromConfig, so the drawer and the engine always apply the same schedule. */
export function scheduleFromConfig(cfg: unknown): RctSchedule | null {
  if (typeof cfg !== 'object' || cfg === null) return null;
  const c = cfg as Record<string, unknown>;
  if (c.rctVersion !== RCT_CONFIG_VERSION) return null;
  const signed = c.ratification === 'ratified'
    && typeof c.ratifiedBy === 'string' && c.ratifiedBy !== ''
    && typeof c.ratifiedDate === 'string' && c.ratifiedDate !== '';
  if (!signed) return null;
  const pos = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v > 0;
  const nonneg = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const m = c.constructionMultipliers as Record<string, unknown> | undefined;
  const a = c.adders as Record<string, unknown> | undefined;
  if (typeof m !== 'object' || m === null || typeof a !== 'object' || a === null) return null;
  const p = m.pemb as Record<string, unknown> | undefined;
  if (typeof p !== 'object' || p === null) return null;
  if (![m['tilt-precast'], m.cmu, m.brick, m.hybrid, m.unknownCap, p.under20k, p.under40k, p.upTo50k, p.above50k].every(pos)) return null;
  if (!RCT_ADDER_IDS.every((id) => nonneg(a[id]))) return null;
  return {
    constructionMultipliers: {
      'tilt-precast': m['tilt-precast'] as number, cmu: m.cmu as number, brick: m.brick as number, hybrid: m.hybrid as number,
      pemb: { under20k: p.under20k as number, under40k: p.under40k as number, upTo50k: p.upTo50k as number, above50k: p.above50k as number },
      unknownCap: m.unknownCap as number,
    },
    adders: Object.fromEntries(RCT_ADDER_IDS.map((id) => [id, a[id] as number])) as AdderSchedule,
  };
}

export const RCT_SCHEDULE: RctSchedule | null = scheduleFromConfig(rctJson);

/**
 * Basis is ALL-IN: price + 2% closing + CapEx + lease-up carry (SKILL.md STAGE 1). The drawer adds CapEx and carry
 * when it has them. Without them the basis is understated and the walk price overstated, so both are then labelled
 * [EXCL. CAPEX/CARRY] and the walk is shown as an UPPER BOUND, never as the walk.
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
  /** False when the market has no RCT row and no fallback was asked for — everything priced below is then null. */
  marketCovered: boolean;
  /** True when the market has no RCT row and the engine's strictest firm-wide fallback band was used (engineFallback). */
  onFallback: boolean;
  /** RCT row is a neighbouring-metro stand-in — always DENOMINATOR-SENSITIVE pre-LOI. */
  proxy: boolean;
  low: number | null;
  mid: number | null; // SF × POINT — kept under the old name for the deal-drawer card
  high: number | null;
  estPrice: number | null;
  /** (price × 1.02 + CapEx + carry) ÷ SF — the all-in basis the floor is tested against (CapEx/carry only when known). */
  basisPsf: number | null;
  /** Construction-type multiplier applied to POINT (SKILL.md v4.37), and its screen citation ("PEMB ×0.90"). */
  multiplier: number | null;
  multiplierLabel: string | null;
  /** True when the type was unknown / mixed and the strictest applicable multiplier was assumed. */
  multiplierAssumed: boolean;
  /** Adder $/SF added to the multiplied POINT. */
  adderPsf: number;
  /** True when CapEx or lease-up carry is unknown: walkPrice is an UPPER BOUND (and basisPsf excludes them, unless it
   *  came from a saved all-in basis). */
  excludesCapexCarry: boolean;
  /** True when basisPsf is the saved all-in basis ÷ SF (the engine's own numerator). */
  basisFromSavedAllIn: boolean;
  /** True when yearBuilt was unknown and the ramp start (strictest floor) was assumed. */
  vintageAssumed: boolean;
  /** The year assumed for an unknown vintage (the ratified ramp start); null when the vintage is known or no floor is scored. */
  assumedVintageYear: number | null;
  /** Null when the ruleset is not ratified and signed: the basis is then not scored (fail closed). */
  vintageFloorPct: number | null;
  /** RCT LOW × (1 − vintageFloorPct). Basis must be at or below this. */
  floorPsf: number | null;
  /** Max price that would clear the floor: (adjusted LOW × (1 − floor) × SF − CapEx − carry) ÷ 1.02. An upper bound
   *  when excludesCapexCarry. */
  walkPrice: number | null;
  /** Sensitivity only (doctrine): the walk at ×1.00 when the type was assumed. Never the walk. */
  walkPriceAtBaseline: number | null;
  clearsFloor: boolean | null;
  /** Basis $/SF as a share of POINT replacement — ORA's real buy zone is ~0.35–0.40. */
  basisToPoint: number | null;
  priceToReplacementMid: number | null;
  verdict: ReplacementVerdict | null;
  basis: string;
}

export interface RcDeal {
  /** TOTAL SF (the Deal record's sf). */
  sf: number | null;
  /** Building count (the Deal record carries it). NOT read by the size tilt: the caller resolves maxBuildingSf, as the
   *  scoring form does for the engine (see DealDrawer). */
  buildings?: number | null;
  /** Largest single building's SF; the PEMB size tilt reads it exactly as the engine does (tiltSfFor). Unknown => the
   *  strictest band. */
  maxBuildingSf?: number | null;
  estPrice: number | null;
  market?: Market | null;
  yearBuilt?: number | null;
  /** Unknown (absent / null) => the strictest applicable multiplier, tagged [DATA-GAP: construction type]. */
  constructionType?: RctConstructionType | null;
  rctAdders?: readonly RctAdderId[] | null;
  /** True when this analysis prices a SAVED underwriting input: a market with no RCT row then takes the engine's strictest
   *  firm-wide fallback (exactly as scoreAcquisition does) instead of pricing nothing. */
  engineFallback?: boolean;
  /** True when built from a saved underwriting input (rcDealFor): the verdict then needs the saved all-in basis, exactly
   *  as the engine's basis floor does; without it the floor is indeterminate (no badge), never a price-derived guess. */
  fromSavedInput?: boolean;
  /** The market name as entered, for the label only (a saved market with no RCT row reaches `market` as null). */
  marketLabel?: string | null;
  /** The saved all-in basis $ (price + closing + CapEx + carry, as the engine tests it). When known, the basis $/SF is
   *  allInBasis ÷ SF, the engine's own numerator, instead of price × 1.02 (+ CapEx + carry). */
  allInBasis?: number | null;
  /** Total $ CapEx and lease-up carry in the all-in basis. Absent / null => unknown, the walk is an upper bound. */
  capex?: number | null;
  leaseUpCarry?: number | null;
}

/** Replacement-cost analysis for a deal. Null when SF is unknown (cannot compute a basis). */
export function replacementCostAnalysis(deal: RcDeal): ReplacementCostAnalysis | null {
  return replacementCostAnalysisWith(deal, RATIFIED_FLOORS, RCT_SCHEDULE);
}

/** replacementCostAnalysis over explicit floors (null = ruleset not ratified/signed: basis not scored). Exported for tests. */
export function replacementCostAnalysisWith(
  deal: RcDeal,
  floors: BasisVintageFloors | null,
  schedule: RctSchedule | null = RCT_SCHEDULE,
): ReplacementCostAnalysis | null {
  if (deal.sf === null || deal.sf <= 0) return null;
  const sf = deal.sf;
  // No ratified schedule => price nothing (fail closed), exactly as for a market with no row. A saved input whose market
  // has no row is priced on the engine's fallback band, never on a different (looser) row (refute wf_a7d3a06f-2a8).
  const marketRow = deal.market ? RCT_V03[deal.market] : undefined;
  const onFallback = marketRow === undefined && deal.engineFallback === true && RCT_FALLBACK !== null;
  const entry = schedule === null ? undefined : (marketRow ?? (onFallback ? RCT_FALLBACK! : undefined));
  const vintageAssumed = deal.yearBuilt === null || deal.yearBuilt === undefined;
  const assumedVintageYear = vintageAssumed && floors !== null ? floors.basisVintageRampStartYear : null;
  const vintageFloorPct = floors === null ? null : vintageFloorFor(deal.yearBuilt, floors);
  const estPrice = deal.estPrice;
  const known = (v: number | null | undefined): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;
  const excludesCapexCarry = !known(deal.capex) || !known(deal.leaseUpCarry);
  const capexCarry = (known(deal.capex) ? deal.capex : 0) + (known(deal.leaseUpCarry) ? deal.leaseUpCarry : 0);
  const savedAllIn = typeof deal.allInBasis === 'number' && Number.isFinite(deal.allInBasis) && deal.allInBasis > 0 ? deal.allInBasis : null;
  // The all-in $ the floor is tested on: the saved all-in basis (the engine's numerator), else price × 1.02 + known
  // CapEx/carry. A saved input with no all-in basis is indeterminate in the engine, so it gets no verdict here either.
  const allInForTest = savedAllIn ?? (estPrice !== null ? estPrice * CLOSING_COST_LOAD + capexCarry : null);
  const verdictAllIn = deal.fromSavedInput === true ? savedAllIn : allInForTest;
  const basisPsf = allInForTest !== null ? allInForTest / sf : null;
  const basisFromSavedAllIn = savedAllIn !== null;
  const noMultiplier = { multiplier: null, multiplierLabel: null, multiplierAssumed: false, adderPsf: 0, excludesCapexCarry, basisFromSavedAllIn, walkPriceAtBaseline: null };

  if (!entry || schedule === null) {
    return {
      rctVersion: RCT_VERSION,
      sf,
      marketCovered: false,
      onFallback: false,
      proxy: false,
      low: null,
      mid: null,
      high: null,
      estPrice,
      basisPsf,
      ...noMultiplier,
      vintageAssumed,
      assumedVintageYear,
      vintageFloorPct,
      floorPsf: null,
      walkPrice: null,
      clearsFloor: null,
      basisToPoint: null,
      priceToReplacementMid: null,
      verdict: null,
      basis: schedule === null && deal.market && RCT_V03[deal.market]
        ? `${RCT_VERSION} — construction-type schedule not ratified and signed; basis cannot be scored`
        : `${RCT_VERSION} — no replacement cost for this market; basis cannot be scored`,
    };
  }

  // SKILL.md v4.37: POINT × construction multiplier + adders; LOW/HIGH at ±10%. Unknown type => strictest multiplier.
  // The size tilt uses the engine's exact rule (tiltSfFor): the largest building's SF, else the strictest band. Never
  // the total on its own (refute wf_3124f132-f17, wf_3b4097ae-24d).
  const ct = constructionMultiplier(deal.constructionType ?? null, tiltSfFor(deal.maxBuildingSf, sf), schedule.constructionMultipliers);
  const add = adderTotal(deal.rctAdders ?? null, schedule.adders);
  const band = adjustBand(entry, ct.multiplier, add.psf);
  const multiplierFields = {
    multiplier: ct.multiplier, multiplierLabel: ct.label, multiplierAssumed: ct.assumed, adderPsf: add.psf, excludesCapexCarry, basisFromSavedAllIn,
  };
  const cite = `${ct.label}${add.psf > 0 ? ` + $${add.psf}/SF adders` : ''}`;

  if (floors === null || vintageFloorPct === null) {
    // Fail closed: the RCT is priced, but no ratified floor exists to test the basis against.
    return {
      rctVersion: RCT_VERSION, sf, marketCovered: true, onFallback, proxy: entry.proxy,
      low: sf * band.low, mid: sf * band.point, high: sf * band.high, estPrice, basisPsf, ...multiplierFields, walkPriceAtBaseline: null,
      vintageAssumed, assumedVintageYear: null,
      vintageFloorPct: null, floorPsf: null, walkPrice: null, clearsFloor: null,
      basisToPoint: basisPsf !== null ? basisPsf / band.point : null,
      priceToReplacementMid: estPrice !== null && band.point > 0 ? estPrice / (sf * band.point) : null,
      verdict: null,
      basis: `${RCT_VERSION} ${deal.market} · ${cite} — acquisition ruleset not ratified and signed; basis floor not scored`,
    };
  }
  const floorPsf = band.low * (1 - vintageFloorPct);
  // True all-in walk (SKILL.md STAGE 1): the max price whose price + 2% closing + CapEx + carry sits at the floor.
  const walkPrice = (floorPsf * sf - capexCarry) / CLOSING_COST_LOAD;
  const walkPriceAtBaseline = ct.assumed
    ? (adjustBand(entry, 1, add.psf).low * (1 - vintageFloorPct) * sf - capexCarry) / CLOSING_COST_LOAD
    : null;
  const clearsFloor = verdictAllIn !== null ? basisClearsFloor(basisDiscount(verdictAllIn, sf, band.low), vintageFloorPct) : null;
  const mid = sf * band.point;

  return {
    rctVersion: RCT_VERSION,
    sf,
    marketCovered: true,
    onFallback,
    proxy: entry.proxy,
    low: sf * band.low,
    mid,
    high: sf * band.high,
    estPrice,
    basisPsf,
    ...multiplierFields,
    walkPriceAtBaseline,
    vintageAssumed,
    assumedVintageYear,
    vintageFloorPct,
    floorPsf,
    walkPrice,
    clearsFloor,
    basisToPoint: basisPsf !== null ? basisPsf / band.point : null,
    priceToReplacementMid: estPrice !== null && mid > 0 ? estPrice / mid : null,
    verdict: clearsFloor === null ? null : clearsFloor ? 'Clears basis floor' : 'Fails basis floor',
    basis: `${RCT_VERSION} ${onFallback ? `${deal.marketLabel ?? deal.market ?? 'market not supplied'} (not priced: strictest firm-wide fallback)` : deal.market} · ${cite} — LOW $${band.low.toFixed(2)}/SF · floor ${(vintageFloorPct * 100).toFixed(1)}%${vintageAssumed ? ` (vintage assumed ${assumedVintageYear})` : ''}${entry.proxy ? ' · [PROXY]' : ''}${excludesCapexCarry ? ' · [EXCL. CAPEX/CARRY]' : ''}`,
  };
}

/**
 * The drawer's RcDeal for a pipeline Deal and its saved underwriting input (refute wf_a7d3a06f-2a8, wf_0b88835c-c66).
 * With a saved input, EVERY field of the basis test comes from that one record, exactly as the engine scores it:
 * numerator (allInBasis, else its price; the Deal's estPrice only when it has neither), SF, largest building, market (a
 * market with no RCT row takes the engine's strictest fallback, never the Deal's row), construction type, adders and
 * vintage. Without one, the Deal is priced as before, with the largest building known only for a one-building Deal, which
 * is what the scoring form prefills for the engine (dealToForm).
 */
export function rcDealFor(deal: Deal, saved: AcquisitionInput | null): RcDeal {
  if (saved === null) {
    return {
      sf: deal.sf, estPrice: deal.estPrice, market: deal.market,
      maxBuildingSf: deal.buildings === 1 ? deal.sf : null,
      constructionType: null, rctAdders: null, yearBuilt: null,
    };
  }
  const covered = saved.market !== null && Object.prototype.hasOwnProperty.call(RCT_V03, saved.market);
  return {
    // The engine's own SF (grossSf = totalSf ?? maxBuildingSf). Never the Deal's SF: with neither saved SF the engine's
    // floor is indeterminate, so the drawer prices nothing ('SF unknown') rather than a verdict the engine never gave
    // (independent review 2026-11-13).
    sf: saved.totalSf ?? saved.maxBuildingSf,
    // Never the Deal's price against the saved SF: the saved price (an estimate shown without a verdict) or nothing.
    estPrice: saved.price,
    fromSavedInput: true,
    allInBasis: saved.allInBasis,
    market: covered ? (saved.market as Market) : null,
    marketLabel: saved.market,
    engineFallback: true,
    maxBuildingSf: saved.maxBuildingSf,
    constructionType: saved.constructionType,
    rctAdders: saved.rctAdders,
    yearBuilt: saved.yearBuilt,
  };
}
