/**
 * Deterministic PII redaction for free-text "notes" fields in the committed portfolio snapshot.
 *
 * WHY: notes are imported from pasted email threads (e.g. M365 To-Do task bodies) and carry
 * third-party contact data -- email addresses, phone numbers, and signature blocks. The snapshot
 * (data/snapshots/portfolio.json) is git-tracked and served to the mirror, so those values must be
 * scrubbed before they are written.
 *
 * Pure and dependency-free (no node imports) so it is usable from the server, scripts and tests.
 * Idempotent: redact(redact(x)) === redact(x). Only free text is touched; structure, ids and every
 * numeric/financial field are the caller's responsibility to leave alone -- see
 * `redactSnapshotNotes`, which rewrites ONLY string values under keys named in NOTES_KEYS.
 *
 * Rules, applied in this order:
 *   1. Signature block: from a sign-off ("Regards,", "Best regards,", "Sincerely,", "Thanks,",
 *      "Thank you,", "Cheers,", "Best,", "Sent from my ...", or a "-- " delimiter) to the end of the
 *      text, when that tail is at most SIGNATURE_MAX_TAIL chars -> "[signature redacted]".
 *      Cuts only at an unambiguous sign-off (comma or delimiter), never on a bare "thanks".
 *   2. Mail-header names: the display name after From:/To:/Cc:/Bcc: and any "Name <addr>" pair
 *      -> "[contact redacted]".
 *   2b. Capitalised name(s) immediately before a phone number -> "[contact redacted]".
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

/** Object keys whose string values are free-text notes subject to redaction. */
export const NOTES_KEYS: readonly string[] = ['notes'];

const EMAIL_SRC = String.raw`[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+`;
const EMAIL_RE = new RegExp(EMAIL_SRC, 'g');

// Phone: separators are required between groups (or parentheses around the area code) so bare
// 10-digit ids and ISO dates are not matched. Not preceded/followed by a digit or dash (parcel ids).
const PHONE_SRC =
  String.raw`(?<![\d-])(?:\+?1[\s.-]?)?(?:\(\d{3}\)\s*|\d{3}[\s.-])\d{3}[\s.-]\d{4}(?![\d-])(?:\s*(?:x|ext\.?)\s*\d{1,5}(?!\d))?`;
const PHONE_RE = new RegExp(PHONE_SRC, 'gi');

// Sign-off cue followed (after the comma) by the tail. Case-insensitive on the cue only.
const SIGNOFF_RE =
  /(?:^|[\s.!?])((?:best|kind|warm|warmest)\s+regards|regards|sincerely|cheers|thank\s+you|thanks|best)\s*(?:,|\n)|(?:^|\s)(sent\s+from\s+my\s+\w+)|(?:^|\n)--\s*(?:\n|$)/i;

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
// Header display names: "From: Jane Doe <" / "To: Jane Doe <" (name up to the angle bracket).
const HEADER_NAME_RE = /\b(From|To|Cc|Bcc|Sent by):\s*[^<\n:]{1,60}?(?=\s*<)/gi;
// Dangling address fragment cut off by truncation: "<jdoe" at end of text.
const TRUNC_ADDR_RE = /\s*<[^\s<>]*$/;

function stripSignature(text: string): string {
  const m = SIGNOFF_RE.exec(text);
  if (!m) return text;
  // Keep the leading separator char the regex consumed; cut from the cue itself.
  const cueStart = m.index + (m[0].length - m[0].trimStart().length);
  const tail = text.slice(cueStart);
  if (tail.length > SIGNATURE_MAX_TAIL) return text;
  // "Thanks," / "Best," / "Cheers," / "Thank you," also open ordinary sentences; treat them as a
  // sign-off only when the tail carries contact data.
  const cue = (m[1] ?? '').toLowerCase().replace(/\s+/g, ' ');
  const strong = /regards|sincerely|sent from my/.test(cue) || m[1] === undefined;
  if (!strong && !CONTACT_TOKEN_RE.test(tail)) return text;
  return `${text.slice(0, cueStart).trimEnd()} ${SIGNATURE_PLACEHOLDER}`.trimStart();
}

/** Redact one free-text string. Pure and idempotent. */
export function redactNotesText(text: string): string {
  let out = stripSignature(text);
  out = out.replace(NAME_ADDR_RE, CONTACT_PLACEHOLDER);
  out = out.replace(NAME_PHONE_RE, `${CONTACT_PLACEHOLDER} `);
  out = out.replace(HEADER_NAME_RE, (_m, label: string) => `${label}: ${CONTACT_PLACEHOLDER}`);
  out = out.replace(TRUNC_ADDR_RE, '');
  out = out.replace(EMAIL_RE, EMAIL_PLACEHOLDER);
  out = out.replace(PHONE_RE, PHONE_PLACEHOLDER);
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
