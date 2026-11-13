// tests/unit/acq-governor-proxy.test.ts
//
// Unit tests for the SHARED governor-proxy demotion (server/warehouse/acq-governor-proxy.ts).
// This is the single source of truth applied by BOTH the ranked-candidate persistence path
// (acq-engine.persistAndLogScore) AND the ad-hoc score surfaces (POST /acquisition/score + the
// edge Pages Function) — so all three agree on what the governors do to a verdict.
//
// FINANCIAL-DECISION CODE — changes require an adversarial refute pass (CLAUDE.md §EOS).
//
// Behaviour pinned here:
//   - DSCR floor (SKILL.md v4.45 STAGE 1; since 2026-11-12 replaces the stabilizedYoc ÷ (0.40 × 0.085) proxy):
//     DSCR at a 65%-LTV loan on stabilized value, at UST + 200 bps, 25-yr monthly amortization = exitCap ÷ (0.65 × k);
//     clears iff ≥ dscrFloor. Unknown exit cap or UST ⇒ indeterminate (null, no demotion).
//   - LTV proxy:  INDETERMINATE at acquisition-screen time (always null → never demotes). There is
//     no loan amount in AcquisitionInput, so a true LTV is not computable here; the ≤40% LTV ceiling
//     is a FINANCING-stage governor enforced at capital allocation (capital_config DB CHECK), not at
//     OM-screen time. This corrects the prior `allInBasis/price ≤ ltvCeiling` formula, which demoted
//     EVERY fully-specified deal to PASS (basis ≥ price ⇒ ratio ~1.0 > 0.40).
//   - Demotion never upgrades KILLED (a hard gate/floor rejection) → PASS.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  applyGovernorProxy,
  applyGovernorProxyToScore,
  dscrAtRefiLtv,
  governorFingerprint,
  refiDebtConstant,
} from '../../server/warehouse/acq-governor-proxy';
import { parseRuleset, loadRatifiedRct, scoreAcquisition } from '../../server/warehouse/acquisition';
import { AcquisitionInput } from '../../src/contracts/acquisition';
import { RATIFIED_GOVERNORS } from '../../src/contracts/governor-constants';
import { ALERT_THRESHOLDS } from '../../src/analytics/conditions';

const GOV = { dscrFloor: 1.25, ltvCeiling: 0.40 };
const UST = 0.043; // 4.30%: refi rate 6.30%
/** The exit cap at which DSCR at a 65%-LTV loan equals the floor exactly: 0.65 × 1.25 × k(UST + 2%). */
const thresholdCap = (ust: number) => 0.65 * 1.25 * refiDebtConstant(ust + 0.02);
const CLEAR = { exitCapPct: 0.075, ust10yr: UST };  // Columbus-style 7.50% exit cap clears at a 4.30% UST
const FAIL = { exitCapPct: 0.055, ust10yr: UST };   // a 5.50% exit cap does not

describe('refi debt constant and the DSCR-at-65%-LTV floor (SKILL.md v4.37 / v4.44 / v4.45)', () => {
  it('k is the 25-yr monthly-amortizing constant: SKILL.md\'s own check, ~8.6% at a 5.2% UST (7.2% rate)', () => {
    expect(refiDebtConstant(0.072)).toBeCloseTo(0.08635, 4);
    expect(refiDebtConstant(0.072, 25)).toBe(refiDebtConstant(0.072));
    expect(refiDebtConstant(0)).toBeCloseTo(1 / 25, 12);
  });

  it('threshold exit cap = 0.65 × 1.25 × k: ~7.0% at a 5.2% UST (SKILL.md v4.37), and the audit\'s table', () => {
    expect(thresholdCap(0.052)).toBeCloseTo(0.0702, 3);
    expect(thresholdCap(0.040)).toBeCloseTo(0.0628, 3);
    expect(thresholdCap(0.043)).toBeCloseTo(0.0646, 3);
    expect(thresholdCap(0.046)).toBeCloseTo(0.0664, 3);
  });

  it('DSCR = exitCap ÷ (0.65 × k), NOI-independent, sized at the ratified per-property ceiling', () => {
    expect(RATIFIED_GOVERNORS.perPropertyLtvCeiling).toBe(0.65);
    // One literal: the per-property refi alert threshold (and debt-maturity) read the same constant.
    expect(ALERT_THRESHOLDS.refiLtvCeilingPerProperty).toBe(RATIFIED_GOVERNORS.perPropertyLtvCeiling);
    expect(dscrAtRefiLtv(0.075, UST)).toBeCloseTo(0.075 / (0.65 * refiDebtConstant(UST + 0.02)), 12);
    // A fully explicit NOI walk gives the same number: NOI 500k, value = NOI / cap, loan = 65% of value.
    const noi = 500_000;
    const loan = 0.65 * (noi / 0.075);
    expect(noi / (loan * refiDebtConstant(UST + 0.02))).toBeCloseTo(dscrAtRefiLtv(0.075, UST)!, 10);
  });

  it('unknown or out-of-domain exit cap / UST is a data gap (null), never a guess', () => {
    for (const [cap, ust] of [[null, UST], [0.075, null], [undefined, UST], [0, UST], [-0.07, UST], [Number.NaN, UST], [0.075, -0.01]] as const) {
      expect(dscrAtRefiLtv(cap as number | null, ust as number | null), `${cap} ${ust}`).toBeNull();
    }
  });
});

describe('applyGovernorProxy — DSCR floor', () => {
  it('clears a market-cap deal (no demotion); verdict preserved', () => {
    const out = applyGovernorProxy({ verdict: 'PURSUE' }, CLEAR, GOV);
    expect(out.governorDscrCleared).toBe(true);
    expect(out.verdict).toBe('PURSUE');
    expect(out.dscrAtRefiLtv).toBeCloseTo(0.075 / (0.65 * refiDebtConstant(0.063)), 12);
  });

  it('demotes to PASS when the exit cap is below 0.65 × 1.25 × k (DSCR binds; Ruling 5 deferred)', () => {
    const out = applyGovernorProxy({ verdict: 'PURSUE' }, FAIL, GOV);
    expect(out.governorDscrCleared).toBe(false);
    expect(out.verdict).toBe('PASS');
  });

  it('is indeterminate (null, no demotion) when the exit cap or the UST is unknown', () => {
    for (const input of [{ exitCapPct: null, ust10yr: UST }, { exitCapPct: 0.075, ust10yr: null }]) {
      const out = applyGovernorProxy({ verdict: 'WATCH' }, input, GOV);
      expect(out.governorDscrCleared).toBeNull();
      expect(out.verdict).toBe('WATCH');
    }
  });

  it('the exact threshold exit cap clears (≥, compared at 1e-8 floor precision)', () => {
    const at = applyGovernorProxy({ verdict: 'PURSUE' }, { exitCapPct: thresholdCap(UST), ust10yr: UST }, GOV);
    expect(at.governorDscrCleared).toBe(true);
    const below = applyGovernorProxy({ verdict: 'PURSUE' }, { exitCapPct: thresholdCap(UST) - 1e-6, ust10yr: UST }, GOV);
    expect(below.governorDscrCleared).toBe(false);
  });

  it('a higher UST raises the bar: the same 6.6% cap clears at 4.0% and fails at 5.2%', () => {
    expect(applyGovernorProxy({ verdict: 'PURSUE' }, { exitCapPct: 0.066, ust10yr: 0.040 }, GOV).governorDscrCleared).toBe(true);
    expect(applyGovernorProxy({ verdict: 'PURSUE' }, { exitCapPct: 0.066, ust10yr: 0.052 }, GOV).governorDscrCleared).toBe(false);
  });

  it('reads the live dscrFloor (a raised floor raises the threshold)', () => {
    expect(applyGovernorProxy({ verdict: 'PURSUE' }, CLEAR, { ...GOV, dscrFloor: 1.6 }).governorDscrCleared).toBe(false);
  });

  it('the governor fingerprint carries the refi terms, not the retired 0.085 constant (re-keys every candidate once)', () => {
    expect(governorFingerprint({ version: 1, dscrFloor: 1.25, ltvCeiling: 0.4 })).toBe('1:1.25:0.4:refi0.65/ust+0.02/25y');
  });
});

describe('applyGovernorProxy — invalid governors FAIL CLOSED (audit 2026-09-25, approved 2026-09-26)', () => {
  it('ltvCeiling = 0 demotes to PASS (previously Infinity cleared every deal)', () => {
    const out = applyGovernorProxy({ verdict: 'PURSUE' }, CLEAR, { dscrFloor: 1.25, ltvCeiling: 0 });
    expect(out.governorDscrCleared).toBe(false);
    expect(out.verdict).toBe('PASS');
  });
  it.each([
    ['negative ltvCeiling', { dscrFloor: 1.25, ltvCeiling: -0.4 }],
    ['NaN ltvCeiling', { dscrFloor: 1.25, ltvCeiling: Number.NaN }],
    ['zero dscrFloor', { dscrFloor: 0, ltvCeiling: 0.4 }],
    ['Infinity dscrFloor', { dscrFloor: Number.POSITIVE_INFINITY, ltvCeiling: 0.4 }],
  ])('%s demotes to PASS even for a clearing exit cap', (_label, gov) => {
    const out = applyGovernorProxy({ verdict: 'PURSUE' }, CLEAR, gov);
    expect(out.governorDscrCleared).toBe(false);
    expect(out.verdict).toBe('PASS');
  });
  it('invalid governors demote even when the DSCR inputs are null (not "indeterminate" — a system condition)', () => {
    const out = applyGovernorProxy({ verdict: 'WATCH' }, { exitCapPct: null, ust10yr: null }, { dscrFloor: 1.25, ltvCeiling: 0 });
    expect(out.governorDscrCleared).toBe(false);
    expect(out.verdict).toBe('PASS');
  });
  it('still never upgrades KILLED', () => {
    const out = applyGovernorProxy({ verdict: 'KILLED' }, CLEAR, { dscrFloor: 1.25, ltvCeiling: 0 });
    expect(out.verdict).toBe('KILLED');
  });
});

describe('applyGovernorProxy — LTV proxy is indeterminate at screen time', () => {
  it('returns governorLtvCleared = null and never demotes on LTV', () => {
    // A deal that the OLD bogus proxy (allInBasis/price ≤ 0.40) would have demoted: basis ≥ price.
    // With a clearing DSCR, it must NOT be demoted now — LTV is indeterminate.
    const out = applyGovernorProxy({ verdict: 'PURSUE' }, CLEAR, GOV);
    expect(out.governorLtvCleared).toBeNull();
    expect(out.verdict).toBe('PURSUE'); // NOT demoted to PASS — the live defect is fixed
  });
});

describe('applyGovernorProxy — KILLED monotonicity', () => {
  it('never upgrades KILLED to PASS even when a governor fails', () => {
    const out = applyGovernorProxy({ verdict: 'KILLED' }, FAIL, GOV);
    expect(out.governorDscrCleared).toBe(false);
    expect(out.verdict).toBe('KILLED');
  });

  it('leaves PASS as PASS (no spurious change)', () => {
    const out = applyGovernorProxy({ verdict: 'PASS' }, CLEAR, GOV);
    expect(out.verdict).toBe('PASS');
  });
});

// Audit 2026-10-13 G1: applyGovernorProxy demotes ONLY `verdict`, so every surface that spread
// `{ ...score, verdict }` emitted tier T1/T2 next to a governor-demoted PASS verdict, and tier-keyed
// readers (the capital BUY gate) treated the demoted deal as buyable. applyGovernorProxyToScore is
// the score-level wrapper every surface uses so tier and verdict can never diverge.
describe('applyGovernorProxyToScore — tier follows the governor-demoted verdict (audit 2026-10-13 G1)', () => {
  const RULESET = parseRuleset(JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')));
  const RCT = loadRatifiedRct();
  const STRONG = AcquisitionInput.parse({
    dealId: 'proxy-strong',
    price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
    productType: 'shallow-bay-multi', officePct: 0.1,
    clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6,
    multiStory: false, truckCourtFt: 120,
    constructionType: 'tilt-precast', yearBuilt: 2005, sfhaOnPad: false,
    groundLeased: false, envRemediationPctOfPrice: 0, use: { automotive: false, childRelated: false, childSafetyReviewed: false }, // other-use gate confirmed (audit 2026-11-08)
    allInBasis: 3_600_000, stabilizedYoc: 0.12, leveredIrr: 0.18, unleveredIrr10yr: 0.12, underwriteHorizonYrs: 5,
    exitCapPct: 0.075, ust10yr: 0.043, ustAsOf: '2026-11-10',
    clusterTier: 'owned-submarket', sellerMotivationScore: 0.8,
    isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5, valueAddScore: 0.5,
    ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
  });
  const raw = scoreAcquisition(STRONG, RULESET, { rct: RCT });

  it('precondition: the strong deal scores T1 PURSUE before any governor', () => {
    expect(raw.tier).toBe('T1');
    expect(raw.verdict).toBe('PURSUE');
  });

  it('an INVALID governor set (fail-closed demotion) demotes BOTH verdict and tier to PASS', () => {
    const out = applyGovernorProxyToScore(raw, STRONG, { dscrFloor: 1.25, ltvCeiling: 0 });
    expect(out.score.verdict).toBe('PASS');
    expect(out.score.tier).toBe('PASS');
    expect(out.governorDscrCleared).toBe(false);
  });

  it('a DSCR-floor failure demotes tier with the verdict, and says why', () => {
    const weak = { ...STRONG, exitCapPct: 0.055 };
    // Feed the T1 PURSUE score with a failing exit cap so the governor test (not the engine) is what demotes.
    const out = applyGovernorProxyToScore(raw, weak, GOV);
    expect(out.score.verdict).toBe('PASS');
    expect(out.score.tier).toBe('PASS');
    expect(out.score.reasons.at(-1)).toMatch(/DSCR 1\.063x at a 65%-LTV refi \(UST \+ 200 bps, 25-yr\) is below the 1\.25x floor/);
  });

  it('cleared governors leave the score untouched (no value drift: composite/tier/verdict identical)', () => {
    const out = applyGovernorProxyToScore(raw, STRONG, GOV);
    expect(out.score).toEqual(raw);
    expect(out.governorDscrCleared).toBe(true);
  });

  it('an indeterminate DSCR floor is disclosed as a governor open item, naming what is missing (refute wf_0a80ea57-515)', () => {
    const noCap = applyGovernorProxyToScore(raw, { ...STRONG, exitCapPct: null }, GOV);
    expect(noCap.governorDscrCleared).toBeNull();
    expect(noCap.score.verdict).toBe(raw.verdict); // not demoted
    expect(noCap.score.reasons.at(-1)).toBe('Governor open item: DSCR floor indeterminate (exit cap unknown) — not BUY-eligible until entered');
    const neither = applyGovernorProxyToScore(raw, { ...STRONG, exitCapPct: null, ust10yr: null }, GOV);
    expect(neither.score.reasons.at(-1)).toMatch(/\(exit cap and 10-yr UST unknown\)/);
    // a KILLED score is not annotated; an invalid governor set demotes and says so (not a DSCR number)
    const killed = { ...raw, tier: 'KILLED' as const, verdict: 'KILLED' as const };
    expect(applyGovernorProxyToScore(killed, { ...STRONG, exitCapPct: null }, GOV).score).toBe(killed);
    const invalid = applyGovernorProxyToScore(raw, STRONG, { dscrFloor: 1.25, ltvCeiling: 0 });
    expect(invalid.score.reasons.at(-1)).toMatch(/the live governor set is invalid\.$/);
  });

  it('the demotion reason never prints a DSCR equal to the floor (3 dp)', () => {
    const justUnder = { ...STRONG, exitCapPct: 0.65 * 1.25 * refiDebtConstant(0.063) * (1 - 2e-4) };
    const out = applyGovernorProxyToScore(raw, justUnder, GOV);
    expect(out.score.verdict).toBe('PASS');
    expect(out.score.reasons.at(-1)).toMatch(/DSCR 1\.249x at/);
  });

  it('never touches a KILLED score', () => {
    const killed = { ...raw, tier: 'KILLED' as const, verdict: 'KILLED' as const };
    const out = applyGovernorProxyToScore(killed, STRONG, { dscrFloor: 1.25, ltvCeiling: 0 });
    expect(out.score.tier).toBe('KILLED');
    expect(out.score.verdict).toBe('KILLED');
  });

  it('a demotion never changes the composite (scoring values are not altered)', () => {
    const out = applyGovernorProxyToScore(raw, STRONG, { dscrFloor: 1.25, ltvCeiling: 0 });
    expect(out.score.composite).toBe(raw.composite);
    expect(out.score.subScores).toEqual(raw.subScores);
    expect(out.score.floors).toEqual(raw.floors);
  });
});
