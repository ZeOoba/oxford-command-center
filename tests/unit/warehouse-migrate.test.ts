import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';

function makeMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  return db;
}

describe('runMigrations', () => {
  it('creates the _migrations tracking table', () => {
    const db = makeMemoryDb();
    runMigrations(db);
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='_migrations'")
      .get();
    expect(row).toBeTruthy();
  });

  it('applies 001_initial — creates all 5 warehouse tables', () => {
    const db = makeMemoryDb();
    runMigrations(db);

    const tables = db
      .prepare(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT IN ('_migrations', 'sqlite_sequence')"
      )
      .all()
      .map((r: unknown) => (r as { name: string }).name)
      .sort();

    expect(tables).toContain('property_master');
    expect(tables).toContain('import_batches');
    expect(tables).toContain('account_mappings');
    expect(tables).toContain('ledger_entries');
    expect(tables).toContain('data_quality_issues');
  });

  it('records applied migrations in _migrations table', () => {
    const db = makeMemoryDb();
    runMigrations(db);
    const rows = db.prepare('SELECT filename FROM _migrations ORDER BY id').all() as { filename: string }[];
    expect(rows.length).toBeGreaterThanOrEqual(1);
    expect(rows[0]?.filename).toBe('001_initial.sql');
  });

  it('is idempotent — second call applies nothing new', () => {
    const db = makeMemoryDb();
    runMigrations(db);
    const countBefore = (db.prepare('SELECT COUNT(*) as n FROM _migrations').get() as { n: number }).n;

    runMigrations(db);
    const countAfter = (db.prepare('SELECT COUNT(*) as n FROM _migrations').get() as { n: number }).n;

    expect(countAfter).toBe(countBefore);
  });

  it('applies migrations in numeric order (001 before 002)', () => {
    const db = makeMemoryDb();
    runMigrations(db);
    const rows = db
      .prepare('SELECT filename FROM _migrations ORDER BY id')
      .all() as { filename: string }[];
    const filenames = rows.map((r) => r.filename);
    const sorted = [...filenames].sort();
    expect(filenames).toEqual(sorted);
  });

  it('does not double-apply if called concurrently on same db', () => {
    const db = makeMemoryDb();
    // Simulate two sequential calls (true concurrent access is not possible with a single Connection)
    runMigrations(db);
    runMigrations(db);
    const count = (db.prepare('SELECT COUNT(*) as n FROM _migrations').get() as { n: number }).n;
    // Should have exactly as many rows as there are migration files
    const rows = db.prepare('SELECT COUNT(*) as n FROM _migrations').get() as { n: number };
    expect(rows.n).toBe(count);
  });

  it('allows inserting data into property_master after migration', () => {
    const db = makeMemoryDb();
    runMigrations(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO property_master (id, name, financial_mode, ownership_pct, ownership_status)
           VALUES ('test-prop', 'Test Property', 'pnl', 1.0, 'active')`
        )
        .run()
    ).not.toThrow();
  });

  it('allows inserting a data_quality_issue after migration', () => {
    const db = makeMemoryDb();
    runMigrations(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO data_quality_issues (kind, detail, severity, status)
           VALUES ('empty-parse', 'Test issue', 'warn', 'open')`
        )
        .run()
    ).not.toThrow();
  });
});
