// server/warehouse/migrate.ts
//
// Migration runner for the financial warehouse SQLite database.
// Applies numbered .sql files from the migrations/ directory in order,
// tracking which have been applied in a _migrations table.
//
// Usage: runMigrations(db) — called once in openWarehouse() before any other operation.
// Idempotent: already-applied migrations are skipped.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

const CREATE_MIGRATIONS_TABLE = `
CREATE TABLE IF NOT EXISTS _migrations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  filename    TEXT    NOT NULL UNIQUE,
  applied_at  TEXT    NOT NULL DEFAULT (datetime('now'))
)
`;

/** Apply all unapplied .sql migrations from the migrations/ directory, in numeric order. */
export function runMigrations(db: Database): void {
  // Ensure the tracking table exists first
  db.exec(CREATE_MIGRATIONS_TABLE);

  // Collect already-applied filenames
  const applied = new Set(
    (db.prepare('SELECT filename FROM _migrations').all() as { filename: string }[]).map(
      (r) => r.filename,
    ),
  );

  // Read and sort migration files numerically (001_ before 002_ before 010_)
  let files: string[];
  try {
    files = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith('.sql'))
      .sort((a, b) => {
        const numA = parseInt(a.split('_')[0] ?? '0', 10);
        const numB = parseInt(b.split('_')[0] ?? '0', 10);
        return numA - numB;
      });
  } catch {
    throw new Error(`Cannot read migrations directory: ${MIGRATIONS_DIR}`);
  }

  const insertMigration = db.prepare(
    'INSERT INTO _migrations (filename) VALUES (?)',
  );

  for (const filename of files) {
    if (applied.has(filename)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');

    // Apply the migration and record it in a single transaction
    db.transaction(() => {
      db.exec(sql);
      insertMigration.run(filename);
    })();
  }
}
