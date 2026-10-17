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
//   - DSCR proxy: stabilizedYoc / (ltvCeiling × SCREENING_DEBT_CONSTANT) ≥ dscrFloor.
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
  SCREENING_DEBT_CONSTANT,
} from '../../server/warehouse/acq-governor-proxy';
import { parseRuleset, loadRatifiedRct, scoreAcquisition } from '../../server/warehouse/acquisition';
import { AcquisitionInput } from '../../src/contracts/acquisition';

const GOV = { dscrFloor: 1.25, ltvCeiling: 0.40 };

// DSCR clears iff stabilizedYoc ≥ dscrFloor × ltvCeiling × SCREENING_DEBT_CONSTANT
//   = 1.25 × 0.40 × 0.085 = 0.0425 (4.25%).
const DSCR_THRESHOLD_YOC = GOV.dscrFloor * GOV.ltvCeiling * SCREENING_DEBT_CONSTANT;

describe('applyGovernorProxy — DSCR proxy', () => {
  it('clears a strong-yield deal (no demotion); verdict preserved', () => {
    const out = applyGovernorProxy({ verdict: 'PURSUE' }, { stabilizedYoc: 0.12 }, GOV);
    expect(out.governorDscrCleared).toBe(true);
    expect(out.verdict).toBe('PURSUE');
  });

  it('demotes a low-yield deal to PASS when DSCR proxy fails', () => {
    // 0.03 < 0.0425 threshold → DSCR fails.
    const out = applyGovernorProxy({ verdict: 'PURSUE' }, { stabilizedYoc: 0.03 }, GOV);
    expect(out.governorDscrCleared).toBe(false);
    expect(out.verdict).toBe('PASS');
  });

  it('is indeterminate (null, no demotion) when stabilizedYoc is null', () => {
    const out = applyGovernorProxy({ verdict: 'WATCH' }, { stabilizedYoc: null }, GOV);
    expect(out.governorDscrCleared).toBeNull();
    expect(out.verdict).toBe('WATCH');
  });

  it('stabilizedYoc = 0 is present-but-zero: DSCR fails (0/x < threshold) → PASS', () => {
    // 0 is neither null nor undefined — the proxy treats it as a computable 0% yield and
    // correctly fails the DSCR check. In the integrated system the engine KILLs a 0% YOC deal
    // first (yield floor), so this pins the module's isolated contract for forward safety.
    const out = applyGovernorProxy({ verdict: 'WATCH' }, { stabilizedYoc: 0 }, GOV);
    expect(out.governorDscrCleared).toBe(false);
    expect(out.verdict).toBe('PASS');
  });

  it('uses the exact 4.25% boundary (≥ clears)', () => {
    const out = applyGovernorProxy({ verdict: 'PURSUE' }, { stabilizedYoc: DSCR_THRESHOLD_YOC }, GOV);
    expect(out.governorDscrCleared).toBe(true);
    expect(out.verdict).toBe('PURSUE');
  });
});

describe('applyGovernorProxy — invalid governors FAIL CLOSED (audit 2026-09-25, approved 2026-09-26)', () => {
  it('ltvCeiling = 0 demotes to PASS (previously Infinity cleared every deal)', () => {
    const out = applyGovernorProxy({ verdict: 'PURSUE' }, { stabilizedYoc: 0.12 }, { dscrFloor: 1.25, ltvCeiling: 0 });
    expect(out.governorDscrCleared).toBe(false);
    expect(out.verdict).toBe('PASS');
  });
  it.each([
    ['negative ltvCeiling', { dscrFloor: 1.25, ltvCeiling: -0.4 }],
    ['NaN ltvCeiling', { dscrFloor: 1.25, ltvCeiling: Number.NaN }],
    ['zero dscrFloor', { dscrFloor: 0, ltvCeiling: 0.4 }],
    ['Infinity dscrFloor', { dscrFloor: Number.POSITIVE_INFINITY, ltvCeiling: 0.4 }],
  ])('%s demotes to PASS even for a strong-yield deal', (_label, gov) => {
    const out = applyGovernorProxy({ verdict: 'PURSUE' }, { stabilizedYoc: 0.5 }, gov);
    expect(out.governorDscrCleared).toBe(false);
    expect(out.verdict).toBe('PASS');
  });
  it('invalid governors demote even when stabilizedYoc is null (not "indeterminate" — a system condition)', () => {
    const out = applyGovernorProxy({ verdict: 'WATCH' }, { stabilizedYoc: null }, { dscrFloor: 1.25, ltvCeiling: 0 });
    expect(out.governorDscrCleared).toBe(false);
    expect(out.verdict).toBe('PASS');
  });
  it('still never upgrades KILLED', () => {
    const out = applyGovernorProxy({ verdict: 'KILLED' }, { stabilizedYoc: 0.5 }, { dscrFloor: 1.25, ltvCeiling: 0 });
    expect(out.verdict).toBe('KILLED');
  });
});

describe('applyGovernorProxy — LTV proxy is indeterminate at screen time', () => {
  it('returns governorLtvCleared = null and never demotes on LTV', () => {
    // A deal that the OLD bogus proxy (allInBasis/price ≤ 0.40) would have demoted: basis ≥ price.
    // With a clearing DSCR, it must NOT be demoted now — LTV is indeterminate.
    const out = applyGovernorProxy({ verdict: 'PURSUE' }, { stabilizedYoc: 0.12 }, GOV);
    expect(out.governorLtvCleared).toBeNull();
    expect(out.verdict).toBe('PURSUE'); // NOT demoted to PASS — the live defect is fixed
  });
});

describe('applyGovernorProxy — KILLED monotonicity', () => {
  it('never upgrades KILLED to PASS even when a governor fails', () => {
    const out = applyGovernorProxy({ verdict: 'KILLED' }, { stabilizedYoc: 0.01 }, GOV);
    expect(out.governorDscrCleared).toBe(false);
    expect(out.verdict).toBe('KILLED');
  });

  it('leaves PASS as PASS (no spurious change)', () => {
    const out = applyGovernorProxy({ verdict: 'PASS' }, { stabilizedYoc: 0.12 }, GOV);
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
    constructionType: 'block-tilt-brick', yearBuilt: 2005, sfhaOnPad: false,
    allInBasis: 3_600_000, stabilizedYoc: 0.12, leveredIrr: 0.18, underwriteHorizonYrs: 5,
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

  it('a DSCR-proxy failure demotes tier with the verdict', () => {
    const weak = { ...STRONG, stabilizedYoc: 0.03 };
    // Feed the T1 PURSUE score with a failing-YoC input so the proxy (not the engine) is what demotes.
    const out = applyGovernorProxyToScore(raw, weak, GOV);
    expect(out.score.verdict).toBe('PASS');
    expect(out.score.tier).toBe('PASS');
  });

  it('cleared governors leave the score untouched (no value drift: composite/tier/verdict identical)', () => {
    const out = applyGovernorProxyToScore(raw, STRONG, GOV);
    expect(out.score).toEqual(raw);
    expect(out.governorDscrCleared).toBe(true);
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
