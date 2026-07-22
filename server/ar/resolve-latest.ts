// server/ar/resolve-latest.ts
//
// Cross-report resolution for the headless AR feed. A single inbox sweep can carry rows from MORE
// THAN ONE aging report (a missed run, a corrected re-export dropped next to the original, or two
// property exports). AR aging is a POINT-IN-TIME balance, not additive across reports: the same
// unpaid $5,000 appearing on both the June and July aging is still $5,000 owed, not $10,000. Summing
// across reports (which mergeByLease would do) silently double-counts and mis-dates the balance.
//
// So: within one report, multiple units for a tenant sum (handled upstream by partitionArRows →
// mergeByLease, same as-of). ACROSS reports, the latest as-of SUPERSEDES — a newer report replaces an
// older one for that lease. This module does only the cross-report supersede; each input row is
// already one lease from one report.

import type { TenantArrears } from '../../src/contracts/index';

export interface DatedArrearsWrite {
  leaseId: string;
  /** Arrears buckets plus the report's asOfDate/sourceFile provenance. */
  arrears: TenantArrears;
  tenant: string;
}

/** Comparable as-of instant. null/undefined/unparseable → -Infinity, so any DATED report supersedes
 *  an undated one (an undated file is the least-trustworthy point-in-time and must not win). */
function asOfMs(a: TenantArrears): number {
  const d = a.asOfDate;
  if (d instanceof Date) return d.getTime();
  if (typeof d === 'string') {
    const t = Date.parse(d);
    return Number.isNaN(t) ? -Infinity : t;
  }
  return -Infinity;
}

/**
 * Keep one arrears record per lease: the one with the latest asOfDate. A dated report beats an
 * undated one; an exact as-of tie keeps the later-scanned row (assumed the more recent drop).
 * NEVER sums across rows. Returns the winners plus the leaseIds that had >1 contributing report
 * (so the caller can surface the supersede rather than let it happen silently).
 */
export function resolveLatestArrears(
  rows: readonly DatedArrearsWrite[],
): { resolved: DatedArrearsWrite[]; superseded: string[] } {
  const best = new Map<string, DatedArrearsWrite>();
  const superseded = new Set<string>();
  for (const row of rows) {
    const prev = best.get(row.leaseId);
    if (prev === undefined) {
      best.set(row.leaseId, row);
      continue;
    }
    superseded.add(row.leaseId); // this lease appeared in more than one report this sweep
    if (asOfMs(row.arrears) >= asOfMs(prev.arrears)) best.set(row.leaseId, row);
  }
  return { resolved: [...best.values()], superseded: [...superseded] };
}
