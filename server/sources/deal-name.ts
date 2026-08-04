// server/sources/deal-name.ts
//
// Deal-name normalization shared by the Notion merge (server/sources/notion-deals.ts) and the
// runtime reconciler (server/reconcile-runtime.ts). It lives in its own module precisely so those
// two cannot drift: the adapter decides what MERGES and the reconciler decides what gets FLAGGED,
// and a detector running a different notion of "same deal" than the joiner is worse than no
// detector at all.
//
// BACKGROUND (2026-08-04). Notion's Acquisition Pipeline Tracker names rows
// "<Deal Name> — <City>, <ST>"; src/data/seed-deals.ts uses the bare deal name. Nothing bridged the
// two, so `mergeDeals` failed to match and emitted BOTH the seed row and the Notion row — two
// mutually contradictory records for one deal (REDACTED-340; REDACTED-367), with
// the Notion copy additionally carrying the fail-closed confidential:true default for unmatched
// rows. The optional NOTION_DEALS_NAME_ALIASES escape hatch existed but had never been configured.
//
// WHY DETERMINISTIC AND NOT FUZZY. A wrong merge is strictly worse here than a duplicate: it
// destroys one of the two rows and can fold an unmatched (fail-closed confidential) Notion deal
// into a public seed record, which is a Hard Invariant 3 exposure. So this module only unifies an
// ANCHORED, documented naming convention, and anything short of that is surfaced by
// findNearDuplicateNames as a gate-blocking flag rather than merged on a similarity guess.

/**
 * A trailing " — City, ST" locality tail: a spaced dash separator, a locality containing no further
 * dash, then a comma and a bare 2-letter state at the very end. Anchored deliberately narrowly —
 * a tail carrying a ZIP ("— Columbus, OH 43205"), a parenthetical ("— Walker, MI (Kent County)"),
 * a date ("— 2026-04-29") or a non-locality phrase ("— Dollar General (Quasi-IOS)") is NOT a
 * locality suffix and is left intact.
 */
const LOCALITY_SUFFIX = /\s+[—–-]\s+[^—–]+,\s*[A-Za-z]{2}\s*$/;

/** Strips Notion's "<Deal Name> — <City>, <ST>" tail. Never returns an empty string. */
export function stripLocalitySuffix(name: string): string {
  const stripped = name.replace(LOCALITY_SUFFIX, '').trim();
  return stripped || name;
}

/** The canonical seed↔Notion match key: locality-stripped, lowercased, punctuation-collapsed. */
export function dealJoinKey(name: string): string {
  return stripLocalitySuffix(name)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/**
 * Regrowth tripwire. Returns every pair of names whose join-key token lists are in a prefix
 * relationship (equal, or one a strict prefix of the other) WITHOUT having been unified by
 * dealJoinKey — i.e. two rows that a human would read as the same deal but the joiner did not
 * merge. Requiring a full leading-token-sequence match (not a shared first token, not a fuzzy
 * distance) keeps this quiet on genuinely distinct deals: "100 Main St" vs "200 Main St" and
 * "REDACTED-401" vs "REDACTED-293" do not pair.
 *
 * Callers treat a non-empty result as an error, not a warning: the fix is to align the seed name
 * with Notion's, add a NOTION_DEALS_NAME_ALIASES entry, or disambiguate two deals that genuinely
 * share a name prefix — the same "disambiguate the join key" doctrine the parse layer already
 * applies to colliding property ids.
 */
export function findNearDuplicateNames(names: readonly string[]): Array<[string, string]> {
  const rows = names.map((name) => ({ name, tokens: dealJoinKey(name).split(' ').filter(Boolean) }));
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < rows.length; i++) {
    for (let k = i + 1; k < rows.length; k++) {
      const a = rows[i]!;
      const b = rows[k]!;
      if (!a.tokens.length || !b.tokens.length) continue;
      const [shorter, longer] = a.tokens.length <= b.tokens.length ? [a.tokens, b.tokens] : [b.tokens, a.tokens];
      if (shorter.every((t, ix) => longer[ix] === t)) pairs.push([a.name, b.name]);
    }
  }
  return pairs;
}
