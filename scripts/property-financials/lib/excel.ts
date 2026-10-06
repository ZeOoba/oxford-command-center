// scripts/property-financials/lib/excel.ts — exceljs workbook -> SheetSource (rows of cells).
//
// exceljs (already a dependency; the Spine A parser uses it) reads .xlsx / .xlsm only. The binary
// .xls (OLE2 / BIFF8) exports AppFolio produces are NOT readable here — see README.md "Binary .xls
// exports" and convert-xls.ps1. All logic over the cells lives in
// src/analytics/property-financials/parse-statements.ts; this file only flattens cell values.
import ExcelJS from 'exceljs';
import type { CellValue, SheetSource } from '../../../src/analytics/property-financials/parse-statements';

/** Collapse an exceljs cell value to string | number | null (rich text joined, formulas by result, dates as YYYY-MM-DD). */
export function flattenCellValue(v: ExcelJS.CellValue): CellValue {
  if (v === null || v === undefined) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') return v;
  if (typeof v === 'boolean') return v ? 'TRUE' : 'FALSE';
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if ('richText' in v && Array.isArray(v.richText)) return v.richText.map((t) => t.text).join('');
    if ('result' in v) return flattenCellValue((v as { result: ExcelJS.CellValue }).result);
    if ('text' in v && typeof (v as { text: unknown }).text === 'string') return (v as { text: string }).text;
    if ('error' in v) return null;
  }
  return null;
}

/** Every non-empty worksheet of the workbook, densely materialised (rowCount x columnCount). */
export async function readWorkbookSheets(path: string): Promise<SheetSource[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(path);
  const out: SheetSource[] = [];
  for (const ws of wb.worksheets) {
    if (ws.rowCount === 0 || ws.columnCount === 0) continue;
    const rows: CellValue[][] = [];
    for (let r = 1; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      const cells: CellValue[] = [];
      for (let c = 1; c <= ws.columnCount; c++) cells.push(flattenCellValue(row.getCell(c).value));
      rows.push(cells);
    }
    out.push({ file: path, sheet: ws.name, rows });
  }
  return out;
}

/** The statement sheet of a workbook: the first non-empty sheet that is not a QuickBooks tips page. */
export function pickStatementSheet(sheets: readonly SheetSource[], file: string): SheetSource {
  const candidates = sheets.filter((s) => !/export tips/i.test(s.sheet));
  const first = candidates[0];
  if (!first) throw new Error(`${file}: no statement worksheet (sheets: ${sheets.map((s) => s.sheet).join(', ') || 'none'})`);
  return first;
}
