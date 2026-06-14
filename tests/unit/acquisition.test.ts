// tests/unit/acquisition.test.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AcquisitionInput, type AcquisitionRuleset, ReplacementCostTable } from '@contracts/acquisition';
import {
  assertProductionRct,
  assertProductionRuleset,
  computeInputsVersion,
  loadRatifiedRct,
  parseRuleset,
  replacementCostTotal,
  scoreAcquisition,
} from '../../server/warehouse/acquisition';

const ratifiedJson = JSON.parse(
  readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8'),
);
const rctJson = JSON.parse(
  readFileSync(resolve(process.cwd(), 'config/replacement-cost.v1.json'), 'utf8'),
);
const ratified = parseRuleset(ratifiedJson);
const RCT = loadRatifiedRct();
const NOW = '2026-06-13T00:00:00Z';

/** A 'proposed', incomplete variant derived from the ratified config (clear-height bands nulled). */
function proposedIncomplete(): AcquisitionRuleset {
  const j = structuredClone(ratifiedJson);
  j.ratification = 'proposed';
  j.scoring.cat3.clearHeightBands = null;
  return parseRuleset(j);
}
const proposed = proposedIncomplete();

/** A strong, fully-known PURSUE-grade deal — HONEST under the ratified RCT ($137.50/SF): 60k SF →
 *  $8.25M replacement; $3.6M all-in ≈ 56% discount → full basis. Loosely typed; parsed at runtime. */
const STRONG_BASE: Record<string, unknown> = {
  dealId: 'strong',
  price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6, multiStory: false, truckCourtFt: 120,
  constructionType: 'block-tilt-brick', yearBuilt: 2005,
  sfhaOnPad: false,
  allInBasis: 3_600_000, stabilizedYoc: 0.12, leveredIrr: 0.18, underwriteHorizonYrs: 5,
  clusterTier: 'owned-submarket',
  sellerMotivationScore: 0.8,
  isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5,
  valueAddScore: 0.5,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
};
function strongDeal(over: Record<string, unknown> = {}) {
  return AcquisitionInput.parse({ ...STRONG_BASE, ...over });
}
/** Score against the ratified ruleset + RCT (the production-faithful path) unless overridden. */
function score(deal: AcquisitionInput, ruleset: AcquisitionRuleset = ratified, opts: Record<string, unknown> = {}) {
  return scoreAcquisition(deal, ruleset, { now: NOW, rct: RCT, ...opts });
}
const round = (n: number): number => Math.round(n * 10) / 10;

describe('fail-closed guards', () => {
  it('assertProductionRuleset throws on a proposed ruleset', () => {
    expect(() => assertProductionRuleset(proposed)).toThrow(/not 'ratified'/);
  });
  it('throws on a ratified-but-incomplete ruleset (clear-height bands null)', () => {
    const j = structuredClone(ratifiedJson); j.ratification = 'ratified'; j.scoring.cat3.clearHeightBands = null;
    expect(() => assertProductionRuleset(parseRuleset(j))).toThrow(/clearHeightBands=null/);
  });
  it('throws on a ratified ruleset missing provenance (ratifiedBy null)', () => {
    const j = structuredClone(ratifiedJson); j.ratifiedBy = null;
    expect(() => assertProductionRuleset(parseRuleset(j))).toThrow(/provenance/);
  });
  it('passes a ratified + complete + signed ruleset', () => {
    expect(() => assertProductionRuleset(ratified)).not.toThrow();
  });
  it('assertProductionRct: real RCT passes; proposed or unsigned throws', () => {
    expect(() => assertProductionRct(RCT)).not.toThrow();
    expect(() => assertProductionRct(ReplacementCostTable.parse({ ...rctJson, ratification: 'proposed' }))).toThrow(/not 'ratified'/);
    expect(() => assertProductionRct(ReplacementCostTable.parse({ ...rctJson, ratifiedBy: null }))).toThrow(/provenance/);
  });
});

describe('determinism', () => {
  it('same (input, ruleset, rct) → identical score (scoredAt injected)', () => {
    expect(score(strongDeal())).toEqual(score(strongDeal()));
  });
  it('inputsVersion is stable, changes on a real field, and treats absent ddKnown ≡ false', () => {
    expect(computeInputsVersion(strongDeal(), ratified)).toBe(computeInputsVersion(strongDeal(), ratified));
    expect(computeInputsVersion(strongDeal(), ratified)).not.toBe(computeInputsVersion(strongDeal({ price: 3_600_000 }), ratified));
    const a = computeInputsVersion(AcquisitionInput.parse({ dealId: 'd', ddKnown: { flood: true } }), ratified);
    const b = computeInputsVersion(AcquisitionInput.parse({ dealId: 'd', ddKnown: { flood: true, roof: false, zoning: false, 'deferred-maintenance-capex': false } }), ratified);
    expect(a).toBe(b);
  });
});

describe('STAGE 0 gates KILL', () => {
  it('kills on building SF ≥ 50,000', () => {
    expect(score(strongDeal({ maxBuildingSf: 55_000 })).verdict).toBe('KILLED');
  });
  it('kills on clear height < 12 ft', () => {
    expect(score(strongDeal({ clearHeightFt: 10 })).verdict).toBe('KILLED');
  });
  it('kills on SFHA on the pad, automotive use, office-only product, and satellite > 30 min', () => {
    expect(score(strongDeal({ sfhaOnPad: true })).verdict).toBe('KILLED');
    expect(score(strongDeal({ use: { automotive: true, childRelated: false, childSafetyReviewed: false } })).verdict).toBe('KILLED');
    expect(score(strongDeal({ productType: 'office-only' })).verdict).toBe('KILLED');
    expect(score(strongDeal({ clusterTier: 'satellite', driveMinutesToCluster: 45 })).verdict).toBe('KILLED');
  });
  it('kills when door COUNTS show no ground-level access (0 docks AND 0 drive-ins), counts authoritative', () => {
    const s = score(strongDeal({ dockCount: 0, driveInCount: 0 }));
    expect(s.verdict).toBe('KILLED');
    expect(s.gates.find((g) => g.id === 'physical')?.passed).toBe(false);
  });
});

describe('STAGE 1 floors KILL', () => {
  it('kills when stabilized YoC is below the 8% floor', () => {
    expect(score(strongDeal({ stabilizedYoc: 0.06 })).verdict).toBe('KILLED');
  });
});

describe('STAGE 2 scorecard', () => {
  it('a strong, honest deal is T1 PURSUE, live (not advisory), composite > 90', () => {
    const s = score(strongDeal());
    expect(s.tier).toBe('T1');
    expect(s.verdict).toBe('PURSUE');
    expect(s.composite).toBeGreaterThan(90);
    expect(s.advisoryOnly).toBe(false);
    expect(s.incompleteRuleset).toBe(false);
  });
  it('PEMB construction scores exactly 2 points below block/tilt/brick (Q1)', () => {
    expect(round(score(strongDeal()).composite - score(strongDeal({ constructionType: 'pemb' })).composite)).toBe(2);
  });
  it('Cat 6 inverse upside: below-market + short WALT outscores at-market rent (Q2)', () => {
    expect(score(strongDeal()).composite).toBeGreaterThan(score(strongDeal({ inPlaceRentPsf: 6.0 })).composite);
  });
  it('vacancy reallocates Cat 6 (7) from Risk → Asset', () => {
    const s = score(strongDeal({ isVacant: true }));
    expect(s.subScores.find((x) => x.id === 'asset')?.maxPoints).toBe(33);
    expect(s.subScores.find((x) => x.id === 'risk')?.maxPoints).toBe(10);
  });
  it('composite equals the sum of the displayed sub-scores even with fractional inputs (§2)', () => {
    const s = score(strongDeal({ valueAddScore: 0.777 }));
    expect(s.composite).toBe(round(s.subScores.reduce((acc, x) => acc + x.points, 0)));
  });
});

describe('Q3 — market-estimated cannot carry T1', () => {
  it('caps T1 → T2 when only the estimated market ± crosses 75 (entry cluster, ± lands)', () => {
    const s = score(strongDeal({
      clusterTier: 'entry', marketFundamentalsAdj: 1, marketFundamentalsConfidence: 'estimated',
      compSourcedAt: NOW, asAtUtc: NOW, sellerMotivationScore: 0.2, inPlaceRentPsf: 6.0, marketRentPsf: 6.0, valueAddScore: 0,
    }));
    expect(s.composite).toBeGreaterThanOrEqual(75);
    expect(s.verdict).toBe('WATCH');
    expect(s.cappedAtT2).toBe(true);
    expect(s.reasons.join(' ')).toMatch(/estimated market/i);
  });
  it('does NOT cap an owned-submarket PURSUE whose estimated ± is clamped out at the Cat4 cap', () => {
    const s = score(strongDeal({
      clusterTier: 'owned-submarket', marketFundamentalsAdj: 1, marketFundamentalsConfidence: 'estimated',
      compSourcedAt: NOW, asAtUtc: NOW, sellerMotivationScore: 0, inPlaceRentPsf: 6.0, marketRentPsf: 6.0, valueAddScore: 0,
    }));
    expect(s.composite).toBeGreaterThanOrEqual(75);
    expect(s.verdict).toBe('PURSUE');
    expect(s.cappedAtT2).toBe(false);
  });
});

describe('caps: incomplete/advisory, DD, unknown gates', () => {
  it('never PURSUE on a proposed/incomplete ruleset; flags advisoryOnly', () => {
    const s = score(strongDeal(), proposed);
    expect(s.advisoryOnly).toBe(true);
    expect(s.incompleteRuleset).toBe(true);
    expect(s.verdict).not.toBe('PURSUE');
    expect(s.cappedAtT2).toBe(true);
  });
  it('an unresolved DD-critical item caps a PURSUE at T2', () => {
    const s = score(strongDeal({ ddKnown: { flood: true, zoning: true, 'deferred-maintenance-capex': true } }));
    expect(s.ddCriticalUnresolved).toContain('roof');
    expect(s.cappedAtT2).toBe(true);
  });
  it('unknown physical kill-inputs cannot reach PURSUE and degrade confidence off "confirmed"', () => {
    const s = score(strongDeal({ clearHeightFt: null, multiStory: null, hasDock: null, hasDriveIn: null, dockCount: null, driveInCount: null }));
    expect(s.verdict).not.toBe('PURSUE');
    expect(s.cappedAtT2).toBe(true);
    expect(s.confidence).not.toBe('confirmed');
  });
  it('unknown price AND SF cannot clear the size box as a confirmed PURSUE', () => {
    expect(score(strongDeal({ price: null, maxBuildingSf: null })).cappedAtT2).toBe(true);
  });
});

describe('ratified recalibration — RCT, loading, provenance (Gabriel 2026-06-14)', () => {
  it('Basis divides by the ratified RCT, not a caller scalar: an honest high basis is KILLED', () => {
    // 60k SF × $137.50 = $8.25M replacement; $7M all-in ⇒ 15.2% discount < 25% floor ⇒ KILLED.
    const s = score(strongDeal({ allInBasis: 7_000_000 }));
    expect(s.verdict).toBe('KILLED');
    expect(s.floors.find((f) => f.id === 'basis')?.passed).toBe(false);
  });
  it('an inflated caller replacementCostTotal cannot game Basis — RCT governs + divergence is flagged', () => {
    const s = score(strongDeal({ replacementCostTotal: 99_000_000 }));
    expect(s.verdict).toBe('PURSUE'); // override ignored; RCT-derived 56% discount stands
    expect(s.dataQuality.some((d) => d.field === 'replacementCostTotal')).toBe(true);
  });
  it('Basis is RCT-backed even with no caller replacementCostTotal (STRONG_BASE omits it)', () => {
    const basis = score(strongDeal()).floors.find((f) => f.id === 'basis');
    expect(basis?.passed).toBe(true);
    expect(basis?.actual ?? 0).toBeGreaterThan(0.5); // ~56% discount derived from the RCT
  });
  it('loading is CONJUNCTIVE: a glut of one door type cannot buy back absence of the other (min, not avg)', () => {
    const balanced = score(strongDeal({ totalSf: 30000, dockCount: 3, driveInCount: 3 }));
    const glut = score(strongDeal({ totalSf: 30000, dockCount: 30, driveInCount: 0, hasDriveIn: false }));
    expect(balanced.composite).toBeGreaterThan(glut.composite);
  });
  it('door data is monotonic: full doors > unknown (neutral) > sparse — reporting never scores lower than withholding', () => {
    const full = score(strongDeal());                                  // 6/6 on 60k → adequacy 1.0
    const unknown = score(strongDeal({ dockCount: null, driveInCount: null })); // neutral 0.5
    const sparse = score(strongDeal({ dockCount: 1, driveInCount: 1 }));        // 1/6 → ~0.17
    expect(full.composite).toBeGreaterThan(unknown.composite);
    expect(unknown.composite).toBeGreaterThan(sparse.composite);
  });
  it('flags contradictory door inputs (count 0 but presence flag true)', () => {
    const s = score(strongDeal({ dockCount: 0, driveInCount: 2, hasDock: true }));
    expect(s.dataQuality.some((d) => d.field === 'doors')).toBe(true);
  });
  it('clear-height: full at 14ft (<20k) / 16ft (>20k), partial below', () => {
    const small14 = score(strongDeal({ maxBuildingSf: 15000, totalSf: 15000, clearHeightFt: 14 }));
    const small13 = score(strongDeal({ maxBuildingSf: 15000, totalSf: 15000, clearHeightFt: 13 }));
    const large14 = score(strongDeal({ maxBuildingSf: 30000, totalSf: 30000, clearHeightFt: 14 }));
    const large16 = score(strongDeal({ maxBuildingSf: 30000, totalSf: 30000, clearHeightFt: 16 }));
    expect(small14.composite).toBeGreaterThan(small13.composite);
    expect(large16.composite).toBeGreaterThan(large14.composite);
  });
  it('replacementCostTotal helper uses the ratified RCT mid ($137.50) by default', () => {
    expect(replacementCostTotal(42000, RCT)).toBe(42000 * 137.5);
  });
});
