// src/modules/intel/capex-irr.ts
//
// Pure IRR / NPV math for the CapexIrrCalc panel.
//
// IRR definition: the discount rate r such that
//   NPV = -capex + Σ(t=1..n)[ annualNOIUplift / (1+r)^t ] = 0
//
// Assumes:
//   - Uniform annual NOI uplift (no growth, no terminal value — conservative for capex ROI)
//   - Single upfront capex outlay at t=0
//   - Whole years only — holdYears must be a positive integer, no partial years
//
// Numerical method: bisection (guaranteed convergence on a bounded monotonic function).
//   Upper bound: r = 10 (1000%; NPV ≈ −capex for any finite positive cash flow)
//   Lower bound: r = 0 UNLESS the undiscounted total (uplift*n) already fails to cover capex, in
//     which case the true IRR is negative — the bracket widens to r = -0.99 so bisection finds
//     the REAL negative rate instead of silently floor-clamping to a misleading ~0% (refute-pass
//     finding: a capex=100k/uplift=10k/hold=5 project — true IRR ≈ -26% — previously displayed
//     as "0.0%", i.e. "roughly break-even" for a project that destroys half the capital).
//   Convergence: |hi−lo| < 1e-8 OR 100 iterations. NOT formally residual-checked (see caller —
//     the near-r=-1 region can leave a small residual on pathological inputs); the root property
//     is asserted directly in tests instead of promised unconditionally here.
//
// CAPITAL_CONFIG.capexIrr (15%) is a SEPARATE governed constant (capex-approval yield-on-cost
// floor) from the general hurdleRatePct (8%) the live capital-allocation engine's own improve-gate
// compares against — CapexIrrCalc.tsx reads hurdleRatePct so this tool never contradicts the
// platform's own verdict for the same property. Neither is hardcoded here.

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
  // flows. At r=0: NPV = uplift*n − capex. A negative NPV(0) means the true IRR is below 0% —
  // widen the lower bound so the root is actually bracketed instead of floor-clamped.
  let lo = npvAtRate(capex, annualNOIUplift, holdYears, 0) <= 0 ? -0.99 : 0;
  let hi = 10;

  for (let i = 0; i < 100; i++) {
    const mid = (lo + hi) / 2;
    if (npvAtRate(capex, annualNOIUplift, holdYears, mid) > 0) {
      lo = mid;
    } else {
      hi = mid;
    }
    if (hi - lo < 1e-8) break;
  }

  return (lo + hi) / 2;
}
