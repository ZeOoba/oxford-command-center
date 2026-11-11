// @vitest-environment node
//
// Regression coverage for the 2026-08-24 integrity-sweep incident: loadLeasesFromSnapshot() fed
// EVERY lease -- including 'Expired' ones -- to the name matcher, so a delinquency export naming a
// vacated tenant auto-attributed to their dead lease at 'exact' confidence with zero human review.
// This silently reversed a ratified SKIP ruling on 2207-northwood-c4-duketa-llc (lease ended
// 2024-09-01) three days after it was made. Expired leases must never be auto-match candidates.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const snapshotDir = mkdtempSync(join(tmpdir(), 'ar-lease-status-test-'));
const snapshotPath = join(snapshotDir, 'portfolio.json');

vi.mock('../../server/config', () => ({
  SNAPSHOT_PATH: snapshotPath,
}));

function writeFixtureSnapshot(): void {
  writeFileSync(
    snapshotPath,
    JSON.stringify({
      leases: [
        { id: 'active-lease-1', tenantName: 'Active Tenant Co', company: 'Active Tenant Co', status: 'Active', annualRent: 25500, unit: 'A1', propertyId: 'prop-a' },
        { id: 'expiring-soon-lease-1', tenantName: 'Soon Gone LLC', company: 'Soon Gone LLC', status: 'Expiring Soon', annualRent: REDACTED-AMT, unit: 'A2', propertyId: 'prop-a' },
        { id: '2207-northwood-c4-duketa-llc', tenantName: 'Duketa LLC', company: 'Duketa LLC', status: 'Expired', annualRent: REDACTED-AMT, unit: 'C4', propertyId: 'prop-a' },
        { id: 'unknown-status-lease-1', tenantName: 'Mystery Tenant', company: null, status: 'Unknown', annualRent: 100, unit: 'A3', propertyId: 'prop-a' },
        // 2026-09-14 sweep, Fix A: the two real zero-rent-but-Active rows plus a Vacant placeholder.
        // Shaped like the live snapshot records (tenantName is the person, company is the entity).
        { id: '29000-information-lane-202-pameta-llc', tenantName: 'Zileta Kineta', company: 'Pameta LLC', status: 'Active', annualRent: 0, unit: '202', propertyId: 'prop-b' },
        { id: '2207-northwood-a15-example-gymnastics-and-dance-llc', tenantName: 'Dana  Example', company: 'Example Gymnastics and Dance LLC', status: 'Active', annualRent: 0, unit: 'A15', propertyId: 'prop-a' },
        { id: 'vacant-lease-1', tenantName: 'VACANT', company: null, status: 'Vacant', annualRent: 0, unit: 'A9', propertyId: 'prop-a' },
      ],
    }),
  );
}

describe('loadLeasesFromSnapshot excludes Expired leases from the auto-match candidate pool', () => {
  beforeEach(() => {
    writeFixtureSnapshot();
  });

  it('drops the Expired lease (Duketa LLC) entirely', async () => {
    vi.resetModules();
    const { loadLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const leases = loadLeasesFromSnapshot();
    expect(leases.find((l) => l.id === '2207-northwood-c4-duketa-llc')).toBeUndefined();
  }); // slow: first dynamic import of this module graph is transform-heavy

  it('keeps Active, Expiring Soon, and Unknown-status leases as match candidates', async () => {
    vi.resetModules();
    const { loadLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const leases = loadLeasesFromSnapshot();
    expect(leases.map((l) => l.id).sort()).toEqual(
      ['active-lease-1', 'expiring-soon-lease-1', 'unknown-status-lease-1'].sort(),
    );
  });

  it('end-to-end: matchTenantToLease can no longer resolve "Duketa LLC" once his lease is Expired', async () => {
    vi.resetModules();
    const { loadLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const { matchTenantToLease } = await import('../../server/ar/match-tenant');
    const leases = loadLeasesFromSnapshot();
    const match = matchTenantToLease('Duketa LLC', leases);
    // No candidate at all -> 'none' confidence -> falls through to human review, never an auto-write.
    expect(match.leaseId).toBeNull();
    expect(match.confidence).toBe('none');
  });
});

// 2026-09-14 weekly financial-code sweep, Fix A: the Expired-only guard was too narrow. An Active
// lease carrying annualRent === 0 (a roster placeholder that bills nothing -- real rows: Example Consulting
// Consulting Group, 29000 Information Lane #202; Example Gymnastics, 2207 Northwood A15) and a
// 'Vacant' record both passed as live fresh-match candidates, so an export naming either could
// auto-attribute to a lease that is not a billing tenant with zero human review. The shared
// predicate isDeadLease (server/ar/lease-liveness.ts) now gates BOTH fresh-match pools -- this
// loader and resolveByUnit's live-hit set -- and nothing else (see the loadAllLeaseIdsFromSnapshot
// tests below for the roster that must stay wide).
describe('loadLeasesFromSnapshot excludes Vacant and zero-rent-Active leases from the fresh-match pool (Fix A)', () => {
  beforeEach(() => {
    writeFixtureSnapshot();
  });

  it('drops an Active lease whose annualRent is 0 (Pameta LLC, Example Gymnastics)', async () => {
    vi.resetModules();
    const { loadLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const ids = loadLeasesFromSnapshot().map((l) => l.id);
    expect(ids).not.toContain('29000-information-lane-202-pameta-llc');
    expect(ids).not.toContain('2207-northwood-a15-example-gymnastics-and-dance-llc');
  });

  it('drops a Vacant lease', async () => {
    vi.resetModules();
    const { loadLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    expect(loadLeasesFromSnapshot().map((l) => l.id)).not.toContain('vacant-lease-1');
  });

  it('end-to-end: "Pameta LLC" no longer fresh-matches -- none confidence, routes to review', async () => {
    vi.resetModules();
    const { loadLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const { matchTenantToLease } = await import('../../server/ar/match-tenant');
    const match = matchTenantToLease('Pameta LLC', loadLeasesFromSnapshot());
    expect(match.leaseId).toBeNull();
    expect(match.confidence).toBe('none');
  });

  it('end-to-end: "Example Gymnastics and Dance LLC" no longer fresh-matches by name either', async () => {
    vi.resetModules();
    const { loadLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const { matchTenantToLease } = await import('../../server/ar/match-tenant');
    const match = matchTenantToLease('Example Gymnastics and Dance LLC', loadLeasesFromSnapshot());
    expect(match.leaseId).toBeNull();
    expect(match.confidence).toBe('none');
  });

  it('end-to-end: partitionArRows routes the Example Consulting row to review, never to write (no cache entry)', async () => {
    vi.resetModules();
    const { loadLeasesFromSnapshot, loadAllLeaseIdsFromSnapshot } = await import('../../scripts/ar-import-headless');
    const { partitionArRows } = await import('../../server/ar/partition-confidence');
    const rows = [{ tenant: 'Pameta LLC', property: null, d30: REDACTED-AMT, d60: REDACTED-AMT, d90: REDACTED-AMT, d90plus: REDACTED-AMT }];
    const p = partitionArRows(rows, loadLeasesFromSnapshot(), {}, loadAllLeaseIdsFromSnapshot());
    expect(p.write).toEqual([]);
    expect(p.review).toHaveLength(1);
    expect(p.review[0]!.proposedLeaseId).toBeNull();
  });

  it('regression: a live Active, non-zero-rent lease is completely unaffected (still exact, still auto-writes)', async () => {
    vi.resetModules();
    const { loadLeasesFromSnapshot, loadAllLeaseIdsFromSnapshot } = await import('../../scripts/ar-import-headless');
    const { matchTenantToLease } = await import('../../server/ar/match-tenant');
    const { partitionArRows } = await import('../../server/ar/partition-confidence');
    const leases = loadLeasesFromSnapshot();
    const match = matchTenantToLease('Active Tenant Co', leases);
    expect(match).toMatchObject({ leaseId: 'active-lease-1', confidence: 'exact', ambiguous: false });
    const p = partitionArRows(
      [{ tenant: 'Active Tenant Co', property: null, d30: 100, d60: 0, d90: 0, d90plus: 0 }],
      leases,
      {},
      loadAllLeaseIdsFromSnapshot(),
    );
    expect(p.write.map((w) => w.leaseId)).toEqual(['active-lease-1']);
    expect(p.review).toEqual([]);
  });
});

describe('loadAllLeaseIdsFromSnapshot stays DELIBERATELY wide -- every lease id, dead or not (PR #302 invariant)', () => {
  // partitionArRows' cache-hit validation must keep recognising a previously human-CONFIRMED mapping
  // to a now-dead lease as still valid, not "lease removed". Narrowing this roster was a real
  // regression once (PR #302 review: $9,596.90 + $REDACTED-AMT of live arrears froze). Fix A must not
  // touch it: the real cache entry "pameta llc" -> 29000-information-lane-202-... is
  // exactly such a confirmed mapping to a lease that is now dead under the wider predicate.
  beforeEach(() => {
    writeFixtureSnapshot();
  });

  it('includes Expired, Vacant, and zero-rent-Active ids alongside the live ones', async () => {
    vi.resetModules();
    const { loadAllLeaseIdsFromSnapshot } = await import('../../scripts/ar-import-headless');
    const ids = loadAllLeaseIdsFromSnapshot();
    for (const id of [
      'active-lease-1',
      'expiring-soon-lease-1',
      '2207-northwood-c4-duketa-llc',
      'unknown-status-lease-1',
      '29000-information-lane-202-pameta-llc',
      '2207-northwood-a15-example-gymnastics-and-dance-llc',
      'vacant-lease-1',
    ]) {
      expect(ids.has(id)).toBe(true);
    }
  });

  it('end-to-end: a confirmed cache mapping to the (now dead) Example Consulting lease still writes -- unchanged', async () => {
    vi.resetModules();
    const { loadLeasesFromSnapshot, loadAllLeaseIdsFromSnapshot } = await import('../../scripts/ar-import-headless');
    const { partitionArRows } = await import('../../server/ar/partition-confidence');
    const { cacheKey } = await import('../../server/ar/mapping-cache');
    const cache = { [cacheKey('Pameta LLC')]: '29000-information-lane-202-pameta-llc' };
    const rows = [{ tenant: 'Pameta LLC', property: null, d30: REDACTED-AMT, d60: 0, d90: 0, d90plus: 0 }];
    const p = partitionArRows(rows, loadLeasesFromSnapshot(), cache, loadAllLeaseIdsFromSnapshot());
    expect(p.write.map((w) => w.leaseId)).toEqual(['29000-information-lane-202-pameta-llc']);
    expect(p.review).toEqual([]);
  });
});

describe('loadUnitLeasesFromSnapshot + resolveByUnit: Expired leases are visible to resolution, not silently pre-filtered', () => {
  // PR #302 review finding (Qodo): an EARLIER version of this fix excluded Expired leases in the
  // LOADER, mirroring the name-based path -- but that opened an adjacent hole on a re-let unit (see
  // the third test below). loadUnitLeasesFromSnapshot now returns the FULL roster (status included)
  // and resolveByUnit does the Expired-aware filtering itself, so it can detect an Expired sibling
  // on the same unit and downgrade to review instead of a clean exact match.
  beforeEach(() => {
    writeFixtureSnapshot();
  });

  it('includes the Expired lease (Duketa LLC, unit C4) in the loader output', async () => {
    vi.resetModules();
    const { loadUnitLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const leases = loadUnitLeasesFromSnapshot();
    const duketa = leases.find((l) => l.id === '2207-northwood-c4-duketa-llc');
    expect(duketa).toBeDefined();
    expect(duketa?.status).toBe('Expired');
  }); // slow: first dynamic import of this module graph is transform-heavy

  it('carries annualRent and tenantName so resolveByUnit can apply the shared dead-lease predicate and name a candidate', async () => {
    vi.resetModules();
    const { loadUnitLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const gym = loadUnitLeasesFromSnapshot().find((l) => l.id === '2207-northwood-a15-example-gymnastics-and-dance-llc');
    expect(gym).toMatchObject({ unit: 'A15', status: 'Active', annualRent: 0, tenantName: 'Dana  Example' });
  });

  it('end-to-end (Fix A): Example Gymnastics, unit A15, Active but $0 rent -> NOT auto-attributed; falls to review', async () => {
    // Real row: $REDACTED-AMT of AR at 2207 Northwood A15. The only lease on that unit is Active with
    // annualRent 0 -- not a billing tenant. Before Fix A this was a clean 'exact' unit hit and an
    // unattended write.
    vi.resetModules();
    const { loadUnitLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const { resolveByUnit } = await import('../../server/ar/resolve-by-unit');
    const res = resolveByUnit({ unit: 'A15', property: 'prop-a', d30: REDACTED-AMT, d30plus: REDACTED-AMT }, loadUnitLeasesFromSnapshot(), 'prop-a');
    expect(res.leaseId).toBeNull();
    expect(res.confidence).toBe('none');
  });

  it('end-to-end (Fix A): a Vacant record on a unit is not a live candidate either', async () => {
    vi.resetModules();
    const { loadUnitLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const { resolveByUnit } = await import('../../server/ar/resolve-by-unit');
    const res = resolveByUnit({ unit: 'A9', property: 'prop-a', d30: 50, d30plus: 0 }, loadUnitLeasesFromSnapshot(), 'prop-a');
    expect(res.leaseId).toBeNull();
    expect(res.confidence).toBe('none');
  });

  it('regression (Fix A): a live Active, non-zero-rent lease on its own unit still resolves exact', async () => {
    vi.resetModules();
    const { loadUnitLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const { resolveByUnit } = await import('../../server/ar/resolve-by-unit');
    const res = resolveByUnit({ unit: 'A1', property: 'prop-a', d30: 50, d30plus: 0 }, loadUnitLeasesFromSnapshot(), 'prop-a');
    expect(res).toEqual({ leaseId: 'active-lease-1', confidence: 'exact', ambiguous: false });
  });

  it('end-to-end: resolveByUnit still refuses to auto-attribute unit C4 when Expired is the ONLY lease there', async () => {
    vi.resetModules();
    const { loadUnitLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const { resolveByUnit } = await import('../../server/ar/resolve-by-unit');
    const leases = loadUnitLeasesFromSnapshot();
    const res = resolveByUnit({ unit: 'C4', property: 'prop-a', d30: 0.38, d30plus: 0 }, leases, 'prop-a');
    // No LIVE candidate -> 'none' confidence -> falls through to human review, never an auto-write.
    expect(res.leaseId).toBeNull();
    expect(res.confidence).toBe('none');
  });

  it('end-to-end: a re-let unit (Expired + new Active lease sharing unit C4) resolves AMBIGUOUS, not an auto-write to the new tenant', async () => {
    // The exact adjacent hole PR #302's own review caught: sign a new tenant into C4 while the
    // export still carries the vacated tenant's residual delinquency for that unit.
    const { writeFileSync: writeFile } = await import('node:fs');
    writeFile(
      snapshotPath,
      JSON.stringify({
        leases: [
          { id: '2207-northwood-c4-duketa-llc', tenantName: 'Duketa LLC', company: 'Duketa LLC', status: 'Expired', unit: 'C4', propertyId: 'prop-a' },
          { id: 'new-tenant-c4', tenantName: 'New Tenant LLC', company: 'New Tenant LLC', status: 'Active', unit: 'C4', propertyId: 'prop-a' },
        ],
      }),
    );
    vi.resetModules();
    const { loadUnitLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const { resolveByUnit } = await import('../../server/ar/resolve-by-unit');
    const leases = loadUnitLeasesFromSnapshot();
    const res = resolveByUnit({ unit: 'C4', property: 'prop-a', d30: 0.38, d30plus: 0 }, leases, 'prop-a');
    expect(res.leaseId).toBeNull();
    expect(res.ambiguous).toBe(true);
  });
});

afterEachCleanup();

function afterEachCleanup() {
  // Best-effort: the fixture dir is per-file (mkdtempSync at module scope), so a single cleanup at
  // teardown is sufficient -- vitest tears the module down after the file's tests complete.
  process.once('exit', () => {
    try {
      rmSync(snapshotDir, { recursive: true, force: true });
    } catch {
      /* best-effort cleanup */
    }
  });
}
