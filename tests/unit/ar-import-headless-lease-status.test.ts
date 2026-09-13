// @vitest-environment node
//
// Regression coverage for the 2026-08-24 integrity-sweep incident: loadLeasesFromSnapshot() fed
// EVERY lease -- including 'Expired' ones -- to the name matcher, so a delinquency export naming a
// vacated tenant auto-attributed to their dead lease at 'exact' confidence with zero human review.
// This silently reversed a ratified SKIP ruling on REDACTED-197 (lease ended
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
        { id: 'active-lease-1', tenantName: 'Active Tenant Co', company: 'Active Tenant Co', status: 'Active', unit: 'A1', propertyId: 'prop-a' },
        { id: 'expiring-soon-lease-1', tenantName: 'Soon Gone LLC', company: 'Soon Gone LLC', status: 'Expiring Soon', unit: 'A2', propertyId: 'prop-a' },
        { id: 'REDACTED-197', tenantName: 'REDACTED-486', company: 'REDACTED-486', status: 'Expired', unit: 'C4', propertyId: 'prop-a' },
        { id: 'unknown-status-lease-1', tenantName: 'Mystery Tenant', company: null, status: 'Unknown', unit: 'A3', propertyId: 'prop-a' },
      ],
    }),
  );
}

describe('loadLeasesFromSnapshot excludes Expired leases from the auto-match candidate pool', () => {
  beforeEach(() => {
    writeFixtureSnapshot();
  });

  it('drops the Expired lease (REDACTED-486) entirely', async () => {
    vi.resetModules();
    const { loadLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const leases = loadLeasesFromSnapshot();
    expect(leases.find((l) => l.id === 'REDACTED-197')).toBeUndefined();
  }); // slow: first dynamic import of this module graph is transform-heavy

  it('keeps Active, Expiring Soon, and Unknown-status leases as match candidates', async () => {
    vi.resetModules();
    const { loadLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const leases = loadLeasesFromSnapshot();
    expect(leases.map((l) => l.id).sort()).toEqual(
      ['active-lease-1', 'expiring-soon-lease-1', 'unknown-status-lease-1'].sort(),
    );
  });

  it('end-to-end: matchTenantToLease can no longer resolve "REDACTED-486" once his lease is Expired', async () => {
    vi.resetModules();
    const { loadLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const { matchTenantToLease } = await import('../../server/ar/match-tenant');
    const leases = loadLeasesFromSnapshot();
    const match = matchTenantToLease('REDACTED-486', leases);
    // No candidate at all -> 'none' confidence -> falls through to human review, never an auto-write.
    expect(match.leaseId).toBeNull();
    expect(match.confidence).toBe('none');
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

  it('includes the Expired lease (REDACTED-486, unit C4) in the loader output', async () => {
    vi.resetModules();
    const { loadUnitLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const leases = loadUnitLeasesFromSnapshot();
    const REDACTED-669 = leases.find((l) => l.id === 'REDACTED-197');
    expect(REDACTED-669).toBeDefined();
    expect(REDACTED-669?.status).toBe('Expired');
  }); // slow: first dynamic import of this module graph is transform-heavy

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
          { id: 'REDACTED-197', tenantName: 'REDACTED-486', company: 'REDACTED-486', status: 'Expired', unit: 'C4', propertyId: 'prop-a' },
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
