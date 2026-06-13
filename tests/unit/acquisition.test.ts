// tests/unit/acquisition.test.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AcquisitionInput, type AcquisitionRuleset } from '@contracts/acquisition';
import {
  assertProductionRuleset,
  computeInputsVersion,
  parseRuleset,
  scoreAcquisition,
} from '../../server/warehouse/acquisition';

const proposedJson = JSON.parse(
  readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.proposed.json'), 'utf8'),
);
const proposed = parseRuleset(proposedJson);

/** A RATIFIED, COMPLETE ruleset (clear-height bands filled) to exercise full scoring + PURSUE paths. */
function ratifiedComplete(): AcquisitionRuleset {
  const j = structuredClone(proposedJson);
  j.ratification = 'ratified';
  j.scoring.cat3.clearHeightBands = [
    { maxSf: 20000, idealClearFt: 18 },
    { maxSf: 50000, idealClearFt: 24 },
  ];
  return parseRuleset(j);
}

const NOW = '2026-06-13T00:00:00Z';

/** A strong, fully-known PURSUE-grade deal. Loosely typed; AcquisitionInput.parse validates at runtime. */
const STRONG_BASE: Record<string, unknown> = {
  dealId: 'strong',
  price: 4_800_000, maxBuildingSf: 42_000, totalSf: 60_000,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, multiStory: false, truckCourtFt: 120,
  constructionType: 'block-tilt-brick', yearBuilt: 2005,
  sfhaOnPad: false,
  allInBasis: 4_800_000, replacementCostTotal: 12_000_000, stabilizedYoc: 0.12, leveredIrr: 0.18, underwriteHorizonYrs: 5,
  clusterTier: 'owned-submarket',
  sellerMotivationScore: 0.8,
  isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5,
  valueAddScore: 0.5,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
};
function strongDeal(over: Record<string, unknown> = {}) {
  return AcquisitionInput.parse({ ...STRONG_BASE, ...over });
}

describe('assertProductionRuleset (fail-closed)', () => {
  it('throws on a proposed ruleset', () => {
    expect(() => assertProductionRuleset(proposed)).toThrow(/not 'ratified'/);
  });
  it('throws on a ratified-but-incomplete ruleset (clear-height bands null)', () => {
    const j = structuredClone(proposedJson); j.ratification = 'ratified';
    expect(() => assertProductionRuleset(parseRuleset(j))).toThrow(/clearHeightBands=null/);
  });
  it('passes a ratified + complete ruleset', () => {
    expect(() => assertProductionRuleset(ratifiedComplete())).not.toThrow();
  });
});

describe('determinism', () => {
  it('same (input, ruleset) → identical score (scoredAt injected)', () => {
    const r = ratifiedComplete();
    const a = scoreAcquisition(strongDeal(), r, { now: NOW });
    const b = scoreAcquisition(strongDeal(), r, { now: NOW });
    expect(a).toEqual(b);
  });
  it('inputsVersion is stable and changes when an input changes', () => {
    const r = ratifiedComplete();
    const v1 = computeInputsVersion(strongDeal(), r);
    const v2 = computeInputsVersion(strongDeal(), r);
    const v3 = computeInputsVersion(strongDeal({ price: 4_900_000 }), r);
    expect(v1).toBe(v2);
    expect(v1).not.toBe(v3);
  });
});

describe('STAGE 0 gates KILL', () => {
  const r = ratifiedComplete();
  it('kills on building SF ≥ 50,000', () => {
    const s = scoreAcquisition(strongDeal({ maxBuildingSf: 55_000 }), r, { now: NOW });
    expect(s.verdict).toBe('KILLED');
    expect(s.gates.find((g) => g.id === 'size-price')?.passed).toBe(false);
  });
  it('kills on clear height < 12 ft', () => {
    expect(scoreAcquisition(strongDeal({ clearHeightFt: 10 }), r, { now: NOW }).verdict).toBe('KILLED');
  });
  it('kills on SFHA on the building pad', () => {
    expect(scoreAcquisition(strongDeal({ sfhaOnPad: true }), r, { now: NOW }).verdict).toBe('KILLED');
  });
  it('kills on automotive use and on office-only product', () => {
    expect(scoreAcquisition(strongDeal({ use: { automotive: true, childRelated: false, childSafetyReviewed: false } }), r, { now: NOW }).verdict).toBe('KILLED');
    expect(scoreAcquisition(strongDeal({ productType: 'office-only' }), r, { now: NOW }).verdict).toBe('KILLED');
  });
  it('kills a satellite cluster beyond the 30-min drive', () => {
    expect(scoreAcquisition(strongDeal({ clusterTier: 'satellite', driveMinutesToCluster: 45 }), r, { now: NOW }).verdict).toBe('KILLED');
  });
});

describe('STAGE 1 floors KILL (gates passing)', () => {
  const r = ratifiedComplete();
  it('kills when stabilized YoC is below the 8% floor', () => {
    const s = scoreAcquisition(strongDeal({ stabilizedYoc: 0.06 }), r, { now: NOW });
    expect(s.verdict).toBe('KILLED');
    expect(s.floors.find((f) => f.id === 'yield')?.passed).toBe(false);
  });
});

describe('STAGE 2 scorecard', () => {
  const r = ratifiedComplete();
  it('a strong, fully-known deal is T1 PURSUE with a high composite', () => {
    const s = scoreAcquisition(strongDeal(), r, { now: NOW });
    expect(s.tier).toBe('T1');
    expect(s.verdict).toBe('PURSUE');
    expect(s.composite).toBeGreaterThan(90);
    expect(s.advisoryOnly).toBe(false);
    expect(s.incompleteRuleset).toBe(false);
  });
  it('PEMB construction scores exactly 2 points below block/tilt/brick (Q1)', () => {
    const block = scoreAcquisition(strongDeal({ constructionType: 'block-tilt-brick' }), r, { now: NOW });
    const pemb = scoreAcquisition(strongDeal({ constructionType: 'pemb' }), r, { now: NOW });
    expect(round(block.composite - pemb.composite)).toBe(2);
  });
  it('Cat 6 inverse upside: below-market + short WALT outscores at-market rent (Q2)', () => {
    const below = scoreAcquisition(strongDeal({ inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5 }), r, { now: NOW });
    const atMkt = scoreAcquisition(strongDeal({ inPlaceRentPsf: 6.0, marketRentPsf: 6.0, waltYears: 1.5 }), r, { now: NOW });
    expect(below.composite).toBeGreaterThan(atMkt.composite);
  });
  it('vacancy reallocates Cat 6 (7) from Risk → Asset', () => {
    const s = scoreAcquisition(strongDeal({ isVacant: true, valueAddScore: 0.5 }), r, { now: NOW });
    const asset = s.subScores.find((x) => x.id === 'asset');
    const risk = s.subScores.find((x) => x.id === 'risk');
    expect(asset?.maxPoints).toBe(33); // 20 product + 13 vacant value-add
    expect(risk?.maxPoints).toBe(10);  // 10 seller only (tenancy → 0)
  });
});

describe('Q3 — market-estimated cannot carry T1', () => {
  it('caps T1 → T2 when only the estimated market ± crosses 75', () => {
    const r = ratifiedComplete();
    // confirmed base 73 (entry cluster=6, seller 0.2, at-market rents, no value-add) + estimated ±3 ⇒ composite 76
    const s = scoreAcquisition(strongDeal({
      clusterTier: 'entry',
      marketFundamentalsAdj: 1, marketFundamentalsConfidence: 'estimated',
      compSourcedAt: NOW, asAtUtc: NOW,
      sellerMotivationScore: 0.2, inPlaceRentPsf: 6.0, marketRentPsf: 6.0, valueAddScore: 0,
    }), r, { now: NOW });
    expect(s.composite).toBeGreaterThanOrEqual(75);
    expect(s.tier).toBe('T2');
    expect(s.verdict).toBe('WATCH');
    expect(s.cappedAtT2).toBe(true);
    expect(s.reasons.join(' ')).toMatch(/estimated market/i);
  });
});

describe('incomplete + advisory (the committed PROPOSED ruleset)', () => {
  it('never PURSUE on a proposed/incomplete ruleset, and flags advisoryOnly', () => {
    const s = scoreAcquisition(strongDeal(), proposed, { now: NOW });
    expect(s.advisoryOnly).toBe(true);
    expect(s.incompleteRuleset).toBe(true);
    expect(s.verdict).not.toBe('PURSUE');
    expect(s.cappedAtT2).toBe(true);
  });
});

describe('STAGE 2.5 — DD-critical cap', () => {
  it('an unresolved DD-critical item caps a PURSUE at T2', () => {
    const r = ratifiedComplete();
    const s = scoreAcquisition(strongDeal({ ddKnown: { flood: true, zoning: true, 'deferred-maintenance-capex': true } }), r, { now: NOW });
    expect(s.ddCriticalUnresolved).toContain('roof');
    expect(s.tier).toBe('T2');
    expect(s.cappedAtT2).toBe(true);
  });
});

describe('adversarial refute fixes (2026-06-13)', () => {
  const r = ratifiedComplete();

  // edge-cases CRITICAL — STAGE 0 gates must fail-CLOSED on unknown kill-determining inputs
  it('unknown physical kill-inputs cannot reach PURSUE and degrade confidence off "confirmed"', () => {
    const s = scoreAcquisition(strongDeal({ clearHeightFt: null, multiStory: null, hasDock: null, hasDriveIn: null }), r, { now: NOW });
    expect(s.verdict).not.toBe('PURSUE');
    expect(s.tier).toBe('T2');
    expect(s.cappedAtT2).toBe(true);
    expect(s.confidence).not.toBe('confirmed');
    expect(s.reasons.join(' ')).toMatch(/unconfirmed|kill screen/i);
  });
  it('unknown price AND SF cannot clear the size box as a confirmed PURSUE', () => {
    const s = scoreAcquisition(strongDeal({ price: null, maxBuildingSf: null }), r, { now: NOW });
    expect(s.verdict).not.toBe('PURSUE');
    expect(s.cappedAtT2).toBe(true);
  });
  it('a fully-known strong deal still PURSUEs (no false cap from the new gate guard)', () => {
    expect(scoreAcquisition(strongDeal(), r, { now: NOW }).verdict).toBe('PURSUE');
  });

  // determinism CRITICAL — freshness rides on the asAtUtc INPUT, never the wall clock
  it('market ± lands only when asAtUtc establishes freshness; null asAtUtc → stale, no Date.now leak', () => {
    const over = {
      clusterTier: 'entry', marketFundamentalsAdj: 1, marketFundamentalsConfidence: 'confirmed',
      compSourcedAt: '2026-06-01T00:00:00Z', sellerMotivationScore: 0, valueAddScore: 0,
      inPlaceRentPsf: 6.0, marketRentPsf: 6.0, waltYears: 10,
    };
    const fresh = scoreAcquisition(strongDeal({ ...over, asAtUtc: '2026-06-13T00:00:00Z' }), r, { now: NOW }); // 12d ≤ 90d
    const noClock = scoreAcquisition(strongDeal({ ...over, asAtUtc: null }), r, { now: NOW });                // cannot establish freshness ⇒ stale
    expect(fresh.composite).toBeGreaterThan(noClock.composite);
    expect(scoreAcquisition(strongDeal({ ...over, asAtUtc: null }), r, { now: NOW })).toEqual(noClock); // deterministic, no clock dependence
  });

  // determinism HIGH — inputsVersion stable for decision-identical ddKnown (absent ≡ explicit false)
  it('inputsVersion treats an absent ddKnown key as explicit false', () => {
    const a = computeInputsVersion(AcquisitionInput.parse({ dealId: 'd', ddKnown: { flood: true } }), r);
    const b = computeInputsVersion(AcquisitionInput.parse({ dealId: 'd', ddKnown: { flood: true, roof: false, zoning: false, 'deferred-maintenance-capex': false } }), r);
    expect(a).toBe(b);
  });

  // correctness HIGH — Q3 must NOT subtract a clamped-out estimated ± (owned-submarket tier at the Cat4 cap)
  it('Q3 does not cap an owned-submarket PURSUE whose estimated ± is clamped out', () => {
    const s = scoreAcquisition(strongDeal({
      clusterTier: 'owned-submarket', marketFundamentalsAdj: 1, marketFundamentalsConfidence: 'estimated',
      compSourcedAt: NOW, asAtUtc: NOW, sellerMotivationScore: 0, valueAddScore: 0,
      inPlaceRentPsf: 6.0, marketRentPsf: 6.0, waltYears: 10,
    }), r, { now: NOW });
    expect(s.composite).toBeGreaterThanOrEqual(75);
    expect(s.verdict).toBe('PURSUE');
    expect(s.cappedAtT2).toBe(false);
  });

  // correctness MEDIUM — composite equals the sum of the displayed sub-scores (§2 identity)
  it('composite equals the sum of the displayed sub-scores even with fractional inputs', () => {
    const s = scoreAcquisition(strongDeal({ valueAddScore: 0.777 }), r, { now: NOW });
    expect(s.composite).toBe(round(s.subScores.reduce((acc, x) => acc + x.points, 0)));
  });
});

function round(n: number): number { return Math.round(n * 10) / 10; }
