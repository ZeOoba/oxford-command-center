// server/briefing/confidential.ts
//
// A server-side confidential-term scanner for the briefing pipeline — the TypeScript twin of the
// egress hook's `find_hit` (C:/Users/Owner/.claude/hooks/confidentiality-guard.py). The hook twin ships
// through ora-claude-config PRs and must ALSO be deployed to the live ~/.claude checkout: until then the
// deployed hook may still be the raw lowercase match, so read the live file before assuming parity. A BriefingModel
// is an ownership-FINANCIAL artifact and by construction carries NO deal terms; this module exists
// to PROVE that invariant in a test (Behavior contract #3) and to fail loud if a future change ever
// let a confidential identifier reach the model.
//
// Normalized substring match (NFKD, invisible chars, whitespace, punctuation, digit groups: see
// confidential-normalize.ts) on each active deal's `always` terms, plus the `context` terms gated by a
// `context_requires_any` anchor — the same semantics as the Python guard once that is deployed. The terms come from the live
// confidential-terms.json; this is a confidentiality gate, so it FAILS CLOSED (throws) if that file is
// absent, unreadable, or empty. The only way to run with reduced (placeholder-only) coverage is the
// explicit CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 opt-out — never an automatic/silent fallback (see
// loadTerms() below). NEVER echo a matched term back out (don't widen the leak) — report only the label.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import {
  NORMALIZATION_TABLES,
  collectText,
  formsContain,
  mentionsAnyTerm,
  normalizeForScan,
  scanTexts,
  tightForm,
} from './confidential-normalize';
import { normalizeRosterText } from './roster-core';
export { collectText, mentionsAnyTerm, normalizeForScan };
export type { ScanForms } from './confidential-normalize';

interface DealTerms {
  label?: string;
  active?: boolean;
  always?: string[];
  context?: string[];
  context_requires_any?: string[];
}

/** Used ONLY when an operator has explicitly set CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 to
 *  knowingly accept reduced-coverage scanning on a box without the live hooks file. It carries NO
 *  real deal identifier — those live ONLY in confidential-terms.json (gitignored, off-machine) and
 *  must never land in a git-tracked file (the pre-push hook scans history for them). The structural
 *  placeholder term is impossible to collide with real ownership-financial text. */
const FALLBACK_TERMS: Record<string, DealTerms> = Object.freeze({
  placeholder: Object.freeze({
    label: 'Confidential Deal',
    active: true,
    always: ['__ora_confidential_placeholder__'],
    context: [],
    context_requires_any: [],
  }),
});

/**
 * True only when `terms` IS the placeholder stand-in loadTerms returns under
 * CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 (refute round 6, G7). Identity, not a scan of the sentinel
 * string: a real roster term that happens to be a substring of the sentinel ('Ora', 'Confidential',
 * 'placeholder') must not make every egress path treat the real roster as the placeholder.
 * loadTerms returns FALLBACK_TERMS itself (never a copy), and it is frozen.
 */
export function isPlaceholderRoster(terms: Record<string, DealTerms>): boolean {
  return terms === FALLBACK_TERMS;
}

/**
 * Resolves the path to the confidential terms configuration file.
 *
 * @returns The path to the confidential terms JSON file, using the `CONFIDENTIAL_TERMS_PATH` environment variable if set, otherwise a default location in the user's home directory.
 * Exported so Brain's roster watcher observes the exact file `loadTerms` reads (one resolver, no drift).
 */
export function termsPath(): string {
  return (
    process.env.CONFIDENTIAL_TERMS_PATH ??
    join(homedir(), '.claude', 'hooks', 'confidential-terms.json')
  );
}

/** Thrown by validateEntry: a PRESENT, parseable roster whose active entry can never match. Not
 *  caught by loadTerms' absent/unreadable fallback, so the placeholder opt-out cannot mask it. */
export class RosterSchemaError extends Error {}

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** A term either matcher can ever match: it normalises to something under main's tightForm OR
 *  roster-core's normalizeRosterText (final refute, L2). An empty, whitespace-only or invisible-only
 *  term normalises to nothing under both and matches nothing at any gate. */
const isUsableTerm = (t: string): boolean => tightForm(t) !== '' || normalizeRosterText(t) !== '';

/** A DEAD anchor (refute wf_fb340eb2, P4): not blank under tightForm (a blank anchor leaves the group
 *  unanchored, which is valid and fails closed) but made only of private-use, unassigned,
 *  noncharacter or surrogate code points (and whitespace), which roster-core's normaliser strips. */
const DEAD_ONLY = /^[\p{Co}\p{Cn}\p{Cs}\s]+$/u;
const isDeadAnchor = (a: string): boolean => {
  const t = tightForm(a);
  return t !== '' && DEAD_ONLY.test(t);
};

/** Count of usable terms (isUsableTerm) in a match field; throws if the field is present but is not
 *  an array of strings. */
function usableTerms(entry: Record<string, unknown>, field: keyof DealTerms, where: string): number {
  const v = entry[field];
  if (v === undefined) return 0;
  if (!Array.isArray(v) || !v.every((t) => typeof t === 'string')) {
    throw new RosterSchemaError(`confidential roster entry ${where}: "${field}" must be an array of strings`);
  }
  return v.filter(isUsableTerm).length;
}

/**
 * Refute round 5, F3: every ACTIVE entry must be able to match something. Before this, any
 * non-'_' object loaded as a valid entry, so a typo ({"x":["..."]}, {"x":{"terms":[...]}},
 * context with no anchors, {"x":{}}) loaded as "readable" and silently dropped that deal from
 * every gate. Rules, against the schema the matchers actually read (always / context /
 * context_requires_any; label / note are free metadata):
 *  - the entry is a plain object, and `active`, when present, is a boolean;
 *  - an entry with `active: false` is retired and is not term-checked (retiring a deal must never
 *    break the gate);
 *  - every present match field is an array of strings;
 *  - it has a USABLE `always` term, or BOTH a usable `context` term and a NON-EMPTY
 *    `context_requires_any` array (usable = normalises to something under either matcher, so an
 *    empty / whitespace / invisible-only term does not count); usable `context` without anchors is
 *    a half-configured gate and is rejected even when `always` is non-empty. Anchors without usable
 *    context gate nothing and load when a usable `always` term covers the deal. A non-empty anchor
 *    array whose anchors are all blank / invisible-only is VALID: it leaves the group unanchored
 *    (context always active, fail closed), matching scanForConfidential and the hook twin. A
 *    non-empty anchor array whose anchors are all DEAD (private-use / unassigned / noncharacter
 *    only, see isDeadAnchor) is rejected when context terms rely on it.
 * An all-retired roster stays valid: "no active confidential deal" is a legitimate state (and the
 * live roster's state as of this change), so throwing on it would disable every egress path.
 * Messages carry the entry's POSITION only, never its key (a deal slug) or a term.
 */
function validateEntry(val: unknown, position: number): DealTerms {
  const where = `#${position}`;
  if (!isPlainObject(val)) throw new RosterSchemaError(`confidential roster entry ${where} is not an object`);
  if (val.active !== undefined && typeof val.active !== 'boolean') {
    throw new RosterSchemaError(`confidential roster entry ${where}: "active" must be a boolean`);
  }
  if (val.active === false) return val as DealTerms;
  const always = usableTerms(val, 'always', where);
  const context = usableTerms(val, 'context', where);
  usableTerms(val, 'context_requires_any', where); // shape check only: throws unless an array of strings
  // Reconciliation with origin/main (c04bf53b): a PRESENT, non-empty `context_requires_any` array
  // counts as anchors even when every anchor is blank or invisible-only. scanForConfidential (and
  // the hook twin) treat such an anchor as matching everywhere, i.e. the group is UNANCHORED and its
  // context terms are always active: a fail-closed configuration, not a half-configured gate, so it
  // must load. Only a missing or EMPTY anchor list next to context terms (which can never fire) is
  // rejected.
  const anchorList = val['context_requires_any'];
  const anchorsPresent = Array.isArray(anchorList) && anchorList.length > 0;
  // Final refute, L2: usable context terms with no (or an empty) anchor array are a context group
  // that can never fire: rejected. The opposite shape, anchors with NO usable context term, gates
  // nothing; it is harmless when a usable `always` term covers the deal (both parents and the hook
  // accept it), so it loads, and with no usable `always` term the no-usable-term rule below throws.
  if (context > 0 && !anchorsPresent) {
    throw new RosterSchemaError(
      `confidential roster entry ${where}: "context" terms need a non-empty "context_requires_any" anchor list`,
    );
  }
  // Refute wf_fb340eb2 (P4): an anchor list whose anchors are ALL dead (private-use, unassigned or
  // noncharacter code points only) is no usable anchor list when context terms rely on it: main's
  // tightForm keeps such an anchor (so the group is not unanchored) while roster-core strips it.
  if (context > 0 && (anchorList as string[]).every(isDeadAnchor)) {
    throw new RosterSchemaError(
      `confidential roster entry ${where}: "context_requires_any" has no usable anchor (private-use / unassigned / noncharacter only)`,
    );
  }
  if (always === 0 && context === 0) {
    throw new RosterSchemaError(`confidential roster entry ${where} is active but has no usable term`);
  }
  return val as DealTerms;
}

/**
 * Loads active confidential deal terms from the live file.
 *
 * This is a confidentiality gate, not a productivity gate: it fails CLOSED. If
 * `confidential-terms.json` is absent or unreadable, this throws by default — it does NOT
 * silently degrade to scanning only the built-in placeholder, because that would let real
 * deal identifiers sail through undetected with no operator-visible signal beyond an easily
 * missed stderr line (see the 2026-07-06 audit finding this fixes).
 *
 * The ONLY way to run with reduced (placeholder-only) coverage is to explicitly set
 * `CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1` — a deliberate, logged acknowledgment, never an
 * automatic fallback. Do NOT key this off `NODE_ENV==='test'`: that is an automatic signal
 * vitest sets by default, not a human decision, and is exactly the condition that let this
 * guard silently no-op in CI for weeks. Tests get real matching coverage via a git-tracked
 * synthetic fixture wired through `CONFIDENTIAL_TERMS_PATH` in tests/setup.ts instead.
 *
 * @returns A record mapping deal identifiers to their term configurations.
 * @throws If the file is absent/unreadable/empty and CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER is not set.
 */
function loadTerms(): Record<string, DealTerms> {
  const terms = readRoster();
  if (terms) return terms;
  const path = termsPath();
  if (process.env['CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER'] === '1') {
    // Deliberate, explicit opt-in to reduced coverage -- always warn, regardless of NODE_ENV,
    // since choosing this mode should never be silent.
    process.stderr.write(
      '[briefing] WARNING: confidential-terms.json absent or unreadable at ' +
        path +
        ' -- CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 set, so the confidentiality guard is scanning ' +
        'the built-in placeholder ONLY; real deal identifiers will NOT be caught.\n',
    );
    return FALLBACK_TERMS;
  }
  throw new Error(
    `confidential-terms.json is absent, unreadable, or empty at ${path} -- refusing to render ` +
      'with a disabled confidentiality guard. Fix: provide a readable terms file at that path ' +
      '(or set CONFIDENTIAL_TERMS_PATH to point at one), or, ONLY for a deliberately reduced-' +
      'coverage dev box, set CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 to acknowledge and proceed ' +
      'with placeholder-only scanning.',
  );
}

/** ONE read of the roster file. The validated roster, or null when it is absent, unreadable,
 *  unparseable or has no entries. A present-but-malformed roster throws RosterSchemaError (F3). */
function readRoster(): Record<string, DealTerms> | null {
  try {
    const raw = JSON.parse(readFileSync(termsPath(), 'utf8')) as Record<string, unknown>;
    const out: Record<string, DealTerms> = {};
    let position = 0;
    for (const [key, val] of Object.entries(raw)) {
      if (key.startsWith('_')) continue;
      position++;
      out[key] = validateEntry(val, position);
    }
    return Object.keys(out).length > 0 ? out : null;
  } catch (e) {
    // A present-but-malformed roster fails closed outright (F3); only an absent / unreadable /
    // unparseable file falls through to the caller's closed-by-default handling.
    if (e instanceof RosterSchemaError) throw e;
    return null;
  }
}

/**
 * The strict roster loader for every EXTERNAL egress and publication decision (#478 item 2). Reads
 * the roster file exactly ONCE and returns those terms, so a caller that scans with the result scans
 * the same roster it checked. THROWS when the roster is absent, unreadable or empty whatever
 * CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER says: that opt-out is a reduced-coverage concession for a
 * local render and never clears data for an external API or a public surface. It never returns
 * FALLBACK_TERMS; the identity check below is a second guard should that ever change.
 *
 * It replaces a probe-then-scan pattern that read the roster twice: under the opt-out, a roster that
 * became unreadable between the two reads passed the placeholder probe as real and was then scanned
 * as the placeholder, which matches nothing (fail open).
 */
export function loadEgressTerms(): Record<string, DealTerms> {
  const terms = readRoster();
  if (!terms || isPlaceholderRoster(terms)) {
    throw new Error(
      'confidential roster is absent, unreadable or empty -- an external egress or publication ' +
        'decision refuses it (the CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER placeholder never clears egress)',
    );
  }
  return terms;
}

/** Read-only accessor for the live roster with loadTerms()' exact fail-closed semantics (throws when
 *  unreadable; placeholder only under the explicit opt-out). Lets a caller pass normalised copies of
 *  the terms to scanForConfidential (server/sources/deal-declassification.ts publicationRosterScan)
 *  without duplicating the load logic. Adds no behaviour to this module. */
export function loadConfidentialTerms(): Record<string, DealTerms> {
  return loadTerms();
}

export type { DealTerms };

/** SHA-256 of the four tables, pinned by tests on both sides of the TS/Python mirror. */
export function normalizationTablesSha256(): string {
  return createHash('sha256').update(NORMALIZATION_TABLES.join('|')).digest('hex');
}

export interface ConfidentialHit {
  dealLabel: string;
}

/**
 * Scans a value for confidential deal terms.
 *
 * Checks `always` terms (which match unconditionally) and `context` terms (which match only when a `context_requires_any` anchor is present). Matching is case-insensitive substring inclusion over NFKD-normalized text with invisible characters, typographic punctuation, whitespace variants and digit-group separators folded (see `normalizeForScan`).
 *
 * @returns `{ dealLabel: string }` for the first confidential term detected, or `null` if none found.
 */
export function scanForConfidential(value: unknown, terms = loadTerms()): ConfidentialHit | null {
  const texts = scanTexts(value);
  const hays = texts.map((t) => normalizeForScan(t)).filter((h) => h.text.some((x) => x));
  // Refute wf_fb340eb2 (P3): ALSO the raw lowercase substring test the branch parent (484ad726) ran
  // over its values-joined text. The normalised test is not a superset of it: NFKD runs before
  // lowercasing, and a compatibility character after a capital sigma (U+33A1) becomes a cased letter
  // that flips the sigma's context-sensitive lowercase form. Substring only, so it can only add hits.
  const lows = texts.map((t) => t.toLowerCase());
  if (hays.length === 0 && lows.length === 0) return null;
  const found = (t: string): boolean => {
    if (hays.some((h) => formsContain(h, t))) return true;
    const low = t.toLowerCase();
    return lows.some((l) => l.includes(low));
  };
  for (const [key, deal] of Object.entries(terms)) {
    if (deal.active === false) continue;
    const label = deal.label ?? key;
    for (const t of deal.always ?? []) {
      if (t && found(t)) return { dealLabel: label };
    }
    const anchors = deal.context_requires_any ?? [];
    // An anchor that normalizes to nothing (empty, whitespace or invisible-only) matches everywhere, as
    // '' always did in the pre-normalization matcher, so ANY such anchor leaves the group unanchored
    // (context terms always active): fail closed. A blank anchor must not be skipped just because a
    // real one sits next to it.
    const unanchored = anchors.length > 0 && anchors.some((a) => !a || !tightForm(a));
    if (anchors.length > 0 && (unanchored || anchors.some((a) => a && found(a)))) {
      for (const t of deal.context ?? []) {
        if (t && found(t)) return { dealLabel: label };
      }
    }
  }
  return null;
}

/**
 * Throws an error if the value contains any confidential term.
 *
 * The error message includes only the deal label.
 *
 * @throws If a confidential term is detected.
 */
export function assertNoConfidential(value: unknown): void {
  const hit = scanForConfidential(value);
  if (hit) {
    throw new Error(
      `briefing model carries a confidential deal term (${hit.dealLabel}) — refusing to render`,
    );
  }
}
