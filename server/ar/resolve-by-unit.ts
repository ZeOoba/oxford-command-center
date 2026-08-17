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

import type { BucketedUnitRow } from './delinquency-bucketed';

export interface UnitLease {
  id: string;
  unit: string | null;
  propertyId: string;
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

/** Expand a compound unit label into its set of canonical tokens. Handles a single letter shared
 *  across a separator-delimited numeric list, in EITHER position ('C 1-2' -> {C1,C2}; '11-12A' ->
 *  {A11,A12}), and falls back to canonicalizing each separator-delimited piece independently when
 *  every piece already carries its own letter ('A11+A12+C3' -> {A11,A12,C3}). Delimiters: '+', '-',
 *  '&', ',', and the word 'and'. */
export function expandUnitTokens(raw: string): Set<string> {
  const normalized = raw.trim().toUpperCase().replace(/\bAND\b/g, '+');

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

export function resolveByUnit(
  row: BucketedUnitRow,
  leases: readonly UnitLease[],
  propertyId: string | null,
): UnitResolution {
  // An unresolved property means we cannot scope the unit. Matching portfolio-wide would let one
  // property's '4A' collect another property's '4A' — the Columbus-vs-Salisbury collision class.
  if (propertyId === null) return { leaseId: null, confidence: 'none', ambiguous: false };

  const target = expandUnitTokens(row.unit);
  if (target.size === 0) return { leaseId: null, confidence: 'none', ambiguous: false };

  const hits = leases.filter(
    (l) => l.propertyId === propertyId && l.unit !== null && setsEqual(expandUnitTokens(l.unit), target),
  );

  if (hits.length === 1) return { leaseId: hits[0]?.id ?? null, confidence: 'exact', ambiguous: false };
  if (hits.length > 1) return { leaseId: null, confidence: 'none', ambiguous: true };
  return { leaseId: null, confidence: 'none', ambiguous: false };
}
