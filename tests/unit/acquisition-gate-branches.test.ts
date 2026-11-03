// @vitest-environment node
//
// tests/unit/acquisition-gate-branches.test.ts
//
// Characterization tests for two acquisition-engine branches the 2026-11-03 cc-audit-army run found
// untested (findings acq-portfolio-price-gate-untested, basis-vintage-degenerate-ramp-untested):
//   1. the size-price gate's isPortfolio branch (portfolioPriceMax vs singleAssetPriceMax) and the
//      singleAssetPriceMin floor that applies to portfolios too;
//   2. basisVintageFloor's degenerate-ramp branch (cutoff year <= ramp start ⇒ behaves as a cliff).
//
// These PIN current behaviour — no production change. Every bound is read from the live ratified
// ruleset object (never restated as a literal), so the governance literal scan is not tripped.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { basisVintageFloor, parseRuleset, scoreAcquisition } from '../../server/warehouse/acquisition';
import { AcquisitionInput } from '@contracts/acquisition';
import type { AcquisitionRuleset } from '@contracts/acquisition';

const ratifiedJson = JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8'));
const RULESET: AcquisitionRuleset = parseRuleset(ratifiedJson);
const SP = RULESET.gates.sizePrice;
const NOW = '2026-11-03T00:00:00Z';

/** Size-price fixture: SF pinned BELOW the per-building cap so the price bound is the only variable. */
function dealAt(price: number, isPortfolio: boolean): AcquisitionInput {
  return AcquisitionInput.parse({
    dealId: `gate-${isPortfolio ? 'pf' : 'sa'}-${price}`,
    price,
    isPortfolio,
    maxBuildingSf: SP.maxSfPerBuilding - 1,
  });
}

function sizePriceGate(price: number, isPortfolio: boolean) {
  const s = scoreAcquisition(dealAt(price, isPortfolio), RULESET, { now: NOW });
  const g = s.gates.find((x) => x.id === 'size-price');
  if (!g) throw new Error('size-price gate missing from score');
  return g;
}

describe('size-price gate — single asset (isPortfolio=false)', () => {
  it('fails one dollar below singleAssetPriceMin and names the single-asset bounds', () => {
    const g = sizePriceGate(SP.singleAssetPriceMin - 1, false);
    expect(g.passed).toBe(false);
    expect(g.detail).toContain(`[${SP.singleAssetPriceMin}, ${SP.singleAssetPriceMax}]`);
  });
  it('passes at singleAssetPriceMin and at singleAssetPriceMax (bounds inclusive)', () => {
    expect(sizePriceGate(SP.singleAssetPriceMin, false).passed).toBe(true);
    expect(sizePriceGate(SP.singleAssetPriceMax, false).passed).toBe(true);
  });
  it('fails one dollar above singleAssetPriceMax', () => {
    const g = sizePriceGate(SP.singleAssetPriceMax + 1, false);
    expect(g.passed).toBe(false);
    expect(g.detail).toContain(`[${SP.singleAssetPriceMin}, ${SP.singleAssetPriceMax}]`);
  });
});

describe('size-price gate — portfolio (isPortfolio=true)', () => {
  it('fixture sanity: the portfolio ceiling is above the single-asset ceiling', () => {
    expect(SP.portfolioPriceMax).toBeGreaterThan(SP.singleAssetPriceMax);
  });
  it('passes above singleAssetPriceMax when within portfolioPriceMax', () => {
    expect(sizePriceGate(SP.singleAssetPriceMax + 1, true).passed).toBe(true);
  });
  it('passes at portfolioPriceMax (inclusive)', () => {
    expect(sizePriceGate(SP.portfolioPriceMax, true).passed).toBe(true);
  });
  it('fails one dollar above portfolioPriceMax and names the portfolio ceiling', () => {
    const g = sizePriceGate(SP.portfolioPriceMax + 1, true);
    expect(g.passed).toBe(false);
    expect(g.detail).toContain(`[${SP.singleAssetPriceMin}, ${SP.portfolioPriceMax}]`);
  });
  it('still applies the singleAssetPriceMin floor to a portfolio', () => {
    const g = sizePriceGate(SP.singleAssetPriceMin - 1, true);
    expect(g.passed).toBe(false);
    expect(g.detail).toContain(`[${SP.singleAssetPriceMin}, ${SP.portfolioPriceMax}]`);
  });
});

describe('basisVintageFloor — degenerate ramp (cutoff <= start ⇒ cliff)', () => {
  const { basisDiscountMinPreMillennium: strict, basisDiscountMinPostMillennium: loose } = RULESET.floors;

  function withRamp(start: number, end: number): AcquisitionRuleset {
    const j = structuredClone(ratifiedJson);
    j.floors.basisVintageRampStartYear = start;
    j.floors.basisVintageCutoffYear = end;
    return parseRuleset(j);
  }

  it('fixture sanity: strict and loose floors differ', () => {
    expect(strict).not.toBeCloseTo(loose, 6);
  });

  for (const [label, start, end] of [['end === start', 2000, 2000], ['end < start', 2005, 1995]] as const) {
    describe(label, () => {
      const r = withRamp(start, end);
      it('yearBuilt at the cutoff gets the loose floor', () => {
        expect(basisVintageFloor(end, r)).toBeCloseTo(loose, 6);
      });
      it('yearBuilt above the cutoff gets the loose floor', () => {
        expect(basisVintageFloor(end + 10, r)).toBeCloseTo(loose, 6);
      });
      it('yearBuilt one year below the cutoff gets the strict floor (no interpolation)', () => {
        expect(basisVintageFloor(end - 1, r)).toBeCloseTo(strict, 6);
      });
      it('unknown vintage still gets the strictest floor', () => {
        expect(basisVintageFloor(null, r)).toBeCloseTo(strict, 6);
      });
    });
  }
});
