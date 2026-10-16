// server/briefing/roster-core.ts
//
// The runtime-agnostic core of the roster matcher (refute round 5, F2): normalisation and the
// raw + normalised + compact + sibling-join passes, against a roster passed IN. No runtime import
// (node:fs / node:os live in confidential.ts, the loader), so the SAME matcher runs in the Node
// server (server/briefing/roster-match.ts, which loads the roster and re-exports this) and in the
// Cloudflare Pages Function (functions/api/ai.ts, which builds its terms from the baked snapshot).
// Moved verbatim from roster-match.ts; combinedScan is exported as matchRosterTerms.
import type { ConfidentialHit, DealTerms } from './confidential';

/** Builds a character class from code points / inclusive ranges (keeps the source ASCII-only). */
function charClass(parts: Array<number | [number, number]>): string {
  const hex = (n: number) => `\\u${n.toString(16).padStart(4, '0')}`;
  return parts.map((p) => (Array.isArray(p) ? `${hex(p[0])}-${hex(p[1])}` : hex(p))).join('');
}

/** Blank-rendering letters/symbols that LOOK like a space: Hangul fillers (U+3164, U+115F, U+1160,
 *  halfwidth U+FFA0) and the braille blank (U+2800). Mapped to a space BEFORE the ignorable strip
 *  below (the Hangul fillers are themselves Default_Ignorable, and deleting them would glue words). */
const BLANK_AS_SPACE = new RegExp(`[${charClass([0x0085, 0x115f, 0x1160, 0x2800, 0x3164, 0xffa0])}]`, 'g');
/** Everything that renders as nothing (refute S2): every Default_Ignorable_Code_Point (zero-width
 *  chars, variation selectors, CGJ, tag characters, ...) and every format char \p{Cf} (soft hyphen,
 *  bidi embeddings/overrides/isolates, Arabic letter mark, BOM, ...). Refute round 6, G2: also every
 *  control character \p{Cc} EXCEPT tab, LF, VT, FF and CR (whitespace, collapsed to a space below)
 *  and NEL U+0085 (a line break, mapped to a space by BLANK_AS_SPACE above), every private-use
 *  character \p{Co} and every lone surrogate \p{Cs}: "Heron<DEL>moor", "Heron<NUL>moor",
 *  "Heron<U+E000>moor" read as "heronmoor". Refute round 7, H5: also every unassigned code point
 *  and noncharacter \p{Cn} ("Heron<U+FDD0>moor", "Heron<U+0378>moor"). "Unassigned" is per the
 *  running engine's Unicode version; stripping a character a newer version assigns is a fail-closed
 *  over-match, never a leak. */
const INVISIBLE = new RegExp(
  `[\\p{Default_Ignorable_Code_Point}\\p{Cf}\\p{Co}\\p{Cs}\\p{Cn}${charClass([[0x00, 0x08], [0x0e, 0x1f], [0x7f, 0x84], [0x86, 0x9f]])}]`,
  'gu',
);
/** Letter-like SYMBOLS with no Unicode decomposition (refute round 6, G2), which would otherwise be
 *  \p{So} separators: negative circled (U+1F150..), negative squared (U+1F170..) and regional
 *  indicator (U+1F1E6..) Latin letters, each a contiguous A..Z run, folded to a..z. (Circled,
 *  squared and parenthesised letters already fold under NFKC.)
 *  Pinned (refute round 7, H5): a flag emoji is a regional-indicator PAIR and folds to its two
 *  letters (U+1F1FA U+1F1F8 -> 'us'), exactly as if the letters were typed. That adds no false-
 *  positive path the typed letters do not already have (it can only complete a term carrying that
 *  same two-letter token, and an over-match refuses, never leaks), while NOT folding would let a
 *  name spelt in regional indicators pass. Deliberately kept. */
const LETTER_SYMBOL_RUNS = [0x1f150, 0x1f170, 0x1f1e6];
const LETTER_SYMBOLS = /[\u{1F150}-\u{1F169}\u{1F170}-\u{1F189}\u{1F1E6}-\u{1F1FF}]/gu;
function letterSymbolFold(ch: string): string {
  const c = ch.codePointAt(0) ?? 0;
  const base = LETTER_SYMBOL_RUNS.find((b) => c >= b && c < b + 26);
  return base === undefined ? ch : String.fromCharCode(0x61 + c - base);
}
/** Circled / dingbat digits with NO compatibility decomposition (refute round 7, H5), which would
 *  otherwise stay \p{No} symbols: negative circled 11..20 (U+24EB..), double circled 1..10
 *  (U+24F5..), negative circled zero (U+24FF), the three dingbat circled 1..10 runs (U+2776..U+2793)
 *  and the dingbat circled sans-serif zero / negative zero (U+1F10B, U+1F10C). Mapped to ASCII with
 *  no spaces, exactly as NFKC already folds the decomposable circled / parenthesised / full-stop
 *  digits (U+2460..U+249B, U+24EA; circled one -> '1'). */
const DINGBAT_DIGITS = new RegExp(`[${charClass([[0x24eb, 0x24ff], [0x2776, 0x2793]])}\\u{1F10B}\\u{1F10C}]`, 'gu');
function dingbatDigitFold(ch: string): string {
  const c = ch.codePointAt(0) ?? 0;
  if (c >= 0x24eb && c <= 0x24f4) return String(c - 0x24eb + 11);
  if (c >= 0x24f5 && c <= 0x24fe) return String(c - 0x24f5 + 1);
  if (c >= 0x2776 && c <= 0x2793) return String(((c - 0x2776) % 10) + 1);
  return '0'; // U+24FF, U+1F10B, U+1F10C
}
/** Every combining mark \p{M} (refute round 4 W3, widened in round 5 F5(a) from \p{Mn}): nonspacing,
 *  spacing (Mc) and enclosing (Me) marks, stripped after an NFD pass so a precomposed accent, a
 *  stray combining mark, an enclosing circle or an Indic spacing sign all fold to the base letter.
 *  Over-strips Indic vowel signs: a fail-closed over-match, never a leak. Single character class:
 *  linear, no backtracking. */
const COMBINING_MARKS = /\p{M}/gu;
/** Letters with NO Unicode decomposition, so NFD + mark strip cannot fold them (refute round 5,
 *  F5(a)): applied after lowercasing, so only the lowercase forms are listed. Also maps the
 *  modifier-letter apostrophes / primes (U+02B9-U+02BD, category Lm, so not caught by SEPARATORS)
 *  to a space, as an ASCII apostrophe already is. */
const FOLD_TABLE: Array<[number, string]> = [
  [0x00df, 'ss'], [0x00e6, 'ae'], [0x00f0, 'd'], [0x00f8, 'o'], [0x00fe, 'th'], [0x0111, 'd'],
  [0x0127, 'h'], [0x0131, 'i'], [0x0138, 'k'], [0x0142, 'l'], [0x014b, 'n'], [0x0153, 'oe'],
  [0x0167, 't'], [0x0180, 'b'], [0x0192, 'f'], [0x01b6, 'z'], [0x01e5, 'g'], [0x0225, 'z'],
  [0x0237, 'j'], [0x023c, 'c'], [0x0247, 'e'], [0x0249, 'j'], [0x024d, 'r'], [0x024f, 'y'],
  [0x0268, 'i'], [0x0289, 'u'],
  // Refute round 6, G2: the Latin small capital letters (IPA Extensions, Phonetic Extensions,
  // Latin Extended-D). Lowercase (Ll) already, and with no decomposition.
  [0x1d00, 'a'], [0x0299, 'b'], [0x1d04, 'c'], [0x1d05, 'd'], [0x1d07, 'e'], [0xa730, 'f'],
  [0x0262, 'g'], [0x029c, 'h'], [0x026a, 'i'], [0x1d0a, 'j'], [0x1d0b, 'k'], [0x029f, 'l'],
  [0x1d0d, 'm'], [0x0274, 'n'], [0x1d0f, 'o'], [0x1d18, 'p'], [0xa7af, 'q'], [0x0280, 'r'],
  [0xa731, 's'], [0x1d1b, 't'], [0x1d1c, 'u'], [0x1d20, 'v'], [0x1d21, 'w'], [0x028f, 'y'],
  [0x1d22, 'z'], [0x1d01, 'ae'], [0x1d0c, 'l'], [0x0276, 'oe'],
  [0x02b9, ' '], [0x02ba, ' '], [0x02bb, ' '], [0x02bc, ' '], [0x02bd, ' '],
];
const FOLD_MAP = new Map(FOLD_TABLE.map(([c, r]) => [String.fromCodePoint(c), r]));
const FOLD_LETTERS = new RegExp(`[${charClass(FOLD_TABLE.map(([c]) => c))}]`, 'g');
/** Decimal digits of any script other than ASCII (refute round 5, F5(b)). NFKC already folds
 *  full-width and mathematical digits; this catches Arabic-Indic, Devanagari, Bengali, Thai, ... */
const NON_ASCII_DIGIT = /[^\P{Nd}0-9]/gu;
const DECIMAL_DIGIT = /^\p{Nd}$/u;
const digitCache = new Map<string, string>();
/** ASCII value of a \p{Nd} character. Unicode encodes every decimal digit set as a contiguous 0..9
 *  run, so the value is the distance from the start of the contiguous Nd stretch, mod 10 (adjacent
 *  runs, e.g. the mathematical digits, are whole multiples of 10). Memoised per character. */
function asciiDigit(ch: string): string {
  const hit = digitCache.get(ch);
  if (hit !== undefined) return hit;
  const c = ch.codePointAt(0) ?? 0;
  let start = c;
  while (start > 0 && DECIMAL_DIGIT.test(String.fromCodePoint(start - 1))) start--;
  const v = String((c - start) % 10);
  digitCache.set(ch, v);
  return v;
}
/** Every punctuation and symbol character is a separator (refute S2), not an explicit list. */
const SEPARATORS = /[\p{P}\p{S}]/gu;
/** Hyphen / Unicode hyphen / non-breaking hyphen / soft hyphen at a line end (PDF hyphenation,
 *  refute U1). Applied AFTER NFKC (refute round 5, F5(f)), so the full-width and small hyphen-minus
 *  (U+FF0D, U+FE63) fold to '-' first and are rejoined too. The hyphen, any trailing spaces/tabs/CR,
 *  the newline and the next line's leading whitespace are removed so the word rejoins. Unambiguous
 *  classes: linear, no catastrophic backtracking. */
const LINE_END_HYPHEN_SRC = `[-${charClass([0x00ad, 0x2010, 0x2011])}][ \\t\\r]*\\n\\s*`;
const LINE_END_HYPHEN = new RegExp(LINE_END_HYPHEN_SRC, 'g');
const HAS_LINE_END_HYPHEN = new RegExp(LINE_END_HYPHEN_SRC);
/** Compact pass threshold (refute U1): only terms whose compact form is at least this long are
 *  matched with every space removed on plain word alignment, so short terms cannot spuriously
 *  appear inside unrelated text. Shorter terms, and short-token terms with no letter, use the
 *  stricter sub-token alignment (see usesPlainCompact, compactSubtokenHit). */
export const COMPACT_MIN_LENGTH = 6;

/** Separator handling for finishNormalize: ' ' maps punctuation/symbols to a space (the canonical
 *  form); '' deletes them (the "separators removed" term variant of refute round 5, F5(c)). */
type SepMode = ' ' | '';

/** Printable ASCII plus tab / LF / CR: NFKC, NFD, the mark strip, the fold table, the digit map,
 *  NFC, the blank map and the invisible strip are all identities on it, so it skips them (a pure
 *  performance path with identical output; keeps many-leaf and multi-MB scans fast). */
const PLAIN_ASCII = /^[\x20-\x7e\t\n\r]*$/;

/** Bounded ICU normalisation (refute wf_fb340eb2, P2). ICU's canonical reordering is quadratic in
 *  the length of a run of non-starters, and the sibling join / stream concatenation glue separately
 *  capped strings into one: a ~44K-character combining-mark body cost 10-18 s of event loop (30 s of
 *  edge CPU). Strings longer than NORMALIZE_RUN_CAP are normalised in pieces of ~NORMALIZE_PIECE
 *  UTF-16 units, cut only BEFORE a code point that can neither reorder with nor compose with what
 *  precedes it under any of NFC / NFD / NFKC / NFKD, so the result is IDENTICAL to normalising the
 *  whole string (pinned by a seeded test against String.prototype.normalize). UNSAFE_CUT lists
 *  every code point that is NOT such a cut point (generated from the running ICU 78 / Unicode 17
 *  data, checked exhaustively):
 *   - every mark \p{M} (every non-starter is one, except the two below);
 *   - U+FF9E / U+FF9F (halfwidth katakana voiced marks: non-starters under NFKD);
 *   - every non-mark that is the SECOND element of a canonical composition (Hangul V / T jamo
 *     U+1161-U+1175, U+11A8-U+11C2; Kirat Rai U+16D67), and every code point whose NFD / NFKD
 *     starts with one of these or with a mark (Thai / Lao SARA AM, compatibility and halfwidth
 *     jamo, U+16D68).
 *  A run of more than NORMALIZE_RUN_CAP units with no cut point (only a hostile input carries one:
 *  thousands of consecutive combining marks) FAILS CLOSED with ScanBudgetError, which every gate
 *  treats as a block / refusal. Ordinary text has a cut point every few characters. */
const NORMALIZE_PIECE = 512;
export const NORMALIZE_RUN_CAP = 2048;
const UNSAFE_CUT = new RegExp(
  `[\\p{M}${charClass([
    0x0e33, 0x0eb3, [0x1161, 0x1175], [0x11a8, 0x11c2], 0x3133, [0x3135, 0x3136], [0x313a, 0x313f],
    [0x314f, 0x3163], [0xff9e, 0xff9f], 0xffa3, [0xffa5, 0xffa6], [0xffaa, 0xffaf], [0xffc2, 0xffc7],
    [0xffca, 0xffcf], [0xffd2, 0xffd7], [0xffda, 0xffdc],
  ])}\\u{16D67}\\u{16D68}]`,
  'uy',
);
/** May a piece end before index `j` (j a code-unit index into s, 0 < j < s.length)? */
function cutSafe(s: string, j: number): boolean {
  const c = s.charCodeAt(j);
  if (c >= 0xdc00 && c <= 0xdfff) return false; // never split a surrogate pair
  UNSAFE_CUT.lastIndex = j;
  return !UNSAFE_CUT.test(s);
}
export type NormForm = 'NFC' | 'NFD' | 'NFKC' | 'NFKD';
/** s.normalize(form), in exact pieces (see above); charges s.length to `budget` when one is given. */
export function normalizeBounded(s: string, form: NormForm, budget?: ScanBudget): string {
  budget?.text(s.length);
  const n = s.length;
  if (n <= NORMALIZE_RUN_CAP) return s.normalize(form);
  const out: string[] = [];
  let i = 0;
  while (i < n) {
    let j = i + NORMALIZE_PIECE;
    if (j >= n) j = n;
    else if (!cutSafe(s, j)) {
      // Back up to the last cut point inside the piece, else run forward to the end of the run.
      let k = j - 1;
      while (k > i && !cutSafe(s, k)) k--;
      if (k > i) j = k;
      else {
        k = j + 1;
        while (k < n && !cutSafe(s, k)) {
          if (k - i > NORMALIZE_RUN_CAP) throw new ScanBudgetError();
          k++;
        }
        if (k - i > NORMALIZE_RUN_CAP + 1) throw new ScanBudgetError();
        j = k;
      }
    }
    out.push(s.slice(i, j).normalize(form));
    i = j;
  }
  return out.join('');
}

/** NFKC, skipped for plain ASCII (an identity there). The normalised characters are charged to
 *  `budget` (the matcher's scan budget) when one is given: one charge per string normalised, for
 *  the NFKC, NFD and NFC passes together. */
const nfkcOf = (s: string, budget?: ScanBudget): string => (PLAIN_ASCII.test(s) ? s : normalizeBounded(s, 'NFKC', budget));

/** Every stage after NFKC (+ optional line-end rejoin). */
function finishNormalize(nfkc: string, rejoin: boolean, sep: SepMode = ' '): string {
  const t = (rejoin ? nfkc.replace(LINE_END_HYPHEN, '') : nfkc).toLowerCase();
  if (PLAIN_ASCII.test(t)) return t.replace(SEPARATORS, sep).replace(/\s+/g, ' ').trim();
  return normalizeBounded(
    // Accent fold (refute round 4 W3; round 5 F5(a)): decompose, drop every combining mark, fold
    // the letters that have no decomposition, map non-ASCII decimal digits, recompose.
    normalizeBounded(t, 'NFD')
      .replace(COMBINING_MARKS, '')
      .replace(FOLD_LETTERS, (ch) => FOLD_MAP.get(ch) ?? ch)
      .replace(NON_ASCII_DIGIT, asciiDigit),
    'NFC',
  )
    .replace(LETTER_SYMBOLS, letterSymbolFold)
    .replace(DINGBAT_DIGITS, dingbatDigitFold)
    .replace(BLANK_AS_SPACE, ' ')
    .replace(INVISIBLE, '')
    .replace(SEPARATORS, sep)
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Canonical form for roster matching: NFKC (full-width / compatibility forms fold to ASCII, NBSP and
 * the ideographic space to a space), PDF line-end hyphenation rejoined, lowercased, combining marks
 * stripped (NFD, strip \p{M}), letters without a decomposition folded (l-stroke, o-slash, dotless
 * i, sharp s, ae, oe, thorn, eth, ...), every script's decimal digits mapped to ASCII, blank-
 * rendering fillers mapped to a space, ignorable and format characters removed, every
 * punctuation/symbol mapped to a space, and every whitespace run collapsed to one space. Applied to
 * haystack AND terms. Known, accepted consequence: a term can match across a sentence boundary
 * ("9900. Quarry") — a fail-closed over-match, never a leak.
 *
 * Also (refute round 6, G2): control characters other than tab/LF/VT/FF/CR stripped (NEL is a
 * space), private-use characters and lone surrogates stripped, Latin small capitals and the
 * regional-indicator / negative squared / negative circled letters folded to ASCII. Refute round 7,
 * H5: unassigned code points and noncharacters stripped, undecomposable circled / dingbat digits
 * mapped to ASCII digits.
 *
 * ACCEPTED LIMITS (refute round 5, F5; deliberately NOT implemented): Cyrillic / Greek homoglyph
 * confusables (a Cyrillic letter that looks like a Latin one) are not folded, and URL-encoded,
 * HTML-entity-encoded or base64-encoded text is not decoded. Either defeats every pass.
 * Also accepted (refute round 7, H6): keyDigest (server/sources/deal-name.ts), used in logs, is an
 * unkeyed 32-bit FNV-1a, so a digest of a guessable name can be confirmed offline; the same digests
 * already appear in public data-quality flags, so a log line adds no new exposure. Not changed.
 */
export function normalizeRosterText(s: string): string {
  return finishNormalize(nfkcOf(s), true);
}

/** normalizeRosterText charging the matcher's scan budget (P2). */
function normText(s: string, budget: ScanBudget): string {
  return finishNormalize(nfkcOf(s, budget), true);
}

/** Both line-end forms of one string (refute round 5, F5(f)): the rejoined form, plus the NON-
 *  rejoined form when the text actually has a line-end hyphen (a real compound hyphen that happens
 *  to fall at a line end must not glue two words together). The scan ORs across both. */
function normalizedForms(s: string, budget: ScanBudget): string[] {
  const nfkc = nfkcOf(s, budget);
  const joined = finishNormalize(nfkc, true);
  if (!HAS_LINE_END_HYPHEN.test(nfkc)) return [joined];
  const split = finishNormalize(nfkc, false);
  return split === joined ? [joined] : [joined, split];
}

export function normalizeTerms(terms: Record<string, DealTerms>): Record<string, DealTerms> {
  const norm = (xs: string[] | undefined) => (xs ?? []).map(normalizeRosterText).filter(Boolean);
  const out: Record<string, DealTerms> = {};
  for (const [k, d] of Object.entries(terms)) {
    out[k] = { ...d, always: norm(d.always), context: norm(d.context), context_requires_any: norm(d.context_requires_any) };
  }
  return out;
}

/** A normalised string with every space removed (separators are already spaces). */
function compact(normalized: string): string {
  return normalized.replace(/ /g, '');
}

/**
 * One walk of a value (refute round 5, F5(d)/(e)):
 *  - leaves: every string leaf AND every object key, in traversal order (numbers/booleans
 *    stringified). Keys were never scanned before ({"<term>": 5} gave null). The compact pass runs
 *    per leaf, so separate fields / array items never merge there (refute W1).
 *  - joins: for each array / object with two or more DIRECT string children, those children
 *    concatenated in order with NO separator, so a word split inside a word across sibling leaves
 *    (['Kest', 'rel Ridge']) is seen whole. Each string belongs to exactly one parent, so the total
 *    join length is bounded by the total string length: linear, never quadratic. Numbers are not
 *    joined (cross-field figures must not merge into a price term).
 *  - stream (refute round 6, G3): every string leaf and key in DOCUMENT order, across nesting
 *    levels, as JSON.stringify would emit them (numbers / booleans / null are skipped, never
 *    joined). Checked as ONE compact leaf whose bounds include every piece boundary, so a word split
 *    across a parent and child (['Kest', ['rel Ridge']]), a key and its value ({Kest: 'rel Ridge'}),
 *    sibling keys or a value and the next key is seen whole. A second stream holds the string VALUES
 *    only (keys left out), so a split across values in different records with keys in between
 *    ({a: 'Kest', b: {c: 'rel Ridge'}}) is seen too. Plain-compact terms use plain alignment on
 *    it; every other term (refute round 7, H1) the strict compactSubtokenHit, so a price split
 *    mid-group across nesting levels is seen while cross-field digit groups that MOVE a break never
 *    merge into a price term. Linear: one concatenation of every string per stream.
 * The walk is ITERATIVE (no stack overflow on deep input), calls toJSON where JSON.stringify would
 * (Date, a class with toJSON, ...), and walks Map entries (keys then values) and Set values, which
 * JSON.stringify itself would drop. A throwing toJSON propagates: the scan fails closed.
 * Refute round 8, J1: only an object on the CURRENT ANCESTOR CHAIN is skipped (a cycle, which
 * JSON.stringify would reject); a shared non-cyclic object is walked again wherever it reappears,
 * exactly as JSON.stringify writes every copy. The walk runs under a scanBudget, so a DAG whose
 * unfolding is exponential (each node referenced twice per level) throws instead of hanging.
 */
interface Walk { leaves: string[]; joins: string[]; stream: string[]; values: string[] }

type WalkItem =
  | { kind: 'value'; v: unknown; key: string }
  | { kind: 'key'; k: string }
  | { kind: 'exit'; o: object };

/** Generous per-scan work caps (refute round 8, J1). A scan walks every copy of a shared object, so
 *  a small DAG can unfold exponentially; past either cap the scan THROWS (fails closed) rather than
 *  hang or exhaust memory. The repo's largest real payloads (the portfolio snapshot, the
 *  property-financials dataset, package-lock.json) each need under 50,000 visits and 400K
 *  characters: two orders of magnitude below both caps. Counted per budget instance: matchRosterTerms
 *  has its own (its walk AND every string it normalises, P2), a direct collectText /
 *  collectTextLegacy call has its own, and scanTexts (confidential-normalize.ts) shares ONE budget
 *  across all four walks of a call. */
export const SCAN_VISIT_BUDGET = 5_000_000;
export const SCAN_CHAR_BUDGET = 64 * 1024 * 1024;

type ScanBudget = ReturnType<typeof scanBudget>;

export class ScanBudgetError extends Error {
  constructor() {
    super('confidential scan budget exceeded (input unfolds too far) -- refusing (fail closed)');
  }
}

/** One scan pass's work counter: visit() per node / key, text(n) per string emitted. */
export function scanBudget(): { visit: () => void; text: (n: number) => void } {
  let visits = 0;
  let chars = 0;
  return {
    visit: () => {
      if (++visits > SCAN_VISIT_BUDGET) throw new ScanBudgetError();
    },
    text: (n: number) => {
      chars += n;
      if (chars > SCAN_CHAR_BUDGET) throw new ScanBudgetError();
    },
  };
}

function resolveJson(v: unknown, key: string): unknown {
  if (v !== null && typeof v === 'object' && typeof (v as { toJSON?: unknown }).toJSON === 'function') {
    return unboxPrimitive((v as { toJSON: (k: string) => unknown }).toJSON(key));
  }
  return unboxPrimitive(v);
}

const BOXED_TAGS = new Set(['[object Number]', '[object String]', '[object Boolean]', '[object BigInt]']);

/** True when `v` carries the internal slot `valueOf` checks (it throws on anything else). */
function hasSlot(valueOf: (this: unknown) => unknown, v: object): boolean {
  try {
    valueOf.call(v);
    return true;
  } catch {
    return false;
  }
}

/**
 * A boxed primitive unboxed as JSON.stringify does after toJSON (refute round 8, J3): a Number
 * object via ToNumber (a user valueOf runs, and may throw), a String object via ToString, a
 * Boolean / BigInt object by its internal value. Anything else is returned unchanged. Before this,
 * {price: new Number(3875000)} expanded to nothing although JSON.stringify emits 3875000. A thrown
 * valueOf / toString propagates: the scan fails closed. The slot check (which throws on a miss) runs
 * only for a candidate: an instance of the four wrappers, or an object whose built-in tag is one of
 * theirs (another realm's wrapper, or a wrapper given a different prototype). JSON.stringify itself
 * throws on a BigInt; the scanner reads its digits instead (a scan is never the reason it leaks).
 * The candidate filter is USER CODE on a hostile object (`instanceof` fires a Proxy getPrototypeOf
 * trap, Object.prototype.toString a Symbol.toStringTag getter; refute wf_fb340eb2, P1), so this runs
 * only in the walks that already run user code: the hardened flattenings (after main's two views)
 * and roster-core's JSON-order walk (after scanForConfidential at every gate). A slot-only test
 * (no candidate filter) would run no user code but throws on every ordinary object (~2-10 us each).
 */
export function unboxPrimitive(v: unknown): unknown {
  if (v === null || typeof v !== 'object' || Array.isArray(v)) return v;
  const candidate =
    v instanceof Number || v instanceof String || v instanceof Boolean || v instanceof BigInt ||
    BOXED_TAGS.has(Object.prototype.toString.call(v));
  if (!candidate) return v;
  if (hasSlot(Number.prototype.valueOf, v)) return Number(v);
  if (hasSlot(String.prototype.valueOf, v)) return String(v);
  if (hasSlot(Boolean.prototype.valueOf, v)) return Boolean.prototype.valueOf.call(v);
  if (hasSlot(BigInt.prototype.valueOf, v)) return BigInt.prototype.valueOf.call(v);
  return v;
}

function walk(value: unknown, budget: ScanBudget): Walk {
  const out: Walk = { leaves: [], joins: [], stream: [], values: [] };
  // The current ancestor chain only (J1): marked on entry, unmarked by the item's exit marker.
  // The current ancestor chain as a per-object COUNTER that is never deleted from (final refute,
  // L3). A Set with add / delete on every enter / exit degraded to O(depth) per visit when a shared
  // object recurs under a deep spine (the table churns through tombstones): 20k levels took ~1 s,
  // 4x per doubling. A counter set back to 0 keeps every operation O(1); the Map holds at most one
  // entry per distinct object, which is bounded by the visit budget.
  const onPath = new Map<object, number>();
  const stack: WalkItem[] = [{ kind: 'value', v: value, key: '' }];
  budget.visit();
  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.kind === 'exit') {
      onPath.set(item.o, 0);
      continue;
    }
    // Visits are charged when an item is QUEUED (final refute, L3): see `queue` below.
    if (item.kind === 'key') {
      budget.text(item.k.length);
      out.leaves.push(item.k);
      out.stream.push(item.k);
      continue;
    }
    const v = resolveJson(item.v, item.key);
    if (v === null || v === undefined) continue;
    if (typeof v === 'string') {
      budget.text(v.length);
      out.leaves.push(v);
      out.stream.push(v);
      out.values.push(v);
      continue;
    }
    if (typeof v === 'number' || typeof v === 'boolean' || typeof v === 'bigint') {
      out.leaves.push(String(v));
      continue;
    }
    if (typeof v !== 'object' || (onPath.get(v) ?? 0) > 0) continue;
    onPath.set(v, 1);
    stack.push({ kind: 'exit', o: v }); // popped after every child: leaves the ancestor chain
    // Children in document order; pushed reversed so they pop in order.
    // Each child is charged to the budget as it is QUEUED (final refute, L3), so a huge or endless
    // child list (a Map / Set whose iterator never ends) throws before it is materialised.
    const children: WalkItem[] = [];
    const queue = (c: WalkItem): void => {
      budget.visit();
      children.push(c);
    };
    if (Array.isArray(v)) {
      v.forEach((x, i) => queue({ kind: 'value', v: x, key: String(i) }));
    } else if (v instanceof Map) {
      for (const [k, x] of v) {
        queue(typeof k === 'string' ? { kind: 'key', k } : { kind: 'value', v: k, key: '' });
        queue({ kind: 'value', v: x, key: typeof k === 'string' ? k : '' });
      }
    } else if (v instanceof Set) {
      for (const x of v) queue({ kind: 'value', v: x, key: '' });
    } else {
      for (const [k, x] of Object.entries(v)) {
        queue({ kind: 'key', k });
        queue({ kind: 'value', v: x, key: k });
      }
    }
    // Direct string children (after toJSON), for the sibling-join pass.
    const direct: string[] = [];
    for (const c of children) {
      if (c.kind !== 'value') continue;
      if (typeof c.v === 'string') direct.push(c.v);
    }
    if (direct.length >= 2) out.joins.push(direct.join(''));
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  return out;
}

/** The stream (see walk) as one compact leaf whose bounds are its pieces' token bounds plus every
 *  piece boundary; empty when it has fewer than two strings (the per-leaf pass already covers it). */
function streamLeaves(stream: string[], budget: ScanBudget): CompactLeaf[] {
  if (stream.length < 2) return [];
  const bounds = new Set<number>([0]);
  let text = '';
  for (const piece of stream) {
    const leaf = compactLeaf(normText(piece, budget));
    for (const b of leaf.bounds) bounds.add(text.length + b);
    text += leaf.text;
  }
  return [{ text, bounds }];
}

/** A leaf's compact string plus the offsets where one of its normalised tokens starts or ends.
 *  A compact hit must start and end on these offsets (refute W1): "midwest portfolio" can never
 *  yield "westport", while "9 900 quarry", letter-spacing and "heronridge" still align. */
interface CompactLeaf { text: string; bounds: Set<number> }

function compactLeaf(normalizedLeaf: string): CompactLeaf {
  const bounds = new Set<number>([0]);
  let text = '';
  for (const w of normalizedLeaf ? normalizedLeaf.split(' ') : []) {
    text += w;
    bounds.add(text.length);
  }
  return { text, bounds };
}

/** Compact hit: the term's compact form occurs in some leaf starting AND ending on word bounds. */
function compactLeafHit(leaves: CompactLeaf[], c: string): boolean {
  for (const leaf of leaves) {
    let at = leaf.text.indexOf(c);
    while (at !== -1) {
      if (leaf.bounds.has(at) && leaf.bounds.has(at + c.length)) return true;
      at = leaf.text.indexOf(c, at + 1);
    }
  }
  return false;
}

/**
 * Stricter compact hit for all-digit and short (compact < COMPACT_MIN_LENGTH) terms (refute round 5,
 * F5(c); widened round 6, G1): the hit must be word-aligned at both ends AND, inside it, the text's
 * word boundaries must be EITHER a subset of the term's (the text DROPS separators the term has:
 * "Unit4B" for "unit 4b", "Bldg7" for "bldg 7", "4250000" for "4 250 000") OR a superset of them
 * (the text ADDS breaks but keeps every one of the term's: letter-spacing "3 8 7 5 0 0 0", one stray
 * space "3 87 5 000", "b a y 1 2"). A break may never MOVE, so "42 50 000" still cannot match
 * "4 250 000", nor "Bldg 10" match "bldg 1", nor "back carriage" match "k c" (W1 / U2 stay fixed in
 * THIS pass and the normalised pass; the raw pass is plain substring and can still over-match an
 * unpunctuated term). Runs per leaf only, never over sibling joins.
 */
function compactSubtokenHit(leaves: CompactLeaf[], term: CompactLeaf): boolean {
  const c = term.text;
  if (!c) return false;
  for (const leaf of leaves) {
    let at = leaf.text.indexOf(c);
    while (at !== -1) {
      if (leaf.bounds.has(at) && leaf.bounds.has(at + c.length)) {
        let subset = true;
        let superset = true;
        for (let i = 1; i < c.length && (subset || superset); i++) {
          const inText = leaf.bounds.has(at + i);
          const inTerm = term.bounds.has(i);
          if (inText && !inTerm) subset = false;
          if (inTerm && !inText) superset = false;
        }
        if (subset || superset) return true;
      }
      at = leaf.text.indexOf(c, at + 1);
    }
  }
  return false;
}

/** A stream's plain concatenation (no separator added between pieces) as a compact leaf on its OWN
 *  token bounds, plus `soft`: the piece boundaries in the same compact coordinates (null when
 *  normalising the whole concatenation changed its compact length, so the coordinates cannot be
 *  trusted; concatHit is then permissive, a fail-closed over-match). Refute round 8, J2. */
interface ConcatLeaf extends CompactLeaf { soft: Set<number> | null }

function concatLeaves(pieces: string[], budget: ScanBudget): ConcatLeaf[] {
  if (pieces.length < 2) return [];
  const soft = new Set<number>();
  let pos = 0;
  for (const piece of pieces) {
    pos += compact(normText(piece, budget)).length;
    soft.add(pos);
  }
  return normalizedForms(pieces.join(''), budget).map((n) => {
    const leaf = compactLeaf(n);
    return { ...leaf, soft: leaf.text.length === pos ? soft : null };
  });
}

/**
 * The concatenation test (refute round 8, J2). A hit is the term's compact form in a concatenation,
 * aligned on the concatenation's own token bounds, where
 *  - the token breaks INSIDE the hit are exactly the term's ("bay 12"), exactly its separators-
 *    deleted form's ("3875000" for "$3,875,000", "obrannigan" for "O'Brannigan"), or none at all
 *    ("bay12"): the bounded normalised test a sibling join gets, plus the unspaced token; and
 *  - no piece boundary inside the hit falls on one of the term's breaks where the text has no break
 *    of its own. A split that lands ON a term break is a word break the stream test (compactSub-
 *    tokenHit, piece boundaries as bounds) already judges, so a break may not MOVE here either:
 *    ['42', ['50', ['000']]] (pieces at 2 and 4, term breaks at 1 and 4) stays a miss for
 *    '$4,250,000', and {a: ['42'], b: {c: '50,000'}} ('4250 000', an inner break) is never a hit.
 * So only a term split strictly INSIDE its tokens across pieces is added: ['387', ['5000']],
 * ['Bay1', ['2']], ['Ba', ['y12']]. ACCEPTED LIMIT: a split inside a token that also drops one of
 * the term's own separators ('$3,8' + '75000') stays a miss, across siblings as across nesting.
 * ACCEPTED LIMIT (final re-review): the separators-deleted form split ON a term break and somewhere
 * else too, e.g. [['3875', '00'], '0'] or [['387'], [['5']]], [['0'], [['00']]] for '$3,875,000',
 * misses. It has the same shape as the pinned negative ['42', ['50', ['000']]], so it cannot be
 * closed without breaking that negative. It also missed before this change (not a regression).
 */
function concatHit(leaves: ConcatLeaf[], nt: string, del: string): boolean {
  if (leaves.length === 0) return false;
  const term = compactLeaf(nt);
  const c = term.text;
  if (!c) return false;
  const interior = (b: Set<number>) => [...b].filter((i) => i > 0 && i < c.length).sort((x, y) => x - y).join(',');
  const allowed = new Set<string>(['', interior(term.bounds)]);
  if (del) allowed.add(interior(compactLeaf(del).bounds));
  for (const leaf of leaves) {
    let at = leaf.text.indexOf(c);
    while (at !== -1) {
      if (leaf.bounds.has(at) && leaf.bounds.has(at + c.length)) {
        const hard: number[] = [];
        let moved = false;
        for (let i = 1; i < c.length; i++) {
          if (leaf.bounds.has(at + i)) hard.push(i);
          else if (leaf.soft?.has(at + i) && term.bounds.has(i)) moved = true;
        }
        if (!moved && allowed.has(hard.join(','))) return true;
      }
      at = leaf.text.indexOf(c, at + 1);
    }
  }
  return false;
}

/** Tokens shorter than this force a token-boundary match (refute U2) and route a term to the
 *  stricter sub-token compact alignment instead of the plain one (refute W1(c), round 5 F5(c)). */
const SHORT_TOKEN = 3;
const hasShortToken = (t: string) => t.split(' ').some((tok) => tok.length < SHORT_TOKEN);
const HAS_LETTER = /\p{L}/u;

/** Plain (any interior break) compact alignment applies to a term whose compact form is at least
 *  COMPACT_MIN_LENGTH long AND that either has no short token, or (refute round 6, G1) carries a
 *  letter: "4417 quarry rd" then matches "4 4 1 7 q u a r r y r d", "4417 qu arry rd" and
 *  "4417quarryrd" across sibling leaves. All-digit short-token terms ("4 250 000") and short terms
 *  ("k c", "bldg 1") keep the stricter compactSubtokenHit, which is what keeps "Building 42,
 *  50,000 SF" from matching "$4,250,000". */
function usesPlainCompact(nt: string, short: boolean): boolean {
  const c = compact(nt);
  return c.length >= COMPACT_MIN_LENGTH && (!short || HAS_LETTER.test(c));
}

/**
 * The passes, evaluated PER TERM and combined with OR (refute round 4, W2):
 *  - raw: plain lowercase substring of the joined text (keys included), scanForConfidential's test.
 *    Substring only, so it can only over-match; token-boundary rules do NOT apply to it.
 *  - normalised (refute U2): substring of the normalised joined text, except that anchors,
 *    context terms and any term with a token shorter than SHORT_TOKEN must match on token
 *    boundaries, (" " + hay + " ").includes(" " + term + " "), so "K.C." cannot match
 *    "back carriage" nor "Bldg #1" match "Bldg 10". The term is also tried with its separators
 *    DELETED ("O'Brannigan" -> "obrannigan", "1,250" -> "1250"), always bounded (F5(c)).
 *  - compact (refute U1, corrected W1, extended F5(c), G1): per string leaf, spaces removed, hit
 *    aligned on that leaf's token boundaries. Terms with compact length >= COMPACT_MIN_LENGTH and
 *    either no short token or at least one letter use plain alignment (usesPlainCompact); every
 *    other term uses compactSubtokenHit.
 *  - sibling joins (F5(e)): each join is checked with the BOUNDED normalised test and, for
 *    plain-alignment terms, the plain compact test; never with sub-token compact.
 *  - stream (G3, H1, J2): the document-order streams as compact leaves whose bounds include every
 *    piece boundary (plain or sub-token alignment, as per leaf), and each stream's plain
 *    concatenation with concatHit (a term split strictly inside its tokens across pieces).
 * Every haystack string is checked in both line-end forms (F5(f)). A deal hits when ANY always
 * term hits, or when at least one anchor AND at least one context term hit, each through whichever
 * pass catches it.
 */
export function matchRosterTerms(value: unknown, terms: Record<string, DealTerms>): ConfidentialHit | null {
  // ONE budget for the walk AND every normalisation it feeds (P2): the characters normalised are
  // charged too, so the 64M-character cap bounds the matcher's total ICU work.
  const budget = scanBudget();
  const w = walk(value, budget);
  const joined = w.leaves.join(' ');
  const rawLow = joined.toLowerCase();
  const hays = normalizedForms(joined, budget).filter(Boolean);
  if (!rawLow && hays.length === 0 && w.joins.length === 0) return null;
  const paddedHays = hays.map((h) => ` ${h} `);
  // Built lazily: only when some term needs them.
  let leaves: CompactLeaf[] | null = null;
  let joinForms: Array<{ padded: string; leaf: CompactLeaf }> | null = null;
  // A single leaf IS the joined text: reuse its normalised forms instead of recomputing them.
  const getLeaves = () =>
    (leaves ??= (w.leaves.length === 1 ? hays : w.leaves.flatMap((l) => normalizedForms(l, budget))).map(compactLeaf));
  let streamForms: CompactLeaf[] | null = null;
  const getStream = () => (streamForms ??= [...streamLeaves(w.stream, budget), ...streamLeaves(w.values, budget)]);
  const getJoins = () =>
    (joinForms ??= w.joins.flatMap((j) => normalizedForms(j, budget).map((n) => ({ padded: ` ${n} `, leaf: compactLeaf(n) }))));
  // Refute round 8, J2: each stream's plain concatenation (see concatLeaves), built lazily.
  let concatForms: ConcatLeaf[] | null = null;
  const getConcat = () => (concatForms ??= [...concatLeaves(w.stream, budget), ...concatLeaves(w.values, budget)]);

  const termHit = (t: string, boundedOnly: boolean): boolean => {
    if (!t) return false;
    if (rawLow.includes(t.toLowerCase())) return true;
    const nt = normalizeRosterText(t);
    if (!nt) return false;
    const short = hasShortToken(nt);
    const bounded = boundedOnly || short;
    if (paddedHays.some((p, i) => (bounded ? p.includes(` ${nt} `) : (hays[i] ?? '').includes(nt)))) return true;
    const del = finishNormalize(nfkcOf(t), true, '');
    if (del && del !== nt && paddedHays.some((p) => p.includes(` ${del} `))) return true;
    const plainCompact = usesPlainCompact(nt, short);
    if (plainCompact ? compactLeafHit(getLeaves(), compact(nt)) : compactSubtokenHit(getLeaves(), compactLeaf(nt))) return true;
    if (w.joins.length > 0) {
      const joins = getJoins();
      if (joins.some((j) => j.padded.includes(` ${nt} `) || (!!del && j.padded.includes(` ${del} `)))) return true;
      if (plainCompact && compactLeafHit(joins.map((j) => j.leaf), compact(nt))) return true;
    }
    // Refute round 8, J2: the stream treats every piece boundary as a word break, so a token split
    // inside itself across pieces (['387', ['5000']], ['Bay1', ['2']], ['Ba', ['y12']]) missed. The
    // concatenation test (concatHit) sees those, and keeps every moved-break negative a miss.
    if (concatHit(getConcat(), nt, del)) return true;
    // Refute round 7, H1: the stream runs the strict sub-token alignment for the other terms too,
    // so a price / short term split mid-group across nesting levels (['$3,87', ['5,000']],
    // ['Ba', ['y 12']]) is seen. A break may still only be dropped or added, never moved, so
    // cross-record digit groups that move a break ({a: ['42'], b: {c: '50,000'}} vs '$4,250,000')
    // stay a miss.
    return plainCompact ? compactLeafHit(getStream(), compact(nt)) : compactSubtokenHit(getStream(), compactLeaf(nt));
  };
  for (const [key, deal] of Object.entries(terms)) {
    if (deal.active === false) continue;
    const label = deal.label ?? key;
    if ((deal.always ?? []).some((t) => termHit(t, false))) return { dealLabel: label };
    const anchors = deal.context_requires_any ?? [];
    if (anchors.length > 0 && anchors.some((t) => termHit(t, true)) && (deal.context ?? []).some((t) => termHit(t, true))) {
      return { dealLabel: label };
    }
  }
  return null;
}
