// server/sources/deal-declassification.ts
//
// Gates the PUBLIC_DEAL_IDS allowlist (Defect 1b, 2026-08-04). The fail-closed default in
// mergeDeals is unchanged: an unmatched Notion deal is confidential unless this module affirms
// BOTH that it was explicitly allowlisted AND that the live confidential-terms roster does not
// claim it. The roster is the source of record for Hard Invariant 3; the allowlist can only ever
// subtract from the default, never override the roster.

import type { Deal } from '../../src/contracts/index';
import { PUBLIC_DEAL_IDS } from '../../src/data/public-deals';
import {
  loadConfidentialTerms, isPlaceholderRoster, type ConfidentialHit,
} from '../briefing/confidential';
import { egressRosterMatch } from '../briefing/roster-match';

// Re-exported for existing callers/tests; the implementation lives in ../briefing/roster-match.
export { normalizeRosterText } from '../briefing/roster-match';

/**
 * True when the roster in use is the placeholder stand-in returned (instead of throwing) under
 * CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 with the real file absent. THROWS on an unreadable roster
 * (callers catch that as "cannot verify"). Detected by identity (refute round 6, G7), no longer by
 * scanning the sentinel string, which a real term like 'Ora' or 'Confidential' also matched.
 */
const rosterIsPlaceholder = (): boolean => isPlaceholderRoster(loadConfidentialTerms());

/**
 * True only if this deal may be published. Returns false — keeping the deal confidential — for any
 * deal that is not allowlisted, that matches an active roster group, whose roster could not be read,
 * or whose roster is the placeholder stand-in.
 *
 * The catch is the fail-closed leg, not defensive noise: `scanForConfidential` loads
 * confidential-terms.json and THROWS when it is absent or unreadable, and a confidentiality gate
 * that treated an unreadable roster as "nothing is confidential" would invert the invariant.
 *
 * PLACEHOLDER REJECTION (review 2026-08-04, CRITICAL — this gate previously failed OPEN). The throw
 * is not the only way the roster can be missing. CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 makes
 * `loadTerms` return FALLBACK_TERMS instead of throwing, so the catch never fires, every real term
 * silently fails to match, and an allowlisted deal was declared publishable with the roster never
 * consulted. That env is a deliberate reduced-coverage concession for a briefing RENDER on a dev
 * box; it must not carry over to a PUBLICATION decision. Verified failing-open before this guard.
 *
 * The whole Deal is scanned, not a hand-picked field list. An earlier version scanned only
 * id/name/shortName/location/lender/owner and missed `status` and `nextAction` — the two long
 * free-text fields, which in real pipeline data carry addresses, brokers and counsel names, and
 * which bake-mirror publishes verbatim. `collectText` flattens objects, so passing the record is
 * both simpler and strictly more conservative.
 */
export function isDeclassified(deal: Deal, allowlist: readonly string[] = PUBLIC_DEAL_IDS): boolean {
  if (!allowlist.includes(deal.id)) return false;
  // Logs name the allowlist POSITION, never the deal id (a slug of the deal's name) nor the roster
  // label (refute round 5, F6): this deal may be roster-claimed, and logs are a sink.
  const entry = `PUBLIC_DEAL_IDS entry #${allowlist.indexOf(deal.id) + 1}`;
  try {
    if (rosterIsPlaceholder()) {
      console.warn(
        `[deal-declassification] the confidential roster is the PLACEHOLDER stand-in ` +
          `(CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER is set and the real file is unreadable) — refusing ` +
          `to declassify ${entry}. A publication decision must never run against a disabled roster.`,
      );
      return false;
    }
    const hit = publicationRosterScan(deal); // normalised match (refute R1)
    if (hit) {
      console.warn(
        `[deal-declassification] ${entry} still matches the ACTIVE confidential roster — keeping it ` +
          `confidential. The roster wins; remove the allowlist entry or retire the roster group ` +
          `(active:false), not both blindly.`,
      );
      return false;
    }
    return true;
  } catch (e) {
    console.warn(
      `[deal-declassification] confidential roster unreadable (${e instanceof Error ? e.message : String(e)}) ` +
        `— allowlist ignored, ${entry} stays confidential.`,
    );
    return false;
  }
}

/**
 * True when the live confidential-terms roster claims this deal — or when that cannot be ruled out.
 * The mirror image of isDeclassified for deals whose flag is already `false` (seed-matched deals,
 * whose seed flag is otherwise authoritative): the roster is the source of record for Hard
 * Invariant 3, so a seed `confidential:false` can never outrank an ACTIVE roster hit. Fails CLOSED
 * on an unreadable roster and on the placeholder stand-in, exactly as isDeclassified does.
 */
export function rosterClaimsDeal(deal: Deal): boolean {
  try {
    if (rosterIsPlaceholder()) {
      console.warn('[deal-declassification] confidential roster is the PLACEHOLDER stand-in — treating every deal as roster-claimed (fail closed).');
      return true;
    }
    // publicationRosterScan: the same strict publication-decision scan every egress gate uses
    // (it also throws on the placeholder, a second guard behind the explicit check above).
    return publicationRosterScan(deal) !== null;
  } catch (e) {
    console.warn(`[deal-declassification] confidential roster unreadable (${e instanceof Error ? e.message : String(e)}) — treating the deal as roster-claimed (fail closed).`);
    return true;
  }
}

/**
 * Roster scan for a PUBLICATION decision (anything bound for a mirror or other external surface).
 * Same matching as scanForConfidential, but strict about the roster itself: THROWS when the roster
 * is unreadable (scanForConfidential already does) AND when it is the placeholder stand-in that
 * CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 substitutes — that opt-out is a reduced-coverage concession
 * for a local briefing render and must never clear data for publication. Callers treat a throw as
 * "cannot verify" and withhold the data.
 */
export function publicationRosterScan(value: unknown): ConfidentialHit | null {
  // Same matcher and placeholder refusal as every other egress gate (refute round 3, U3): raw +
  // normalised + compact passes, throwing on an unreadable or placeholder roster.
  return egressRosterMatch(value);
}

