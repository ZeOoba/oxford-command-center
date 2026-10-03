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
    const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { markets: Array<Record<string, unknown> & { truck: Array<number | null>; status: Record<string, string[]> }> };
    const clone = (id: string, state: string, truck?: Array<number | null>) => {
      const m = JSON.parse(JSON.stringify(f.markets[0])) as (typeof f.markets)[number];
      m.id = id;
      m.state = state;
      if (truck) {
        m.truck = truck;
        m.status.truck = truck.map(() => 'actual'); // automated = observed STATUS, not just a value
      }
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
    expect(byKind.storage!.scopes.map((s) => s.scopeKey)).toEqual(EDGE_BUY_BOX_FALLBACK.map((s) => s.id)); // R2: union with the frozen list
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
    expect(queue.items[0]!.counts).toEqual({ open: 20, due: 0, current: 1 }); // 21 scopes (frozen union), 1 recorded
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

describe('POST /pull-queue/:id/void — stale tab (F1)', () => {
  it('voiding a superseded row → 409 with a refresh message, row untouched; the latest row still voids → 200', async () => {
    const db = freshDb();
    const app = makeApp(() => db);
    const first = EdgePullItem.parse(await (await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-06-01' })).json());
    const id1 = first.scopes.find((s) => s.scopeKey === 'columbus')!.lastLogId!;
    const second = EdgePullItem.parse(await (await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-01' })).json());
    const id2 = second.scopes.find((s) => s.scopeKey === 'columbus')!.lastLogId!;

    const stale = await post(app, `/pull-queue/${id1}/void`);
    expect(stale.status).toBe(409);
    expect(((await stale.json()) as { error: string }).error).toMatch(/superseded by a newer record.*refresh and retry/);
    expect((db.prepare('SELECT voided_at FROM edge_pull_log WHERE id = ?').get(id1) as { voided_at: string | null }).voided_at).toBeNull();

    const ok = await post(app, `/pull-queue/${id2}/void`);
    expect(ok.status).toBe(200);
    expect(EdgePullItem.parse(await ok.json()).scopes.find((s) => s.scopeKey === 'columbus')!.lastDoneOn).toBe('2026-06-01');
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

  it('a genuine SQLite CHECK violation (SQLITE_CONSTRAINT_CHECK) is 400, not 500; no row recorded', async () => {
    const real = freshDb();
    const violating = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === 'prepare') {
          return (sql: string) => {
            // Rewrite the bound scope to a 1-char key so the real pull-log CHECK (length 2..64) fires.
            if (/INSERT INTO edge_pull_log/.test(sql)) {
              const stmt = target.prepare(sql);
              return { run: (kind: string, _scope: string, doneOn: string, note: string | null) => stmt.run(kind, 'x', doneOn, note) };
            }
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as WarehouseDb;
    const res = await post(makeApp(() => violating), '/pull-queue', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30' });
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty('error');
    expect((real.prepare('SELECT COUNT(*) AS n FROM edge_pull_log').get() as { n: number }).n).toBe(0);
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

describe('R2 — a quarantined buy-box market stays in the storage/IOS queues', () => {
  function quarantinedColumbusDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'edge-api-quar-'));
    const text = readFileSync(FIXTURE, 'utf8').replace(/"lat":\s*-?[\d.]+/, '"lat":1e999'); // first market = columbus
    writeFileSync(join(dir, 'markets.json'), text);
    return dir;
  }

  it('keeps recorded state visible, counts it, and still accepts POST for it', async () => {
    const db = freshDb();
    db.prepare("INSERT INTO edge_pull_log (pull_kind, scope_key, done_on) VALUES ('storage', 'columbus', '2026-09-30')").run();
    const app = makeApp(() => db, quarantinedColumbusDir());
    const markets = EdgeMarketsResponse.parse(await (await app.request('/markets')).json());
    expect(markets.rejectedMarkets.map((r) => JSON.stringify(r))).toEqual([expect.stringContaining('columbus')]);
    expect(markets.markets.map((m) => m.id)).not.toContain('columbus');

    const queue = EdgePullQueueResponse.parse(await (await app.request('/pull-queue')).json());
    const storage = queue.items.find((i) => i.kind === 'storage')!;
    expect(storage.scopes).toHaveLength(21);
    expect(storage.scopes.find((s) => s.scopeKey === 'columbus')).toMatchObject({ state: 'current', lastDoneOn: '2026-09-30' });
    expect(storage.counts).toEqual({ open: 20, due: 0, current: 1 });
    expect(queue.items.find((i) => i.kind === 'ios')!.scopes.map((s) => s.scopeKey)).toContain('columbus');

    for (const kind of ['storage', 'ios']) {
      const res = await post(app, '/pull-queue', { kind, scopeKey: 'columbus', doneOn: '2026-10-01' });
      expect(res.status).toBe(200);
    }
    // a non-buy-box id is still unknown
    expect((await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'cedar_rapids', doneOn: '2026-10-01' })).status).toBe(400);
  });

  it('an unavailable dataset still serves the full frozen set', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'edge-api-empty-'));
    const app = makeApp(() => freshDb(), dir);
    const queue = EdgePullQueueResponse.parse(await (await app.request('/pull-queue')).json());
    expect(queue.items.find((i) => i.kind === 'storage')!.scopes.map((s) => s.scopeKey)).toEqual(EDGE_BUY_BOX_FALLBACK.map((s) => s.id));
  });
});

describe('I1 — an automated truck state is not queued and not recordable', () => {
  function automatedOhioDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'edge-api-truck-'));
    const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { markets: Array<{ id: string; truck: Array<number | null>; status: Record<string, string[]> }> };
    const columbus = f.markets.find((m) => m.id === 'columbus')!;
    columbus.truck = [1, 2, 3, 4, 5];
    columbus.status.truck = ['actual', 'actual', 'actual', 'actual', 'actual'];
    writeFileSync(join(dir, 'markets.json'), JSON.stringify(f));
    return dir;
  }

  it('automated OH is listed in automatedCoverage, absent from the truck scopes and counts; POST for it → 400', async () => {
    const db = freshDb();
    const app = makeApp(() => db, automatedOhioDir());
    const queue = EdgePullQueueResponse.parse(await (await app.request('/pull-queue')).json());
    expect(queue.automatedCoverage.truck).toEqual(['OH', 'VA']);
    const truck = queue.items.find((i) => i.kind === 'truck')!;
    expect(truck.scopes.map((s) => s.scopeKey)).not.toContain('OH');
    expect(truck.scopes).toHaveLength(12);
    expect(truck.counts).toEqual({ open: 12, due: 0, current: 0 });

    const res = await post(app, '/pull-queue', { kind: 'truck', scopeKey: 'OH', doneOn: '2026-09-30' });
    expect(res.status).toBe(400);
    expect((db.prepare('SELECT COUNT(*) AS n FROM edge_pull_log').get() as { n: number }).n).toBe(0);
    // a non-automated state is unchanged
    expect((await post(app, '/pull-queue', { kind: 'truck', scopeKey: 'IN', doneOn: '2026-09-30' })).status).toBe(200);
  });

  it('an unavailable dataset keeps the full fixed truck list', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'edge-api-truck-missing-')), 'nope');
    const db = freshDb();
    const app = makeApp(() => db, dir);
    const queue = EdgePullQueueResponse.parse(await (await app.request('/pull-queue')).json());
    expect(queue.items.find((i) => i.kind === 'truck')!.scopes).toHaveLength(13);
    expect((await post(app, '/pull-queue', { kind: 'truck', scopeKey: 'OH', doneOn: '2026-09-30' })).status).toBe(200);
  });
});

describe('I2/I3 — storage/IOS scope = loaded buy-box ∪ frozen-unless-explicitly-non-buy-box ∪ logged', () => {
  type RawM = Record<string, unknown> & { id: string; type: string; lat: unknown };
  function writeDataset(dir: string, edit: (markets: RawM[]) => void): void {
    const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { markets: RawM[] };
    edit(f.markets);
    writeFileSync(join(dir, 'markets.json'), JSON.stringify(f));
  }
  const cloneAs = (markets: RawM[], id: string, type: string): RawM => {
    const m = JSON.parse(JSON.stringify(markets[0])) as RawM;
    m.id = id;
    m.type = type;
    return m;
  };
  const scopeKeys = async (app: ReturnType<typeof makeApp>, kind: string) =>
    EdgePullQueueResponse.parse(await (await app.request('/pull-queue')).json()).items.find((i) => i.kind === kind)!;

  it('I2: a recorded 22nd buy-box market stays visible and recordable after it is quarantined or retyped', async () => {
    const db = freshDb();
    const dir = mkdtempSync(join(tmpdir(), 'edge-api-22nd-'));
    writeDataset(dir, (ms) => ms.push(cloneAs(ms, 'newtown', 'named')));
    const app = makeApp(() => db, dir);
    expect((await scopeKeys(app, 'storage')).scopes.map((s) => s.scopeKey)).toContain('newtown');
    expect((await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'newtown', doneOn: '2026-09-30' })).status).toBe(200);

    // quarantined (bad lat) → still listed with its recorded state, still recordable
    writeDataset(dir, (ms) => {
      const n = cloneAs(ms, 'newtown', 'named');
      n.lat = 'not-a-number'; // fails the raw schema → quarantined
      ms.push(n);
    });
    const loaded = EdgeMarketsResponse.parse(await (await app.request('/markets')).json());
    expect(loaded.rejectedMarkets.map((r) => r.id)).toEqual(['newtown']);
    let storage = await scopeKeys(app, 'storage');
    expect(storage.scopes.find((s) => s.scopeKey === 'newtown')).toMatchObject({ state: 'current', lastDoneOn: '2026-09-30' });
    expect(storage.counts).toEqual({ open: 21, due: 0, current: 1 });
    expect((await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'newtown', doneOn: '2026-10-01' })).status).toBe(200);
    // the IOS queue has no history for it → not in IOS scope while quarantined
    expect((await scopeKeys(app, 'ios')).scopes.map((s) => s.scopeKey)).not.toContain('newtown');
    expect((await post(app, '/pull-queue', { kind: 'ios', scopeKey: 'newtown', doneOn: '2026-10-01' })).status).toBe(400);

    // retyped non-buy-box → still listed and recordable
    writeDataset(dir, (ms) => ms.push(cloneAs(ms, 'newtown', 'auto')));
    storage = await scopeKeys(app, 'storage');
    expect(storage.scopes.find((s) => s.scopeKey === 'newtown')).toMatchObject({ state: 'current', lastDoneOn: '2026-10-01' });
    expect((await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'newtown', doneOn: '2026-10-02' })).status).toBe(200);
  });

  it('I3: a frozen id loaded OK and typed non-buy-box (harrisburg auto) leaves storage/IOS and is not recordable', async () => {
    const db = freshDb();
    const dir = mkdtempSync(join(tmpdir(), 'edge-api-retype-'));
    writeDataset(dir, (ms) => ms.push(cloneAs(ms, 'harrisburg', 'auto')));
    const app = makeApp(() => db, dir);
    for (const kind of ['storage', 'ios']) {
      const item = await scopeKeys(app, kind);
      expect(item.scopes.map((s) => s.scopeKey)).not.toContain('harrisburg');
      expect(item.scopes).toHaveLength(20);
      expect(item.counts).toEqual({ open: 20, due: 0, current: 0 });
      expect((await post(app, '/pull-queue', { kind, scopeKey: 'harrisburg', doneOn: '2026-09-30' })).status).toBe(400);
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM edge_pull_log').get() as { n: number }).n).toBe(0);
  });

  it('I3 + I2: a retyped frozen id WITH log history stays visible and recordable', async () => {
    const db = freshDb();
    db.prepare("INSERT INTO edge_pull_log (pull_kind, scope_key, done_on) VALUES ('storage', 'harrisburg', '2026-09-30')").run();
    const dir = mkdtempSync(join(tmpdir(), 'edge-api-retype-log-'));
    writeDataset(dir, (ms) => ms.push(cloneAs(ms, 'harrisburg', 'auto')));
    const app = makeApp(() => db, dir);
    const storage = await scopeKeys(app, 'storage');
    expect(storage.scopes.find((s) => s.scopeKey === 'harrisburg')).toMatchObject({ state: 'current', scopeLabel: 'Harrisburg, PA' });
    expect(storage.scopes).toHaveLength(21);
    expect((await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'harrisburg', doneOn: '2026-10-01' })).status).toBe(200);
    // IOS has no history for it → excluded there
    expect((await scopeKeys(app, 'ios')).scopes.map((s) => s.scopeKey)).not.toContain('harrisburg');
  });
});

describe('I4 — void under write contention', () => {
  it('missing → 404 and already-voided → 409 immediately; a live void → 503 with a fixed message', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'edge-api-busy-')), 'w.sqlite');
    const a = openWarehouse(path);
    const b = openWarehouse(path);
    a.pragma('busy_timeout = 0');
    const app = makeApp(() => a);
    const live = EdgePullItem.parse(await (await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-01' })).json())
      .scopes.find((s) => s.scopeKey === 'columbus')!.lastLogId!;
    const dead = EdgePullItem.parse(await (await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'richmond', doneOn: '2026-09-01' })).json())
      .scopes.find((s) => s.scopeKey === 'richmond')!.lastLogId!;
    expect((await post(app, `/pull-queue/${dead}/void`)).status).toBe(200);

    b.exec('BEGIN IMMEDIATE');
    try {
      expect((await post(app, '/pull-queue/9999/void')).status).toBe(404);
      expect((await post(app, `/pull-queue/${dead}/void`)).status).toBe(409);
      const busy = await post(app, `/pull-queue/${live}/void`);
      expect(busy.status).toBe(503);
      expect(await busy.json()).toEqual({ error: 'pull log is busy; retry' });
    } finally {
      b.exec('ROLLBACK');
    }
    expect((await post(app, `/pull-queue/${live}/void`)).status).toBe(200);
    a.close();
    b.close();
  });

  it.each([
    ['SQLITE_BUSY', 503],
    ['SQLITE_BUSY_SNAPSHOT', 503],
    ['SQLITE_IOERR', 500],
  ])('a %s thrown by the void transaction → %i', async (code, status) => {
    const real = freshDb();
    real.prepare("INSERT INTO edge_pull_log (pull_kind, scope_key, done_on) VALUES ('storage', 'columbus', '2026-09-01')").run();
    const faulty = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === 'transaction') {
          return () => ({
            immediate: () => {
              throw Object.assign(new Error(`${code}: database is locked at C:/secret/path`), { code });
            },
          });
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as WarehouseDb;
    const app = makeApp(() => faulty);
    app.onError(warehouseJsonError);
    const res = await post(app, '/pull-queue/1/void');
    expect(res.status).toBe(status);
    if (status === 503) {
      const text = await res.text();
      expect(JSON.parse(text)).toEqual({ error: 'pull log is busy; retry' });
      expect(text).not.toMatch(/secret|SQLITE|locked/);
    }
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

describe('POST /pull-queue under write contention', () => {
  it('SQLITE_BUSY on the insert → 503 with the same fixed text as the void route; no row; succeeds once the lock clears', async () => {
    const path = join(mkdtempSync(join(tmpdir(), 'edge-api-post-busy-')), 'w.sqlite');
    const a = openWarehouse(path);
    const b = openWarehouse(path);
    a.pragma('busy_timeout = 1');
    const app = makeApp(() => a);
    const body = { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30' };
    b.exec('BEGIN IMMEDIATE');
    try {
      const busy = await post(app, '/pull-queue', body);
      expect(busy.status).toBe(503);
      const text = await busy.text();
      expect(JSON.parse(text)).toEqual({ error: 'pull log is busy; retry' });
      expect(text).not.toMatch(/locked|SQLITE/);
    } finally {
      b.exec('ROLLBACK');
    }
    expect((a.prepare('SELECT COUNT(*) AS n FROM edge_pull_log').get() as { n: number }).n).toBe(0);
    expect((await post(app, '/pull-queue', body)).status).toBe(200);
    a.close();
    b.close();
  });

  it('a non-busy fault is still a 500 (the mapping is busy-only)', async () => {
    const real = freshDb();
    const faulty = new Proxy(real, {
      get(target, prop, recv) {
        if (prop === 'prepare') {
          return (sql: string) => {
            if (/INSERT INTO edge_pull_log/.test(sql)) throw Object.assign(new Error('disk I/O error'), { code: 'SQLITE_IOERR' });
            return target.prepare(sql);
          };
        }
        const v = Reflect.get(target, prop, recv);
        return typeof v === 'function' ? v.bind(target) : v;
      },
    }) as WarehouseDb;
    expect((await post(makeApp(() => faulty), '/pull-queue', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30' })).status).toBe(500);
  });
});

describe('POST /pull-queue/:id/void — scope guard', () => {
  type RawM = Record<string, unknown> & { id: string; type: string; truck?: Array<number | null>; status?: Record<string, string[]> };
  function writeDataset(dir: string, edit: (markets: RawM[]) => void): void {
    const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { markets: RawM[] };
    edit(f.markets);
    writeFileSync(join(dir, 'markets.json'), JSON.stringify(f));
  }
  const voidedAt = (db: WarehouseDb, id: number) =>
    (db.prepare('SELECT voided_at FROM edge_pull_log WHERE id = ?').get(id) as { voided_at: string | null }).voided_at;

  it('a truck state that became automated cannot be voided (409, fixed text, row untouched); un-automated it is voidable again', async () => {
    const db = freshDb();
    const dir = fixtureDir();
    const app = makeApp(() => db, dir);
    const item = EdgePullItem.parse(await (await post(app, '/pull-queue', { kind: 'truck', scopeKey: 'OH', doneOn: '2026-09-01' })).json());
    const id = item.scopes.find((s) => s.scopeKey === 'OH')!.lastLogId!;

    writeDataset(dir, (ms) => {
      const columbus = ms.find((m) => m.id === 'columbus')!; // columbus is OH → OH automated
      columbus.truck = [1, 2, 3, 4, 5];
      columbus.status!.truck = ['actual', 'actual', 'actual', 'actual', 'actual'];
    });
    const res = await post(app, `/pull-queue/${id}/void`);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: 'that scope is no longer in the pull queue; its history is kept' });
    expect(voidedAt(db, id)).toBeNull();

    writeDataset(dir, () => undefined); // automation lost
    expect((await post(app, `/pull-queue/${id}/void`)).status).toBe(200);
    expect(voidedAt(db, id)).not.toBeNull();
  });

  it('a retyped frozen id with log history stays voidable (log-only keys are in scope)', async () => {
    const db = freshDb();
    const id = Number(db.prepare("INSERT INTO edge_pull_log (pull_kind, scope_key, done_on) VALUES ('storage', 'harrisburg', '2026-09-30')").run().lastInsertRowid);
    const dir = mkdtempSync(join(tmpdir(), 'edge-api-void-retype-'));
    writeDataset(dir, (ms) => {
      const m = JSON.parse(JSON.stringify(ms[0])) as RawM;
      m.id = 'harrisburg';
      m.type = 'auto';
      ms.push(m);
    });
    const res = await post(makeApp(() => db, dir), `/pull-queue/${id}/void`);
    expect(res.status).toBe(200);
    expect(voidedAt(db, id)).not.toBeNull();
  });
});

describe('POST / void responses keep log-history-only scopes', () => {
  type RawM = Record<string, unknown> & { id: string; type: string; lat: unknown };
  function writeDataset(dir: string, edit: (markets: RawM[]) => void): void {
    const f = JSON.parse(readFileSync(FIXTURE, 'utf8')) as { markets: RawM[] };
    edit(f.markets);
    writeFileSync(join(dir, 'markets.json'), JSON.stringify(f));
  }
  const clone = (markets: RawM[], id: string, type: string): RawM => {
    const m = JSON.parse(JSON.stringify(markets[0])) as RawM;
    m.id = id;
    m.type = type;
    return m;
  };

  it('quarantined newtown: POST and void bodies still carry its scope (current, then reverted)', async () => {
    const db = freshDb();
    db.prepare("INSERT INTO edge_pull_log (pull_kind, scope_key, done_on) VALUES ('storage', 'newtown', '2026-09-01')").run();
    const dir = mkdtempSync(join(tmpdir(), 'edge-api-hist-quar-'));
    writeDataset(dir, (ms) => {
      const n = clone(ms, 'newtown', 'named');
      n.lat = 'not-a-number'; // quarantined: absent from loaded markets, in scope only via log history
      ms.push(n);
    });
    const app = makeApp(() => db, dir);
    const rec = await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'newtown', doneOn: '2026-09-30' });
    expect(rec.status).toBe(200);
    const item = EdgePullItem.parse(await rec.json());
    const scope = item.scopes.find((s) => s.scopeKey === 'newtown');
    expect(scope).toMatchObject({ state: 'current', lastDoneOn: '2026-09-30' });
    expect(item.scopes).toHaveLength(22);

    const voided = await post(app, `/pull-queue/${scope!.lastLogId}/void`);
    expect(voided.status).toBe(200);
    const after = EdgePullItem.parse(await voided.json());
    expect(after.scopes.find((s) => s.scopeKey === 'newtown')).toMatchObject({ state: 'current', lastDoneOn: '2026-09-01' });
    expect(after.scopes).toHaveLength(22);
  });

  it('retyped frozen harrisburg (auto) with history: POST and void bodies still carry its scope', async () => {
    const db = freshDb();
    db.prepare("INSERT INTO edge_pull_log (pull_kind, scope_key, done_on) VALUES ('storage', 'harrisburg', '2026-09-01')").run();
    const dir = mkdtempSync(join(tmpdir(), 'edge-api-hist-retype-'));
    writeDataset(dir, (ms) => ms.push(clone(ms, 'harrisburg', 'auto')));
    const app = makeApp(() => db, dir);
    const item = EdgePullItem.parse(await (await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'harrisburg', doneOn: '2026-09-30' })).json());
    const scope = item.scopes.find((s) => s.scopeKey === 'harrisburg');
    expect(scope).toMatchObject({ state: 'current', lastDoneOn: '2026-09-30', scopeLabel: 'Harrisburg, PA' });

    const after = EdgePullItem.parse(await (await post(app, `/pull-queue/${scope!.lastLogId}/void`)).json());
    expect(after.scopes.find((s) => s.scopeKey === 'harrisburg')).toMatchObject({ state: 'current', lastDoneOn: '2026-09-01' });
  });

  it('a scope whose ONLY history is the voided row still appears (open) in the void response', async () => {
    const db = freshDb();
    const dir = mkdtempSync(join(tmpdir(), 'edge-api-hist-only-'));
    writeDataset(dir, (ms) => ms.push(clone(ms, 'harrisburg', 'auto')));
    const id = Number(db.prepare("INSERT INTO edge_pull_log (pull_kind, scope_key, done_on) VALUES ('storage', 'harrisburg', '2026-09-01')").run().lastInsertRowid);
    const after = EdgePullItem.parse(await (await post(makeApp(() => db, dir), `/pull-queue/${id}/void`)).json());
    expect(after.scopes.find((s) => s.scopeKey === 'harrisburg')).toMatchObject({ state: 'open', lastDoneOn: null });
  });
});
