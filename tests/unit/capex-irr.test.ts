// tests/unit/capex-irr.test.ts
//
// TDD: tests written BEFORE the implementation.
// Financial math must hold to the stated precision before the panel ships.
//
// IRR definition: the discount rate r s.t.
//   NPV = -capex + Σ(t=1..n)[ uplift / (1+r)^t ] = 0
//
// All expected values verified independently (Node.js bisection cross-check).

import { describe, it, expect } from 'vitest';
import { computeCapexIrr, npvAtRate } from '../../src/modules/intel/capex-irr';

describe('computeCapexIrr', () => {
  // -------------------------------------------------------------------------
  // Case 1: capex=100k, uplift=20k, hold=10 → IRR ≈ 15.1% (just above 0.15 hurdle)
  // Cross-check: at r=0.1510, PV of 20k × 10-yr annuity ≈ 100k
  // -------------------------------------------------------------------------
  it('returns ~15.1% for capex=100k, uplift=20k, hold=10', () => {
    const irr = computeCapexIrr(100_000, 20_000, 10);
    expect(irr).toBeCloseTo(0.1510, 3); // ±0.05% tolerance (3 decimal places = 0.1%)
  });

  // -------------------------------------------------------------------------
  // Case 2: capex=100k, uplift=15k, hold=10 → IRR ≈ 8.1% (well below hurdle)
  // -------------------------------------------------------------------------
  it('returns ~8.1% for capex=100k, uplift=15k, hold=10', () => {
    const irr = computeCapexIrr(100_000, 15_000, 10);
    expect(irr).toBeCloseTo(0.0814, 3);
  });

  // -------------------------------------------------------------------------
  // Case 3: capex=100k, uplift=25k, hold=5 → IRR ≈ 7.9% (below hurdle even short hold)
  // -------------------------------------------------------------------------
  it('returns ~7.9% for capex=100k, uplift=25k, hold=5', () => {
    const irr = computeCapexIrr(100_000, 25_000, 5);
    expect(irr).toBeCloseTo(0.0793, 3);
  });

  // -------------------------------------------------------------------------
  // Case 4: capex=50k, uplift=20k, hold=5 → IRR ≈ 28.6% (well above hurdle)
  // -------------------------------------------------------------------------
  it('returns ~28.6% for capex=50k, uplift=20k, hold=5', () => {
    const irr = computeCapexIrr(50_000, 20_000, 5);
    expect(irr).toBeCloseTo(0.2865, 3);
  });

  // -------------------------------------------------------------------------
  // Case 5: uplift=0 → no positive return path → IRR = -Infinity
  // -------------------------------------------------------------------------
  it('returns -Infinity when annualNOIUplift=0', () => {
    const irr = computeCapexIrr(100_000, 0, 10);
    expect(irr).toBe(-Infinity);
  });

  // -------------------------------------------------------------------------
  // Case 5b: uplift<0 → also -Infinity
  // -------------------------------------------------------------------------
  it('returns -Infinity when annualNOIUplift is negative', () => {
    const irr = computeCapexIrr(100_000, -5_000, 10);
    expect(irr).toBe(-Infinity);
  });

  // -------------------------------------------------------------------------
  // Case 6: capex=100k, uplift=100k, hold=1 → IRR = 0%
  // NPV = 100000/(1+r) - 100000 = 0 → r = 0
  // -------------------------------------------------------------------------
  it('returns 0% for capex=100k, uplift=100k, hold=1 (break-even in year 1)', () => {
    const irr = computeCapexIrr(100_000, 100_000, 1);
    expect(irr).toBeCloseTo(0.0, 3);
  });

  // -------------------------------------------------------------------------
  // Edge case: capex <= 0 → NaN (no investment, no meaningful IRR)
  // -------------------------------------------------------------------------
  it('returns NaN when capex=0', () => {
    const irr = computeCapexIrr(0, 20_000, 10);
    expect(Number.isNaN(irr)).toBe(true);
  });

  it('returns NaN when capex is negative', () => {
    const irr = computeCapexIrr(-1, 20_000, 10);
    expect(Number.isNaN(irr)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Edge case: hold <= 0 → NaN
  // -------------------------------------------------------------------------
  it('returns NaN when holdYears=0', () => {
    const irr = computeCapexIrr(100_000, 20_000, 0);
    expect(Number.isNaN(irr)).toBe(true);
  });

  it('returns NaN when holdYears is negative', () => {
    const irr = computeCapexIrr(100_000, 20_000, -1);
    expect(Number.isNaN(irr)).toBe(true);
  });

  // -------------------------------------------------------------------------
  // Refute-pass finding: a true NEGATIVE IRR (undiscounted cash < capex) previously collapsed to
  // the bisection's r=0 lower bound (~0%), silently reporting "break-even" for a value-destroying
  // project. capex=100k, uplift=10k, hold=5: undiscounted total = 50k < 100k capex -> true IRR is
  // meaningfully negative, not ~0%. Cross-checked independently via Newton-Raphson refinement:
  // the root is -0.19401852 (a SECOND round of adversarial review caught an earlier version of
  // this comment claiming an uncross-checked "~-26%" -- a wrong number in a test's own commentary
  // is itself a defect in financial-decision code, however harmless the assertion below still is).
  // -------------------------------------------------------------------------
  it('reports a REAL negative IRR (not a ~0% floor) when undiscounted cash flow < capex', () => {
    const irr = computeCapexIrr(100_000, 10_000, 5);
    expect(irr).toBeCloseTo(-0.19401852, 6); // verified root, not an approximate bound
  });

  it('the negative-IRR root property still holds: NPV at the reported (negative) IRR is ~0', () => {
    const irr = computeCapexIrr(100_000, 10_000, 5);
    const nv = npvAtRate(100_000, 10_000, 5, irr);
    expect(Math.abs(nv)).toBeLessThan(0.01);
  });

  // -------------------------------------------------------------------------
  // Second refute round: the widened bracket's fixed -0.99 floor still left a five-figure NPV
  // residual for a CATASTROPHIC loss whose true IRR is below -99% (capex=100k, uplift=500,
  // hold=1 -> true IRR ~ -99.5%, outside [-0.99, 10]). The bracket now adaptively pushes the
  // lower bound closer to -1 (never reaching it) until the root is actually contained, so even
  // this case converges to a near-zero residual instead of clamping to a wrong answer.
  // -------------------------------------------------------------------------
  it('converges to the real rate (near-zero residual), not a clamped -99.0%, for a catastrophic loss below -99%', () => {
    const irr = computeCapexIrr(100_000, 500, 1);
    expect(irr).toBeLessThan(-0.99); // genuinely beyond the old fixed floor
    const nv = npvAtRate(100_000, 500, 1, irr);
    expect(Math.abs(nv)).toBeLessThan(0.01); // real convergence, not a residual-laden clamp
  });

  it('still returns 0 (not spuriously negative) for the true break-even case (uplift*n === capex)', () => {
    const irr = computeCapexIrr(100_000, 20_000, 5); // 20k*5 = 100k exactly
    expect(irr).toBeCloseTo(0, 3);
  });

  // -------------------------------------------------------------------------
  // Third refute round: the upper bound had the SAME defect class the lower bound was fixed for
  // in round 2 -- a fixed hi=10 (1000%) clamp silently truncates a true IRR above 1000%, leaving a
  // large positive NPV residual (a wrong answer) instead of reporting the real rate. capex=10,000,
  // uplift=200,000, hold=5 -> true IRR is far beyond 1000% (first-year cash flow alone is 20x
  // capex). The bracket now adaptively pushes the upper bound outward (never bounded) until the
  // root is actually contained, mirroring the lower-bound fix.
  // -------------------------------------------------------------------------
  it('converges to the real rate (near-zero residual), not a clamped 1000.0%, for an extreme-return project', () => {
    const irr = computeCapexIrr(10_000, 200_000, 5);
    expect(irr).toBeGreaterThan(10); // genuinely beyond the old fixed 1000% clamp
    const nv = npvAtRate(10_000, 200_000, 5, irr);
    expect(Math.abs(nv)).toBeLessThan(0.01); // real convergence, not a residual-laden clamp
  });

  // -------------------------------------------------------------------------
  // Refute-pass finding: computeCapexIrr's own guard only checked `uplift <= 0`, so
  // `NaN <= 0` (false) and `Infinity > 0` (passes) both slipped through as "valid" inputs and
  // produced finite-looking garbage, contradicting the function's own documented contract
  // ("returns NaN / -Infinity on invalid inputs").
  // -------------------------------------------------------------------------
  it('returns -Infinity (not finite garbage) when annualNOIUplift is NaN', () => {
    const irr = computeCapexIrr(100_000, NaN, 5);
    expect(irr).toBe(-Infinity);
  });

  it('returns -Infinity (not finite garbage) when annualNOIUplift is +Infinity', () => {
    const irr = computeCapexIrr(100_000, Infinity, 5);
    expect(irr).toBe(-Infinity);
  });

  // -------------------------------------------------------------------------
  // Refute-pass finding: the model's own doc comment states "No partial years" -- a fractional
  // holdYears was previously silently floored by the `for (t=1; t<=holdYears; t++)` loop instead
  // of being rejected, contradicting that stated assumption.
  // -------------------------------------------------------------------------
  it('returns NaN for a non-integer holdYears (model assumes whole years only)', () => {
    const irr = computeCapexIrr(100_000, 20_000, 5.5);
    expect(Number.isNaN(irr)).toBe(true);
  });
});

describe('npvAtRate', () => {
  // -------------------------------------------------------------------------
  // Case 7: NPV at the computed IRR must be ~0 (root property of IRR definition)
  // computeCapexIrr(100k, 20k, 10) ≈ 0.1510
  // npv(100000, 20000, 10, 0.1510) must be |< 1| (bisection converges to < 0.01)
  // -------------------------------------------------------------------------
  it('returns near-zero NPV at the computed IRR (root property)', () => {
    const irr = computeCapexIrr(100_000, 20_000, 10);
    const nv = npvAtRate(100_000, 20_000, 10, irr);
    expect(Math.abs(nv)).toBeLessThan(0.01);
  });

  // -------------------------------------------------------------------------
  // NPV at r=0 = sum of undiscounted cash flows minus capex
  // 20000 * 10 - 100000 = 100000
  // -------------------------------------------------------------------------
  it('returns total undiscounted net profit at r=0', () => {
    const nv = npvAtRate(100_000, 20_000, 10, 0);
    expect(nv).toBeCloseTo(100_000, 0);
  });

  // -------------------------------------------------------------------------
  // NPV at very high r → effectively -capex (cash flows discounted to near-zero)
  // -------------------------------------------------------------------------
  it('approaches -capex at very high discount rate', () => {
    const nv = npvAtRate(100_000, 20_000, 10, 10); // 1000% discount rate
    // Each cash flow ~ 20000 / (11^t) → sum ≈ 20000/11 + ... → ~1818 for t=1
    expect(nv).toBeLessThan(-90_000);
  });

  // -------------------------------------------------------------------------
  // NPV at r=0.15 for case 1 is slightly positive (IRR is 15.10%, above 15%)
  // -------------------------------------------------------------------------
  it('NPV at r=0.15 is slightly positive for case 1 (IRR > hurdle)', () => {
    const nv = npvAtRate(100_000, 20_000, 10, 0.15);
    expect(nv).toBeGreaterThan(0);
    expect(nv).toBeLessThan(1_000); // close to zero but positive
  });
});
