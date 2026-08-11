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
// mutually contradictory records for one deal (Pendleton Trade Center; 2146 Enterprise Pkwy), with
// the Notion copy additionally carrying the fail-closed confidential:true default for unmatched
// rows. The optional NOTION_DEALS_NAME_ALIASES escape hatch existed but had never been configured.
//
// WHY DETERMINISTIC AND NOT FUZZY. A wrong merge is strictly worse here than a duplicate: it
// destroys one of the two rows and can fold an unmatched (fail-closed confidential) Notion deal
// into a public seed record, which is a Hard Invariant 3 exposure. So this module only unifies an
// ANCHORED, documented naming convention, and anything short of that is surfaced by
// findNearDuplicateNames as a gate-blocking flag rather than merged on a similarity guess.

/**
 * A trailing " — City, ST" locality tail: a spaced dash separator, a locality containing NO further
 * dash of any kind, then a comma and a bare 2-letter state at the very end. Anchored deliberately
 * narrowly — a tail carrying a ZIP ("— Columbus, OH 43205"), a parenthetical
 * ("— Walker, MI (Kent County)"), a date ("— 2026-04-29") or a non-locality phrase
 * ("— Dollar General (Quasi-IOS)") is NOT a locality suffix and is left intact.
 *
 * The locality body excludes the ASCII hyphen as well as the em/en dashes. It must: the separator
 * class accepts " - ", so a body that permitted "-" would let the leftmost em dash match and swallow
 * a real name segment — "Foo — Bldg A - Indianapolis, IN" stripped all the way to "Foo", merging a
 * building-level deal into its parent. Caught in review 2026-08-04 before merge.
 */
const LOCALITY_SUFFIX = /\s+[—–-]\s+[^—–-]+,\s*[A-Za-z]{2}\s*$/;

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
 * The alias map: a Notion spelling → the seed name it should join to. Lives HERE, beside the key
 * function it modifies, because the joiner and the near-duplicate detector must resolve "same deal"
 * identically — the whole reason this module exists. Format: "From=>To" pairs separated by ';' or
 * newlines. Env-configured so a confidential deal name never lands in the repo.
 *
 * Moved out of notion-deals.ts 2026-08-11 (catch-up sweep H1): while the joiner owned the map
 * privately, findNearDuplicateNames could not see it and silently keyed on the raw name.
 */
export function parseNameAliases(
  raw: string = process.env.NOTION_DEALS_NAME_ALIASES ?? '',
): Map<string, string> {
  const m = new Map<string, string>();
  for (const pair of raw.split(/[;\n]+/)) {
    const idx = pair.indexOf('=>');
    if (idx < 0) continue;
    const from = dealJoinKey(pair.slice(0, idx));
    const to = dealJoinKey(pair.slice(idx + 2));
    if (from && to) m.set(from, to);
  }
  return m;
}

/** `dealJoinKey` with the alias map applied — the ONE key both the joiner and the detector use. */
export function aliasedJoinKey(name: string, aliases: ReadonlyMap<string, string>): string {
  const k = dealJoinKey(name);
  return aliases.get(k) ?? k;
}

/**
 * Regrowth tripwire. Returns every pair of names whose join-key token lists are in a prefix
 * relationship (equal, or one a strict prefix of the other) WITHOUT having been unified by
 * dealJoinKey.
 *
 * SCOPE — read this before trusting it. It catches TRAILING-TOKEN variance only: a name that is a
 * leading-token-sequence prefix of another ("2146 Enterprise" ⇄ "2146 Enterprise Pkwy — …"). It
 * does NOT catch abbreviation or spelling variance anywhere in the name — "Pendleton Trade Center"
 * vs "Pendleton Trade Ctr", "470 McCormick Blvd" vs "470 McCormick Boulevard", and "E. Fulton" vs
 * "East Fulton" all return nothing. Widening it to fuzzy/token-set matching was considered and
 * rejected: this feeds a GATE-BLOCKING flag, and false positives there block the build on data the
 * operator cannot fix without renaming a real asset. Narrow-and-honest beats broad-and-noisy here.
 *
 * Requiring a full leading-token-sequence match also keeps it quiet on genuinely distinct deals:
 * "100 Main St" vs "200 Main St" and "470 McCormick Blvd" vs "511 Industrial Mile Road" do not pair.
 *
 * FALSE POSITIVES ARE REAL AND HAVE AN ESCAPE HATCH. Phased and multi-building assets legitimately
 * share a prefix ("Fairground Village Center" ⇄ "Fairground Village", "… Center" ⇄ "… Center II").
 * Accept such a pair via NOTION_DEALS_ACCEPTED_NEAR_DUPES rather than renaming the asset — see
 * parseAcceptedNearDupes.
 *
 * Callers treat a non-empty result as an error, not a warning: the fix is to align the seed name
 * with Notion's, add a NOTION_DEALS_NAME_ALIASES entry, accept the pair explicitly, or disambiguate
 * two deals that genuinely share a prefix — the same "disambiguate the join key" doctrine the parse
 * layer already applies to colliding property ids.
 */
export function findNearDuplicateNames(
  names: readonly string[],
  accepted: ReadonlySet<string> = parseAcceptedNearDupes(),
  aliases: ReadonlyMap<string, string> = parseNameAliases(),
): Array<[string, string]> {
  // Alias-aware, exactly like mergeDeals' keyOf. Tokenizing the RAW key here let the joiner and this
  // detector run two different notions of "same deal" -- the state this module's header calls worse
  // than no detector: two names reaching one key only via NOTION_DEALS_NAME_ALIASES collided in the
  // joiner (both rows withheld, seed emitted unenriched) while this returned NO pair, so the gate
  // saw nothing and the snapshot published. The alias map is owned by this module and applied by
  // DEFAULT so no caller has to remember it. (Catch-up sweep 2026-07-28..08-04, H1.)
  const rows = names.map((name) => ({ name, tokens: aliasedJoinKey(name, aliases).split(' ').filter(Boolean) }));
  const pairs: Array<[string, string]> = [];
  for (let i = 0; i < rows.length; i++) {
    for (let k = i + 1; k < rows.length; k++) {
      const a = rows[i]!;
      const b = rows[k]!;
      if (!a.tokens.length || !b.tokens.length) continue;
      const [shorter, longer] = a.tokens.length <= b.tokens.length ? [a.tokens, b.tokens] : [b.tokens, a.tokens];
      if (!shorter.every((t, ix) => longer[ix] === t)) continue;
      if (accepted.has(acceptedPairKey(a.name, b.name))) continue;
      pairs.push([a.name, b.name]);
    }
  }
  return pairs;
}

/** Order-independent key for an accepted pair, so config need not guess which name comes first. */
export function acceptedPairKey(a: string, b: string): string {
  return [dealJoinKey(a), dealJoinKey(b)].sort().join('||');
}

/**
 * Operator escape hatch for a near-duplicate pair that is genuinely two different deals (phased or
 * multi-building assets that legitimately share a name prefix). Format: "Name A=>Name B" pairs
 * separated by ';' or newlines — same shape as NOTION_DEALS_NAME_ALIASES, but the opposite meaning:
 * aliases MERGE two names, this one affirms they must stay SEPARATE. Env-configured so a
 * confidential deal name never lands in the repo. Exported + injectable for tests.
 */
export function parseAcceptedNearDupes(
  raw: string = process.env.NOTION_DEALS_ACCEPTED_NEAR_DUPES ?? '',
): Set<string> {
  const out = new Set<string>();
  for (const entry of raw.split(/[;\n]+/)) {
    const idx = entry.indexOf('=>');
    if (idx < 0) continue;
    const a = entry.slice(0, idx);
    const b = entry.slice(idx + 2);
    if (dealJoinKey(a) && dealJoinKey(b)) out.add(acceptedPairKey(a, b));
  }
  return out;
}
