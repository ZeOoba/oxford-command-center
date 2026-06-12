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
});
