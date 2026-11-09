// @vitest-environment node
//
// tests/unit/acquisition-portfolio-unknown.test.ts
//
// Refute wf_6e927240-7cc (MEDIUM) on Wave-1 batch A-1. `isPortfolio` defaulted to false, so an UNKNOWN portfolio status
// was scored as a confirmed single asset: a deal with an unknown building count priced between the single-asset and
// portfolio caps was KILLED on the single-asset cap. isPortfolio is now tri-state (null unknown, false single asset,
// true portfolio; architect-approved 2026-11-09). Unknown never KILLs: between the two caps the size-price gate passes
// unconfirmed and caps the verdict at T2. Above the portfolio cap (or below the minimum) it still KILLs. Every bound is
// read from the ratified ruleset; no value changes.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { computeInputsVersion, parseRuleset, scoreAcquisition } from '../../server/warehouse/acquisition';
import { AcquisitionInput, ReplacementCostTable } from '@contracts/acquisition';
import { buildInput, dealToForm, inputToForm } from '../../src/modules/acquisitions/acquisition-score';

const RULESET = parseRuleset(JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')));
const RCT = ReplacementCostTable.parse(JSON.parse(readFileSync(resolve(process.cwd(), 'config/replacement-cost.v3.json'), 'utf8')));
const SP = RULESET.gates.sizePrice;
const NOW = '2026-11-09T00:00:00Z';

// A fully-known deal (every other Stage-0 input confirmed) so only portfolio status varies.
const STRONG: Record<string, unknown> = {
  dealId: 'zephyr', totalSf: 40_000, maxBuildingSf: 40_000, productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6, multiStory: false, truckCourtFt: 120,
  constructionType: 'block-tilt-brick', yearBuilt: 2005, sfhaOnPad: false,
  groundLeased: false, envRemediationPctOfPrice: 0, use: { automotive: false, childRelated: false, childSafetyReviewed: false },
  stabilizedYoc: 0.12, leveredIrr: 0.18, underwriteHorizonYrs: 5, clusterTier: 'owned-submarket',
  sellerMotivationScore: 0.8, isVacant: false, inPlaceRentPsf: 4, marketRentPsf: 6, waltYears: 1.5, valueAddScore: 0.6,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
};
// allInBasis is pinned well inside the Basis floor so the size-price gate is the only thing under test.
const BASIS = 3_000_000;
const score = (over: Record<string, unknown>) =>
  scoreAcquisition(AcquisitionInput.parse({ ...STRONG, allInBasis: BASIS, ...over }), RULESET, { now: NOW, rct: RCT });
const gate = (s: ReturnType<typeof score>) => s.gates.find((g) => g.id === 'size-price')!;

describe('contract: isPortfolio is tri-state', () => {
  it('defaults to null (unknown), keeps an explicit false and true', () => {
    expect(AcquisitionInput.parse({ dealId: 'd' }).isPortfolio).toBeNull();
    expect(AcquisitionInput.parse({ dealId: 'd', isPortfolio: false }).isPortfolio).toBe(false);
    expect(AcquisitionInput.parse({ dealId: 'd', isPortfolio: true }).isPortfolio).toBe(true);
  });
});

describe('size-price gate with an unknown portfolio status', () => {
  const between = SP.singleAssetPriceMax + 2_000_000;

  it('between the caps: not KILLED, passes unconfirmed, flagged, capped at T2', () => {
    expect(between).toBeLessThanOrEqual(SP.portfolioPriceMax);
    const s = score({ isPortfolio: null, price: between });
    expect(s.verdict).not.toBe('KILLED');
    expect(gate(s).passed).toBe(true);
    expect(gate(s).detail).toMatch(/portfolio status unknown/);
    expect(s.dataQuality.some((d) => d.field === 'isPortfolio' && /portfolio status unknown — price cap not confirmable/.test(d.issue))).toBe(true);
    expect(s.cappedAtT2).toBe(true);
    expect(s.reasons.join(' ')).toMatch(/Stage-0 gate input is unconfirmed/);
  });

  it('the same price with a CONFIRMED single asset still KILLs; a confirmed portfolio passes determinately', () => {
    expect(score({ isPortfolio: false, price: between }).verdict).toBe('KILLED');
    const pf = score({ isPortfolio: true, price: between });
    expect(gate(pf).passed).toBe(true);
    expect(pf.dataQuality.some((d) => d.field === 'isPortfolio')).toBe(false);
  });

  it('above the portfolio cap, or below the minimum, unknown still KILLs (either answer kills)', () => {
    expect(score({ isPortfolio: null, price: SP.portfolioPriceMax + 1 }).verdict).toBe('KILLED');
    expect(score({ isPortfolio: null, price: SP.singleAssetPriceMin - 1 }).verdict).toBe('KILLED');
  });

  it('within the single-asset cap, unknown is decision-identical to false: no flag, no cap from it', () => {
    const price = SP.singleAssetPriceMax;
    const unknown = score({ isPortfolio: null, price });
    const single = score({ isPortfolio: false, price });
    expect(unknown.dataQuality.some((d) => d.field === 'isPortfolio')).toBe(false);
    expect(unknown.verdict).toBe(single.verdict);
    expect(unknown.cappedAtT2).toBe(single.cappedAtT2);
    expect(unknown.composite).toBe(single.composite);
  });
});

describe('inputs_version: null folds to false wherever the two decide identically (no needless hash churn)', () => {
  const v = (over: Record<string, unknown>) => computeInputsVersion(AcquisitionInput.parse({ dealId: 'd', ...over }), RULESET);

  it('price unknown, within the single-asset cap, below the minimum or above the portfolio cap: null hashes as false', () => {
    for (const price of [null, SP.singleAssetPriceMin, SP.singleAssetPriceMax, SP.singleAssetPriceMin - 1, SP.portfolioPriceMax + 1]) {
      expect(v({ price, isPortfolio: null }), String(price)).toBe(v({ price, isPortfolio: false }));
    }
  });

  it('between the caps the three states hash differently (they decide differently)', () => {
    const price = SP.singleAssetPriceMax + 1;
    const hs = new Set([v({ price, isPortfolio: null }), v({ price, isPortfolio: false }), v({ price, isPortfolio: true })]);
    expect(hs.size).toBe(3);
  });
});

describe('form: unknown building count reaches the engine as unknown, never as a single asset', () => {
  it('dealToForm with buildings null and a $12M price: not KILLED, capped at T2', () => {
    const price = 12_000_000;
    expect(price).toBeGreaterThan(SP.singleAssetPriceMax);
    expect(price).toBeLessThanOrEqual(SP.portfolioPriceMax);
    const form = dealToForm({ sf: 40_000, buildings: null, estPrice: price, irr: null, holdYrs: null, market: null });
    const input = AcquisitionInput.parse({ ...STRONG, ...buildInput(form, 'zephyr'), maxBuildingSf: 40_000, allInBasis: BASIS });
    expect(input.isPortfolio).toBeNull();
    const s = scoreAcquisition(input, RULESET, { now: NOW, rct: RCT });
    expect(s.verdict).not.toBe('KILLED');
    expect(s.cappedAtT2).toBe(true);
  });

  it('a stored unknown reloads blank and round-trips as unknown; stored false/true round-trip', () => {
    for (const isPortfolio of [null, false, true] as const) {
      const input = AcquisitionInput.parse({ dealId: 'd', isPortfolio });
      expect(AcquisitionInput.parse(buildInput(inputToForm(input), 'd')).isPortfolio).toBe(isPortfolio);
    }
  });
});
