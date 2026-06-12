// server/warehouse/parse/qb-excel.ts
import ExcelJS from 'exceljs';
import type { RawAccountLine, RawStatement } from '../../../src/contracts/warehouse';
import { RawStatementSchema } from '../../../src/contracts/warehouse';

function cellText(v: ExcelJS.CellValue): string | null {
  if (v == null) return null;
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (v instanceof Date) return v.toISOString();
  if (typeof v === 'object' && 'richText' in v) return v.richText.map((t) => t.text).join('');
  if (typeof v === 'object' && 'result' in v) return cellText(v.result as ExcelJS.CellValue);
  if (typeof v === 'object' && 'text' in v) return String((v as { text: unknown }).text);
  return null;
}

function cellNum(v: ExcelJS.CellValue): number | null {
  if (typeof v === 'number') return v;
  if (v != null && typeof v === 'object' && 'result' in v && typeof (v as { result: unknown }).result === 'number') {
    return (v as { result: number }).result;
  }
  const t = cellText(v);
  if (!t) return null;
  const cleaned = t.replace(/[$,\s]/g, '').replace(/^\((.*)\)$/, '-$1');
  const n = Number(cleaned);
  return Number.isFinite(n) && cleaned !== '' ? n : null;
}

function toIso(mdy: string): string {
  const m = mdy.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})$/);
  if (!m) return mdy;
  const yy = m[3]!.length === 2 ? `20${m[3]}` : m[3]!;
  return `${yy}-${m[1]!.padStart(2, '0')}-${m[2]!.padStart(2, '0')}`;
}

const SECTION_RE = /^(INCOME|EXPENSE|TOTAL|NON OPERATING EXPENSE|OPERATING EXPENSES?|REVENUE|OTHER ITEMS)$/i;

// Derived-summary rows (CRC/Yardi-style charts): report-computed totals that carry a
// value but are NOT accounts — ingesting them double-counts (same class as numeric-only
// summary rows, fix ba230df).
const DERIVED_SUMMARY_RE = /^(net operating income|net income(\/loss)?|noi\b.*|income after owner activity|cash flow|net other items)$/i;

export async function parseQbExcel(filePath: string): Promise<RawStatement> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  const ws = wb.worksheets[0];
  if (!ws) throw new Error(`no worksheet in ${filePath}`);

  let propertyRaw = '';
  let periodLabel = '';
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  let basis: RawStatement['basis'] = 'unknown';
  let section = '';
  let parent: string | null = null;
  const accounts: RawAccountLine[] = [];

  ws.eachRow({ includeEmpty: false }, (row) => {
    // gather all non-empty cells in the row
    const texts: Array<{ col: number; text: string }> = [];
    let rowNum: number | null = null;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const t = cellText(cell.value);
      if (t && t.trim() !== '') texts.push({ col, text: t });
      const n = cellNum(cell.value);
      if (n !== null) rowNum = n; // rightmost numeric wins
    });
    if (texts.length === 0) return;
    const first = texts[0]!.text.trim();

    // header rows
    const propMatch = first.match(/^Property:\s*(.+)$/i);
    if (propMatch) { propertyRaw = propMatch[1]!.trim(); return; }
    const periodMatch = first.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*(\((\w+)\s+basis\))?/i);
    if (periodMatch) {
      periodLabel = first;
      periodStart = toIso(periodMatch[1]!);
      periodEnd = toIso(periodMatch[2]!);
      const b = periodMatch[4]?.toLowerCase();
      if (b === 'cash' || b === 'accrual' || b === 'tax') basis = b;
      return;
    }
    // also accept "Jan - Dec 24" style period labels without dates
    if (!periodLabel && /^[A-Z][a-z]{2}\s*-\s*[A-Z][a-z]{2}\s+\d{2}$/.test(first)) { periodLabel = first; return; }

    // section labels (column B in real exports — any short all-caps cell that matches)
    for (const t of texts) {
      const trimmed = t.text.trim();
      if (SECTION_RE.test(trimmed)) {
        if (rowNum !== null) return; // section word + amount on one row = a total-value row ("INCOME 216461.4"), not a header — skip without changing section
        section = trimmed.toUpperCase();
        parent = null; // a new section starts a new group context
        return;
      }
    }

    // account rows: "     5002 RENTAL INCOME" (group), "          5064 Rent" (leaf), "          5002 Total X" (subtotal)
    const acctCell = texts.find((t) => /^\s/.test(t.text) || /^\d/.test(t.text.trim()));
    if (!acctCell || !section || section === 'TOTAL') return;
    const trimmed = acctCell.text.trim();
    // A GL code must be digits FOLLOWED BY WHITESPACE — otherwise alpha names with a
    // leading digit ("1st Mortgage Note Payable") lose their first character(s).
    const m = trimmed.match(/^(?<code>\d[\d.-]*)\s+(?<name>.+)$/);
    const code = m?.groups?.['code'] ?? null;
    const name = (m?.groups?.['name'] ?? trimmed).trim();
    if (/^[\d.,()$\s-]*$/.test(name)) return; // numeric-only candidate ("105647.91" → code 105647.9 + name "1") = a report summary value, not an account
    if (DERIVED_SUMMARY_RE.test(name.toLowerCase())) return; // derived totals ("NET OPERATING INCOME", "CASH FLOW") are not accounts
    if (/^Total\b/i.test(name) || /\bTotal\b/.test(name.split(/\s+/).slice(0, 2).join(' '))) {
      return; // subtotal row ("5002 Total RENTAL INCOME") — skipped even when it carries an amount
    }
    if (rowNum === null) {
      // group header (no value) — becomes parent for subsequent leaves.
      // (code is already split off; re-stripping here would eat "1st …" names)
      parent = name;
      return;
    }
    accounts.push({
      code,
      name,
      section,
      parent,
      total: rowNum,
    });
  });

  // YTD if the period ends mid-year; a full year ends on month-day 12-31.
  // (helper defeats TS narrowing — periodEnd is assigned inside the eachRow callback)
  const endsMidYear = (end: string | null): boolean => end !== null && end.slice(5) !== '12-31';
  const grain: RawStatement['grain'] = endsMidYear(periodEnd) ? 'ytd' : 'year';

  return RawStatementSchema.parse({
    propertyRaw, periodLabel, periodStart, periodEnd, grain,
    basis, sourceSystem: 'quickbooks',
    accounts, totalIncome: null, totalExpense: null,
  });
}
