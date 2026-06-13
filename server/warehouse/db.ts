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
export function openWarehouse(path: string): WarehouseDb {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  // Baseline adoption is safe on a pre-existing DB: 001_initial.sql is all
  // `CREATE TABLE IF NOT EXISTS`, so it no-ops on existing tables and is then
  // recorded in _migrations as applied.
  runMigrations(db);
  return db;
}
