// src/modules/intel/approve-blockers.ts
//
// Why approveImport (server/warehouse/actions.ts) refuses a pending-review import WHATEVER its sign, computed from
// data the views already hold: the imports list, and a data-quality issue's own property. "Mark sign verified" only
// lifts the sign gate, so where one of these applies the views stop offering it and say why. This mirrors the server
// gates and never replaces them: where the UI cannot tell (no imports list, or no sign issue to read the ledger key
// from), it reports nothing and the server's refusal still applies.
import type { ImportSummary } from './hooks';

export type ApproveBlocker = 'newer-version-committed' | 'property-unresolved' | 'property-mismatch';

/** approveImport's property-unresolved predicate: a NULL, blank or 'unknown' batch property. */
export function isPropertyUnresolved(propertyId: string | null | undefined): boolean {
  return propertyId == null || propertyId.trim() === '' || propertyId === 'unknown';
}

/** raw-store.ts newerCommittedImport: a COMMITTED import of the same property and period that arrived later (higher
 *  id). A null property matches nothing (the server's supersede joins on `=`); periods compare null-safely (`IS`). */
export function hasNewerCommittedVersion(imp: ImportSummary, imports: readonly ImportSummary[]): boolean {
  if (imp.propertyId === null) return false;
  return imports.some(
    (o) =>
      o.status === 'committed' &&
      o.id > imp.id &&
      o.propertyId === imp.propertyId &&
      o.periodStart === imp.periodStart &&
      o.periodEnd === imp.periodEnd,
  );
}

/**
 * The refusal approveImport returns before reaching its sign gate, in server order, or null when none can be known.
 * `ledgerPropertyId` is the property the import's ledger rows are keyed to, when the caller knows it (null meaning
 * 'unknown'); pass undefined when it does not. A sign-undecidable issue carries it exactly: ingest writes that issue
 * and the ledger rows from the same detection, and a re-derive rewrites both.
 */
export function signVerifyBlocker(
  imp: ImportSummary,
  imports: readonly ImportSummary[],
  ledgerPropertyId?: string | null,
): ApproveBlocker | null {
  if (imp.status !== 'pending-review') return null;
  if (hasNewerCommittedVersion(imp, imports)) return 'newer-version-committed';
  if (isPropertyUnresolved(imp.propertyId)) return 'property-unresolved';
  if (ledgerPropertyId !== undefined && (ledgerPropertyId ?? 'unknown') !== imp.propertyId) return 'property-mismatch';
  return null;
}

/** The reason shown next to a disabled "Mark sign verified". */
export const SIGN_VERIFY_BLOCKED_REASON: Record<ApproveBlocker, string> = {
  'newer-version-committed':
    'A newer version of this period is already committed, so Approve refuses this import whatever the sign ' +
    '(newer-version-committed): verifying would not unlock it. Reject it; the newer version stays.',
  'property-unresolved':
    "This import's property is unresolved, so Approve refuses it whatever the sign (property-unresolved): " +
    'verifying would not unlock it. Approve shows the re-drop steps; Reject is available.',
  'property-mismatch':
    "This import's ledger rows are keyed to a different property than the import, so Approve refuses it whatever " +
    'the sign (property-mismatch): verifying would not unlock it. Approve shows the re-drop steps; Reject is available.',
};
