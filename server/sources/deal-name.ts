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

/**
 * The 2-letter state from a name's locality tail, uppercased, or null when there is no tail.
 *
 * DETECTION-SIDE SUPPRESSOR ONLY. Under the name join this was a corroboration signal — evidence
 * used to decide whether a merge was allowed to proceed — and that is exactly the role it must
 * never have again. Its only caller now is mergeDeals' published-duplicate detector, where it
 * SUPPRESSES a warning: two rows sharing a bare street name in demonstrably different states are
 * the documented steady state ("REDACTED-185" vs "— Louisville, KY"), not a
 * duplicate. Suppressing a false alarm and authorizing a merge are different powers; this has only
 * the first.
 */
/**
 * A short, stable, NON-IDENTIFYING digest of a deal-join key, for flag text that would otherwise
 * carry a deal NAME.
 *
 * Moved here 2026-08-13 (code review) from server/sources/notion-deals.ts, where its own doc
 * comment claimed exactly ONE caller needed it — already stale at two call sites there, and now a
 * third exists (checkSnapshot, server/reconcile-runtime.ts) reachable via the COMMITTED-snapshot
 * CI path that has no console.warn to log the real name beside it. Living beside dealJoinKey
 * rather than duplicated per caller keeps "how do we reference a name-derived key safely" answered
 * once.
 *
 * dataQuality flags reach the PUBLIC brain.oxfordra.net payload (scripts/bake-mirror.ts) and
 * redactConfidential does NOT sweep them regardless of `entity` — verified against the live code
 * 2026-08-13, not assumed: its own comment says "dataQuality is parser-emitted" and it sweeps only
 * dealComps/acquisitionInputs/tenantNotes. Embedding a duplicated CONFIDENTIAL deal's name in any
 * flag text is therefore a Hard Invariant 3 exposure. Prefer `Deal.notionDealId` where available —
 * opaque and non-identifying by construction — and fall back to this digest only when it is null.
 * FNV-1a rather than node:crypto so this module stays safe for any bundle that reaches it.
 */
export function keyDigest(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

export function localityStateOf(name: string): string | null {
  const m = LOCALITY_SUFFIX.exec(name);
  if (!m) return null;
  const st = /([A-Za-z]{2})\s*$/.exec(m[0]);
  return st ? st[1]!.toUpperCase() : null;
}

/**
 * Groups of 2+ rows sharing one normalized name that were never joined onto each other — the
 * always-on published-duplicate backstop.
 *
 * SHARED by two callers that must judge "same deal" identically: mergeDeals (over its freshly
 * merged output) and checkSnapshot (over the COMMITTED, POST-MERGE snapshot, reachable via
 * scripts/reconcile-snapshot.ts's `npm run gate:ci` path — zero Notion I/O, zero call into
 * mergeDeals). A merge conflict, a hand-edit, or a future writer bug can introduce two rows for
 * one deal without ever going through mergeDeals at all; checkSnapshot's own CI gate exists
 * PRECISELY to catch corruption independent of how the file was produced (its header cites the
 * 2026-08-03 phantom-vacancy-lease incident that shipped under exactly that kind of blind spot).
 * A second, code-review-caught instance of the "detector diverges from the joiner" trap this
 * module's own header already warns about — this time not a stale key function, but the detector
 * existing in only ONE of two reachable code paths. One function, two call sites, closes it for
 * both. (Independent code review, 2026-08-13 — HIGH.)
 *
 * Cross-metro namesakes are suppressed: two rows that both carry a locality tail, both name a
 * state, and disagree on every state, are the documented steady state (a bare street name
 * repeating across metros — "REDACTED-185" vs "— Louisville, KY"), not a
 * duplicate. A row with NO tail cannot establish distinctness, so it never suppresses.
 */
export function findDuplicateDealRows<T extends { id: string; name: string; notionDealId: string | null }>(
  rows: readonly T[],
): Array<{ key: string; rows: T[] }> {
  const byName = new Map<string, T[]>();
  for (const d of rows) {
    const key = dealJoinKey(d.name);
    if (!key) continue;
    const bucket = byName.get(key);
    if (bucket) bucket.push(d);
    else byName.set(key, [d]);
  }
  const groups: Array<{ key: string; rows: T[] }> = [];
  for (const [key, group] of byName) {
    if (group.length < 2) continue;
    const states = group.map((r) => localityStateOf(r.name));
    const known = states.filter((st): st is string => st !== null);
    // Suppress ONLY when every row names a state and all of them differ. A missing tail cannot
    // establish distinctness, so it never suppresses.
    if (known.length === group.length && new Set(known).size === group.length) continue;
    groups.push({ key, rows: group });
  }
  return groups;
}
