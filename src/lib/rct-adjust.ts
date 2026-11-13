/**
 * Construction-type multiplier and adder schedule for the RCT v03 denominator (acquisition-underwriting SKILL.md v4.37,
 * "Construction-Type Multiplier Schedule" + "Adder schedule"; every multiplier [EST], calibration-pending).
 *
 * ONE implementation, shared by the server engine (server/warehouse/acquisition.ts) and the deal drawer
 * (src/brain/replacement-cost.ts), so the engine's Basis verdict and the drawer's walk price cannot drift apart. The
 * VALUES live in config/replacement-cost.v3.json (ratified with the table; rctVersion folds into inputsVersion), never
 * here.
 *
 * Order of operations (doctrine): (1) the market's RCT POINT × the multiplier; (2) + the adders; (3) LOW and HIGH at
 * ±10% of the result; (4) the Basis floor, Basis points and walk price use the adjusted LOW.
 *
 * Step (3) is applied as `table LOW × multiplier + 0.90 × adders` (HIGH likewise at 1.10), not `0.90 × (POINT ×
 * multiplier + adders)`. The two are the same formula, but the ratified table rounds each column to the cent, so
 * `0.90 × POINT` can sit up to $0.01 off the ratified LOW (Columbus: 229.644 vs 229.65). Anchoring on the ratified LOW
 * keeps a tilt-up building with no adders priced on EXACTLY the ratified row.
 */

/** Construction types the RCT schedule distinguishes. `block-tilt-brick` (the pre-v4.37 lump) is a LEGACY value: the
 *  contract maps it to `cmu` on parse (Gabriel ruling 2026-11-12: the strictest of its members short of PEMB). */
export const RCT_CONSTRUCTION_TYPES = ['tilt-precast', 'cmu', 'brick', 'hybrid', 'pemb', 'mixed', 'unknown'] as const;
export type RctConstructionType = (typeof RCT_CONSTRUCTION_TYPES)[number];

/** The documented adder schedule (SKILL.md "Adder schedule"). Applied only when the subject genuinely carries the feature. */
export const RCT_ADDER_IDS = ['heavy-office', 'climate-controlled', 'cranes', 'esfr', 'excess-site-work', 'paving-lighting'] as const;
export type RctAdderId = (typeof RCT_ADDER_IDS)[number];

export interface PembSizeTilt {
  /** under ~20,000 SF */
  under20k: number;
  /** 20,000 to under 40,000 SF */
  under40k: number;
  /** 40,000–50,000 SF */
  upTo50k: number;
  /** above 50,000 SF: outside the band (doctrine: use the largest band, tagged [EST: outside band]) */
  above50k: number;
}

export interface ConstructionSchedule {
  'tilt-precast': number;
  cmu: number;
  brick: number;
  hybrid: number;
  pemb: PembSizeTilt;
  /** Unknown type ⇒ the PEMB value for the subject's SF, capped at this (doctrine: 0.90). */
  unknownCap: number;
}

export type AdderSchedule = Record<RctAdderId, number>;

export interface MultiplierResult {
  multiplier: number;
  /** Screen citation, e.g. "PEMB ×0.90" — doctrine: report the multiplier beside the RCT citation. */
  label: string;
  /** True when the type was not confirmed (unknown / null / mixed) and the strictest applicable multiplier was used. */
  assumed: boolean;
  /** PEMB above 50,000 SF: the size tilt is undefined there. */
  outsideBand: boolean;
}

const fmt = (m: number): string => `×${m.toFixed(2)}`;

/** PEMB size tilt. Unknown SF ⇒ the smallest band, the strictest value (never a looser denominator for a missing SF). */
export function pembMultiplier(buildingSf: number | null, tilt: PembSizeTilt): { multiplier: number; outsideBand: boolean } {
  if (buildingSf === null || !Number.isFinite(buildingSf) || buildingSf < 20_000) return { multiplier: tilt.under20k, outsideBand: false };
  if (buildingSf < 40_000) return { multiplier: tilt.under40k, outsideBand: false };
  if (buildingSf <= 50_000) return { multiplier: tilt.upTo50k, outsideBand: false };
  return { multiplier: tilt.above50k, outsideBand: true };
}

/**
 * The construction-type multiplier for a building.
 *
 * Unknown (null, 'unknown') ⇒ the strictest applicable multiplier: the PEMB value for the subject's SF, capped at
 * `unknownCap` (0.88 under ~20,000 SF, 0.90 otherwise), tagged [DATA-GAP: construction type]. An unchecked building
 * must never price better than a checked metal one.
 *
 * 'mixed' is a mixed façade, which doctrine weights by façade share. The engine carries no façade share, so it takes
 * the same strict value as unknown and says so; enter the dominant or façade-weighted type to lift it.
 *
 * `buildingSf` is the single building's SF (doctrine: the lower of the OM and county SF).
 */
export function constructionMultiplier(
  type: RctConstructionType | null | undefined,
  buildingSf: number | null,
  s: ConstructionSchedule,
): MultiplierResult {
  switch (type) {
    case 'tilt-precast': return { multiplier: s['tilt-precast'], label: `Tilt-up/precast ${fmt(s['tilt-precast'])}`, assumed: false, outsideBand: false };
    case 'cmu': return { multiplier: s.cmu, label: `CMU ${fmt(s.cmu)}`, assumed: false, outsideBand: false };
    case 'brick': return { multiplier: s.brick, label: `Brick ${fmt(s.brick)}`, assumed: false, outsideBand: false };
    case 'hybrid': return { multiplier: s.hybrid, label: `Hybrid ${fmt(s.hybrid)}`, assumed: false, outsideBand: false };
    case 'pemb': {
      const p = pembMultiplier(buildingSf, s.pemb);
      return { multiplier: p.multiplier, label: `PEMB ${fmt(p.multiplier)}${p.outsideBand ? ' [EST: outside band]' : ''}`, assumed: false, outsideBand: p.outsideBand };
    }
    default: {
      const m = Math.min(pembMultiplier(buildingSf, s.pemb).multiplier, s.unknownCap);
      const why = type === 'mixed' ? 'mixed façade, no façade weighting' : 'DATA-GAP: construction type';
      return { multiplier: m, label: `PEMB ${fmt(m)} [${why}]`, assumed: true, outsideBand: false };
    }
  }
}

/**
 * The SF the PEMB size tilt is read at — ONE rule for the engine and the drawer (refute wf_3b4097ae-24d): the largest
 * building's SF, clamped to the total when both are known (a largest building cannot exceed the deal), and null (the
 * strictest band) when it is unknown. Never the total on its own: a total is not a building.
 */
export function tiltSfFor(maxBuildingSf: number | null | undefined, totalSf: number | null | undefined): number | null {
  if (maxBuildingSf === null || maxBuildingSf === undefined || !Number.isFinite(maxBuildingSf)) return null;
  return totalSf !== null && totalSf !== undefined && Number.isFinite(totalSf) && totalSf > 0 ? Math.min(maxBuildingSf, totalSf) : maxBuildingSf;
}

export interface AdderResult {
  /** Total $/SF added to the POINT (duplicates counted once). */
  psf: number;
  ids: RctAdderId[];
  /** Both site-work adders on one deal: doctrine forbids stacking them for the SAME paving scope. Disclosed, not refused
   *  (they may be different scopes). */
  siteWorkStacked: boolean;
}

export function adderTotal(ids: readonly RctAdderId[] | null | undefined, schedule: AdderSchedule): AdderResult {
  // Summed in schedule order, so the total is a function of the SET, never of the input sequence (exact for any values).
  const chosen = new Set(ids ?? []);
  const unique = RCT_ADDER_IDS.filter((id) => chosen.has(id));
  const psf = unique.reduce((sum, id) => sum + schedule[id], 0);
  return { psf, ids: unique, siteWorkStacked: unique.includes('excess-site-work') && unique.includes('paving-lighting') };
}

export interface RctBand { low: number; point: number; high: number }

/**
 * THE basis-floor predicate, shared by the engine and the drawer so they can never reach opposite verdicts on the same
 * numbers (refute wf_fa550461-ced: the algebraically equal `allIn/SF <= LOW × (1 − floor)` and `1 − allIn/(SF × LOW) >=
 * floor` disagree at the boundary in floating point). discount = 1 − allIn ÷ (SF × adjusted LOW); both sides of the
 * comparison rounded to 1e-8, the engine's existing floor-comparison precision (atFloorPrecision, IRR / YoC floors).
 */
export function basisDiscount(allInBasis: number, sf: number, adjustedLowPsf: number): number {
  return 1 - allInBasis / (sf * adjustedLowPsf);
}
export function basisClearsFloor(discount: number, floor: number): boolean {
  return Math.round(discount * 1e8) / 1e8 >= Math.round(floor * 1e8) / 1e8;
}

/** The construction-type-adjusted band (see the module header for the LOW/HIGH anchoring). */
export function adjustBand(row: RctBand, multiplier: number, adderPsf: number): RctBand {
  return {
    low: row.low * multiplier + 0.9 * adderPsf,
    point: row.point * multiplier + adderPsf,
    high: row.high * multiplier + 1.1 * adderPsf,
  };
}
