// server/warehouse/acq-governor-proxy.ts
//
// SHARED governor-proxy demotion for the Acquisition Intelligence engine — the single source of
// truth applied by ALL acquisition-scoring surfaces so they can never diverge:
//   - the ranked-candidate persistence path  (acq-engine.persistAndLogScore)
//   - the ad-hoc score route                 (POST /api/warehouse/acquisition/score)
//   - the deployed edge Pages Function        (functions/api/warehouse/acquisition/score.ts)
//
// PURE + EDGE-PORTABLE: imports only types and the import-free ratified-governor constants, takes
// the live governor values as a parameter, touches no DB and no node:fs — so the Cloudflare Pages
// bundle stays clean.
//
// FINANCIAL-DECISION CODE — CLAUDE.md §EOS: any change to this demotion logic requires a
// MANDATORY adversarial refute pass before merge.
//
// DSCR FLOOR (acquisition-underwriting SKILL.md v4.45 STAGE 1 "DSCR floor", v4.44 basis, v4.45 NOI basis; refi terms
// UNDERWRITING CONVENTIONS v4.37). Replaced the screening proxy (stabilizedYoc ÷ (0.40 × 0.085)) on 2026-11-12, PR-C
// of the doctrine-drift audit, under Gabriel's in-turn go-ahead. That proxy was inert (it failed only below a 4.25%
// YoC, inside the engine's 8% yield kill zone) and used the wrong LTV leg (the 40% AGGREGATE ceiling, which doctrine
// checks at STAGE 2.3 and excludes from the refi test), the wrong NOI basis (YoC on cost) and a retired rate (7.25%,
// 30-yr).
//
//   Doctrine: DSCR at a loan sized to 65% LTV (per-property) of stabilized value (stabilized NOI ÷ exit cap), at the
//   market-rate refi (10-yr UST + 200 bps, 25-yr amortization, monthly), on stabilized NOI, must be ≥ the DSCR floor.
//   Algebra: DSCR = NOI ÷ (0.65 × NOI/exitCap × k) = exitCap ÷ (0.65 × k), so the test is NOI-independent:
//   it clears iff exitCap ≥ 0.65 × dscrFloor × k(UST + 200 bps, 25 yr). SKILL.md's own check: at a 5.2% UST
//   (7.2% rate) k ≈ 8.6% and the threshold exit cap ≈ 7.0%.
//   Unknown exit cap or UST ⇒ INDETERMINATE (null): no demotion, and not BUY-eligible (the BUY gate requires
//   governor_dscr_cleared = 1). Doctrine's UST fallback (the last cited value tagged [UST UNVERIFIED]) is the
//   underwriter's to enter; with none it is a data gap, never a guessed rate.
//   A miss DEMOTES to PASS (Ruling 5, flag-not-kill, is deferred by Gabriel; the demotion stays until he rules).
//
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
// DISCLOSURE (refute wf_0a80ea57-515): an indeterminate DSCR floor on a valid governor set adds a
// `Governor open item: ...` reason naming the missing input, which capital-allocation surfaces as an open item,
// so a deal held out of BUY for a missing exit cap or UST always says why.
//
// Either test FAILING (=== false) hard-demotes the verdict to 'PASS' — but NEVER upgrades KILLED
// (a hard gate/floor rejection) to PASS, so verdict-filtered ranked lists stay correct.
import type { AcquisitionInput, AcquisitionScore, Tier, Verdict } from '../../src/contracts/acquisition';
import { RATIFIED_GOVERNORS } from '../../src/contracts/governor-constants';
import { GOVERNOR_OPEN_ITEM_PREFIX } from '../../src/analytics/acq-governor-demotion';

/** Refi rate spread over the 10-yr UST (SKILL.md v4.37: "10-yr U.S. Treasury + 200 bps, always"). */
export const REFI_UST_SPREAD = 0.02;
/** Refi amortization, years, monthly payments (SKILL.md UNDERWRITING CONVENTIONS: 25-yr amortization). */
export const REFI_AMORT_YEARS = 25;

/** Annual debt constant of a fully amortizing loan: 12 × the monthly payment per $1 at annual rate `rate`. */
export function refiDebtConstant(rate: number, amortYears: number = REFI_AMORT_YEARS): number {
  const n = amortYears * 12;
  if (rate === 0) return 1 / amortYears;
  const m = rate / 12;
  return (12 * m) / (1 - Math.pow(1 + m, -n));
}

/**
 * DSCR at a loan sized to `perPropertyLtv` of stabilized value, at UST + 200 bps over 25 years: exitCap ÷ (LTV × k).
 * Null when either input is unknown or out of domain (a data gap, never a guess).
 */
export function dscrAtRefiLtv(
  exitCapPct: number | null | undefined,
  ust10yr: number | null | undefined,
  perPropertyLtv: number = RATIFIED_GOVERNORS.perPropertyLtvCeiling,
): number | null {
  if (exitCapPct === null || exitCapPct === undefined || !Number.isFinite(exitCapPct) || exitCapPct <= 0) return null;
  if (ust10yr === null || ust10yr === undefined || !Number.isFinite(ust10yr) || ust10yr < 0) return null;
  return exitCapPct / (perPropertyLtv * refiDebtConstant(ust10yr + REFI_UST_SPREAD));
}

/** Both sides rounded to 1e-8 before comparing — the engine's floor-comparison precision (atFloorPrecision). */
function clearsAtFloorPrecision(actual: number, floor: number): boolean {
  return Math.round(actual * 1e8) / 1e8 >= Math.round(floor * 1e8) / 1e8;
}

/**
 * The governor-regime identity of a score: the capital_config `version` + the governor values + the DSCR test's
 * refi terms. Lives here (pure, DB-free) so the persistence funnel (acq-engine.ts, which folds it into
 * inputs_version and stamps it into score_json.governorRegime) and the BUY gate (capital-allocation.ts, which
 * compares a row's stamp to the CURRENT regime) share one definition. Format pinned — changing it re-keys every
 * candidate once (2026-11-12: the retired screening debt constant 0.085 gave way to the 65%-LTV refi terms).
 */
export function governorFingerprint(g: { version: number; dscrFloor: number; ltvCeiling: number }): string {
  return `${g.version}:${g.dscrFloor}:${g.ltvCeiling}:refi${RATIFIED_GOVERNORS.perPropertyLtvCeiling}/ust+${REFI_UST_SPREAD}/${REFI_AMORT_YEARS}y`;
}

/** The governor values the proxy reads — supplied by the caller (DB-loaded server-side, bundled
 *  defaults at the edge) so this module stays pure and DB-free. */
export interface GovernorProxyGovernors {
  dscrFloor: number;
  ltvCeiling: number;
}

/** The inputs the DSCR floor reads. */
export type GovernorProxyInput = Pick<AcquisitionInput, 'exitCapPct' | 'ust10yr'>;

export interface GovernorProxyOutcome {
  /** The verdict after governor demotion (may equal the input verdict). */
  verdict: Verdict;
  /** true=cleared, false=failed, null=indeterminate (input absent). */
  governorDscrCleared: boolean | null;
  /** Always null at acquisition-screen time — see module header. */
  governorLtvCleared: boolean | null;
  /** The DSCR at a 65%-LTV loan, when computable (observability only). */
  dscrAtRefiLtv: number | null;
}

/**
 * Apply the governor tests to a freshly-computed acquisition score and return the (possibly
 * demoted) verdict plus the governor-cleared booleans for persistence/observability.
 *
 * Reads only `score.verdict` and the exit cap + UST inputs (Pick-typed for cheap, decoupled testing).
 */
export function applyGovernorProxy(
  score: Pick<AcquisitionScore, 'verdict'>,
  input: GovernorProxyInput,
  governors: GovernorProxyGovernors,
): GovernorProxyOutcome {
  // Governor sanity — FAIL CLOSED. A non-finite or non-positive governor is not a deal-data condition, so it is
  // not "indeterminate": an invalid governor set demotes rather than passes. (Gabriel-approved 2026-09-26 from the
  // 2026-09-25 audit.) ltvCeiling no longer enters the DSCR arithmetic but stays a validity check on the set.
  const governorsValid =
    Number.isFinite(governors.ltvCeiling) && governors.ltvCeiling > 0 &&
    Number.isFinite(governors.dscrFloor) && governors.dscrFloor > 0;

  const dscr = dscrAtRefiLtv(input.exitCapPct, input.ust10yr);
  let governorDscrCleared: boolean | null = null;
  if (!governorsValid) {
    // Loud, so a persisted governor_dscr_cleared=0 from THIS path is distinguishable in the log
    // from a genuine DSCR miss (the outcome shape is unchanged for persistence/edge parity).
    console.warn(`[acq-governor-proxy] INVALID governor set (dscrFloor=${governors.dscrFloor}, ltvCeiling=${governors.ltvCeiling}) — failing closed (demote)`);
    governorDscrCleared = false;
  } else if (dscr !== null) {
    governorDscrCleared = clearsAtFloorPrecision(dscr, governors.dscrFloor);
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

  return { verdict, governorDscrCleared, governorLtvCleared, dscrAtRefiLtv: dscr };
}

/** Prefix of a non-demoting governor disclosure; capital-allocation's capReasonsOf lists each as an open item. Defined
 *  once in the shared analytics module so the deal drawer can recognise it too (OI-404 follow-up). */
export { GOVERNOR_OPEN_ITEM_PREFIX };

/** The reason text for an indeterminate DSCR floor, naming exactly what is missing. */
export function dscrIndeterminateReason(input: GovernorProxyInput): string {
  const missing = [
    input.exitCapPct === null || input.exitCapPct === undefined ? 'exit cap' : null,
    input.ust10yr === null || input.ust10yr === undefined ? '10-yr UST' : null,
  ].filter((m): m is string => m !== null);
  const what = missing.length > 0 ? missing.join(' and ') + ' unknown' : 'exit cap or 10-yr UST out of range';
  return `${GOVERNOR_OPEN_ITEM_PREFIX}DSCR floor indeterminate (${what}) — not BUY-eligible until entered`;
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
  input: GovernorProxyInput,
  governors: GovernorProxyGovernors,
): GovernorProxyScoreOutcome<S> {
  const outcome = applyGovernorProxy(score, input, governors);
  if (outcome.verdict === score.verdict) {
    // Not demoted. An indeterminate DSCR floor (valid governors, missing exit cap / UST) is still disclosed, unless
    // the score is KILLED (already out of every buy list for a harder reason).
    const disclose = outcome.governorDscrCleared === null && score.verdict !== 'KILLED';
    return {
      score: disclose ? { ...score, reasons: [...score.reasons, dscrIndeterminateReason(input)] } : score,
      governorDscrCleared: outcome.governorDscrCleared,
      governorLtvCleared: outcome.governorLtvCleared,
    };
  }
  const tier: Tier = 'PASS';
  const governorsValid = Number.isFinite(governors.ltvCeiling) && governors.ltvCeiling > 0
    && Number.isFinite(governors.dscrFloor) && governors.dscrFloor > 0;
  const why = outcome.governorLtvCleared === false
    ? 'LTV proxy failed'
    : !governorsValid
      ? 'the live governor set is invalid'
      // Truncated (never rounded up) to 3 dp, so a value just under the floor never prints as the floor itself.
      : `DSCR ${(Math.floor(outcome.dscrAtRefiLtv! * 1000) / 1000).toFixed(3)}x at a ${RATIFIED_GOVERNORS.perPropertyLtvCeiling * 100}%-LTV refi (UST + ${REFI_UST_SPREAD * 10000} bps, ${REFI_AMORT_YEARS}-yr) is below the ${governors.dscrFloor}x floor`;
  return {
    score: {
      ...score,
      verdict: outcome.verdict,
      tier,
      reasons: [
        ...score.reasons,
        `Governor demotion: ${score.verdict} → ${outcome.verdict} (tier ${score.tier} → ${tier}) — ${why}.`,
      ],
    },
    governorDscrCleared: outcome.governorDscrCleared,
    governorLtvCleared: outcome.governorLtvCleared,
  };
}
