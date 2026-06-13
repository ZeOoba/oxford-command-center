// tests/unit/warehouse-raw-store.test.ts
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import { registerImport, sha256File } from '../../server/warehouse/raw-store';

describe('raw store + versioning', () => {
  it('copies bytes immutably, dedups by hash, versions by (property, period)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    db.prepare("INSERT INTO property_master (id, name) VALUES ('p1', 'P1')").run(); // FK parent (foreign_keys=ON)
    const rawDir = join(dir, 'raw');
    const src = join(dir, 'P&L 2025 -- X.xlsx');
    writeFileSync(src, 'v1-bytes');

    const a = registerImport(db, { sourcePath: src, rawDir, propertyId: 'p1', periodStart: '2025-01-01', periodEnd: '2025-12-31', grain: 'year', basis: 'cash', sourceSystem: 'quickbooks', confidence: 0.95, importedAt: '2026-06-12T00:00:00Z' });
    expect(a.kind).toBe('new');
    if (a.kind !== 'new') throw new Error('expected new');
    expect(a.version).toBe(1);
    expect(readFileSync(a.rawPath, 'utf8')).toBe('v1-bytes');

    // exact duplicate bytes → rejected as duplicate
    const dup = registerImport(db, { sourcePath: src, rawDir, propertyId: 'p1', periodStart: '2025-01-01', periodEnd: '2025-12-31', grain: 'year', basis: 'cash', sourceSystem: 'quickbooks', confidence: 0.95, importedAt: '2026-06-12T01:00:00Z' });
    expect(dup.kind).toBe('duplicate');

    // corrected file, same logical period → version 2; v1 stays on disk and in the table
    writeFileSync(src, 'v2-bytes');
    const b = registerImport(db, { sourcePath: src, rawDir, propertyId: 'p1', periodStart: '2025-01-01', periodEnd: '2025-12-31', grain: 'year', basis: 'cash', sourceSystem: 'quickbooks', confidence: 0.95, importedAt: '2026-06-12T02:00:00Z' });
    if (b.kind !== 'new') throw new Error('expected new');
    expect(b.version).toBe(2);
    const rows = db.prepare('SELECT id, version, status FROM import_batches ORDER BY id').all();
    expect(rows).toHaveLength(2);
    expect(sha256File(src)).toHaveLength(64);
  });
});
