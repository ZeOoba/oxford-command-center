// server/warehouse/debt-trust.ts
//
// Round 19d. THE single place a debt-book trust level is derived.
//
// Before this module, three surfaces each mapped the raw snapshot marker themselves with slightly
// different rules, and on an IDENTICAL empty warehouse `/maturity` and `/timeline` reported
// 'trusted' while capital allocation reported 'degraded'. Two independent adversarial lenses
// flagged the incoherence. One helper, one answer.
//
// ROUND 19e (adversarial refute of 19d, HIGH — reproduced): "one helper, one answer" was not
// actually true. debt-api.ts's readBookTrust counted debt_positions ROWS (COUNT(*), no
// property_id filter). capital-allocation.ts's deriveBookTrust counted SCORES, which
// scoreDebtPositions only emits for ATTRIBUTED properties (property_id IS NOT NULL) — and its
// zero-score branch passed a hardcoded literal 0, never the real row count. Both called the same
// pure deriveDebtBookTrust() below with different, disagreeing inputs. This is exactly the class
// of bug "one helper" was meant to prevent, just one layer down: helper unification without INPUT
// unification.
//
// The trigger is a documented, warn-only production state: writeDebtSnapshot writes property_id
// = NULL whenever buildLoanPropertyMap can't resolve a loan's collateralProperty (a blank or
// typo'd name in the Loan Index, or a name not in property_master) — debt-api.ts logs it via
// console.warn and proceeds. On that state the two surfaces reported 'trusted' and 'unknown' on
// the SAME instant, and — worse — with PARTIAL attribution (one attributed loan, one unattributed
// $9M loan with a near-term balloon) capital allocation's `debtScores.length > 0` short-circuit
// returned 'trusted' outright, silently ignoring the unattributed loan entirely: the property
// rendered debtSignal 'no-debt', bookTrust 'trusted', balloon erased. computePortfolioAggregateLtv
// already ratified that an unattributed loan invalidates a governor verdict (it returns
// complete:false and withholds); the trust helpers had never inherited that rule.
//
// Fix: ONE function now reads the database directly — marker AND both loan counts, in one
// transaction — so there is exactly one query path for every consumer. debt-api.ts and
// capital-allocation.ts both call readDebtBookTrust(db) and no longer run their own COUNT/score
// arithmetic to decide trust.
//
// The pure deriveDebtBookTrust() below is kept separate from the db read (rather than folded in)
// specifically so it stays trivially unit-testable without a database — the extraction from
// debt-scoring.ts already established that principle for exactly this reason (heavy vi.mock
// coverage elsewhere in the suite).
import type { WarehouseDb } from './db';
import type { DebtBookTrust } from '../../src/contracts/debt';
import { readLastSnapshotRefusal } from './debt-snapshot';

/**
 * @param marker  the persisted snapshot refusal marker, or null when none stands.
 * @param attributedActiveCount  active debt_positions rows with a resolved property_id.
 * @param unattributedActiveCount  active debt_positions rows with property_id IS NULL — a loan
 *   the crosswalk could not resolve. Non-zero here means the book is INCOMPLETE from the
 *   consumer's point of view even when some rows resolved fine: the same withhold-in-either-
 *   direction posture computePortfolioAggregateLtv already applies for exactly this state
 *   (`complete: false`). Mapped to 'degraded' rather than a new state — an unattributed loan is,
 *   for every consumer of this trust level, indistinguishable in effect from a lost row: some
 *   portion of the book's debt cannot be reasoned about.
 *
 * Zero active rows (attributed or not) with no marker is 'unknown' — there is no book to judge.
 * It is NOT 'trusted' (debt-maturity's ratified H2b doctrine: "the warehouse cannot distinguish
 * 'no debt' from 'no data', so it must not guess") and NOT 'degraded' on its own, which
 * contractually asserts rows were LOST and would send an operator hunting an incident that never
 * happened.
 */
export function deriveDebtBookTrust(
  marker: { kind: 'refused' | 'degraded' } | null,
  attributedActiveCount: number,
  unattributedActiveCount = 0,
): DebtBookTrust {
  // Round 19h (adversarial refute of 19d/19e, HIGH — reproduced): the unattributed-count check
  // MUST be evaluated before a 'refused' marker is honored. A 'refused' marker means "a refusal
  // touched zero rows, so it can never UPGRADE trust" (round-11 doctrine) -- but checking the
  // marker first let an unattributed-loan 'degraded' book (no marker required, round 19e's
  // count-based path) get UPGRADED to 'refused' by a later, unrelated write, restoring
  // "last trusted book" figures that never actually reflected the unattributed loan. A 'degraded'
  // marker still wins immediately either way, so this only changes the refused-vs-unattributed
  // ordering.
  if (marker?.kind === 'degraded') return 'degraded';
  if (unattributedActiveCount > 0) return 'degraded';
  if (marker !== null) return marker.kind;
  return attributedActiveCount > 0 ? 'trusted' : 'unknown';
}

/**
 * THE single DB read behind deriveDebtBookTrust. Marker and both loan counts are read inside one
 * transaction so they describe one instant — mirroring the atomicity pattern already used for the
 * rows themselves in scoreDebtPositions and computePortfolioAggregateLtv (a healing or damaging
 * write must not be observable as two different snapshots to two different reads of this state).
 */
export function readDebtBookTrust(db: WarehouseDb): DebtBookTrust {
  const { marker, attributed, unattributed } = db.transaction(() => {
    const counts = db
      .prepare(
        `SELECT
           SUM(CASE WHEN property_id IS NOT NULL THEN 1 ELSE 0 END) AS attributed,
           SUM(CASE WHEN property_id IS NULL THEN 1 ELSE 0 END) AS unattributed
         FROM debt_positions WHERE status = 'active'`,
      )
      .get() as { attributed: number | null; unattributed: number | null };
    return {
      marker: readLastSnapshotRefusal(db),
      attributed: counts.attributed ?? 0,
      unattributed: counts.unattributed ?? 0,
    };
  })();
  return deriveDebtBookTrust(marker, attributed, unattributed);
}

/**
 * True when a trust level forbids any clearance-direction inference — i.e. everything except
 * 'trusted'. Exists so consumers stop hand-rolling the comparison: round 19b had one engine
 * testing `!== 'trusted'` and its sibling in the same file testing `=== 'degraded'`, which made a
 * warehouse WITH a refusal marker report less conservatively than the same warehouse with none.
 */
export function isDistrusted(trust: DebtBookTrust): boolean {
  return trust !== 'trusted';
}
