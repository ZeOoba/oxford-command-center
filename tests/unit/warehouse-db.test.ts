// tests/unit/warehouse-db.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';

describe('warehouse db', () => {
  it('creates the schema idempotently and enforces unique file hashes', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'finance.sqlite'));
    const db2 = openWarehouse(join(dir, 'finance.sqlite')); // idempotent re-open
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        'account_mappings', 'data_quality_issues', 'import_batches',
        'ledger_entries', 'property_master',
      ]),
    );
    const ins = db.prepare(
      `INSERT INTO import_batches (file_name, file_hash, raw_path, imported_at, status, version)
       VALUES (?, ?, ?, ?, 'committed', 1)`,
    );
    ins.run('a.xlsx', 'hash1', '/raw/a', '2026-06-12T00:00:00Z');
    expect(() => ins.run('b.xlsx', 'hash1', '/raw/b', '2026-06-12T00:00:00Z')).toThrow(/UNIQUE/);
    db2.close();
    db.close();
  });

  it('opens in WAL mode with foreign keys enforced', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'finance.sqlite'));
    expect(String(db.pragma('journal_mode', { simple: true })).toLowerCase()).toBe('wal');
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    db.close();
  });

  // Root cause of "a live `npm run dev` blocks `npm run warehouse:backfill`": the dev server holds a
  // read-write singleton (server/index.ts) and writes occupancy on every refresh, so it and the backfill
  // are two writers on one WAL DB. With no explicit busy wait, the second writer throws SQLITE_BUSY the
  // instant their transactions overlap. A generous busy_timeout makes a writer wait out a peer's in-flight
  // (sub-second) transaction instead of dying — the connection must NOT rely on the driver default.
  it('sets a generous busy_timeout so concurrent writers wait instead of throwing SQLITE_BUSY', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'finance.sqlite'));
    expect(db.pragma('busy_timeout', { simple: true })).toBeGreaterThanOrEqual(15_000);
    db.close();
  });
});
