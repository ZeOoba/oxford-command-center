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
import {
  applyGovernorProxy,
  SCREENING_DEBT_CONSTANT,
} from '../../server/warehouse/acq-governor-proxy';

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

  it('is indeterminate (null, no demotion) when stabilizedYoc is undefined', () => {
    const out = applyGovernorProxy({ verdict: 'WATCH' }, { stabilizedYoc: undefined }, GOV);
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
