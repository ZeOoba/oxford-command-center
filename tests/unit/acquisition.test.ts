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

describe('characterization — currently-untested STAGE 0/1 branches (additive, 2026-06-13)', () => {
  const r = ratifiedComplete();

  // 1. IRR floor is horizon-dependent: 10yr bar (0.12) is looser than the 5yr bar (0.15).
  //    A deal at leveredIrr 0.13 PASSES the floor at horizon 10 but the SAME deal KILLs at the
  //    default-horizon 5yr bar (engine: irrReq = horizon===10 ? floor10yr : floor5yr; null ⇒ 5yr).
  it('10yr IRR floor: leveredIrr 0.13 passes at horizon 10 but kills at the default-horizon 5yr bar', () => {
    const tenYr = scoreAcquisition(strongDeal({ underwriteHorizonYrs: 10, leveredIrr: 0.13 }), r, { now: NOW });
    expect(tenYr.floors.find((f) => f.id === 'irr')?.passed).toBe(true);
    expect(tenYr.floors.find((f) => f.id === 'irr')?.required).toBe(0.12);
    expect(tenYr.verdict).not.toBe('KILLED');

    // Same IRR, default horizon (null) ⇒ stricter 5yr bar (0.15) ⇒ hard floor fail ⇒ KILLED.
    const defHorizon = scoreAcquisition(strongDeal({ underwriteHorizonYrs: null, leveredIrr: 0.13 }), r, { now: NOW });
    expect(defHorizon.floors.find((f) => f.id === 'irr')?.required).toBe(0.15);
    expect(defHorizon.floors.find((f) => f.id === 'irr')?.passed).toBe(false);
    expect(defHorizon.verdict).toBe('KILLED');
  });

  // 2. Basis-discount floor is vintage-banded: post-millennium (built ≥ 2000) needs 25%, pre-millennium
  //    needs 30%, and an UNKNOWN vintage (null) defaults to the STRICT (pre-millennium) branch.
  //    Pin the deal at exactly a 27% discount (basis 8.76M / RCT 12M): clears the 25% post-2000 bar,
  //    fails the 30% pre-2000 bar — so 1998 KILLs, 2001 passes, and null (strict) KILLs.
  it('vintage basis floor: 27% discount — 1998 kills, 2001 passes, null defaults strict (kills)', () => {
    const discounted = { allInBasis: 8_760_000, replacementCostTotal: 12_000_000 }; // 1 − 8.76/12 = 0.27
    const built1998 = scoreAcquisition(strongDeal({ ...discounted, yearBuilt: 1998 }), r, { now: NOW });
    expect(built1998.floors.find((f) => f.id === 'basis')?.required).toBe(0.30);
    expect(built1998.floors.find((f) => f.id === 'basis')?.passed).toBe(false);
    expect(built1998.verdict).toBe('KILLED');

    const built2001 = scoreAcquisition(strongDeal({ ...discounted, yearBuilt: 2001 }), r, { now: NOW });
    expect(built2001.floors.find((f) => f.id === 'basis')?.required).toBe(0.25);
    expect(built2001.floors.find((f) => f.id === 'basis')?.passed).toBe(true);
    expect(built2001.verdict).not.toBe('KILLED');

    // null vintage ⇒ strict (pre-millennium) branch ⇒ 30% required ⇒ KILLED at 27%.
    const builtNull = scoreAcquisition(strongDeal({ ...discounted, yearBuilt: null }), r, { now: NOW });
    expect(builtNull.floors.find((f) => f.id === 'basis')?.required).toBe(0.30);
    expect(builtNull.verdict).toBe('KILLED');
  });

  // 3. Stabilized YoC floor at the exact 8% boundary: 0.08 PASSES (≥), 0.079 KILLs (computable fail),
  //    null ⇒ floorIndeterminate ⇒ NOT killed, lands in T2/WATCH.
  //
  //    CHARACTERIZATION SURPRISE (see report): with stabilizedYoc null the Cat-2 yield sub-score also
  //    zeroes out, so the composite (74.2) falls BELOW the 75 T1 bar on its own — the deal lands at T2
  //    BY BAND, and the `cappedAtT2` flag stays FALSE (it only flips when a T1-banded deal is demoted).
  //    The floor-indeterminacy is surfaced ONLY in `reasons` ("a floor is indeterminate"), not via the
  //    cappedAtT2 boolean. A consumer keying off cappedAtT2 alone would miss the indeterminacy here.
  it('stabilized YoC floor boundary: 0.08 passes, 0.079 kills, null ⇒ floorIndeterminate (T2/WATCH, not capped-flag)', () => {
    const atBoundary = scoreAcquisition(strongDeal({ stabilizedYoc: 0.08 }), r, { now: NOW });
    expect(atBoundary.floors.find((f) => f.id === 'yield')?.passed).toBe(true);
    expect(atBoundary.verdict).not.toBe('KILLED');

    const justUnder = scoreAcquisition(strongDeal({ stabilizedYoc: 0.079 }), r, { now: NOW });
    expect(justUnder.floors.find((f) => f.id === 'yield')?.passed).toBe(false);
    expect(justUnder.verdict).toBe('KILLED');

    const unknownYoc = scoreAcquisition(strongDeal({ stabilizedYoc: null }), r, { now: NOW });
    expect(unknownYoc.verdict).not.toBe('KILLED');     // indeterminate floor never KILLs
    expect(unknownYoc.floors.find((f) => f.id === 'yield')?.actual).toBeNull();
    expect(unknownYoc.tier).toBe('T2');                 // composite (74.2) < 75 ⇒ T2 by band
    expect(unknownYoc.cappedAtT2).toBe(false);          // never T1, so the cap flag never fires
    expect(unknownYoc.reasons.join(' ')).toMatch(/floor is indeterminate/i); // surfaced only in reasons
  });

  // 4. STAGE 0 other-use / DD-critical KILLs (each on its own, gates otherwise passing):
  //    child-related use without a safety review, env remediation above the 20% max, and a
  //    ground-lease term below the 30yr minimum each independently KILL.
  it('STAGE 0 other-use kills: child-related (unreviewed), env-remediation > max, ground-lease < min', () => {
    const child = scoreAcquisition(
      strongDeal({ use: { automotive: false, childRelated: true, childSafetyReviewed: false } }), r, { now: NOW });
    expect(child.verdict).toBe('KILLED');
    expect(child.gates.find((g) => g.id === 'other-use')?.passed).toBe(false);

    // child-related WITH a safety review does NOT kill on the other-use gate.
    const childReviewed = scoreAcquisition(
      strongDeal({ use: { automotive: false, childRelated: true, childSafetyReviewed: true } }), r, { now: NOW });
    expect(childReviewed.gates.find((g) => g.id === 'other-use')?.passed).toBe(true);

    const env = scoreAcquisition(strongDeal({ envRemediationPctOfPrice: 0.25 }), r, { now: NOW }); // > 0.20 max
    expect(env.verdict).toBe('KILLED');
    expect(env.gates.find((g) => g.id === 'other-use')?.passed).toBe(false);

    const groundLease = scoreAcquisition(strongDeal({ groundLeaseYearsRemaining: 25 }), r, { now: NOW }); // < 30 min
    expect(groundLease.verdict).toBe('KILLED');
    expect(groundLease.gates.find((g) => g.id === 'other-use')?.passed).toBe(false);
  });

  // 5. allInBasis null OR replacementCostTotal null ⇒ basis discount indeterminate ⇒ NOT killed.
  //
  //    CHARACTERIZATION SURPRISE (same shape as case 3): a null basis input also zeroes the Cat-1 basis
  //    sub-score, dragging the composite (69.2) below the 75 T1 bar — so the deal lands at T2/WATCH BY
  //    BAND and `cappedAtT2` is FALSE. The floor-indeterminacy shows up in `reasons` and as a null
  //    `floors.basis.actual`, never via the cappedAtT2 flag. Encoding ACTUAL behavior, not the intuitive
  //    "indeterminate ⇒ capped-at-T2" reading.
  it('null allInBasis or null replacementCostTotal ⇒ basis floor indeterminate (T2/WATCH, not killed)', () => {
    const noBasis = scoreAcquisition(strongDeal({ allInBasis: null }), r, { now: NOW });
    expect(noBasis.verdict).not.toBe('KILLED');
    expect(noBasis.floors.find((f) => f.id === 'basis')?.actual).toBeNull();
    expect(noBasis.tier).toBe('T2');
    expect(noBasis.cappedAtT2).toBe(false);
    expect(noBasis.reasons.join(' ')).toMatch(/floor is indeterminate/i);

    const noRct = scoreAcquisition(strongDeal({ replacementCostTotal: null }), r, { now: NOW });
    expect(noRct.verdict).not.toBe('KILLED');
    expect(noRct.floors.find((f) => f.id === 'basis')?.actual).toBeNull();
    expect(noRct.tier).toBe('T2');
    expect(noRct.cappedAtT2).toBe(false);
    expect(noRct.reasons.join(' ')).toMatch(/floor is indeterminate/i);
  });

  // 6. M8 wall-clock determinism. DISTINCT from the now-injected determinism test (~line 64-69):
  //    that one PASSES opts.now and would still pass even if scoredAt secretly read Date.now().
  //    Here we deliberately pass NO opts.now, so scoredAt falls through to `new Date().toISOString()`.
  //    Stripping scoredAt, the REST of the result must be wall-clock-independent. Do NOT consolidate
  //    these two tests — collapsing them would silently restore the wall-clock blind spot.
  it('wall-clock determinism: two no-opts calls deep-equal once scoredAt is stripped', () => {
    const { scoredAt: _a, ...restA } = scoreAcquisition(strongDeal(), r); // no opts.now — wall-clock scoredAt
    const { scoredAt: _b, ...restB } = scoreAcquisition(strongDeal(), r); // no opts.now — wall-clock scoredAt
    expect(restA).toEqual(restB);
  });
});

function round(n: number): number { return Math.round(n * 10) / 10; }
