// server/warehouse/db.ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { pendingMigrations, runMigrations } from './migrate';

export type WarehouseDb = Database.Database;

// Schema is no longer defined inline. The single source of truth is
// server/warehouse/migrations/*.sql, applied in order by runMigrations().
// This removes the silent-drift hazard of `CREATE TABLE IF NOT EXISTS`:
// a column added inline here would never reach an already-created DB, so two
// agents could diverge undetected. Migrations make every schema change an
// explicit, ordered, recorded step. See architecture/database-schema.md.
// Multi-process write coordination. The dev server (server/index.ts) holds a read-write
// connection for its whole lifetime and writes occupancy on every brain refresh, while
// `npm run warehouse:backfill` opens the SAME WAL DB read-write and ingests every file.
// Two writers on one WAL DB serialize, but with no explicit busy wait the loser of an
// overlapping write throws `SQLITE_BUSY: database is locked` immediately — which is what
// made a live dev server appear to "block" the backfill (better-sqlite3's own default is
// only 5s). Wait out a peer's in-flight (sub-second) transaction instead of dying; every
// connection opened via openWarehouse (server, backfill, tests, the read-only drift check)
// inherits this. Tunable via WAREHOUSE_BUSY_TIMEOUT_MS for unusually long ingests.
const BUSY_TIMEOUT_MS = Number(process.env.WAREHOUSE_BUSY_TIMEOUT_MS) || 15_000;

/**
 * Read-only handle on an EXISTING warehouse. Use this from any script that only reads.
 *
 * Why this exists: openWarehouse() below runs pending migrations as a side effect. A script that
 * merely reads the live warehouse therefore writes its branch's schema into it — and because
 * runMigrations tracks migrations by FILENAME with no checksum, that database is thereafter
 * recorded as having applied the file and will never receive later edits to it. The corruption is
 * silent and not fixed by re-running.
 *
 * Unlike openWarehouse this does not mkdir or create the file: opening a path that does not exist
 * throws (SQLITE_CANTOPEN) rather than silently producing an empty database, which is the correct
 * behaviour for a reader. Proven pattern — scripts/warehouse-live-drift-check.ts has opened the
 * live DB this way since the drift check shipped.
 */
export function openWarehouseReadOnly(path: string): WarehouseDb {
  const db = new Database(path, { readonly: true });
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  return db;
}

/**
 * Read-WRITE handle on an EXISTING, CURRENT warehouse that will NOT apply migrations.
 *
 * For scripts that legitimately write (a CLI ingest, the crosswalk seeder) but must never be the
 * thing that changes the schema of the live warehouse. openWarehouse() migrates as a side effect, so
 * a writer run from a feature branch applied that branch's unmerged migration to the live database
 * and recorded it by filename — after which later edits to the file never applied (the 2026-09-17
 * incident: the unattended bake migrated live to 030/031 this way). Here a database that is behind
 * this code is a hard error, not a silent upgrade: the dev server on main (server/index.ts) is the
 * sanctioned migrator.
 *
 * Like openWarehouseReadOnly it does not mkdir or create the file.
 */
export function openWarehouseNoMigrate(path: string): WarehouseDb {
  const db = new Database(path, { fileMustExist: true });
  try {
    db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
    // Decide BEFORE any write-ish pragma: `journal_mode = WAL` rewrites the file header (and creates
    // -wal/-shm sidecars) on a DELETE-journal database, so setting it first meant a handle that
    // refuses to open still changed the file. A refusal must leave the database untouched.
    const pending = pendingMigrations(db);
    if (pending.length > 0) {
      throw new Error(
        `warehouse at ${path} is ${pending.length} migration(s) behind this code ` +
          `(${pending.join(', ')}) — refusing to apply them from a script. Start the dev server on ` +
          `main (or run npm run warehouse:backfill) to migrate it deliberately.`,
      );
    }
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    return db;
  } catch (err) {
    db.close();
    throw err;
  }
}

export function openWarehouse(path: string): WarehouseDb {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  // Set the busy timeout BEFORE the journal-mode switch so even that pragma waits if a peer
  // momentarily holds the file lock.
  db.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Baseline adoption is safe on a pre-existing DB: 001_initial.sql is all
  // `CREATE TABLE IF NOT EXISTS`, so it no-ops on existing tables and is then
  // recorded in _migrations as applied.
  runMigrations(db);
  return db;
}
