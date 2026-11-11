// server/ar/resolve-by-unit.ts
//
// (property, unit) -> Lease.id resolution for Format B, whose export carries no tenant name.
// Separate from match-tenant.ts, which is name-based and must not be weakened to accept nameless rows.
//
// SET-EQUALITY EXACT MATCH ONLY, by design. Verified against the real Northwood lease roster
// (2026-08-16): the PM export and ORA's own rent roll disagree on unit-label CONVENTION in two ways
// a naive strip-non-alphanumeric normalizer cannot bridge:
//
//   1. Digit/letter ORDER is reversed for buildings A and B: the PM export writes '4A' / '01B'
//      (number-then-letter), ORA's roster writes 'A4' / 'B1' (letter-then-number). Building C's
//      export rows already lead with the letter ('C 1-2'), so this is a PM-export-internal
//      inconsistency, not a universal rule — canonicalToken() below accepts either order and
//      strips a leading zero ('01B' -> 'B1').
//
//   2. Compound units use different separators and must be expanded to a SET (the general match-
//      ladder's documented R2 rung), then compared by set EQUALITY — never partial overlap or edit
//      distance. A unit label is short and low-entropy ('4A' vs '4B' differ by one character and are
//      different tenants), so ANY ambiguity routes to review rather than guessing. Found live: the
//      real AR row '11-12A' expands to {A11, A12}, but the only real lease covering those units is
//      'A11+A12+C3' — a 3-unit merged lease. {A11,A12} is a proper SUBSET of {A11,A12,C3}, not equal
//      to it, so this correctly falls through to review rather than auto-matching on partial overlap
//      — whether the AR row's balance belongs entirely to that merged lease, or the export is
//      tracking a sub-unit ORA's roster no longer breaks out separately, is a human call.
//
//   3. The export sometimes appends a PARENTHETICAL USE descriptor to the label ('C 4 (storage)');
//      ORA's roster never does. It is an annotation, not identity, so stripAnnotations() removes it
//      before canonicalization — the comparison stays set-EQUALITY exact, it just no longer treats
//      'STORAGE' as part of the unit token. Found live on the 2026-08-21 nbc-c export.
//      Only WORD-shaped parentheticals are stripped (isUseAnnotation): a parenthetical that carries
//      identity — 'C 4 (2)' -> C42, '12(A)' -> A12 — is left alone, because deleting its contents
//      would silently retarget the row onto a real but DIFFERENT unit (C4, or nothing at all).

import type { BucketedUnitRow } from './delinquency-bucketed';
import { isDeadLease } from './lease-liveness';

export interface UnitLease {
  id: string;
  unit: string | null;
  propertyId: string;
  /** Optional -- when present and dead per isDeadLease ('Expired' / 'Vacant'), resolveByUnit uses
   *  it to detect a re-let unit (see that function's doc). Callers that never populate it get the
   *  pre-2026-08-24 behavior. */
  status?: string | null;
  /** Optional -- annualRent === 0 also makes a lease dead per isDeadLease (2026-09-14 sweep, Fix
   *  A: a zero-rent Active placeholder is not a billing tenant). Absent/null = unknown = not dead. */
  annualRent?: number | null;
  /** Optional -- contract monthly rent; an Active annualRent-0 lease with monthlyRent > 0 is a fully
   *  abated live tenant, not a placeholder (see isDeadLease). */
  monthlyRent?: number | null;
  /** Optional -- the roster's tenant name, surfaced by unitCandidates() so a Format B row that
   *  lands in the review queue can say who the roster puts at that unit (the row itself carries no
   *  name). Never used for matching: Format B resolution stays unit-only. */
  tenantName?: string | null;
}

export interface UnitResolution {
  leaseId: string | null;
  confidence: 'exact' | 'none';
  ambiguous: boolean;
}

/** Canonicalize ONE unit token to a stable LETTER+NUMBER form regardless of which order the source
 *  wrote them in, and regardless of a leading zero. 'A4', '4A', and '04A' all -> 'A4'. A token with
 *  no letter or no digit canonicalizes to its stripped form as-is (never throws). */
function canonicalToken(raw: string): string {
  const cleaned = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  const letterFirst = /^([A-Z]+)(\d+)$/.exec(cleaned);
  if (letterFirst) return letterFirst[1] + String(Number(letterFirst[2]));
  const digitFirst = /^(\d+)([A-Z]+)$/.exec(cleaned);
  if (digitFirst) return digitFirst[2] + String(Number(digitFirst[1]));
  return cleaned;
}

const DIGITS_AND_SEPS = /^[\d+\-&,\s]+$/;
const SEP = /[+\-&,]/;

/** True iff a parenthetical's contents are a USE descriptor ('storage', 'cold storage') rather than
 *  part of the unit's own identity. Deliberately narrow, because stripping the wrong parenthetical
 *  DESTROYS identity and can mis-attribute to a real but different lease:
 *
 *    'C 4 (2)'  canonicalizes to C42 — strip '(2)' and it becomes C4, a DIFFERENT unit
 *    '12(A)'    canonicalizes to A12 — strip '(A)' and it becomes 12, no unit at all
 *
 *  A use descriptor is a WORD: no digits, and at least three letters. That keeps every
 *  identity-bearing parenthetical (a bare letter, or anything containing a digit) intact and routed
 *  through the pre-existing canonicalization path untouched. */
function isUseAnnotation(contents: string): boolean {
  if (/\d/.test(contents)) return false;
  return (contents.match(/[A-Za-z]/g)?.length ?? 0) >= 3;
}

/** Strip a parenthetical USE descriptor the PM export appends to a unit label
 *  ('C 4 (storage)' -> 'C 4'). Such a parenthetical says what the space is used for; it is never
 *  part of the unit's identity, and the lease roster never carries one. Removing it BEFORE
 *  canonicalization keeps the match EXACT rather than weakening it — without this, '(storage)' folds
 *  into the token ('C4STORAGE') and matches nothing, sending a real balance to review forever
 *  (found live: the 2026-08-21 nbc-c row). A parenthetical that fails isUseAnnotation() is left
 *  exactly where it is, so this can never delete an identity-bearing character.
 *  Two leases whose labels differ only by annotation still canonicalize to the SAME token and are
 *  caught by resolveByUnit()'s hits.length > 1 ambiguity branch, so this cannot silently mis-attribute. */
function stripAnnotations(raw: string): string {
  return raw.replace(/\(([^()]*)\)/g, (whole, contents: string) => (isUseAnnotation(contents) ? ' ' : whole)).trim();
}

/** Expand a compound unit label into its set of canonical tokens. Handles a single letter shared
 *  across a separator-delimited numeric list, in EITHER position ('C 1-2' -> {C1,C2}; '11-12A' ->
 *  {A11,A12}), and falls back to canonicalizing each separator-delimited piece independently when
 *  every piece already carries its own letter ('A11+A12+C3' -> {A11,A12,C3}). Delimiters: '+', '-',
 *  '&', ',', and the word 'and'. A trailing parenthetical annotation is stripped first. */
export function expandUnitTokens(raw: string): Set<string> {
  const stripped = stripAnnotations(raw);
  // A label that is ONLY an annotation ('(storage)') carries no unit identity at all. Return an
  // EMPTY set so resolveByUnit() routes it to human review, rather than letting it canonicalize to
  // the empty token and set-equal some other label that also reduces to nothing.
  if (stripped === '' && raw.trim() !== '') return new Set();
  const normalized = stripped.toUpperCase().replace(/\bAND\b/g, '+');

  const leadMatch = /^([A-Z]+)\s*(.+)$/.exec(normalized);
  const leadBody = leadMatch?.[2] ?? '';
  if (leadMatch && DIGITS_AND_SEPS.test(leadBody)) {
    const prefix = leadMatch[1] ?? '';
    const nums = leadBody.split(SEP).map((p) => p.trim()).filter(Boolean);
    return new Set(nums.map((n) => canonicalToken(prefix + n)));
  }

  const trailMatch = /^(.+?)([A-Z]+)$/.exec(normalized);
  const trailBody = trailMatch?.[1] ?? '';
  if (trailMatch && DIGITS_AND_SEPS.test(trailBody)) {
    const suffix = trailMatch[2] ?? '';
    const nums = trailBody.split(SEP).map((p) => p.trim()).filter(Boolean);
    return new Set(nums.map((n) => canonicalToken(n + suffix)));
  }

  const pieces = normalized.split(SEP).map((p) => p.trim()).filter(Boolean);
  if (pieces.length === 0) return new Set([canonicalToken(normalized)]);
  return new Set(pieces.map((p) => canonicalToken(p)));
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
}

/**
 * Resolve (property, unit) -> leaseId. Callers should pass the FULL lease roster, including
 * Expired ones (2026-08-24, PR #302 review finding) -- filtering Expired leases out BEFORE calling
 * this, as an earlier version of the fix did, opened an adjacent hole: on a re-let unit (an Expired
 * lease and a new Active lease sharing the same unit label -- exactly the routine "vacate, then
 * re-let" business event), the Expired lease's exact match had made this unit AMBIGUOUS (2 hits ->
 * review), the safe outcome for a residual-delinquency row from the vacated tenant. Excluding the
 * Expired lease from the input entirely turned that same row into a single, 'exact'-confidence hit
 * -> AUTO-WRITE of the old tenant's arrears onto the NEW tenant's lease, with no review possible
 * (Format B rows carry no tenant name to cross-check against). Filtering status INSIDE this
 * function instead means an Expired sibling on the same unit still downgrades the match to
 * ambiguous/review, closing both holes at once.
 *
 * "Dead" widened from Expired-only to the shared isDeadLease predicate on 2026-09-14 (weekly
 * financial-code sweep, Fix A): a 'Vacant' record and an Active lease with annualRent 0 (real row:
 * Example Gymnastics, 2207 Northwood A15, with a live AR balance -- a placeholder that bills nothing) were
 * still counted as LIVE here and took a clean 'exact' hit with no review. Both the single-hit
 * refusal and the dead-sibling downgrade now apply to every dead status, and the same predicate
 * gates the name-matcher's roster (scripts/ar-import-headless.ts loadLeasesFromSnapshot) so the two
 * fresh-match pools cannot drift apart again.
 */
export function resolveByUnit(
  row: BucketedUnitRow,
  leases: readonly UnitLease[],
  propertyId: string | null,
): UnitResolution {
  // An unresolved property means we cannot scope the unit. Matching portfolio-wide would let one
  // property's '4A' collect another property's '4A' — the Columbus-vs-Salisbury collision class.
  if (propertyId === null) return { leaseId: null, confidence: 'none', ambiguous: false };

  const hits = unitCandidates(row, leases, propertyId);
  const liveHits = hits.filter((l) => !isDeadLease(l));
  const hasDeadSibling = liveHits.length < hits.length;

  if (liveHits.length === 1) {
    // A dead lease shares this unit -- possible re-let. Never silently attribute the (possibly
    // vacated tenant's) delinquency to whichever lease happens to be live; a human must confirm.
    if (hasDeadSibling) return { leaseId: null, confidence: 'none', ambiguous: true };
    return { leaseId: liveHits[0]?.id ?? null, confidence: 'exact', ambiguous: false };
  }
  if (liveHits.length > 1) return { leaseId: null, confidence: 'none', ambiguous: true };
  return { leaseId: null, confidence: 'none', ambiguous: false };
}

/**
 * Every lease at `propertyId` whose unit label set-equals the row's, REGARDLESS of status or rent
 * -- the raw hit set resolveByUnit filters for liveness. Exported (2026-09-14 sweep, Fix B) so the
 * headless importer can name who the roster puts at a unit when a Format B row lands in the review
 * queue: the row carries no tenant name, so without this a durable name-keyed SKIP ruling in the
 * mapping cache (e.g. "tenant 059 llc": "SKIP") is invisible to a human reading the queue. It is a
 * DISPLAY aid only -- never a matching input; Format B resolution stays unit-only and set-exact.
 * Returns [] for an unresolved property or an annotation-only label, mirroring resolveByUnit.
 */
export function unitCandidates(
  row: BucketedUnitRow,
  leases: readonly UnitLease[],
  propertyId: string | null,
): UnitLease[] {
  if (propertyId === null) return [];
  const target = expandUnitTokens(row.unit);
  if (target.size === 0) return [];
  return leases.filter(
    (l) => l.propertyId === propertyId && l.unit !== null && setsEqual(expandUnitTokens(l.unit), target),
  );
}
