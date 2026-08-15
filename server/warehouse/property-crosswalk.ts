// server/warehouse/property-crosswalk.ts
//
// Phase 2 — loan-to-property binding crosswalk.
//
// Resolves a workbook collateral property NAME (Spine A display name) to a
// property_master id (Spine B warehouse id), closing the two-spine id-mismatch
// hazard in one reusable place.
//
// Most properties: slug(name) === id (aligned — e.g. address-based names).
// A few entity/portfolio names diverge (e.g. FVC/Sepich). Those are listed
// in PROPERTY_ALIASES below, derived by iterating CANON_PROPERTIES and
// comparing slug(name) to id.
//
// NEVER called at parse time — called at snapshot-write time to bind
// the collateralProperty string to a real property_master id.

import { slug } from '../../src/contracts/common';
import type { Loan } from '../../src/contracts/index';

// ── PROPERTY_ALIASES ─────────────────────────────────────────────────────────
//
// Maps: slug(name) → id, for every CANON_PROPERTY where slug(name) !== id.
//
// Derived by running slug() over each CANON_PROPERTIES entry:
//   slug('FVC — Fairground Village Center / Sepich Portfolio (8 props)')
//     → 'fvc-fairground-village-center-sepich-portfolio-8-props'
//     ≠  'sepich-portfolio-columbus-oh-8-props'
//
//   slug('1851 S Club — Solar (25% roof project)')
//     → '1851-s-club-solar-25-roof-project'
//     ≠  '1851-s-club-solar'
//
// All other CANON_PROPERTIES have slug(name) === id (identity — no alias needed).

export const PROPERTY_ALIASES: Record<string, string> = {
  'fvc-fairground-village-center-sepich-portfolio-8-props': 'sepich-portfolio-columbus-oh-8-props',
  '1851-s-club-solar-25-roof-project': '1851-s-club-solar',
};

// ── resolvePropertyMasterId ───────────────────────────────────────────────────
//
// Resolves a raw collateral property name from the workbook to a property_master id.
//
// Resolution order:
//   1. Blank / null → null (safe: unattributed, never misattributed).
//   2. Normalize (trim + collapse whitespace + lowercase).
//   3. Name-match: find every Property whose normalized name equals the normalized input.
//      Exactly one match → use that Property.id as spineAId. More than one match (two
//      properties sharing a display name) → null (safe: ambiguous, never misattributed — see
//      L4 below). Not constructible from today's canon roster, but if it ever occurs this must
//      not silently pick whichever duplicate happens to sort first.
//   4. Slug fallback: if no name match, spineAId = slug(collateralName).
//   5. Alias lookup: PROPERTY_ALIASES[spineAId] ?? spineAId.
//      → identity when the id is already aligned.

export function resolvePropertyMasterId(
  collateralName: string | null,
  properties: { id: string; name: string }[],
): string | null {
  if (!collateralName || !collateralName.trim()) return null;

  const normalized = collateralName.trim().replace(/\s+/g, ' ').toLowerCase();

  // Step 1: name-match (case-insensitive, whitespace-normalized).
  //
  // L4 (2026-07-27 round-19-LOWs sweep): the original .find() picked the FIRST match by array
  // order — an artifact of whatever order `properties` happened to arrive in, with no
  // correctness meaning. Two distinct properties sharing a display name would silently
  // misattribute a loan to whichever one sorted first, at random, rather than the one the
  // collateral name actually named. Collecting ALL matches and refusing to guess on ambiguity
  // (returning null, same as the blank-name case) routes it into buildLoanPropertyMap's existing
  // `unresolved` reporting instead of a coin-flip attribution.
  const matches = properties.filter(
    (p) => p.name.trim().replace(/\s+/g, ' ').toLowerCase() === normalized,
  );
  if (matches.length > 1) return null;
  const spineAId = matches.length === 1 ? matches[0]!.id : slug(collateralName);

  // Step 2: alias lookup — resolves entity names whose id differs from slug(name)
  return PROPERTY_ALIASES[spineAId] ?? spineAId;
}

// ── buildLoanPropertyMap ──────────────────────────────────────────────────────
//
// Shared helper used by the snapshot writer (debt-snapshot.ts) and the reload
// trigger (server/index.ts brain.on('snapshot')).
//
// For each borrower-direction loan:
//   - resolvePropertyMasterId(loan.collateralProperty, properties)
//   - If non-null AND in validPropertyIds: map.set(loan.id, resolvedId)
//   - Otherwise: push loan.id to unresolved
//
// The validPropertyIds guard catches typo'd collateral names that produce a
// non-null slug which is not actually in property_master — without it, a typo
// silently enters the map and the downstream FK-null-backstop in writeDebtSnapshot
// (which fires *after* property_id is already trusted) would mask the issue.
// Both null resolutions (blank/null name) AND typo'd-but-non-master names land
// in `unresolved` so the "counted not hidden" caller warning is true for both.
//
// Lender and internal loans are excluded silently (they have no collateral property).
// unresolved.length is reported by callers — never hidden.

export interface LoanPropertyMapResult {
  map: Map<string, string>;
  unresolved: string[];
}

export function buildLoanPropertyMap(
  loans: Loan[],
  properties: { id: string; name: string }[],
  validPropertyIds: ReadonlySet<string>,
): LoanPropertyMapResult {
  const map = new Map<string, string>();
  const unresolved: string[] = [];

  for (const loan of loans) {
    // Only borrower-direction loans have collateral property assignments
    if (loan.direction !== 'borrower') continue;

    const resolved = resolvePropertyMasterId(loan.collateralProperty, properties);
    if (resolved !== null && validPropertyIds.has(resolved)) {
      map.set(loan.id, resolved);
    } else {
      unresolved.push(loan.id);
    }
  }

  return { map, unresolved };
}
