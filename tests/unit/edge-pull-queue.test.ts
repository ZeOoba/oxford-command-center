// @vitest-environment node
//
// tests/unit/edge-pull-queue.test.ts — pull-queue model + append-only log (spec §5.3, F12).
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse, type WarehouseDb } from '../../server/warehouse/db';
import {
  EDGE_BUY_BOX_FALLBACK, MFG_INVEST_STATES, TRUCK_STATES, automatedTruckStates, buildEdgePullItem, buildEdgePullQueue,
  computeOutsidePullScope, deriveBuyBoxIds, isRealIsoDate, localIsoDate, pullScopeKeys, readEdgePullLatest,
  PullValidationError, recordEdgePull, scopeStateFor, voidEdgePull,
} from '../../server/edge/pull-queue';
import * as pullQueue from '../../server/edge/pull-queue';
import { fourMarkets, mkMarket, obs } from './edge-test-helpers';

const pullQueueDays = (k: 'storage' | 'ios' | 'mfgInvest' | 'truck'): number => pullQueue.PULL_ITEMS[k].cadenceDays;

function freshDb(): WarehouseDb {
  return openWarehouse(join(mkdtempSync(join(tmpdir(), 'edge-pq-')), 'w.sqlite'));
}

describe('scope lists', () => {
  it('launch scope counts are 21 / 21 / 15 / 13 = 70 with no dataset (frozen fallback)', () => {
    expect(pullScopeKeys('storage', [])).toHaveLength(21);
    expect(pullScopeKeys('ios', [])).toHaveLength(21);
    expect(pullScopeKeys('mfgInvest', [])).toHaveLength(15);
    expect(pullScopeKeys('truck', [])).toHaveLength(13);
  });

  it('pins the state lists from spec §5.3', () => {
    expect([...MFG_INVEST_STATES]).toEqual(['PA', 'MD', 'VA', 'WV', 'OH', 'IN', 'MI', 'KY', 'MO', 'KS', 'WI', 'IA', 'NE', 'IL', 'MN']);
    expect([...TRUCK_STATES]).toEqual(['OH', 'IN', 'WI', 'PA', 'MD', 'KY', 'MO', 'KS', 'IA', 'NE', 'WV', 'IL', 'MN']);
    expect(TRUCK_STATES).not.toContain('VA');
    expect(TRUCK_STATES).not.toContain('MI');
  });

  it('buy-box derivation from markets.json type equals the frozen artifact list', () => {
    const markets = [
      ...EDGE_BUY_BOX_FALLBACK.map((s) =>
        mkMarket(s.id, s.label, s.label.slice(-2), s.id === 'indianapolis_south' ? 'named_custom' : 'named')),
      mkMarket('akron', 'Akron', 'OH', 'auto'),
    ];
    expect(deriveBuyBoxIds(markets)).toEqual(EDGE_BUY_BOX_FALLBACK.map((s) => s.id));
  });

  it('derives buy-box ids from the dataset when present (fixture-sized)', () => {
    expect(deriveBuyBoxIds(fourMarkets())).toEqual(['columbus', 'indianapolis_south', 'richmond']);
    for (const id of deriveBuyBoxIds(fourMarkets())) {
      expect(EDGE_BUY_BOX_FALLBACK.map((s) => s.id)).toContain(id);
    }
  });

  it('VA/MI truck coverage comes from markets.json, not the queue', () => {
    const markets = [...fourMarkets(), mkMarket('grand_rapids', 'Grand Rapids', 'MI', 'named', { truck: obs([1, 2, 3, 4, 5]) })];
    expect(automatedTruckStates(markets)).toEqual(['MI', 'VA']);
    expect(pullScopeKeys('truck', markets)).not.toContain('VA');
  });

  it('a partially filled truck series still counts as automated (some, not every)', () => {
    const markets = [...fourMarkets(), mkMarket('grand_rapids', 'Grand Rapids', 'MI', 'named', { truck: obs([null, null, null, null, 3]) })];
    expect(automatedTruckStates(markets)).toEqual(['MI', 'VA']);
    expect(pullScopeKeys('truck', markets)).not.toContain('MI');
  });

  it('lists in-dataset states outside the pull scope (never silently omitted)', () => {
    const markets = [
      ...fourMarkets(),
      mkMarket('clarksville', 'Clarksville', 'TN', 'auto'),
      mkMarket('fargo', 'Fargo', 'ND', 'auto'),
      mkMarket('washington_arlington_alexandria', 'Washington-Arlington-Alexandria', 'DC', 'auto'),
    ];
    expect(computeOutsidePullScope(markets)).toEqual({ truck: ['DC', 'ND', 'TN'], mfgInvest: ['DC', 'ND', 'TN'] });
  });
});

describe('dates and state derivation', () => {
  it('localIsoDate formats the local calendar date', () => {
    expect(localIsoDate(new Date(2026, 9, 2, 23, 30))).toBe('2026-10-02');
  });

  it('isRealIsoDate rejects overflow and malformed dates', () => {
    expect(isRealIsoDate('2026-02-28')).toBe(true);
    expect(isRealIsoDate('2026-02-30')).toBe(false);
    expect(isRealIsoDate('2026-13-01')).toBe(false);
    expect(isRealIsoDate('2026-9-1')).toBe(false);
  });

  it('open / current / due at the cadence boundary', () => {
    expect(scopeStateFor(null, 90, '2026-10-02')).toEqual({ state: 'open', ageDays: null });
    expect(scopeStateFor('2026-07-04', 90, '2026-10-02')).toEqual({ state: 'current', ageDays: 90 });
    expect(scopeStateFor('2026-07-03', 90, '2026-10-02')).toEqual({ state: 'due', ageDays: 91 });
  });

  it('pins the boundary for every cadence: exactly N days = current, N+1 = due', () => {
    // monthly 30
    expect(scopeStateFor('2026-09-02', 30, '2026-10-02')).toEqual({ state: 'current', ageDays: 30 });
    expect(scopeStateFor('2026-09-01', 30, '2026-10-02')).toEqual({ state: 'due', ageDays: 31 });
    // annual 365
    expect(scopeStateFor('2025-10-02', 365, '2026-10-02')).toEqual({ state: 'current', ageDays: 365 });
    expect(scopeStateFor('2025-10-01', 365, '2026-10-02')).toEqual({ state: 'due', ageDays: 366 });
    // the cadences themselves
    expect([pullQueueDays('storage'), pullQueueDays('ios'), pullQueueDays('mfgInvest'), pullQueueDays('truck')]).toEqual([90, 90, 30, 365]);
  });
});

describe('append-only log', () => {
  it('latest non-voided row wins, ordered done_on DESC then id DESC; void reverts to the prior row', () => {
    const db = freshDb();
    recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-06-01' });
    const id2 = recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-01', note: 'baseline' });
    recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-06-15' });
    expect(readEdgePullLatest(db).get('storage|columbus')?.id).toBe(id2);

    const id4 = recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-01' });
    expect(readEdgePullLatest(db).get('storage|columbus')?.id).toBe(id4);

    expect(voidEdgePull(db, id4)).toEqual({ status: 'voided', kind: 'storage' });
    expect(readEdgePullLatest(db).get('storage|columbus')?.id).toBe(id2);
    expect(voidEdgePull(db, id4)).toEqual({ status: 'already_voided', kind: 'storage' });
    expect(voidEdgePull(db, 9999)).toEqual({ status: 'not_found' });

    const count = (db.prepare('SELECT COUNT(*) AS n FROM edge_pull_log').get() as { n: number }).n;
    expect(count).toBe(4); // void never deletes
  });

  it('F1: a stale tab cannot void a superseded row; only the latest non-voided row per scope is voidable', () => {
    const db = freshDb();
    const id1 = recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-06-01' });
    const id2 = recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-01' });
    // another scope's rows never count as "newer"
    const other = recordEdgePull(db, { kind: 'storage', scopeKey: 'richmond', doneOn: '2026-09-15' });

    expect(voidEdgePull(db, id1)).toEqual({ status: 'superseded', kind: 'storage' });
    const voidedAt = (id: number) => (db.prepare('SELECT voided_at FROM edge_pull_log WHERE id = ?').get(id) as { voided_at: string | null }).voided_at;
    expect(voidedAt(id1)).toBeNull(); // row 1 NOT voided
    expect(readEdgePullLatest(db).get('storage|columbus')?.id).toBe(id2); // state unchanged

    expect(voidEdgePull(db, other)).toEqual({ status: 'voided', kind: 'storage' }); // different scope: own latest
    expect(voidEdgePull(db, id2)).toEqual({ status: 'voided', kind: 'storage' });
    expect(readEdgePullLatest(db).get('storage|columbus')?.id).toBe(id1); // reverts to row 1
    expect(voidEdgePull(db, id1)).toEqual({ status: 'voided', kind: 'storage' }); // now row 1 is the latest
  });

  it('F1: supersession uses the state ordering (done_on DESC, id DESC), not insertion order', () => {
    const db = freshDb();
    const newerDate = recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-01' });
    const laterInsertOlderDate = recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-06-01' });
    expect(voidEdgePull(db, laterInsertOlderDate)).toEqual({ status: 'superseded', kind: 'storage' });
    expect(voidEdgePull(db, newerDate)).toEqual({ status: 'voided', kind: 'storage' });
  });

  it('launch state: zero log rows → all 70 scopes open, no seeding', () => {
    const q = buildEdgePullQueue(freshDb(), [], '2026-10-02');
    expect(q.items.map((i) => i.kind)).toEqual(['storage', 'ios', 'mfgInvest', 'truck']);
    const scopes = q.items.flatMap((i) => i.scopes);
    expect(scopes).toHaveLength(70);
    expect(scopes.every((s) => s.state === 'open')).toBe(true);
    expect(q.items.map((i) => i.counts.open)).toEqual([21, 21, 15, 13]);
  });

  it('builds per-scope links and truck blockers', () => {
    const item = buildEdgePullItem('storage', [], new Map(), '2026-10-02');
    const columbus = item.scopes.find((s) => s.scopeKey === 'columbus');
    expect(columbus?.scopeLabel).toBe('Columbus, OH');
    expect(columbus?.links.map((l) => l.url)).toEqual([
      'https://www.storagecafe.com/self-storage-rates/columbus-oh/',
      'https://www.rentcafe.com/self-storage/usa/columbus-oh/',
    ]);
    const truck = buildEdgePullItem('truck', [], new Map(), '2026-10-02');
    expect(truck.scopes.find((s) => s.scopeKey === 'OH')?.blocker).toContain('decommissioned');
    expect(truck.scopes.find((s) => s.scopeKey === 'PA')?.blocker).toContain('PASDA');
    const mfg = buildEdgePullItem('mfgInvest', [], new Map(), '2026-10-02');
    expect(mfg.scopes.find((s) => s.scopeKey === 'OH')?.links[0]?.url).toBe('https://www.jobsohio.com/newsroom');
  });
});
describe('recordEdgePull validation and append-only guarantees', () => {
  it('rejects non-real calendar dates the contract regex accepts', () => {
    const db = freshDb();
    for (const doneOn of ['2026-99-99', '2026-02-30', '2026-13-01', '2026-00-10']) {
      expect(() => recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn })).toThrow(/real calendar date/);
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM edge_pull_log').get() as { n: number }).n).toBe(0);
  });

  it('throws PullValidationError (a RangeError subclass) for bad and future dates', () => {
    const db = freshDb();
    for (const [doneOn, today] of [['2026-02-30', '2026-10-02'], ['2026-10-03', '2026-10-02']] as const) {
      let caught: unknown;
      try {
        recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn }, today);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(PullValidationError);
      expect(caught).toBeInstanceOf(RangeError);
      expect((caught as Error).name).toBe('PullValidationError');
    }
  });

  it('rejects future dates relative to server local date; accepts today', () => {
    const db = freshDb();
    expect(() => recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-10-03' }, '2026-10-02')).toThrow(/future/);
    expect(() => recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn: '9999-12-31' })).toThrow(/future/);
    expect(recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-10-02' }, '2026-10-02')).toBeGreaterThan(0);
    // Inject the same `today` the caller computed: recordEdgePull would otherwise re-read new Date() (midnight-rollover flake).
    const today = localIsoDate(new Date());
    expect(recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn: today }, today)).toBeGreaterThan(0);
  });

  it('exposes no delete path: no DELETE SQL in the module, void only sets voided_at and keeps the row', () => {
    const src = readFileSync(join(__dirname, '../../server/edge/pull-queue.ts'), 'utf8');
    expect(src).not.toMatch(/\bDELETE\b/i);
    expect(Object.keys(pullQueue).filter((k) => /delete|remove|purge|drop/i.test(k))).toEqual([]);
    const db = freshDb();
    const id = recordEdgePull(db, { kind: 'truck', scopeKey: 'OH', doneOn: '2026-01-05', note: 'kept' });
    voidEdgePull(db, id);
    const row = db.prepare('SELECT done_on, note, voided_at FROM edge_pull_log WHERE id = ?').get(id) as
      { done_on: string; note: string; voided_at: string | null };
    expect(row.done_on).toBe('2026-01-05');
    expect(row.note).toBe('kept');
    expect(row.voided_at).not.toBeNull();
  });

  it('queue state derives from the log: a recorded pull makes its scope current, not the others', () => {
    const db = freshDb();
    recordEdgePull(db, { kind: 'truck', scopeKey: 'OH', doneOn: '2026-10-01' }, '2026-10-02');
    const q = buildEdgePullQueue(db, [], '2026-10-02');
    const truck = q.items.find((i) => i.kind === 'truck');
    expect(truck?.counts).toEqual({ open: 12, due: 0, current: 1 });
  });
});

describe('R1 — void check-then-update is atomic against another connection', () => {
  it('a competing newer pull recorded between the latest-row check and the UPDATE never lets a superseded row be voided', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'edge-pq-race-')), 'w.sqlite');
    const a = openWarehouse(path);
    const b = openWarehouse(path);
    b.pragma('busy_timeout = 0'); // B must not wait on A's lock (same thread: a wait could never be released)
    const target = recordEdgePull(a, { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-01' });

    let bInsert: 'not_run' | 'inserted' | 'busy' = 'not_run';
    const hooked = new Proxy(a, {
      get(t, prop) {
        const v = Reflect.get(t, prop, t) as unknown;
        if (prop === 'prepare') {
          return (sql: string) => {
            const stmt = t.prepare(sql);
            if (!/ORDER BY done_on DESC/.test(sql)) return stmt;
            // Right after the latest-row SELECT executes, connection B records a newer row for the scope.
            return new Proxy(stmt, {
              get(st, sp) {
                const sv = Reflect.get(st, sp, st) as unknown;
                if (sp !== 'get') return typeof sv === 'function' ? (sv as (...x: unknown[]) => unknown).bind(st) : sv;
                return (...args: unknown[]) => {
                  const out = st.get(...args);
                  try {
                    b.prepare('INSERT INTO edge_pull_log (pull_kind, scope_key, done_on) VALUES (?, ?, ?)')
                      .run('storage', 'columbus', '2026-09-20');
                    bInsert = 'inserted';
                  } catch (e) {
                    if ((e as { code?: string }).code !== 'SQLITE_BUSY') throw e;
                    bInsert = 'busy';
                  }
                  return out;
                };
              },
            });
          };
        }
        return typeof v === 'function' ? (v as (...x: unknown[]) => unknown).bind(t) : v;
      },
    }) as WarehouseDb;

    const result = voidEdgePull(hooked, target);

    // Invariant (deterministic either way): a void decision is never applied to a row that B's
    // committed insert had already superseded. With the fix BEGIN IMMEDIATE holds the write lock
    // across check+update, so B is refused (SQLITE_BUSY) inside the window and the void is valid;
    // without it B's insert lands in the window and the stale decision voids a superseded row.
    if (bInsert === 'inserted') expect(result.status).not.toBe('voided');
    expect(bInsert).toBe('busy');
    expect(result).toEqual({ status: 'voided', kind: 'storage' });
    const voidedAt = (a.prepare('SELECT voided_at FROM edge_pull_log WHERE id = ?').get(target) as { voided_at: string | null }).voided_at;
    expect(voidedAt).not.toBeNull();
    // once A has committed, B's retry succeeds and becomes the scope's state
    b.prepare('INSERT INTO edge_pull_log (pull_kind, scope_key, done_on) VALUES (?, ?, ?)').run('storage', 'columbus', '2026-09-20');
    expect(readEdgePullLatest(a).get('storage|columbus')?.doneOn).toBe('2026-09-20');
    a.close();
    b.close();
  });
});

describe('fix-pass 3 — B7 pull-queue gaps', () => {
  it('blockers appear only on truck scopes, never on other kinds even when the scope key collides', () => {
    for (const kind of ['storage', 'ios', 'mfgInvest'] as const) {
      const item = buildEdgePullItem(kind, [], new Map(), '2026-10-02');
      expect(item.scopes.every((s) => s.blocker === null)).toBe(true);
    }
    // mfgInvest shares state keys (OH, PA) with TRUCK_BLOCKERS: a leak would surface here
    const mfg = buildEdgePullItem('mfgInvest', [], new Map(), '2026-10-02');
    expect(mfg.scopes.find((s) => s.scopeKey === 'OH')?.blocker).toBeNull();
    expect(mfg.scopes.find((s) => s.scopeKey === 'PA')?.blocker).toBeNull();
  });

  it('ageDays is clamped at 0 for a legacy row dated in the future (inserted directly, bypassing the API guard)', () => {
    const db = freshDb();
    db.prepare("INSERT INTO edge_pull_log (pull_kind, scope_key, done_on) VALUES ('truck', 'OH', '2026-10-09')").run();
    const q = buildEdgePullQueue(db, [], '2026-10-02');
    const oh = q.items.find((i) => i.kind === 'truck')!.scopes.find((s) => s.scopeKey === 'OH')!;
    expect(oh.ageDays).toBe(0);
    expect(oh.state).toBe('current');
    expect(scopeStateFor('2026-10-09', 365, '2026-10-02')).toEqual({ state: 'current', ageDays: 0 });
  });
});
