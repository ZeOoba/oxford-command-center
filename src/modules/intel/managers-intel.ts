// src/modules/intel/managers-intel.ts
//
// Pure, deterministic helper backing ManagersView — orders the PM scorecards by avg NOI
// growth descending (best manager first), with null-growth managers pushed to the bottom
// (an unrankable manager never outranks a ranked one). No I/O, no React; the input array
// is never mutated. The canon small-n caveat ("directional, not definitive") lives in the
// view, not here — this is just the ordering.
import type { PmScorecard } from './analytics-hooks';

/** Scorecards ordered by avg NOI growth descending; nulls last. Stable, non-mutating. */
export function sortScorecards(scorecards: PmScorecard[]): PmScorecard[] {
  return [...scorecards].sort((a, b) => {
    const av = a.avgNoiGrowth;
    const bv = b.avgNoiGrowth;
    if (av === null && bv === null) return 0;
    if (av === null) return 1; // null sinks below any ranked manager
    if (bv === null) return -1;
    return bv - av; // descending — best first
  });
}
