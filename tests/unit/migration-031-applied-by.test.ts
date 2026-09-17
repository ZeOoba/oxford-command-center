import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations, migrationActor } from '../../server/warehouse/migrate';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('migration 031 — _migrations.applied_by', () => {
  it('adds the column', () => {
    const db = makeDb();
    const cols = (db.pragma('table_info(_migrations)') as Array<{ name: string }>).map(
      (c) => c.name,
    );
    expect(cols).toContain('applied_by');
  });

  it('stamps 031 itself, and every migration after it', () => {
    // 031 is the migration that creates the column, so the runner has to check for the column
    // AFTER exec() rather than preparing one statement up front — otherwise 031 could never
    // record its own author and the first stamped row would be 032.
    const db = makeDb();
    const row = db
      .prepare("SELECT applied_by FROM _migrations WHERE filename = '031_migrations_applied_by.sql'")
      .get() as { applied_by: string | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.applied_by).toBeTruthy();
  });

  it('leaves earlier migrations NULL rather than backfilling a guess', () => {
    const db = makeDb();
    const row = db
      .prepare("SELECT applied_by FROM _migrations WHERE filename = '001_initial.sql'")
      .get() as { applied_by: string | null };
    expect(row.applied_by).toBeNull();
  });

  it('is idempotent — a second run does not re-apply or duplicate', () => {
    const db = makeDb();
    const before = (db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n;
    runMigrations(db);
    const after = (db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n;
    expect(after).toBe(before);
  });
});

describe('migrationActor', () => {
  it('prefers an explicit WAREHOUSE_ACTOR tag', () => {
    expect(migrationActor({ WAREHOUSE_ACTOR: 'ora-warehouse-backup' } as NodeJS.ProcessEnv)).toBe(
      'ora-warehouse-backup',
    );
  });

  it('falls back to the entry script and pid', () => {
    const actor = migrationActor({} as NodeJS.ProcessEnv);
    expect(actor).toMatch(/pid=\d+/);
  });

  it('ignores a whitespace-only tag', () => {
    expect(migrationActor({ WAREHOUSE_ACTOR: '   ' } as NodeJS.ProcessEnv)).toMatch(/pid=\d+/);
  });
});
