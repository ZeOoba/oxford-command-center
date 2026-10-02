import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';

function makeDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare("INSERT INTO property_master (id, name) VALUES ('p1', 'P1')").run();
  return db;
}
const ins = (db: Database.Database, o: Record<string, unknown> = {}) => {
  const r = { property_id: 'p1', month: '2026-10', captured_through: '2026-10-02', total_sf: 1000, leased_sf: 800, in_place_rent: 9000, lease_count: 3, occ_pct: 0.8, ...o };
  return db.prepare(
    `INSERT INTO portfolio_month_snapshot (property_id, month, captured_through, total_sf, leased_sf, in_place_rent, lease_count, occ_pct)
     VALUES (@property_id, @month, @captured_through, @total_sf, @leased_sf, @in_place_rent, @lease_count, @occ_pct)`,
  ).run(r);
};

describe('migration 033 portfolio_month_snapshot', () => {
  it('creates the table and enforces UNIQUE(property_id, month)', () => {
    const db = makeDb();
    ins(db);
    expect(() => ins(db)).toThrow(/UNIQUE/);
  });
  it('rejects a malformed month key', () => {
    expect(() => ins(makeDb(), { month: '2026-1' })).toThrow(/CHECK/);
    expect(() => ins(makeDb(), { month: 'October' })).toThrow(/CHECK/);
  });
  it('rejects negative SF / rent / count and out-of-range occ_pct; allows NULL occ_pct', () => {
    expect(() => ins(makeDb(), { leased_sf: -1 })).toThrow(/CHECK/);
    expect(() => ins(makeDb(), { in_place_rent: -5 })).toThrow(/CHECK/);
    expect(() => ins(makeDb(), { lease_count: -1 })).toThrow(/CHECK/);
    expect(() => ins(makeDb(), { occ_pct: 1.2 })).toThrow(/CHECK/);
    expect(() => ins(makeDb(), { occ_pct: null })).not.toThrow();
  });
  it('defaults frozen to 0 and cascades on property delete', () => {
    const db = makeDb();
    ins(db);
    expect((db.prepare('SELECT frozen FROM portfolio_month_snapshot').get() as { frozen: number }).frozen).toBe(0);
    db.prepare("DELETE FROM property_master WHERE id = 'p1'").run();
    expect((db.prepare('SELECT COUNT(*) AS n FROM portfolio_month_snapshot').get() as { n: number }).n).toBe(0);
  });
});
