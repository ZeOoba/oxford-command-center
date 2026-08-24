// tests/unit/parse-snapshot-for-import.test.ts
//
// PR #302 review finding (refute-financial-change, all 5 lenses): scripts/ar-import.ts is a third
// AR entry point that bypassed the 2026-08-24 Expired-lease exclusion applied to
// ar-import-headless.ts's two loaders -- parseSnapshotForImport projected leases with no status
// filter, so an exact tenant-name hit on a dead lease could auto-accept with zero human review
// through this path. This locks the fix in.
import { describe, it, expect } from 'vitest';
import { parseSnapshotForImport } from '../../server/ar/parse-snapshot-for-import';

function envelope(leases: Array<{ id: string; tenantName: string; company: string | null; status?: string | null }>) {
  return { snapshot: { leases, tenantArrears: {} } };
}

describe('parseSnapshotForImport', () => {
  it('excludes Expired leases from `leases` (the fresh-match candidate pool)', () => {
    const result = parseSnapshotForImport(
      envelope([
        { id: 'active-1', tenantName: 'Active Co', company: null, status: 'Active' },
        { id: 'expired-1', tenantName: 'Vacated Tenant', company: null, status: 'Expired' },
      ]),
    );
    expect(result.leases.map((l) => l.id)).toEqual(['active-1']);
  });

  it('keeps ALL lease ids, including Expired, in allLeaseIds (for manual-entry / cache validation)', () => {
    const result = parseSnapshotForImport(
      envelope([
        { id: 'active-1', tenantName: 'Active Co', company: null, status: 'Active' },
        { id: 'expired-1', tenantName: 'Vacated Tenant', company: null, status: 'Expired' },
      ]),
    );
    expect(result.allLeaseIds).toEqual(new Set(['active-1', 'expired-1']));
  });

  it('a missing status defaults to included (not Expired) — matches the headless loaders\' convention', () => {
    const result = parseSnapshotForImport(envelope([{ id: 'l1', tenantName: 'No Status Tenant', company: null }]));
    expect(result.leases.map((l) => l.id)).toEqual(['l1']);
  });

  it('still throws on a missing snapshot envelope (unchanged pre-existing behavior)', () => {
    expect(() => parseSnapshotForImport({})).toThrow(/snapshot/);
  });
});
