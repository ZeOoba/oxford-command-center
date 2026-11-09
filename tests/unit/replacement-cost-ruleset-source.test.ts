// tests/unit/replacement-cost-ruleset-source.test.ts
//
// Audit 2026-11-08 client-basis-floor-engine-hardcodes-ruleset (Wave 1, batch A-1). The deal-drawer basis-floor engine
// (src/brain/replacement-cost.ts) hardcoded the vintage ramp (65% at <=1995, 60% at >=2005) and a hand-copied RCT v03
// table, so a ratified ruleset or RCT change would move the server engine's verdict and leave the drawer badge on the old
// numbers. It now reads both from the ratified config files. MECHANISM ONLY: every value must stay identical, which the
// frozen snapshot below (the literals the module carried before this change) proves.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { basisVintageFloor, parseRuleset } from '../../server/warehouse/acquisition';
import {
  RCT_V03, floorsFromRuleset, rctFromConfig, replacementCostAnalysis, replacementCostAnalysisWith, vintageFloor, vintageFloorFor,
} from '../../src/brain/replacement-cost';

const ruleset = parseRuleset(JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')));
const rctJson = JSON.parse(readFileSync(resolve(process.cwd(), 'config/replacement-cost.v3.json'), 'utf8')) as Record<string, unknown>;

// The hardcoded values the client module carried BEFORE this change (2026-11-08). Frozen here on purpose: if a test below
// fails, the change moved a value and must not ship as mechanism-only.
const PRIOR_RCT = {
  'Columbus OH': { low: 229.65, point: 255.16, high: 280.68, cwHardPsf: 130.51, proxy: false },
  'Cincinnati OH': { low: 251.46, point: 279.4, high: 307.34, cwHardPsf: 143.15, proxy: false },
  'Kansas City MO': { low: 227.9, point: 253.22, high: 278.54, cwHardPsf: 129.94, proxy: false },
  'Indianapolis IN': { low: 253.83, point: 282.03, high: 310.24, cwHardPsf: 143.46, proxy: false },
  'Mid-Atlantic': { low: 232.97, point: 258.85, high: 284.74, cwHardPsf: 133.7, proxy: false },
  'Madison WI': { low: 229.08, point: 254.53, high: 279.98, cwHardPsf: 130.05, proxy: true },
  'Grand Rapids MI': { low: 253.11, point: 281.23, high: 309.36, cwHardPsf: 143.64, proxy: true },
  'Richmond VA': { low: 232.97, point: 258.85, high: 284.74, cwHardPsf: 133.7, proxy: true },
  'Des Moines IA': { low: 231.66, point: 257.4, high: 283.14, cwHardPsf: 131.46, proxy: true },
  'Louisville KY': { low: 237.07, point: 263.41, high: 289.75, cwHardPsf: 135.28, proxy: false },
} as const;
const priorVintageFloor = (y: number | null | undefined): number => {
  const c = Math.min(2005, Math.max(1995, y ?? 1995));
  return 0.65 - (c - 1995) * 0.005;
};

describe('client basis-floor engine reads the ratified config (values unchanged)', () => {
  it('RCT_V03 is exactly the prior table (same markets, bit-identical values)', () => {
    expect(RCT_V03).toEqual(PRIOR_RCT);
  });

  it('vintageFloor is bit-identical to the prior hardcoded ramp for every year 1800..2200 and for unknown vintage', () => {
    for (let y = 1800; y <= 2200; y++) expect(vintageFloor(y), String(y)).toBe(priorVintageFloor(y));
    expect(vintageFloor(null)).toBe(priorVintageFloor(null));
    expect(vintageFloor(undefined)).toBe(priorVintageFloor(undefined));
  });

  it('vintageFloor equals the SERVER engine (basisVintageFloor over the ratified ruleset) across the full ramp', () => {
    for (let y = 1800; y <= 2200; y++) expect(vintageFloor(y), String(y)).toBe(basisVintageFloor(y, ruleset));
    expect(vintageFloor(null)).toBe(basisVintageFloor(null, ruleset));
  });

  it('the floor follows the ruleset, not a literal: a synthetic ruleset moves it', () => {
    const floors = { basisDiscountMinPreMillennium: 0.7, basisDiscountMinPostMillennium: 0.5, basisVintageRampStartYear: 2000, basisVintageCutoffYear: 2010 };
    expect(vintageFloorFor(1990, floors)).toBe(0.7);
    expect(vintageFloorFor(2005, floors)).toBeCloseTo(0.6, 12);
    expect(vintageFloorFor(2020, floors)).toBe(0.5);
    expect(vintageFloorFor(null, floors)).toBe(0.7);
    // degenerate config behaves as a cliff, exactly like the server
    const cliff = { ...floors, basisVintageCutoffYear: 2000 };
    expect(vintageFloorFor(1999, cliff)).toBe(0.7);
    expect(vintageFloorFor(2000, cliff)).toBe(0.5);
  });

  it('the RCT follows the config: an unratified or unsigned table prices nothing (as the server engine refuses it)', () => {
    expect(rctFromConfig(rctJson)).toEqual(PRIOR_RCT);
    expect(rctFromConfig({ ...rctJson, ratification: 'proposed' })).toEqual({});
    expect(rctFromConfig({ ...rctJson, ratifiedBy: null })).toEqual({});
    expect(rctFromConfig({ ...rctJson, ratifiedDate: null })).toEqual({});
    // a key outside the Market enum, or a malformed row, is dropped rather than priced
    const markets = rctJson.markets as Record<string, unknown>;
    const odd = rctFromConfig({ ...rctJson, markets: { ...markets, Atlantis: markets['Columbus OH'], 'Toledo OH': { low: 'x' } } });
    expect(odd).toEqual(PRIOR_RCT);
  });

  it('replacementCostAnalysis output is unchanged across the vintage ramp and the uncovered-market branch', () => {
    for (const market of [...Object.keys(PRIOR_RCT), 'Toledo OH', null] as const) {
      for (const yearBuilt of [null, 1960, 1995, 1998, 2000, 2003, 2005, 2010]) {
        const r = replacementCostAnalysis({ sf: 40_000, estPrice: 3_500_000, market: market as never, yearBuilt });
        const entry = market ? PRIOR_RCT[market as keyof typeof PRIOR_RCT] : undefined;
        expect(r!.vintageFloorPct).toBe(priorVintageFloor(yearBuilt));
        expect(r!.marketCovered).toBe(entry !== undefined);
        if (entry) {
          const floorPsf = entry.low * (1 - priorVintageFloor(yearBuilt));
          expect(r!.floorPsf).toBe(floorPsf);
          expect(r!.clearsFloor).toBe((3_500_000 * 1.02) / 40_000 <= floorPsf);
        } else {
          expect(r!.verdict).toBeNull();
        }
      }
    }
  });
});

// Refute wf_6e927240-7cc (low): the client vintage floor read the ruleset without checking its ratification. It now
// mirrors rctFromConfig and the server's assertProductionRuleset: an unratified or unsigned ruleset scores nothing.
describe('client vintage floor fails closed on an unratified ruleset', () => {
  const rulesetJson = JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')) as Record<string, unknown>;

  it('the ratified, signed ruleset yields its floors (values unchanged)', () => {
    expect(floorsFromRuleset(rulesetJson)).toEqual({
      basisDiscountMinPreMillennium: ruleset.floors.basisDiscountMinPreMillennium,
      basisDiscountMinPostMillennium: ruleset.floors.basisDiscountMinPostMillennium,
      basisVintageRampStartYear: ruleset.floors.basisVintageRampStartYear,
      basisVintageCutoffYear: ruleset.floors.basisVintageCutoffYear,
    });
  });

  it('proposed, unsigned or malformed floors yield null', () => {
    expect(floorsFromRuleset({ ...rulesetJson, ratification: 'proposed' })).toBeNull();
    expect(floorsFromRuleset({ ...rulesetJson, ratifiedBy: null })).toBeNull();
    expect(floorsFromRuleset({ ...rulesetJson, ratifiedDate: '' })).toBeNull();
    expect(floorsFromRuleset({ ...rulesetJson, floors: { ...(rulesetJson.floors as object), basisVintageCutoffYear: '2005' } })).toBeNull();
    expect(floorsFromRuleset(null)).toBeNull();
  });

  it('with no ratified floors the analysis prices the RCT but scores no basis verdict', () => {
    const r = replacementCostAnalysisWith({ sf: 40_000, estPrice: 1_000_000, market: 'Columbus OH', yearBuilt: 2000 }, null)!;
    expect(r.marketCovered).toBe(true);
    expect(r.low).toBe(40_000 * PRIOR_RCT['Columbus OH'].low);
    expect(r.vintageFloorPct).toBeNull();
    expect(r.floorPsf).toBeNull();
    expect(r.clearsFloor).toBeNull();
    expect(r.verdict).toBeNull();
    expect(r.basis).toMatch(/not ratified/);
  });
});
