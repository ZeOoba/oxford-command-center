// tests/unit/acquisition-contract.test.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcquisitionInput,
  AcquisitionRuleset,
  RCT_VERSION,
  ReplacementCostTable,
  RULESET_VERSION,
} from '@contracts/acquisition';

const ratifiedJson = JSON.parse(
  readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8'),
);
const rctJson = JSON.parse(
  readFileSync(resolve(process.cwd(), 'config/replacement-cost.v3.json'), 'utf8'),
);

describe('acquisition ruleset contract (ratified v1)', () => {
  it('parses the committed RATIFIED ruleset against the schema', () => {
    const r = AcquisitionRuleset.parse(ratifiedJson);
    expect(r.rulesetVersion).toBe(RULESET_VERSION);
    expect(r.ratification).toBe('ratified');
    expect(r.ratifiedBy).toBe('Gabriel Goldberg');
  });

  it('base scorecard points total exactly 100', () => {
    const r = AcquisitionRuleset.parse(ratifiedJson);
    expect(r.scorecard.reduce((s, c) => s + c.points, 0)).toBe(100);
  });

  it('clear-height bands are present and ratified (14ft <20k / 16ft >20k)', () => {
    const r = AcquisitionRuleset.parse(ratifiedJson);
    expect(r.scoring.cat3.clearHeightBands).not.toBeNull();
    expect(r.scoring.cat3.clearHeightBands).toEqual([
      { maxSf: 20000, idealClearFt: 14 },
      { maxSf: 50000, idealClearFt: 16 },
    ]);
  });

  it('encodes the ratified Q1 answers (PEMB 2/4, satellite 6/12, loading 1 dock + 1 drive-in / 10k SF)', () => {
    const r = AcquisitionRuleset.parse(ratifiedJson);
    expect(r.scoring.cat3.constructionPoints.pemb).toBe(2);
    expect(r.scoring.cat3.constructionPoints.blockTiltBrick).toBe(4);
    expect(r.scoring.cat4.tierPoints.satellite).toBe(6);
    expect(r.scoring.cat4.tierPoints.ownedSubmarket).toBe(12);
    expect(r.scoring.cat3.loadingDoorsPer10kSf).toEqual({ docks: 1, driveIns: 1 });
  });

  it('keeps governors (DSCR/LTV) OUT of the ruleset (Q4) and the Q3 guard ON', () => {
    const r = AcquisitionRuleset.parse(ratifiedJson);
    expect(JSON.stringify(r)).not.toMatch(/dscr|ltv/i);
    expect(r.guards.marketEstimatedCannotCarryT1).toBe(true);
  });

  it('rejects a ruleset whose base points do not total 100', () => {
    const broken = structuredClone(ratifiedJson);
    broken.scorecard[0].points = 24;
    expect(() => AcquisitionRuleset.parse(broken)).toThrow(/total 100/);
  });

  it('rejects duplicate-maxSf clear-height bands (deterministic banding)', () => {
    const broken = structuredClone(ratifiedJson);
    broken.scoring.cat3.clearHeightBands = [{ maxSf: 20000, idealClearFt: 14 }, { maxSf: 20000, idealClearFt: 16 }];
    expect(() => AcquisitionRuleset.parse(broken)).toThrow(/unique/);
  });

  it('parses the ratified per-market Replacement-Cost Table (RCT v03)', () => {
    const rct = ReplacementCostTable.parse(rctJson);
    expect(rct.rctVersion).toBe(RCT_VERSION);
    expect(rct.ratification).toBe('ratified');
    // Per-market, not flat. The old flat $125/$137.50/$150 had no market variation at all and sat
    // at roughly HALF true all-in shallow-bay replacement cost — which made ORA too STRICT.
    expect(Object.keys(rct.markets).length).toBeGreaterThanOrEqual(9);
    expect(rct.markets['Columbus OH']!.low).toBeCloseTo(229.65, 2);
    expect(rct.markets['Indianapolis IN']!.low).toBeCloseTo(253.83, 2);
  });

  it('RCT coherence: every all-in POINT exceeds its C&W hard cost — the test RCT v02 failed', () => {
    const rct = ReplacementCostTable.parse(rctJson);
    for (const [name, m] of Object.entries(rct.markets)) {
      // All-in CONTAINS hard cost, so it cannot be less. RCT v02 broke this in 5 of 9 markets.
      expect(m.point, `${name}`).toBeGreaterThan(m.cwHardPsf);
      expect(m.point / m.cwHardPsf, `${name}`).toBeGreaterThan(1.5);
      expect(m.low).toBeCloseTo(m.point * 0.9, 1); // ±10% band
    }
  });

  it('the psf fallback is the CHEAPEST market — an unknown market gets the STRICTEST floor', () => {
    const rct = ReplacementCostTable.parse(rctJson);
    const cheapestLow = Math.min(...Object.values(rct.markets).map((m) => m.low));
    expect(rct.psf.low).toBeCloseTo(cheapestLow, 2);
    for (const m of Object.values(rct.markets)) expect(rct.psf.low).toBeLessThanOrEqual(m.low + 1e-9);
  });

  it('accepts a representative AcquisitionInput incl. dock/drive-in counts', () => {
    const input = AcquisitionInput.parse({
      dealId: 'test-deal', price: 4_800_000, maxBuildingSf: 42_000, totalSf: 42_000,
      productType: 'shallow-bay-multi', clearHeightFt: 24, hasDriveIn: true, hasDock: true,
      dockCount: 4, driveInCount: 4, multiStory: false, constructionType: 'block-tilt-brick',
      yearBuilt: 1998, sfhaOnPad: false, allInBasis: 4_800_000, replacementCostTotal: 6_150_000,
      stabilizedYoc: 0.095, leveredIrr: 0.16, underwriteHorizonYrs: 5, clusterTier: 'established',
      isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.8,
    });
    expect(input.dockCount).toBe(4);
    expect(input.isPortfolio).toBe(false);
    expect(input.ddKnown).toEqual({});
  });
});
