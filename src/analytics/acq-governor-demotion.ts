// src/analytics/acq-governor-demotion.ts
//
// Display rule for a governor-demoted acquisition score, used by the five acquisitions surfaces that
// render a persisted (tier, verdict) pair: RankedCandidateList, PipelineTierBoard, DealDrawer, the
// Capital Buy Pipeline and the IC memo.
//
// Ruling 5 (Gabriel in-turn 2026-11-20): a genuine DSCR floor miss now relabels the score FLOOR-FLAGGED (tier and
// verdict) with the same "Governor demotion:" reason; the fail-closed paths (invalid governor set) still demote to PASS.
// A governor demotion has these persisted shapes:
//   - current engine (G1, server/warehouse/acq-governor-proxy.ts applyGovernorProxyToScore): tier moves together
//     with the verdict and a reason is appended — "Governor demotion: PURSUE → FLOOR-FLAGGED (tier T1 →
//     FLOOR-FLAGGED) — …" on a DSCR floor miss, "Governor demotion: PURSUE → PASS (tier T1 → PASS) — …" on the
//     fail-closed (invalid governor set) path. A natively scored PASS that misses the DSCR floor becomes FLOOR-FLAGGED
//     with a "FLOOR-FLAGGED (governor):" reason instead: it was never buyable, so it is not a demotion;
//   - legacy (pre-G1) rows: tier T1/T2 left next to the demoted PASS verdict.
// This is the same rule the server uses for governorDemotedPass (server/warehouse/capital-allocation.ts),
// which carries it onto Capital pipeline items as `governorDemoted` because those items have no reasons.
//
// The VERDICT is authoritative (it is what /acq/intel ranks by and what the capital BUY gate reads),
// so these surfaces display a row under effectiveTier() and mark it "Governor-demoted (was T1)"
// instead of presenting a plain PASS or a clean T1/T2. Display only: BUY eligibility stays the
// allocator's own stricter check (capital-allocation.ts isBuyEligible) and is never re-derived here.
import type { Tier, Verdict } from '../contracts/acquisition';

const TIER_FOR_VERDICT: Record<Verdict, Tier> = {
  PURSUE: 'T1', WATCH: 'T2', PASS: 'PASS', 'GATE-FLAGGED': 'GATE-FLAGGED', 'FLOOR-FLAGGED': 'FLOOR-FLAGGED', KILLED: 'KILLED',
};

/** Prefix of the reason applyGovernorProxyToScore appends on a demotion (acq-governor-proxy.ts). */
export const GOVERNOR_DEMOTION_REASON_PREFIX = 'Governor demotion:';

/** Prefix of a non-demoting governor disclosure (e.g. an indeterminate DSCR floor). Defined here so client surfaces can
 *  recognise it; acq-governor-proxy.ts re-exports this exact constant, and capital-allocation's capReasonsOf lists each
 *  such reason as an open item. */
export const GOVERNOR_OPEN_ITEM_PREFIX = 'Governor open item: ';

/** Prefix of the governor's DSCR floor-flag disclosure (Ruling 5): appended to a natively scored PASS that misses the
 *  DSCR floor, and to an already gate- or floor-flagged score so the DSCR miss is still named. Not a demotion.
 *  acq-governor-proxy.ts appends exactly this constant. */
export const FLOOR_FLAG_GOVERNOR_PREFIX = 'FLOOR-FLAGGED (governor): ';

/** Reasons the governor appends LAST that a compact surface must never cap away. */
const GOVERNOR_APPENDED_PREFIXES = [GOVERNOR_OPEN_ITEM_PREFIX, FLOOR_FLAG_GOVERNOR_PREFIX, GOVERNOR_DEMOTION_REASON_PREFIX];

/** Score reasons a compact surface (the deal drawer) shows: the first `limit`, plus any governor-appended reason (open
 *  item, DSCR floor flag, demotion) they left out, in original order. The governor appends its reason LAST, so a plain
 *  slice hid it behind 3+ engine reasons (OI-404 follow-up; Ruling 5 round-2 refute). Ordinary reasons stay capped. */
export function drawerReasons(reasons: readonly string[], limit = 3): string[] {
  return reasons.filter((r, i) => i < limit || GOVERNOR_APPENDED_PREFIXES.some((p) => r.startsWith(p)));
}

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

/** A verdict produced by a governor demotion: the legacy T1/T2 + PASS shape, a PASS or FLOOR-FLAGGED whose
 *  reasons carry the engine's "Governor demotion:" entry (Ruling 5: a DSCR floor miss is FLOOR-FLAGGED), or the
 *  server's governorDemoted flag. An engine FLOOR-FLAGGED with no such reason is a STAGE 1 floor breach, not this. */
export function isGovernorDemoted(score: PersistedTierVerdict | null | undefined): boolean {
  if (!score) return false;
  if (score.governorDemoted === true) return true;
  if (score.verdict === 'FLOOR-FLAGGED') return demotionReason(score) !== null;
  if (score.verdict !== 'PASS') return false;
  return isLegacyShape(score) || demotionReason(score) !== null;
}

/** The tier the score held before the governor demoted it, when it can be told: the persisted tier
 *  of a legacy row, or the "(tier T1 → FLOOR-FLAGGED)" / "(tier T1 → PASS)" part of the engine's demotion reason. */
export function preDemotionTier(score: PersistedTierVerdict | null | undefined): Tier | null {
  if (!score || !isGovernorDemoted(score)) return null;
  if (isLegacyShape(score)) return score.tier!;
  const m = /\(tier (T1|T2|PASS|GATE-FLAGGED|FLOOR-FLAGGED|KILLED) →/.exec(demotionReason(score) ?? '');
  return m ? (m[1] as Tier) : null;
}

/** Marker text for a demoted score, or null when the score is not demoted. */
export function governorDemotedLabel(score: PersistedTierVerdict | null | undefined): string | null {
  if (!isGovernorDemoted(score)) return null;
  const was = preDemotionTier(score);
  return was === 'T1' || was === 'T2' ? `Governor-demoted (was ${was})` : 'Governor-demoted';
}
