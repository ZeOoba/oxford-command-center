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

  // CONTRACT CHANGE 2026-07-24 (M1). This case used to force a hash mismatch and assert a bump,
  // under the name "a field actually changed" — but it never changed a field. That conflation is
  // exactly the defect: the hash was treated as a proxy for the row's state while being writable
  // independently of it. updated_at now tracks the COLUMNS, so a corrupt/stale fingerprint alone
  // is not an edit. The real "a field actually changed" case is covered below.
  it('a stale content_hash alone does NOT bump updated_at (the hash is no longer authoritative)', () => {
    const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'wh-')), 'f.sqlite'));
    seedPropertyMaster(db);
    db.prepare("UPDATE property_master SET updated_at = '2000-01-01 00:00:00'").run();
    db.prepare("UPDATE property_master SET content_hash = 'stale-hash-forces-mismatch' WHERE id = '1100-rarig-ave-columbus-oh'").run();
    seedPropertyMaster(db);

    const row = db.prepare('SELECT updated_at, content_hash FROM property_master WHERE id = ?')
      .get('1100-rarig-ave-columbus-oh') as { updated_at: string; content_hash: string };
    expect(row.updated_at).toBe('2000-01-01 00:00:00');
    // The fingerprint is repaired back to the true value even though it was not the gate.
    expect(row.content_hash).not.toBe('stale-hash-forces-mismatch');
  });

  it('backfilling a NULL content_hash is NOT an edit — updated_at stays put', () => {
    // A pre-existing row from before migration 024 added the column. Under the old hash-based
    // gate this produced a one-time mass bump across EVERY row — the migration masquerading as
    // an edit to the whole table. Comparing columns instead makes the backfill correctly silent.
    const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'wh-')), 'f.sqlite'));
    seedPropertyMaster(db);
    db.prepare("UPDATE property_master SET updated_at = '2000-01-01 00:00:00', content_hash = NULL").run();

    seedPropertyMaster(db);

    const rows = db.prepare('SELECT updated_at, content_hash FROM property_master')
      .all() as Array<{ updated_at: string; content_hash: string | null }>;
    for (const row of rows) {
      expect(row.updated_at).toBe('2000-01-01 00:00:00');
      expect(row.content_hash).not.toBeNull();
    }
  });

  // M1 (2026-07-24 integrity sweep): the gate compared the STORED content_hash against the
  // INCOMING hash. An out-of-band write (manual SQL fix, or property-onboarding.ts, which
  // inserts without a hash) leaves content_hash stale relative to the row's real columns —
  // so on the next seed the hashes still matched, updated_at was KEPT, and yet the SET clause
  // actively reverted the drifted column back to canon. A real persisted change with no
  // timestamp bump: the exact inverse of what migration 024 set out to fix.
  it('an out-of-band column edit that the reseed reverts DOES bump updated_at', () => {
    const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'wh-')), 'f.sqlite'));
    seedPropertyMaster(db);

    const target = CANON_PROPERTIES[0]!.id;
    // Drift one column WITHOUT touching content_hash — exactly what a manual fix does.
    db.prepare("UPDATE property_master SET pm_contact = 'corrected@example.com', updated_at = '2000-01-01 00:00:00' WHERE id = ?")
      .run(target);

    seedPropertyMaster(db);

    const row = db.prepare('SELECT pm_contact, updated_at FROM property_master WHERE id = ?')
      .get(target) as { pm_contact: string | null; updated_at: string };
    // The reseed reverts the column back to canon …
    expect(row.pm_contact).not.toBe('corrected@example.com');
    // … so it MUST be recorded as an edit.
    expect(row.updated_at).not.toBe('2000-01-01 00:00:00');
  });

  it('a genuine no-op reseed still leaves updated_at untouched', () => {
    const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'wh-')), 'f.sqlite'));
    seedPropertyMaster(db);
    seedPropertyMaster(db); // settle content_hash for every row
    db.prepare("UPDATE property_master SET updated_at = '2000-01-01 00:00:00'").run();

    seedPropertyMaster(db);

    const rows = db.prepare('SELECT updated_at FROM property_master').all() as Array<{ updated_at: string }>;
    for (const row of rows) {
      expect(row.updated_at).toBe('2000-01-01 00:00:00');
    }
  });
});
