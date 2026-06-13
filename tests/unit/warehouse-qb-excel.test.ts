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

// Yardi "Cash Flow Statement" export layout (verified against the real
// "P&L 2024 -- 1900 Broadway.xlsx", sheet Report1): A1 property name (no
// "Property:" prefix), Period=/Book= metadata lines, a 5-column body where
// B=Period-to-Date dollars, C=%, D=Year-to-Date dollars, E=%. The dollar
// value MUST come from the YTD dollars column — never the % columns.
type YardiRow = [string | null, number | string | null, number | string | null, number | string | null, number | string | null];

const YARDI_FIXTURE: YardiRow[] = [
  ['1900 North Broadway (eastgate)', null, null, null, null],
  ['Cash Flow Statement', null, null, null, null],
  ['Period = Jan 2024-Dec 2024', null, null, null, null],
  ['Book = Cash ; Tree = 8807cole', null, null, null, null],
  [null, ' Period to Date', '%', ' Year to Date', '%'],
  [' REVENUE', null, null, null, null],
  [' RENTAL REVENUE', null, null, null, null],
  ['    Rental Revenue', 479096.4, 68.17, 479096.4, 68.17],
  [' TOTAL RENTAL REVENUE', 480436.1, 68.36, 480436.1, 68.36],
  [' EXPENSE', null, null, null, null],
  ['    Insurance Expense', 12000, 1.71, 12000, 1.71],
  ['NET OPERATING INCOME', 300000, 42.7, 300000, 42.7],
];

async function buildYardiFixture(path: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Report1');
  for (const r of YARDI_FIXTURE) ws.addRow(r);
  await wb.xlsx.writeFile(path);
}

// AppFolio "Cash Flow" export layout (verified against the real
// "P&L 2025 -- 2203 -2207 Northwood.xlsx", sheet Sheet1): header text repeats
// across cols 1-5 (merged spans), r9 column headers include TWO "%" columns
// whose header text CONTAINS '%' but is not exactly '%' ("% of Selected Period",
// "% of Fiscal Year To Date"), sections are 4-space-indented words ("    Income"),
// leaves 8-space. Dollar values MUST come from "Fiscal Year To Date" (col 4) —
// never a %-containing column (col 5 would read Rent as 93).
type AfRow = Array<string | number | null>;

const AF_PROPERTIES = 'Properties: nbc-a - 2207 Nothwood Drive Bldg A Salisbury, MD 21801, nbc-b - 2205 Northwood Drive Bldg B Salisbury, MD 21801, nbc-c - 2203 Marvel Road Salisbury, MD 21801';

function rep5(text: string): AfRow {
  return [text, text, text, text, text];
}

function appfolioRows(dateRange: string): AfRow[] {
  return [
    rep5('Cash Flow'),
    rep5('Exported On: 06/12/2026 04:51 PM'),
    [null, null, null, null, null],
    rep5(AF_PROPERTIES),
    rep5('Display by Ownership %: No'),
    rep5(dateRange),
    rep5('Level of Detail: Detail View'),
    [null, null, null, null, null],
    ['Account Name', 'Selected Period', '% of Selected Period', 'Fiscal Year To Date', '% of Fiscal Year To Date'],
    ['Operating Income & Expense', null, null, null, null],
    ['    Income', null, null, null, null],
    ['        Rent', 479208.59, 93, 479208.59, 93],
    ['        CAM pass-thru', 17057.04, 3.31, 17057.04, 3.31],
    ['    Total Operating Income', 515253.29, 100, 515253.29, 100],
    ['    Expense', null, null, null, null],
    ['        Owner Transfer', 61171.04, 11.87, 61171.04, 11.87],
    ['        Interest Expense', 162474.41, 31.53, 162474.41, 31.53],
    ['    Total Operating Expense', 371767.05, 72.15, 371767.05, 72.15],
    ['    NOI - Net Operating Income', 143486.24, 27.85, 143486.24, 27.85],
    ['    Total Income', 515253.29, 100, 515253.29, 100],
    ['    Total Expense', 371767.05, 72.15, 371767.05, 72.15],
    ['    Net Income', 143486.24, 27.85, 143486.24, 27.85],
    ['    Other Items', null, null, null, null],
    ['        Operating Cash', 17526.66, null, 17526.66, null],
    ['        Owner deposit', 61171.04, null, 61171.04, null],
    ['        Owner Draw', -232820.9, null, -232820.9, null],
    ['    Net Other Items', -154123.2, null, -154123.2, null],
    ['Cash Flow', -10636.96, null, -10636.96, null],
    ['Beginning Cash', 21173.1, null, 21173.1, null],
    ['Beginning Cash + Cash Flow', 10536.14, null, 10536.14, null],
    ['Actual Ending Cash', 3646.44, null, 3646.44, null],
  ];
}

async function buildAppfolioFixture(path: string, dateRange: string): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  for (const r of appfolioRows(dateRange)) ws.addRow(r);
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
    // bare-TOTAL pattern: "TOTAL → INCOME 216461.4" row records the stated income total;
    // the default tail has no EXPENSE word row, so totalExpense stays null
    expect(s.totalIncome).toBeCloseTo(216461.4);
    expect(s.totalExpense).toBeNull();
    // per-section foot scope: leaf sums accumulate per section; the bare-TOTAL INCOME
    // value becomes a synthetic file-total section footed against the income-side
    // sections captured at the row's pass time. No EXPENSE word row → no expense synthetic.
    expect(s.sections).toEqual([
      { name: 'INCOME', leafSum: expect.closeTo(216461.4), statedTotal: null },
      { name: 'EXPENSE', leafSum: expect.closeTo(630.95), statedTotal: null },
      { name: 'NON OPERATING EXPENSE', leafSum: 25000, statedTotal: null },
      { name: 'INCOME (file total)', leafSum: expect.closeTo(216461.4), statedTotal: expect.closeTo(216461.4) },
    ]);
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
    // the skipped TOTAL→INCOME / TOTAL→EXPENSE value rows ARE the report's stated totals
    expect(s.totalIncome).toBeCloseTo(216461.4);
    expect(s.totalExpense).toBeCloseTo(25630.95);
    // footer bare-TOTAL EXPENSE (25630.95) is a FILE-level total: its synthetic section
    // snapshots the expense-side leaf sums at pass time — here AFTER both expense
    // sections, so 630.95 + 25000 (= the report's own arithmetic) → foots clean.
    expect(s.sections).toEqual([
      { name: 'INCOME', leafSum: expect.closeTo(216461.4), statedTotal: null },
      { name: 'EXPENSE', leafSum: expect.closeTo(630.95), statedTotal: null },
      { name: 'NON OPERATING EXPENSE', leafSum: 25000, statedTotal: null },
      { name: 'INCOME (file total)', leafSum: expect.closeTo(216461.4), statedTotal: expect.closeTo(216461.4) },
      { name: 'EXPENSE (file total)', leafSum: expect.closeTo(25630.95), statedTotal: expect.closeTo(25630.95) },
    ]);
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
      [null, null, '          Beginning Cash', 21173.1], // cash-position line — NOT a P&L account
      [null, null, '          Actual Ending Cash', 3646.44], // cash-position line — NOT a P&L account
    ];
    for (const r of rows) ws.addRow(r);
    const file = join(mkdtempSync(join(tmpdir(), 'wh-')), 'derived.xlsx');
    await wb.xlsx.writeFile(file);
    const s = await parseQbExcel(file);
    expect(s.accounts.map((a) => a.name)).toEqual(['HVAC Repair']);
  });

  it('reads DOLLAR columns (not %) from Yardi cash-flow exports via header-driven value-column selection', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'wh-')), 'yardi.xlsx');
    await buildYardiFixture(file);
    const s = await parseQbExcel(file);
    expect(s.propertyRaw).toBe('1900 North Broadway (eastgate)');
    expect(s.basis).toBe('cash');
    expect(s.periodStart).toBe('2024-01-01');
    expect(s.periodEnd).toBe('2024-12-31');
    expect(s.grain).toBe('year');
    expect(s.sourceSystem).toBe('yardi');
    const names = s.accounts.map((a) => a.name);
    expect(names).toEqual(['Rental Revenue', 'Insurance Expense']);
    expect(names.some((n) => /total|net operating income/i.test(n))).toBe(false);
    const rent = s.accounts[0]!;
    expect(rent.section).toBe('REVENUE');
    expect(rent.parent).toBe('RENTAL REVENUE');
    expect(rent.total).toBeCloseTo(479096.4); // dollars — NOT the trailing % column (68.17)
    const ins = s.accounts[1]!;
    expect(ins.section).toBe('EXPENSE');
    expect(ins.total).toBeCloseTo(12000); // dollars — NOT 1.71
    // only group subtotals exist ("TOTAL RENTAL REVENUE") — never a top-level stated
    // total form, so both stated totals stay null (no false capture from sub-groups)
    expect(s.totalIncome).toBeNull();
    expect(s.totalExpense).toBeNull();
    // no top-level Total rows → sections never close, stated totals stay null
    expect(s.sections).toEqual([
      { name: 'REVENUE', leafSum: expect.closeTo(479096.4), statedTotal: null },
      { name: 'EXPENSE', leafSum: 12000, statedTotal: null },
    ]);
  });

  it('closes a Yardi section at its TOTAL row: trailing rows stay in the ledger but not in the section foot scope', async () => {
    // 29000 Info Lane 2025 pattern: "TOTAL OPERATING EXPENSES" concludes the section,
    // then financing/capital rows follow under the SAME lingering section header. The
    // ledger keeps them (the seed classifies them out of NOI); the section's foot scope
    // must NOT — its leafSum closes at the Total row that stated 12000.
    const rows: YardiRow[] = [
      ['1900 North Broadway (eastgate)', null, null, null, null],
      ['Cash Flow Statement', null, null, null, null],
      ['Period = Jan 2024-Dec 2024', null, null, null, null],
      ['Book = Cash ; Tree = 8807cole', null, null, null, null],
      [null, ' Period to Date', '%', ' Year to Date', '%'],
      [' REVENUE', null, null, null, null],
      ['    Rental Revenue', 479096.4, 68.17, 479096.4, 68.17],
      [' OPERATING EXPENSES', null, null, null, null],
      ['    Insurance Expense', 12000, 1.71, 12000, 1.71],
      [' TOTAL OPERATING EXPENSES', 12000, 1.71, 12000, 1.71],
      ['    Mortgage Interest', -50000, -7.12, -50000, -7.12],
      ['NET OPERATING INCOME', 300000, 42.7, 300000, 42.7],
    ];
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Report1');
    for (const r of rows) ws.addRow(r);
    const file = join(mkdtempSync(join(tmpdir(), 'wh-')), 'yardi-close.xlsx');
    await wb.xlsx.writeFile(file);
    const s = await parseQbExcel(file);
    // ledger behavior unchanged: the trailing row IS an account under the lingering section
    const mortgage = s.accounts.find((a) => a.name === 'Mortgage Interest')!;
    expect(mortgage.section).toBe('OPERATING EXPENSES');
    expect(mortgage.total).toBeCloseTo(-50000);
    // but the section closed at its TOTAL row: leafSum 12000 (Insurance only), stated 12000
    expect(s.sections).toEqual([
      { name: 'REVENUE', leafSum: expect.closeTo(479096.4), statedTotal: null },
      { name: 'OPERATING EXPENSES', leafSum: 12000, statedTotal: 12000 },
    ]);
    expect(s.totalExpense).toBe(12000); // existing capture path untouched
  });

  it('captures Rent-Manager merged "TOTAL | EXPENSE | value" rows at pass time (section-scoped, first capture wins)', async () => {
    // Real Rarig/FVC/Westerville/9620 layout: each section is followed by a TOTAL block
    // whose value row carries BOTH the word TOTAL and the section word (merged cells);
    // the TOTAL header row may carry a stray % numeric (9620) and never arm the TOTAL
    // section state. The file then ends with a NET INCOME SUMMARY recap that restates
    // the same magnitudes with display signs. The per-section foot must use the FIRST
    // bare total per side with the side's leaf sums AT THAT ROW — Rarig's expense total
    // lands BEFORE NON OPERATING EXPENSE opens and covers the EXPENSE section only.
    const rows: Array<Array<string | number | null>> = [
      ['Profit & Loss', null, null, null],
      ['Property: 1100 Rarig Ave', null, null, null],
      ['01/01/24 - 12/31/24  (cash basis)', null, null, null],
      [null, 'INCOME', null, null],
      [null, null, '          5064 Rent', 100000],
      [null, 'TOTAL', null, 1], // stray % numeric on the TOTAL header — must NOT arm the TOTAL block
      // merged per-section closer (section state still INCOME) with a TRAILING 100%
      // numeric (9620's "% Income" column) — the stated value is the LEFTMOST numeric
      [null, 'TOTAL', 'INCOME', 100000, 1],
      [null, 'EXPENSE', null, null],
      [null, null, '          INSURANCE EXPENSE', -30000],
      [null, null, '          MANAGEMENT FEE EXPENSE', -10000],
      [null, null, '          Property Taxes', 5000],
      [null, 'TOTAL', null, null],
      [null, 'TOTAL', 'EXPENSE', -35000], // EXPENSE-scoped: passes before NON OPERATING EXPENSE opens
      [null, 'NON OPERATING EXPENSE', null, null],
      [null, null, '          7402 Distribution to Owner', 25000],
      [null, 'TOTAL', null, null],
      [null, 'TOTAL', 'NON OPERATING EXPENSE', 25000], // never feeds file totals (word ≠ INCOME/EXPENSE)
      [null, null, 'NET INCOME SUMMARY', null],
      [null, null, 'Income', 100000], // recap rows: last writer for totalIncome/totalExpense,
      [null, null, 'Expense', -35000], // but the file-total snapshot keeps the FIRST capture
      [null, null, 'Non Operating Expense', -25000],
      [null, null, 'NET INCOME', 40000],
    ];
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    for (const r of rows) ws.addRow(r);
    const file = join(mkdtempSync(join(tmpdir(), 'wh-')), 'rent-manager.xlsx');
    await wb.xlsx.writeFile(file);
    const s = await parseQbExcel(file);
    expect(s.accounts.map((a) => a.name)).toEqual(
      ['Rent', 'INSURANCE EXPENSE', 'MANAGEMENT FEE EXPENSE', 'Property Taxes', 'Distribution to Owner']);
    // totalIncome/totalExpense keep today's semantics: merged rows are skipped (first
    // text is TOTAL); the single-word summary recap rows record, last writer wins
    expect(s.totalIncome).toBe(100000);
    expect(s.totalExpense).toBe(-35000);
    expect(s.sections).toEqual([
      { name: 'INCOME', leafSum: 100000, statedTotal: null },
      { name: 'EXPENSE', leafSum: -35000, statedTotal: null },
      { name: 'NON OPERATING EXPENSE', leafSum: 25000, statedTotal: null },
      // income captured at the merged row (snapshot = INCOME section only)
      { name: 'INCOME (file total)', leafSum: 100000, statedTotal: 100000 },
      // expense captured at the merged row BEFORE NON OPERATING EXPENSE: scoped -35000,
      // |stated| = |leaves| even though the recap shows it negative
      { name: 'EXPENSE (file total)', leafSum: -35000, statedTotal: -35000 },
    ]);
  });

  it('closes a 9620-style negative-leaf section at its stated total row (parse space, signs preserved)', async () => {
    const rows: FixtureRow[] = [
      ['Cash Flow', null, null, null],
      ['Property: 350 Highway Center', null, null, null],
      ['01/01/25 - 12/31/25  (cash basis)', null, null, null],
      [null, 'EXPENSE', null, null],
      [null, null, '          INSURANCE EXPENSE', -30000],
      [null, null, '          MANAGEMENT FEE EXPENSE', -10000],
      [null, null, '          Property Taxes', 5000],
      [null, null, '          Total Expense', -35000],
    ];
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    for (const r of rows) ws.addRow(r);
    const file = join(mkdtempSync(join(tmpdir(), 'wh-')), 'neg-leaf.xlsx');
    await wb.xlsx.writeFile(file);
    const s = await parseQbExcel(file);
    expect(s.accounts.map((a) => a.total)).toEqual([-30000, -10000, 5000]);
    // leafSum stays in PARSE space (raw signs): -30000 - 10000 + 5000 = -35000 = stated
    expect(s.sections).toEqual([
      { name: 'EXPENSE', leafSum: -35000, statedTotal: -35000 },
    ]);
  });

  it('parses AppFolio Cash Flow exports: %-containing headers ineligible, Properties/Date Range headers, sections, derived rows skipped', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'wh-')), 'appfolio.xlsx');
    await buildAppfolioFixture(file, 'Date Range: 01/01/2025 to 12/31/2025 (Last Year)');
    const s = await parseQbExcel(file);
    expect(s.sourceSystem).toBe('appfolio');
    // propertyRaw comes from the "Properties:" line (no "Property:" line exists)
    expect(s.propertyRaw).toBe(AF_PROPERTIES.replace(/^Properties:\s*/, ''));
    expect(s.periodStart).toBe('2025-01-01');
    expect(s.periodEnd).toBe('2025-12-31');
    expect(s.grain).toBe('year');
    const names = s.accounts.map((a) => a.name);
    // derived totals / cash-position lines are never accounts
    for (const absent of ['Total Operating Income', 'Total Operating Expense', 'NOI - Net Operating Income',
      'Net Income', 'Net Other Items', 'Cash Flow', 'Beginning Cash', 'Beginning Cash + Cash Flow', 'Actual Ending Cash']) {
      expect(names).not.toContain(absent);
    }
    const byName = new Map(s.accounts.map((a) => [a.name, a]));
    // value column is "Fiscal Year To Date" (col 4) — NOT "% of Fiscal Year To Date" (col 5)
    expect(byName.get('Rent')!.total).toBeCloseTo(479208.59); // not 93 (the % column)
    expect(byName.get('Rent')!.section).toBe('INCOME');
    expect(byName.get('CAM pass-thru')!.total).toBeCloseTo(17057.04);
    expect(byName.get('CAM pass-thru')!.section).toBe('INCOME');
    // Owner Transfer IS parsed as an EXPENSE-section account — its NOI exclusion
    // happens via the seed mapping (classification 'excluded'), not the parser
    expect(byName.get('Owner Transfer')!.total).toBeCloseTo(61171.04);
    expect(byName.get('Owner Transfer')!.section).toBe('EXPENSE');
    expect(byName.get('Interest Expense')!.total).toBeCloseTo(162474.41);
    expect(byName.get('Interest Expense')!.section).toBe('EXPENSE');
    expect(byName.get('Owner Draw')!.section).toBe('OTHER ITEMS');
    expect(byName.get('Owner Draw')!.total).toBeCloseTo(-232820.9);
    // stated totals captured from the skipped "Total Operating Income" / "Total Operating
    // Expense" rows (the later "Total Income"/"Total Expense" rows carry the same values)
    expect(s.totalIncome).toBeCloseTo(515253.29);
    expect(s.totalExpense).toBeCloseTo(371767.05);
    // sections close at their "Total Operating ..." rows; the later duplicate
    // "Total Income"/"Total Expense" rows find them closed and re-attribute nothing.
    // (This fixture is a trimmed subset of the real export, so leafSum ≠ statedTotal
    // here — the parse layer RECORDS scope, the ingest layer judges mismatches.)
    // Other Items never states a total → never footable.
    expect(s.sections).toEqual([
      { name: 'INCOME', leafSum: expect.closeTo(496265.63), statedTotal: expect.closeTo(515253.29) },
      { name: 'EXPENSE', leafSum: expect.closeTo(223645.45), statedTotal: expect.closeTo(371767.05) },
      { name: 'OTHER ITEMS', leafSum: expect.closeTo(-154123.2), statedTotal: null },
    ]);
  });

  it('parses AppFolio YTD Date Range form to grain ytd', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'wh-')), 'appfolio-ytd.xlsx');
    await buildAppfolioFixture(file, 'Date Range: 01/01/2026 to 06/12/2026 (This Year-to-date)');
    const s = await parseQbExcel(file);
    expect(s.sourceSystem).toBe('appfolio');
    expect(s.periodStart).toBe('2026-01-01');
    expect(s.periodEnd).toBe('2026-06-12');
    expect(s.grain).toBe('ytd');
  });

  it('does not mistake merged-cell QB rows (label repeated across columns) for a header row', async () => {
    // Real QB exports repeat every label across its merged span — a subtotal row like
    // "5002 Total RENTAL INCOME" occupies 9 cells, each matching /total/i. That must NOT
    // trigger header-driven column selection (the repeated text is ONE logical cell).
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    const sub = '          5002 Total RENTAL INCOME';
    const rows: Array<Array<string | number | null>> = [
      ['Profit & Loss', 'Profit & Loss', 'Profit & Loss', null, null, null],
      ['Property: 1100 Rarig Ave', 'Property: 1100 Rarig Ave', null, null, null, null],
      ['01/01/24 - 12/31/24  (cash basis)', '01/01/24 - 12/31/24  (cash basis)', null, null, null, null],
      [null, null, null, null, 'Amount', 'Amount'],
      [null, 'INCOME', 'INCOME', 'INCOME', null, null],
      [null, null, '     5002 RENTAL INCOME', '     5002 RENTAL INCOME', null, null],
      [null, null, '          5064 Rent', '          5064 Rent', 214557.21, 214557.21],
      [null, null, sub, sub, 214557.21, 214557.21],
    ];
    for (const r of rows) ws.addRow(r);
    const file = join(mkdtempSync(join(tmpdir(), 'wh-')), 'merged.xlsx');
    await wb.xlsx.writeFile(file);
    const s = await parseQbExcel(file);
    expect(s.propertyRaw).toBe('1100 Rarig Ave');
    expect(s.sourceSystem).toBe('quickbooks');
    expect(s.accounts.map((a) => a.name)).toEqual(['Rent']);
    expect(s.accounts[0]!.total).toBeCloseTo(214557.21);
  });

  it('does not treat data rows below the first section as header rows (QB cash-flow "% Income" format)', async () => {
    // Real QB "Cash Flow" exports (9620 State 350) carry a "% Income" column of TEXT
    // percents ("92.83 %"). A subtotal row then holds a "Total ..." label AND a "% "
    // cell — two distinct header-vocabulary matches. Header rows precede data: the
    // pre-pass must stop scanning at the first section row.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    const rows: Array<Array<string | number | null>> = [
      ['Cash Flow', null, null, null, null, null],
      ['Property: 350 Highway Center', null, null, null, null, null],
      ['01/01/25 - 12/31/25  (cash basis)', null, null, null, null, null],
      [null, null, null, null, null, '% Income'],
      [null, 'INCOME', null, null, null, null],
      [null, null, '     4100 RENTAL PROPERTY INCOME', null, null, null],
      [null, null, '          4110 Rental Income', null, 171801.26, '92.83 %'],
      [null, null, '          4100 Total RENTAL PROPERTY INCOME', null, 171803.76, '92.83 %'],
    ];
    for (const r of rows) ws.addRow(r);
    const file = join(mkdtempSync(join(tmpdir(), 'wh-')), 'pct-income.xlsx');
    await wb.xlsx.writeFile(file);
    const s = await parseQbExcel(file);
    expect(s.propertyRaw).toBe('350 Highway Center');
    expect(s.sourceSystem).toBe('quickbooks');
    expect(s.accounts.map((a) => a.name)).toEqual(['Rental Income']);
    expect(s.accounts[0]!.total).toBeCloseTo(171801.26);
  });

  it('parses column-indented QB Desktop layouts (55 New Plant): no leading spaces, indentation by column', async () => {
    // Verified against the real "P&L 2024 -- 55 New Plant (EGFLLC).xlsx": every label is
    // an unindented cell; depth is encoded by COLUMN (B=section, C=leaf/group, D=sub-leaf,
    // E=value). The space/digit candidate rule finds ZERO accounts in this layout.
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('Sheet1');
    const rows: Array<Array<string | number | null>> = [
      [null, null, null, null, 'Jan - Dec 24'],
      [null, 'Income', null, null, null],
      [null, null, 'Rents', null, 425450.49],
      [null, null, 'Tax Refund', null, 1500],
      [null, 'Total Income', null, null, 426950.49],
      [null, 'Expense', null, null, null],
      [null, null, 'Amortization Expense', null, 17601],
      [null, null, 'Asset Management Fees', null, 17342.6],
      [null, null, 'Depreciation', null, 14529],
      [null, null, 'Insurance', null, 0],
      [null, null, 'Interest Expense', null, 58659.84],
      [null, null, 'Professional Fees', null, 3520],
      [null, null, 'REPAIR & MAINT--BLDG', null, 975],
      [null, null, 'Tax', null, null], // group header — no value; parent for the col-D leaves
      [null, null, null, 'Fed', 7000],
      [null, null, null, 'Property', 309],
      [null, null, null, 'State', 1500],
      [null, null, null, 'Tax - Other', 309],
      [null, null, 'Total Tax', null, 9118],
      [null, 'Total Expense', null, null, 121745.44],
      ['Net Income', null, null, null, 305205.05],
    ];
    for (const r of rows) ws.addRow(r);
    const file = join(mkdtempSync(join(tmpdir(), 'wh-')), 'col-indent.xlsx');
    await wb.xlsx.writeFile(file);
    const s = await parseQbExcel(file);
    expect(s.periodLabel).toBe('Jan - Dec 24');
    const byName = new Map(s.accounts.map((a) => [a.name, a]));
    expect(byName.get('Rents')!.total).toBeCloseTo(425450.49);
    expect(byName.get('Rents')!.section).toBe('INCOME');
    expect(byName.get('Tax Refund')!.total).toBeCloseTo(1500);
    expect(byName.get('Amortization Expense')!.total).toBeCloseTo(17601);
    expect(byName.get('Asset Management Fees')!.total).toBeCloseTo(17342.6);
    expect(byName.get('Depreciation')!.total).toBeCloseTo(14529);
    expect(byName.get('Insurance')!.total).toBe(0); // real file carries a numeric 0
    expect(byName.get('Interest Expense')!.total).toBeCloseTo(58659.84);
    expect(byName.get('Professional Fees')!.total).toBeCloseTo(3520);
    expect(byName.get('REPAIR & MAINT--BLDG')!.total).toBeCloseTo(975);
    // Tax sub-leaves (column D) get the most recent shallower-column group as parent
    for (const [name, total] of [['Fed', 7000], ['Property', 309], ['State', 1500], ['Tax - Other', 309]] as const) {
      const a = byName.get(name)!;
      expect(a.total).toBeCloseTo(total);
      expect(a.parent).toBe('Tax');
      expect(a.section).toBe('EXPENSE');
    }
    // expense leaves at the group's own column do NOT inherit a parent
    expect(byName.get('Insurance')!.parent).toBeNull();
    // subtotal / derived rows never become accounts
    const names = s.accounts.map((a) => a.name);
    expect(names.filter((n) => /^Total\b/i.test(n))).toEqual([]);
    expect(names).not.toContain('Net Income');
    expect(s.accounts).toHaveLength(13);
    // stated totals from the skipped top-level "Total Income"/"Total Expense" rows —
    // the sub-group "Total Tax" must NOT overwrite totalExpense
    expect(s.totalIncome).toBeCloseTo(426950.49);
    expect(s.totalExpense).toBeCloseTo(121745.44);
    // both sections close at their own Total rows and foot exactly; "Total Tax" closed nothing
    expect(s.sections).toEqual([
      { name: 'INCOME', leafSum: expect.closeTo(426950.49), statedTotal: expect.closeTo(426950.49) },
      { name: 'EXPENSE', leafSum: expect.closeTo(121745.44), statedTotal: expect.closeTo(121745.44) },
    ]);
  });

  it('selects the first worksheet that yields accounts (skips "QuickBooks Desktop Export Tips")', async () => {
    // Verified against the real "P&L 2024 -- 1851 South Club Solar.xlsm": sheet 0 is a
    // QB-generated tips sheet, the statement lives on Sheet1 — worksheets[0] parses empty.
    // Sheet1 replicates the real nested column-indented layout including the derived
    // "Gross Profit" / "Net Ordinary Income" / "Net Other Income" rows.
    const wb = new ExcelJS.Workbook();
    const tips = wb.addWorksheet('QuickBooks Desktop Export Tips');
    tips.addRow(['QuickBooks Desktop Export Tips']);
    tips.addRow(['This worksheet contains tips for working with your exported report.']);
    tips.addRow(['To update the data, run the report again in QuickBooks.']);
    const ws = wb.addWorksheet('Sheet1');
    const rows: Array<Array<string | number | null>> = [
      [null, null, null, null, null, null, 'Jan - Dec 24'],
      [null, 'Ordinary Income/Expense', null, null, null, null, null],
      [null, null, null, 'Income', null, null, null],
      [null, null, null, null, 'Electricity Income -- PS', null, 216214.47],
      [null, null, null, null, 'SREC Income', null, 452584],
      [null, null, null, 'Total Income', null, null, 668798.47],
      [null, null, 'Gross Profit', null, null, null, 668798.47],
      [null, null, null, 'Expense', null, null, null],
      [null, null, null, null, 'Bank Service Charges', null, null],
      [null, null, null, null, null, 'Wire Fee', 15],
      [null, null, null, null, null, 'Bank Service Charges - Other', 30],
      [null, null, null, null, 'Total Bank Service Charges', null, 45],
      [null, null, null, null, 'Insurance Expense', null, 17556.92],
      [null, null, null, null, 'Professional Fees', null, 3000],
      [null, null, null, null, 'Repairs and Maintenance', null, 17062.37],
      [null, null, null, null, 'Tax -- Personal Property', null, 309],
      [null, null, null, 'Total Expense', null, null, 37973.29],
      [null, 'Net Ordinary Income', null, null, null, null, 630825.18],
      [null, 'Other Income/Expense', null, null, null, null, null],
      [null, null, 'Other Expense', null, null, null, null],
      [null, null, null, 'Tax -- Md State', null, null, 36013],
      [null, null, 'Total Other Expense', null, null, null, 36013],
      [null, 'Net Other Income', null, null, null, null, -36013],
      ['Net Income', null, null, null, null, null, 594812.18],
    ];
    for (const r of rows) ws.addRow(r);
    const file = join(mkdtempSync(join(tmpdir(), 'wh-')), 'tips-first.xlsm');
    await wb.xlsx.writeFile(file);
    const s = await parseQbExcel(file);
    expect(s.periodLabel).toBe('Jan - Dec 24');
    expect(s.accounts.map((a) => a.name)).toEqual([
      'Electricity Income -- PS', 'SREC Income',
      'Wire Fee', 'Bank Service Charges - Other',
      'Insurance Expense', 'Professional Fees', 'Repairs and Maintenance', 'Tax -- Personal Property',
      'Tax -- Md State',
    ]);
    const byName = new Map(s.accounts.map((a) => [a.name, a]));
    expect(byName.get('Electricity Income -- PS')!.section).toBe('INCOME');
    expect(byName.get('Wire Fee')!.parent).toBe('Bank Service Charges');
    expect(byName.get('Insurance Expense')!.parent).toBeNull();
    expect(byName.get('Tax -- Md State')!.section).toBe('EXPENSE');
    expect(byName.get('Tax -- Md State')!.total).toBeCloseTo(36013);
    // 1851 Solar pattern: the stated "Total Expense" covers Ordinary Expense only; the
    // EXPENSE section closes there, so the trailing Other Expense leaf (Tax -- Md State,
    // 36013) stays in the LEDGER but out of the closed section's foot scope.
    expect(s.sections).toEqual([
      { name: 'INCOME', leafSum: expect.closeTo(668798.47), statedTotal: expect.closeTo(668798.47) },
      { name: 'EXPENSE', leafSum: expect.closeTo(37973.29), statedTotal: expect.closeTo(37973.29) },
    ]);
  });

  it('returns the first sheet\'s empty result when no worksheet yields accounts', async () => {
    const wb = new ExcelJS.Workbook();
    const tips = wb.addWorksheet('QuickBooks Desktop Export Tips');
    tips.addRow(['QuickBooks Desktop Export Tips']);
    tips.addRow(['No statement here.']);
    const file = join(mkdtempSync(join(tmpdir(), 'wh-')), 'tips-only.xlsx');
    await wb.xlsx.writeFile(file);
    const s = await parseQbExcel(file);
    expect(s.accounts).toEqual([]);
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
