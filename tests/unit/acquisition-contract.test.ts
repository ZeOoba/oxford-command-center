// tests/unit/acquisition-contract.test.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AcquisitionInput,
  AcquisitionRuleset,
  RULESET_VERSION,
} from '@contracts/acquisition';

const proposedJson = JSON.parse(
  readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.proposed.json'), 'utf8'),
);

describe('acquisition ruleset contract', () => {
  it('parses the committed PROPOSED ruleset against the schema', () => {
    const r = AcquisitionRuleset.parse(proposedJson);
    expect(r.rulesetVersion).toBe(RULESET_VERSION);
    expect(r.ratification).toBe('proposed'); // never ratified until Gabriel signs
  });

  it('base scorecard points total exactly 100', () => {
    const r = AcquisitionRuleset.parse(proposedJson);
    const sum = r.scorecard.reduce((s, c) => s + c.points, 0);
    expect(sum).toBe(100);
  });

  it('clear-height bands are the PENDING sentinel (null) — not fabricated cutoffs', () => {
    const r = AcquisitionRuleset.parse(proposedJson);
    expect(r.scoring.cat3.clearHeightBands).toBeNull();
  });

  it('encodes the confirmed Q1 answers (PEMB = 2/4, satellite = 6/12)', () => {
    const r = AcquisitionRuleset.parse(proposedJson);
    expect(r.scoring.cat3.constructionPoints.pemb).toBe(2);
    expect(r.scoring.cat3.constructionPoints.blockTiltBrick).toBe(4);
    expect(r.scoring.cat4.tierPoints.satellite).toBe(6);
    expect(r.scoring.cat4.tierPoints.ownedSubmarket).toBe(12);
  });

  it('keeps governors (DSCR/LTV) OUT of the ruleset (Q4) and Q3 guard ON', () => {
    const r = AcquisitionRuleset.parse(proposedJson);
    expect(JSON.stringify(r)).not.toMatch(/dscr|ltv/i);
    expect(r.guards.marketEstimatedCannotCarryT1).toBe(true);
  });

  it('rejects a ruleset whose base points do not total 100 (refine fires)', () => {
    const broken = structuredClone(proposedJson);
    broken.scorecard[0].points = 24; // 99 total
    expect(() => AcquisitionRuleset.parse(broken)).toThrow(/total 100/);
  });

  it('accepts a representative AcquisitionInput', () => {
    const input = AcquisitionInput.parse({
      dealId: 'test-deal',
      price: 4_800_000,
      maxBuildingSf: 42_000,
      totalSf: 60_000,
      productType: 'shallow-bay-multi',
      officePct: 0.1,
      clearHeightFt: 24,
      hasDriveIn: true,
      hasDock: true,
      multiStory: false,
      constructionType: 'block-tilt-brick',
      yearBuilt: 1998,
      sfhaOnPad: false,
      allInBasis: 4_800_000,
      replacementCostTotal: 6_150_000,
      stabilizedYoc: 0.095,
      leveredIrr: 0.16,
      underwriteHorizonYrs: 5,
      clusterTier: 'established',
      isVacant: false,
      inPlaceRentPsf: 4.5,
      marketRentPsf: 6.0,
      waltYears: 1.8,
    });
    expect(input.dealId).toBe('test-deal');
    expect(input.isPortfolio).toBe(false); // default applied
    expect(input.ddKnown).toEqual({}); // default applied
  });
});
