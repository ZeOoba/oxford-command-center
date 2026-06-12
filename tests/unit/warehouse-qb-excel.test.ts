// tests/unit/warehouse-qb-excel.test.ts
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseQbExcel } from '../../server/warehouse/parse/qb-excel';

async function buildFixture(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    ['Property: 1100 Rarig Ave', null, null, null],
    ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
    [null, null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    [null, null, '          5064 Rent', 214557.21],
    [null, null, '          5002 Total RENTAL INCOME', 214557.21],
    [null, null, '     5090 MISC INCOME', null],
    [null, null, '          5046 Miscellaneous', 1904.19],
    [null, null, '          5090 Total MISC INCOME', 1904.19],
    [null, 'TOTAL', null, null],
    [null, null, null, 216461.4],
    [null, 'EXPENSE', null, null],
    [null, null, '     6160 REPAIR', null],
    [null, null, '          6285 HVAC Repair', 630.95],
    [null, null, '          6160 Total REPAIR', 630.95],
    [null, 'NON OPERATING EXPENSE', null, null],
    [null, null, '          7402 Distribution to Owner', 25000],
    [null, 'TOTAL', null, null],
    [null, null, null, 25630.95],
  ];
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(path);
}

describe('qb-excel adapter', () => {
  it('extracts header, basis, leaf accounts (skipping subtotals), sections', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'wh-')), 'fixture.xlsx');
    await buildFixture(file);
    const s = await parseQbExcel(file);
    expect(s.propertyRaw).toBe('1100 Rarig Ave');
    expect(s.basis).toBe('cash');
    expect(s.periodStart).toBe('2025-01-01');
    expect(s.periodEnd).toBe('2025-12-31');
    expect(s.grain).toBe('year');
    const names = s.accounts.map((a) => a.name);
    expect(names).toEqual(['Rent', 'Miscellaneous', 'HVAC Repair', 'Distribution to Owner']);
    expect(names.some((n) => /Total/.test(n))).toBe(false);
    const rent = s.accounts[0]!;
    expect(rent.code).toBe('5064');
    expect(rent.section).toBe('INCOME');
    expect(rent.parent).toBe('RENTAL INCOME');
    expect(rent.total).toBeCloseTo(214557.21);
    const dist = s.accounts[3]!;
    expect(dist.section).toBe('NON OPERATING EXPENSE');
  });

  it('skips subtotal rows even when they carry a numeric amount', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    const rows: Array<[string | null, string | null, string | null, number | null]> = [
      ['Property: 1100 Rarig Ave', null, null, null],
      ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
      [null, 'INCOME', null, null],
      [null, null, '     5002 RENTAL INCOME', null],
      [null, null, '          5064 Rent', 1000],
      [null, null, '          5002 Total RENTAL INCOME', 1000],
    ];
    for (const r of rows) ws.addRow(r);
    const file = join(mkdtempSync(join(tmpdir(), 'wh-')), 'subtotal.xlsx');
    await wb.xlsx.writeFile(file);
    const s = await parseQbExcel(file);
    expect(s.accounts.map((a) => a.name)).toEqual(['Rent']);
    expect(s.accounts.some((a) => /Total/.test(a.name))).toBe(false);
  });

  it('parses text-formatted parenthesized amounts as negative numbers', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    ws.addRow(['Property: 1100 Rarig Ave', null, null, null]);
    ws.addRow(['01/01/25 - 12/31/25  (cash basis)', null, null, null]);
    ws.addRow([null, 'EXPENSE', null, null]);
    ws.addRow([null, null, '     6160 REPAIR', null]);
    ws.addRow([null, null, '          6285 HVAC Repair', '(98.81)']);
    const file = join(mkdtempSync(join(tmpdir(), 'wh-')), 'paren.xlsx');
    await wb.xlsx.writeFile(file);
    const s = await parseQbExcel(file);
    expect(s.accounts).toHaveLength(1);
    const hvac = s.accounts[0]!;
    expect(hvac.name).toBe('HVAC Repair');
    expect(hvac.total).toBeCloseTo(-98.81);
  });
});
