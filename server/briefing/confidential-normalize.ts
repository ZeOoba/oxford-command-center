// server/briefing/confidential-normalize.ts
//
// The text normalization behind the confidential-term scanners. PURE: no node:* imports, so it can be
// used by modules that must stay runtime-agnostic (server/ai/tools.ts also runs at the edge) as well as
// by server/briefing/confidential.ts (which adds the roster loading) and scripts/bake-mirror.ts.
// Twin of `_norm_variants` / `_forms_contain` in the egress hook confidentiality-guard.py: keep the two
// aligned; both test suites pin the same table hash. The hook twin ships through ora-claude-config PRs and
// still has to be deployed to the live ~/.claude checkout; until then the deployed hook may be the old
// raw lowercase match, so read the live file before assuming parity.

// --- Normalization (mirror of confidentiality-guard.py `_norm_variants` -- keep the two aligned) ---
// A plain lowercase substring match is evaded by anything that changes the CHARACTERS without
// changing what a reader sees: a zero-width space or soft hyphen inside a term, NBSP / thin-space
// for a space, curly quotes and dashes, fullwidth or math-alphanumeric letters, accents, and numbers
// pasted with digit-group separators. Both the haystack and every roster term go through the same
// fold, so the comparison happens in one canonical space.
//   1. Drop superscript/subscript digits, fold typographic punctuation, NFKD, lowercase.
//   2. Delete combining marks (\p{Mn}) and the invisible set (format chars, default-ignorables,
//      non-whitespace control chars, fillers); fold non-ASCII decimal digits to ASCII. (No NFC: both
//      sides stay decomposed, which cannot change a comparison.)
//   3. Fold typographic punctuation again, collapse every whitespace run (NBSP included) to one space.
// Two haystack variants: "tight" (invisible chars deleted -- catches `Zeph<ZWSP>yr`) and "spaced"
// (invisible chars become a space -- catches `Zephyr<ZWSP>Corp` for the term `zephyr corp`). A text
// carrying bidi override controls is also scanned REVERSED (what an RLO run renders as). Each variant
// gets a "digits" form with group separators removed from properly grouped numbers (4,250,000 ->
// 4250000) so a bare numeric roster term cannot be dodged by number formatting.
//
// The Unicode sets below are a FIXED table (generated once from Unicode 17 / ICU 78), NOT runtime
// \p{...} properties, so this file and the Python hook cannot drift when either runtime's Unicode
// data moves. The hook embeds the identical strings; both test suites pin their SHA-256. NFKD/lowercase
// still follow the runtime's Unicode data: a character assigned after the older runtime's version may
// fold differently on the two sides (documented, residual).
const TABLE_MN = '300-36f,483-487,591-5bd,5bf,5c1-5c2,5c4-5c5,5c7,610-61a,64b-65f,670,6d6-6dc,6df-6e4,6e7-6e8,6ea-6ed,711,730-74a,7a6-7b0,7eb-7f3,7fd,816-819,81b-823,825-827,829-82d,859-85b,897-89f,8ca-8e1,8e3-902,93a,93c,941-948,94d,951-957,962-963,981,9bc,9c1-9c4,9cd,9e2-9e3,9fe,a01-a02,a3c,a41-a42,a47-a48,a4b-a4d,a51,a70-a71,a75,a81-a82,abc,ac1-ac5,ac7-ac8,acd,ae2-ae3,afa-aff,b01,b3c,b3f,b41-b44,b4d,b55-b56,b62-b63,b82,bc0,bcd,c00,c04,c3c,c3e-c40,c46-c48,c4a-c4d,c55-c56,c62-c63,c81,cbc,cbf,cc6,ccc-ccd,ce2-ce3,d00-d01,d3b-d3c,d41-d44,d4d,d62-d63,d81,dca,dd2-dd4,dd6,e31,e34-e3a,e47-e4e,eb1,eb4-ebc,ec8-ece,f18-f19,f35,f37,f39,f71-f7e,f80-f84,f86-f87,f8d-f97,f99-fbc,fc6,102d-1030,1032-1037,1039-103a,103d-103e,1058-1059,105e-1060,1071-1074,1082,1085-1086,108d,109d,135d-135f,1712-1714,1732-1733,1752-1753,1772-1773,17b4-17b5,17b7-17bd,17c6,17c9-17d3,17dd,180b-180d,180f,1885-1886,18a9,1920-1922,1927-1928,1932,1939-193b,1a17-1a18,1a1b,1a56,1a58-1a5e,1a60,1a62,1a65-1a6c,1a73-1a7c,1a7f,1ab0-1abd,1abf-1add,1ae0-1aeb,1b00-1b03,1b34,1b36-1b3a,1b3c,1b42,1b6b-1b73,1b80-1b81,1ba2-1ba5,1ba8-1ba9,1bab-1bad,1be6,1be8-1be9,1bed,1bef-1bf1,1c2c-1c33,1c36-1c37,1cd0-1cd2,1cd4-1ce0,1ce2-1ce8,1ced,1cf4,1cf8-1cf9,1dc0-1dff,20d0-20dc,20e1,20e5-20f0,2cef-2cf1,2d7f,2de0-2dff,302a-302d,3099-309a,a66f,a674-a67d,a69e-a69f,a6f0-a6f1,a802,a806,a80b,a825-a826,a82c,a8c4-a8c5,a8e0-a8f1,a8ff,a926-a92d,a947-a951,a980-a982,a9b3,a9b6-a9b9,a9bc-a9bd,a9e5,aa29-aa2e,aa31-aa32,aa35-aa36,aa43,aa4c,aa7c,aab0,aab2-aab4,aab7-aab8,aabe-aabf,aac1,aaec-aaed,aaf6,abe5,abe8,abed,fb1e,fe00-fe0f,fe20-fe2f,101fd,102e0,10376-1037a,10a01-10a03,10a05-10a06,10a0c-10a0f,10a38-10a3a,10a3f,10ae5-10ae6,10d24-10d27,10d69-10d6d,10eab-10eac,10efa-10eff,10f46-10f50,10f82-10f85,11001,11038-11046,11070,11073-11074,1107f-11081,110b3-110b6,110b9-110ba,110c2,11100-11102,11127-1112b,1112d-11134,11173,11180-11181,111b6-111be,111c9-111cc,111cf,1122f-11231,11234,11236-11237,1123e,11241,112df,112e3-112ea,11300-11301,1133b-1133c,11340,11366-1136c,11370-11374,113bb-113c0,113ce,113d0,113d2,113e1-113e2,11438-1143f,11442-11444,11446,1145e,114b3-114b8,114ba,114bf-114c0,114c2-114c3,115b2-115b5,115bc-115bd,115bf-115c0,115dc-115dd,11633-1163a,1163d,1163f-11640,116ab,116ad,116b0-116b5,116b7,1171d,1171f,11722-11725,11727-1172b,1182f-11837,11839-1183a,1193b-1193c,1193e,11943,119d4-119d7,119da-119db,119e0,11a01-11a0a,11a33-11a38,11a3b-11a3e,11a47,11a51-11a56,11a59-11a5b,11a8a-11a96,11a98-11a99,11b60,11b62-11b64,11b66,11c30-11c36,11c38-11c3d,11c3f,11c92-11ca7,11caa-11cb0,11cb2-11cb3,11cb5-11cb6,11d31-11d36,11d3a,11d3c-11d3d,11d3f-11d45,11d47,11d90-11d91,11d95,11d97,11ef3-11ef4,11f00-11f01,11f36-11f3a,11f40,11f42,11f5a,13440,13447-13455,1611e-16129,1612d-1612f,16af0-16af4,16b30-16b36,16f4f,16f8f-16f92,16fe4,1bc9d-1bc9e,1cf00-1cf2d,1cf30-1cf46,1d167-1d169,1d17b-1d182,1d185-1d18b,1d1aa-1d1ad,1d242-1d244,1da00-1da36,1da3b-1da6c,1da75,1da84,1da9b-1da9f,1daa1-1daaf,1e000-1e006,1e008-1e018,1e01b-1e021,1e023-1e024,1e026-1e02a,1e08f,1e130-1e136,1e2ae,1e2ec-1e2ef,1e4ec-1e4ef,1e5ee-1e5ef,1e6e3,1e6e6,1e6ee-1e6ef,1e6f5,1e8d0-1e8d6,1e944-1e94a,e0100-e01ef';
const TABLE_FMT = '0-8,e-1b,7f-84,86-9f,ad,600-605,61c,6dd,70f,890-891,8e2,115f-1160,180e,200b-200f,202a-202e,2060-206f,2800,3164,feff,ffa0,fff0-fffb,110bd,110cd,13430-1343f,1bca0-1bca3,1d173-1d17a,e0000-e00ff,e01f0-e0fff';
const TABLE_PD = '2d,58a,5be,1400,1806,2010-2015,2212,2e17,2e1a,2e3a-2e3b,2e40,2e5d,301c,3030,30a0,fe31-fe32,fe58,fe63,ff0d,10d6e,10ead';
const TABLE_ND0 = '30,660,6f0,7c0,966,9e6,a66,ae6,b66,be6,c66,ce6,d66,de6,e50,ed0,f20,1040,1090,17e0,1810,1946,19d0,1a80,1a90,1b50,1bb0,1c40,1c50,a620,a8d0,a900,a9d0,a9f0,aa50,abf0,ff10,104a0,10d30,10d40,11066,110f0,11136,111d0,112f0,11450,114d0,11650,116c0,116d0,116da,11730,118e0,11950,11bf0,11c50,11d50,11da0,11de0,11f50,16130,16a60,16ac0,16b50,16d70,1ccf0,1d7ce,1d7d8,1d7e2,1d7ec,1d7f6,1e140,1e2f0,1e4f0,1e5f1,1e950,1fbf0';

/** The four fixed tables, in hashing order (see normalizationTablesSha256 in confidential.ts). */
export const NORMALIZATION_TABLES = [TABLE_MN, TABLE_FMT, TABLE_PD, TABLE_ND0] as const;

type CodeRange = [number, number];
function parseRanges(spec: string): CodeRange[] {
  return spec.split(',').map((r): CodeRange => {
    const [a, b] = r.split('-');
    const lo = parseInt(a ?? '', 16);
    return [lo, b === undefined ? lo : parseInt(b, 16)];
  });
}
const BS = String.fromCharCode(92);
function classOf(ranges: CodeRange[]): string {
  const esc = (c: number): string => {
    const ch = String.fromCodePoint(c);
    return (BS + ']^-[').includes(ch) ? BS + ch : ch;
  };
  return '[' + ranges.map(([a, b]) => (a === b ? esc(a) : esc(a) + '-' + esc(b))).join('') + ']';
}
const reOf = (ranges: CodeRange[]): RegExp => new RegExp(classOf(ranges), 'gu');

const ND_ZEROS = parseRanges(TABLE_ND0).map(([z]) => z);
const RE_MN = reOf(parseRanges(TABLE_MN));
const RE_FMT = reOf(parseRanges(TABLE_FMT));
const RE_DASH = reOf([...parseRanges(TABLE_PD), [0x2212, 0x2212]]);
const RE_ND = reOf(ND_ZEROS.filter((z) => z !== 0x30).map((z): CodeRange => [z, z + 9]));
const RE_SUPSUB = reOf([[0xb2, 0xb3], [0xb9, 0xb9], [0x2070, 0x2070], [0x2074, 0x2079], [0x2080, 0x2089]]);
const RE_APOS = reOf([[0x60, 0x60], [0xb4, 0xb4], [0x2b9, 0x2b9], [0x2bb, 0x2bc], [0x2018, 0x201b], [0x2032, 0x2032], [0x2035, 0x2035], [0xa78c, 0xa78c]]);
const RE_DQUOTE = reOf([[0xab, 0xab], [0xbb, 0xbb], [0x201c, 0x201f], [0x2033, 0x2033], [0x2036, 0x2036]]);
const RE_WS = new RegExp(
  classOf([[9, 13], [0x1c, 0x1f], [0x20, 0x20], [0x85, 0x85], [0xa0, 0xa0], [0x1680, 0x1680], [0x2000, 0x200a], [0x2028, 0x2029], [0x202f, 0x202f], [0x205f, 0x205f], [0x3000, 0x3000]]) + '+',
  'gu',
);
const RE_BIDI = /[\u202a-\u202e\u2066-\u2069]/;
// Digit-group separators: , . _ ' space NBSP thin-space narrow-NBSP and the Arabic thousands separator.
const GROUP_SEPS = `,._' \u00a0\u2009\u202f\u066c`;
const SEP_CLASS = classOf(GROUP_SEPS.split('').map((c): CodeRange => [c.codePointAt(0) ?? 0, c.codePointAt(0) ?? 0]));
// A properly grouped number: 1-3 digits then 1+ groups of exactly 3 digits, ONE separator character
// used throughout (a backreference), so `4,250,000 100%` is the number 4,250,000 followed by 100 and
// not 4250000100. Not preceded or followed by another digit, so `12.50` and `1,2345` are left alone.
const RE_GROUPED_NUM = new RegExp(String.raw`(?<!\d)\d{1,3}(${SEP_CLASS})\d{3}(?:\1\d{3})*(?!\d)`, 'g');
// Canonical digit-run form: ANY separator between two digits is dropped. Over-merges ("3 250,000" ->
// 3250000, "4.25" -> 425) on purpose, and is used SYMMETRICALLY (term and haystack) only for terms that
// mix words and a number, so the match never depends on how a neighbouring number happens to be written;
// the over-merge can only add matches (fail closed).
const RE_DIGIT_SEP = new RegExp(String.raw`(?<=\d)${SEP_CLASS}(?=\d)`, 'g');
const RE_ALL_DIGITS = /^\d+$/;

function foldPunct(s: string): string {
  return s.replace(RE_APOS, "'").replace(RE_DQUOTE, '"').replace(RE_DASH, '-');
}
function foldDigits(s: string): string {
  return s.replace(RE_ND, (ch) => {
    const c = ch.codePointAt(0) ?? 0;
    const z = ND_ZEROS.find((zero) => c >= zero && c <= zero + 9);
    return z === undefined ? ch : String(c - z);
  });
}
const RE_MARK = /\p{M}/u;
/**
 * NFKD in pieces of ~512 UTF-16 units cut only before a non-mark character, never past 2048 units.
 * ICU's NFKD is quadratic in the length of a run of combining marks (80K marks = 4.4 s), and marks are
 * deleted right after anyway. Mirrors _nfkd_chunked in confidentiality-guard.py (cut positions can
 * differ only inside >2048-unit mark runs, where only retained marks can reorder).
 */
function nfkdChunked(s: string): string {
  const n = s.length;
  if (n <= 2048) return s.normalize('NFKD');
  const out: string[] = [];
  let i = 0;
  while (i < n) {
    let j = Math.min(n, i + 512);
    const stop = Math.min(n, i + 2048);
    while (j < stop && (isLowSurrogate(s.charCodeAt(j)) || RE_MARK.test(String.fromCodePoint(s.codePointAt(j) ?? 0)))) j++;
    if (j < n && isLowSurrogate(s.charCodeAt(j))) j++;
    out.push(s.slice(i, j).normalize('NFKD'));
    i = j;
  }
  return out.join('');
}
function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
function decomposed(s: string): string {
  return nfkdChunked(foldPunct(s.replace(RE_SUPSUB, ''))).toLowerCase().replace(RE_MN, '');
}
function finish(s: string): string {
  return foldPunct(foldDigits(s)).replace(RE_WS, ' ').trim();
}
const RE_NONASCII = new RegExp(classOf([[0x80, 0x10ffff]]), 'u');
const RE_ASCII_FMT = reOf(
  parseRanges(TABLE_FMT)
    .filter(([lo]) => lo < 128)
    .map(([lo, hi]): CodeRange => [lo, Math.min(hi, 127)]),
);
/** Pure-ASCII fast path: only ASCII controls and the backtick differ from the full pipeline. */
function asciiForm(s: string, fmtTo: string): string {
  return s.replace(/`/g, "'").toLowerCase().replace(RE_ASCII_FMT, fmtTo).replace(RE_WS, ' ').trim();
}
/** Invisible chars deleted outright. */
export function tightForm(s: string): string {
  return RE_NONASCII.test(s) ? finish(decomposed(s).replace(RE_FMT, '')) : asciiForm(s, '');
}
/** Invisible chars become a space (a ZWSP used AS the separator); combining marks still deleted. */
function spacedForm(s: string): string {
  return RE_NONASCII.test(s) ? finish(decomposed(s).replace(RE_FMT, ' ')) : asciiForm(s, ' ');
}
function digitsForm(s: string): string {
  return s.replace(RE_GROUPED_NUM, (m, sep: string) => m.split(sep).join(''));
}
function digitsCanonForm(s: string): string {
  return s.replace(RE_DIGIT_SEP, '');
}

export interface ScanForms {
  /** Distinct normalized strings to substring-search (tight, spaced, and tight-reversed for bidi text). */
  text: string[];
  /** `text` with digit-group separators removed: the consistent-separator form AND the canonical digit-run form. */
  digits: string[];
  /** The tight form with every space removed (and its reversed twin for bidi text): matches a long
   *  multi-word term whatever mix of invisible characters and spaces separates its words. */
  compact: string[];
}

/** The canonical comparison forms of `s`. Exported so the hook-parity tests can diff the two sides. */
export function normalizeForScan(s: string): ScanForms {
  const tight = tightForm(s);
  const spaced = spacedForm(s);
  const text = tight === spaced ? [tight] : [tight, spaced];
  const compact = [tight.replace(/ /g, '')];
  if (RE_BIDI.test(s)) {
    // What a bidi-override run renders as: the text reversed (both variants, and the compact form).
    const rev = (x: string): string => [...x].reverse().join('');
    text.push(rev(tight));
    if (spaced !== tight) text.push(rev(spaced));
    compact.push(rev(tight).replace(/ /g, ''));
  }
  return { text, digits: [...new Set(text.flatMap((t) => [digitsForm(t), digitsCanonForm(t)]))], compact };
}

/** Shortest compact term the whitespace-insensitive match applies to (short terms would over-match). */
const COMPACT_MIN = 8;
const OPT_SEP = SEP_CLASS + '?';

/**
 * Regex for a purely numeric roster term, written against the haystack as TEXT: the term's digits in
 * groups of three from the right, each pair of groups allowed an optional separator. Anchored so it is
 * a whole number: not touching another digit, not the tail of a larger grouped number (`1,250,000`
 * does not carry `250000`), not the head of one (`4,250,000,000` does not carry `4250000`). A SPACE
 * before it is deliberately allowed: `Suite 7 250,000` is ambiguous and fails toward matching.
 */
function numericTermRegex(bare: string): RegExp {
  const groups: string[] = [];
  for (let end = bare.length; end > 0; end -= 3) groups.unshift(bare.slice(Math.max(0, end - 3), end));
  const sep = `[,._']`;
  return new RegExp(
    String.raw`(?<!\d)(?<!\d${sep})` + groups.join(OPT_SEP) + String.raw`(?!\d)(?!${sep}\d{3}(?!\d))`,
  );
}

/** Does the normalized haystack carry the normalized term? Substring; numeric terms ALSO match across grouping. */
export function formsContain(hay: ScanForms, rawTerm: string): boolean {
  const tight = tightForm(rawTerm);
  if (!tight) return false;
  if (hay.text.some((h) => h.includes(tight))) return true;
  const compactTerm = tight.replace(/ /g, '');
  if (compactTerm !== tight && compactTerm.length >= COMPACT_MIN && hay.compact.some((c) => c.includes(compactTerm))) return true;
  // The TERM gets both digit forms too (as the haystack does), so a term mixing words and a number
  // does not depend on how its neighbours happen to be written.
  const dTerms = [...new Set([digitsForm(tight), digitsCanonForm(tight)])];
  const bare = (dTerms[0] ?? tight).replace(/^\$\s*/, '');
  if (RE_ALL_DIGITS.test(bare)) {
    const re = numericTermRegex(bare);
    // Also the digit forms: the canonical digit-run form folds odd groupings (Indian lakh `42,50,000`,
    // `25 00 00`) back to the plain digits. Only adds matches; the anchors still apply.
    return hay.text.some((h) => re.test(h)) || hay.digits.some((h) => re.test(h));
  }
  return hay.digits.some((h) => dTerms.some((d) => h.includes(d)));
}

/**
 * Does `text` mention any of `terms`, under the same normalization as scanForConfidential? For the
 * free-text residue sweeps that match deal NAMES rather than the roster (bake-mirror's
 * redactConfidential, the AI tool layer's confidentialScope.mentions).
 */
export function mentionsAnyTerm(text: string | null | undefined, terms: readonly string[]): boolean {
  if (!text) return false;
  const hay = normalizeForScan(text);
  return terms.some((t) => !!t && formsContain(hay, t));
}

/**
 * Converts any value into a single flattened string for scanning. Pure, so the edge twin
 * (functions/api/ai.ts) uses the SAME flattening as the server scanner.
 *
 * Reads a SUPERSET of what the original scanner read (`Object.values` of every object, i.e. own
 * enumerable properties) and adds what that missed: Date (ISO), URL (href, raw and percent-decoded),
 * Error (name, message, cause, AggregateError.errors), Map (keys and values) and Set. BigInt is stringified.
 * `seen` tracks only the ACTIVE recursion path, so a cycle is cut but an object legitimately shared by
 * two fields is read both times.
 */
export function collectText(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
  if (typeof value !== 'object') return '';
  if (seen.has(value)) return '';
  seen.add(value);
  try {
    const rec = (v: unknown): string => collectText(v, seen);
    let extra = '';
    if (value instanceof Date) {
      extra = Number.isNaN(value.getTime()) ? '' : value.toISOString();
    } else if (value instanceof URL) {
      // href is percent-encoded (`Zephyrine%20Holdings`); decode each escape run on its own so one
      // malformed escape does not stop the rest.
      const decoded = value.href.replace(/(%[0-9a-f]{2})+/gi, (m) => {
        try {
          return decodeURIComponent(m);
        } catch {
          return m;
        }
      });
      // plus every ASCII escape on its own (%5A%65... decodes even if the run also holds an invalid byte)
      const ascii = value.href.replace(/%([0-7][0-9a-f])/gi, (_m, h: string) => String.fromCharCode(parseInt(h, 16)));
      extra = value.href + ' ' + decoded + ' ' + ascii;
    } else if (value instanceof Error) {
      const errors = (value as { errors?: unknown }).errors;
      extra = [value.name, value.message, rec((value as { cause?: unknown }).cause), Array.isArray(errors) ? errors.map(rec).join(' ') : ''].join(' ');
    } else if (value instanceof Map) {
      extra = [...value.entries()].map(([k, v]) => rec(k) + ' ' + rec(v)).join(' ');
    } else if (value instanceof Set) {
      extra = [...value].map(rec).join(' ');
    }
    const own = Object.values(value).map(rec).join(' ');
    return extra ? extra + ' ' + own : own;
  } finally {
    seen.delete(value);
  }
}

/**
 * The ORIGINAL flattening, byte for byte (arrays and plain objects only: no Date/URL/Error/Map/Set/BigInt
 * handling, values joined with ' '), plus an active-path visited set that only cuts cycles. The scanners
 * scan THIS text and the extended collectText text separately, so "reads a superset of what main read"
 * holds by construction, adjacency included: the extended text inserts extra text next to an object's
 * fields, which could split a term that spans a neighbour.
 */
export function collectTextLegacy(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value !== 'object') return '';
  if (seen.has(value)) return '';
  seen.add(value);
  try {
    const rec = (v: unknown): string => collectTextLegacy(v, seen);
    if (Array.isArray(value)) return value.map(rec).join(' ');
    return Object.values(value).map(rec).join(' ');
  } finally {
    seen.delete(value);
  }
}

/** The distinct, non-empty texts a scanner must check for `value` (legacy flatten and extended flatten). */
export function scanTexts(value: unknown): string[] {
  const legacy = collectTextLegacy(value);
  const extended = collectText(value);
  return [...new Set([legacy, extended])].filter((t) => t.length > 0);
}
