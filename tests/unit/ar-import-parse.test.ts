import { describe, it, expect } from 'vitest';
import { parseSnapshotForImport } from '../../server/ar/parse-snapshot-for-import';

// Refute 2026-07-22 round 4 (HIGH): the function under test replaces a version that read leases/
// tenantArrears off the TOP LEVEL of the /api/snapshot response, when the real route (server/index.ts)
// nests everything under `snapshot: {...}`. That mismatch made every guard built on this parse a
// structural no-op against a real server. These tests pin the REAL envelope shape so a future change
// to either side (the route or this parser) breaks the build here, not silently in production.

describe('parseSnapshotForImport — /api/snapshot envelope shape', () => {
  it('reads leases/tenantArrears from the NESTED snapshot envelope (the real response shape)', () => {
    const body = {
      snapshot: {
        leases: [{ id: 'L1', tenantName: 'Acme', company: null }],
        tenantArrears: { L1: { d30: 100, d60: 0, d90: 0, d90plus: 0 } },
      },
      state: { status: 'fresh' },
    };
    const r = parseSnapshotForImport(body);
    expect(r.leases).toEqual([{ id: 'L1', tenantName: 'Acme', company: null }]);
    expect(r.tenantArrears).toEqual({ L1: { d30: 100, d60: 0, d90: 0, d90plus: 0 } });
  });

  it('does NOT read leases/tenantArrears from the top level (the bug this replaces)', () => {
    const body = {
      leases: [{ id: 'TOP-LEVEL-SHOULD-BE-IGNORED', tenantName: 'x', company: null }],
      tenantArrears: { WRONG: { d30: 999, d60: 0, d90: 0, d90plus: 0 } },
      snapshot: { leases: [], tenantArrears: {} },
      state: {},
    };
    const r = parseSnapshotForImport(body);
    expect(r.leases).toEqual([]);
    expect(r.tenantArrears).toEqual({});
  });

  it('defaults to empty leases/tenantArrears when the snapshot envelope omits them', () => {
    const r = parseSnapshotForImport({ snapshot: {}, state: {} });
    expect(r.leases).toEqual([]);
    expect(r.tenantArrears).toEqual({});
  });

  it('throws (never silently defaults) when the snapshot envelope itself is missing', () => {
    expect(() => parseSnapshotForImport({ state: {} })).toThrow(/missing the expected 'snapshot' envelope/);
  });

  it('throws when the body is not an object at all', () => {
    expect(() => parseSnapshotForImport(null)).toThrow();
    expect(() => parseSnapshotForImport('not json')).toThrow();
  });

  it('maps company null-coalescing correctly for a lease with no company', () => {
    const body = { snapshot: { leases: [{ id: 'L1', tenantName: 'Solo Tenant' }], tenantArrears: {} } };
    const r = parseSnapshotForImport(body);
    expect(r.leases[0]).toEqual({ id: 'L1', tenantName: 'Solo Tenant', company: null });
  });
});
