// server/ar/derive-ar-balances.ts
//
// Projects the per-lease `tenantArrears` record into the denormalized `arBalances[]` read model
// (contract: ArBalance). Each entry joins a lease's arrears buckets to its tenant/property
// identity, so flat-JSON consumers — chiefly the daily brief's Section 4c (collections) — can read
// AR without doing a leaseId→lease lookup themselves. Pure; no I/O.
//
// Called from applyOverlay (server/overlay.ts) so arBalances is recomputed on every derive and can
// never drift from tenantArrears. Empty tenantArrears → [].

import type { Lease } from '../../src/contracts/lease';
import type { ArBalance, TenantArrears } from '../../src/contracts/quickbooks';
import type { Property } from '../../src/contracts/property';
import type { DataQualityFlag } from '../../src/contracts/common';
import { resolvePropertyId } from '../workbook/parse';

/**
 * Build arBalances[] from the tenantArrears map and the lease list.
 *
 * - total = d30 + d60 + d90 + d90plus.
 * - Sorted worst-first: total desc, then tenantName asc for a stable tie-break.
 * - Orphan arrears (a leaseId with no matching lease) are SKIPPED: an unattributable balance is
 *   not actionable in the brief, and the import validates leaseId against the live snapshot, so
 *   this should not occur — skipping beats emitting an identity-less row.
 * - All-zero entries are KEPT: a written all-zero record means "checked, current", which is
 *   distinct from an absent entry ("no AR data"). Consumers filter `total > 0` when they want
 *   only live delinquencies.
 *
 * propertyId cross-check (2026-08-17 — financial-code integrity sweep): `lease.propertyId` used to
 * be copied blind. A pre-existing lease-snapshot defect (two Westerville Rd, Columbus OH leases
 * carrying propertyId 'baltimore') meant a whole property's delinquency reported under the WRONG
 * property with zero visibility. `properties` is optional (existing 2-arg callers/tests keep
 * working, trusting lease.propertyId as before); when supplied, propertyId is independently
 * re-derived from `lease.propertyKey` via the same resolver parse.ts uses, and the resolved id
 * wins on a disagreement — the freshly-resolved id is strictly more trustworthy than a value that
 * may have been wrong since the lease was first parsed. `flags` is an optional mutable
 * accumulator (same convention as parseLeases's `flags: DataQualityFlag[]` in parse.ts) that a
 * caller can merge into snapshot.dataQuality to make the correction visible, not silent.
 */
export function deriveArBalances(
  leases: readonly Lease[],
  tenantArrears: Readonly<Record<string, TenantArrears>>,
  properties?: readonly Property[],
  flags?: DataQualityFlag[],
): ArBalance[] {
  // Guard a nullish leases array: applyOverlay historically tolerated a base snapshot without a
  // populated leases list, and this projection must not newly break that. No leases → no join → [].
  const byId = new Map((leases ?? []).map((l) => [l.id, l]));
  const out: ArBalance[] = [];
  for (const [leaseId, a] of Object.entries(tenantArrears)) {
    const lease = byId.get(leaseId);
    if (!lease) continue; // orphan — unattributable, skip

    let propertyId = lease.propertyId;
    if (properties && properties.length > 0) {
      const resolved = resolvePropertyId(lease.propertyKey, properties as Property[]);
      if (resolved !== null && resolved !== lease.propertyId) {
        flags?.push({
          entity: leaseId,
          field: 'propertyId',
          issue:
            `AR balance's stored propertyId ("${lease.propertyId ?? 'null'}") disagrees with the ` +
            `property independently resolved from propertyKey "${lease.propertyKey}" ` +
            `("${resolved}") — using the resolved id for this AR balance.`,
          rawValue: lease.propertyId ?? undefined,
          severity: 'error',
        });
        propertyId = resolved;
      }
    }

    out.push({
      leaseId,
      tenantName: lease.tenantName,
      company: lease.company,
      unit: lease.unit,
      propertyKey: lease.propertyKey,
      propertyId,
      d30: a.d30,
      d60: a.d60,
      d90: a.d90,
      d90plus: a.d90plus,
      total: a.d30 + a.d60 + a.d90 + a.d90plus,
      asOfDate: a.asOfDate ?? null,
      sourceFile: a.sourceFile ?? null,
    });
  }
  out.sort((x, y) => y.total - x.total || x.tenantName.localeCompare(y.tenantName));
  return out;
}
