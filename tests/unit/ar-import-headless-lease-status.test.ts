// @vitest-environment node
//
// Regression coverage for the 2026-08-24 integrity-sweep incident: loadLeasesFromSnapshot() fed
// EVERY lease -- including 'Expired' ones -- to the name matcher, so a delinquency export naming a
// vacated tenant auto-attributed to their dead lease at 'exact' confidence with zero human review.
// This silently reversed a ratified SKIP ruling on 2207-northwood-c4-anibal-morales (lease ended
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
        { id: '2207-northwood-c4-anibal-morales', tenantName: 'Anibal Morales', company: 'Anibal Morales', status: 'Expired', unit: 'C4', propertyId: 'prop-a' },
        { id: 'unknown-status-lease-1', tenantName: 'Mystery Tenant', company: null, status: 'Unknown', unit: 'A3', propertyId: 'prop-a' },
      ],
    }),
  );
}

describe('loadLeasesFromSnapshot excludes Expired leases from the auto-match candidate pool', () => {
  beforeEach(() => {
    writeFixtureSnapshot();
  });

  it('drops the Expired lease (Anibal Morales) entirely', async () => {
    vi.resetModules();
    const { loadLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const leases = loadLeasesFromSnapshot();
    expect(leases.find((l) => l.id === '2207-northwood-c4-anibal-morales')).toBeUndefined();
  }, 45000); // first dynamic import of this module graph is transform-heavy

  it('keeps Active, Expiring Soon, and Unknown-status leases as match candidates', async () => {
    vi.resetModules();
    const { loadLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const leases = loadLeasesFromSnapshot();
    expect(leases.map((l) => l.id).sort()).toEqual(
      ['active-lease-1', 'expiring-soon-lease-1', 'unknown-status-lease-1'].sort(),
    );
  });

  it('end-to-end: matchTenantToLease can no longer resolve "Anibal Morales" once his lease is Expired', async () => {
    vi.resetModules();
    const { loadLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const { matchTenantToLease } = await import('../../server/ar/match-tenant');
    const leases = loadLeasesFromSnapshot();
    const match = matchTenantToLease('Anibal Morales', leases);
    // No candidate at all -> 'none' confidence -> falls through to human review, never an auto-write.
    expect(match.leaseId).toBeNull();
    expect(match.confidence).toBe('none');
  });
});

describe('loadUnitLeasesFromSnapshot excludes Expired leases from the Format B auto-match candidate pool', () => {
  // PR #302 review finding (Qodo): the name-based fix above left the UNIT-based Format B path
  // (loadUnitLeasesFromSnapshot -> resolveByUnit) with the identical exposure -- resolveByUnit's
  // exact-match branch auto-writes with no human review, so an Expired lease could still be
  // silently re-attributed through a unit-only export even after the name-based path was closed.
  beforeEach(() => {
    writeFixtureSnapshot();
  });

  it('drops the Expired lease (Anibal Morales, unit C4) entirely', async () => {
    vi.resetModules();
    const { loadUnitLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const leases = loadUnitLeasesFromSnapshot();
    expect(leases.find((l) => l.id === '2207-northwood-c4-anibal-morales')).toBeUndefined();
  }, 20000); // first dynamic import of this module graph is transform-heavy

  it('keeps Active, Expiring Soon, and Unknown-status leases as unit-match candidates', async () => {
    vi.resetModules();
    const { loadUnitLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const leases = loadUnitLeasesFromSnapshot();
    expect(leases.map((l) => l.id).sort()).toEqual(
      ['active-lease-1', 'expiring-soon-lease-1', 'unknown-status-lease-1'].sort(),
    );
  });

  it('end-to-end: resolveByUnit can no longer auto-attribute unit C4 once its lease is Expired', async () => {
    vi.resetModules();
    const { loadUnitLeasesFromSnapshot } = await import('../../scripts/ar-import-headless');
    const { resolveByUnit } = await import('../../server/ar/resolve-by-unit');
    const leases = loadUnitLeasesFromSnapshot();
    const res = resolveByUnit({ unit: 'C4', property: 'prop-a', d30: 0.38, d30plus: 0 }, leases, 'prop-a');
    // No candidate at all -> 'none' confidence -> falls through to human review, never an auto-write.
    expect(res.leaseId).toBeNull();
    expect(res.confidence).toBe('none');
    expect(res.ambiguous).toBe(false);
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
