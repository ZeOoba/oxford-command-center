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
//   3. Name-match: find a Property whose normalized name equals the normalized input
//      → use that Property.id as spineAId.
//   4. Slug fallback: if no name match, spineAId = slug(collateralName).
//   5. Alias lookup: PROPERTY_ALIASES[spineAId] ?? spineAId.
//      → identity when the id is already aligned.

export function resolvePropertyMasterId(
  collateralName: string | null,
  properties: { id: string; name: string }[],
): string | null {
  if (!collateralName || !collateralName.trim()) return null;

  const normalized = collateralName.trim().replace(/\s+/g, ' ').toLowerCase();

  // Step 1: name-match (case-insensitive, whitespace-normalized)
  const matched = properties.find((p) => p.name.trim().replace(/\s+/g, ' ').toLowerCase() === normalized);
  const spineAId = matched ? matched.id : slug(collateralName);

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
//   - If non-null: map.set(loan.id, resolvedId)
//   - If null:     push loan.id to unresolved
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
): LoanPropertyMapResult {
  const map = new Map<string, string>();
  const unresolved: string[] = [];

  for (const loan of loans) {
    // Only borrower-direction loans have collateral property assignments
    if (loan.direction !== 'borrower') continue;

    const resolved = resolvePropertyMasterId(loan.collateralProperty, properties);
    if (resolved !== null) {
      map.set(loan.id, resolved);
    } else {
      unresolved.push(loan.id);
    }
  }

  return { map, unresolved };
}
