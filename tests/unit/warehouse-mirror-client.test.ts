// tests/unit/warehouse-mirror-client.test.ts
//
// The CLIENT half of the Fat Mirror (Phase 1b): the warehouse.json envelope contract
// (schema-version FAIL-CLOSE), the endpoint lookup, the calibration-log client-side filter
// (the mirror bakes the UNFILTERED log), and the honest warehouse freshness badge.
// The fetch-fallback wiring (fetchParsedOrMirror) is covered lower in this file.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  WAREHOUSE_MIRROR_SCHEMA_VERSION,
  parseWarehouseMirror,
  getMirrorEndpoint,
  filterCalibrationLogRows,
} from '../../src/lib/warehouse-mirror';
import { computeWarehouseFreshness } from '../../src/lib/freshness';

const goodEnvelope = {
  schemaVersion: WAREHOUSE_MIRROR_SCHEMA_VERSION,
  bakedAt: '2026-06-15T00:00:00.000Z',
  warehouseSource: 'checkpoint-read',
  endpoints: { '/api/warehouse/analytics/scores': { scores: [] } },
};

describe('warehouse-mirror envelope (fail-closed)', () => {
  it('parses a valid envelope and looks up an endpoint payload', () => {
    const env = parseWarehouseMirror(goodEnvelope);
    expect(env).not.toBeNull();
    expect(getMirrorEndpoint(env!, '/api/warehouse/analytics/scores')).toEqual({ scores: [] });
    expect(getMirrorEndpoint(env!, '/api/warehouse/not-baked')).toBeUndefined();
  });

  it('FAIL-CLOSES (returns null) on a schema-version mismatch — never serve stale data as current', () => {
    expect(parseWarehouseMirror({ ...goodEnvelope, schemaVersion: 'wh-v0' })).toBeNull();
  });

  it('fail-closes on a malformed / missing envelope', () => {
    expect(parseWarehouseMirror({ nope: true })).toBeNull();
    expect(parseWarehouseMirror(null)).toBeNull();
    expect(parseWarehouseMirror('not json')).toBeNull();
  });
});

describe('filterCalibrationLogRows (mirror serves the unfiltered log)', () => {
  const rows = [
    { subjectId: 'a', verdictKind: 'health-band', resolved: false },
    { subjectId: 'a', verdictKind: 'anomaly', resolved: true },
    { subjectId: 'b', verdictKind: 'health-band', resolved: true },
  ];

  it('filters by subject, kind and open/resolved status — matching the server WHERE', () => {
    expect(filterCalibrationLogRows(rows, {}).length).toBe(3);
    expect(filterCalibrationLogRows(rows, { subject: 'a' }).map((r) => r.subjectId)).toEqual(['a', 'a']);
    expect(filterCalibrationLogRows(rows, { kind: 'health-band' }).length).toBe(2);
    expect(filterCalibrationLogRows(rows, { status: 'open' })).toEqual([rows[0]]);
    expect(filterCalibrationLogRows(rows, { status: 'resolved' }).map((r) => r.subjectId)).toEqual(['a', 'b']);
    expect(filterCalibrationLogRows(rows, { subject: 'a', status: 'resolved' })).toEqual([rows[1]]);
  });
});

describe('computeWarehouseFreshness (honest — never "Live")', () => {
  it('labels baked warehouse data "Computed from snapshot baked Nh ago"', () => {
    const now = Date.parse('2026-06-15T06:00:00Z');
    const f = computeWarehouseFreshness(
      { schemaVersion: 'wh-v1', bakedAt: '2026-06-15T00:00:00Z', warehouseSource: 'checkpoint-read' },
      now,
    );
    expect(f.label).toMatch(/Computed from snapshot/i);
    expect(f.detail).toMatch(/baked 6h ago/);
    expect(f.isStale).toBe(false);
    expect(f.kind).not.toBe('live');
  });

  it('marks the bake stale past the staleness threshold', () => {
    const now = Date.parse('2026-06-17T00:00:00Z'); // 48h later
    const f = computeWarehouseFreshness(
      { schemaVersion: 'wh-v1', bakedAt: '2026-06-15T00:00:00Z', warehouseSource: 'checkpoint-read' },
      now,
    );
    expect(f.isStale).toBe(true);
    expect(f.kind).toBe('stale');
  });

  it('fail-closes to offline when there is no mirror meta (schema mismatch upstream → null)', () => {
    const f = computeWarehouseFreshness(null, Date.parse('2026-06-15T06:00:00Z'));
    expect(f.kind).toBe('offline');
    expect(f.isStale).toBe(false);
  });
});

// ── fetchParsedOrMirror: live first, fall back to the baked payload on a 404/non-JSON mirror ──
describe('fetchParsedOrMirror (client 404 fallback)', () => {
  beforeEach(() => {
    vi.resetModules();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the baked payload when the live warehouse route is unavailable', async () => {
    const env = {
      schemaVersion: WAREHOUSE_MIRROR_SCHEMA_VERSION,
      bakedAt: '2026-06-15T00:00:00.000Z',
      warehouseSource: 'checkpoint-read',
      endpoints: { '/api/warehouse/analytics/scores': { scores: [{ propertyId: 'x' }] } },
    };
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/warehouse/')) {
        // The static mirror serves the SPA index.html (non-JSON) for an absent API route.
        return new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (url.includes('/warehouse.json')) {
        return new Response(JSON.stringify(env), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { z } = await import('zod');
    const schema = z.object({ scores: z.array(z.object({ propertyId: z.string() })) });
    const { fetchParsedOrMirror } = await import('../../src/modules/intel/hooks');
    const out = await fetchParsedOrMirror('/api/warehouse/analytics/scores', schema);
    expect(out).toEqual({ scores: [{ propertyId: 'x' }] });
  });

  it('rethrows unavailable when there is no baked mirror (live workstation offline, no warehouse.json)', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/warehouse/')) {
        return new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      return new Response('not found', { status: 404 }); // no warehouse.json
    });
    vi.stubGlobal('fetch', fetchMock);

    const { z } = await import('zod');
    const schema = z.object({ scores: z.array(z.unknown()) });
    const { fetchParsedOrMirror, isWarehouseUnavailable } = await import('../../src/modules/intel/hooks');
    await expect(fetchParsedOrMirror('/api/warehouse/analytics/scores', schema)).rejects.toSatisfy(
      isWarehouseUnavailable,
    );
  });
});

// ── fetchJsonOrMirror: the unschema'd list reads (noi/imports/issues) also fall back, so the PFI
//    module's `unavailable` gate does NOT trip on the mirror (it would, leaving PFI offline). ──
describe('fetchJsonOrMirror (unschema list reads fall back too)', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.restoreAllMocks());

  it('returns the baked matrix when /api/warehouse/noi is unavailable', async () => {
    const env = {
      schemaVersion: WAREHOUSE_MIRROR_SCHEMA_VERSION,
      bakedAt: '2026-06-15T00:00:00.000Z',
      warehouseSource: 'checkpoint-read',
      endpoints: { '/api/warehouse/noi': { matrix: [{ propertyId: 'p', period: '2025', noi: 1 }] } },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/api/warehouse/')) {
        return new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });
      }
      if (url.includes('/warehouse.json')) {
        return new Response(JSON.stringify(env), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('not found', { status: 404 });
    }));
    const { fetchJsonOrMirror } = await import('../../src/modules/intel/hooks');
    const out = await fetchJsonOrMirror<{ matrix: unknown[] }>('/api/warehouse/noi');
    expect(out).toEqual({ matrix: [{ propertyId: 'p', period: '2025', noi: 1 }] });
  });

  it('stays unavailable for an endpoint that was not baked (e.g. import detail)', async () => {
    const env = {
      schemaVersion: WAREHOUSE_MIRROR_SCHEMA_VERSION,
      bakedAt: '2026-06-15T00:00:00.000Z',
      warehouseSource: 'checkpoint-read',
      endpoints: { '/api/warehouse/noi': { matrix: [] } },
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes('/warehouse.json')) {
        return new Response(JSON.stringify(env), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      return new Response('<!doctype html>', { status: 200, headers: { 'content-type': 'text/html' } });
    }));
    const { fetchJsonOrMirror, isWarehouseUnavailable } = await import('../../src/modules/intel/hooks');
    await expect(fetchJsonOrMirror('/api/warehouse/imports/7')).rejects.toSatisfy(isWarehouseUnavailable);
  });
});
