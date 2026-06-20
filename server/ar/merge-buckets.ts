// server/ar/merge-buckets.ts
//
// Pre-write bucket summation for the AR-aging import pipeline.
//
// The overlay write (POST /api/actions/tenant-arrears) does a REPLACE — not an accumulate.
// One tenant leasing multiple units produces multiple parser rows (AppFolio emits one row per
// unit block). Without summation, the second write silently overwrites the first, and row order
// decides which buckets survive — the same input file can produce different financial state
// depending on parse order. Group by leaseId and SUM before writing.

import type { TenantArrears } from '../../src/contracts/index';

export interface MergedRow {
  leaseId: string;
  arrears: TenantArrears;
  /** All tenant display names that contributed, joined with ' + ' for the summary table. */
  tenant: string;
  /** True when ≥2 parser rows resolved to this leaseId (multi-unit or suffix-collapsed pair). */
  multiUnit: boolean;
}

/** Group confirmed rows by leaseId and SUM bucket values. Preserves first-occurrence insertion
 *  order. Multi-unit rows have their display names joined with ' + '. */
export function mergeByLease(
  rows: ReadonlyArray<{ leaseId: string; arrears: TenantArrears; tenant: string }>,
): MergedRow[] {
  const map = new Map<string, { d30: number; d60: number; d90: number; d90plus: number; tenants: string[] }>();
  for (const { leaseId, arrears, tenant } of rows) {
    const acc = map.get(leaseId) ?? { d30: 0, d60: 0, d90: 0, d90plus: 0, tenants: [] };
    acc.d30 += arrears.d30;
    acc.d60 += arrears.d60;
    acc.d90 += arrears.d90;
    acc.d90plus += arrears.d90plus;
    acc.tenants.push(tenant);
    map.set(leaseId, acc);
  }
  return [...map].map(([leaseId, acc]) => ({
    leaseId,
    arrears: { d30: acc.d30, d60: acc.d60, d90: acc.d90, d90plus: acc.d90plus },
    tenant: acc.tenants.join(' + '),
    multiUnit: acc.tenants.length > 1,
  }));
}
