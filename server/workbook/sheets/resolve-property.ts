// server/workbook/sheets/resolve-property.ts
//
// Master Workbook parser: resolving a free-text property key (address or name) to a property id. Moved verbatim out of
// server/workbook/parse.ts (2026-11-24 split, no behaviour change); parse.ts re-exports its public names.
import type { Property } from '../../../src/contracts/index';

// A 2026-08-17 fix (OI-184) first tried stripping known street-suffix words ('road', 'lane', ...)
// out of the substring match, closing the ONE word that mis-tagged '3034 Westerville Road' onto
// '1900 N Broadway, Baltimore MD' ('road' is a raw substring of 'b-ROAD-way'). A same-day
// adversarial refute pass proved the denylist patched the symptom, not the mechanism: ANY-token
// RAW SUBSTRING matching with first-array-hit-wins is still an open class for every OTHER generic
// word. Executed against the real portfolio: the live rent-roll key '1900 North Broadway' matches
// Salisbury's 'Northwood Dr' on 'north' alone (a directional, not a suffix — saved only by
// Broadway's row currently sitting above Northwood's in the human-maintained Properties sheet, so
// a routine re-sort would silently retag it), and the property's OWN canonical name '3034
// Westerville Rd, Columbus OH' resolves to the WRONG Columbus property via the shared 'columbus'
// token (6 of 14 properties share a city). A denylist can only ever cover the words someone
// thought to list — 'roadway', 'pike', 'parkway', every plural — inherit the identical hole.
//
// Fix: tokenize both the key and every candidate address IDENTICALLY, require WHOLE-TOKEN
// equality (not substring — this alone kills the entire accidental-substring class, suffix,
// directional, and city alike, since 'north' as its own token never equals 'northwood' as a
// whole word), and score each candidate by matched-token count so the MOST DISTINCTIVE address
// wins instead of whichever property happens to sit first in sheet order. A tie between two
// candidates resolves to null rather than guessing — the same fail-closed shape already used by
// resolvePropertyMasterId (property-crosswalk) and ar-import-headless's explicit lookup table.
// These words name a street TYPE or a compass DIRECTION or a building UNIT rather than a specific
// place — spelled out in enough addresses across a small portfolio that, alone, they identify
// nothing ('Lane' matching Easton purely because 'lane' happens to be spelled out in exactly one
// property's address, with zero other corroborating signal; 'North' matching a Baltimore street
// that happens to share a house number with an unrelated 'North'-something address). The
// distinctiveMatch gate below uses this set to require that at least one of a candidate's matched
// words be genuinely distinctive; it never strips these words out of scoring entirely — that was
// round 1's approach, and it reopened the directional/city-token collisions rounds 1-2 exist to
// describe. A generic word can still ADD to score once a real distinctive word has already
// qualified the candidate.
const GENERIC_WORDS = new Set([
  'road', 'street', 'avenue', 'ave', 'lane', 'drive', 'court', 'boulevard', 'blvd', 'place',
  'circle', 'cir', 'highway', 'hwy', 'route', 'way', 'branch', 'plaza', 'park', 'parkway', 'pkwy',
  'trail', 'pike', 'terrace', 'square', 'loop', 'crossing',
  'north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest',
  'suite', 'ste', 'unit', 'bldg', 'building', 'apt', 'floor', 'rear',
]);

function addressTokens(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length >= 3);
}

/** All-digit tokens in `s`, extracted independently of addressTokens' length>=3 word filter — a
 *  1-2 digit house number ('55 New Plant Ct') must still arm the number-range gate below; folding
 *  digit extraction into the same length-filtered pass as words silently dropped it (refute pass,
 *  round 3: '57 New Plant Court' wrong-matched to the real '55 New Plant Ct' because its own '57'
 *  never reached keyNumbers to disqualify the mismatch). */
function numberTokens(s: string): number[] {
  const matches = s.match(/\d+/g);
  return matches ? matches.map(Number) : [];
}

export function normalizedAddress(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The property's own leading house-number-or-range: '2203-2207 Northwood Dr' -> [2203, 2207],
 *  '3034 Westerville Rd' -> [3034, 3034]. Null when the address doesn't open with a number. */
function leadingNumberRange(address: string): [number, number] | null {
  const m = address.trim().match(/^(\d+)(?:\s*-\s*(\d+))?/);
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = m[2] !== undefined ? Number(m[2]) : lo;
  return [Math.min(lo, hi), Math.max(lo, hi)];
}

/** Word tokens from everything after the address's FIRST comma — the city/state/zip tail,
 *  regardless of how many further commas it contains ('Street, City MD', 'Street, City, MD
 *  21613' both work) — derived structurally from the address text rather than a hardcoded city
 *  list, so it stays correct as the portfolio grows into new markets. A city name is exactly as
 *  non-distinctive as a street-suffix word when it is the ONLY thing a key shares with a
 *  candidate: refute pass round 3 demonstrated '401 Cambridge Ave' resolving to Sunburst (401
 *  Sunburst Hwy, Cambridge MD) purely because 'cambridge' happened to match, with the actual
 *  street name ('Sunburst') absent from the key entirely. Round 4 caught the FIRST version of
 *  this using lastIndexOf: correct only for the sheet's current single-comma convention, and
 *  silently defeated by the equally-standard 'Street, City, ST ZIP' postal format, where the
 *  city sits in the middle segment and the last-comma slice keeps only the ZIP. */
function cityTokens(address: string): Set<string> {
  const comma = address.indexOf(',');
  return new Set(comma === -1 ? [] : addressTokens(address.slice(comma + 1)));
}

/** Word tokens from the address's own STREET segment — everything before the first comma. A word
 *  that names both the street AND the city ('3034 Westerville Rd, Westerville OH' — an Ohio
 *  naming pattern this exact portfolio already uses) must not be excluded as a mere city
 *  qualifier: it is the property's own distinctive street name, and excluding it would make the
 *  property's own canonical address permanently unable to resolve any of its leases (refute pass,
 *  round 4). */
function streetTokens(address: string): Set<string> {
  const comma = address.indexOf(',');
  return new Set(addressTokens(comma === -1 ? address : address.slice(0, comma)));
}

interface PropertyAddressTokens {
  range: [number, number] | null;
  wordTokens: Set<string>;
  cityTokens: Set<string>;
  streetTokens: Set<string>;
}

/** Per-property address tokenization, cached per `properties` array. FIXED 2026-08-21
 *  (adversarial review finding): resolvePropertyId is called once per lease row (~140 rows in
 *  the live portfolio) and used to re-tokenize every property's address from scratch — 4 regex/
 *  string passes per property per call — on every one of those calls, even though property
 *  addresses are static for the whole parse run. Keyed on the `properties` array's own identity
 *  (a WeakMap, so a different array — a different parse run, a test fixture — never sees a stale
 *  cache and nothing needs manual invalidation) rather than on Property.id, since disambiguated
 *  duplicate rows already guarantee id uniqueness (see disambiguatePropertyIds). */
const propertyTokenCache = new WeakMap<Property[], Map<string, PropertyAddressTokens>>();

function propertyTokensFor(properties: Property[]): Map<string, PropertyAddressTokens> {
  const cached = propertyTokenCache.get(properties);
  if (cached) return cached;
  const table = new Map<string, PropertyAddressTokens>();
  for (const p of properties) {
    table.set(p.id, {
      range: leadingNumberRange(p.address),
      wordTokens: new Set(addressTokens(p.address).filter((t) => !/^\d+$/.test(t))),
      cityTokens: cityTokens(p.address),
      streetTokens: streetTokens(p.address),
    });
  }
  propertyTokenCache.set(properties, table);
  return table;
}

// Rent-roll property-key aliases for names that can never resolve via address-token matching
// below, because property_master carries no address text for them at all: the Sepich Portfolio
// (property id sepich-portfolio-columbus-oh-8-props) is tracked as ONE consolidated
// property_master row for its 8 physical buildings (same target detect.ts's PROPERTY_ALIASES
// already uses for the portfolio's P&L filename token 'fvc'), so a rent-roll row naming an
// individual building by its street/subdivision name has no per-building address to match
// against — same shape as detect.ts's PROPERTY_ALIASES, for the rent-roll key column instead of
// P&L filenames. "Banwick" is not a hypothetical: it is literally the token named in this
// function's own comment below as the example a bare-word match must NOT trust, confirmed live
// (cc-audit-army finding unresolved-lease-propertyid-silent, 2026-08-21) as one of the Sepich
// sub-property names actually driving 39 of 41 unresolved rent-roll rows (most of their rent).
// Only alias names with that level of direct corroboration. The 2026-08-21 pass left
// "4595 E. 5th Ave" unresolved for want of "comparable evidence"; that evidence has since been
// located in the source of record and the call is REVERSED (Gabriel directive, 2026-08-24) --
// see the E. 5th Ave note below. Keys are matched EXACTLY (trimmed + lowercased), so a future
// rent-roll rewording re-raises the reconciliation flag rather than silently mis-attributing:
// that is the intended failure mode, not a gap to paper over with fuzzy variants.
//
// E. 5TH AVE (added 2026-08-24). 'Tax Assessment Summary -- Sepich Portfolio.xlsx' enumerates
// exactly EIGHT parcels -- matching this property_master row's own "(8 props)" -- and parcel
// 010-003904-00 is literally "4595-4601 E Fifth Ave / Sepich". ONE parcel spans BOTH street
// numbers, which is why the rent roll carries two separate keys that both map here. Independently
// corroborated by the 2020 acquisition DD ('Environmental Report -- 4595 - 4601 East 5th Avenue
// 12-2020.pdf', 'survey -- 4595 - 4601 East Fifth Ave.pdf'), by the 2022 Sepich rent roll whose
// own header lists "4595 E 5th Ave" among the portfolio's properties, and by 'Billboard Lease --
// 4601 E. 5th Ave Sepich.pdf'. Note these are a DIFFERENT building from the unrelated standalone
// property '3540 E. 5th Ave, Columbus OH' on the same street -- the street-number gate below, and
// the alias's own target-must-exist check, both still prevent that mis-resolution.
// QUICKBOOKS P&L CLASS KEYS (added 2026-08-24, PR #302 review finding). server/sources/quickbooks.ts
// routes its class-name keys through this same table via resolvePropertyId, not a separate one --
// two DIFFERENT strings, both verified against the live QB export
// (QUICKBOOKS_CSV, 'ora-pl-by-property.csv'): the raw CSV's class column reads
// 'FVC - Fairground Village Center / Sepich Portfolio (8 props)' with a plain HYPHEN, while the
// already-committed data/snapshots/portfolio.json quickbooks block (a stale prior parse) carries an
// EM DASH ('FVC — ...') for the identical class -- the export apparently varies the dash on
// different QuickBooks report runs. Both forms are aliased so neither a fresh parse of the live CSV
// nor a read of the already-persisted snapshot regresses. This is the 'QB fix' the
// 2026-08-24 sweep and this PR's own commit claimed to close -- verified live: adding ONLY the
// em-dash form (matching the committed snapshot) would have left the ACTUAL next CSV parse
// unresolved, since resolvePropertyId never ran the token/number-gate path successfully for this
// key to begin with ('(8 props)' arms the street-number gate against the Sepich row, which has no
// leading house number) -- an exact alias hit is the only path that works for this key.
const RENT_ROLL_PROPERTY_ALIASES: Record<string, string> = {
  banwick: 'sepich-portfolio-columbus-oh-8-props',
  morrison: 'sepich-portfolio-columbus-oh-8-props',
  zettler: 'sepich-portfolio-columbus-oh-8-props',
  '4595 e. 5th ave': 'sepich-portfolio-columbus-oh-8-props',
  '4601 e. 5th ave': 'sepich-portfolio-columbus-oh-8-props',
  'fvc - fairground village center / sepich portfolio (8 props)': 'sepich-portfolio-columbus-oh-8-props',
  'fvc — fairground village center / sepich portfolio (8 props)': 'sepich-portfolio-columbus-oh-8-props',
  // '1851 S Club - Solar (25% roof project)' / '1851 S Club — Solar (...)' are DELIBERATELY NOT
  // aliased here: verified against the live 14-row property_master roster (2026-08-24) that no
  // property (by id, name, or address) corresponds to a '1851 S Club' or 'Solar' entity -- this QB
  // class appears to track a rooftop solar installation that was never onboarded as its own
  // property record. Aliasing it to an existing property would be a fabricated attribution (Hard
  // Invariant 7); it stays propertyId:null, honestly, until a real property_master row exists for
  // it or Gabriel rules on which existing property it should roll into.
};

export function resolvePropertyId(key: string, properties: Property[]): string | null {
  // Object.hasOwn guard (2026-08-24 integrity-sweep hygiene finding): a plain object literal
  // indexed by an untrusted string is reachable via the prototype chain for a key like
  // 'constructor'/'toString'/'valueOf' — RENT_ROLL_PROPERTY_ALIASES['constructor'] would return
  // Object's constructor function, not undefined. No real rent-roll property key collides with an
  // Object.prototype member today (this already failed CLOSED via the target-must-exist check a
  // few lines below), but the guard is one line and removes the class of bug outright rather than
  // relying on a downstream check to keep catching it.
  const normalizedKey = key.trim().toLowerCase();
  const aliased = Object.hasOwn(RENT_ROLL_PROPERTY_ALIASES, normalizedKey)
    ? RENT_ROLL_PROPERTY_ALIASES[normalizedKey]
    : undefined;
  // Every OTHER path through this function only ever returns an id actually present in
  // `properties` (see the token-matching loop below) -- the alias table must hold to that same
  // contract. Trusting the hardcoded target unconditionally would let a future rename/retirement
  // of the Sepich portfolio's id produce a dangling propertyId with NO data-quality signal at
  // all (worse than null: parseLeases' resolvedPropertyId===null flag never fires for a
  // non-null-but-wrong id).
  if (aliased !== undefined) {
    return properties.some((p) => p.id === aliased) ? aliased : null;
  }
  const keyTokenList = addressTokens(key);
  if (keyTokenList.length === 0) return null;
  const keyWordTokens = new Set(keyTokenList.filter((t) => !/^\d+$/.test(t)));
  const keyNumbers = numberTokens(key);
  // A single-token key ('Sunburst') has nothing else to require, but a multi-token key needs at
  // least two independent signals before it is trusted — one shared word alone is exactly the
  // failure the refute pass demonstrated: a hypothetical 'Banwick Lane' key would match Easton's
  // address on the bare word 'lane' with no other corroborating signal. Two matched words, or one
  // matched word plus an agreeing street number, both clear this floor; one matched word alone
  // does not.
  const floor = keyTokenList.length >= 2 ? 2 : 1;

  const tokenTable = propertyTokensFor(properties);
  const eligible: { p: Property; score: number }[] = [];
  for (const p of properties) {
    const { range, wordTokens: addrWordTokens, cityTokens: addrCityTokens, streetTokens: addrStreetTokens } =
      tokenTable.get(p.id)!;
    // A street NUMBER match is the strongest single disambiguator two addresses on the same
    // street can offer — '4595 E. 5th Ave' is a different building from '3540 E. 5th Ave,
    // Columbus OH' despite sharing every word (caught by the refute pass's differential replay:
    // word-overlap scoring alone mis-resolved the Sepich sub-address to the unrelated numbered
    // property). So when the key carries a number, a candidate whose OWN number range doesn't
    // cover it is disqualified outright, however many words overlap. A RANGE, not exact equality,
    // so a real multi-suite address ('2203-2207 Northwood Dr' housing a '2205 Northwood' lease)
    // still matches on its own street number — an exact-equality gate (an earlier version of this
    // fix) silently dropped every such lease, a regression the refute pass also caught.
    const numberMatches = range !== null && keyNumbers.some((n) => n >= range[0] && n <= range[1]);
    if (keyNumbers.length > 0 && !numberMatches) continue;

    let wordScore = 0;
    let distinctiveMatch = false;
    for (const t of keyWordTokens) {
      if (!addrWordTokens.has(t)) continue;
      wordScore++;
      // Not generic, AND (not a city word OR also the property's own street word) — a word that
      // names both the street and the city ('Westerville Rd, Westerville OH') is still the
      // property's own distinctive street name, not a mere city qualifier (refute pass, round 4).
      if (!GENERIC_WORDS.has(t) && (!addrCityTokens.has(t) || addrStreetTokens.has(t))) distinctiveMatch = true;
    }
    // At least one matched word must be genuinely distinctive — not a generic street-type word,
    // not the address's own city/state qualifier. A number match alone, or generic/city words
    // alone, corroborate a real match but must never CARRY one by themselves (refute pass, round
    // 3: a bare numeric key resolved on the range bonus with zero word evidence at all; a single
    // shared generic word resolved confidently with no other signal; a shared city word plus a
    // coincidental number resolved to the wrong street entirely).
    if (wordScore === 0 || !distinctiveMatch) continue;
    const score = wordScore + (keyNumbers.length > 0 && numberMatches ? 1 : 0);
    if (score >= floor) eligible.push({ p, score });
  }
  if (eligible.length === 0) return null;

  let best = eligible[0]!; // safe: eligible.length > 0 just checked above
  let tied = false;
  for (const c of eligible.slice(1)) {
    if (c.score > best.score) {
      best = c;
      tied = false;
    } else if (c.score === best.score && normalizedAddress(c.p.address) !== normalizedAddress(best.p.address)) {
      // Two DIFFERENT addresses tied at the same score is genuine ambiguity — fail closed. Two
      // candidates sharing the SAME normalized address are the same physical property (a
      // human-entered duplicate Properties-sheet row, which disambiguatePropertyIds already
      // suffixes with '-2' rather than merges) — keep one of them rather than nulling out every
      // one of that property's leases, a regression the refute pass caught in an earlier
      // tie-always version of this fix.
      tied = true;
    } else if (c.score === best.score) {
      // Same-address tie: pick a candidate deterministically from `properties` ARRAY CONTENT, not
      // array ORDER. FIXED 2026-08-24 (integrity sweep, Finding 9): the previous version always
      // kept whichever duplicate came first in `properties` — but that array's order need not
      // match the order disambiguatePropertyIds ran in when it decided which row kept its base
      // (non-suffixed) id, so a properties-order permutation could flip which id wins and
      // silently move the lease's rent/NOI attribution between the two Property entries. Prefer
      // the id WITHOUT a disambiguation suffix (the canonical row); if both or neither carry one,
      // fall back to the lexicographically smaller id — either branch is properties-order
      // INDEPENDENT.
      const bestHasSuffix = /-\d+$/.test(best.p.id);
      const cHasSuffix = /-\d+$/.test(c.p.id);
      if (bestHasSuffix && !cHasSuffix) best = c;
      else if (bestHasSuffix === cHasSuffix && c.p.id < best.p.id) best = c;
    }
  }
  return tied ? null : best.p.id;
}
