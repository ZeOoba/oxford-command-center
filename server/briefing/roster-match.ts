// server/briefing/roster-match.ts
//
// The ONE normalised roster matcher for every egress / publication gate (refute R1, S1, S2). It
// wraps server/briefing/confidential.ts without changing that scanner's semantics: a raw
// scanForConfidential pass (identical results to before), then the same scan over a normalised
// copy of BOTH the haystack and every roster term, so line wraps, NBSP / ideographic spaces, soft
// hyphens, zero-width / bidi / tag characters, full-width forms, accents / combining marks and
// arbitrary punctuation can no longer split a term.
//
// Roster-availability semantics are exactly scanForConfidential's: THROWS when the roster is absent
// or unreadable; under the explicit CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1 opt-out it scans the
// placeholder. Publication decisions that must also refuse the placeholder use
// publicationRosterScan (server/sources/deal-declassification.ts), which builds on this.
import {
  scanForConfidential, loadConfidentialTerms, loadEgressTerms, type ConfidentialHit, type DealTerms,
} from './confidential';
import { matchRosterTerms } from './roster-core';

// The matcher core lives in ./roster-core (runtime-agnostic, shared with the Pages Function).
export { normalizeRosterText, normalizeTerms, COMPACT_MIN_LENGTH, matchRosterTerms } from './roster-core';

/** Raw + normalised + compact roster scan against an already-loaded roster. scanForConfidential
 *  runs first (unchanged semantics, cheap exact path); matchRosterTerms (./roster-core) then
 *  evaluates every term across all passes. */
export function rosterMatchWithTerms(value: unknown, terms: Record<string, DealTerms>): ConfidentialHit | null {
  return scanForConfidential(value, terms) ?? matchRosterTerms(value, terms);
}

/** Drop-in for scanForConfidential with the normalised pass added. Throws on an unreadable roster. */
export function rosterMatch(value: unknown): ConfidentialHit | null {
  return rosterMatchWithTerms(value, loadConfidentialTerms());
}

/**
 * Egress / publication matcher (refute round 3, U3): rosterMatch that ALSO refuses the placeholder
 * roster. The placeholder opt-out is a reduced-coverage concession for a local render; it must not
 * clear text for an external API or a public surface. THROWS on an unreadable OR placeholder roster.
 * Each caller keeps its own failure shape (block / degrade / generic error).
 */
export function egressRosterMatch(value: unknown): ConfidentialHit | null {
  return egressRosterScanner()(value);
}

/** egressRosterMatch's roster load done ONCE, returning a scanner bound to that roster. For a caller
 *  that scans many records in one decision (scripts/bake-mirror.ts rosterScrubSnapshot, refute round
 *  5 F1). loadEgressTerms is a single read that throws on an unreadable, empty or placeholder roster
 *  whatever the opt-out says, so the scan always runs against the roster that was checked (#478). */
export function egressRosterScanner(): (value: unknown) => ConfidentialHit | null {
  const terms = loadEgressTerms();
  return (value: unknown) => rosterMatchWithTerms(value, terms);
}

/** assertNoRosterMatch with egressRosterMatch's placeholder refusal (throws on hit, placeholder or
 *  unreadable roster). */
export function assertNoEgressRosterMatch(value: unknown): void {
  const hit = egressRosterMatch(value);
  if (hit) {
    throw new Error(`briefing model carries a confidential deal term (${hit.dealLabel}) — refusing to render`);
  }
}

/** Drop-in for assertNoConfidential with the normalised pass added (same label-only message). */
export function assertNoRosterMatch(value: unknown): void {
  const hit = rosterMatch(value);
  if (hit) {
    throw new Error(`briefing model carries a confidential deal term (${hit.dealLabel}) — refusing to render`);
  }
}
