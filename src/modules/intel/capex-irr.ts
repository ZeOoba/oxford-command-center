// src/modules/intel/capex-irr.ts
//
// Pure IRR / NPV math for the CapexIrrCalc panel.
//
// IRR definition: the discount rate r such that
//   NPV = -capex + Σ(t=1..n)[ annualNOIUplift / (1+r)^t ] = 0
//
// Assumes:
//   - Uniform annual NOI uplift (no growth, no terminal value, single t=0 outlay — conservative
//     and deliberately simple for a quick capex ROI read, not a full underwriting model)
//   - Whole years only — holdYears must be a positive integer, no partial years
//
// Numerical method: bisection. For uplift > 0 and r > -1, NPV is strictly monotone decreasing in
// r and NPV(r) -> +Infinity as r -> -1+, so a root always exists somewhere in (-1, 10) — the
// bracket's lower bound starts at -0.99 and adaptively pushes closer to -1 (never reaching it)
// until NPV(lo) > 0, so even a catastrophic-loss project converges to its REAL negative rate with
// a near-zero residual, rather than clamping to an arbitrary floor (refute-pass finding: a fixed
// -0.99 floor left a five-figure NPV residual — i.e. a wrong answer — for a severe enough loss).
// Convergence: |hi-lo| < 1e-9 OR 200 iterations; the root property (NPV ~ 0 at the returned rate)
// is asserted directly in tests for both the ordinary and catastrophic-loss regions.
//
// CAPITAL_CONFIG.capexIrr (15%) is a SEPARATE governed constant (capex-approval yield-on-cost
// floor) from the general hurdleRatePct (8%) the live capital-allocation engine's own improve-gate
// compares against — CapexIrrCalc.tsx reads hurdleRatePct and compares with the SAME strict `>`
// the engine uses, so the two can never disagree on the SAME metric. They remain conceptually
// different calculations (this is a full IRR on user-entered capex; the engine's capexIrr is a
// portfolio-level proxy estimate), so this only guarantees comparison-logic parity, not that the
// two numbers are ever literally equal.

/**
 * Discount a uniform annual cash flow stream and subtract the initial capex.
 *
 * NPV = Σ(t=1..n)[ annualNOIUplift / (1+r)^t ] − capex
 *
 * Exported so tests can verify the root property (NPV ≈ 0 at the computed IRR).
 */
export function npvAtRate(
  capex: number,
  annualNOIUplift: number,
  holdYears: number,
  r: number,
): number {
  let pv = 0;
  for (let t = 1; t <= holdYears; t++) {
    pv += annualNOIUplift / Math.pow(1 + r, t);
  }
  return pv - capex;
}

/**
 * Compute the unlevered IRR on a capex investment with uniform annual NOI uplift.
 *
 * Edge cases:
 *   capex ≤ 0 or non-finite            → NaN  (no investment to evaluate)
 *   holdYears ≤ 0, non-finite, or non-integer → NaN  (whole-year hold periods only)
 *   annualNOIUplift ≤ 0 or non-finite  → −Infinity  (no positive cash flow — destroy-value case)
 *
 * The bisection search is bounded [0, 10] (0% to 1000%) for a normally-profitable project, or
 * widened to [-0.99, 10] when the undiscounted total (uplift*holdYears) already fails to cover
 * capex — the true IRR is negative in that case, and bisection reports the REAL rate rather than
 * clamping to a misleading ~0%.
 *
 * @param capex            Initial capital outlay ($), must be > 0
 * @param annualNOIUplift  Projected annual incremental NOI ($), must be > 0
 * @param holdYears        Investment horizon (positive integer, 1–10 in the UI)
 * @returns                IRR as a decimal (0.15 = 15%), or NaN / −Infinity on invalid inputs
 */
export function computeCapexIrr(
  capex: number,
  annualNOIUplift: number,
  holdYears: number,
): number {
  // Guard: invalid inputs
  if (capex <= 0 || !Number.isFinite(capex)) return NaN;
  if (holdYears <= 0 || !Number.isFinite(holdYears) || !Number.isInteger(holdYears)) return NaN;

  // Guard: no positive return stream (NaN/Infinity fail !(x > 0) too, closing the contract gap
  // the plain `<= 0` check left open — NaN <= 0 is false, Infinity > 0 is true).
  if (!(annualNOIUplift > 0) || !Number.isFinite(annualNOIUplift)) return -Infinity;

  // Bisection search: NPV is strictly monotone decreasing in r (for r > -1) with positive cash
  // flows, and NPV(r) -> +Infinity as r -> -1+ — so a root ALWAYS exists somewhere in (-1, 10).
  // At r=0: NPV = uplift*n − capex. A negative NPV(0) means the true IRR is below 0% — widen the
  // lower bound, adaptively pushing closer to -1 (never reaching it) until the root is actually
  // bracketed, so even a catastrophic loss converges to its real rate instead of clamping to a
  // fixed floor with a large residual.
  let lo = 0;
  if (npvAtRate(capex, annualNOIUplift, holdYears, 0) <= 0) {
    lo = -0.99;
    for (let guard = 0; guard < 30 && npvAtRate(capex, annualNOIUplift, holdYears, lo) <= 0; guard++) {
      lo = -1 + (1 + lo) / 10; // shrinks the distance to -1 by 10x each attempt: -0.99, -0.999, ...
    }
  }
  let hi = 10;

  for (let i = 0; i < 200; i++) {
    const mid = (lo + hi) / 2;
    if (npvAtRate(capex, annualNOIUplift, holdYears, mid) > 0) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-9) break;
  }

  return (lo + hi) / 2;
}
