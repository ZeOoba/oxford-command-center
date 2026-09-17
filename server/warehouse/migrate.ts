// server/warehouse/migrate.ts
//
// Migration runner for the financial warehouse SQLite database.
// Applies numbered .sql files from the migrations/ directory in order,
// tracking which have been applied in a _migrations table.
//
// Usage: runMigrations(db) — called once in openWarehouse() before any other operation.
// Idempotent: already-applied migrations are skipped.
import { readdirSync, readFileSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Database } from 'better-sqlite3';

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Who is applying this migration. WAREHOUSE_ACTOR lets a scheduled task or CI name itself;
 *  otherwise the entry script plus pid, which is enough to tell a backup from a bake from a dev
 *  server. Recorded because an unattributed schema change on the live warehouse cost two sessions
 *  an investigation that ended in "unknown" (see migration 031). */
export function migrationActor(env: NodeJS.ProcessEnv = process.env): string {
  const tag = env.WAREHOUSE_ACTOR?.trim();
  if (tag) return tag;
  const entry = process.argv[1] ? basename(process.argv[1]) : 'unknown';
  return `${entry} pid=${process.pid}`;
}

function hasAppliedByColumn(db: Database): boolean {
  return (db.pragma('table_info(_migrations)') as Array<{ name: string }>).some(
    (c) => c.name === 'applied_by',
  );
}

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

  const actor = migrationActor();

  for (const filename of files) {
    if (applied.has(filename)) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, filename), 'utf8');

    // Apply the migration and record it in a single transaction. The column check is INSIDE the
    // loop and after exec() on purpose: migration 031 is the one that adds applied_by, so it must
    // be able to stamp itself. Before 031 the column does not exist and the insert omits it.
    db.transaction(() => {
      db.exec(sql);
      if (hasAppliedByColumn(db)) {
        db.prepare('INSERT INTO _migrations (filename, applied_by) VALUES (?, ?)').run(
          filename,
          actor,
        );
      } else {
        db.prepare('INSERT INTO _migrations (filename) VALUES (?)').run(filename);
      }
    })();
  }
}
