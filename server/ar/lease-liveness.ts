// server/ar/lease-liveness.ts
//
// The ONE shared "is this lease dead for fresh AR matching?" predicate (2026-09-14 weekly
// financial-code sweep). Before this, scripts/ar-import-headless.ts's loadLeasesFromSnapshot and
// server/ar/resolve-by-unit.ts's live-hit filter each carried their own `status !== 'Expired'`
// check -- two copies of a rule that was also too narrow. Both missed:
//
//   - status 'Vacant': a vacancy placeholder row in the roster, never a billing tenant.
//   - status 'Active' with annualRent === 0: a roster row that bills nothing. Real cases: Example Consulting
//     Consulting Group (29000 Information Lane #202, Active, $0, $6,063.09 AR persisted via a
//     human-confirmed cache mapping) and Example Gymnastics (2207 Northwood A15, Active, $0,
//     $1,824.01 AR). A fresh export naming either -- or, in Format B, simply carrying their unit --
//     took a clean 'exact' hit and auto-wrote with no human review, the same failure class the
//     2026-08-24 Expired-exclusion was built to stop (a dead lease silently absorbing a delinquency
//     nobody confirmed belongs to it).
//
// SCOPE -- read before widening the call sites: this predicate gates the FRESH-MATCH candidate
// pools ONLY (the name-matcher's roster and resolveByUnit's live-hit set). It must NOT be applied to
// loadAllLeaseIdsFromSnapshot / partitionArRows' validLeaseIds: a PREVIOUSLY human-CONFIRMED cache
// mapping to a dead lease is a different, already-trusted decision, and narrowing that roster was a
// real regression once (PR #302 review, $9,596.90 + $13,019.92 of live arrears froze). The real
// cache entry "tenant 072 llc" -> 29000-information-lane-202-... is exactly such a mapping
// and must keep writing.
//
// The effect of "dead" is never a redirect: a name or unit that only hits a dead lease falls to
// 'none' confidence and lands in the review queue (or, with a dead sibling on a re-let unit, is
// downgraded to ambiguous -> review). It can only ever make MORE rows route to a human, never fewer.

export interface LeaseLivenessFields {
  status?: string | null;
  /** Annualized rent from the roster. `null`/`undefined` means UNKNOWN, which is not zero -- see
   *  isDeadLease. */
  annualRent?: number | null;
  /** Contract monthly rent. annualRent is NET of abated months, so a live fully-abated lease reads
   *  annualRent 0 with monthlyRent > 0; absent/null/0 = no contract rent known. */
  monthlyRent?: number | null;
}

/** True when the lease is not a live fresh-match candidate: status 'Expired' or 'Vacant', or an
 *  annualRent of exactly 0 with no contract monthlyRent either (annualRent is year-1 cash net of
 *  abated months, so annualRent 0 alone also describes a live lease abated all 12 months). An absent/null annualRent is treated as unknown and does NOT make the
 *  lease dead -- a loader that does not project the field (or a snapshot row missing it) keeps
 *  the pre-existing status-only behaviour rather than silently declaring every lease dead. */
export function isDeadLease(lease: LeaseLivenessFields): boolean {
  if (lease.status === 'Expired' || lease.status === 'Vacant') return true;
  if (lease.annualRent !== 0) return false;
  // annualRent 0 is ambiguous (placeholder / zeroed cell / fully abated). Only a LIVE-status row with a
  // contract monthlyRent is trusted as abated; Unknown or any other status stays dead -> review (Fix A).
  const live = lease.status === 'Active' || lease.status === 'Expiring Soon';
  return !(live && typeof lease.monthlyRent === 'number' && Number.isFinite(lease.monthlyRent) && lease.monthlyRent > 0);
}
