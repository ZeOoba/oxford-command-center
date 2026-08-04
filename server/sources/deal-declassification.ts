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
 * The identifying text a confidentiality scan must see. Deliberately more than the name: an address
 * or a lender can identify a deal on its own, and confidential-terms.json carries address- and
 * counterparty-level terms (street numbers, ownership entities) precisely for that reason.
 */
function identifyingText(deal: Deal): string {
  return [deal.id, deal.name, deal.shortName, deal.location, deal.lender, deal.owner]
    .filter((s): s is string => typeof s === 'string' && s.length > 0)
    .join(' ');
}

/**
 * True only if this deal may be published. Returns false — keeping the deal confidential — for any
 * deal that is not allowlisted, that matches an active roster group, or whose roster could not be
 * read. The catch is the fail-closed leg, not defensive noise: `scanForConfidential` loads
 * confidential-terms.json and THROWS when it is absent or unreadable, and a confidentiality gate
 * that treated an unreadable roster as "nothing is confidential" would invert the invariant.
 */
export function isDeclassified(deal: Deal, allowlist: readonly string[] = PUBLIC_DEAL_IDS): boolean {
  if (!allowlist.includes(deal.id)) return false;
  try {
    const hit = scanForConfidential(identifyingText(deal));
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
