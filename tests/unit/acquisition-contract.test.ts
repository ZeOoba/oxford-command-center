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
  readFileSync(resolve(process.cwd(), 'fixtures/synthetic/config/replacement-cost.v3.json'), 'utf8'),
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

  // The ratified RCT is local-only (docs/ops/rct-runtime-config.md); these tests run on the committed synthetic stand-in,
  // whose figures are invented. What used to be the value pins here (every market row, the fallback, the construction
  // schedule) is now the keyed-HMAC pin in server/warehouse/rct-pin.ts, which every production load checks; the local
  // ratified table is checked against it in tests/unit/rct-runtime-config.test.ts when present.
  it('parses the per-market Replacement-Cost Table shape (synthetic stand-in)', () => {
    const rct = ReplacementCostTable.parse(rctJson);
    expect(rct.rctVersion).toBe(RCT_VERSION);
    expect(rct.ratification).toBe('ratified');
    // Per-market, not flat: the old flat v1 table had no market variation at all.
    expect(Object.keys(rct.markets).length).toBeGreaterThanOrEqual(10);
    expect(new Set(Object.values(rct.markets).map((m) => m.low)).size).toBeGreaterThan(1);
  });

  it('the synthetic stand-in carries a full construction schedule: tilt-up is the ×1.00 baseline, PEMB tilts up with SF, the unknown cap sits inside the PEMB range', () => {
    const rct = ReplacementCostTable.parse(rctJson);
    const m = rct.constructionMultipliers;
    expect(m['tilt-precast']).toBe(1);
    expect(m.pemb.under20k).toBeLessThan(m.pemb.under40k);
    expect(m.pemb.under40k).toBeLessThan(m.pemb.upTo50k);
    expect(m.pemb.above50k).toBeGreaterThanOrEqual(m.pemb.upTo50k);
    expect(m.unknownCap).toBeGreaterThanOrEqual(m.pemb.under20k);
    expect(m.unknownCap).toBeLessThan(m.pemb.upTo50k);
    expect(Object.keys(rct.adders).sort()).toEqual(['climate-controlled', 'cranes', 'esfr', 'excess-site-work', 'heavy-office', 'paving-lighting']);
  });

  it('refuses an RCT config without the construction schedule (fail closed, never a silent ×1.00)', () => {
    const { constructionMultipliers: _m, ...noSchedule } = rctJson as Record<string, unknown>;
    expect(ReplacementCostTable.safeParse(noSchedule).success).toBe(false);
    const { adders: _a, ...noAdders } = rctJson as Record<string, unknown>;
    expect(ReplacementCostTable.safeParse(noAdders).success).toBe(false);
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
      dockCount: 4, driveInCount: 4, multiStory: false, constructionType: 'tilt-precast',
      yearBuilt: 1998, sfhaOnPad: false, allInBasis: 4_800_000, replacementCostTotal: 6_150_000,
      stabilizedYoc: 0.095, leveredIrr: 0.16, unleveredIrr10yr: 0.12, underwriteHorizonYrs: 5, clusterTier: 'established',
      isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.8,
    });
    expect(input.dockCount).toBe(4);
    expect(input.isPortfolio).toBeNull(); // tri-state since refute wf_6e927240-7cc: unset = unknown, not single asset
    expect(input.ddKnown).toEqual({});
  });
});

// computeInputsVersion folds only the rctVersion STRING, not the table content, so editing a row without bumping
// RCT_VERSION would leave every cached score keyed to the old denominator (OI-354). That content -> version pin used to
// be a plain SHA-256 here; in a public repo a plain hash confirms the values already in git history, so it is now the
// keyed HMAC RATIFIED_RCT_HMAC (server/warehouse/rct-pin.ts), checked on every production load: a content change without
// a new pin (and, by the re-ratification procedure, a new RCT_VERSION) fails closed. See rct-runtime-config.test.ts.
