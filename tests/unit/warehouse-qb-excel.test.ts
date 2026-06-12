// tests/unit/warehouse-qb-excel.test.ts
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseQbExcel } from '../../server/warehouse/parse/qb-excel';

type FixtureRow = [string | null, string | null, string | null, number | null];

const FIXTURE_BODY: FixtureRow[] = [
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
  [null, null, 'INCOME', 216461.4], // real "TOTAL → INCOME 216461.4" value row — NOT a section header
  [null, 'EXPENSE', null, null],
  [null, null, '     6160 REPAIR', null],
  [null, null, '          6285 HVAC Repair', 630.95],
  [null, null, '          6160 Total REPAIR', 630.95],
  [null, 'NON OPERATING EXPENSE', null, null],
  [null, null, '          7402 Distribution to Owner', 25000],
  [null, null, '105647.91', null], // numeric-only TEXT label under a live (non-TOTAL) section — must be skipped
];

const FIXTURE_TOTAL_TAIL: FixtureRow[] = [
  [null, 'TOTAL', null, null],
  [null, null, null, 25630.95],
];

// Real-world report footer (observed in actual QB P&L exports): summary lines that
// repeat the section word WITH an amount, NOI / NET INCOME metric rows, and a
// pure-numeric label cell. None of these may become accounts or re-arm a section.
const REPORT_FOOTER_TAIL: FixtureRow[] = [
  [null, 'TOTAL', null, null],
  [null, null, null, 25630.95], // summary total row (already suppressed by TOTAL section)
  [null, null, null, null],
  [null, null, 'INCOME', 216461.4], // section word + amount on SAME row — must NOT re-arm section
  [null, null, 'EXPENSE', 25630.95], // same
  [null, null, 'NOI - Net Operating Income', 190830.45], // footer metric row — must be skipped
  [null, null, 'NET INCOME', 190830.45], // footer metric row — must be skipped
  [null, null, '1', 190830.45], // pure-numeric label cell — must be skipped
];

async function buildFixture(path: string, tail: FixtureRow[] = FIXTURE_TOTAL_TAIL): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const r of [...FIXTURE_BODY, ...tail]) ws.addRow(r);
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

  it('ignores summary rows: total-value rows, footer metrics, numeric-only labels', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'wh-')), 'footer.xlsx');
    await buildFixture(file, REPORT_FOOTER_TAIL);
    const s = await parseQbExcel(file);
    const names = s.accounts.map((a) => a.name);
    expect(names).toEqual(['Rent', 'Miscellaneous', 'HVAC Repair', 'Distribution to Owner']);
    expect(names.some((n) => /^[\d.]+$/.test(n))).toBe(false);
    // the INCOME/EXPENSE total-value rows must not re-arm section state mid- or post-report
    expect(s.accounts.find((a) => a.name === 'HVAC Repair')!.section).toBe('EXPENSE');
    expect(s.accounts.find((a) => a.name === 'Distribution to Owner')!.section).toBe('NON OPERATING EXPENSE');
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

  it('keeps digit-leading alpha account names intact (code only when digits + whitespace)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    const rows: FixtureRow[] = [
      ['Property: 1100 Rarig Ave', null, null, null],
      ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
      [null, 'INCOME', null, null],
      [null, null, '     5002 RENTAL INCOME', null],
      [null, null, '          5064 Rent', 214557.21],
      [null, 'NON OPERATING EXPENSE', null, null],
      [null, null, '          1st Mortgage Note Payable', 5000],
      [null, null, '          1st Mortgage Interest', 1200],
    ];
    for (const r of rows) ws.addRow(r);
    const file = join(mkdtempSync(join(tmpdir(), 'wh-')), 'digit-name.xlsx');
    await wb.xlsx.writeFile(file);
    const s = await parseQbExcel(file);
    const names = s.accounts.map((a) => a.name);
    expect(names).toEqual(['Rent', '1st Mortgage Note Payable', '1st Mortgage Interest']);
    const note = s.accounts.find((a) => a.name === '1st Mortgage Note Payable')!;
    expect(note.code).toBeNull();
    expect(note.total).toBeCloseTo(5000);
    const interest = s.accounts.find((a) => a.name === '1st Mortgage Interest')!;
    expect(interest.code).toBeNull();
    expect(interest.total).toBeCloseTo(1200);
    const rent = s.accounts.find((a) => a.name === 'Rent')!;
    expect(rent.code).toBe('5064');
  });

  it('skips derived-summary rows with alpha names (NET OPERATING INCOME, CASH FLOW)', async () => {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    const rows: FixtureRow[] = [
      ['Property: 1100 Rarig Ave', null, null, null],
      ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
      [null, 'EXPENSE', null, null],
      [null, null, '     6160 REPAIR', null],
      [null, null, '          6285 HVAC Repair', 630.95],
      [null, null, '          NET OPERATING INCOME', 190830.45], // derived total — NOT an account
      [null, null, '          CASH FLOW', 165830.45], // derived total — NOT an account
    ];
    for (const r of rows) ws.addRow(r);
    const file = join(mkdtempSync(join(tmpdir(), 'wh-')), 'derived.xlsx');
    await wb.xlsx.writeFile(file);
    const s = await parseQbExcel(file);
    expect(s.accounts.map((a) => a.name)).toEqual(['HVAC Repair']);
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
