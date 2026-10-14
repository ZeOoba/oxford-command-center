// server/sources/deal-declassification.ts
//
// Gates the PUBLIC_DEAL_IDS allowlist (Defect 1b, 2026-08-04). The fail-closed default in
// mergeDeals is unchanged: an unmatched Notion deal is confidential unless this module affirms
// BOTH that it was explicitly allowlisted AND that the live confidential-terms roster does not
// claim it. The roster is the source of record for Hard Invariant 3; the allowlist can only ever
// subtract from the default, never override the roster.

import type { Deal } from '../../src/contracts/index';
import { PUBLIC_DEAL_IDS } from '../../src/data/public-deals';
import { scanForConfidential } from '../briefing/confidential';

/**
 * The sentinel term carried by `confidential.ts`'s FALLBACK_TERMS — the placeholder roster returned
 * (instead of throwing) when CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 is set and the real file is
 * absent. Probing for it is how we detect that we are scanning against a roster with NO real terms.
 * `loadTerms` is not exported, so this probe is the available seam.
 */
const PLACEHOLDER_SENTINEL = '__ora_confidential_placeholder__';

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
  try {
    if (scanForConfidential(PLACEHOLDER_SENTINEL)) {
      console.warn(
        `[deal-declassification] the confidential roster is the PLACEHOLDER stand-in ` +
          `(CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER is set and the real file is unreadable) — refusing ` +
          `to declassify ${deal.id}. A publication decision must never run against a disabled roster.`,
      );
      return false;
    }
    const hit = scanForConfidential(deal);
    if (hit) {
      console.warn(
        `[deal-declassification] ${deal.id} is on PUBLIC_DEAL_IDS but still matches the ACTIVE ` +
          `confidential roster (${hit.dealLabel}) — keeping it confidential. The roster wins; ` +
          `remove the allowlist entry or retire the roster group (active:false), not both blindly.`,
      );
      return false;
    }
    return true;
  } catch (e) {
    console.warn(
      `[deal-declassification] confidential roster unreadable (${e instanceof Error ? e.message : String(e)}) ` +
        `— allowlist ignored, ${deal.id} stays confidential.`,
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
    if (scanForConfidential(PLACEHOLDER_SENTINEL)) return true;
    return scanForConfidential(deal) !== null;
  } catch {
    return true;
  }
}

/**
 * True when the confidential roster cannot be relied on at all: unreadable/absent (the scan throws)
 * or the placeholder stand-in (CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 with no real file). The
 * publication-boundary counterpart of the per-deal checks above -- used by writers that must refuse
 * outright rather than decide per deal, and by the aggregate `deals / confidential-roster` flag.
 */
export function rosterUnavailable(): boolean {
  try {
    return scanForConfidential(PLACEHOLDER_SENTINEL) !== null;
  } catch {
    return true;
  }
}
