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
});
