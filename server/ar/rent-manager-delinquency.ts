// server/ar/rent-manager-delinquency.ts
//
// Parser for the REAL Rent Manager "Delinquency (Detail)" export format ORA actually receives —
// an .xlsx workbook (NOT a PDF), one file per property or per portfolio, landing in
// `OneDrive - Oxford Capital Partners\Business\A.R. Reports\`. Confirmed against 5 of 8 live files
// there 2026-07-22 (1100 Rarig, 3034 Westerville, 3540 E 5th, 9620 State 350, Sepich Portfolio); the
// remaining 3 files are two OTHER distinct formats (a Yardi-style bucketed export and a 2-bucket
// "Northwood" variant) deliberately deferred to a follow-up — see the 2026-07-22 turn that
// discovered this mismatch. This is exactly the 'rent-manager-delinquency' format server/ar/ar-aging.ts
// already detects (from PDF-extracted text) and explicitly REFUSES to parse, citing: "Rent Manager
// 'Delinquency (Detail)' carries no aging buckets — arrears must be computed from per-charge dates (a
// separate increment)." This module is that increment, built for the real .xlsx shape, not a PDF.
//
// REPORT SHAPE (verified against 5 real files, 2026-07-22):
//   B1: "Delinquency (Detail)"
//   B2: "Property: {name}"  OR  "All Properties" (a portfolio-wide file, e.g. Sepich Portfolio)
//   B3: "Current tenants as of {MM/DD/YY}"  <- the file's own as-of date; MORE RELIABLE than a
//       filename-derived date (server/ar/ar-aging.ts's extractAsOfDateFromFilename), since it is
//       printed by the report itself rather than inferred from whatever the exporter named the file.
//   row with 'Tenant Name' in it: column headers (C=Tenant Name, D=Acct, F=Unit, H=Unit Type,
//       K=Rent Amount, L=Other Amount, M=Charge, P=Date, Q=Per Day Late)
//   Then repeating: a PROPERTY-HEADER row (col A only, e.g. "2000 Zettler Rd") -> one or more TENANT
//   BLOCKS -> a "Total Delinquent for Property:" row -> next property-header (or, for a
//   single-property file, straight to a "Report Summary" section that must be ignored entirely).
//
//   A TENANT BLOCK is: a first row carrying identity (Tenant Name/Acct/Unit/Unit Type) PLUS that
//   tenant's first charge (Charge type + Date + an amount in EITHER the Rent Amount OR Other Amount
//   column — never both), zero or more pure continuation charge rows (same amount/Charge/Date shape,
//   no identity columns), and a closing SUBTOTAL row (Rent Amount total + Other Amount total, NO
//   Charge/Date). Critically: **none of these rows carry an aging bucket** — every charge is a flat
//   dollar amount on a Date. This module computes (asOfDate - chargeDate) in days per charge and buckets
//   that charge's dollar amount into d30/d60/d90/d90plus, summing across a tenant's whole block. The
//   file's own subtotal row (Rent total + Other total) is used ONLY as a cross-check against the
//   summed buckets — never as the source of truth for the split, since the file doesn't state one.

import type ExcelJS from 'exceljs';
import type { ArAgingRow } from './ar-aging';

/** One physical row's relevant columns, extracted from the worksheet — decoupled from ExcelJS so the
 *  actual parsing/bucketing logic below is pure and unit-testable with plain array fixtures. */
export interface RmDetailCell {
  /** Column A — populated ONLY on a property-header row (e.g. "2000 Zettler Rd") or a
   *  "Total Delinquent for Property:" / "Report Summary" marker row. */
  colA: string | null;
  tenantName: string | null; // column C
  rentAmount: number | null; // column K
  otherAmount: number | null; // column L
  charge: string | null; // column M
  date: Date | null; // column P
}

export interface SubtotalMismatch {
  tenant: string;
  property: string | null;
  computedTotal: number;
  reportedTotal: number;
}

export interface RentManagerParseResult {
  rows: ArAgingRow[];
  /** Never null on a well-formed file, but a caller MUST check this — see the module doc above:
   *  without it, no per-charge age can be computed at all. */
  asOfDate: Date | null;
  /** Set when asOfDate could not be determined, or the sheet has no recognizable tenant blocks at
   *  all — never a silent empty result, matching server/ar/ar-aging.ts's ParseArResult contract. */
  unsupportedReason?: string;
  /** Per-tenant cross-check failures: the sum of this module's own computed buckets disagreed with
   *  the file's own printed subtotal for that tenant. Non-fatal (the computed buckets are still used
   *  — they are the only source with dates to bucket by), but surfaced so a human can investigate a
   *  parsing gap rather than trust a silently-wrong number. */
  subtotalMismatches: SubtotalMismatch[];
}

/** A past-due bucket is never negative: a credit/prepayment nets to 0 — mirrors ar-aging.ts's own
 *  `bucket()` helper and coerceNonNegMoney's established philosophy for this entire feature. */
function nonNeg(n: number): number {
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** Whole days between two dates, ignoring time-of-day (both inputs are already midnight-normalized
 *  Dates from ExcelJS date cells). Positive = date is BEFORE reference (i.e. how many days past due). */
function daysBefore(reference: Date, date: Date): number {
  const MS_PER_DAY = 24 * 60 * 60 * 1000;
  return Math.round((reference.getTime() - date.getTime()) / MS_PER_DAY);
}

/** Bucket semantics match ar-aging.ts's documented contract (d30=1-30, d60=31-60, d90=61-90,
 *  d90plus=90+), with the observed real-report convention of an inclusive "0-30" first bucket — a
 *  charge dated ON or shortly AFTER the as-of date (age <= 0, e.g. a same-day rent charge) is
 *  "current, not yet 30 days old", not omitted or negative-bucketed. */
type BucketKey = 'd30' | 'd60' | 'd90' | 'd90plus';
function bucketForAge(ageDays: number): BucketKey {
  if (ageDays <= 30) return 'd30';
  if (ageDays <= 60) return 'd60';
  if (ageDays <= 90) return 'd90';
  return 'd90plus';
}

/** Extract the as-of date from row 3's text, e.g. "Current tenants as of 07/15/26". Returns null
 *  (never throws) when the phrase is absent, malformed, or the date doesn't round-trip (e.g. 13/45/26
 *  — matches server/ar/ar-aging.ts's extractAsOfDateFromFilename's own round-trip-validation style). */
export function parseAsOfDateFromText(text: string | null | undefined): Date | null {
  if (!text) return null;
  const m = text.match(/as of\s+(\d{1,2})\/(\d{1,2})\/(\d{2,4})/i);
  if (!m) return null;
  const mm = Number(m[1]);
  const dd = Number(m[2]);
  const yy = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
  const d = new Date(Date.UTC(yy, mm - 1, dd));
  const roundTrips = d.getUTCFullYear() === yy && d.getUTCMonth() === mm - 1 && d.getUTCDate() === dd;
  return roundTrips ? d : null;
}

const TOTAL_FOR_PROPERTY_RE = /^total delinquent for property/i;
const REPORT_SUMMARY_RE = /^report summary/i;

/**
 * Pure parse of an already-extracted row array (see the module doc above for the exact state
 * machine). No I/O — the ExcelJS worksheet walk lives in parseRentManagerWorksheet below.
 */
export function parseRentManagerRows(cells: readonly RmDetailCell[], asOfDate: Date | null): RentManagerParseResult {
  if (asOfDate === null) {
    return {
      rows: [],
      asOfDate: null,
      unsupportedReason: 'Could not determine the report\'s "Current tenants as of" date — cannot compute per-charge aging without it.',
      subtotalMismatches: [],
    };
  }

  const rows: ArAgingRow[] = [];
  const subtotalMismatches: SubtotalMismatch[] = [];
  let curProperty: string | null = null;
  let curTenant: string | null = null;
  let curTenantProperty: string | null = null;
  let acc: Record<BucketKey, number> = { d30: 0, d60: 0, d90: 0, d90plus: 0 };

  function resetAcc(): void {
    acc = { d30: 0, d60: 0, d90: 0, d90plus: 0 };
  }

  /** Emit the currently-open tenant block as one ArAgingRow. No-op if no tenant is open. Called on
   *  every block boundary (subtotal row, next tenant, next property, end of sheet) so a tenant block
   *  missing its subtotal row (malformed export) still isn't silently dropped. */
  function flush(reportedTotal: number | null): void {
    if (curTenant === null) return;
    if (reportedTotal !== null) {
      const computedTotal = acc.d30 + acc.d60 + acc.d90 + acc.d90plus;
      // Float-safe: real exports carry cents, so compare to the nearest cent.
      if (Math.round((computedTotal - reportedTotal) * 100) !== 0) {
        subtotalMismatches.push({ tenant: curTenant, property: curTenantProperty, computedTotal, reportedTotal });
      }
    }
    rows.push({ tenant: curTenant, property: curTenantProperty, d30: acc.d30, d60: acc.d60, d90: acc.d90, d90plus: acc.d90plus });
    curTenant = null;
    resetAcc();
  }

  for (const cell of cells) {
    if (REPORT_SUMMARY_RE.test(cell.colA ?? '')) {
      flush(null); // defensive — should already be closed by a subtotal row
      break; // portfolio-wide grand-total section; nothing after this is per-tenant data
    }
    if (TOTAL_FOR_PROPERTY_RE.test(cell.colA ?? '')) {
      flush(null); // defensive
      continue;
    }
    if (cell.colA !== null && cell.tenantName === null && cell.charge === null && cell.date === null && cell.rentAmount === null && cell.otherAmount === null) {
      // Property-group-header row (e.g. "2000 Zettler Rd") — only col A populated.
      flush(null); // defensive — close any block left open by a malformed prior section
      curProperty = cell.colA;
      continue;
    }
    if (cell.tenantName !== null) {
      // Starts (or restarts) a tenant block. Flush whatever was open first.
      flush(null); // defensive; a well-formed file always closed the prior block via its subtotal row
      curTenant = cell.tenantName;
      curTenantProperty = curProperty;
      // Fall through: this row also carries the tenant's FIRST charge (real files combine both).
    }
    if (cell.charge !== null && cell.date !== null) {
      const amount = nonNeg(cell.rentAmount ?? cell.otherAmount ?? 0);
      const age = daysBefore(asOfDate, cell.date);
      acc[bucketForAge(age)] += amount;
      continue;
    }
    if (cell.charge === null && cell.date === null && (cell.rentAmount !== null || cell.otherAmount !== null)) {
      // Subtotal row closing the currently-open tenant block.
      const reportedTotal = (cell.rentAmount ?? 0) + (cell.otherAmount ?? 0);
      flush(reportedTotal);
      continue;
    }
    // Anything else (a stray blank row) is ignored.
  }
  flush(null); // defensive end-of-sheet close, in case the last block had no subtotal row

  return { rows, asOfDate, subtotalMismatches };
}

// ─── ExcelJS adapter (thin — the actual parsing logic above is pure and takes no ExcelJS type) ────

function cellString(v: ExcelJS.CellValue): string | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'string') return v.trim() || null;
  if (typeof v === 'number') return String(v);
  if (v instanceof Date) return null; // a date cell has no string reading relevant here
  if (typeof v === 'object' && 'richText' in v) return v.richText.map((t) => t.text).join('').trim() || null;
  if (typeof v === 'object' && 'text' in v) return String((v as { text: unknown }).text).trim() || null;
  if (typeof v === 'object' && 'result' in v) return cellString((v as { result: ExcelJS.CellValue }).result);
  return null;
}

function cellNumber(v: ExcelJS.CellValue): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/[$,]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'object' && v !== null && 'result' in v) return cellNumber((v as { result: ExcelJS.CellValue }).result);
  return null;
}

function cellDate(v: ExcelJS.CellValue): Date | null {
  if (v instanceof Date) return v;
  if (typeof v === 'object' && v !== null && 'result' in v) return cellDate((v as { result: ExcelJS.CellValue }).result);
  return null;
}

/** Detects the real report's title cell ('Delinquency (Detail)') anywhere in the first 3 rows —
 *  ORA's exports place it at B1, but this tolerates a shifted column without over-fitting to one
 *  exact coordinate. Returns false (never throws) for any other/unrecognized workbook. */
export function detectRentManagerDelinquencyDetail(ws: ExcelJS.Worksheet): boolean {
  for (let r = 1; r <= 3; r++) {
    for (let c = 1; c <= 5; c++) {
      if (cellString(ws.getCell(r, c).value) === 'Delinquency (Detail)') return true;
    }
  }
  return false;
}

interface ColumnMap {
  tenantName: number;
  rentAmount: number;
  otherAmount: number;
  charge: number;
  date: number;
}

/** Locates the header row (containing 'Tenant Name') and each named column's index within it,
 *  rather than hardcoding fixed column letters — cheap insurance against a future export-config
 *  change shifting a column, since (unlike the PDF-text-based Yardi/AppFolio parsers) an Excel file
 *  gives real cell coordinates to search. Returns null (never partial/guessed) if the header row or
 *  any required column isn't found within a reasonable scan window. */
function detectColumns(ws: ExcelJS.Worksheet): { headerRow: number; columns: ColumnMap } | null {
  const maxScanRow = Math.min(ws.rowCount || 10, 10);
  for (let r = 1; r <= maxScanRow; r++) {
    let tenantName = -1;
    let rentAmount = -1;
    let otherAmount = -1;
    let charge = -1;
    let date = -1;
    for (let c = 1; c <= 25; c++) {
      const label = cellString(ws.getCell(r, c).value);
      if (label === 'Tenant Name') tenantName = c;
      else if (label === 'Rent Amount') rentAmount = c;
      else if (label === 'Other Amount') otherAmount = c;
      else if (label === 'Charge') charge = c;
      else if (label === 'Date') date = c;
    }
    if (tenantName > 0 && rentAmount > 0 && otherAmount > 0 && charge > 0 && date > 0) {
      return { headerRow: r, columns: { tenantName, rentAmount, otherAmount, charge, date } };
    }
  }
  return null;
}

/**
 * Read a live ExcelJS worksheet holding a Rent Manager "Delinquency (Detail)" export and parse it
 * into ArAgingRow[] with computed aging buckets. This is the ONLY function in this module that
 * touches ExcelJS — everything else (parseRentManagerRows, parseAsOfDateFromText) is pure and
 * unit-tested with plain-array fixtures.
 */
export function parseRentManagerWorksheet(ws: ExcelJS.Worksheet): RentManagerParseResult {
  const cols = detectColumns(ws);
  if (cols === null) {
    return {
      rows: [],
      asOfDate: null,
      unsupportedReason: 'Could not find the expected column headers (Tenant Name / Rent Amount / Other Amount / Charge / Date) — sheet layout may have changed.',
      subtotalMismatches: [],
    };
  }
  // The as-of date line ("Current tenants as of MM/DD/YY") sits somewhere above the header row —
  // scan every cell in that span rather than assuming one fixed coordinate.
  let asOfDate: Date | null = null;
  for (let r = 1; r < cols.headerRow && asOfDate === null; r++) {
    for (let c = 1; c <= 5 && asOfDate === null; c++) {
      asOfDate = parseAsOfDateFromText(cellString(ws.getCell(r, c).value));
    }
  }

  const cells: RmDetailCell[] = [];
  const lastRow = ws.rowCount || 0;
  for (let r = cols.headerRow + 1; r <= lastRow; r++) {
    const row = ws.getRow(r);
    const colA = cellString(row.getCell(1).value);
    let tenantName = cellString(row.getCell(cols.columns.tenantName).value);
    // Merged-cell artifact (verified against the real 1100 Rarig file, 2026-07-22): a label row
    // (property header, "Total Delinquent for Property:", "Report Summary", the summary detail
    // lines) merges its text across columns A through at least the tenant-name column, so ExcelJS's
    // per-cell `.value` echoes the SAME string into every merged column — not a real, distinct
    // tenant name. A genuine tenant detail row never populates column A at all, so this cannot
    // false-positive on real data: nullify tenantName whenever it exactly matches colA.
    if (colA !== null && tenantName === colA) tenantName = null;
    cells.push({
      colA,
      tenantName,
      rentAmount: cellNumber(row.getCell(cols.columns.rentAmount).value),
      otherAmount: cellNumber(row.getCell(cols.columns.otherAmount).value),
      charge: cellString(row.getCell(cols.columns.charge).value),
      date: cellDate(row.getCell(cols.columns.date).value),
    });
  }
  return parseRentManagerRows(cells, asOfDate);
}
