import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { propertyPeriodMetrics } from '../../server/warehouse/metrics';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { noiPrintRows } from '../../scripts/warehouse-backfill';

// Local fixture writer (tests never import across test files). propertyLine/periodLine vary the
// bytes so two property/period files never collide on content hash.
async function writeFixture(
  path: string,
  propertyLine = 'Property: 1100 Rarig Ave',
  periodLine = '01/01/25 - 12/31/25  (cash basis)',
  rent = 100000,
  repair = 5000,
): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    [propertyLine, null, null, null],
    [periodLine, null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    [null, null, '          5064 Rent', rent],
    [null, 'EXPENSE', null, null],
    [null, null, '     6160 REPAIR', null],
    [null, null, '          6285 HVAC Repair', repair],
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

describe('warehouse-backfill NOI print path (noiPrintRows)', () => {
  it('prints the COHERENT (full-year) NOI when a same-year YTD coexists — not the doubled sum (straggler M1)', async () => {
    // Defect M1: warehouse-backfill.ts (the production `warehouse:backfill` CLI) printed NOI via the
    // same raw GROUP BY (property, period) over ALL active rows that the H2 fix removed elsewhere. A
    // full-year (period_end 12-31) and a same-year YTD (06-30) share ledger period '2026' but differ on
    // period_end ⇒ neither supersedes the other and BOTH stay active. The raw GROUP BY SUMMED both ⇒
    // ~2x NOI overstatement printed to the operator. The CLI must print the coherent figure that
    // warehouse-verify.ts / the /noi API report — the single full-year batch, never the sum.
    const dir = mkdtempSync(join(tmpdir(), 'whbf-coexist-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const opts = { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' };

    // Full-year 2026: rent 100k / repair 5k → NOI 95k.
    const fy = join(dir, 'P&L 2026 -- 1100 Rarig.xlsx');
    await writeFixture(fy, 'Property: 1100 Rarig Ave', '01/01/26 - 12/31/26  (cash basis)', 100000, 5000);
    expect((await ingestFile(db, fy, opts)).status).toBe('committed');
    // YTD 2026 (Jan–Jun): rent 40k / repair 2k → NOI 38k. Different period_end ⇒ both active.
    const ytd = join(dir, 'P&L 2026 YTD -- 1100 Rarig.xlsx');
    await writeFixture(ytd, 'Property: 1100 Rarig Ave', '01/01/26 - 06/30/26  (accrual basis)', 40000, 2000);
    expect((await ingestFile(db, ytd, opts)).status).toBe('committed');

    const id = '1100-rarig-ave-columbus-oh';
    const rows2026 = noiPrintRows(db).filter((r) => r.property_id === id && r.period === '2026');
    // EXACTLY ONE coherent row for (rarig, 2026) — not two, not a merged sum.
    expect(rows2026.length).toBe(1);
    expect(rows2026[0]!.noi).toBe(95000); // full-year NOI — NOT 95000 + 38000 = 133000 (the double-count)

    // Parity with the coherent figure verify.ts / the /noi API serve.
    const m2026 = propertyPeriodMetrics(db).find((x) => x.propertyId === id && x.period === '2026')!;
    expect(rows2026[0]!.noi).toBeCloseTo(m2026.noi, 2);
  });

  it('print row shape is exactly { property_id, period, noi } — operator console.table contract unchanged', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'whbf-shape-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(file);
    expect((await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' })).status).toBe('committed');

    const rows = noiPrintRows(db);
    expect(rows.length).toBeGreaterThan(0);
    const cell = rows.find((r) => r.property_id === '1100-rarig-ave-columbus-oh' && r.period === '2025')!;
    expect(Object.keys(cell).sort()).toEqual(['noi', 'period', 'property_id']);
    expect(cell.noi).toBe(95000);
  });
});
