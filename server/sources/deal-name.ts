// server/sources/deal-name.ts
//
// Deal-name normalization. As of 2026-08-12 this is a DETECTOR ONLY — nothing here decides what
// merges.
//
// HISTORY, because the scar tissue is the point. This module used to own the seed↔Notion join key:
// `dealJoinKey` stripped Notion's "<Deal Name> — <City>, <ST>" tail, lowercased, and collapsed
// punctuation, and `mergeDeals` merged two rows whose keys were equal. Notion's locality tail exists
// PRECISELY because bare street names repeat across metros, so that key deleted the only
// disambiguator the join had — and confidentiality rides on the join, because a wrong merge folds an
// unmatched (fail-closed confidential) row into a public seed record: Hard Invariant 3.
//
// Four adversarial passes over 2026-08-11/12 found, in this subsystem alone: a CRITICAL cross-side
// wrong merge with executed repros; an alias path that bypassed the guard written to contain it;
// corroboration that was inert for the MAJORITY of live rows; and an acceptance key that was
// degenerate for exactly the collisions it gated. Each fix bolted on another corroborating signal.
// Three of them shared one shape — a guard stated over a MECHANISM instead of the INVARIANT — and
// that kept recurring for a reason no amount of care would have fixed: "same deal" has no ground
// truth in a name.
//
// The join now uses Notion's native Unique ID (`Deal.notionDealId`), which is opaque, assigned by
// Notion, and read-only at the source. See server/sources/notion-deals.ts and
// docs/superpowers/plans/2026-08-12-deal-id-join.md.
//
// RETIRED with the name join, and deliberately NOT ported: NOTION_DEALS_NAME_ALIASES,
// NOTION_DEALS_ACCEPTED_NEAR_DUPES, parseNameAliases, aliasedJoinKey, acceptedPairKey,
// acceptedCollisionKey, parseAcceptedNearDupes, parseAcceptedCollisions, localityStateOf, and
// findNearDuplicateNames. Every one of them existed to shore up a key that could not carry the
// weight; an opaque id needs no aliases, no acceptance hatches, and no corroboration. If you find
// yourself adding a "just one more signal" here, that is the smell this change was made to remove.
//
// WHAT SURVIVES, AND WHY ONLY THIS. `mergeDeals` needs to tell an operator "you forgot to mirror a
// Deal ID" — a seed and a live row that are plainly the same asset but share no id. That is a
// DETECTION question, where a name is legitimate evidence and a false positive costs a warning
// rather than a wrong merge. Names must never again decide what joins.

/**
 * A trailing " — City, ST" locality tail: a spaced dash separator, a locality containing NO further
 * dash of any kind, then a comma and a bare 2-letter state at the very end. Anchored deliberately
 * narrowly — a tail carrying a ZIP ("— Columbus, OH 43205"), a parenthetical
 * ("— Walker, MI (Kent County)"), a date ("— 2026-04-29") or a non-locality phrase
 * ("— Dollar General (Quasi-IOS)") is NOT a locality suffix and is left intact.
 *
 * The locality body excludes the ASCII hyphen as well as the em/en dashes. It must: the separator
 * class accepts " - ", so a body that permitted "-" would let the leftmost em dash match and swallow
 * a real name segment — "Foo — Bldg A - Indianapolis, IN" stripped all the way to "Foo". When this
 * fed the joiner that merged a building-level deal into its parent (caught in review 2026-08-04);
 * it now only costs a spurious tripwire warning, but the anchoring is still correct and cheap.
 */
const LOCALITY_SUFFIX = /\s+[—–-]\s+[^—–-]+,\s*[A-Za-z]{2}\s*$/;

/** Strips Notion's "<Deal Name> — <City>, <ST>" tail. Never returns an empty string. */
export function stripLocalitySuffix(name: string): string {
  const stripped = name.replace(LOCALITY_SUFFIX, '').trim();
  return stripped || name;
}

/**
 * Normalized comparison form of a deal name: locality-stripped, lowercased, punctuation-collapsed.
 *
 * NOT A JOIN KEY. Two names sharing this value are a REASON TO WARN, never grounds to merge — the
 * whole point of the id join is that this function can no longer move data between records. Its one
 * caller is mergeDeals' migration tripwire.
 */
export function dealJoinKey(name: string): string {
  return stripLocalitySuffix(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}
