// server/warehouse/acq-governor-proxy.ts
//
// SHARED governor-proxy demotion for the Acquisition Intelligence engine — the single source of
// truth applied by ALL acquisition-scoring surfaces so they can never diverge:
//   - the ranked-candidate persistence path  (acq-engine.persistAndLogScore)
//   - the ad-hoc score route                 (POST /api/warehouse/acquisition/score)
//   - the deployed edge Pages Function        (functions/api/warehouse/acquisition/score.ts)
//
// PURE + EDGE-PORTABLE: imports only types (erased at compile), takes governor values as a
// parameter, touches no DB and no node:fs — so the Cloudflare Pages bundle stays clean.
//
// FINANCIAL-DECISION CODE — CLAUDE.md §EOS: any change to this demotion logic requires a
// MANDATORY adversarial refute pass before merge.
//
// GOVERNOR PROXIES (screen-time approximations — NOT the protected capital governors themselves):
//   DSCR proxy: stabilizedYoc / (ltvCeiling × SCREENING_DEBT_CONSTANT) ≥ dscrFloor.
//               Null when stabilizedYoc is absent (indeterminate ⇒ no demotion).
//               LIVE STATUS: currently inert under the ratified ruleset (v1). The engine's own
//               stabilizedYocFloorPct (8%) hard-kills any deal below 8% YOC, while the proxy
//               threshold is 4.25% (1.25 × 0.40 × 0.085). The proxy-fail zone [0, 4.25%) ⊂ the
//               engine-kill zone [0, 8%), so DSCR demotion cannot change a non-KILLED verdict
//               under the current ruleset. This module is the FORWARD SLOT: if the YoC floor is
//               relaxed or dscrFloor is raised (≥ 2.0 activates the proxy), it will work correctly
//               without code changes. Tests pin this module's contract in isolation.
//   LTV proxy:  INDETERMINATE at acquisition-screen time → always null, never demotes.
//               Rationale: AcquisitionInput carries no loan amount, so a true loan-to-value is not
//               computable here. The ≤ ltvCeiling (40%) governor is a FINANCING-stage decision,
//               enforced at capital allocation (capital_config DB CHECK), not at OM-screen time.
//               This replaces the prior `allInBasis / price ≤ ltvCeiling` formula, which demoted
//               EVERY fully-specified deal to PASS (all-in basis ≥ price ⇒ ratio ≈ 1.0 > 0.40) —
//               a live defect that made the ranked pipeline mis-demote underwritten candidates and
//               would have made the OM grader return PASS for virtually every OM. (Gabriel-ratified
//               correction, 2026-06-20.) A real LTV gate slots in here if a loan/LTV input is added.
//
// Either proxy FAILING (=== false) hard-demotes the verdict to 'PASS' — but NEVER upgrades KILLED
// (a hard gate/floor rejection) to PASS, so verdict-filtered ranked lists stay correct.
import type { AcquisitionInput, AcquisitionScore, Verdict } from '../../src/contracts/acquisition';

/** 8.5% annual debt-service constant (7.25% rate proxy, 30-yr amortizing @ 40% LTV).
 *  Gabriel G3 — RATIFIED 2026-06-20. Screening heuristic, NOT a capital_config governor constant. */
export const SCREENING_DEBT_CONSTANT = 0.085;

/** The governor values the proxy reads — supplied by the caller (DB-loaded server-side, bundled
 *  defaults at the edge) so this module stays pure and DB-free. */
export interface GovernorProxyGovernors {
  dscrFloor: number;
  ltvCeiling: number;
}

export interface GovernorProxyOutcome {
  /** The verdict after governor demotion (may equal the input verdict). */
  verdict: Verdict;
  /** true=cleared, false=failed, null=indeterminate (input absent). */
  governorDscrCleared: boolean | null;
  /** Always null at acquisition-screen time — see module header. */
  governorLtvCleared: boolean | null;
}

/**
 * Apply the governor proxies to a freshly-computed acquisition score and return the (possibly
 * demoted) verdict plus the governor-cleared booleans for persistence/observability.
 *
 * Reads only `score.verdict` and `input.stabilizedYoc` (Pick-typed for cheap, decoupled testing).
 */
export function applyGovernorProxy(
  score: Pick<AcquisitionScore, 'verdict'>,
  input: Pick<AcquisitionInput, 'stabilizedYoc'>,
  governors: GovernorProxyGovernors,
): GovernorProxyOutcome {
  // DSCR proxy — indeterminate (null) when stabilizedYoc is absent.
  let governorDscrCleared: boolean | null = null;
  if (input.stabilizedYoc !== null && input.stabilizedYoc !== undefined) {
    const dscrProxy = input.stabilizedYoc / (governors.ltvCeiling * SCREENING_DEBT_CONSTANT);
    governorDscrCleared = dscrProxy >= governors.dscrFloor;
  }

  // LTV proxy — indeterminate at screen time (no loan amount in the inputs). Enforced downstream
  // at the financing/capital-allocation stage. Kept in the outcome (null) for a consistent contract
  // and as the slot where a real LTV gate would plug in.
  const governorLtvCleared: boolean | null = null;

  // Demotion: a FAILED governor hard-demotes to PASS, but never upgrades KILLED.
  let verdict: Verdict = score.verdict;
  if (
    (governorDscrCleared === false || governorLtvCleared === false) &&
    verdict !== 'KILLED'
  ) {
    verdict = 'PASS';
  }

  return { verdict, governorDscrCleared, governorLtvCleared };
}
