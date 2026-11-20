// src/modules/acquisitions/ranked-sort.ts
//
// Sort key for the RankedCandidateList Tier column. It must match the server's /acq/intel ORDER BY
// (server/warehouse/api.ts): verdict rank first (PURSUE, WATCH, PASS, FLOOR-FLAGGED, GATE-FLAGGED, legacy KILLED), then
// composite DESC (Ruling 5: a flagged deal is ranked by its composite, after every clean verdict).
// Sorting the tier STRING put KILLED and PASS above T1 (localeCompare; audit 2026-11-03). A score with no
// verdict falls back to the verdict its tier pairs with; a row with no parsed score returns null so
// DataTable keeps it last in either direction.
//
// DELIBERATE DIVERGENCE: the server ranks on the acq_scores SQL columns, so an 'unparseable' row (score_json
// no longer parses ⇒ latestScore null) still ranks by its column verdict there. The client never receives
// that verdict, so such rows sort LAST here. They are already flagged and excluded from the capital BUY
// verdict; carrying the column verdict would need a RankedCandidate contract change (Architect-owned).
import type { RankedCandidate, Tier, Verdict } from '@contracts/acquisition';

const VERDICT_RANK: Record<Verdict, number> = { PURSUE: 0, WATCH: 1, PASS: 2, 'FLOOR-FLAGGED': 3, 'GATE-FLAGGED': 4, KILLED: 5 };
const VERDICT_FOR_TIER: Record<Tier, Verdict> = {
  T1: 'PURSUE', T2: 'WATCH', PASS: 'PASS', 'GATE-FLAGGED': 'GATE-FLAGGED', 'FLOOR-FLAGGED': 'FLOOR-FLAGGED', KILLED: 'KILLED',
};
const UNKNOWN_RANK = 6;

export function rankedSortValue(item: RankedCandidate): number | null {
  const s = item.latestScore;
  if (!s) return null;
  const verdict = s.verdict ?? (s.tier ? VERDICT_FOR_TIER[s.tier] : undefined);
  const rank = verdict ? (VERDICT_RANK[verdict] ?? UNKNOWN_RANK) : UNKNOWN_RANK;
  return rank * 1000 + (100 - (s.composite ?? 0));
}
