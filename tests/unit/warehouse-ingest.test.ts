// tests/unit/warehouse-ingest.test.ts
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';

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

describe('ingest pipeline', () => {
  it('commits a confident file: versioned import, classified ledger, NOI excludes distributions', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(file);

    const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    expect(r.status).toBe('committed');
    const ledger = db.prepare(
      "SELECT raw_account, classification, amount FROM ledger_entries WHERE is_active=1 ORDER BY raw_account",
    ).all() as Array<{ raw_account: string; classification: string; amount: number }>;
    expect(ledger).toHaveLength(3);

    // NOI from active NOI-class rows only: 100000 (revenue) - 5000 (opex) = 95000; distribution excluded
    const noi = db.prepare(`
      SELECT SUM(CASE WHEN classification IN ('revenue','recovery','other-income') THEN amount
                      WHEN classification = 'opex' THEN -amount ELSE 0 END) AS noi
      FROM ledger_entries WHERE is_active = 1 AND property_id = '1100-rarig-ave-columbus-oh' AND period = '2025'
    `).get() as { noi: number };
    expect(noi.noi).toBe(95000);
  });

  it('re-import of a corrected file supersedes prior ledger rows (rollback-able, never deleted)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(file);
    await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });

    // corrected file: different bytes (regenerate with one changed amount)
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(file);
    const ws = wb.worksheets[0]!;
    ws.getCell('D6').value = 110000; // Rent corrected
    await wb.xlsx.writeFile(file);

    const r2 = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T01:00:00Z' });
    expect(r2.status).toBe('committed');
    expect(r2.version).toBe(2);

    const active = db.prepare("SELECT COUNT(*) AS c FROM ledger_entries WHERE is_active=1").get() as { c: number };
    const inactive = db.prepare("SELECT COUNT(*) AS c FROM ledger_entries WHERE is_active=0").get() as { c: number };
    expect(active.c).toBe(3);
    expect(inactive.c).toBe(3); // v1 preserved, deactivated
    const v1 = db.prepare("SELECT status FROM import_batches WHERE version=1").get() as { status: string };
    expect(v1.status).toBe('superseded');
  });

  it('empty parse (zero valued accounts) is never auto-committed: pending-review + empty-parse DQ issue', async () => {
    // Regression: six real files (tips-sheet-first .xlsm + column-indented layouts)
    // parsed to ZERO accounts and were silently committed with no ledger rows.
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED);
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('QuickBooks Desktop Export Tips');
    ws.addRow(['QuickBooks Desktop Export Tips']);
    ws.addRow(['This worksheet contains tips for working with your exported report.']);
    await wb.xlsx.writeFile(file);

    const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    expect(r.status).toBe('pending-review');
    const batch = db.prepare('SELECT status FROM import_batches WHERE id = ?').get(r.importId) as { status: string };
    expect(batch.status).toBe('pending-review');
    expect((db.prepare('SELECT COUNT(*) AS c FROM ledger_entries').get() as { c: number }).c).toBe(0);
    const issues = db.prepare('SELECT kind, severity FROM data_quality_issues WHERE import_id = ?').all(r.importId) as Array<{ kind: string; severity: string }>;
    expect(issues.map((i) => i.kind)).toContain('empty-parse');
    expect(issues.find((i) => i.kind === 'empty-parse')!.severity).toBe('error');
  });

  it('unmapped accounts flag data quality and downgrade to pending-review', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-'));
    const db = openWarehouse(join(dir, 'f.sqlite'));
    seedPropertyMaster(db);
    seedMappings(db, SEED.slice(0, 1)); // only Rent mapped
    const file = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
    await writeFixture(file);
    const r = await ingestFile(db, file, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' });
    expect(r.status).toBe('pending-review');
    const issues = db.prepare("SELECT kind FROM data_quality_issues").all() as Array<{ kind: string }>;
    expect(issues.map((i) => i.kind)).toContain('unmapped-account');
  });
});
