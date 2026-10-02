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

  it('is idempotent — a second run does not re-apply', () => {
    const db = makeDb();
    const before = (db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n;
    runMigrations(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n).toBe(before);
  });
});
