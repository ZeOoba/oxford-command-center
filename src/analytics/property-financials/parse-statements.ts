// src/analytics/property-financials/parse-statements.ts
//
// Source-layout parsers (plan T9b, part 1): one statement sheet -> raw P&L records in the exact
// shape the T9a normalizer consumes (normalize.ts RawRecord: entity, period, layout, section, group,
// account, amount, isTotal). Four layouts, all seen in OneDrive Business/Property Financials:
//
//   AF  AppFolio consolidated "Profit & Loss" (amount column L). Labels: B = section / TOTAL /
//       NET INCOME / NOI, C = group (5-space indent, "5002 RENTAL INCOME") or account (10-space,
//       "5064 Rent" -> "Rent"); a group-level line that carries an amount is an account under the
//       current group (AppFolio prints "4700 Unallocated Prepays" that way, before any group).
//       One period per file, from the row-3 dateline.
//   CF  Yardi "Statement (12 months)" cash-flow statement, one column per month (row 5) plus a Total
//       column. A 1-space ALL-CAPS header is a group; a 4-space line is an account. A mixed-case
//       header ("TAXES and RESERVES") is NOT a group — the reference parser only promoted all-caps
//       headers, the committed CSV carries Real Estate Taxes under MAINTENANCE EXPENSES and the v1
//       mapping (CF-MAINT-RE-TAX) keys on that; the parser reports such headers in ignoredHeaders.
//       Also reads the single-month variant (no month header row; Period = Mon YYYY; column B) and
//       the annual "Cash Flow Statement" variant (Period to Date column -> one YYYY-FY period).
//   A12 AppFolio "Profit & Loss 12 Month Recap": A = section / TOTAL / NOI / NET INCOME, B = group
//       (4-space) or account (8-space), month columns from the row-5 labels ("OCT 25"; columns have
//       gaps; TOTAL skipped). Expenses print positive. The section "N/O EXPENSE" is normalised to
//       NON OPERATING EXPENSE (the total row keeps its printed label). A recap printed without
//       section headers yields null sections (the 2025-09 single-month recap).
//   QB  QuickBooks entity statement: a tree by column depth (header = label without an amount,
//       leaf = label with an amount, "Total X" closes header X). section = nearest enclosing
//       Income / Expense / Other Income / Other Expense header; group = a nearer parent account
//       ("Tax", "Bank Service Charges") or null. Period from the row-1 header: "Jan - Dec 24" ->
//       2024-FY, "Jan 1 - Jun 12, 26" -> 2026-YTD(thru 2026-06-12) (the contract's annual period).
//
// Every parser verifies the statement's own totals (group totals and section totals) against the
// sum of the accounts it read, to the cent; a mismatch is a StatementParseError that names the
// file, sheet, row (and month). Nothing is ever skipped silently: an unknown layout, a missing
// header or an account outside any section all throw. Total rows are emitted with isTotal: true so
// the normalizer skips them exactly as it does the reference export's.
//
// Pure TypeScript: no fs, no exceljs — scripts/property-financials/lib/excel.ts turns a workbook
// into SheetSource objects (rows of cells), which is also what the unit tests build by hand.
import type { RawRecord } from './normalize';

// -------------------------------------------------------------------------------------------------
// Sheet model
// -------------------------------------------------------------------------------------------------

export type CellValue = string | number | null;

/** One worksheet as dense rows of cells: rows[r - 1][c - 1] is cell (r, c), 1-based like Excel. */
export interface SheetSource {
  readonly file: string;
  readonly sheet: string;
  readonly rows: ReadonlyArray<ReadonlyArray<CellValue>>;
}

export type StatementLayout = 'AF' | 'CF' | 'A12' | 'QB';
export const STATEMENT_LAYOUTS: readonly StatementLayout[] = ['AF', 'CF', 'A12', 'QB'];

export class StatementParseError extends Error {
  constructor(
    readonly file: string,
    readonly sheet: string,
    readonly row: number | null,
    readonly detail: string,
  ) {
    super(`${file} › ${sheet}${row === null ? '' : ` › row ${row}`}: ${detail}`);
    this.name = 'StatementParseError';
  }
}

export interface ParsedStatement {
  readonly layout: StatementLayout;
  readonly entity: string;
  /** Period ids in column order (one for AF / QB / single-month CF). */
  readonly periods: readonly string[];
  readonly records: readonly RawRecord[];
  /** Number of statement totals verified against the accounts read. */
  readonly totalChecks: number;
  /** CF only: 1-space headers that were not promoted to a group (mixed case). */
  readonly ignoredHeaders: readonly string[];
  /** Set when the export carries no rows at all ("No activity for given filter criteria"): records is empty. */
  readonly emptyReason: string | null;
}

const EMPTY_SENTINEL = /^No activity for given filter criteria$/i;

const TOLERANCE = 0.011;

function cellAt(sheet: SheetSource, row: number, col: number): CellValue {
  const v = sheet.rows[row - 1]?.[col - 1];
  return v === undefined ? null : v;
}

function str(v: CellValue): string | null {
  if (typeof v !== 'string') return null;
  const t = v.trim();
  return t.length === 0 ? null : t;
}

function num(v: CellValue): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function leadingSpaces(v: CellValue): number {
  return typeof v === 'string' ? v.length - v.trimStart().length : 0;
}

function fail(sheet: SheetSource, row: number | null, detail: string): never {
  throw new StatementParseError(sheet.file, sheet.sheet, row, detail);
}

function ties(stated: number, summed: number): boolean {
  return Math.abs(stated - summed) <= TOLERANCE;
}

function money(n: number): string {
  return n.toFixed(2);
}

// -------------------------------------------------------------------------------------------------
// Periods
// -------------------------------------------------------------------------------------------------

const MONTHS: Readonly<Record<string, number>> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12 };

function ym(y: number, m: number): string {
  return `${y}-${String(m).padStart(2, '0')}`;
}

function ymd(y: number, m: number, d: number): string {
  return `${ym(y, m)}-${String(d).padStart(2, '0')}`;
}

function daysInMonth(y: number, m: number): number {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}

function fullYear(yy: number): number {
  return yy < 100 ? 2000 + yy : yy;
}

/** Period id for a window: a whole month -> YYYY-MM; Jan 1 - Dec 31 -> YYYY-FY; Jan 1 - any -> YYYY-YTD(thru YYYY-MM-DD). */
function periodFromWindow(sy: number, sm: number, sd: number, ey: number, em: number, ed: number, what: string): string {
  if (sd === 1 && sy === ey && sm === em && ed === daysInMonth(ey, em)) return ym(sy, sm);
  if (sd === 1 && sm === 1 && sy === ey) {
    if (em === 12 && ed === 31) return `${sy}-FY`;
    return `${sy}-YTD(thru ${ymd(ey, em, ed)})`;
  }
  throw new Error(`${what} is neither a whole month, a whole calendar year nor a Jan-1-anchored window`);
}

/** AppFolio dateline "10/01/23 - 10/31/23  (cash basis)" -> 2023-10 | 2024-FY | 2026-YTD(thru 2026-09-30). */
export function periodFromDateline(text: string): string {
  const m = /(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s*-\s*(\d{1,2})\/(\d{1,2})\/(\d{2,4})/.exec(text);
  if (!m) throw new Error(`no MM/DD/YY - MM/DD/YY dateline in "${text}"`);
  const [, sm, sd, sy, em, ed, ey] = m.map(Number) as [number, number, number, number, number, number, number];
  return periodFromWindow(fullYear(sy), sm, sd, fullYear(ey), em, ed, `dateline "${text.trim()}"`);
}

/** "Oct 2025" / "OCT 25" -> 2025-10; anything else (Total, Period to Date, blank) -> null. */
export function monthFromLabel(v: CellValue): string | null {
  const s = str(v);
  if (!s) return null;
  const m = /^([A-Za-z]{3})\s+(\d{2}|\d{4})$/.exec(s);
  if (!m) return null;
  const mon = MONTHS[m[1]!.toLowerCase()];
  if (mon === undefined) return null;
  return ym(fullYear(Number(m[2])), mon);
}

export type MonthRange = { kind: 'month'; period: string } | { kind: 'range'; period: string | null; months: number };

/** Yardi "Period = Sep 2025" -> a month; "Period = Jan 2024-Dec 2024" -> a range (FY / YTD id when Jan-anchored, else null). */
export function periodFromMonthRange(text: string): MonthRange {
  const m = /Period\s*=\s*([A-Za-z]{3})\s+(\d{4})(?:\s*-\s*([A-Za-z]{3})\s+(\d{4}))?/.exec(text);
  if (!m) throw new Error(`no "Period = Mon YYYY[-Mon YYYY]" line in "${text}"`);
  const sm = MONTHS[m[1]!.toLowerCase()];
  const sy = Number(m[2]);
  if (sm === undefined) throw new Error(`unknown month in "${text}"`);
  if (m[3] === undefined) return { kind: 'month', period: ym(sy, sm) };
  const em = MONTHS[m[3].toLowerCase()];
  const ey = Number(m[4]);
  if (em === undefined) throw new Error(`unknown month in "${text}"`);
  const months = (ey - sy) * 12 + (em - sm) + 1;
  if (months < 1) throw new Error(`period range runs backwards in "${text}"`);
  let period: string | null = null;
  if (sm === 1 && sy === ey) period = em === 12 ? `${sy}-FY` : `${sy}-YTD(thru ${ymd(ey, em, daysInMonth(ey, em))})`;
  return { kind: 'range', period, months };
}

// -------------------------------------------------------------------------------------------------
// Shared helpers for the AppFolio family (AF, A12)
// -------------------------------------------------------------------------------------------------

const SECTION_ALIASES: Readonly<Record<string, string>> = { 'N/O EXPENSE': 'NON OPERATING EXPENSE' };

function normalizeSection(label: string): string {
  const u = label.toUpperCase();
  return SECTION_ALIASES[u] ?? u;
}

/** "5064 Rent" -> { code: "5064", name: "Rent" }; a label without a code keeps itself as the name. */
function splitCode(label: string): { code: string | null; name: string } {
  const m = /^(\d+)\s+(.*\S)\s*$/.exec(label.trim());
  return m ? { code: m[1]!, name: m[2]! } : { code: null, name: label.trim() };
}

/**
 * Sums per key with a `check` that verifies a stated total and counts it. A section total ("TOTAL
 * INCOME") covers every account since the previous section total — `reset` after each — so a recap
 * printed without section headers still ties; a group total covers the current group.
 */
class Ledger {
  private readonly sums = new Map<string, number>();
  checks = 0;
  add(key: string, amount: number): void {
    this.sums.set(key, (this.sums.get(key) ?? 0) + amount);
  }
  sum(key: string): number {
    return this.sums.get(key) ?? 0;
  }
  reset(key: string): void {
    this.sums.delete(key);
  }
  check(sheet: SheetSource, row: number, key: string, label: string, stated: number, where: string): void {
    const summed = this.sum(key);
    if (!ties(stated, summed)) fail(sheet, row, `${label}${where} states ${money(stated)} but its accounts sum to ${money(summed)}`);
    this.checks++;
  }
}

interface PeriodColumn {
  readonly col: number;
  readonly period: string;
}

/**
 * Add a month column, reading a merged header cell once: Excel replicates a merged cell's value into
 * every column of the merge (the 9620 recap prints "JUN 26" across N:O), so an ADJACENT repeat of the
 * same month is the same column; a repeat anywhere else is a malformed header and fails.
 */
function pushPeriodColumn(sheet: SheetSource, columns: PeriodColumn[], col: number, period: string): void {
  const last = columns[columns.length - 1];
  if (last && last.period === period && col === last.col + 1) return;
  if (columns.some((c) => c.period === period)) fail(sheet, 5, `month ${period} appears twice in the header row`);
  columns.push({ col, period });
}

// -------------------------------------------------------------------------------------------------
// AppFolio family (AF single-amount P&L, A12 12-month recap) — shared row reader
// -------------------------------------------------------------------------------------------------
//
// AppFolio shifts its label columns between exports (sections in A and groups in B on the 12-month
// recap; everything in C on the single-month recap; B / C on the consolidated P&L) and replicates a
// merged cell's value across the merge. Each row is therefore read as: the first string cell before
// the value columns is the label (indentation decides the level), and a TOTAL row names its section
// in the next string cell that differs from "TOTAL".

interface AfRow {
  readonly label: string;
  readonly indent: number;
  /** For a TOTAL row: the section it totals. */
  readonly totalOf: string | null;
}

function appFolioRow(sheet: SheetSource, r: number, beforeCol: number): AfRow | null {
  for (let c = 1; c < beforeCol; c++) {
    const raw = cellAt(sheet, r, c);
    const label = str(raw);
    if (label === null) continue;
    let totalOf: string | null = null;
    if (label === 'TOTAL') {
      for (let d = c + 1; d < beforeCol; d++) {
        const next = str(cellAt(sheet, r, d));
        if (next !== null && next !== 'TOTAL') {
          totalOf = next;
          break;
        }
      }
    }
    return { label, indent: leadingSpaces(raw), totalOf };
  }
  return null;
}

function findInRow(sheet: SheetSource, r: number, pred: (s: string) => boolean): number | null {
  const row = sheet.rows[r - 1] ?? [];
  for (const [i, v] of row.entries()) {
    const s = str(v);
    if (s !== null && pred(s)) return i + 1;
  }
  return null;
}

const SUMMARY_SENTINEL = 'NET INCOME SUMMARY';
const ACCOUNT_INDENT = 8;

function parseAppFolioFamily(sheet: SheetSource, entity: string, layout: 'AF' | 'A12', columns: readonly PeriodColumn[]): ParsedStatement {
  const firstValueCol = Math.min(...columns.map((c) => c.col));
  const records: RawRecord[] = [];
  const ledger = new Ledger();
  let section: string | null = null;
  let group: string | null = null;
  const sectionKey = (period: string) => `S\u0001${period}`;
  const groupKey = (period: string) => `G\u0001${section ?? ''}\u0001${group ?? ''}\u0001${period}`;
  const pushAll = (account: string, values: ReadonlyArray<number | null>, isTotal: boolean, r: number, label: string): void => {
    for (const [i, pc] of columns.entries()) {
      const v = values[i];
      if (v === null || v === undefined) {
        if (isTotal) continue; // a total row leaves blank months blank
        fail(sheet, r, `"${label}" has no amount for ${pc.period}`);
      }
      records.push({ entity, period: pc.period, layout, section, group, account, amount: v, isTotal });
    }
  };

  for (let r = 6; r <= sheet.rows.length; r++) {
    if (findInRow(sheet, r, (x) => x === SUMMARY_SENTINEL) !== null) break;
    const row = appFolioRow(sheet, r, firstValueCol);
    if (row === null) continue;
    const values = columns.map((pc) => num(cellAt(sheet, r, pc.col)));
    const hasNum = values.some((v) => v !== null);
    if (row.label === 'TOTAL') {
      const of = row.totalOf;
      // The annual export prints a total over two rows: a bare "TOTAL" label, then TOTAL + section + amount.
      if (!of && !hasNum) continue;
      if (!of) fail(sheet, r, 'TOTAL row names no section');
      for (const [i, pc] of columns.entries()) {
        // AppFolio leaves a zero total blank (a month with no postings), so blank reads as 0 here.
        const stated: number = values[i] ?? 0;
        ledger.check(sheet, r, sectionKey(pc.period), `TOTAL ${of}`, stated, columns.length > 1 ? ` (${pc.period})` : '');
        ledger.reset(sectionKey(pc.period));
      }
      pushAll(of, values, true, r, `TOTAL ${of}`);
      continue;
    }
    if (row.indent === 0) {
      if (hasNum) pushAll(row.label, values, true, r, row.label); // NOI / NET INCOME — computed lines
      else {
        section = normalizeSection(row.label);
        group = null;
      }
      continue;
    }
    const { code, name } = splitCode(row.label);
    if (/^Total\b/.test(name)) {
      for (const [i, pc] of columns.entries()) ledger.check(sheet, r, groupKey(pc.period), row.label, values[i] ?? 0, columns.length > 1 ? ` (${pc.period})` : '');
      pushAll(name, values, true, r, row.label);
      continue;
    }
    if (row.indent < ACCOUNT_INDENT && !hasNum) {
      group = code === null ? name : `${code} ${name}`;
      continue;
    }
    if (section === null && layout === 'AF') fail(sheet, r, `account "${name}" appears before any section header`);
    const filled = values.map((v) => v ?? 0);
    for (const [i, pc] of columns.entries()) {
      ledger.add(sectionKey(pc.period), filled[i]!);
      ledger.add(groupKey(pc.period), filled[i]!);
    }
    pushAll(name, filled, false, r, row.label);
  }
  if (records.length === 0) fail(sheet, null, 'no account rows found');
  return { layout, entity, periods: columns.map((c) => c.period), records, totalChecks: ledger.checks, ignoredHeaders: [], emptyReason: null };
}

// -------------------------------------------------------------------------------------------------
// Layout AF — AppFolio consolidated P&L (one amount column)
// -------------------------------------------------------------------------------------------------

export function parseAppFolioPl(sheet: SheetSource, entity: string): ParsedStatement {
  if (findInRow(sheet, 1, (x) => x === 'Profit & Loss') === null) fail(sheet, 1, 'expected "Profit & Loss" in row 1 (AppFolio consolidated P&L)');
  const amountCol = findInRow(sheet, 5, (x) => x === 'Amount');
  if (amountCol === null) fail(sheet, 5, 'expected the "Amount" header in row 5');
  const datelineCol = findInRow(sheet, 3, (x) => /\d{1,2}\/\d{1,2}\/\d{2,4}/.test(x));
  if (datelineCol === null) fail(sheet, 3, 'expected the period dateline in row 3');
  let period: string;
  try {
    period = periodFromDateline(str(cellAt(sheet, 3, datelineCol))!);
  } catch (e) {
    fail(sheet, 3, (e as Error).message);
  }
  return parseAppFolioFamily(sheet, entity, 'AF', [{ col: amountCol, period }]);
}

// -------------------------------------------------------------------------------------------------
// Layout CF — Yardi 12-month cash flow statement
// -------------------------------------------------------------------------------------------------

/** Yardi's total / computed lines: TOTAL ..., NET ..., CASH FLOW, INCOME AFTER OWNER ACTIVITY. */
const CF_COMPUTED_LABEL = /^(TOTAL\b|NET\b|CASH FLOW$|INCOME AFTER\b)/;

function isAllCaps(label: string): boolean {
  return /[A-Z]/.test(label) && label === label.toUpperCase();
}

export function parseCashFlow12(sheet: SheetSource, entity: string): ParsedStatement {
  const title = str(cellAt(sheet, 2, 1));
  if (title !== 'Statement (12 months)' && title !== 'Cash Flow Statement') fail(sheet, 2, 'expected "Statement (12 months)" or "Cash Flow Statement" in A2');
  const periodLine = str(cellAt(sheet, 3, 1));
  if (!periodLine) fail(sheet, 3, 'expected the "Period = ..." line in A3');
  let range: MonthRange;
  try {
    range = periodFromMonthRange(periodLine);
  } catch (e) {
    fail(sheet, 3, (e as Error).message);
  }

  const width = Math.max(0, ...sheet.rows.map((row) => row.length));
  const columns: PeriodColumn[] = [];
  let periodToDate: number | null = null;
  for (let c = 2; c <= width; c++) {
    const label = cellAt(sheet, 5, c);
    const p = monthFromLabel(label);
    if (p !== null) pushPeriodColumn(sheet, columns, c, p);
    else if (/period to date/i.test(str(label) ?? '')) periodToDate = c;
  }
  if (columns.length === 0) {
    if (range.kind === 'month') columns.push({ col: 2, period: range.period });
    else if (periodToDate !== null && range.period !== null) columns.push({ col: periodToDate, period: range.period });
    else if (periodToDate !== null) fail(sheet, 3, `"${periodLine}" is not a Jan-anchored window, so the Period to Date column has no period id`);
    else fail(sheet, 5, 'no month labels in row 5 and no single-month Period line');
  } else if (range.kind === 'range' && columns.length !== range.months) {
    fail(sheet, 5, `${columns.length} month column(s) but the Period line spans ${range.months} month(s)`);
  }

  const records: RawRecord[] = [];
  const ledger = new Ledger();
  const ignored: string[] = [];
  let group: string | null = null;
  const key = (g: string | null, period: string) => `${g ?? ''}\u0001${period}`;

  for (let r = 6; r <= sheet.rows.length; r++) {
    const aRaw = cellAt(sheet, r, 1);
    const a = str(aRaw);
    if (a === null) continue;
    if (records.length === 0 && EMPTY_SENTINEL.test(a)) {
      return { layout: 'CF', entity, periods: columns.map((c) => c.period), records: [], totalChecks: 0, ignoredHeaders: [], emptyReason: a };
    }
    const values = columns.map((pc) => num(cellAt(sheet, r, pc.col)));
    const hasNum = values.some((v) => v !== null);
    // Indentation is not a reliable signal in Yardi exports (accounts sit at 4 or 6 spaces, group
    // headers at 1 or 4, the closing "    CASH FLOW" / "    TOTAL ADJUSTMENTS" lines at 4): the label
    // and the presence of numbers decide. A computed label is a total; a label with no numbers is a
    // header (ALL-CAPS -> group, mixed case -> ignored); anything else with numbers is an account.
    if (CF_COMPUTED_LABEL.test(a)) {
      const totalOf = /^TOTAL\s+(.+)$/.exec(a)?.[1] ?? null;
      for (const [i, pc] of columns.entries()) {
        const amount: number = values[i] ?? 0; // a blank month on a total line is a zero total
        if (totalOf !== null && group !== null && totalOf === group) ledger.check(sheet, r, key(group, pc.period), a, amount, ` (${pc.period})`);
        records.push({ entity, period: pc.period, layout: 'CF', section: null, group, account: a, amount, isTotal: true });
      }
      continue;
    }
    if (!hasNum) {
      if (isAllCaps(a)) group = a;
      else ignored.push(a);
      continue;
    }
    if (group === null) fail(sheet, r, `account "${a}" appears before any group header`);
    for (const [i, pc] of columns.entries()) {
      const amount = values[i] ?? 0; // a blank month on an account line is a zero posting
      ledger.add(key(group, pc.period), amount);
      records.push({ entity, period: pc.period, layout: 'CF', section: null, group, account: a, amount, isTotal: false });
    }
  }
  if (records.length === 0) fail(sheet, null, 'no account rows found');
  return { layout: 'CF', entity, periods: columns.map((c) => c.period), records, totalChecks: ledger.checks, ignoredHeaders: ignored, emptyReason: null };
}

// -------------------------------------------------------------------------------------------------
// Layout A12 — AppFolio 12-month recap (month columns from row 5; expenses positive)
// -------------------------------------------------------------------------------------------------

export function parseRecap12(sheet: SheetSource, entity: string): ParsedStatement {
  if (findInRow(sheet, 1, (x) => x === 'Profit & Loss 12 Month Recap') === null) fail(sheet, 1, 'expected "Profit & Loss 12 Month Recap" in row 1');
  const width = Math.max(0, ...sheet.rows.map((row) => row.length));
  const columns: PeriodColumn[] = [];
  for (let c = 2; c <= width; c++) {
    const p = monthFromLabel(cellAt(sheet, 5, c));
    if (p !== null) pushPeriodColumn(sheet, columns, c, p);
  }
  if (columns.length === 0) fail(sheet, 5, 'no month labels ("OCT 25") in row 5');
  return parseAppFolioFamily(sheet, entity, 'A12', columns);
}

// -------------------------------------------------------------------------------------------------
// Layout QB — QuickBooks entity statement
// -------------------------------------------------------------------------------------------------

const QB_SECTIONS: ReadonlySet<string> = new Set(['Income', 'Expense', 'Other Income', 'Other Expense']);

/** "Jan - Dec 24" -> 2024-FY; "Jan 1 - Jun 12, 26" -> 2026-YTD(thru 2026-06-12). */
export function periodFromQuickBooksHeader(text: string): string | null {
  const fy = /^Jan\s*-\s*Dec\s+(\d{2}|\d{4})$/.exec(text.trim());
  if (fy) return `${fullYear(Number(fy[1]))}-FY`;
  const ytd = /^Jan\s+1\s*-\s*([A-Za-z]{3})\s+(\d{1,2}),\s*(\d{2}|\d{4})$/.exec(text.trim());
  if (ytd) {
    const m = MONTHS[ytd[1]!.toLowerCase()];
    if (m === undefined) return null;
    const y = fullYear(Number(ytd[3]));
    const d = Number(ytd[2]);
    if (m === 12 && d === 31) return `${y}-FY`;
    return `${y}-YTD(thru ${ymd(y, m, d)})`;
  }
  return null;
}

interface QbHeader {
  readonly depth: number;
  readonly label: string;
  sum: number;
}

/** section = nearest enclosing Income / Expense / Other * header; group = the nearest parent account inside it. */
function qbContext(headers: readonly QbHeader[]): { section: string | null; group: string | null } {
  let at = -1;
  for (let i = headers.length - 1; i >= 0; i--) {
    if (QB_SECTIONS.has(headers[i]!.label)) {
      at = i;
      break;
    }
  }
  if (at < 0) return { section: null, group: null };
  const inner = headers.slice(at + 1);
  return { section: headers[at]!.label, group: inner.length > 0 ? inner[inner.length - 1]!.label : null };
}

export function parseQuickBooks(sheet: SheetSource, entity: string): ParsedStatement {
  const header = sheet.rows[0] ?? [];
  let amountCol: number | null = null;
  let period: string | null = null;
  for (const [i, v] of header.entries()) {
    const s = str(v);
    if (s === null) continue;
    const p = periodFromQuickBooksHeader(s);
    if (p === null) continue;
    if (amountCol !== null) fail(sheet, 1, 'more than one period header in row 1');
    amountCol = i + 1;
    period = p;
  }
  if (amountCol === null || period === null) fail(sheet, 1, 'no QuickBooks period header ("Jan - Dec 24" / "Jan 1 - Jun 12, 26") in row 1');

  const records: RawRecord[] = [];
  const stack: QbHeader[] = [];
  let checks = 0;
  for (let r = 2; r <= sheet.rows.length; r++) {
    const row = sheet.rows[r - 1] ?? [];
    let col = 0;
    let label: string | null = null;
    for (let c = 1; c < amountCol; c++) {
      const s = str(row[c - 1] ?? null);
      if (s !== null) {
        col = c;
        label = s;
        break;
      }
    }
    if (label === null) continue;
    const amount = num(row[amountCol - 1] ?? null);
    const popped: QbHeader[] = [];
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= col) popped.push(stack.pop()!);

    const totalOf = /^Total\s+(.+)$/.exec(label)?.[1] ?? null;
    if (totalOf !== null) {
      if (amount === null) fail(sheet, r, `"${label}" has no amount`);
      const closed = popped.find((h) => h.label === totalOf) ?? stack.find((h) => h.label === totalOf);
      if (!closed) fail(sheet, r, `"${label}" closes a header that was never opened`);
      if (!ties(amount, closed.sum)) fail(sheet, r, `"${label}" states ${money(amount)} but its accounts sum to ${money(closed.sum)}`);
      checks++;
      // A total carries the context of the header it closes (so "Total Tax" sits in Expense / Tax).
      const ctx = qbContext(stack.includes(closed) ? stack.slice(0, stack.indexOf(closed) + 1) : [...stack, closed]);
      records.push({ entity, period, layout: 'QB', section: ctx.section, group: ctx.group, account: label, amount, isTotal: true });
      continue;
    }
    if (amount === null) {
      stack.push({ depth: col, label, sum: 0 });
      continue;
    }
    const { section, group } = qbContext(stack);
    if (section === null) {
      if (/^(Net |Gross )/.test(label)) {
        records.push({ entity, period, layout: 'QB', section: null, group: null, account: label, amount, isTotal: true });
        continue;
      }
      fail(sheet, r, `account "${label}" is not inside an Income / Expense / Other Income / Other Expense section`);
    }
    for (const h of stack) h.sum += amount;
    records.push({ entity, period, layout: 'QB', section, group, account: label, amount, isTotal: false });
  }
  if (records.some((x) => !x.isTotal) === false) fail(sheet, null, 'no account rows found');
  return { layout: 'QB', entity, periods: [period], records, totalChecks: checks, ignoredHeaders: [], emptyReason: null };
}

// -------------------------------------------------------------------------------------------------
// Dispatch
// -------------------------------------------------------------------------------------------------

/** Recognise a layout from its title cells; null for anything else (including the AppFolio "Cash Flow" annual variant). */
export function detectLayout(sheet: SheetSource): StatementLayout | null {
  if (findInRow(sheet, 1, (x) => x === 'Profit & Loss') !== null) return 'AF';
  if (findInRow(sheet, 1, (x) => x === 'Profit & Loss 12 Month Recap') !== null) return 'A12';
  const a2 = str(cellAt(sheet, 2, 1));
  if (a2 === 'Statement (12 months)' || a2 === 'Cash Flow Statement') return 'CF';
  const header = sheet.rows[0] ?? [];
  if (header.some((v) => typeof v === 'string' && periodFromQuickBooksHeader(v) !== null)) return 'QB';
  return null;
}

const PARSERS: Readonly<Record<StatementLayout, (sheet: SheetSource, entity: string) => ParsedStatement>> = {
  AF: parseAppFolioPl,
  CF: parseCashFlow12,
  A12: parseRecap12,
  QB: parseQuickBooks,
};

export function parseStatement(sheet: SheetSource, opts: { readonly entity: string; readonly layout?: StatementLayout }): ParsedStatement {
  const detected = detectLayout(sheet);
  if (detected === null) {
    const title = str(cellAt(sheet, 1, 1)) ?? str(cellAt(sheet, 1, 2)) ?? str(cellAt(sheet, 2, 1)) ?? '(no title)';
    fail(sheet, null, `unsupported statement layout (title "${title}"); supported: AppFolio P&L, Yardi 12-month statement, AppFolio 12-month recap, QuickBooks statement`);
  }
  if (opts.layout !== undefined && opts.layout !== detected) fail(sheet, null, `expected layout ${opts.layout} but the sheet is ${detected}`);
  return PARSERS[detected](sheet, opts.entity);
}
