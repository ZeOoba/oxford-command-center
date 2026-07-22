// tests/unit/warehouse-property-master.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import { CANON_PROPERTIES, seedPropertyMaster } from '../../server/warehouse/property-master';

describe('property master seed', () => {
  it('seeds exactly the ratified 14 units, idempotently', () => {
    const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'wh-')), 'f.sqlite'));
    seedPropertyMaster(db);
    seedPropertyMaster(db); // idempotent
    const rows = db.prepare('SELECT * FROM property_master ORDER BY id').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(14);
    const byId = new Map(rows.map((r) => [r.id as string, r]));
    expect(byId.get('9050-red-branch-rd-columbia-md')?.ownership_pct).toBe(0.5);
    expect(byId.get('1851-s-club-solar')?.ownership_pct).toBe(0.25);
    expect(byId.get('401-sunburst-hwy-cambridge-md')?.financial_mode).toBe('lease-run');
    expect(byId.get('7658-fishel-dr-n-dublin-oh')?.financial_mode).toBe('lease-run');
    expect(byId.get('1100-rarig-ave-columbus-oh')?.property_manager).toBe('Kohr Royer Griffith');
    expect(byId.get('2203-2207-northwood-dr-salisbury-md')?.property_manager).toBe('SVN');
    expect(byId.has('9510-persimmon-tree-rd-potomac-md')).toBe(false); // residence excluded
    expect(CANON_PROPERTIES).toHaveLength(14);
  });

  it('does not bump updated_at on a reseed when no field actually changed', () => {
    const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'wh-')), 'f.sqlite'));
    seedPropertyMaster(db);
    const before = db.prepare('SELECT id, updated_at FROM property_master ORDER BY id')
      .all() as Array<{ id: string; updated_at: string }>;

    // Force every row's updated_at into the past so a real bump would be detectable,
    // then reseed with byte-for-byte identical CANON_PROPERTIES data.
    db.prepare("UPDATE property_master SET updated_at = '2000-01-01 00:00:00'").run();
    seedPropertyMaster(db);

    const after = db.prepare('SELECT id, updated_at FROM property_master ORDER BY id')
      .all() as Array<{ id: string; updated_at: string }>;
    expect(after).toHaveLength(before.length);
    for (const row of after) {
      expect(row.updated_at).toBe('2000-01-01 00:00:00');
    }
  });

  it('does bump updated_at when a field actually changed', () => {
    const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'wh-')), 'f.sqlite'));
    seedPropertyMaster(db);
    db.prepare("UPDATE property_master SET updated_at = '2000-01-01 00:00:00'").run();
    db.prepare("UPDATE property_master SET content_hash = 'stale-hash-forces-mismatch' WHERE id = '1100-rarig-ave-columbus-oh'").run();
    seedPropertyMaster(db);

    const row = db.prepare('SELECT updated_at FROM property_master WHERE id = ?')
      .get('1100-rarig-ave-columbus-oh') as { updated_at: string };
    expect(row.updated_at).not.toBe('2000-01-01 00:00:00');
  });

  it('bumps updated_at on the first reseed after migration, when content_hash is still NULL', () => {
    // Simulates a pre-existing row from before migration 024 added the column: content_hash
    // is genuinely NULL (not just a mismatched value), which is the exact transition the
    // upsert's `IS` (NULL-safe) comparison — rather than `=` — is meant to handle correctly.
    const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'wh-')), 'f.sqlite'));
    seedPropertyMaster(db);
    db.prepare("UPDATE property_master SET updated_at = '2000-01-01 00:00:00', content_hash = NULL").run();

    seedPropertyMaster(db);

    const rows = db.prepare('SELECT updated_at FROM property_master').all() as Array<{ updated_at: string }>;
    for (const row of rows) {
      expect(row.updated_at).not.toBe('2000-01-01 00:00:00');
    }
  });
});
