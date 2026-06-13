// tests/unit/warehouse-queries.test.ts
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { getImportDetail, listImports, listIssues, noiMatrix } from '../../server/warehouse/queries';

// Local copy of the ingest-test fixture writer (tests never import across test files).
async function writeFixture(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    ['Property: 1100 Rarig Ave', null, null, null],
    ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    [null, null, '          5064 Rent', 100000],
    [null, 'EXPENSE', null, null],
    [null, null, '     6160 REPAIR', null],
    [null, null, '          6285 HVAC Repair', 5000],
    [null, 'NON OPERATING EXPENSE', null, null],
    [null, null, '          7402 Distribution to Owner', 25000],
  ];
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(path);
}

const SEED = [
  { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
  { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
  { account: 'Distribution to Owner', code: '7402', normalized_category: 'Distributions', classification: 'excluded' },
];

async function committedWarehouse(): Promise<{ db: WarehouseDb; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'whq-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED);
  const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
  await writeFixture(file);
  const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
  expect(r.status).toBe('committed');
  return { db, dir };
}

describe('warehouse read queries', () => {
  it('listImports: one committed import with property name, period, version, status', async () => {
    const { db } = await committedWarehouse();
    const imports = listImports(db);
    expect(imports).toHaveLength(1);
    expect(imports[0]).toMatchObject({
      fileName: 'P&L 2025 -- 1100 Rarig.xlsx',
      propertyId: '1100-rarig-ave-columbus-oh',
      propertyName: '1100 Rarig Ave, Columbus OH',
      status: 'committed',
      version: 1,
      period: '2025',
    });
    expect(imports[0]!.periodStart).toBe('2025-01-01');
    expect(imports[0]!.periodEnd).toBe('2025-12-31');
    expect(imports[0]!.importedAt).toBe('2026-06-12T00:00:00Z');
  });

  it('getImportDetail: batch + classified ledger rows + (empty) issue list; null for unknown id', async () => {
    const { db } = await committedWarehouse();
    const imports = listImports(db);
    const detail = getImportDetail(db, imports[0]!.id);
    expect(detail?.rows).toHaveLength(3);
    expect(detail?.rows.map((r) => r.classification).sort()).toEqual(['excluded', 'opex', 'revenue']);
    expect(detail?.rows.every((r) => r.isActive)).toBe(true);
    expect(detail?.issues).toEqual([]);
    expect(getImportDetail(db, 999999)).toBeNull();
  });

  it('listIssues: clean committed warehouse has zero open issues', async () => {
    const { db } = await committedWarehouse();
    const issues = listIssues(db);
    expect(issues).toEqual([]);
  });

  it('listIssues: pending import with unmapped accounts surfaces open issues joined to file + property', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whq-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED.slice(0, 1)); // only Rent mapped → unmapped-account issues
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(file);
    const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    expect(r.status).toBe('pending-review');

    const issues = listIssues(db);
    expect(issues.length).toBeGreaterThanOrEqual(2);
    for (const i of issues) {
      expect(i.status).toBe('open');
      expect(i.fileName).toBe('P&L 2025 -- 1100 Rarig.xlsx');
      expect(i.propertyName).toBe('1100 Rarig Ave, Columbus OH');
    }
    expect(issues.map((i) => i.kind)).toContain('unmapped-account');
    // resolved issues are filtered out by the default status='open'
    expect(listIssues(db, 'resolved')).toEqual([]);
  });

  it('noiMatrix: active-rows NOI by property and period, joined to property names', async () => {
    const { db } = await committedWarehouse();
    const matrix = noiMatrix(db);
    expect(matrix).toEqual([
      {
        propertyId: '1100-rarig-ave-columbus-oh',
        propertyName: '1100 Rarig Ave, Columbus OH',
        period: '2025',
        noi: 95000,
      },
    ]);
  });
});
