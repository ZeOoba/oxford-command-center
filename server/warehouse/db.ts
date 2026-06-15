// server/warehouse/db.ts
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { runMigrations } from './migrate';

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
