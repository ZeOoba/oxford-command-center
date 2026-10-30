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
 * its placeholder brings a sign-off tail under SIGNATURE_MAX_TAIL; removing one truncated "<frag"
 * exposes the next). Only free text is touched; structure, ids and every
 * numeric/financial field are the caller's responsibility to leave alone -- see
 * `redactSnapshotNotes`, which rewrites ONLY string values under keys named in NOTES_KEYS.
 *
 * Rules, applied in this order:
 *   1. Signature block: from a sign-off ("Regards,", "Best regards,", "Sincerely,", "Thanks,",
 *      "Thank you,", "Cheers,", "Best,", "Sent from my ...", or a "-- " delimiter) to the end of the
 *      text, when that tail is at most SIGNATURE_MAX_TAIL chars -> "[signature redacted]".
 *      The cue must START A LINE within the last SIGNATURE_MAX_LINES lines: a mid-line "Regards,"
 *      ("Re roof. Regards, the $8,200 quote ...") is business text and is never cut (contact data in
 *      it is still caught by rules 2-5). Weak cues (Thanks/Thank you/Cheers/Best) also need contact
 *      data in the tail.
 *   2. Mail-header names: the display name after From:/To:/Cc:/Bcc: and any "Name <addr>" pair
 *      -> "[contact redacted]".
 *   2b. Capitalised name(s) immediately before a phone number -> "[contact redacted]".
 *   Rules 2 and 2b keep a name that reads as a company or property (an LLC/Inc/Co-style suffix, or
 *   Suite/Building/Park and similar; see BUSINESS_TOKENS): the vendor or the suite is the business
 *   fact the note is about. The address or phone next to it is still redacted.
 *   3. Truncated address fragments at end of text ("<localpart" with no closing) -> removed.
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

// "Name <addr>" (name = up to 4 words) -- run BEFORE bare-email replacement so the name goes too.
const NAME_ADDR_RE = new RegExp(
  String.raw`(?:[A-Z][\w'’.-]*\s+){0,3}[A-Z][\w'’.-]*\s*<\s*${EMAIL_SRC}(?:\s*>)?`,
  'g',
);
// Name directly before a phone number ("Test Person (555) 010-0123", "Test Person - 555-010-0123"):
// signature / contact-list names with no sign-off cue. Up to 3 capitalised words.
const NAME_PHONE_RE = new RegExp(
  String.raw`(?:[A-Z][\w'’.-]*\s+){1,3}(?:[-–:]\s*)?(?=${PHONE_SRC})`,
  'g',
);
// Words that make a name a company or property rather than a person (compared case-insensitively,
// trailing "." / "," ignored). Matching any one keeps the name.
const BUSINESS_TOKENS: ReadonlySet<string> = new Set([
  'llc', 'l.l.c', 'inc', 'incorporated', 'corp', 'corporation', 'co', 'company', 'ltd', 'lp', 'llp', 'pllc',
  'pc', 'group', 'partners', 'holdings', 'properties', 'realty', 'services', 'suite', 'ste', 'unit',
  'building', 'bldg', 'park', 'plaza', 'center', 'centre', 'industrial',
]);

function isBusinessName(name: string): boolean {
  return name
    .split(/\s+/)
    .map((w) => w.replace(/[.,]+$/, '').toLowerCase())
    .some((w) => BUSINESS_TOKENS.has(w));
}

// Header display names: "From: Jane Doe <" / "To: Jane Doe <" (name up to the angle bracket).
const HEADER_NAME_RE = /\b(From|To|Cc|Bcc|Sent by):\s*[^<\n:]{1,60}?(?=\s*<)/gi;
// Dangling address fragment cut off by truncation: "<jdoe" at end of text.
const TRUNC_ADDR_RE = /\s*<[^\s<>]*$/;

function stripSignature(text: string): string {
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
    // sign-off only when the tail carries contact data.
    const cue = (m[1] ?? '').toLowerCase();
    const strong = m[1] === undefined || /regards|sincerely/.test(cue);
    if (!strong && !CONTACT_TOKEN_RE.test(tail)) continue;
    return `${text.slice(0, cueStart).trimEnd()} ${SIGNATURE_PLACEHOLDER}`.trimStart();
  }
  return text;
}

function redactOnce(text: string): string {
  let out = stripSignature(text);
  out = out.replace(NAME_ADDR_RE, (match: string) => {
    const name = match.slice(0, match.indexOf('<')).trim();
    return isBusinessName(name) ? `${name} <${EMAIL_PLACEHOLDER}>` : CONTACT_PLACEHOLDER;
  });
  out = out.replace(NAME_PHONE_RE, (match: string) => (isBusinessName(match) ? match : `${CONTACT_PLACEHOLDER} `));
  out = out.replace(HEADER_NAME_RE, (match: string, label: string) =>
    isBusinessName(match.slice(match.indexOf(':') + 1)) ? match : `${label}: ${CONTACT_PLACEHOLDER}`,
  );
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
