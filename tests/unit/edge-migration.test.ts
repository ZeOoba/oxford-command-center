// @vitest-environment node
//
// tests/unit/edge-migration.test.ts — migration 034 (spec §7). In-memory DB; never touches finance.sqlite.
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const insert = (db: Database.Database, kind: string, scope: string, doneOn: string, note: string | null = null) =>
  db.prepare('INSERT INTO edge_pull_log (pull_kind, scope_key, done_on, note) VALUES (?, ?, ?, ?)').run(kind, scope, doneOn, note);

describe('migration 034 — edge_pull_log', () => {
  it('a fresh DB migrates through 034 and records it', () => {
    const db = makeDb();
    const row = db.prepare("SELECT filename FROM _migrations WHERE filename = '034_edge_pull_log.sql'").get();
    expect(row).toBeDefined();
    const cols = (db.pragma('table_info(edge_pull_log)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(['id', 'pull_kind', 'scope_key', 'done_on', 'note', 'recorded_by', 'created_at', 'voided_at']);
  });

  it('accepts a valid row and fills the defaults', () => {
    const db = makeDb();
    insert(db, 'storage', 'columbus', '2026-09-30', 'baseline');
    const row = db.prepare('SELECT recorded_by, created_at, voided_at FROM edge_pull_log').get() as {
      recorded_by: string; created_at: string; voided_at: string | null;
    };
    expect(row.recorded_by).toBe('ui');
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(row.voided_at).toBeNull();
  });

  it('CHECK rejects a bad pull_kind', () => {
    expect(() => insert(makeDb(), 'rent', 'columbus', '2026-09-30')).toThrow(/CHECK constraint failed/);
  });

  it("CHECK rejects a non-calendar done_on ('2026-02-30') and a non-date string", () => {
    const db = makeDb();
    expect(() => insert(db, 'storage', 'columbus', '2026-02-30')).toThrow(/CHECK constraint failed/);
    expect(() => insert(db, 'storage', 'columbus', 'not-a-date')).toThrow(/CHECK constraint failed/);
  });

  it('CHECK rejects an oversize note and an out-of-range scope_key', () => {
    const db = makeDb();
    expect(() => insert(db, 'storage', 'columbus', '2026-09-30', 'x'.repeat(2001))).toThrow(/CHECK constraint failed/);
    expect(() => insert(db, 'storage', 'x', '2026-09-30')).toThrow(/CHECK constraint failed/);
  });

  it('boundaries: scope_key length 64 accepted / 65 rejected; note length 2000 accepted', () => {
    const db = makeDb();
    expect(() => insert(db, 'storage', 'x'.repeat(64), '2026-09-30', 'y'.repeat(2000))).not.toThrow();
    expect(() => insert(db, 'storage', 'x'.repeat(65), '2026-09-30')).toThrow(/CHECK constraint failed/);
    expect(() => insert(db, 'storage', 'xx', '2026-09-30')).not.toThrow();
  });

  it('is append-only at the DB level: DELETE aborts; INSERT and the void UPDATE still work', () => {
    const db = makeDb();
    const id = Number(insert(db, 'storage', 'columbus', '2026-09-30').lastInsertRowid);
    expect(() => db.prepare('DELETE FROM edge_pull_log WHERE id = ?').run(id)).toThrow(/append-only/);
    expect(() => db.prepare('DELETE FROM edge_pull_log').run()).toThrow(/append-only/);
    db.prepare("UPDATE edge_pull_log SET voided_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?").run(id);
    const row = db.prepare('SELECT voided_at FROM edge_pull_log WHERE id = ?').get(id) as { voided_at: string | null };
    expect(row.voided_at).not.toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM edge_pull_log').get() as { n: number }).n).toBe(1);
    expect(() => insert(db, 'ios', 'columbus', '2026-09-30')).not.toThrow();
  });

  describe('append-only guards (gate-fix P1)', () => {
    const seed = () => {
      const db = makeDb();
      const id = Number(insert(db, 'storage', 'columbus', '2026-09-30', 'n').lastInsertRowid);
      return { db, id };
    };
    const voidSql = "UPDATE edge_pull_log SET voided_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ?";

    it.each([
      ['done_on', "UPDATE edge_pull_log SET done_on = '2026-09-29' WHERE id = ?"],
      ['note', "UPDATE edge_pull_log SET note = 'edited' WHERE id = ?"],
      ['pull_kind', "UPDATE edge_pull_log SET pull_kind = 'ios' WHERE id = ?"],
      ['scope_key', "UPDATE edge_pull_log SET scope_key = 'cincinnati' WHERE id = ?"],
      ['id', 'UPDATE edge_pull_log SET id = id + 100 WHERE id = ?'],
    ])('UPDATE of %s aborts', (_c, sql) => {
      const { db, id } = seed();
      expect(() => db.prepare(sql).run(id)).toThrow(/append-only/);
    });

    it('un-void and re-void abort; void plus another column aborts', () => {
      const { db, id } = seed();
      db.prepare(voidSql).run(id);
      expect(() => db.prepare('UPDATE edge_pull_log SET voided_at = NULL WHERE id = ?').run(id)).toThrow(/append-only/);
      expect(() => db.prepare(voidSql).run(id)).toThrow(/append-only/);
      const { db: db2, id: id2 } = seed();
      expect(() =>
        db2.prepare("UPDATE edge_pull_log SET voided_at = '2026-10-02T00:00:00Z', note = 'x' WHERE id = ?").run(id2),
      ).toThrow(/append-only/);
    });

    it('INSERT OR REPLACE over an existing id aborts and the original row survives', () => {
      const { db, id } = seed();
      expect(() =>
        db
          .prepare("INSERT OR REPLACE INTO edge_pull_log (id, pull_kind, scope_key, done_on) VALUES (?, 'ios', 'columbus', '2026-09-01')")
          .run(id),
      ).toThrow(/REPLACE is not permitted/);
      const row = db.prepare('SELECT pull_kind, note FROM edge_pull_log WHERE id = ?').get(id) as { pull_kind: string; note: string };
      expect(row).toEqual({ pull_kind: 'storage', note: 'n' });
    });

    it('plain INSERT, explicit fresh-id INSERT, and the one-way void still work; DELETE still aborts', () => {
      const { db, id } = seed();
      expect(() => insert(db, 'ios', 'columbus', '2026-09-30')).not.toThrow();
      expect(() =>
        db.prepare("INSERT INTO edge_pull_log (id, pull_kind, scope_key, done_on) VALUES (9999, 'truck', 'oh', '2026-09-30')").run(),
      ).not.toThrow();
      db.prepare(voidSql).run(id);
      expect((db.prepare('SELECT voided_at FROM edge_pull_log WHERE id = ?').get(id) as { voided_at: string | null }).voided_at).not.toBeNull();
      expect(() => db.prepare('DELETE FROM edge_pull_log WHERE id = ?').run(id)).toThrow(/append-only/);
    });
  });

  it('is idempotent — a second run does not re-apply', () => {
    const db = makeDb();
    const before = (db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n;
    runMigrations(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n).toBe(before);
  });
});
