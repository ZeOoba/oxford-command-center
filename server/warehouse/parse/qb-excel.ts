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

// Report-stated TOP-LEVEL totals (the ingest foot-mismatch choke point). Only these
// exact forms — sub-group subtotals ("Total RENTAL INCOME", "Total Tax") must never
// be captured. Last writer wins when a report states the same total twice (AppFolio
// emits both "Total Operating Income" and "Total Income" with identical values).
const STATED_TOTAL_INCOME_RE = /^total (income|revenue|operating income)$/i;
const STATED_TOTAL_EXPENSE_RE = /^total (operating )?expenses?$/i;

// Column-header cells (Yardi/CRC-style charts put dollar AND percent columns side by
// side; "rightmost numeric wins" would read the trailing % column — the Broadway bug).
const HEADER_CELL_RE = /period to date|year to date|selected period|%|total|annual|ytd/i;
const HEADER_PRIMARY_RE = /year to date|ytd|total|annual/i;
const HEADER_SECONDARY_RE = /period to date|selected period/i;

// Numeric-only text ("425450.49", "(98.81)", "1") is a VALUE cell, never an account label.
function isNumericText(s: string): boolean {
  return /^[\d.,()$\s-]*$/.test(s.trim());
}

// Strict account-candidate rule for space-indented QB/Yardi sheets: leading whitespace
// ("     5002 RENTAL INCOME") or a digit-led GL code ("5064 Rent").
function isSpaceOrDigitCandidate(t: string): boolean {
  return !isNumericText(t) && (/^\s/.test(t) || /^\d/.test(t.trim()));
}

const MONTHS: Record<string, number> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

/** Last calendar day of a 1-based month (no Date.now — pure calendar math). */
function lastDayOfMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

// Derived-summary rows (CRC/Yardi-style charts AND QB Desktop nested layouts):
// report-computed totals that carry a value but are NOT accounts — ingesting them
// double-counts (same class as numeric-only summary rows, fix ba230df).
// "beginning cash"/"(actual) ending cash" are AppFolio cash-position lines, not P&L.
const DERIVED_SUMMARY_RE = /^(net operating income|net income(\/loss)?|noi\b.*|income after owner activity|cash flow|net other items|gross profit|net ordinary income|net other income|beginning cash|actual ending cash|ending cash)$/i;

export async function parseQbExcel(filePath: string): Promise<RawStatement> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(filePath);
  if (wb.worksheets.length === 0) throw new Error(`no worksheet in ${filePath}`);
  // QB Desktop .xlsm exports put a "QuickBooks Desktop Export Tips" sheet FIRST; the
  // statement lives on a later sheet. Take the first worksheet that yields accounts;
  // if none do, return the first sheet's (empty) result.
  let first: RawStatement | null = null;
  for (const ws of wb.worksheets) {
    const parsed = parseWorksheet(ws);
    if (parsed.accounts.length > 0) return parsed;
    first ??= parsed;
  }
  return first!;
}

function parseWorksheet(ws: ExcelJS.Worksheet): RawStatement {
  let propertyRaw = '';
  let periodLabel = '';
  let periodStart: string | null = null;
  let periodEnd: string | null = null;
  let basis: RawStatement['basis'] = 'unknown';
  let yardiHeaders = false; // "Period =" / "Book =" metadata forms matched
  let appfolioHeaders = false; // "Properties:" / "Exported On:" metadata forms matched
  let propertiesRaw = ''; // AppFolio "Properties: ..." text — fallback when no "Property:" line
  let firstRowText: string | null = null; // A1-style property-name candidate
  let nonEmptyRows = 0;
  let section = '';
  let totalIncome: number | null = null;
  let totalExpense: number | null = null;
  let parent: string | null = null;
  // Column the current parent group sits in — set ONLY for column-indented layouts
  // (null = space-indented mode, where parent applies to every subsequent leaf).
  let parentCol: number | null = null;
  const accounts: RawAccountLine[] = [];

  // Pre-pass: find a column-header row (≥2 cells matching the header vocabulary) and
  // pick the dollar value column — LAST "Year to Date"/YTD/Total/Annual column, else
  // last "Period to Date"/"Selected Period". '%' columns are never eligible. Without a
  // header row (QB-style exports), valueCol stays null → rightmost-numeric fallback.
  // Column headers definitionally precede data: the scan STOPS at the first section row
  // — data rows can pair a "Total ..." subtotal label with a "92.83 %" text cell and
  // must never be mistaken for headers (the 9620 State 350 cash-flow format).
  // Pre-pass: layout mode. Sheets with ANY space/digit-prefixed candidate are
  // space-indented (classic QB/Yardi) and keep the strict rule — their unindented
  // footer rows (cash balances, "Net cash provided by ...") stay invisible, as before.
  // A sheet with NO such candidate is column-indented (QB Desktop 55 New Plant / 1851
  // Solar layout): depth is encoded by COLUMN and the fallback candidate rule applies.
  let columnMode = true;
  ws.eachRow({ includeEmpty: false }, (row) => {
    if (!columnMode) return;
    row.eachCell({ includeEmpty: false }, (cell) => {
      const t = cellText(cell.value);
      if (t && t.trim() !== '' && isSpaceOrDigitCandidate(t)) columnMode = false;
    });
  });

  let valueCol: number | null = null;
  let headerRowNumber: number | null = null;
  let scanDone = false;
  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (scanDone || valueCol !== null) return;
    const cells: Array<{ col: number; text: string }> = [];
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const t = cellText(cell.value);
      if (t && t.trim() !== '') cells.push({ col, text: t.trim() });
    });
    if (cells.some((c) => SECTION_RE.test(c.text))) { scanDone = true; return; }
    const headerish = cells.filter((c) => HEADER_CELL_RE.test(c.text));
    // ≥2 DISTINCT matching texts: QB exports repeat one label across its merged span
    // ("5002 Total RENTAL INCOME" × 9 cells) — that is ONE logical cell, not a header row.
    if (new Set(headerish.map((c) => c.text)).size < 2) return;
    // ANY %-containing header is ineligible — AppFolio names its percent columns
    // "% of Selected Period"/"% of Fiscal Year To Date", which also match the
    // PRIMARY/SECONDARY vocabulary and would otherwise win as the rightmost match.
    const eligible = headerish.filter((c) => !c.text.includes('%'));
    const primary = eligible.filter((c) => HEADER_PRIMARY_RE.test(c.text));
    const secondary = eligible.filter((c) => HEADER_SECONDARY_RE.test(c.text));
    const pick = primary[primary.length - 1] ?? secondary[secondary.length - 1];
    if (pick) { valueCol = pick.col; headerRowNumber = rn; }
  });

  ws.eachRow({ includeEmpty: false }, (row, rn) => {
    if (rn === headerRowNumber) return; // column-header row is metadata, not data
    // gather all non-empty cells in the row
    const texts: Array<{ col: number; text: string }> = [];
    let rowNum: number | null = null;
    let numCol: number | null = null;
    let anyNumeric = false;
    row.eachCell({ includeEmpty: false }, (cell, col) => {
      const t = cellText(cell.value);
      if (t && t.trim() !== '') texts.push({ col, text: t });
      const n = cellNum(cell.value);
      if (n !== null) {
        anyNumeric = true;
        // header-driven column when one exists; else rightmost numeric wins
        if (valueCol === null || col === valueCol) { rowNum = n; numCol = col; }
      }
    });
    if (texts.length === 0) return;
    const first = texts[0]!.text.trim();
    if (nonEmptyRows === 0 && !/^(Property:|Period\s*=|Book\s*=)/i.test(first)) {
      firstRowText = first; // Yardi puts the bare property name in A1
    }
    nonEmptyRows += 1;

    // header rows
    const propMatch = first.match(/^Property:\s*(.+)$/i);
    if (propMatch) { propertyRaw = propMatch[1]!.trim(); return; }
    // AppFolio Cash Flow metadata: "Exported On: ..." / "Properties: ..." /
    // "Date Range: MM/DD/YYYY to MM/DD/YYYY (...)" (text repeats across merged cols)
    if (/^Exported On:/i.test(first)) { appfolioHeaders = true; return; }
    const propsMatch = first.match(/^Properties:\s*(.+)$/i);
    if (propsMatch) { propertiesRaw = propsMatch[1]!.trim(); appfolioHeaders = true; return; }
    const rangeMatch = first.match(/^Date Range:\s*(\d{1,2}\/\d{1,2}\/\d{4})\s+to\s+(\d{1,2}\/\d{1,2}\/\d{4})/i);
    if (rangeMatch) {
      periodLabel = first;
      periodStart = toIso(rangeMatch[1]!);
      periodEnd = toIso(rangeMatch[2]!);
      return;
    }
    const periodMatch = first.match(/^(\d{1,2}\/\d{1,2}\/\d{2,4})\s*-\s*(\d{1,2}\/\d{1,2}\/\d{2,4})\s*(\((\w+)\s+basis\))?/i);
    if (periodMatch) {
      periodLabel = first;
      periodStart = toIso(periodMatch[1]!);
      periodEnd = toIso(periodMatch[2]!);
      const b = periodMatch[4]?.toLowerCase();
      if (b === 'cash' || b === 'accrual' || b === 'tax') basis = b;
      return;
    }
    // Yardi metadata: "Period = Jan 2024-Dec 2024"
    const yardiPeriod = first.match(/^Period\s*=\s*([A-Za-z]{3,9})\.?\s+(\d{4})\s*[-–]\s*([A-Za-z]{3,9})\.?\s+(\d{4})$/i);
    if (yardiPeriod) {
      const m1 = MONTHS[yardiPeriod[1]!.slice(0, 3).toLowerCase()];
      const m2 = MONTHS[yardiPeriod[3]!.slice(0, 3).toLowerCase()];
      if (m1 && m2) {
        periodLabel = first;
        const y1 = Number(yardiPeriod[2]!);
        const y2 = Number(yardiPeriod[4]!);
        periodStart = `${y1}-${String(m1).padStart(2, '0')}-01`;
        periodEnd = `${y2}-${String(m2).padStart(2, '0')}-${String(lastDayOfMonth(y2, m2)).padStart(2, '0')}`;
        yardiHeaders = true;
        return;
      }
    }
    // Yardi metadata: "Book = Cash ; Tree = 8807cole"
    const bookMatch = first.match(/^Book\s*=\s*(Cash|Accrual)\b/i);
    if (bookMatch) {
      basis = bookMatch[1]!.toLowerCase() as RawStatement['basis'];
      yardiHeaders = true;
      return;
    }
    // also accept "Jan - Dec 24" style period labels without dates
    if (!periodLabel && /^[A-Z][a-z]{2}\s*-\s*[A-Z][a-z]{2}\s+\d{2}$/.test(first)) { periodLabel = first; return; }

    // section labels (column B in real exports — any short all-caps cell that matches)
    for (const t of texts) {
      const trimmed = t.text.trim();
      if (SECTION_RE.test(trimmed)) {
        if (anyNumeric) {
          // section word + amount on one row = a total-value row ("INCOME 216461.4"),
          // not a header — skip without changing section. Under the bare-TOTAL section
          // (QB "TOTAL → INCOME 216461.4" footer) that row IS the report's stated
          // top-level total: record it while skipping.
          if (section === 'TOTAL' && rowNum !== null) {
            if (/^INCOME$/i.test(trimmed)) totalIncome = rowNum;
            else if (/^EXPENSE$/i.test(trimmed)) totalExpense = rowNum;
          }
          return;
        }
        section = trimmed.toUpperCase();
        parent = null; // a new section starts a new group context
        parentCol = null;
        return;
      }
    }

    // account rows: "     5002 RENTAL INCOME" (group), "          5064 Rent" (leaf), "          5002 Total X" (subtotal)
    let acctCell: { col: number; text: string } | undefined;
    let columnIndented = false;
    if (columnMode) {
      // column-indented layout: take the RIGHTMOST text cell that is not a section
      // label, not numeric text, and not the chosen value column.
      const candidates = texts.filter((t) =>
        !SECTION_RE.test(t.text.trim())
        && !isNumericText(t.text)
        && t.col !== (valueCol ?? numCol));
      acctCell = candidates[candidates.length - 1];
      columnIndented = acctCell !== undefined;
    } else {
      // space-indented sheets keep the original rule VERBATIM — including numeric-text
      // matches (rejected below by the numeric-only name check), which mask junk cells
      // to their right (" %" on QB cash-flow percent rows).
      acctCell = texts.find((t) => /^\s/.test(t.text) || /^\d/.test(t.text.trim()));
    }
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
      // subtotal row ("5002 Total RENTAL INCOME") — skipped even when it carries an
      // amount, but a TOP-LEVEL stated total ("Total Income" / "Total Operating
      // Expense") is captured for the ingest foot-mismatch check on the way out.
      if (rowNum !== null) {
        if (STATED_TOTAL_INCOME_RE.test(name)) totalIncome = rowNum;
        else if (STATED_TOTAL_EXPENSE_RE.test(name)) totalExpense = rowNum;
      }
      return;
    }
    if (rowNum === null) {
      // group header (no value) — becomes parent for subsequent leaves.
      // (code is already split off; re-stripping here would eat "1st …" names)
      // Column-indented mode tracks the group's column: a leaf in a DEEPER column gets
      // this group as parent; a new group at the same/shallower column replaces it.
      parent = name;
      parentCol = columnIndented ? acctCell.col : null;
      return;
    }
    if (parentCol !== null && acctCell.col <= parentCol) {
      // column-indented leaf back at/above the group's column — the group has ended
      parent = null;
      parentCol = null;
    }
    accounts.push({
      code,
      name,
      section,
      parent,
      total: rowNum,
    });
  });

  // Yardi exports carry the bare property name in A1 (no "Property:" line). Applied
  // only when Yardi metadata matched — QB files without a "Property:" line keep '',
  // never a report title like "Profit & Loss".
  if (!propertyRaw && yardiHeaders && firstRowText) propertyRaw = firstRowText;
  // AppFolio exports carry the roster in "Properties:" (no "Property:" line).
  if (!propertyRaw && propertiesRaw) propertyRaw = propertiesRaw;

  // YTD if the period ends mid-year; a full year ends on month-day 12-31.
  // (helper defeats TS narrowing — periodEnd is assigned inside the eachRow callback)
  const endsMidYear = (end: string | null): boolean => end !== null && end.slice(5) !== '12-31';
  const grain: RawStatement['grain'] = endsMidYear(periodEnd) ? 'ytd' : 'year';

  return RawStatementSchema.parse({
    propertyRaw, periodLabel, periodStart, periodEnd, grain,
    basis, sourceSystem: appfolioHeaders ? 'appfolio' : yardiHeaders ? 'yardi' : 'quickbooks',
    accounts, totalIncome, totalExpense,
  });
}
