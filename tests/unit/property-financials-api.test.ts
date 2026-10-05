// @vitest-environment node
//
// tests/unit/property-financials-api.test.ts — in-process Hono (pattern: tests/unit/edge-api.test.ts).
// Each test gets a tmpdir copy of the committed dataset and a tmpdir status store; the repo's
// data/ files are never written.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { warehouseEndpointPlan } from '../../scripts/bake-warehouse';
import { buildMountPrefixMap } from '../../scripts/check-write-schema-drift';
import { allowedHosts, requestBoundary } from '../../server/host-guard';
import { propertyFinancialsApi } from '../../server/property-financials/property-financials-api';
import type { LiveSfSnapshot } from '../../server/property-financials/live-sf';
import { ENTITY_TO_CANONICAL } from '../../server/property-financials/mapping';
import type { WarehouseDb } from '../../server/warehouse/db';
import { warehouseJsonError } from '../../server/warehouse/json-errors';
import { WAREHOUSE_SUB_ROUTERS } from '../../server/warehouse/sub-routers';
import { ORA_CLIENT_HEADER, ORA_CLIENT_HEADER_VALUE } from '../../src/contracts/client-header';

const REPO_ROOT = resolve(__dirname, '..', '..');
const DATA_DIR = join(REPO_ROOT, 'data', 'property-financials');
const NOW = new Date(2026, 9, 5, 12, 0, 0);

const noDb = (): WarehouseDb => {
  throw new Error('warehouse unopenable');
};

function setup(opts: { dataset?: boolean; snapshot?: () => Promise<LiveSfSnapshot | null> } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'pf-api-'));
  const dir = join(root, 'pf');
  if (opts.dataset !== false) {
    mkdirSync(dir);
    for (const f of ['dataset.json', 'monthly-long.csv']) copyFileSync(join(DATA_DIR, f), join(dir, f));
  }
  const statusPath = join(root, 'status.json');
  // Default: no Spine A snapshot in this process (the real default dynamically imports server/brain).
  const app = propertyFinancialsApi(noDb, { dir: () => dir, statusPath: () => statusPath, now: () => NOW, snapshot: opts.snapshot ?? (async () => null) });
  app.onError(warehouseJsonError);
  return { app, root, dir, statusPath };
}

const put = (app: Hono, id: string, body: unknown, contentType = 'application/json') =>
  app.request(`/insight-status/${id}`, {
    method: 'PUT',
    headers: { 'content-type': contentType },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

describe('GET /dataset liveSf (T9b part 2 — additive, dataset shape unchanged)', () => {
  const rarig = ENTITY_TO_CANONICAL['1100 Rarig']!.id;
  const snap = (asOf: string): LiveSfSnapshot =>
    ({
      meta: { schemaVersion: 1, asOf, generatedAt: `${asOf}T08:00:00.000Z`, source: 'wb', scenario: 'base' },
      properties: [{ id: rarig, sf: 21000, occPct: 0.9, tenantCount: 9 }],
      leases: [
        { id: 'a', propertyId: rarig, propertyKey: '1100 Rarig', tenantName: 't', unit: null, company: null, sf: 18900, monthlyRent: 1, rentPerSf: null, leaseStart: null, leaseEnd: null, escalationDate: null, escalationPct: null, status: 'Active', annualRent: 12, monthsToExpiry: null, flags: [] },
      ],
    }) as unknown as LiveSfSnapshot;

  it('with a fresh Spine A snapshot: liveSf is spine-a, fresh, carries live SF per entity; the dataset itself is byte-identical to the committed file', async () => {
    const { app } = setup({ snapshot: async () => snap('2026-10-04') });
    const body = (await (await app.request('/dataset')).json()) as { dataset: unknown; liveSf: { source: string; stale: boolean; asOf: string; ageDays: number; entries: Record<string, { sf: number | null; leasedSf: number | null; fields: { sf: string } }> } };
    expect(body.liveSf).toMatchObject({ source: 'spine-a', stale: false, asOf: '2026-10-04', ageDays: 1, staleDays: 7 });
    expect(body.liveSf.entries['1100 Rarig']).toMatchObject({ sf: 21000, leasedSf: 18900, fields: { sf: 'live', leasedSf: 'live', occupancy: 'live' } });
    expect(body.liveSf.entries['3540 E 5th']!.fields.sf).toBe('static');
    // Structural compare after a JSON round-trip: the committed file holds three Python `-0.0` literals that
    // JSON.stringify writes as 0 (README), and Zod re-emits keys in schema order.
    const norm = (x: unknown) => JSON.parse(JSON.stringify(x)) as unknown;
    expect(norm(body.dataset)).toEqual(norm(JSON.parse(readFileSync(join(DATA_DIR, 'dataset.json'), 'utf8'))));
  });

  it('with a stale snapshot (> 7 days) the block says STALE and why', async () => {
    const { app } = setup({ snapshot: async () => snap('2026-09-20') });
    const body = (await (await app.request('/dataset')).json()) as { liveSf: { stale: boolean; staleReason: string; ageDays: number } };
    expect(body.liveSf).toMatchObject({ stale: true, ageDays: 15 });
    expect(body.liveSf.staleReason).toMatch(/2026-09-20 is 15 day\(s\) old/);
  });

  it('with no snapshot it falls back to the dataset and labels it "static dataset (2026-10-02)"; the route never fails on a snapshot error', async () => {
    const { app } = setup();
    const body = (await (await app.request('/dataset')).json()) as { liveSf: { source: string; label: string; staleReason: string } };
    expect(body.liveSf).toMatchObject({ source: 'static-dataset', label: 'static dataset (2026-10-02)' });
    expect(body.liveSf.staleReason).toMatch(/no snapshot/);
    const { app: missing } = setup({ dataset: false, snapshot: async () => snap('2026-10-05') });
    const res = await missing.request('/dataset');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { liveSf: { source: string } }).liveSf.source).toBe('spine-a');
  });
});

describe('GET /dataset', () => {
  it('serves the validated dataset + data-health meta, without the warehouse DB', async () => {
    const { app } = setup();
    const res = await app.request('/dataset');
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & { dataset: { insights: unknown[] }; meta: Record<string, unknown> };
    expect(body.availability).toBe('ok');
    expect(body.dataset.insights).toHaveLength(21);
    expect(body.meta).toMatchObject({ version: 'v03', as_of: '2026-09-30', basis: 'cash', ageDays: 5, staleness: 'fresh' });
    expect(body.meta.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(body.meta.csvSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('missing dataset dir → 200 availability missing, dataset null', async () => {
    const { app } = setup({ dataset: false });
    const res = await app.request('/dataset');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ availability: 'missing', dataset: null, meta: null });
  });

  it('never echoes the filesystem path', async () => {
    const { app, root } = setup({ dataset: false });
    const text = await (await app.request('/dataset')).text();
    expect(text).not.toContain(root.replace(/\\/g, '\\\\'));
    expect(text).not.toContain('pf-api-');
  });
});

describe('GET /mapping', () => {
  it('returns the 11-row entity → canonical id table with computed flags', async () => {
    const { app } = setup();
    const body = (await (await app.request('/mapping')).json()) as { rows: Array<{ entity: string; canonicalId: string | null; flags: Array<{ code: string }> }> };
    expect(body.rows).toHaveLength(11);
    expect(body.rows.find((r) => r.entity === 'FVC')!.flags.map((f) => f.code)).toEqual(['FVC_SEPICH_MAPPING_INFERRED', 'SF_MISMATCH']);
    expect(JSON.stringify(body)).not.toMatch(/northwood/i);
  });
});

describe('insight status', () => {
  it('GET on an empty store → no records', async () => {
    const { app } = setup();
    expect(await (await app.request('/insight-status')).json()).toEqual({ records: [], orphanedIds: [] });
  });

  it('PUT then GET round-trips, written only to the status store', async () => {
    const { app, statusPath, dir } = setup();
    const datasetBefore = readFileSync(join(dir, 'dataset.json'));
    const res = await put(app, 'REV-01', { owner: 'Gabriel', dueDate: '2026-10-31', status: 'in_progress' });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      insightId: 'REV-01', owner: 'Gabriel', dueDate: '2026-10-31', status: 'in_progress', dismissReason: null, updatedAt: NOW.toISOString(),
    });
    const all = (await (await app.request('/insight-status')).json()) as { records: Array<{ insightId: string }> };
    expect(all.records.map((r) => r.insightId)).toEqual(['REV-01']);
    expect(existsSync(statusPath)).toBe(true);
    expect(readFileSync(join(dir, 'dataset.json')).equals(datasetBefore)).toBe(true);
  });

  it('unknown or malformed insight id → 404, nothing written', async () => {
    const { app, statusPath } = setup();
    expect((await put(app, 'ZZZ-99', { owner: null, dueDate: null, status: 'open' })).status).toBe(404);
    expect((await put(app, '..%2Fetc', { owner: null, dueDate: null, status: 'open' })).status).toBe(404);
    expect(existsSync(statusPath)).toBe(false);
  });

  it('dismissed without a reason → 400 with path+code issues only', async () => {
    const { app, statusPath } = setup();
    const res = await put(app, 'REV-01', { owner: 'G', dueDate: null, status: 'dismissed' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; issues: string[] };
    expect(body.error).toBe('invalid insight status');
    expect(body.issues.join(' ')).toContain('dismissReason');
    expect(existsSync(statusPath)).toBe(false);
  });

  it('strict body: an unknown key → 400 and the value is never echoed', async () => {
    const { app } = setup();
    const res = await put(app, 'REV-01', { owner: 'G', dueDate: null, status: 'open', secretField: 'SECRET-123' });
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain('SECRET-123');
  });

  it('non-JSON content-type or body → 400', async () => {
    const { app } = setup();
    expect((await put(app, 'REV-01', 'owner=G', 'text/plain')).status).toBe(400);
    expect((await put(app, 'REV-01', '{ nope')).status).toBe(400);
  });

  it('PUT with no loadable dataset → 503 (cannot verify the insight id)', async () => {
    const { app } = setup({ dataset: false });
    const res = await put(app, 'REV-01', { owner: null, dueDate: null, status: 'open' });
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'property financials dataset unavailable' });
  });

  it('a corrupt store → fixed-text 500 on read and write; the file is not overwritten', async () => {
    const { app, statusPath } = setup();
    writeFileSync(statusPath, '{ broken');
    const g = await app.request('/insight-status');
    expect(g.status).toBe(500);
    expect(await g.json()).toEqual({ error: 'insight status store is unreadable or invalid' });
    expect((await put(app, 'REV-01', { owner: null, dueDate: null, status: 'open' })).status).toBe(500);
    expect(readFileSync(statusPath, 'utf8')).toBe('{ broken');
  });

  it('an unexpected fs fault → generic 500 with no path or errno text', async () => {
    const { app, statusPath } = setup();
    mkdirSync(statusPath); // the store path is a directory: readFileSync throws EISDIR
    const res = await put(app, 'REV-01', { owner: null, dueDate: null, status: 'open' });
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: 'internal error' });
    expect(text).not.toMatch(/EISDIR|pf-api-/);
  });

  it('records for insights no longer in the dataset are reported as orphaned, not served', async () => {
    const { app, statusPath } = setup();
    await put(app, 'REV-01', { owner: 'G', dueDate: null, status: 'open' });
    const raw = JSON.parse(readFileSync(statusPath, 'utf8')) as { records: Record<string, Record<string, unknown>> };
    raw.records['OLD-01'] = { ...raw.records['REV-01'], insightId: 'OLD-01' };
    writeFileSync(statusPath, JSON.stringify(raw));
    expect(await (await app.request('/insight-status')).json()).toMatchObject({ records: [{ insightId: 'REV-01' }], orphanedIds: ['OLD-01'] });
  });

  it('concurrent PUTs through the router leave a valid store with every record', async () => {
    const { app, statusPath } = setup();
    const ids = ['REV-01', 'REV-02', 'EXP-01', 'EXP-02', 'REC-01', 'REC-02'];
    const results = await Promise.all(
      Array.from({ length: 36 }, (_, i) => put(app, ids[i % ids.length]!, { owner: `o${i}`, dueDate: null, status: 'open' })),
    );
    expect(results.every((r) => r.status === 200)).toBe(true);
    const stored = JSON.parse(readFileSync(statusPath, 'utf8')) as { records: Record<string, unknown> };
    expect(Object.keys(stored.records).sort()).toEqual([...ids].sort());
  });
});

describe('host-guard (X-ORA-Client) — mounted the way server/index.ts mounts it', () => {
  function guarded() {
    const s = setup();
    const outer = new Hono();
    outer.use('/api/*', requestBoundary({ allowedHosts: allowedHosts(8911) }));
    outer.route('/api/warehouse/property-financials', s.app);
    return { ...s, outer };
  }
  const req = (outer: Hono, headers: Record<string, string>) =>
    outer.request('/api/warehouse/property-financials/insight-status/REV-01', {
      method: 'PUT',
      headers: { host: 'localhost:8911', 'content-type': 'application/json', ...headers },
      body: JSON.stringify({ owner: 'G', dueDate: null, status: 'open' }),
    });

  it('a PUT without X-ORA-Client is rejected 403 and nothing is written', async () => {
    const { outer, statusPath } = guarded();
    const res = await req(outer, {});
    expect(res.status).toBe(403);
    expect(existsSync(statusPath)).toBe(false);
  });

  it('the same PUT with X-ORA-Client reaches the handler', async () => {
    const { outer, statusPath } = guarded();
    const res = await req(outer, { [ORA_CLIENT_HEADER]: ORA_CLIENT_HEADER_VALUE });
    expect(res.status).toBe(200);
    expect(existsSync(statusPath)).toBe(true);
  });

  it('server/index.ts mounts the boundary on /api/* ahead of the sub-routers', () => {
    const src = readFileSync(join(REPO_ROOT, 'server', 'index.ts'), 'utf8');
    const guard = src.indexOf("app.use('/api/*', boundary)");
    const mount = src.indexOf('for (const { prefix, factory } of WAREHOUSE_SUB_ROUTERS)');
    expect(guard).toBeGreaterThan(-1);
    expect(mount).toBeGreaterThan(guard);
  });
});

describe('mounting and mirror boundaries', () => {
  it('sub-routers.ts mounts the router at /api/warehouse/property-financials (literal-entry shape)', () => {
    expect(buildMountPrefixMap(REPO_ROOT).get('property-financials-api')).toBe('/api/warehouse/property-financials');
    expect(WAREHOUSE_SUB_ROUTERS.filter((r) => r.prefix === '/property-financials')).toHaveLength(1);
  });

  it('the base warehouse router keeps its own mount (no basename collision in the drift map)', () => {
    expect(buildMountPrefixMap(REPO_ROOT).get('api')).toBe('/api/warehouse');
  });

  it('/property-financials is never baked into the Cloudflare mirror (FIXED_ROUTES)', () => {
    const src = readFileSync(join(REPO_ROOT, 'scripts', 'bake-warehouse.ts'), 'utf8');
    const start = src.indexOf('const FIXED_ROUTES = [');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('];', start));
    expect(block).not.toContain('/property-financials');
  });

  it('the bake endpoint plan never includes a /property-financials path', () => {
    const plan = warehouseEndpointPlan([{ propertyId: '1100-rarig-ave-columbus-oh', period: '2025' }], ['1100-rarig-ave-columbus-oh']);
    expect(plan.length).toBeGreaterThan(0);
    expect(plan.some((p) => p.includes('property-financials'))).toBe(false);
  });
});
