import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { propertyPeriodMetrics } from '../../server/warehouse/metrics';
import { seedPropertyMaster } from '../../server/warehouse/property-master';

// Local copy of the ingest-test fixture writer (tests never import across test files).
// propertyLine varies the bytes so two property files never collide on content hash.
async function writeFixture(path: string, propertyLine = 'Property: 1100 Rarig Ave'): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    [propertyLine, null, null, null],
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

async function buildWarehouse(): Promise<{ db: WarehouseDb; dir: string }> {
  const dir = mkdtempSync(join(tmpdir(), 'whm-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED);
  // Rarig: 100% owned, rentable_sf 21000.
  const rarig = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
  await writeFixture(rarig);
  expect((await ingestFile(db, rarig, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' })).status).toBe('committed');
  // Red Branch: 50% owned. Distinct property line keeps the content hash distinct.
  const redBranch = join(dir, 'P&L 2025 -- 9050 Red Branch.xlsx');
  await writeFixture(redBranch, 'Property: 9050 Red Branch Rd');
  expect((await ingestFile(db, redBranch, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:01:00Z' })).status).toBe('committed');
  return { db, dir };
}

describe('propertyPeriodMetrics', () => {
  it('computes NOI, margin, $/SF, category subtotals, revenueCategories, ownership overlay (Rarig 100%)', async () => {
    const { db } = await buildWarehouse();
    const m = propertyPeriodMetrics(db);
    const rarig = m.find((x) => x.propertyId === '1100-rarig-ave-columbus-oh' && x.period === '2025')!;
    expect(rarig.revenue).toBe(100000);
    expect(rarig.opex).toBe(5000);
    expect(rarig.noi).toBe(95000);
    expect(rarig.noiMargin).toBeCloseTo(0.95, 6);
    expect(rarig.expenseRatio).toBeCloseTo(0.05, 6);
    expect(rarig.categories['Repairs & Maintenance']).toBe(5000);
    expect(rarig.revenueCategories['Rental Revenue']).toBe(100000);
    expect(rarig.noiPerSf).toBeCloseTo(95000 / 21000, 6);
    expect(rarig.revenuePerSf).toBeCloseTo(100000 / 21000, 6);
    expect(rarig.ownershipPct).toBe(1);
    expect(rarig.oxfordNoi).toBe(95000); // 100% owned
    // distribution excluded from everything
    expect(rarig.capex).toBe(0);
  });

  it('applies ownership overlay to oxfordNoi but keeps $/SF 100%-basis (Red Branch 50%)', async () => {
    const { db } = await buildWarehouse();
    const m = propertyPeriodMetrics(db);
    const rb = m.find((x) => x.propertyId === '9050-red-branch-rd-columbia-md' && x.period === '2025')!;
    expect(rb.ownershipPct).toBe(0.5);
    expect(rb.noi).toBe(95000); // 100%-basis NOI
    expect(rb.oxfordNoi).toBeCloseTo(95000 * 0.5, 6); // ownership overlay
    // $/SF stays 100%-basis (unchanged by ownership): rentable_sf 90000
    expect(rb.noiPerSf).toBeCloseTo(95000 / 90000, 6);
    expect(rb.revenuePerSf).toBeCloseTo(100000 / 90000, 6);
  });
});
