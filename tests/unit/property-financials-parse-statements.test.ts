// @vitest-environment node
//
// tests/unit/property-financials-parse-statements.test.ts — T9b part 1: statement files -> raw
// records in the exact shape the T9a normalizer consumes ([entity, period, layout, section, group,
// account, amount, isTotal]). The parsers are pure (a SheetSource is rows of cells), so every layout
// is proven here on synthetic sheets; tests/unit/property-financials-parse-sources.test.ts runs the
// same parsers against the real OneDrive exports when they are present.
import { describe, expect, it } from 'vitest';
import {
  detectLayout,
  monthFromLabel,
  parseAppFolioPl,
  parseCashFlow12,
  parseQuickBooks,
  parseRecap12,
  parseStatement,
  periodFromDateline,
  periodFromMonthRange,
  StatementParseError,
  type CellValue,
  type SheetSource,
} from '@analytics/property-financials/parse-statements';
import type { RawRecord } from '@analytics/property-financials/normalize';

type Row = Record<string, CellValue>;

/** Build a sheet from sparse rows keyed by column letter: [{ B: 'INCOME' }, {}, { C: '  5064 Rent', L: 9 }]. */
function sheet(rows: readonly Row[], opts: { file?: string; sheet?: string } = {}): SheetSource {
  const col = (k: string): number => {
    let n = 0;
    for (const ch of k) n = n * 26 + (ch.charCodeAt(0) - 64);
    return n;
  };
  const width = Math.max(1, ...rows.flatMap((r) => Object.keys(r).map(col)));
  return {
    file: opts.file ?? 'synthetic.xlsx',
    sheet: opts.sheet ?? 'Sheet1',
    rows: rows.map((r) => {
      const out: CellValue[] = Array.from({ length: width }, () => null);
      for (const [k, v] of Object.entries(r)) out[col(k) - 1] = v;
      return out;
    }),
  };
}

const rec = (entity: string, period: string, layout: string, section: string | null, group: string | null, account: string, amount: number, isTotal = false): RawRecord => ({
  entity,
  period,
  layout,
  section,
  group,
  account,
  amount,
  isTotal,
});

const nonTotals = (rs: readonly RawRecord[]) => rs.filter((r) => !r.isTotal);

// -------------------------------------------------------------------------------------------------
// Period helpers
// -------------------------------------------------------------------------------------------------

describe('period helpers', () => {
  it('derives a month, a fiscal year or a YTD label from an AppFolio dateline', () => {
    expect(periodFromDateline('10/01/23 - 10/31/23  (cash basis)')).toBe('2023-10');
    expect(periodFromDateline('02/01/24 - 02/29/24  (cash basis)')).toBe('2024-02');
    expect(periodFromDateline('01/01/24 - 12/31/24  (cash basis)')).toBe('2024-FY');
    expect(periodFromDateline('01/01/26 - 09/30/26  (cash basis)')).toBe('2026-YTD(thru 2026-09-30)');
  });

  it('refuses a window that is neither a whole month, a whole year nor Jan-1-anchored', () => {
    expect(() => periodFromDateline('02/01/24 - 02/28/24')).toThrow(/whole month/);
    expect(() => periodFromDateline('03/15/24 - 04/14/24')).toThrow(/whole month/);
    expect(() => periodFromDateline('no dates here')).toThrow(/dateline/);
  });

  it('reads Yardi / recap month labels', () => {
    expect(monthFromLabel('Oct 2025')).toBe('2025-10');
    expect(monthFromLabel('SEP 24')).toBe('2024-09');
    expect(monthFromLabel('Total')).toBeNull();
    expect(monthFromLabel(' Period to Date')).toBeNull();
  });

  it('reads a Yardi "Period = ..." range', () => {
    expect(periodFromMonthRange('Period = Sep 2025')).toEqual({ kind: 'month', period: '2025-09' });
    expect(periodFromMonthRange('Period = Jan 2024-Dec 2024')).toEqual({ kind: 'range', period: '2024-FY', months: 12 });
    expect(periodFromMonthRange('Period = Jan 2026-Sep 2026')).toEqual({ kind: 'range', period: '2026-YTD(thru 2026-09-30)', months: 9 });
    expect(periodFromMonthRange('Period = Oct 2025-Sep 2026')).toEqual({ kind: 'range', period: null, months: 12 });
    expect(() => periodFromMonthRange('Book = Cash')).toThrow(/Period =/);
  });
});

// -------------------------------------------------------------------------------------------------
// Layout 1 — AppFolio consolidated P&L (amount column L)
// -------------------------------------------------------------------------------------------------

const AF_ROWS: Row[] = [
  { A: 'Profit & Loss' },
  { A: 'Property: 1100 Rarig Ave' },
  { A: '10/01/23 - 10/31/23  (cash basis)' },
  { A: 'Period Adjustments Excluded' },
  { L: 'Amount', M: 'Amount' },
  {},
  { B: 'INCOME' },
  { C: '     4700 Unallocated Prepays', L: 968 },
  { C: '     5002 RENTAL INCOME' },
  { C: '          5064 Rent', L: 9855 },
  { C: '          5002 Total RENTAL INCOME', L: 9855 },
  { C: '     5019 SECURITY DEPOSIT ACTIVITY' },
  { C: '          5070 Security Deposit', L: -2415 },
  { C: '          5019 Total SECURITY DEPOSIT ACTIVITY', L: -2415 },
  { B: 'TOTAL', D: 'INCOME', L: 8408 },
  { B: 'EXPENSE' },
  { C: '     6160 REPAIR' },
  { C: '          6240 Door Repair', L: 141 },
  { C: '          6320 Misc Repair', L: 1508.25 },
  { C: '          6160 Total REPAIR', L: 1649.25 },
  { B: 'TOTAL', D: 'EXPENSE', L: 1649.25 },
  {},
  { B: 'NOI', L: 6758.75 },
  { B: 'N/O EXPENSE' },
  { C: '     7400 DEBT' },
  { C: '          7402 Distribution to Owner', L: 5000 },
  { C: '          7400 Total DEBT', L: 5000 },
  { B: 'TOTAL', D: 'N/O EXPENSE', L: 5000 },
  { B: 'NET INCOME', L: 1758.75 },
  {},
  { E: 'NET INCOME SUMMARY' },
  { F: 'Income', J: 8408 },
  { F: 'Expense', J: -1649.25 },
  { F: 'NET INCOME', J: 1758.75 },
];

describe('layout AF — AppFolio consolidated P&L', () => {
  it('emits one record per account (codes stripped, group kept with its code, null group before the first group) and the section totals as isTotal', () => {
    const out = parseAppFolioPl(sheet(AF_ROWS), '1100 Rarig');
    expect(out.periods).toEqual(['2023-10']);
    expect(nonTotals(out.records)).toEqual([
      rec('1100 Rarig', '2023-10', 'AF', 'INCOME', null, 'Unallocated Prepays', 968),
      rec('1100 Rarig', '2023-10', 'AF', 'INCOME', '5002 RENTAL INCOME', 'Rent', 9855),
      rec('1100 Rarig', '2023-10', 'AF', 'INCOME', '5019 SECURITY DEPOSIT ACTIVITY', 'Security Deposit', -2415),
      rec('1100 Rarig', '2023-10', 'AF', 'EXPENSE', '6160 REPAIR', 'Door Repair', 141),
      rec('1100 Rarig', '2023-10', 'AF', 'EXPENSE', '6160 REPAIR', 'Misc Repair', 1508.25),
      rec('1100 Rarig', '2023-10', 'AF', 'NON OPERATING EXPENSE', '7400 DEBT', 'Distribution to Owner', 5000),
    ]);
    const totals = out.records.filter((r) => r.isTotal).map((r) => [r.section, r.group, r.account, r.amount]);
    expect(totals).toContainEqual(['INCOME', '5019 SECURITY DEPOSIT ACTIVITY', 'INCOME', 8408]);
    expect(totals).toContainEqual(['EXPENSE', '6160 REPAIR', 'NOI', 6758.75]);
    expect(totals).toContainEqual(['NON OPERATING EXPENSE', '7400 DEBT', 'NET INCOME', 1758.75]);
    // the summary block (columns E/F/J) is never read as accounts
    expect(out.records.some((r) => r.account === 'Income' || r.account === 'Expense')).toBe(false);
    expect(out.totalChecks).toBeGreaterThanOrEqual(5);
  });

  it('a group-level line that carries an amount is an account under the current group', () => {
    const rows = AF_ROWS.map((r) => ({ ...r }));
    rows.splice(14, 0, { C: '     5080 MISC', L: 10 }); // after the deposit group, before TOTAL INCOME
    rows[14 + 1] = { B: 'TOTAL', D: 'INCOME', L: 8418 };
    const out = parseAppFolioPl(sheet(rows), 'X');
    expect(nonTotals(out.records)).toContainEqual(rec('X', '2023-10', 'AF', 'INCOME', '5019 SECURITY DEPOSIT ACTIVITY', 'MISC', 10));
  });

  it('fails naming file, sheet and row when a stated section total does not equal the sum of its accounts', () => {
    const rows = AF_ROWS.map((r) => ({ ...r }));
    rows[14] = { B: 'TOTAL', D: 'INCOME', L: 8409 };
    expect(() => parseAppFolioPl(sheet(rows, { file: 'Rarig/ProfitLoss_1.xlsx', sheet: 'Sheet1' }), 'X')).toThrow(StatementParseError);
    try {
      parseAppFolioPl(sheet(rows, { file: 'Rarig/ProfitLoss_1.xlsx', sheet: 'Sheet1' }), 'X');
    } catch (e) {
      const err = e as StatementParseError;
      expect(err.file).toBe('Rarig/ProfitLoss_1.xlsx');
      expect(err.sheet).toBe('Sheet1');
      expect(err.row).toBe(15);
      expect(err.message).toMatch(/Rarig\/ProfitLoss_1\.xlsx/);
      expect(err.message).toMatch(/row 15/);
      expect(err.message).toMatch(/8409/);
    }
  });

  it('fails on a group total that does not tie, and on a missing Amount header', () => {
    const rows = AF_ROWS.map((r) => ({ ...r }));
    rows[19] = { C: '          6160 Total REPAIR', L: 1649 };
    expect(() => parseAppFolioPl(sheet(rows), 'X')).toThrow(/row 20/);
    const rows2 = AF_ROWS.map((r) => ({ ...r }));
    rows2[4] = { L: 'Total' };
    expect(() => parseAppFolioPl(sheet(rows2), 'X')).toThrow(/Amount/);
  });

  it('a whole-year dateline yields a YYYY-FY period, and the annual export\'s two-row TOTAL (bare "TOTAL", then TOTAL + section + amount) is read once', () => {
    const rows = AF_ROWS.map((r) => ({ ...r }));
    rows[2] = { A: '01/01/24 - 12/31/24  (cash basis)' };
    rows.splice(14, 0, { B: 'TOTAL', C: 'TOTAL' });
    const out = parseAppFolioPl(sheet(rows), 'X');
    expect(out.periods).toEqual(['2024-FY']);
    expect(out.records.filter((r) => r.isTotal && r.account === 'INCOME')).toHaveLength(1);
  });

  it('a merged label replicated across columns (B..J = "INCOME") is still one section header, and TOTAL rows find their section past the replicated "TOTAL"', () => {
    const rows = AF_ROWS.map((r) => ({ ...r }));
    rows[6] = { B: 'INCOME', C: 'INCOME', D: 'INCOME' };
    rows[14] = { B: 'TOTAL', C: 'TOTAL', D: 'INCOME', E: 'INCOME', L: 8408 };
    const out = parseAppFolioPl(sheet(rows), 'X');
    expect(nonTotals(out.records)[0]).toEqual(rec('X', '2023-10', 'AF', 'INCOME', null, 'Unallocated Prepays', 968));
    expect(out.records.filter((r) => r.isTotal && r.account === 'INCOME' && r.amount === 8408)).toHaveLength(1);
  });
});

// -------------------------------------------------------------------------------------------------
// Layout 2 — 12-month cash flow statement (Yardi)
// -------------------------------------------------------------------------------------------------

const CF_ROWS: Row[] = [
  { A: '1900 North Broadway (eastgate)' },
  { A: 'Statement (12 months)' },
  { A: 'Period = Oct 2025-Sep 2026' },
  { A: 'Book = Cash ; Tree = 8807cole' },
  { B: 'Oct 2025', C: 'Nov 2025', D: 'Dec 2025', E: 'Jan 2026', F: 'Feb 2026', G: 'Mar 2026', H: 'Apr 2026', I: 'May 2026', J: 'Jun 2026', K: 'Jul 2026', L: 'Aug 2026', M: 'Sep 2026', N: 'Total' },
  {},
  { A: ' REVENUE' },
  {},
  { A: ' RENTAL REVENUE' },
  { A: '    Rental Revenue', B: 100, C: 100, D: 100, E: 100, F: 100, G: 100, H: 100, I: 100, J: 100, K: 100, L: 100, M: 110, N: 1210 },
  { A: '    Commercial Rental Waiver', B: 0, C: 0, D: 0, E: 0, F: 0, G: 0, H: 0, I: 0, J: 0, K: 0, L: -14, M: 0, N: -14 },
  { A: ' TOTAL RENTAL REVENUE', B: 100, C: 100, D: 100, E: 100, F: 100, G: 100, H: 100, I: 100, J: 100, K: 100, L: 86, M: 110, N: 1196 },
  { A: ' TOTAL REVENUE', B: 100, C: 100, D: 100, E: 100, F: 100, G: 100, H: 100, I: 100, J: 100, K: 100, L: 86, M: 110, N: 1196 },
  {},
  { A: ' OPERATING EXPENSES' },
  {},
  { A: ' MAINTENANCE EXPENSES' },
  { A: '    HVAC Repair', B: 0, C: 5, D: 0, E: 0, F: 0, G: 0, H: 0, I: 0, J: 0, K: 0, L: 0, M: 0, N: 5 },
  { A: ' TOTAL MAINTENANCE EXPENSES', B: 0, C: 5, D: 0, E: 0, F: 0, G: 0, H: 0, I: 0, J: 0, K: 0, L: 0, M: 0, N: 5 },
  {},
  { A: ' TAXES and RESERVES' },
  { A: '    Real Estate Taxes', B: 0, C: 0, D: 0, E: 0, F: 0, G: 0, H: 0, I: 0, J: 0, K: 0, L: 0, M: 30, N: 30 },
  { A: ' TOTAL TAXES and RESERVES', B: 0, C: 0, D: 0, E: 0, F: 0, G: 0, H: 0, I: 0, J: 0, K: 0, L: 0, M: 30, N: 30 },
  { A: ' TOTAL OPERATING EXPENSES', B: 0, C: 5, D: 0, E: 0, F: 0, G: 0, H: 0, I: 0, J: 0, K: 0, L: 0, M: 30, N: 35 },
  {},
  { A: ' NET OPERATING INCOME', B: 100, C: 95, D: 100, E: 100, F: 100, G: 100, H: 100, I: 100, J: 100, K: 100, L: 86, M: 80, N: 1161 },
  {},
  // Info Lane style: a 4-space ALL-CAPS group header (no numbers) with 6-space accounts
  { A: '    OWNER ACTIVITY' },
  { A: '      Owners Draw', B: 0, C: 0, D: 0, E: 0, F: 0, G: 0, H: 0, I: 0, J: 0, K: 0, L: 0, M: 50, N: 50 },
  { A: ' TOTAL OWNER ACTIVITY', B: 0, C: 0, D: 0, E: 0, F: 0, G: 0, H: 0, I: 0, J: 0, K: 0, L: 0, M: 50, N: 50 },
  { A: ' INCOME AFTER OWNER ACTIVITY', B: 100, C: 95, D: 100, E: 100, F: 100, G: 100, H: 100, I: 100, J: 100, K: 100, L: 86, M: 30, N: 1111 },
  // Yardi indents these two closing lines like accounts; they are computed lines, not accounts.
  { A: '    TOTAL ADJUSTMENTS', B: 0, C: 0, D: 0, E: 0, F: 0, G: 0, H: 0, I: 0, J: 0, K: 0, L: 0, M: 0, N: 0 },
  { A: '    CASH FLOW', B: 100, C: 95, D: 100, E: 100, F: 100, G: 100, H: 100, I: 100, J: 100, K: 100, L: 86, M: 30, N: 1111 },
];

describe('layout CF — 12-month cash flow statement', () => {
  it('emits one record per account per month column (zeros kept), with the enclosing ALL-CAPS header as the group and no section', () => {
    const out = parseCashFlow12(sheet(CF_ROWS), '1900 Broadway');
    expect(out.periods).toHaveLength(12);
    expect(out.periods[0]).toBe('2025-10');
    expect(out.periods[11]).toBe('2026-09');
    const rows = nonTotals(out.records);
    expect(rows).toHaveLength(5 * 12);
    expect(rows.filter((r) => r.period === '2026-08')).toEqual([
      rec('1900 Broadway', '2026-08', 'CF', null, 'RENTAL REVENUE', 'Rental Revenue', 100),
      rec('1900 Broadway', '2026-08', 'CF', null, 'RENTAL REVENUE', 'Commercial Rental Waiver', -14),
      rec('1900 Broadway', '2026-08', 'CF', null, 'MAINTENANCE EXPENSES', 'HVAC Repair', 0),
      rec('1900 Broadway', '2026-08', 'CF', null, 'MAINTENANCE EXPENSES', 'Real Estate Taxes', 0),
      rec('1900 Broadway', '2026-08', 'CF', null, 'OWNER ACTIVITY', 'Owners Draw', 0),
    ]);
    // the mixed-case "TAXES and RESERVES" header is NOT a group (the reference parser only promoted
    // ALL-CAPS headers), so Real Estate Taxes stays under MAINTENANCE EXPENSES — the v1 mapping
    // (CF-MAINT-RE-TAX) depends on exactly this.
    expect(out.ignoredHeaders).toEqual(['TAXES and RESERVES']);
    const totals = out.records.filter((r) => r.isTotal && r.period === '2026-09').map((r) => [r.group, r.account, r.amount]);
    expect(totals).toContainEqual(['RENTAL REVENUE', 'TOTAL RENTAL REVENUE', 110]);
    expect(totals).toContainEqual(['MAINTENANCE EXPENSES', 'NET OPERATING INCOME', 80]);
    expect(totals).toContainEqual(['OWNER ACTIVITY', 'CASH FLOW', 30]);
    expect(totals).toContainEqual(['OWNER ACTIVITY', 'TOTAL ADJUSTMENTS', 0]);
    expect(totals).toContainEqual(['OWNER ACTIVITY', 'INCOME AFTER OWNER ACTIVITY', 30]);
    expect(rows.some((r) => r.account === 'CASH FLOW' || r.account === 'TOTAL ADJUSTMENTS')).toBe(false);
  });

  it('a blank month on a total line is a zero total (Yardi prints nothing for a month with no postings)', () => {
    const rows = CF_ROWS.map((r) => ({ ...r }));
    delete rows[17]!.B; // HVAC Repair Oct 2025 blank -> 0
    delete rows[18]!.B; // TOTAL MAINTENANCE EXPENSES Oct 2025 blank -> 0, ties
    expect(() => parseCashFlow12(sheet(rows), 'X')).not.toThrow();
  });

  it('the Total column is never a period; an empty month cell is 0', () => {
    const rows = CF_ROWS.map((r) => ({ ...r }));
    delete rows[9]!.C; // Rental Revenue Nov 2025 blank
    rows[11] = { ...rows[11], C: 0 };
    rows[12] = { ...rows[12], C: 0 };
    const out = parseCashFlow12(sheet(rows), 'X');
    expect(out.periods).not.toContain('Total');
    expect(nonTotals(out.records).find((r) => r.period === '2025-11' && r.account === 'Rental Revenue')?.amount).toBe(0);
  });

  it('a single-month statement (no month header row) takes its period from the Period line and its values from column B', () => {
    const rows: Row[] = [
      { A: '1900 North Broadway (eastgate)' },
      { A: 'Statement (12 months)' },
      { A: 'Period = Sep 2025' },
      { A: 'Book = Cash ; Tree = 8807cole' },
      {},
      {},
      { A: ' RENTAL REVENUE' },
      { A: '    Rental Revenue', B: 40879.8, C: 40879.8 },
      { A: ' TOTAL RENTAL REVENUE', B: 40879.8, C: 40879.8 },
    ];
    const out = parseCashFlow12(sheet(rows), 'X');
    expect(out.periods).toEqual(['2025-09']);
    expect(nonTotals(out.records)).toEqual([rec('X', '2025-09', 'CF', null, 'RENTAL REVENUE', 'Rental Revenue', 40879.8)]);
  });

  it('an annual "Cash Flow Statement" (Period to Date column) yields one YYYY-FY period from column B', () => {
    const rows: Row[] = [
      { A: '1900 North Broadway (eastgate)' },
      { A: 'Cash Flow Statement' },
      { A: 'Period = Jan 2024-Dec 2024' },
      { A: 'Book = Cash ; Tree = 8807cole' },
      { B: ' Period to Date', C: '%', D: ' Year to Date', E: '%' },
      {},
      { A: ' RENTAL REVENUE' },
      { A: '    Rental Revenue', B: 479096.4, C: 68.17, D: 479096.4, E: 68.17 },
      { A: ' TOTAL RENTAL REVENUE', B: 479096.4, C: 68.36, D: 479096.4, E: 68.36 },
    ];
    const out = parseCashFlow12(sheet(rows), 'X');
    expect(out.periods).toEqual(['2024-FY']);
    expect(nonTotals(out.records)).toEqual([rec('X', '2024-FY', 'CF', null, 'RENTAL REVENUE', 'Rental Revenue', 479096.4)]);
  });

  it('fails naming the row when a group total does not tie in some month', () => {
    const rows = CF_ROWS.map((r) => ({ ...r }));
    rows[11] = { ...rows[11], G: 101 };
    expect(() => parseCashFlow12(sheet(rows, { file: 'f.xlsx', sheet: 'Report1' }), 'X')).toThrow(/f\.xlsx › Report1 › row 12/);
    expect(() => parseCashFlow12(sheet(rows), 'X')).toThrow(/2026-03/);
  });

  it('an export that says "No activity for given filter criteria" is an EMPTY statement, reported as such (not a failure, not a silent skip)', () => {
    const rows: Row[] = [...CF_ROWS.slice(0, 5), { A: 'No activity for given filter criteria' }];
    const out = parseCashFlow12(sheet(rows), 'X');
    expect(out.records).toEqual([]);
    expect(out.periods).toHaveLength(12);
    expect(out.emptyReason).toBe('No activity for given filter criteria');
    expect(parseCashFlow12(sheet(CF_ROWS), 'X').emptyReason).toBeNull();
  });

  it('refuses a sheet whose Period line or month labels are missing', () => {
    const rows = CF_ROWS.map((r) => ({ ...r }));
    rows[2] = { A: 'nothing' };
    expect(() => parseCashFlow12(sheet(rows), 'X')).toThrow(/Period =/);
  });
});

// -------------------------------------------------------------------------------------------------
// Layout 3 — 9620 State 350 12-month recap (expenses positive, nested sections, column gaps)
// -------------------------------------------------------------------------------------------------

const A12_ROWS: Row[] = [
  { B: 'Profit & Loss 12 Month Recap' },
  { B: 'Property: 350 Highway Center' },
  { B: 'Monthly recap 10/01/25 - 09/30/26  (cash basis)' },
  { B: 'Period Adjustments Excluded' },
  { E: 'OCT 25', F: 'NOV 25', H: 'DEC 25', I: 'JAN 26', J: 'FEB 26', K: 'MAR 26', L: 'APR 26', M: 'MAY 26', N: 'JUN 26', P: 'JUL 26', Q: 'AUG 26', R: 'SEP 26', S: 'TOTAL' },
  { A: 'INCOME' },
  { B: '    4100 RENTAL PROPERTY INCOME' },
  { B: '        4110 Rental Income', E: 10, I: 20, R: 25, S: 55 },
  { B: '        4117 NSF Fees', E: 2.5, F: 0, S: 2.5 },
  { B: '        4100 Total RENTAL PROPERTY INCOME', E: 12.5, F: 0, I: 20, R: 25, S: 57.5 },
  { B: '    4800 Security Deposit Forfeitures', E: 0, Q: 1800, R: 0, S: 1800 },
  { A: 'TOTAL', C: 'INCOME', E: 12.5, I: 20, Q: 1800, R: 25, S: 1857.5 },
  { A: 'EXPENSE' },
  { B: '    5500 CAM EXPENSES' },
  { B: '        5115 CAM - Grounds', E: 305, R: 400, S: 705 },
  { B: '        5500 Total CAM EXPENSES', E: 305, R: 400, S: 705 },
  { B: '    5000 MANAGEMENT FEE EXPENSE', E: -50, F: 1200, L: 1250, S: 2400 },
  { A: 'TOTAL', C: 'EXPENSE', E: 255, F: 1200, L: 1250, R: 400, S: 3105 },
  {},
  { A: 'NOI', E: -242.5, F: -1200, I: 20, L: -1250, Q: 1800, R: -375, S: -1247.5 },
  { A: 'N/O EXPENSE' },
  { B: '    5060 Legal & Professional Fees' },
  { B: '        5062 Legal Fees', E: 755, S: 755 },
  { B: '        5060 Total Legal & Professional Fees', E: 755, S: 755 },
  { B: '    6252 Vacant Utilities', E: 87.18, F: 0, S: 87.18 },
  { A: 'TOTAL', C: 'N/O EXPENSE', E: 842.18, S: 842.18 },
  { A: 'NET INCOME', E: -1084.68, S: -2089.68 },
  {},
  { A: 'NET INCOME SUMMARY' },
  { B: 'Income', E: 12.5, S: 1857.5 },
  { B: 'Expense', E: -255, S: -3105 },
];

describe('layout A12 — 12-month recap', () => {
  it('reads the month columns from row 5 (gaps and TOTAL skipped), nested sections (N/O EXPENSE normalised) and group-level accounts', () => {
    const out = parseRecap12(sheet(A12_ROWS), '9620 State 350');
    expect(out.periods).toEqual(['2025-10', '2025-11', '2025-12', '2026-01', '2026-02', '2026-03', '2026-04', '2026-05', '2026-06', '2026-07', '2026-08', '2026-09']);
    const rows = nonTotals(out.records);
    expect(rows).toHaveLength(7 * 12);
    const sep = rows.filter((r) => r.period === '2026-09');
    expect(sep).toEqual([
      rec('9620 State 350', '2026-09', 'A12', 'INCOME', '4100 RENTAL PROPERTY INCOME', 'Rental Income', 25),
      rec('9620 State 350', '2026-09', 'A12', 'INCOME', '4100 RENTAL PROPERTY INCOME', 'NSF Fees', 0),
      rec('9620 State 350', '2026-09', 'A12', 'INCOME', '4100 RENTAL PROPERTY INCOME', 'Security Deposit Forfeitures', 0),
      rec('9620 State 350', '2026-09', 'A12', 'EXPENSE', '5500 CAM EXPENSES', 'CAM - Grounds', 400),
      rec('9620 State 350', '2026-09', 'A12', 'EXPENSE', '5500 CAM EXPENSES', 'MANAGEMENT FEE EXPENSE', 0),
      rec('9620 State 350', '2026-09', 'A12', 'NON OPERATING EXPENSE', '5060 Legal & Professional Fees', 'Legal Fees', 0),
      rec('9620 State 350', '2026-09', 'A12', 'NON OPERATING EXPENSE', '5060 Legal & Professional Fees', 'Vacant Utilities', 0),
    ]);
    const totals = out.records.filter((r) => r.isTotal && r.period === '2025-10').map((r) => [r.section, r.account, r.amount]);
    expect(totals).toContainEqual(['INCOME', 'INCOME', 12.5]);
    expect(totals).toContainEqual(['NON OPERATING EXPENSE', 'N/O EXPENSE', 842.18]);
    expect(totals).toContainEqual(['NON OPERATING EXPENSE', 'NET INCOME', -1084.68]);
    expect(out.records.some((r) => r.account === 'Income' || r.account === 'Expense')).toBe(false);
  });

  it('a merged month header replicated into two columns (N:O = "JUN 26") is read once, from the first column', () => {
    const rows = A12_ROWS.map((r) => ({ ...r }));
    rows[4] = { ...rows[4], O: 'JUN 26' };
    rows[7] = { ...rows[7], N: 7, O: 7 };
    rows[9] = { ...rows[9], N: 7, O: 7 };
    rows[11] = { ...rows[11], N: 7, O: 7 };
    const out = parseRecap12(sheet(rows), 'X');
    expect(out.periods.filter((p) => p === '2026-06')).toHaveLength(1);
    expect(nonTotals(out.records).filter((r) => r.period === '2026-06' && r.account === 'Rental Income')).toEqual([rec('X', '2026-06', 'A12', 'INCOME', '4100 RENTAL PROPERTY INCOME', 'Rental Income', 7)]);
  });

  it('a recap printed without section headers yields null sections (the 2025-09 single-month recap)', () => {
    const rows: Row[] = [
      { B: 'Profit & Loss 12 Month Recap' },
      { B: 'Property: 350 Highway Center' },
      { B: 'Monthly recap 09/01/25 - 09/30/25  (cash basis)' },
      { B: 'Period Adjustments Excluded' },
      { E: 'SEP 25', S: 'TOTAL' },
      { B: '    4100 RENTAL PROPERTY INCOME' },
      { B: '        4110 Rental Income', E: 16222.02, S: 16222.02 },
      { A: 'TOTAL', C: 'INCOME', E: 16222.02, S: 16222.02 },
      { B: '    5500 CAM EXPENSES' },
      { B: '        5115 CAM - Grounds', E: 580, S: 580 },
      { B: '    5100 REPAIRS & MAINTENANCE', E: 729.24, S: 729.24 },
      { A: 'TOTAL', C: 'EXPENSE', E: 1309.24, S: 1309.24 },
    ];
    const out = parseRecap12(sheet(rows), 'X');
    expect(nonTotals(out.records)).toEqual([
      rec('X', '2025-09', 'A12', null, '4100 RENTAL PROPERTY INCOME', 'Rental Income', 16222.02),
      rec('X', '2025-09', 'A12', null, '5500 CAM EXPENSES', 'CAM - Grounds', 580),
      rec('X', '2025-09', 'A12', null, '5500 CAM EXPENSES', 'REPAIRS & MAINTENANCE', 729.24),
    ]);
  });

  it('fails naming the row and month when a section total does not tie', () => {
    const rows = A12_ROWS.map((r) => ({ ...r }));
    rows[11] = { ...rows[11], I: 21 };
    expect(() => parseRecap12(sheet(rows), 'X')).toThrow(/row 12/);
    expect(() => parseRecap12(sheet(rows), 'X')).toThrow(/2026-01/);
  });
});

// -------------------------------------------------------------------------------------------------
// Layout 4 — QuickBooks entity statement (annual / partial-year, nested by column depth)
// -------------------------------------------------------------------------------------------------

const QB_NEW_PLANT_ROWS: Row[] = [
  { E: 'Jan - Dec 24' },
  { B: 'Income' },
  { C: 'Rents', E: 425450.49 },
  { C: 'Tax Refund', E: 1500 },
  { B: 'Total Income', E: 426950.49 },
  { B: 'Expense' },
  { C: 'Amortization Expense', E: 17601 },
  { C: 'Insurance', E: 0 },
  { C: 'Interest Expense', E: 58659.84 },
  { C: 'Tax' },
  { D: 'Fed', E: 7000 },
  { D: 'Property', E: 309 },
  { C: 'Total Tax', E: 7309 },
  { B: 'Total Expense', E: 83569.84 },
  { A: 'Net Income', E: 343380.65 },
];

const QB_SOLAR_ROWS: Row[] = [
  { G: 'Jan 1 - Jun 12, 26' },
  { B: 'Ordinary Income/Expense' },
  { D: 'Income' },
  { E: 'Electricity Income -- PS', G: 88098.39 },
  { E: 'SREC Income', G: 139415.5 },
  { D: 'Total Income', G: 227513.89 },
  { C: 'Gross Profit', G: 227513.89 },
  { D: 'Expense' },
  { E: 'Bank Service Charges' },
  { F: 'Wire Fee', G: 15 },
  { F: 'Bank Service Charges - Other', G: 30 },
  { E: 'Total Bank Service Charges', G: 45 },
  { E: 'Insurance Expense', G: 13678.25 },
  { D: 'Total Expense', G: 13723.25 },
  { B: 'Net Ordinary Income', G: 213790.64 },
  { B: 'Other Income/Expense' },
  { C: 'Other Expense' },
  { D: 'Tax -- Md State', G: 13400 },
  { C: 'Total Other Expense', G: 13400 },
  { B: 'Net Other Income', G: -13400 },
  { A: 'Net Income', G: 200390.64 },
];

describe('layout QB — QuickBooks entity statement', () => {
  it('flat shape: section from the enclosing Income/Expense header, parent account as group, Total rows as totals', () => {
    const out = parseQuickBooks(sheet(QB_NEW_PLANT_ROWS), '55 New Plant (EGFLLC)');
    expect(out.periods).toEqual(['2024-FY']);
    const e = '55 New Plant (EGFLLC)';
    expect(nonTotals(out.records)).toEqual([
      rec(e, '2024-FY', 'QB', 'Income', null, 'Rents', 425450.49),
      rec(e, '2024-FY', 'QB', 'Income', null, 'Tax Refund', 1500),
      rec(e, '2024-FY', 'QB', 'Expense', null, 'Amortization Expense', 17601),
      rec(e, '2024-FY', 'QB', 'Expense', null, 'Insurance', 0),
      rec(e, '2024-FY', 'QB', 'Expense', null, 'Interest Expense', 58659.84),
      rec(e, '2024-FY', 'QB', 'Expense', 'Tax', 'Fed', 7000),
      rec(e, '2024-FY', 'QB', 'Expense', 'Tax', 'Property', 309),
    ]);
    const totals = out.records.filter((r) => r.isTotal).map((r) => [r.section, r.group, r.account, r.amount]);
    expect(totals).toEqual([
      ['Income', null, 'Total Income', 426950.49],
      ['Expense', 'Tax', 'Total Tax', 7309],
      ['Expense', null, 'Total Expense', 83569.84],
      [null, null, 'Net Income', 343380.65],
    ]);
  });

  it('nested shape (Ordinary Income/Expense › Other Expense) and the partial-year period label', () => {
    const out = parseQuickBooks(sheet(QB_SOLAR_ROWS), '1851 South Club Solar');
    expect(out.periods).toEqual(['2026-YTD(thru 2026-06-12)']);
    const p = '2026-YTD(thru 2026-06-12)';
    const e = '1851 South Club Solar';
    expect(nonTotals(out.records)).toEqual([
      rec(e, p, 'QB', 'Income', null, 'Electricity Income -- PS', 88098.39),
      rec(e, p, 'QB', 'Income', null, 'SREC Income', 139415.5),
      rec(e, p, 'QB', 'Expense', 'Bank Service Charges', 'Wire Fee', 15),
      rec(e, p, 'QB', 'Expense', 'Bank Service Charges', 'Bank Service Charges - Other', 30),
      rec(e, p, 'QB', 'Expense', null, 'Insurance Expense', 13678.25),
      rec(e, p, 'QB', 'Other Expense', null, 'Tax -- Md State', 13400),
    ]);
    // Gross Profit / Net Ordinary Income / Net Other Income are computed lines, never accounts
    expect(out.records.filter((r) => r.isTotal).map((r) => r.account)).toEqual([
      'Total Income',
      'Gross Profit',
      'Total Bank Service Charges',
      'Total Expense',
      'Net Ordinary Income',
      'Total Other Expense',
      'Net Other Income',
      'Net Income',
    ]);
  });

  it('fails on a Total that does not tie, on an unrecognised period header, and on an account outside any section', () => {
    const bad = QB_NEW_PLANT_ROWS.map((r) => ({ ...r }));
    bad[12] = { C: 'Total Tax', E: 7310 };
    expect(() => parseQuickBooks(sheet(bad), 'X')).toThrow(/row 13/);
    const bad2 = QB_NEW_PLANT_ROWS.map((r) => ({ ...r }));
    bad2[0] = { E: 'Q1 2024' };
    expect(() => parseQuickBooks(sheet(bad2), 'X')).toThrow(/period/i);
    const bad3: Row[] = [{ E: 'Jan - Dec 24' }, { C: 'Rents', E: 1 }];
    expect(() => parseQuickBooks(sheet(bad3), 'X')).toThrow(/section/i);
  });
});

// -------------------------------------------------------------------------------------------------
// Dispatch
// -------------------------------------------------------------------------------------------------

describe('detectLayout / parseStatement', () => {
  it('recognises each layout from its title cells and refuses the AppFolio "Cash Flow" variant and unknown sheets', () => {
    expect(detectLayout(sheet(AF_ROWS))).toBe('AF');
    expect(detectLayout(sheet(CF_ROWS))).toBe('CF');
    expect(detectLayout(sheet(A12_ROWS))).toBe('A12');
    expect(detectLayout(sheet(QB_NEW_PLANT_ROWS))).toBe('QB');
    expect(detectLayout(sheet(QB_SOLAR_ROWS))).toBe('QB');
    expect(detectLayout(sheet([{ A: 'Cash Flow' }, { A: 'Property: 350 Highway Center' }]))).toBeNull();
    expect(detectLayout(sheet([{ A: 'hello' }]))).toBeNull();
  });

  it('parseStatement dispatches on the detected layout and fails loud on a layout mismatch or an unknown layout', () => {
    expect(parseStatement(sheet(CF_ROWS), { entity: 'X' }).layout).toBe('CF');
    expect(parseStatement(sheet(AF_ROWS), { entity: 'X', layout: 'AF' }).layout).toBe('AF');
    expect(() => parseStatement(sheet(AF_ROWS), { entity: 'X', layout: 'CF' })).toThrow(/expected layout CF/);
    expect(() => parseStatement(sheet([{ A: 'Cash Flow' }], { file: 'P&L 2025 -- 9620 State 350.xlsx' }), { entity: 'X' })).toThrow(/P&L 2025 -- 9620 State 350\.xlsx.*unsupported/);
  });
});
