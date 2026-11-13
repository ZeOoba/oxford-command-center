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
  basisVintageFloor,
  scoreAcquisition,
} from '../../server/warehouse/acquisition';
import { RCT_V03, vintageFloor } from '../../src/brain/replacement-cost';

const ratifiedJson = JSON.parse(
  readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8'),
);
const rctJson = JSON.parse(
  readFileSync(resolve(process.cwd(), 'config/replacement-cost.v3.json'), 'utf8'),
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

/** A strong, fully-known PURSUE-grade deal — HONEST under RCT v03's conservative firm-wide fallback
 *  (no market supplied, $225.59/SF — Chicago Cook County IL since RCT v3.2, the cheapest market, per doctrine the
 *  strictest available floor; tilt-up ×1.00): 60k SF → $13.535M replacement; $1.2M all-in ≈ 91.1% discount → full Basis credit (full-credit
 *  threshold is 0.90 at the yearBuilt=2005 post-cutoff floor). RECALIBRATED 2026-07-14 (refute-fix):
 *  the prior $3.6M/~56% figure only reached full Basis credit because of the step-function bug the
 *  refute pass caught (basisFullCreditDiscount sat below the vintage floor); under the corrected
 *  graduated ramp, ~56-74% discount earns partial credit only (~11/25 pts), not the max. This fixture
 *  now needs a genuinely deep discount to represent "obviously strong," matching the doctrine finding
 *  that ORA's real full-credit bar sits well above its floor, not just above it. Loosely typed; parsed
 *  at runtime. */
const STRONG_BASE: Record<string, unknown> = {
  dealId: 'strong',
  price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6, multiStory: false, truckCourtFt: 120,
  constructionType: 'tilt-precast', yearBuilt: 2005,
  sfhaOnPad: false,
  // other-use gate inputs, CONFIRMED (audit 2026-11-08 other-use-gate-unfed-fail-open): fee simple, Phase I clean,
  // no automotive / child-related use. Unknown values now cap at T2, so a "fully-known" deal must carry them.
  groundLeased: false, envRemediationPctOfPrice: 0,
  use: { automotive: false, childRelated: false, childSafetyReviewed: false },
  allInBasis: 1_200_000, stabilizedYoc: 0.12, leveredIrr: 0.18, unleveredIrr10yr: 0.12, underwriteHorizonYrs: 5,
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
  });
  it('governor fingerprint mints a distinct inputs_version; absent/null preserves the legacy hash', () => {
    // I1 (governor-excluded-from-score-dedup-key): the persistence layer folds a governor
    // fingerprint into the dedup key so a DSCR/LTV change re-derives persisted verdicts. Pure/edge
    // callers that pass no fingerprint (or null) must keep their legacy hashes — the key is only
    // widened where governor state is actually loaded.
    const legacy = computeInputsVersion(strongDeal(), ratified);
    expect(computeInputsVersion(strongDeal(), ratified, undefined, null)).toBe(legacy);
    const fp1 = computeInputsVersion(strongDeal(), ratified, undefined, '1.25:0.4:0.085');
    const fp2 = computeInputsVersion(strongDeal(), ratified, undefined, '1.3:0.4:0.085');
    expect(fp1).not.toBe(legacy);
    expect(fp2).not.toBe(fp1);
    expect(computeInputsVersion(strongDeal(), ratified, undefined, '1.25:0.4:0.085')).toBe(fp1);
    // Empty-string fingerprint throws — never a silent legacy-keyspace collision (refute fix).
    expect(() => computeInputsVersion(strongDeal(), ratified, undefined, '')).toThrow(/empty governor fingerprint/);
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
  it('kills on retail-only product type (L14)', () => {
    expect(score(strongDeal({ productType: 'retail-only' })).verdict).toBe('KILLED');
  });
  it('kills a short ground lease (other-use gate, threshold from the ruleset)', () => {
    const s = score(strongDeal({ groundLeaseYearsRemaining: ratified.gates.other.minGroundLeaseYearsRemaining - 1 }));
    expect(s.verdict).toBe('KILLED');
    expect(s.gates.find((g) => g.id === 'other-use')!.passed).toBe(false);
  });
  it('kills excessive environmental remediation (other-use gate, threshold from the ruleset)', () => {
    const s = score(strongDeal({ envRemediationPctOfPrice: ratified.gates.other.maxEnvRemediationPctOfPrice + 0.01 }));
    expect(s.verdict).toBe('KILLED');
    expect(s.gates.find((g) => g.id === 'other-use')!.passed).toBe(false);
  });
  it('kills child-related use without safety review; the gate passes once reviewed', () => {
    expect(score(strongDeal({ use: { automotive: false, childRelated: true, childSafetyReviewed: false } })).verdict).toBe('KILLED');
    const reviewed = score(strongDeal({ use: { automotive: false, childRelated: true, childSafetyReviewed: true } }));
    expect(reviewed.gates.find((g) => g.id === 'other-use')!.passed).toBe(true);
    expect(reviewed.verdict).not.toBe('KILLED');
  });
  it('SFHA on excess land only (pad clear) passes the flood gate — value land at $0, proceed', () => {
    // STRONG_BASE sets sfhaOnPad: false — the pad-KILL branch (line above) must not fire; the
    // excess-land branch is only reachable when the pad is clear (engine flood gate is an if/else-if).
    const s = score(strongDeal({ sfhaOnExcessLandOnly: true }));
    const flood = s.gates.find((g) => g.id === 'flood')!;
    expect(flood.passed).toBe(true);
    expect(flood.detail).toBe('SFHA on excess land only — value land at $0, proceed');
    expect(s.verdict).not.toBe('KILLED');
  });
  it('null SF deal cannot reach PURSUE (basis indeterminate, size box unconfirmed) (L15)', () => {
    const s = score(strongDeal({ totalSf: null, maxBuildingSf: null }));
    expect(s.verdict).not.toBe('PURSUE');
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

// 2026-09-30 audit: an unknown officePct was read as 0% office and earned FULL product-fit credit,
// with no flag and no confidence downgrade. Every other unknown input scores neutral or zero and
// says so (truck court, door counts). An unfilled field must never outscore a reported one.
describe('unknown officePct scores neutral, not full credit', () => {
  const PF = ratifiedJson.scoring.cat3.productFitPoints as number;
  const asset = (d: ReturnType<typeof score>) => d.subScores.find((x) => x.id === 'asset')!;

  it('scores half the product-fit points when officePct is null', () => {
    const known = score(strongDeal({ officePct: 0.1 }));
    const unknown = score(strongDeal({ officePct: null }));
    expect(round(asset(known).points - asset(unknown).points)).toBe(round(PF * 0.5));
  });
  it('never outscores a reported low-office deal', () => {
    expect(score(strongDeal({ officePct: null })).composite).toBeLessThan(score(strongDeal({ officePct: 0.1 })).composite);
  });
  it('raises an officePct data-quality flag', () => {
    expect(score(strongDeal({ officePct: null })).dataQuality.some((d) => d.field === 'officePct')).toBe(true);
    expect(score(strongDeal({ officePct: 0.1 })).dataQuality.some((d) => d.field === 'officePct')).toBe(false);
  });
  it('downgrades the asset sub-score confidence to estimated', () => {
    expect(asset(score(strongDeal({ officePct: 0.1 }))).confidence).toBe('confirmed');
    expect(asset(score(strongDeal({ officePct: null }))).confidence).toBe('estimated');
  });
  it('leaves office-heavy and known-office scoring unchanged', () => {
    const heavy = score(strongDeal({ officePct: 0.65 }));
    const light = score(strongDeal({ officePct: 0.3 }));
    expect(asset(heavy).points).toBeLessThan(asset(light).points);
    expect(heavy.dataQuality.some((d) => d.field === 'officePct')).toBe(false);
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
  it('unknown cluster tier demotes via gateIndeterminate (T2 cap), never a hard KILL', () => {
    const s = score(strongDeal({ clusterTier: null }));
    expect(s.verdict).not.toBe('KILLED');
    expect(s.cappedAtT2).toBe(true);
    const market = s.gates.find((g) => g.id === 'market')!;
    expect(market.passed).toBe(true);
    expect(market.detail).toBe('cluster tier unknown');
  });

  it('exposes floorIndeterminate=true when a floor input is null even if capped only by band (B5)', () => {
    // A missing yield input zeroes the yield sub-score, dropping the composite into the T2 band on
    // its own → demoted by BAND, so cappedAtT2 stays false. The indeterminacy must still be visible
    // via a dedicated field, not only by scanning reasons/floors[].actual===null.
    const s = score(strongDeal({ stabilizedYoc: null }));
    expect(s.floorIndeterminate).toBe(true); // the new first-class observability field
    expect(s.cappedAtT2).toBe(false); // demoted by band, not by cap — was the B5 blind spot
    expect(s.floors.find((f) => f.id === 'yield')?.actual).toBeNull(); // consistent with the floor row
  });
});

// Audit 2026-11-08 other-use-gate-unfed-fail-open. The other-use KILL gate (ground lease / environmental remediation /
// automotive / child-related use) passed whenever its inputs were null, and gateIndeterminate never looked at them, so a
// deal nobody had screened for those disqualifiers could reach PURSUE. Mechanism-only fix, mirroring the other gates:
// an UNKNOWN other-use input caps the verdict at T2 (never a KILL); no ratified threshold moves. Ground-lease tenure is
// tri-state (groundLeased: null unknown / false fee simple / true ground-leased) because a null term used to MEAN fee simple.
describe('other-use gate: unknown inputs cap at T2 (audit 2026-11-08)', () => {
  const otherUse = (s: ReturnType<typeof score>) => s.gates.find((g) => g.id === 'other-use')!;
  const flagged = (s: ReturnType<typeof score>, field: string) => s.dataQuality.some((d) => d.field === field);

  it('the fully-confirmed strong deal still reaches PURSUE (fixture carries the other-use inputs)', () => {
    const s = score(strongDeal());
    expect(s.verdict).toBe('PURSUE');
    expect(s.cappedAtT2).toBe(false);
    expect(otherUse(s).passed).toBe(true);
  });

  it.each([
    ['use unknown', { use: null }, 'use'],
    ['environmental remediation unknown', { envRemediationPctOfPrice: null }, 'envRemediationPctOfPrice'],
    ['tenure unknown (fee simple vs ground lease)', { groundLeased: null }, 'groundLeased'],
    ['ground-leased with the term unknown', { groundLeased: true }, 'groundLeaseYearsRemaining'],
  ] as const)('%s: not KILLED, gate passes but is unconfirmed, verdict capped T1 -> T2, confidence off "confirmed"', (_label, over, field) => {
    const s = score(strongDeal(over));
    expect(s.verdict).toBe('WATCH');
    expect(s.tier).toBe('T2');
    expect(s.cappedAtT2).toBe(true);
    expect(otherUse(s).passed).toBe(true);
    expect(otherUse(s).detail).toMatch(/not confirm/);
    expect(flagged(s, field)).toBe(true);
    expect(s.confidence).not.toBe('confirmed');
    expect(s.reasons.join(' ')).toMatch(/Stage-0 gate input is unconfirmed/);
  });

  it('a supplied ground-lease term is determinate whatever groundLeased says (term at the ratified minimum passes)', () => {
    const min = ratified.gates.other.minGroundLeaseYearsRemaining;
    for (const groundLeased of [null, true] as const) {
      const s = score(strongDeal({ groundLeased, groundLeaseYearsRemaining: min }));
      expect(s.verdict).toBe('PURSUE');
      expect(s.cappedAtT2).toBe(false);
    }
  });

  it('a short ground-lease term still KILLS even when tenure is otherwise unknown (KILL beats the cap)', () => {
    const s = score(strongDeal({ groundLeased: null, groundLeaseYearsRemaining: ratified.gates.other.minGroundLeaseYearsRemaining - 1 }));
    expect(s.verdict).toBe('KILLED');
  });

  it('groundLeased=false with a supplied term is flagged as contradictory and the term is still tested', () => {
    const s = score(strongDeal({ groundLeased: false, groundLeaseYearsRemaining: ratified.gates.other.minGroundLeaseYearsRemaining - 1 }));
    expect(s.verdict).toBe('KILLED');
    expect(flagged(s, 'groundLeased')).toBe(true);
  });

  it('an unscreened deal (all three other-use inputs absent, the pre-fix default) cannot reach PURSUE', () => {
    const s = score(strongDeal({ use: null, envRemediationPctOfPrice: null, groundLeased: null }));
    expect(s.verdict).not.toBe('PURSUE');
    expect(s.verdict).not.toBe('KILLED');
    expect(s.cappedAtT2).toBe(true);
  });

  it('inputs_version folds decision-identical other-use inputs (refute wf_5337efe6-574 determinism lens)', () => {
    const v = (over: Record<string, unknown>) => computeInputsVersion(strongDeal(over), ratified);
    // childSafetyReviewed is irrelevant when not child-related
    expect(v({ use: { automotive: false, childRelated: false, childSafetyReviewed: true } }))
      .toBe(v({ use: { automotive: false, childRelated: false, childSafetyReviewed: false } }));
    // ...but it matters when child-related
    expect(v({ use: { automotive: false, childRelated: true, childSafetyReviewed: true } }))
      .not.toBe(v({ use: { automotive: false, childRelated: true, childSafetyReviewed: false } }));
    // with a term supplied, groundLeased null and true decide identically; false (contradiction flag) stays distinct
    expect(v({ groundLeased: null, groundLeaseYearsRemaining: 40 })).toBe(v({ groundLeased: true, groundLeaseYearsRemaining: 40 }));
    expect(v({ groundLeased: false, groundLeaseYearsRemaining: 40 })).not.toBe(v({ groundLeased: true, groundLeaseYearsRemaining: 40 }));
    // with no term, all three tenure states are distinct decisions
    expect(new Set([v({ groundLeased: null }), v({ groundLeased: true }), v({ groundLeased: false })]).size).toBe(3);
  });

  it('a known disqualifier still KILLS with the other inputs unknown', () => {
    const s = score(strongDeal({ use: { automotive: true, childRelated: false, childSafetyReviewed: false }, envRemediationPctOfPrice: null, groundLeased: null }));
    expect(s.verdict).toBe('KILLED');
  });
});

describe('ratified recalibration — RCT, loading, provenance (Gabriel 2026-06-14)', () => {
  it('Basis divides by the ratified RCT, not a caller scalar: an honest high basis is KILLED', () => {
    // RCT v3.2: STRONG_BASE has no market ⇒ conservative fallback (Chicago Cook County IL, low=$225.59/SF).
    // 60k SF × $225.59 = $13.535M replacement; $7M all-in ⇒ ~48.3% discount < 60% floor
    // (built 2005, post-cutoff) ⇒ KILLED.
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
    // RCT v3.2: $1.2M all-in vs $13.535M conservative-fallback replacement ⇒ ~91.1% discount.
    const basis = score(strongDeal()).floors.find((f) => f.id === 'basis');
    expect(basis?.passed).toBe(true);
    expect(basis?.actual ?? 0).toBeGreaterThan(0.9);
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
  it('replacementCostTotal falls back to the CONSERVATIVE firm-wide psf when no market is given', () => {
    // RCT v03: the fallback is the CHEAPEST market to build in ⇒ the STRICTEST floor. We never hand a
    // deal a looser floor because we failed to identify its market.
    expect(replacementCostTotal(42000, RCT)).toBe(42000 * RCT.psf.mid);
  });

  it('replacementCostTotal uses the PER-MARKET row when the market is supplied', () => {
    // The whole point of RCT v03 — the old table was flat firm-wide, with no market variation.
    const columbus = replacementCostTotal(42000, RCT, 'mid', 'Columbus OH');
    const indy = replacementCostTotal(42000, RCT, 'mid', 'Indianapolis IN');
    expect(columbus).toBeCloseTo(42000 * RCT.markets['Columbus OH']!.point, 4);
    expect(indy).toBeCloseTo(42000 * RCT.markets['Indianapolis IN']!.point, 4);
    // Indianapolis is genuinely more expensive to build in than Columbus — RCT v02 had this backwards.
    expect(indy).toBeGreaterThan(columbus);
  });

  it('an unrecognised market falls back conservatively rather than inventing a denominator', () => {
    expect(replacementCostTotal(42000, RCT, 'mid', 'Atlantis')).toBe(42000 * RCT.psf.mid);
  });

  it('basisVintageFloor ramps linearly 65% @≤1995 → 60% @≥2005; unknown vintage gets the STRICTEST', () => {
    expect(basisVintageFloor(1918, ratified)).toBeCloseTo(0.65, 4);
    expect(basisVintageFloor(1995, ratified)).toBeCloseTo(0.65, 4);
    expect(basisVintageFloor(2000, ratified)).toBeCloseTo(0.625, 4); // linear midpoint, not a cliff
    expect(basisVintageFloor(2005, ratified)).toBeCloseTo(0.6, 4);
    expect(basisVintageFloor(2020, ratified)).toBeCloseTo(0.6, 4);
    // Unknown vintage must get the STRICT floor, never the loose one.
    expect(basisVintageFloor(null, ratified)).toBeCloseTo(0.65, 4);
    expect(basisVintageFloor(null, ratified)).toBeGreaterThan(basisVintageFloor(2005, ratified));
  });
});

describe('confirmatory refute fixes — RCT fail-closed', () => {
  it('ratified ruleset but NO RCT supplied cannot reach a live PURSUE (Basis indeterminate)', () => {
    const s = scoreAcquisition(strongDeal(), ratified, { now: NOW }); // no opts.rct
    expect(s.verdict).not.toBe('PURSUE');
    expect(s.floors.find((f) => f.id === 'basis')?.actual).toBeNull();
    expect(s.dataQuality.some((d) => d.field === 'replacementCost')).toBe(true);
  });
  it('an unratified (proposed) RCT cannot drive a live verdict — advisoryOnly + no PURSUE', () => {
    const proposedRct = ReplacementCostTable.parse({ ...rctJson, ratification: 'proposed' });
    const s = scoreAcquisition(strongDeal(), ratified, { now: NOW, rct: proposedRct });
    expect(s.advisoryOnly).toBe(true);
    expect(s.verdict).not.toBe('PURSUE');
  });
  it('non-positive all-in basis is indeterminate, not a free 100% discount', () => {
    const s = score(strongDeal({ allInBasis: 0 }));
    expect(s.floors.find((f) => f.id === 'basis')?.actual).toBeNull();
    expect(s.verdict).not.toBe('PURSUE');
  });
  it('flags the reverse door contradiction (count > 0 but presence flag false)', () => {
    const s = score(strongDeal({ dockCount: 5, driveInCount: 5, hasDock: false, hasDriveIn: false }));
    expect(s.dataQuality.some((d) => d.field === 'doors')).toBe(true);
  });
});

describe('confirmatory refute fixes — RCT v03 refute pass (2026-07-14, 2/3 sonnet lenses)', () => {
  // Sonnet-5 adversarial pass on PR #210 found: (1) basisFullCreditDiscount (0.55) sat BELOW the
  // recalibrated vintage floors (0.60/0.65), so the divide-by-zero guard in cat1's formula clamped
  // its denominator to ~0, collapsing the graduated 25-pt Basis ramp into a step function — any deal
  // that cleared the floor at all scored the FULL 25 points, identically, whether by 0.1pt or 30pts.
  // (2) The engine's floor/score divisor defaulted to `input.replacementCostBand ?? 'mid'` (POINT),
  // contradicting every doc comment's claim that the Basis floor divides by LOW, and contradicting
  // the new client-side DealDrawer badge — the same deal could show 'Fails basis floor' on the card
  // while the real engine verdict said it clears. Both fixed; these tests are the regression guard.

  it('Cat 1 Basis is a GRADUATED RAMP, not a step function: a marginal-clear deal scores less than an exceptional one', () => {
    // Columbus OH, built 2005 (floor=0.60, RCT low=$229.65/SF). Discount just above the floor vs. deep.
    const marginal = score(strongDeal({ market: 'Columbus OH', totalSf: 60_000, maxBuildingSf: 42_000, allInBasis: 5_600_000 })); // ~59.4% discount off point... use low-based calc below
    const exceptional = score(strongDeal({ market: 'Columbus OH', totalSf: 60_000, maxBuildingSf: 42_000, allInBasis: 1_500_000 }));
    const basisMarginal = marginal.subScores.find((x) => x.id === 'basis')!.points;
    const basisExceptional = exceptional.subScores.find((x) => x.id === 'basis')!.points;
    // The exceptional deal must score STRICTLY more Basis points — a step function would tie them.
    expect(basisExceptional).toBeGreaterThan(basisMarginal);
    // And a deal exactly at the floor earns 0 of Cat 1's 25 Basis points, not the full 25 (the
    // step-function symptom). subScore id 'basis' AGGREGATES Cat 1 (Basis, 25pts) + Cat 2 (Yield,
    // 20pts) — isolate Cat 1's swing as a DIFFERENCE against `exceptional` above, since both share
    // STRONG_BASE's stabilizedYoc (0.12) unchanged, so Cat 2's contribution cancels out.
    const atFloor = score(strongDeal({ market: 'Columbus OH', totalSf: 60_000, maxBuildingSf: 42_000, allInBasis: 229.65 * 60_000 * 0.40 })); // exactly the 60% floor
    const cat1Swing = exceptional.subScores.find((x) => x.id === 'basis')!.points - atFloor.subScores.find((x) => x.id === 'basis')!.points;
    // exceptional's 89.1% discount doesn't quite clear the 90% full-credit threshold (~24.3/25), so
    // this isn't exactly 25 — the point is that it's LARGE, proving graduation, not a step function
    // (under the bug, atFloor and exceptional would both have scored identically at the cap).
    expect(cat1Swing).toBeGreaterThan(20);
  });

  it('assertProductionRuleset fails closed if basisFullCreditDiscount is ever left below a vintage floor again', () => {
    const broken = structuredClone(ratifiedJson);
    broken.scoring.basisFullCreditDiscount = 0.55; // the exact stale value the refute pass caught
    expect(() => assertProductionRuleset(parseRuleset(broken))).toThrow(/basisFullCreditDiscount/);
  });

  it('the Basis floor/score divisor is HARDCODED to RCT low — replacementCostBand no longer has any effect', () => {
    const withoutBand = score(strongDeal({ market: 'Columbus OH' }));
    const withMidBand = score(strongDeal({ market: 'Columbus OH', replacementCostBand: 'mid' }));
    const withHighBand = score(strongDeal({ market: 'Columbus OH', replacementCostBand: 'high' }));
    // All three must be IDENTICAL — the dormant field must not silently change the verdict.
    expect(withoutBand.floors.find((f) => f.id === 'basis')?.actual).toBeCloseTo(withMidBand.floors.find((f) => f.id === 'basis')?.actual ?? NaN, 10);
    expect(withoutBand.floors.find((f) => f.id === 'basis')?.actual).toBeCloseTo(withHighBand.floors.find((f) => f.id === 'basis')?.actual ?? NaN, 10);
  });

  it('cross-surface consistency: the client DealDrawer badge and the server verdict agree on clears/fails for the same deal', () => {
    // This is the exact contradiction the correctness lens found: client used `low`, server defaulted
    // to `mid`/`point`. Both now use `low` — assert they compute the SAME floorPsf and the SAME verdict.
    const market = 'Columbus OH' as const;
    const yearBuilt = 2005;
    const sf = 60_000;
    const clientRow = RCT_V03[market]!;
    const clientFloorPsf = clientRow.low * (1 - vintageFloor(yearBuilt)!);
    // Server: replicate its resolved floor via the ratified RCT + ruleset (same market/vintage).
    const serverFloorDiscount = basisVintageFloor(yearBuilt, ratified);
    const serverRow = RCT.markets[market]!;
    const serverFloorPsf = serverRow.low * (1 - serverFloorDiscount);
    expect(clientFloorPsf).toBeCloseTo(serverFloorPsf, 6);
    // And a live deal at $95/SF: both surfaces must agree it CLEARS (basis just under $102.06 the
    // pre-fix server default would have produced, but comfortably under the now-shared $91.86 floor
    // is the wrong test — use a value between the two historically-disagreeing thresholds to prove
    // they no longer disagree: $95/SF fails against the old client-only floor ($91.86) but the server
    // (post-fix) must now ALSO fail it, not silently pass via a looser `mid` divisor.
    const basisPsf = 95;
    const allInBasis = (basisPsf * sf) / 1.02;
    const s = score(strongDeal({ market, yearBuilt, totalSf: sf, maxBuildingSf: 42_000, allInBasis }));
    const serverClears = s.floors.find((f) => f.id === 'basis')?.passed;
    const clientClears = basisPsf <= clientFloorPsf;
    expect(serverClears).toBe(clientClears);
    expect(serverClears).toBe(false); // $95/SF vs a ~$91.86 floor — fails on BOTH surfaces now
  });
});

describe('isFresh — comp staleness (H7)', () => {
  const WITH_ADJ = { marketFundamentalsAdj: 1, marketFundamentalsConfidence: 'estimated' } as const;

  it('null compSourcedAt zeroes marketFundamentalsAdj and fires the data-quality flag', () => {
    const s = score(strongDeal({ ...WITH_ADJ, compSourcedAt: null }));
    expect(s.dataQuality.some((d) => d.field === 'marketFundamentalsAdj')).toBe(true);
  });

  it('null asAtUtc zeroes marketFundamentalsAdj and fires the data-quality flag', () => {
    const s = score(strongDeal({ ...WITH_ADJ, asAtUtc: null }));
    expect(s.dataQuality.some((d) => d.field === 'marketFundamentalsAdj')).toBe(true);
  });

  it('future-dated comp (sourced AFTER asAtUtc) is NOT fresh — fails closed, zeroes ± and fires the flag', () => {
    // NOW = '2026-06-13T00:00:00Z'; a comp "sourced" 2 days later cannot be verified at that as-at.
    const future = score(strongDeal({ ...WITH_ADJ, compSourcedAt: '2026-06-15T00:00:00Z', asAtUtc: NOW }));
    const fresh = score(strongDeal({ ...WITH_ADJ, compSourcedAt: NOW, asAtUtc: NOW }));
    expect(future.dataQuality.some((d) => d.field === 'marketFundamentalsAdj')).toBe(true);
    expect(fresh.dataQuality.some((d) => d.field === 'marketFundamentalsAdj')).toBe(false);
    // (No composite comparison: strongDeal already sits at the Cat 4 cap, so the ± is clamped out either way.)
  });

  it('a date-only asAtUtc compares as end-of-day: a same-day time-stamped comp stays fresh, next-day is not', () => {
    const sameDay = score(strongDeal({ ...WITH_ADJ, compSourcedAt: '2026-06-13T15:30:00Z', asAtUtc: '2026-06-13' }));
    const nextDay = score(strongDeal({ ...WITH_ADJ, compSourcedAt: '2026-06-14T00:00:01Z', asAtUtc: '2026-06-13' }));
    expect(sameDay.dataQuality.some((d) => d.field === 'marketFundamentalsAdj')).toBe(false);
    expect(nextDay.dataQuality.some((d) => d.field === 'marketFundamentalsAdj')).toBe(true);
  });

  it('stale comp (100 days > 90-day window) fires marketFundamentalsAdj flag', () => {
    // NOW = '2026-06-13T00:00:00Z'; '2026-03-05T00:00:00Z' is 100 days prior → outside 90-day window
    const s = score(strongDeal({ ...WITH_ADJ, compSourcedAt: '2026-03-05T00:00:00Z', asAtUtc: NOW }));
    expect(s.dataQuality.some((d) => d.field === 'marketFundamentalsAdj')).toBe(true);
  });
});

describe('WALT decay band (M8)', () => {
  it('waltYears=3 (2 < w ≤ 4 decay band) scores strictly between sweet-spot (1.5yr) and beyond-decay (5yr)', () => {
    const sweet = score(strongDeal({ waltYears: 1.5 })); // factor 1.0
    const decay = score(strongDeal({ waltYears: 3.0 })); // factor 0.5 — mid-decay band
    const beyond = score(strongDeal({ waltYears: 5.0 })); // factor 0.0 — past decay threshold
    expect(decay.composite).toBeLessThan(sweet.composite);
    expect(decay.composite).toBeGreaterThan(beyond.composite);
  });
});

// Audit 2026-11-08 satellite-null-drive-kills. A satellite deal whose drive time to the cluster was UNKNOWN failed the
// market gate (`dm === null` was treated like "over the max"), so a fact nobody had looked up KILLED the deal. Same rule
// as every other gate: unknown never KILLs, it caps at T2 via gateIndeterminate. The ratified max drive is unchanged.
describe('market gate: satellite with an unknown drive time caps at T2 (audit 2026-11-08)', () => {
  const market = (s: ReturnType<typeof score>) => s.gates.find((g) => g.id === 'market')!;
  const max = ratified.gates.satelliteMaxDriveMinutes;

  it('satellite + null drive: not KILLED, market gate passes unconfirmed, verdict capped at T2, flagged', () => {
    const s = score(strongDeal({ clusterTier: 'satellite', driveMinutesToCluster: null }));
    expect(s.verdict).not.toBe('KILLED');
    expect(s.verdict).toBe('WATCH');
    expect(s.tier).toBe('T2');
    expect(s.cappedAtT2).toBe(true);
    expect(market(s).passed).toBe(true);
    expect(market(s).detail).toMatch(/unknown/);
    expect(s.dataQuality.some((d) => d.field === 'driveMinutesToCluster')).toBe(true);
    expect(s.confidence).not.toBe('confirmed');
    expect(s.reasons.join(' ')).toMatch(/Stage-0 gate input is unconfirmed/);
  });

  it('satellite + drive above the ratified max still KILLS; at the max it passes determinately', () => {
    expect(score(strongDeal({ clusterTier: 'satellite', driveMinutesToCluster: max + 1 })).verdict).toBe('KILLED');
    const atMax = score(strongDeal({ clusterTier: 'satellite', driveMinutesToCluster: max }));
    expect(atMax.verdict).not.toBe('KILLED');
    expect(market(atMax).passed).toBe(true);
    expect(atMax.dataQuality.some((d) => d.field === 'driveMinutesToCluster')).toBe(false);
  });

  it('a null drive on a NON-satellite tier is irrelevant (no flag, no cap from it)', () => {
    const s = score(strongDeal({ clusterTier: 'owned-submarket', driveMinutesToCluster: null }));
    expect(s.verdict).toBe('PURSUE');
    expect(s.dataQuality.some((d) => d.field === 'driveMinutesToCluster')).toBe(false);
  });

  it('a null drive never rescues a deal another gate KILLS', () => {
    const s = score(strongDeal({ clusterTier: 'satellite', driveMinutesToCluster: null, sfhaOnPad: true }));
    expect(s.verdict).toBe('KILLED');
  });
});
