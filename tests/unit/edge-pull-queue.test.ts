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
  recordEdgePull, scopeStateFor, voidEdgePull,
} from '../../server/edge/pull-queue';
import * as pullQueue from '../../server/edge/pull-queue';
import { fourMarkets, mkMarket, obs } from './edge-test-helpers';

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

  it('rejects future dates relative to server local date; accepts today', () => {
    const db = freshDb();
    expect(() => recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-10-03' }, '2026-10-02')).toThrow(/future/);
    expect(() => recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn: '9999-12-31' })).toThrow(/future/);
    expect(recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-10-02' }, '2026-10-02')).toBeGreaterThan(0);
    const today = localIsoDate(new Date());
    expect(recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn: today })).toBeGreaterThan(0);
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
