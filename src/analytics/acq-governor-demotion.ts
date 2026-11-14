// src/analytics/acq-governor-demotion.ts
//
// Display rule for a governor-demoted acquisition score, used by the five acquisitions surfaces that
// render a persisted (tier, verdict) pair: RankedCandidateList, PipelineTierBoard, DealDrawer, the
// Capital Buy Pipeline and the IC memo.
//
// A governor demotion has two persisted shapes, both with verdict PASS:
//   - current engine (G1, server/warehouse/acq-governor-proxy.ts applyGovernorProxyToScore): tier is
//     demoted to PASS together with the verdict, and a reason "Governor demotion: PURSUE → PASS
//     (tier T1 → PASS) — …" is appended;
//   - legacy (pre-G1) rows: tier T1/T2 left next to the demoted PASS verdict.
// This is the same rule the server uses for governorDemotedPass (server/warehouse/capital-allocation.ts),
// which carries it onto Capital pipeline items as `governorDemoted` because those items have no reasons.
//
// The VERDICT is authoritative (it is what /acq/intel ranks by and what the capital BUY gate reads),
// so these surfaces display a row under effectiveTier() and mark it "Governor-demoted (was T1)"
// instead of presenting a plain PASS or a clean T1/T2. Display only: BUY eligibility stays the
// allocator's own stricter check (capital-allocation.ts isBuyEligible) and is never re-derived here.
import type { Tier, Verdict } from '../contracts/acquisition';

const TIER_FOR_VERDICT: Record<Verdict, Tier> = { PURSUE: 'T1', WATCH: 'T2', PASS: 'PASS', KILLED: 'KILLED' };

/** Prefix of the reason applyGovernorProxyToScore appends on a demotion (acq-governor-proxy.ts). */
export const GOVERNOR_DEMOTION_REASON_PREFIX = 'Governor demotion:';

export interface PersistedTierVerdict {
  tier?: Tier | null | undefined;
  verdict?: Verdict | null | undefined;
  /** Score reasons, when the surface has them (AcquisitionScore.reasons). */
  reasons?: readonly string[] | null | undefined;
  /** Server-computed flag, for surfaces without reasons (capital pipeline items, IC memo). */
  governorDemoted?: boolean | null | undefined;
}

/** The tier a persisted score should display under: the verdict's tier when a verdict is present,
 *  otherwise the persisted tier; null when the row is unscored. */
export function effectiveTier(score: PersistedTierVerdict | null | undefined): Tier | null {
  if (!score) return null;
  if (score.verdict) return TIER_FOR_VERDICT[score.verdict] ?? score.tier ?? null;
  return score.tier ?? null;
}

function isLegacyShape(score: PersistedTierVerdict): boolean {
  return (score.tier === 'T1' || score.tier === 'T2') && score.verdict === 'PASS';
}

function demotionReason(score: PersistedTierVerdict): string | null {
  return score.reasons?.find((r) => r.startsWith(GOVERNOR_DEMOTION_REASON_PREFIX)) ?? null;
}

/** A PASS verdict produced by a governor demotion: the legacy T1/T2 + PASS shape, a PASS whose
 *  reasons carry the engine's "Governor demotion:" entry, or the server's governorDemoted flag. */
export function isGovernorDemoted(score: PersistedTierVerdict | null | undefined): boolean {
  if (!score) return false;
  if (score.governorDemoted === true) return true;
  if (score.verdict !== 'PASS') return false;
  return isLegacyShape(score) || demotionReason(score) !== null;
}

/** The tier the score held before the governor demoted it, when it can be told: the persisted tier
 *  of a legacy row, or the "(tier T1 → PASS)" part of the engine's demotion reason. */
export function preDemotionTier(score: PersistedTierVerdict | null | undefined): Tier | null {
  if (!score || !isGovernorDemoted(score)) return null;
  if (isLegacyShape(score)) return score.tier!;
  const m = /\(tier (T1|T2|PASS|KILLED) →/.exec(demotionReason(score) ?? '');
  return m ? (m[1] as Tier) : null;
}

/** Marker text for a demoted score, or null when the score is not demoted. */
export function governorDemotedLabel(score: PersistedTierVerdict | null | undefined): string | null {
  if (!isGovernorDemoted(score)) return null;
  const was = preDemotionTier(score);
  return was === 'T1' || was === 'T2' ? `Governor-demoted (was ${was})` : 'Governor-demoted';
}
