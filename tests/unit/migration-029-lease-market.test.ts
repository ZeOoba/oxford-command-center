// tests/unit/migration-029-lease-market.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}
function landing(db: Database.Database, sha: string, status: 'ok' | 'failed' = 'ok'): number {
  return Number(
    db.prepare(
      `INSERT INTO lm_landing (source, source_ref, sha256, market_id, observed_at, received_at, completeness, parse_status)
       VALUES ('costar_listings', 'f.xlsx', ?, 'columbus', '2026-01-01', '2026-01-02T00:00:00Z', ?, ?)`,
    ).run(sha, status === 'ok' ? 'complete' : 'n/a', status).lastInsertRowid,
  );
}
function property(db: Database.Database, addressNorm: string, identityKey = `addr:${addressNorm}`): number {
  return Number(
    db.prepare(
      `INSERT INTO lm_property (identity_key, address_norm, address_display, market_id, subtype, building_status, first_seen, last_seen)
       VALUES (?, ?, 'x', 'columbus', 'warehouse', 'existing', '2026-01-01', '2026-01-01')`,
    ).run(identityKey, addressNorm).lastInsertRowid,
  );
}
function space(db: Database.Database, propertyId: number, landingId: number, suite: string): number {
  return Number(
    db.prepare(
      `INSERT INTO lm_listing (property_id, suite_norm, first_seen, last_seen, first_landing_id, origin_tier)
       VALUES (?, ?, '2026-01-01', '2026-01-01', ?, 'T1')`,
    ).run(propertyId, suite, landingId).lastInsertRowid,
  );
}
function observe(db: Database.Database, listingId: number, landingId: number, date: string, asking: number | null) {
  db.prepare(
    `INSERT INTO lm_observation (listing_id, landing_id, observed_at, available_sf, rent_basis, is_sublease, rent_is_total, asking_nnn_eq, confidence)
     VALUES (?, ?, ?, 10000, 'NNN', 0, 0, ?, 'high')`,
  ).run(listingId, landingId, date, asking);
}

describe('migration 029 — lease market', () => {
  it('creates all tables and views', () => {
    const db = makeDb();
    const names = (type: string) =>
      db.prepare("SELECT name FROM sqlite_master WHERE type = ? AND name LIKE 'lm_%' ORDER BY name").all(type).map((r) => (r as { name: string }).name);
    expect(names('table')).toEqual(['lm_landing', 'lm_listing', 'lm_listing_event', 'lm_market_rent_feed', 'lm_observation', 'lm_property', 'lm_radar_decision', 'lm_signal']);
    expect(names('view')).toEqual(['lm_v_current_spaces', 'lm_v_listing_metrics', 'lm_v_radar']);
  });

  it('lets a failed landing retry but rejects two ok landings with the same bytes', () => {
    const db = makeDb();
    landing(db, 'abc', 'failed');
    landing(db, 'abc', 'failed');
    landing(db, 'abc', 'ok');
    expect(() => landing(db, 'abc', 'ok')).toThrow(/UNIQUE/);
  });

  it('keys properties by identity_key (same address allowed with different keys) and spaces by property + suite', () => {
    const db = makeDb();
    const l = landing(db, 's1');
    const p = property(db, '1100 RARIG AVE', 'addr:columbus|COLUMBUS|1100 RARIG AVE');
    // Same street address, different identity_key (e.g. a second CoStar-id-keyed property at the same
    // address, or the same address in a different market) — allowed since address_norm is no longer UNIQUE.
    expect(() => property(db, '1100 RARIG AVE', 'costar:C1')).not.toThrow();
    // Same identity_key is still rejected.
    expect(() => property(db, '9 OTHER ST', 'addr:columbus|COLUMBUS|1100 RARIG AVE')).toThrow(/UNIQUE/);
    space(db, p, l, 'B');
    space(db, p, l, '');
    expect(() => space(db, p, l, 'B')).toThrow(/UNIQUE/);
  });

  it('enforces check constraints on basis, events, signals and decisions', () => {
    const db = makeDb();
    const l = landing(db, 's2');
    const s = space(db, property(db, '1 MAIN ST'), l, '');
    expect(() =>
      db.prepare(`INSERT INTO lm_observation (listing_id, landing_id, observed_at, available_sf, rent_basis, is_sublease, rent_is_total, confidence) VALUES (?, ?, '2026-01-01', 1000, 'NET', 0, 0, 'high')`).run(s, l),
    ).toThrow(/CHECK/);
    expect(() => db.prepare(`INSERT INTO lm_listing_event (listing_id, landing_id, event_date, kind) VALUES (?, ?, '2026-01-01', 'leased')`).run(s, l)).toThrow(/CHECK/);
    expect(() =>
      db.prepare(`INSERT INTO lm_signal (property_id, kind, severity, computed_at, evidence_json) VALUES (1, 'acq_candidate', 'high', '2026-01-01', '{}')`).run(),
    ).toThrow(/CHECK/);
    expect(() => db.prepare(`INSERT INTO lm_radar_decision (property_id, decided_at, decision) VALUES (1, '2026-01-01', 'buy')`).run()).toThrow(/CHECK/);
  });

  it('enforces lm_radar_decision as append-only (no UPDATE, no DELETE)', () => {
    const db = makeDb();
    const info = db
      .prepare(`INSERT INTO lm_radar_decision (property_id, decided_at, decision, note) VALUES (1, '2026-01-01', 'investigate', 'call broker')`)
      .run();
    const id = Number(info.lastInsertRowid);
    expect(() => db.prepare(`UPDATE lm_radar_decision SET decision = 'pass' WHERE id = ?`).run(id)).toThrow(/append-only/i);
    expect(() => db.prepare(`DELETE FROM lm_radar_decision WHERE id = ?`).run(id)).toThrow(/append-only/i);
    // The row survives both attempts untouched — corrections are new rows, not mutations.
    expect(db.prepare('SELECT decision FROM lm_radar_decision WHERE id = ?').get(id)).toEqual({ decision: 'investigate' });
    expect((db.prepare('SELECT COUNT(*) AS n FROM lm_radar_decision').get() as { n: number }).n).toBe(1);
  });

  it('lm_v_listing_metrics reports original, current, minimum asking and cuts', () => {
    const db = makeDb();
    const l1 = landing(db, 'a');
    const l2 = landing(db, 'b');
    const l3 = landing(db, 'c');
    const s = space(db, property(db, '9 OAK ST'), l1, '');
    observe(db, s, l1, '2026-01-01', 9.5);
    observe(db, s, l2, '2026-02-01', 9.0);
    observe(db, s, l3, '2026-03-01', 8.5);
    const ev = db.prepare(`INSERT INTO lm_listing_event (listing_id, landing_id, event_date, kind, prev_value, new_value) VALUES (?, ?, ?, 'price_cut', ?, ?)`);
    ev.run(s, l2, '2026-02-01', 9.5, 9.0);
    ev.run(s, l3, '2026-03-01', 9.0, 8.5);
    const m = db.prepare('SELECT * FROM lm_v_listing_metrics WHERE listing_id = ?').get(s) as Record<string, number | string>;
    expect(m).toMatchObject({ original_asking: 9.5, current_asking: 8.5, min_asking: 8.5, reduction_count: 2, first_observed: '2026-01-01', last_observed: '2026-03-01' });
    expect(m.cumulative_reduction_pct as number).toBeCloseTo(-0.10526, 4);
  });
});
