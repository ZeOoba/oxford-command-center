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
//   - No partial years
//
// Numerical method: bisection (guaranteed convergence on a bounded monotonic function).
//   Lower bound: r = 0  (NPV = uplift*n − capex; positive when profitable at zero cost of capital)
//   Upper bound: r = 10 (1000%; NPV ≈ −capex for any finite positive cash flow)
//   Convergence: |hi−lo| < 1e-8 OR 100 iterations
//   Residual: |NPV| < 0.01 at convergence
//
// CAPITAL_CONFIG.capexIrr (15%) is the governed hurdle rate — never hardcoded here.

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
 *   capex ≤ 0   → NaN  (no investment to evaluate)
 *   uplift ≤ 0  → −Infinity  (no positive cash flow — destroy-value case)
 *   holdYears ≤ 0 → NaN  (no hold period)
 *
 * The bisection search is bounded [0, 10] (0% to 1000%). Any real-world capex
 * with a positive return will converge in this range. If NPV at r=0 is negative
 * (i.e. total undiscounted cash flows < capex), the true IRR is negative; the
 * function returns 0 as a floor (since the bisection lower bound is 0) — the
 * caller should treat any result below the hurdle as a "do not deploy" verdict
 * regardless of sign.
 *
 * @param capex            Initial capital outlay ($), must be > 0
 * @param annualNOIUplift  Projected annual incremental NOI ($), must be > 0
 * @param holdYears        Investment horizon (integer 1–10)
 * @returns                IRR as a decimal (0.15 = 15%), or NaN / −Infinity on invalid inputs
 */
export function computeCapexIrr(
  capex: number,
  annualNOIUplift: number,
  holdYears: number,
): number {
  // Guard: invalid inputs
  if (capex <= 0 || !Number.isFinite(capex)) return NaN;
  if (holdYears <= 0 || !Number.isFinite(holdYears)) return NaN;

  // Guard: no positive return stream
  if (annualNOIUplift <= 0) return -Infinity;

  // Bisection search: NPV is strictly monotone decreasing in r for positive cash flows.
  // At r=0: NPV = uplift*n − capex (may be positive or negative).
  // At r=10 (1000%): NPV ≈ −capex (effectively -capex; all cash flows discounted away).
  let lo = 0;
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
