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
// r and NPV(r) -> +Infinity as r -> -1+, so a root always exists somewhere above -1 — both bracket
// ends start at [0, 10] and adaptively widen outward (lower toward -1, never reaching it; upper by
// 10x steps, uncapped) until NPV brackets a sign change, so even a catastrophic-loss or
// extreme-return project converges to its REAL rate with a near-zero residual in the ordinary
// case, rather than clamping to an arbitrary floor/ceiling (refute-pass findings: a fixed -0.99
// floor, and separately a fixed 10 ceiling, each left a residual — i.e. a wrong answer — outside
// their bracket). Convergence: |hi-lo| < 1e-9 OR 200 iterations. Precision degrades as r -> -1
// (dNPV/dr is unbounded there), so a residual on the order of the capex's own magnitude is
// possible for a large-enough capex at a deeply negative rate — decision-irrelevant in practice
// since the verdict is already unambiguously "does not clear" well before that region, but the
// root property is NOT a blanket "near-zero residual" guarantee at every input.
//
// CAPITAL_CONFIG.capexIrr (15%) is a SEPARATE governed constant (capex-approval yield-on-cost
// floor) from the general hurdleRatePct (8%) the live capital-allocation engine's own improve-gate
// (capexIrr > hurdleRatePct, strict) compares against — CapexIrrCalc.tsx reads hurdleRatePct and
// applies the same strict `>`. This guarantees comparison-LOGIC parity only: the two are
// conceptually different calculations (this is a full IRR on user-entered capex; the engine's
// capexIrr is a portfolio-level proxy) computed on different numbers, so an exact tie between this
// panel's bisected IRR and the live hurdle can still land on either side of `>` depending on the
// bisection's own sub-cent residual — a decision-irrelevant edge case (a genuine $0-NPV project),
// not a "can never disagree" guarantee.

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
  // Same defect class on the other side (round-3 finding): a fixed hi=10 (1000%) silently
  // truncates a true IRR above 1000% (e.g. capex small relative to annual uplift) with a large
  // positive NPV residual. Widen outward, uncapped, until the root is actually bracketed.
  let hi = 10;
  for (let guard = 0; guard < 30 && npvAtRate(capex, annualNOIUplift, holdYears, hi) > 0; guard++) {
    hi *= 10;
  }

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
