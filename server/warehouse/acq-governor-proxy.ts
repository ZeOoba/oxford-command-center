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
//               stabilizedYocFloorPct (8%) hard-kills any deal at or below 8% YOC (strict since ruleset
//               2.0.0), while the proxy threshold is 4.25% (1.25 × 0.40 × 0.085). The proxy-fail zone
//               [0, 4.25%) ⊂ the engine-kill zone [0, 8%], so DSCR demotion cannot change a non-KILLED verdict
//               under the current ruleset. This module is the FORWARD SLOT: if the YoC floor is
//               relaxed or dscrFloor is raised (≥ 2.0 activates the proxy), it will work correctly
//               without code changes. Tests pin this module's contract in isolation.
//   LTV proxy:  INDETERMINATE at acquisition-screen time → always null, never demotes.
//               Rationale: AcquisitionInput carries no loan amount, so a true loan-to-value is not
//               computable here. The ≤ ltvCeiling (40%) governor is a FINANCING-stage decision.
//               HONEST STATUS (audit 2026-10-13 G1): NO code path enforces a per-deal LTV for a
//               pipeline candidate today — the capital-allocation BUY gate has no loan amount
//               either, and the capital_config CHECK (ltv_ceiling <= 0.40) only bounds the governor
//               VALUE, not any deal's leverage. The BUY gate fails closed on governor_ltv_cleared = 0
//               or an out-of-domain value, which is inert while this proxy always returns null.
//               The real LTV test happens at financing (debt-scoring.ts on owned positions).
//               This replaces the prior `allInBasis / price ≤ ltvCeiling` formula, which demoted
//               EVERY fully-specified deal to PASS (all-in basis ≥ price ⇒ ratio ≈ 1.0 > 0.40) —
//               a live defect that made the ranked pipeline mis-demote underwritten candidates and
//               would have made the OM grader return PASS for virtually every OM. (Gabriel-ratified
//               correction, 2026-06-20.) A real LTV gate slots in here if a loan/LTV input is added.
//
// Either proxy FAILING (=== false) hard-demotes the verdict to 'PASS' — but NEVER upgrades KILLED
// (a hard gate/floor rejection) to PASS, so verdict-filtered ranked lists stay correct.
import type { AcquisitionInput, AcquisitionScore, Tier, Verdict } from '../../src/contracts/acquisition';

/** 8.5% annual debt-service constant (7.25% rate proxy, 30-yr amortizing @ 40% LTV).
 *  Gabriel G3 — RATIFIED 2026-06-20. Screening heuristic, NOT a capital_config governor constant. */
export const SCREENING_DEBT_CONSTANT = 0.085;

/**
 * The governor-regime identity of a score: the capital_config `version` + the governor values + the
 * screening debt constant. Lives here (pure, DB-free) so the persistence funnel (acq-engine.ts, which
 * folds it into inputs_version and stamps it into score_json.governorRegime) and the BUY gate
 * (capital-allocation.ts, which compares a row's stamp to the CURRENT regime) share one definition.
 * Format pinned — changing it re-keys every candidate once. Rationale for leading with `version`:
 * see acq-engine.ts.
 */
export function governorFingerprint(g: { version: number; dscrFloor: number; ltvCeiling: number }): string {
  return `${g.version}:${g.dscrFloor}:${g.ltvCeiling}:${SCREENING_DEBT_CONSTANT}`;
}

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
  // Governor sanity — FAIL CLOSED. ltvCeiling <= 0 (or non-finite either value) turns the proxy
  // into Infinity / NaN: a zero ceiling cleared EVERY deal (Infinity >= floor) and NaN cleared none
  // silently. Neither is a deal-data condition, so it is not "indeterminate": an invalid governor
  // set demotes rather than passes. (Gabriel-approved 2026-09-26 from the 2026-09-25 audit.)
  const governorsValid =
    Number.isFinite(governors.ltvCeiling) && governors.ltvCeiling > 0 &&
    Number.isFinite(governors.dscrFloor) && governors.dscrFloor > 0;

  // DSCR proxy — indeterminate (null) when stabilizedYoc is absent AND the governors are valid.
  let governorDscrCleared: boolean | null = null;
  if (!governorsValid) {
    // Loud, so a persisted governor_dscr_cleared=0 from THIS path is distinguishable in the log
    // from a genuine DSCR-proxy miss (the outcome shape is unchanged for persistence/edge parity).
    console.warn(`[acq-governor-proxy] INVALID governor set (dscrFloor=${governors.dscrFloor}, ltvCeiling=${governors.ltvCeiling}) — failing closed (demote)`);
    governorDscrCleared = false;
  } else if (input.stabilizedYoc !== null && input.stabilizedYoc !== undefined) {
    const dscrProxy = input.stabilizedYoc / (governors.ltvCeiling * SCREENING_DEBT_CONSTANT);
    governorDscrCleared = dscrProxy >= governors.dscrFloor;
  }

  // LTV proxy — indeterminate at screen time (no loan amount in the inputs). NOT enforced anywhere
  // downstream for a pipeline candidate (see the module header); kept in the outcome (null) for a
  // consistent contract and as the slot where a real LTV gate would plug in.
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

export interface GovernorProxyScoreOutcome<S> {
  /** The score with verdict AND tier reflecting the governor demotion (identical object values when none). */
  score: S;
  governorDscrCleared: boolean | null;
  governorLtvCleared: boolean | null;
}

/**
 * Score-level wrapper around applyGovernorProxy — what EVERY surface (persistence, ad-hoc route,
 * edge Function) applies, so the emitted/persisted tier can never disagree with the verdict.
 *
 * applyGovernorProxy demotes only `verdict`; spreading `{ ...score, verdict }` left tier = T1/T2 next
 * to a demoted PASS (audit 2026-10-13 G1), and a tier-keyed reader (the capital BUY gate) then read a
 * governor-failed deal as buyable. On a demotion this sets tier = 'PASS' (the tier that pairs with a
 * PASS verdict) and appends a reason. Composite, floors, sub-scores and every other scored value are
 * left untouched — this changes no scoring value, only the governor-stage label pair.
 */
export function applyGovernorProxyToScore<S extends Pick<AcquisitionScore, 'verdict' | 'tier' | 'reasons'>>(
  score: S,
  input: Pick<AcquisitionInput, 'stabilizedYoc'>,
  governors: GovernorProxyGovernors,
): GovernorProxyScoreOutcome<S> {
  const outcome = applyGovernorProxy(score, input, governors);
  if (outcome.verdict === score.verdict) {
    return { score, governorDscrCleared: outcome.governorDscrCleared, governorLtvCleared: outcome.governorLtvCleared };
  }
  const tier: Tier = 'PASS';
  return {
    score: {
      ...score,
      verdict: outcome.verdict,
      tier,
      reasons: [
        ...score.reasons,
        `Governor demotion: ${score.verdict} → ${outcome.verdict} (tier ${score.tier} → ${tier}) — ` +
          `${outcome.governorLtvCleared === false ? 'LTV proxy failed' : 'DSCR proxy failed or the live governor set is invalid'}.`,
      ],
    },
    governorDscrCleared: outcome.governorDscrCleared,
    governorLtvCleared: outcome.governorLtvCleared,
  };
}
