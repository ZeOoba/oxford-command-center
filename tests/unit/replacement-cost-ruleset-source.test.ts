// tests/unit/replacement-cost-ruleset-source.test.ts
//
// Audit 2026-11-08 client-basis-floor-engine-hardcodes-ruleset (Wave 1, batch A-1). The deal-drawer basis-floor engine
// (src/brain/replacement-cost.ts) hardcoded the vintage ramp (65% at <=1995, 60% at >=2005) and a hand-copied RCT v03
// table, so a ratified ruleset or RCT change would move the server engine's verdict and leave the drawer badge on the old
// numbers. It now reads both from the ratified config files. MECHANISM ONLY. The vintage ramp is still checked against
// the prior hardcoded literals below. The RCT is local-only (docs/ops/rct-runtime-config.md), so these tests run on
// the synthetic stand-in and prove only that the drawer reads the bundled config verbatim. They cannot detect a moved
// RCT value. That guarantee is the keyed-HMAC pin (server/warehouse/rct-pin.ts). The Brain Server checks it on every
// load; build:mirror (check:rct-pin) checks the file bundled into this drawer and the edge Function, which carry no key at
// runtime; and tests/unit/rct-public-leak.test.ts checks it locally when the real table and key are present.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { basisVintageFloor, parseRuleset } from '../../server/warehouse/acquisition';
import {
  RCT_V03, floorsFromRuleset, rctFromConfig, replacementCostAnalysis, replacementCostAnalysisWith, vintageFloor, vintageFloorFor,
} from '../../src/brain/replacement-cost';

const ruleset = parseRuleset(JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')));
const rctJson = JSON.parse(readFileSync(resolve(process.cwd(), 'fixtures/synthetic/config/replacement-cost.v3.json'), 'utf8')) as Record<string, unknown>;

// The ratified RCT is local-only (docs/ops/rct-runtime-config.md). The bundled import resolves to the committed synthetic
// stand-in under test, so the expected rows are read from that same file: the mechanism under test is that the drawer
// reads the config verbatim (every market, every field, no hand copy). That the LOCAL ratified table is unchanged is
// proven by the keyed-HMAC pin (server/warehouse/rct-pin.ts; local check: tests/unit/rct-public-leak.test.ts). The pin
// mechanism itself is tested with a test key in tests/unit/rct-runtime-config.test.ts.
type Row = { low: number; point: number; high: number; cwHardPsf: number; proxy: boolean };
const PRIOR_RCT = Object.fromEntries(
  Object.entries(rctJson.markets as Record<string, Row>).map(([m, r]) => [m, { low: r.low, point: r.point, high: r.high, cwHardPsf: r.cwHardPsf, proxy: r.proxy }]),
) as Record<string, Row>;
// Every value below is the tilt-up baseline (×1.00, no adders), so the pre-v3.2 arithmetic is unchanged for it. The
// construction multiplier, adders and the true all-in walk are pinned in tests/unit/rct-construction-type.test.ts.
const BASELINE = { constructionType: 'tilt-precast', capex: 0, leaseUpCarry: 0 } as const;
const priorVintageFloor = (y: number | null | undefined): number => {
  const c = Math.min(2005, Math.max(1995, y ?? 1995));
  return 0.65 - (c - 1995) * 0.005;
};

describe('client basis-floor engine reads the bundled config verbatim (RCT values pinned by the keyed HMAC, not here)', () => {
  it('RCT_V03 is exactly the config table (same markets, bit-identical values)', () => {
    expect(Object.keys(PRIOR_RCT).length).toBeGreaterThanOrEqual(10);
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

  it('replacementCostAnalysis follows the config rows and the prior vintage ramp, including the uncovered-market branch', () => {
    for (const market of [...Object.keys(PRIOR_RCT), 'Toledo OH', null] as const) {
      for (const yearBuilt of [null, 1960, 1995, 1998, 2000, 2003, 2005, 2010]) {
        const r = replacementCostAnalysis({ sf: 40_000, estPrice: 3_500_000, market: market as never, yearBuilt, ...BASELINE });
        const entry = market ? PRIOR_RCT[market] : undefined;
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
    const r = replacementCostAnalysisWith({ sf: 40_000, estPrice: 1_000_000, market: 'Columbus OH', yearBuilt: 2000, ...BASELINE }, null)!;
    expect(r.marketCovered).toBe(true);
    expect(r.low).toBe(40_000 * PRIOR_RCT['Columbus OH']!.low);
    expect(r.vintageFloorPct).toBeNull();
    expect(r.floorPsf).toBeNull();
    expect(r.clearsFloor).toBeNull();
    expect(r.verdict).toBeNull();
    expect(r.basis).toMatch(/not ratified/);
  });
});

// Refute wf_3d47a7eb-3e0 (lows): the drawer's "strictest floor (1995) assumed" note hardcoded the ramp start, and the
// client RCT loader skipped the server's rctVersion check.
describe('drawer vintage note and RCT version follow the ratified configs', () => {
  it('the analysis carries the assumed vintage year from the ruleset, and none when the floor is not scored', () => {
    const scored = replacementCostAnalysis({ sf: 40_000, estPrice: 3_000_000, market: 'Columbus OH', yearBuilt: null })!;
    expect(scored.assumedVintageYear).toBe(ruleset.floors.basisVintageRampStartYear);
    const known = replacementCostAnalysis({ sf: 40_000, estPrice: 3_000_000, market: 'Columbus OH', yearBuilt: 2001 })!;
    expect(known.assumedVintageYear).toBeNull();
    const failClosed = replacementCostAnalysisWith({ sf: 40_000, estPrice: 3_000_000, market: 'Columbus OH', yearBuilt: null }, null)!;
    expect(failClosed.assumedVintageYear).toBeNull();
  });

  it('DealDrawer renders the assumed year from the analysis, never a literal year', () => {
    const src = readFileSync(resolve(process.cwd(), 'src/brain/DealDrawer.tsx'), 'utf8');
    expect(src).not.toMatch(/\(1995\)/);
    expect(src).toMatch(/assumedVintageYear/);
  });

  it('an RCT config whose rctVersion is not the version the server accepts prices nothing', () => {
    expect(rctFromConfig({ ...rctJson, rctVersion: 'replacement-cost.v3.1' })).toEqual({}); // the pre-v3.2 version
    expect(rctFromConfig({ ...rctJson, rctVersion: 'replacement-cost.v3.3' })).toEqual({});
    expect(rctFromConfig({ ...rctJson, rctVersion: undefined })).toEqual({});
  });
});
