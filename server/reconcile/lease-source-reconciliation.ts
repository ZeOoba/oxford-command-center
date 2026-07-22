// server/reconcile/lease-source-reconciliation.ts
//
// Pure comparison logic cross-checking the Master Workbook's lease/tenant rows (server/workbook
// parse.ts, feeds data/snapshots/portfolio.json) against the Notion Tenant Database. These are
// two independent sources of truth for the same leases with NO reconciliation step before this
// module existed — a status correction made in one (e.g. the 2026-07-21 Tenant DB rent-roll
// reconciliation) has no way of ever reaching the other. This module reports where they
// disagree; it does not write to either source.
//
// Match key: normalized tenant name ONLY (not property). Property identifiers differ in format
// between the workbook (a short label like "1100 Rarig") and Notion (a full address string), and
// fuzzy address-matching risks false matches.
//
// Name collisions (2026-07-21 code review, Critical #1): a normalized name is NEVER matched when
// it is ambiguous — either the "VACANT" placeholder (used elsewhere in this codebase for an
// unoccupied unit, not a real tenant identity — server/workbook/parse.ts, renewals.test.ts) or a
// genuine duplicate (the same normalized name appearing more than once within the workbook, or
// more than once within Notion — e.g. a franchise tenant at two properties). Matching on an
// ambiguous name risks comparing unrelated leases across different properties, or silently
// dropping one of several same-named Notion rows via a Map overwrite. Ambiguous names are
// reported separately (`ambiguousNames`) so a human can resolve them; they are never guessed.
import type { Lease, LeaseStatus } from '../../src/contracts/lease';

export interface NotionTenantLease {
  tenantName: string;
  propertyAddress: string | null;
  leaseStatus: string | null;
  leaseStart: string | null;
  leaseEnd: string | null;
}

export type DivergenceSeverity = 'workbook-stale-expired' | 'notion-ahead-expired';

export interface LeaseSourceDivergence {
  tenantName: string;
  propertyKey: string;
  notionPropertyAddress: string | null;
  workbookStatus: LeaseStatus;
  notionStatus: string;
  workbookLeaseEnd: string | null;
  notionLeaseEnd: string | null;
  severity: DivergenceSeverity;
  note: string;
}

export interface LeaseReconciliationResult {
  divergences: LeaseSourceDivergence[];
  /** Tenant present in both sources, but one or both statuses aren't in the comparable subset
   *  (e.g. Notion "Month-to-Month"/"Notice Given" have no confident workbook equivalent) —
   *  skipped rather than compared with a fabricated mapping. */
  skippedIncomparable: string[];
  unmatchedInWorkbook: string[];
  unmatchedInNotion: string[];
  /** Normalized-name collisions (the placeholder "VACANT" name, or a genuine duplicate on either
   *  side) — deliberately never name-matched. Needs manual review, not an automated guess. */
  ambiguousNames: string[];
}

const normName = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Never a real, individually-identifiable tenant — used elsewhere in this codebase as the
 *  placeholder name for an unoccupied unit. Always excluded from name-matching, regardless of
 *  how many happen to appear in a given snapshot. */
const PLACEHOLDER_NAMES = new Set(['vacant']);

function countByNormalizedName<T>(items: T[], nameOf: (item: T) => string): Map<string, number> {
  const counts = new Map<string, number>();
  for (const item of items) {
    const key = normName(nameOf(item));
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** The only workbook/Notion status pairing this module has confidence comparing: whether the
 *  lease is "Expired" or is one of the occupied/active-ish states. Anything else (Notion
 *  "Month-to-Month", "Notice Given") is deliberately left uncompared — see module header. */
type ComparableBucket = 'expired' | 'active';

function workbookBucket(status: LeaseStatus): ComparableBucket | null {
  if (status === 'Expired') return 'expired';
  if (status === 'Active' || status === 'Expiring Soon' || status === 'Vacant') return 'active';
  return null; // 'Unknown'
}

function notionBucket(status: string | null): ComparableBucket | null {
  if (status === 'Expired') return 'expired';
  if (status === 'Active') return 'active';
  return null; // Month-to-Month, Notice Given, Vacant (Notion's own), or unset
}

export function reconcileLeaseSources(
  workbookLeases: Lease[],
  notionTenants: NotionTenantLease[],
): LeaseReconciliationResult {
  const workbookNameCounts = countByNormalizedName(workbookLeases, (l) => l.tenantName);
  const notionNameCounts = countByNormalizedName(notionTenants, (t) => t.tenantName);
  const isAmbiguous = (key: string): boolean =>
    PLACEHOLDER_NAMES.has(key) ||
    (workbookNameCounts.get(key) ?? 0) > 1 ||
    (notionNameCounts.get(key) ?? 0) > 1;

  const notionByName = new Map<string, NotionTenantLease>();
  for (const t of notionTenants) {
    const key = normName(t.tenantName);
    if (!isAmbiguous(key)) notionByName.set(key, t);
  }

  const divergences: LeaseSourceDivergence[] = [];
  const skippedIncomparable: string[] = [];
  const unmatchedInWorkbook: string[] = [];
  const ambiguousNames = new Set<string>();
  const matchedNames = new Set<string>();

  for (const lease of workbookLeases) {
    const key = normName(lease.tenantName);
    if (isAmbiguous(key)) {
      ambiguousNames.add(lease.tenantName);
      continue;
    }
    const notionRow = notionByName.get(key);
    if (!notionRow) {
      unmatchedInWorkbook.push(lease.tenantName);
      continue;
    }
    matchedNames.add(key);

    const wbBucket = workbookBucket(lease.status);
    const ntBucket = notionBucket(notionRow.leaseStatus);
    if (wbBucket === null || ntBucket === null) {
      skippedIncomparable.push(lease.tenantName);
      continue;
    }
    if (wbBucket === ntBucket) continue;

    const severity: DivergenceSeverity =
      wbBucket === 'expired' ? 'workbook-stale-expired' : 'notion-ahead-expired';
    divergences.push({
      tenantName: lease.tenantName,
      propertyKey: lease.propertyKey,
      notionPropertyAddress: notionRow.propertyAddress,
      workbookStatus: lease.status,
      notionStatus: notionRow.leaseStatus ?? 'Unknown',
      workbookLeaseEnd: lease.leaseEnd,
      notionLeaseEnd: notionRow.leaseEnd,
      severity,
      note:
        severity === 'workbook-stale-expired'
          ? `Workbook (Master Workbook / portfolio.json) shows Expired, but the Notion Tenant DB shows "${notionRow.leaseStatus}" — the workbook source needs a refresh to re-converge.`
          : `Notion Tenant DB shows Expired, but the workbook shows "${lease.status}" — confirm whether the workbook is stale or Notion is premature.`,
    });
  }

  for (const t of notionTenants) {
    if (isAmbiguous(normName(t.tenantName))) ambiguousNames.add(t.tenantName);
  }

  const unmatchedInNotion = notionTenants
    .map((t) => t.tenantName)
    .filter((name) => {
      const key = normName(name);
      return !isAmbiguous(key) && !matchedNames.has(key);
    });

  return {
    divergences,
    skippedIncomparable,
    unmatchedInWorkbook,
    unmatchedInNotion,
    ambiguousNames: [...ambiguousNames],
  };
}
