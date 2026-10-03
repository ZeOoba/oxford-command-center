// @vitest-environment node
//
// tests/unit/edge-api.test.ts — in-process Hono (pattern: tests/unit/acq-api.test.ts). Fresh
// openWarehouse() on a tmpdir path, all migrations applied — never touches finance.sqlite.
import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EdgeMarketsResponse, EdgePullItem, EdgePullQueueResponse } from '@contracts/edge';
import { openWarehouse, type WarehouseDb } from '../../server/warehouse/db';
import { edgeApi } from '../../server/edge/edge-api';
import { EDGE_BUY_BOX_FALLBACK } from '../../server/edge/pull-queue';
import { buildMountPrefixMap } from '../../scripts/check-write-schema-drift';
import { warehouseJsonError } from '../../server/warehouse/json-errors';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FIXTURE = join(__dirname, '..', 'fixtures', 'edge', 'markets.slice.json');
const NOW = new Date('2026-10-02T12:00:00');

function freshDb(): WarehouseDb {
  return openWarehouse(join(mkdtempSync(join(tmpdir(), 'edge-api-db-')), 'w.sqlite'));
}
function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'edge-api-data-'));
  copyFileSync(FIXTURE, join(dir, 'markets.json'));
  return dir;
}
function makeApp(getDb: () => WarehouseDb, dir = fixtureDir()) {
  return edgeApi(getDb, { edgeDir: () => dir, now: () => NOW });
}
const noDb = (): WarehouseDb => {
  throw new Error('warehouse unopenable');
};
async function post(app: ReturnType<typeof makeApp>, path: string, body?: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function keysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysDeep(x, out);
    }
  }
  return out;
}

describe('GET /markets', () => {
  it('serves the fixture without the DB (no withDb guard)', async () => {
    const res = await makeApp(noDb).request('/markets');
    expect(res.status).toBe(200);
    const body = EdgeMarketsResponse.parse(await res.json());
    expect(body.availability).toBe('ok');
    expect(body.marketCount).toBe(4);
    expect(body.freshness).toMatchObject({ asOf: '2026-07-14', ageDays: 80, stale: true });
    expect(body.outsidePullScope).toEqual({ truck: [], mfgInvest: [] });
  });

  it('outsidePullScope lists in-dataset states outside the pull scopes (automated truck states excluded)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'edge-api-oos-'));
    const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { markets: Array<Record<string, unknown> & { truck: Array<number | null> }> };
    const clone = (id: string, state: string, truck?: Array<number | null>) => {
      const m = JSON.parse(JSON.stringify(f.markets[0])) as (typeof f.markets)[number];
      m.id = id;
      m.state = state;
      if (truck) m.truck = truck;
      return m;
    };
    // TN / DC: outside both scopes. MI with truck data: automated, so out of the truck list; MI is a mfg-scope state.
    f.markets.push(clone('nashville', 'TN'), clone('washington', 'DC'), clone('detroit', 'MI', [1, 1, 1, 1, 1]));
    writeFileSync(join(dir, 'markets.json'), JSON.stringify(f));
    const body = EdgeMarketsResponse.parse(await (await makeApp(noDb, dir).request('/markets')).json());
    expect(body.outsidePullScope).toEqual({ truck: ['DC', 'TN'], mfgInvest: ['DC', 'TN'] });
  });

  it('missing dir → 200 with availability missing and markets []', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'edge-api-missing-')), 'nope');
    const res = await makeApp(noDb, dir).request('/markets');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ availability: 'missing', markets: [], dir });
  });

  it('F9: the response carries no deal-shaped key', async () => {
    const body = await (await makeApp(noDb).request('/markets')).json();
    expect(keysDeep(body).filter((k) => /^deal/i.test(k))).toEqual([]);
  });
});

describe('GET /pull-queue', () => {
  it('503 through the standard guard when the warehouse is unopenable', async () => {
    const res = await makeApp(noDb).request('/pull-queue');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'warehouse unavailable' });
  });

  it('derives scopes from the fixture; VA is automated, not queued; all open', async () => {
    const db = freshDb();
    const body = EdgePullQueueResponse.parse(await (await makeApp(() => db).request('/pull-queue')).json());
    const byKind = Object.fromEntries(body.items.map((i) => [i.kind, i]));
    expect(byKind.storage!.scopes.map((s) => s.scopeKey)).toEqual(['columbus', 'indianapolis_south', 'richmond']);
    expect(byKind.mfgInvest!.scopes).toHaveLength(15);
    expect(byKind.truck!.scopes).toHaveLength(13);
    expect(body.automatedCoverage.truck).toEqual(['VA']);
    expect(body.items.flatMap((i) => i.scopes).every((s) => s.state === 'open')).toBe(true);
    expect(keysDeep(body).filter((k) => /^deal/i.test(k))).toEqual([]);
  });
});

describe('POST /pull-queue', () => {
  it('records a pull and returns the updated item', async () => {
    const db = freshDb();
    const app = makeApp(() => db);
    const res = await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30', note: 'baseline' });
    expect(res.status).toBe(200);
    const item = EdgePullItem.parse(await res.json());
    expect(item.scopes.find((s) => s.scopeKey === 'columbus')).toMatchObject({
      state: 'current', lastDoneOn: '2026-09-30', lastNote: 'baseline', ageDays: 2,
    });
    const queue = EdgePullQueueResponse.parse(await (await app.request('/pull-queue')).json());
    expect(queue.items[0]!.counts).toEqual({ open: 2, due: 0, current: 1 });
  });

  it.each([
    ['bad kind', { kind: 'rent', scopeKey: 'columbus', doneOn: '2026-09-30' }],
    ['unknown scope (F12)', { kind: 'storage', scopeKey: 'akron', doneOn: '2026-09-30' }],
    ['typo state', { kind: 'truck', scopeKey: 'OHH', doneOn: '2026-09-30' }],
    ['unreal date', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-02-30' }],
    ['future date', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-10-03' }],
    ['oversize note', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30', note: 'x'.repeat(2001) }],
    ['extra key (strict)', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30', dealId: 'd1' }],
  ])('400 on %s', async (_label, body) => {
    const db = freshDb();
    const res = await post(makeApp(() => db), '/pull-queue', body);
    expect(res.status).toBe(400);
    expect((db.prepare('SELECT COUNT(*) AS n FROM edge_pull_log').get() as { n: number }).n).toBe(0);
  });

  it('503 when the warehouse is unopenable', async () => {
    const res = await post(makeApp(noDb), '/pull-queue', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30' });
    expect(res.status).toBe(503);
  });
});

describe('POST /pull-queue/:id/void', () => {
  it('void reverts the scope to the prior row (F12); repeat → 409; unknown → 404; bad id → 400', async () => {
    const db = freshDb();
    const app = makeApp(() => db);
    await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-06-01' });
    const second = EdgePullItem.parse(await (await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-01' })).json());
    const id = second.scopes.find((s) => s.scopeKey === 'columbus')!.lastLogId!;

    const voided = await post(app, `/pull-queue/${id}/void`);
    expect(voided.status).toBe(200);
    expect(EdgePullItem.parse(await voided.json()).scopes.find((s) => s.scopeKey === 'columbus')!.lastDoneOn).toBe('2026-06-01');

    expect((await post(app, `/pull-queue/${id}/void`)).status).toBe(409);
    expect((await post(app, '/pull-queue/9999/void')).status).toBe(404);
    expect((await post(app, '/pull-queue/abc/void')).status).toBe(400);
  });
});

describe('POST /pull-queue/:id/void — injected clock', () => {
  it('voiding the newer row returns state/ageDays computed from the injected today, not a stale constant', async () => {
    const db = freshDb();
    const app = makeApp(() => db);
    await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-06-01' });
    const second = EdgePullItem.parse(await (await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-01' })).json());
    const id = second.scopes.find((s) => s.scopeKey === 'columbus')!.lastLogId!;
    const scope = EdgePullItem.parse(await (await post(app, `/pull-queue/${id}/void`)).json()).scopes.find((s) => s.scopeKey === 'columbus')!;
    expect(scope.lastDoneOn).toBe('2026-06-01');
    expect(scope.ageDays).toBe(123); // 2026-06-01 -> 2026-10-02
    expect(scope.state).toBe('due');
  });
});

describe('scope membership (carry-over 2)', () => {
  it.each([['truck', 'VA'], ['truck', 'MI'], ['mfgInvest', 'TX'], ['storage', 'Columbus']])(
    '400 and no row for (%s, %s)',
    async (kind, scopeKey) => {
      const db = freshDb();
      const res = await post(makeApp(() => db), '/pull-queue', { kind, scopeKey, doneOn: '2026-09-30' });
      expect(res.status).toBe(400);
      expect((db.prepare('SELECT COUNT(*) AS n FROM edge_pull_log').get() as { n: number }).n).toBe(0);
    },
  );

  it('200 for a valid scope (truck OH)', async () => {
    const db = freshDb();
    const res = await post(makeApp(() => db), '/pull-queue', { kind: 'truck', scopeKey: 'OH', doneOn: '2026-09-30' });
    expect(res.status).toBe(200);
  });
});

describe('error mapping (carry-over 1)', () => {
  it('a non-validation DB fault is 500, not 400', async () => {
    const real = freshDb();
    const faulty = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (/INSERT INTO edge_pull_log/.test(sql)) throw new Error('disk I/O error');
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as WarehouseDb;
    const res = await post(makeApp(() => faulty), '/pull-queue', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30' });
    expect(res.status).toBe(500);
  });

  it('through the production JSON error handler, the 500 is JSON (the handler is the shared warehouseJsonError)', async () => {
    const real = freshDb();
    const faulty = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (/INSERT INTO edge_pull_log/.test(sql)) throw new Error('disk I/O error');
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as WarehouseDb;
    const app = makeApp(() => faulty);
    app.onError(warehouseJsonError); // exactly what sub-routers.ts withJsonErrors applies
    const res = await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30' });
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('application/json');
    // NOTE: warehouseJsonError echoes err.message by design (shared warehouse behavior), so the
    // body is asserted to be JSON with an error key; leak-hardening of the shared handler is out of scope.
    expect(await res.json()).toHaveProperty('error');
  });
});

describe('hardening (fix wave)', () => {
  it.each(['0', '-1', '1e3', '0x10', '1.0', ' 1', '99999999999999999999'])('void id %j → 400, no mutation', async (badId) => {
    const db = freshDb();
    const app = makeApp(() => db);
    await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30' });
    const res = await post(app, `/pull-queue/${encodeURIComponent(badId)}/void`);
    expect(res.status).toBe(400);
    expect((db.prepare('SELECT COUNT(*) AS n FROM edge_pull_log WHERE voided_at IS NOT NULL').get() as { n: number }).n).toBe(0);
  });

  it('/pull-queue with a MISSING dataset falls back to the frozen buy-box list and can record', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'edge-api-missing2-')), 'nope');
    const db = freshDb();
    const app = makeApp(() => db, dir);
    const res = await app.request('/pull-queue');
    expect(res.status).toBe(200);
    const q = EdgePullQueueResponse.parse(await res.json());
    expect(q.items.find((i) => i.kind === 'storage')!.scopes).toHaveLength(EDGE_BUY_BOX_FALLBACK.length);
    const rec = await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30' });
    expect(rec.status).toBe(200);
  });

  it('malformed JSON and non-JSON content-type POST → 400, no row', async () => {
    const db = freshDb();
    const app = makeApp(() => db);
    const bad = await app.request('/pull-queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    expect(bad.status).toBe(400);
    const text = await app.request('/pull-queue', {
      method: 'POST', headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30' }),
    });
    expect(text.status).toBe(400);
    expect((db.prepare('SELECT COUNT(*) AS n FROM edge_pull_log').get() as { n: number }).n).toBe(0);
  });
});

describe('append-only (carry-over 3)', () => {
  it('registers no DELETE route', () => {
    const methods = makeApp(noDb).routes.map((r) => r.method.toUpperCase());
    expect(methods.length).toBeGreaterThan(0);
    expect(methods).not.toContain('DELETE');
    expect(methods.filter((m) => m !== 'ALL').sort()).toEqual(['GET', 'GET', 'POST', 'POST']);
  });

  it('void retains the row and sets voided_at', async () => {
    const db = freshDb();
    const app = makeApp(() => db);
    const item = EdgePullItem.parse(await (await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30' })).json());
    const id = item.scopes.find((s) => s.scopeKey === 'columbus')!.lastLogId!;
    expect((await post(app, `/pull-queue/${id}/void`)).status).toBe(200);
    const rows = db.prepare('SELECT id, voided_at FROM edge_pull_log').all() as { id: number; voided_at: string | null }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(id);
    expect(rows[0]!.voided_at).not.toBeNull();
  });
});

describe('mounting and mirror boundaries', () => {
  it('sub-routers.ts mounts edge-api at /api/warehouse/edge (literal-entry shape check:schema-drift reads)', () => {
    expect(buildMountPrefixMap(REPO_ROOT).get('edge-api')).toBe('/api/warehouse/edge');
  });

  it('F9: /edge is never baked into the Cloudflare mirror (FIXED_ROUTES)', () => {
    const src = readFileSync(join(REPO_ROOT, 'scripts', 'bake-warehouse.ts'), 'utf8');
    const start = src.indexOf('const FIXED_ROUTES = [');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('];', start));
    expect(block).not.toContain('/edge');
  });
});

describe('POST /pull-queue content-type (gate-fix P2)', () => {
  it.each([
    ['application/json', 200],
    ['application/json; charset=utf-8', 200],
    ['APPLICATION/JSON', 200],
    ['text/plain; x=application/json', 400],
    ['text/plain', 400],
    [null, 400],
  ])('content-type %s → %i (exact media type)', async (ct, status) => {
    const db = freshDb();
    const headers: Record<string, string> = ct === null ? {} : { 'content-type': ct };
    const res = await makeApp(() => db).request('/pull-queue', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30' }),
    });
    expect(res.status).toBe(status);
  });
});

describe('GET /markets — non-finite numbers (gate-fix F1)', () => {
  it.each([
    ['lat', (t: string) => t.replace(/"lat":\s*-?[\d.]+/, '"lat":1e999')],
    ['series value', (t: string) => t.replace(/("vac":\s*\[[^\]]*?),\s*[\d.]+\s*\]/, '$1,1e999]')],
  ])('%s of 1e999 is quarantined and the response parses with the client contract', async (_l, mutate) => {
    const dir = mkdtempSync(join(tmpdir(), 'edge-api-inf-'));
    const text = mutate(readFileSync(FIXTURE, 'utf8'));
    expect(text).toContain('1e999');
    writeFileSync(join(dir, 'markets.json'), text);
    const res = await makeApp(noDb, dir).request('/markets');
    expect(res.status).toBe(200);
    const body = EdgeMarketsResponse.parse(await res.json());
    expect(body.rejectedMarkets).toHaveLength(1);
    expect(body.marketCount).toBe(3);
  });
});
