/**
 * Deterministic PII redaction for free-text "notes" fields in the committed portfolio snapshot.
 *
 * WHY: notes are imported from pasted email threads (e.g. M365 To-Do task bodies) and carry
 * third-party contact data -- email addresses, phone numbers, and signature blocks. The snapshot
 * (data/snapshots/portfolio.json) is git-tracked and served to the mirror, so those values must be
 * scrubbed before they are written.
 *
 * Pure and dependency-free (no node imports) so it is usable from the server, scripts and tests.
 * Idempotent: redact(redact(x)) === redact(x) -- the rules run to a fixed point (at most
 * MAX_REDACTION_PASSES passes), because one rule can expose input for another (an email shortened to
 * its placeholder brings a sign-off tail under SIGNATURE_MAX_TAIL). Rules that can cascade within
 * themselves (stacked "<frag" runs, stacked sign-off blocks) finish in a single pass, so the pass
 * count does not grow with the input. Only free text is touched; structure, ids and every
 * numeric/financial field are the caller's responsibility to leave alone -- see
 * `redactSnapshotNotes`, which rewrites ONLY string values under keys named in NOTES_KEYS.
 *
 * Rules, applied in this order:
 *   1. Signature block: from a sign-off ("Regards,", "Best regards,", "Sincerely,", "Thanks,",
 *      "Thank you,", "Cheers,", "Best,", "Sent from my ...", or a "-- " delimiter) to the end of the
 *      text, when that tail is at most SIGNATURE_MAX_TAIL chars -> "[signature redacted]".
 *      In multi-line text the cue must START A LINE within the last SIGNATURE_MAX_LINES lines.
 *      Single-line text (every M365 note: htmlToText collapses whitespace) also cuts at a mid-line
 *      cue when the tail is at most MIDLINE_SIGNATURE_MAX_TAIL chars. A cue with text after it on its
 *      line (always the case mid-line) opens a signature only when that text starts with a capital
 *      (lower-case continuation is prose: "Regards, the tenant will renew"; "following up with
 *      regards, the roof" is never a cue) AND the tail either carries contact data or -- strong cues
 *      only (Regards / Sincerely) -- reads as a name block (no lower-case word but connectors such as
 *      "of" / "and") with no business fact ($, an SF figure, a suite / unit number, a date). So
 *      "Sincerely, Lowe's will deliver Friday" is kept and "Thanks, Robert Jones ... 614-... x@y" is
 *      cut. Both run to their own fixed point in one step, so stacked sign-off blocks cut at once.
 *   2. Mail-header names: the display name after From:/To:/Cc:/Bcc: and any "Name <addr>" pair
 *      -> "[contact redacted]".
 *   2b. Capitalised name(s) immediately before a phone number -> "[contact redacted]".
 *   Rules 2 and 2b keep only the business sub-span of a name (a legal-suffix company, "<descriptor>
 *   Business Park"-style place, or a Suite/Unit/Building id; see KEEP_NAME_RE): the vendor or the
 *   suite is the business fact the note is about. Every other capitalised word in the span -- a
 *   person after or comma-separated from it -- is redacted, as is the address or phone. A company or
 *   place is kept only when it follows a cue word (Call / Attn / cc ...; up to 4 name words) or opens
 *   the span with at most ONE name word in front of its suffix / descriptor; a person's name in front
 *   of it ("Jane Doe Acme Inc", "Mike Park Business Park") redacts the WHOLE span.
 *   3. Truncated address fragments at end of text ("<localpart" with no closing) -> removed, the
 *      whole run at once.
 *   4. Email addresses -> "[email redacted]".
 *   5. US/NANP phone numbers (optional +1, optional extension) -> "[phone redacted]".
 * Everything else (wording, dates, amounts) is left intact.
 */

export const EMAIL_PLACEHOLDER = '[email redacted]';
export const PHONE_PLACEHOLDER = '[phone redacted]';
export const SIGNATURE_PLACEHOLDER = '[signature redacted]';
export const CONTACT_PLACEHOLDER = '[contact redacted]';

/** Longest trailing block treated as a signature; a longer tail is probably real prose. */
export const SIGNATURE_MAX_TAIL = 300;

/** A sign-off cue opens a signature only when its line is one of the last this-many lines. */
export const SIGNATURE_MAX_LINES = 5;

/** Fixed-point cap for redactNotesText (each pass only removes or replaces text, so it converges fast). */
export const MAX_REDACTION_PASSES = 8;

/** Object keys whose string values are free-text notes subject to redaction. */
export const NOTES_KEYS: readonly string[] = ['notes'];

const EMAIL_SRC = String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+`;
const EMAIL_RE = new RegExp(EMAIL_SRC, 'g');

// Phone: separators are required between groups (or parentheses around the area code) so bare
// 10-digit ids and ISO dates are not matched. Not preceded/followed by a digit or dash (parcel ids).
const PHONE_SRC =
  String.raw`(?<![\d-])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s*|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\d-])(?:\s*(?:x|ext\.?)\s*\d{1,5}(?!\d))?`;
const PHONE_RE = new RegExp(PHONE_SRC, 'gi');

// A sign-off cue at the START of a line (leading whitespace allowed): the cue then a comma or the
// end of the line, a "Sent from my ..." footer, or a "--" delimiter line. Case-insensitive.
const SIGNOFF_LINE_RE =
  /^\s*(?:((?:best|kind|warm|warmest)\s+regards|regards|sincerely|cheers|thank\s+you|thanks|best)\s*(?:,|$)|(sent\s+from\s+my\s+\w+)|(--)\s*$)/i;

const CONTACT_TOKEN_RE = new RegExp(`${EMAIL_SRC}|\\d{3}[\\s.)-]+\\d{3}[\\s.-]\\d{4}|www\\.|https?://`, 'i');

// "Name <addr>" (name = up to 5 words, a word may end in a comma: "Jane Doe, Acme Realty <addr>")
// -- run BEFORE bare-email replacement so the name goes too.
const NAME_ADDR_RE = new RegExp(
  String.raw`(?:[A-Z][\w'’.-]*,?\s+){0,4}[A-Z][\w'’.-]*\s*<\s*${EMAIL_SRC}(?:\s*>)?`,
  'g',
);
// Name directly before a phone number ("Test Person (555) 010-0123", "Test Person - 555-010-0123"):
// signature / contact-list names with no sign-off cue. Up to 5 capitalised words (round 2: 3 split
// "Oakview Business Park Building C" and left the front of a longer person + company span).
const NAME_PHONE_RE = new RegExp(
  String.raw`(?:[A-Z][\w'’.-]*\s+){1,5}(?:[-–:]\s*)?(?=${PHONE_SRC})`,
  'g',
);
// The parts of a name span that are a company or property rather than a person (adversarial review
// 2026-10-30, C4). Only these sub-spans are kept; every other capitalised word in the span is redacted.
// A business word anywhere in the span used to keep the WHOLE span, so "Mike Park", "Jane Group",
// "Jane Doe, Acme Realty" and "Acme LLC Jane Doe" all leaked the person.
//  - a legal-suffix company: up to 4 capitalised words ending in LLC / Inc / Corp / Company / Ltd /
//    LP / LLP / PLLC (the suffix anchors the end, so a name AFTER it is not swallowed). Bare Co / PC
//    are not suffixes (round 2): "Jane Doe Co" is a person. The words in FRONT of the suffix are
//    vetted by scrubName (see allowedPrefix), because they can be a person ("Jane Doe Acme Inc");
//  - a place: a descriptor (Business, Industrial, Office, ...) + Park / Center / Plaza, so "Oakview
//    Business Park" is kept but "Mike Park" is not;
//  - a property id: Suite / Ste / Unit / Building / Bldg + a short id ("Suite B", "Unit 104").
// Bare Group / Realty / Partners / Park words no longer keep anything: they are also surnames, and
// over-redacting a vendor is safe where leaking a person is not.
const NAME_WORD = String.raw`[A-Z][\w&'’.-]*`;
const KEEP_NAME_RE = new RegExp(
  [
    String.raw`(?<cpre>(?:${NAME_WORD}\s+){0,4})(?:LLC|L\.L\.C\.?|Inc\.?|Incorporated|Corp\.?|Corporation|Company|Ltd\.?|LP|LLP|PLLC)(?![\w&'’-])`,
    String.raw`(?<ppre>(?:${NAME_WORD}\s+){0,2})(?:Business|Industrial|Office|Commerce|Commercial|Corporate|Technology|Tech|Trade|Distribution|Shopping|Medical|Logistics|Research|Executive)\s+(?:Park|Center|Centre|Plaza)\b`,
    String.raw`\b(?:Suite|Ste\.?|Unit|Building|Bldg\.?)\s+#?(?:\d[\w-]{0,5}|[A-Z]{1,2}-?\d{0,4})\b`,
  ].join('|'),
  'g',
);

// Capitalised words a name span picks up that are not names ("Call Building C 555-..."). Kept as-is
// only next to a kept business sub-span; a span with no business part is redacted whole.
const NON_NAME_WORDS: ReadonlySet<string> = new Set([
  'call', 'contact', 'email', 'text', 'ask', 'per', 'attn', 'via', 're', 'cc', 'please', 'phone', 'tel',
  'mobile', 'cell', 'office', 'fax', 'tenant', 'vendor', 'owner', 'landlord', 'and', 'or',
]);

const isNonNameWord = (w: string): boolean => NON_NAME_WORDS.has(w.replace(/[.,]+$/, '').toLowerCase());
// A cue word (or a mail-header label) directly in front of a name span, outside it: "From: Acme
// Roofing LLC <addr>", "cc Acme LLC Jane Doe <addr>". The span regexes start at a capital, so these
// never fall inside the span.
const CUE_BEFORE_RE = new RegExp(
  String.raw`(?:^|[^\w])(?:${[...NON_NAME_WORDS, 'from', 'to', 'bcc'].join('|')})\s*:?\s*$`,
  'i',
);
const cueBefore = (all: string, offset: number): boolean => CUE_BEFORE_RE.test(all.slice(Math.max(0, offset - 16), offset));
const gapWords = (gap: string): string[] =>
  gap.replace(/\[(?:contact|email|phone) redacted\]/g, ' ').match(/[A-Za-z][\w'’.-]*/g) ?? [];

/** Name words a company / place may carry in front of its suffix or descriptor (round 2, C4). A
 *  company: up to 4 after a cue word ("Call Acme Roofing Supply LLC"), at most 1 when it opens the
 *  span ("Acme LLC"). A place: at most 1 either way ("Oakview Business Park"), because "Park" is also
 *  a surname ("Call Mike Park Business Park"). Two or more name words at the front can be a person
 *  ("Jane Doe Acme Inc"), and over-redacting a vendor is safe where leaking a person is not. */
function allowedPrefix(nameWords: number, afterCue: boolean, place: boolean): boolean {
  return afterCue && !place ? nameWords <= 4 : nameWords <= 1;
}

/** Keep the business sub-spans of a name span and redact the rest; null when nothing is kept (the
 *  caller then redacts the whole span). */
function scrubName(span: string, afterCueWord = false): string | null {
  const parts: string[] = [];
  let last = 0;
  let kept = false;
  const pushGap = (gap: string) => {
    const words = gapWords(gap);
    if (words.length > 0 && words.every(isNonNameWord)) {
      parts.push(gap.trim().replace(/[,\s]+$/, '')); // "Call", "Attn" — an instruction, not a person
    } else if (words.length > 0) parts.push(CONTACT_PLACEHOLDER);
    else if (gap.includes(CONTACT_PLACEHOLDER)) parts.push(CONTACT_PLACEHOLDER);
  };
  for (const m of span.matchAll(KEEP_NAME_RE)) {
    let idx = m.index ?? 0;
    let text = m[0];
    const pre = m.groups?.cpre ?? m.groups?.ppre;
    if (pre !== undefined) {
      // Cue words the prefix picked up ("Call Acme LLC") belong to the gap, not the company.
      let consumed = 0;
      let nameWords = 0;
      for (const w of pre.matchAll(/(\S+)\s+/g)) {
        if (nameWords === 0 && isNonNameWord(w[1]!)) consumed += w[0].length;
        else nameWords += 1;
      }
      idx += consumed;
      text = text.slice(consumed);
      const before = gapWords(span.slice(last, idx));
      // A person in front of a company / place: redact the whole span (round 2, C4).
      if (before.some((w) => !isNonNameWord(w))) return null;
      const afterCue = before.length > 0 || (last === 0 && afterCueWord);
      if (!allowedPrefix(nameWords, afterCue, m.groups?.ppre !== undefined)) return null;
    }
    pushGap(span.slice(last, idx));
    parts.push(text.trim());
    last = idx + text.length;
    kept = true;
  }
  if (!kept) return null;
  pushGap(span.slice(last));
  return parts.join(' ');
}

// Header display names: "From: Jane Doe <" / "To: Jane Doe <" (name up to the angle bracket), and a
// name left in front of a placeholder an earlier rule wrote ("From: Jane [contact redacted]").
const HEADER_NAME_RE = /\b(From|To|Cc|Bcc|Sent by):(\s*)([^<\n:[\]]{1,60}?)\s*(?=<|\[contact redacted\])/gi;
// Dangling address fragments cut off by truncation: "<jdoe" at end of text. The whole run goes in
// one step (adversarial review 2026-10-30, C2): one fragment per pass outran the fixed-point cap.
const TRUNC_ADDR_RE = /(?:\s*<[^\s<>]*)+$/;

// Sign-off cue in the middle of a line (single-line text: htmlToText collapses all whitespace, so an
// M365 note never has a line start to anchor on). Group 1 = strong cue (Regards / Sincerely; a comma
// or end of text after it, so "with regards to the roof" is not a cue), group 2 = weak cue (Thanks /
// Thank you / Cheers / Best, comma required), group 3 = "Sent from my ...". Whether a cue opens a
// signature is decided by isSignatureTail.
const MIDLINE_SIGNOFF_RE =
  /\b((?:best|kind|warm|warmest)\s+regards|regards|sincerely)\s*(?:,|$)|\b(thanks|thank\s+you|cheers|best)\s*,|\b(sent\s+from\s+my\s+\w+)/gi;
// Lower-case words a name / title block may hold ("Director of Leasing", "Smith and Sons").
const NAME_BLOCK_CONNECTORS: ReadonlySet<string> = new Set([
  'of', 'and', 'at', 'the', 'for', 'de', 'la', 'van', 'von', 'du', 'del', 'da', 'y', 'e', 'x', 'ext',
  'cell', 'mobile', 'office', 'tel', 'phone', 'fax', 'email', 'direct', 'main',
]);
/** Longest tail a mid-line cue may cut; a signature block flattened onto one line is short. */
export const MIDLINE_SIGNATURE_MAX_TAIL = 120;
// Business facts that mean a mid-line "Regards," tail is note text, not a signature: an amount, an
// SF figure, a suite / unit / building number, or a date.
const BUSINESS_TAIL_RE = new RegExp(
  [
    String.raw`\$`,
    String.raw`\d[\d,.]*\s*(?:sf|sq\.?\s*ft|square\s+f(?:ee|oo)t)\b`,
    String.raw`/\s*sf\b`,
    String.raw`\b(?:suite|ste\.?|unit|bldg\.?|building)\s*#?\s*(?:\d|[a-z]\b)`,
    String.raw`\b\d{1,2}/\d{1,2}(?:/\d{2,4})?\b`,
    String.raw`\b\d{4}-\d{2}-\d{2}\b`,
    String.raw`\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}\b`,
  ].join('|'),
  'i',
);

/** Text after a cue that reads as a name / title / address block: every lower-case word is a
 *  connector ("Jane Doe Director of Leasing"), so "Lowe's will deliver Friday" is prose. */
function isNameBlock(after: string): boolean {
  const words = after.replace(/\[(?:contact|email|phone|signature) redacted\]/g, ' ').match(/[A-Za-z][\w'’.&-]*/g) ?? [];
  return words.every((w) => /^[A-Z]/.test(w) || NAME_BLOCK_CONNECTORS.has(w.toLowerCase()));
}

/** Does the text after a sign-off cue open a signature (round 2, C3)? `after` is the rest of the
 *  cue's line, `tail` the rest of the text. Empty `after` (cue alone on its line / at the end): a
 *  strong cue opens a signature, a weak one needs contact data in the tail. Otherwise the text must
 *  start with a capital (lower-case continuation is prose), and the tail must carry contact data or,
 *  for a strong cue, be a name block with no business fact on the cue's line. */
function isSignatureTail(strong: boolean, after: string, tail: string): boolean {
  const rest = after.trim();
  if (rest === '') return strong || CONTACT_TOKEN_RE.test(tail);
  if (!/^[A-Z]/.test(rest)) return false;
  if (CONTACT_TOKEN_RE.test(tail)) return true;
  return strong && isNameBlock(rest) && !BUSINESS_TAIL_RE.test(rest);
}

function cutAt(text: string, cueStart: number): string {
  return `${text.slice(0, cueStart).trimEnd()} ${SIGNATURE_PLACEHOLDER}`.trimStart();
}

function stripMidlineSignature(text: string): string {
  if (text.includes('\n')) return text;
  for (const m of text.matchAll(MIDLINE_SIGNOFF_RE)) {
    const cueStart = m.index ?? 0;
    const tail = text.slice(cueStart);
    if (tail.length > MIDLINE_SIGNATURE_MAX_TAIL) continue;
    if (m[3] === undefined) {
      // "following up with regards, the roof": lower-case "with" before a bare Regards is prose.
      if (/^regards/i.test(m[0]) && /\bwith\s+$/.test(text.slice(0, cueStart))) continue;
      if (!isSignatureTail(m[1] !== undefined, text.slice(cueStart + m[0].length), tail)) continue;
    }
    return cutAt(text, cueStart);
  }
  return text;
}

/** Both signature rules, run to their own fixed point in one step (adversarial review 2026-10-30,
 *  C2): a cut shortens every earlier cue's tail and can bring an earlier line into the last-N-lines
 *  window, so stacked sign-off blocks would otherwise each cost one outer pass. Terminates: every cut
 *  removes at least one cue and the placeholder contains none. */
function stripSignature(text: string): string {
  let out = text;
  for (;;) {
    const next = stripMidlineSignature(stripLineSignature(out));
    if (next === out) return out;
    out = next;
  }
}

function stripLineSignature(text: string): string {
  const lines = text.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] ?? '';
    const lineStart = offset;
    offset += line.length + 1;
    if (i < lines.length - SIGNATURE_MAX_LINES) continue;
    const m = SIGNOFF_LINE_RE.exec(line);
    if (!m) continue;
    const cueStart = lineStart + (line.length - line.trimStart().length);
    const tail = text.slice(cueStart);
    if (tail.length > SIGNATURE_MAX_TAIL) continue;
    // "Thanks," / "Best," / "Cheers," / "Thank you," also open ordinary sentences; treat them as a
    // sign-off only when the tail carries contact data. Text after the cue on its own line must read
    // as a signature too ("Sincerely, Lowe's will deliver Friday" is a sentence; round 2, C3).
    const cue = (m[1] ?? '').toLowerCase();
    if (m[2] === undefined && m[3] === undefined) {
      const strong = /regards|sincerely/.test(cue);
      if (!isSignatureTail(strong, line.slice(line.indexOf(m[0].trim()) + m[0].trim().length), tail)) continue;
    }
    return cutAt(text, cueStart);
  }
  return text;
}

function redactOnce(text: string): string {
  let out = stripSignature(text);
  out = out.replace(NAME_ADDR_RE, (match: string, offset: number, all: string) => {
    const scrubbed = scrubName(match.slice(0, match.indexOf('<')).trim(), cueBefore(all, offset));
    return scrubbed === null ? CONTACT_PLACEHOLDER : `${scrubbed} <${EMAIL_PLACEHOLDER}>`;
  });
  out = out.replace(NAME_PHONE_RE, (match: string, offset: number, all: string) => {
    const trailing = /[\s\-–:]*$/.exec(match)?.[0] ?? '';
    const scrubbed = scrubName(match.slice(0, match.length - trailing.length), cueBefore(all, offset));
    return scrubbed === null ? `${CONTACT_PLACEHOLDER} ` : `${scrubbed}${trailing}`;
  });
  out = out.replace(HEADER_NAME_RE, (match: string, label: string, gap: string, name: string, offset: number, all: string) => {
    if (!/[A-Za-z]/.test(name)) return match;
    const scrubbed = scrubName(name.trim(), true); // the header label is the cue
    if (scrubbed !== null) return `${label}:${gap}${scrubbed} `;
    // The name alone; a placeholder already following it stands for the whole contact.
    const rest = all.slice(offset + match.length);
    return rest.startsWith(CONTACT_PLACEHOLDER) ? `${label}:${gap}` : `${label}:${gap}${CONTACT_PLACEHOLDER} `;
  });
  out = out.replace(TRUNC_ADDR_RE, '');
  out = out.replace(EMAIL_RE, EMAIL_PLACEHOLDER);
  out = out.replace(PHONE_RE, PHONE_PLACEHOLDER);
  return out;
}

/** Redact one free-text string. Pure and idempotent: the rules are re-applied until the text stops
 *  changing (capped at MAX_REDACTION_PASSES). */
export function redactNotesText(text: string): string {
  let out = text;
  for (let pass = 0; pass < MAX_REDACTION_PASSES; pass += 1) {
    const next = redactOnce(out);
    if (next === out) return out;
    out = next;
  }
  return out;
}

export interface RedactionResult<T> {
  value: T;
  /** Number of notes string values whose text changed. */
  changed: number;
}

/**
 * Deep-walk `input` and redact string values under any key in `keys` (default NOTES_KEYS).
 * Returns a new structure; nothing else is touched (key order, nulls, numbers, arrays preserved).
 */
export function redactSnapshotNotes<T>(input: T, keys: readonly string[] = NOTES_KEYS): RedactionResult<T> {
  let changed = 0;
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (node && typeof node === 'object') {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
        if (keys.includes(k) && typeof v === 'string') {
          const r = redactNotesText(v);
          if (r !== v) changed += 1;
          out[k] = r;
        } else {
          out[k] = walk(v);
        }
      }
      return out;
    }
    return node;
  };
  return { value: walk(input) as T, changed };
}
