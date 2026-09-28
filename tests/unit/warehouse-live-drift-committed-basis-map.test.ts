// @vitest-environment node
//
// tests/unit/warehouse-live-drift-committed-basis-map.test.ts
//
// Characterizes committedBasisMap (server/warehouse/live-drift.ts), the SQL that feeds the
// warehouse:drift gate step. If it silently returned the wrong rows the gate could pass green while
// comparing garbage (cc-audit-army 2026-09-28, committed-basis-map-sql-untested). Tests only; no
// production change. Tmpdir warehouse: never touches data/warehouse/finance.sqlite.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { committedBasisMap } from '../../server/warehouse/live-drift';

function freshDb(): WarehouseDb {
  return openWarehouse(join(mkdtempSync(join(tmpdir(), 'drift-basis-')), 'test.sqlite'));
}

function insertBatch(
  db: WarehouseDb,
  o: { hash: string; name: string; status: string; basis: string; version?: number },
): void {
  db.prepare(
    `INSERT INTO import_batches (file_name, file_hash, raw_path, imported_at, basis, version, status)
     VALUES (?, ?, 'raw/x', '2026-09-28T00:00:00Z', ?, ?, ?)`,
  ).run(o.name, o.hash, o.basis, o.version ?? 1, o.status);
}

describe('committedBasisMap', () => {
  it('returns an empty map for an empty warehouse', () => {
    expect(committedBasisMap(freshDb()).size).toBe(0);
  });

  it('includes ONLY committed batches (not superseded, pending-review or rejected)', () => {
    const db = freshDb();
    insertBatch(db, { hash: 'h-committed', name: 'a.xlsx', status: 'committed', basis: 'cash' });
    insertBatch(db, { hash: 'h-superseded', name: 'b.xlsx', status: 'superseded', basis: 'cash' });
    insertBatch(db, { hash: 'h-pending', name: 'c.xlsx', status: 'pending-review', basis: 'accrual' });
    insertBatch(db, { hash: 'h-rejected', name: 'd.xlsx', status: 'rejected', basis: 'accrual' });
    expect([...committedBasisMap(db).keys()]).toEqual(['h-committed']);
  });

  it('carries basis and fileName through, keyed by file_hash', () => {
    const db = freshDb();
    insertBatch(db, { hash: 'h1', name: 'P&L 2025 -- 1100 Rarig.xlsx', status: 'committed', basis: 'accrual' });
    expect(committedBasisMap(db).get('h1')).toEqual({ basis: 'accrual', fileName: 'P&L 2025 -- 1100 Rarig.xlsx' });
  });

  it("coalesces an empty-string basis to 'unknown' (basis is NOT NULL, so '' is the only empty form)", () => {
    const db = freshDb();
    insertBatch(db, { hash: 'h-empty', name: 'e.xlsx', status: 'committed', basis: '' });
    insertBatch(db, { hash: 'h-cash', name: 'f.xlsx', status: 'committed', basis: 'cash' });
    const m = committedBasisMap(db);
    expect(m.get('h-empty')?.basis).toBe('unknown');
    expect(m.get('h-cash')?.basis).toBe('cash');
  });

  it('a literal unknown basis stays unknown', () => {
    const db = freshDb();
    insertBatch(db, { hash: 'h-unk', name: 'g.xlsx', status: 'committed', basis: 'unknown' });
    expect(committedBasisMap(db).get('h-unk')?.basis).toBe('unknown');
  });

  it('two committed rows sharing a file_name but with different hashes do NOT collide', () => {
    const db = freshDb();
    insertBatch(db, { hash: 'h-v1', name: 'same.xlsx', status: 'committed', basis: 'cash', version: 1 });
    insertBatch(db, { hash: 'h-v2', name: 'same.xlsx', status: 'committed', basis: 'accrual', version: 2 });
    const m = committedBasisMap(db);
    expect(m.size).toBe(2);
    expect(m.get('h-v1')?.basis).toBe('cash');
    expect(m.get('h-v2')?.basis).toBe('accrual');
  });
});
