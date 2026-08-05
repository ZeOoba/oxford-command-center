/**
 * OI-092 — next-12-month debt-service cross-check.
 *
 * WHY THIS SHAPE. The first attempt (`debt-service-window.ts`, withdrawn before shipping)
 * counted amortization-schedule rows falling inside a window it computed itself, and asserted
 * the count was 12. Independent review and an adversarial REFUTE pass both found it could not
 * detect the defect it was built for: reverting `External Loans Summary!H9` to the buggy
 * `SUMPRODUCT((dates>=TODAY())*(dates<TODAY()+366)*amount)` left its output byte-identical —
 * all clean — while annual debt service re-inflated to $297,950.51. It asserted a property of
 * the schedule DATA; the bug lived in the FORMULA, which it never read.
 *
 * So this is a CROSS-CHECK of two independent computations:
 *
 *   (a) recompute next-12-month interest + principal directly from the full amortization
 *       schedule, and
 *   (b) compare it against the workbook's own cached `External Loans Summary` H/I.
 *
 * Divergence is the signal. Because (a) never consults the formula's declared range or column
 * choice, that single comparison catches a wrong window (OI-092), a truncated range (OI-094),
 * and a wrong column mapping alike — none of which the count-only shape could see.
 *
 * Two independence rules make it work, and both are load-bearing:
 *   1. Columns are resolved from each schedule sheet's OWN header row, never hardcoded to
 *      mirror the formula. The six real sheets genuinely disagree on layout (29000 Information
 *      Lane puts Principal in C and Interest in D; every other sheet is the other way round),
 *      so a hardcoded map both rots and hides the exact defect class it should catch.
 *   2. The schedule's extent is discovered by scanning until the dated rows stop — NOT by
 *      reading the formula's declared range. Mirroring the range would reproduce OI-094's
 *      one-row truncation and report it clean.
 *
 * Severity is `warn`, per Gabriel's ruling: this reports on a workbook it does not control,
 * and a blocking flag would stop legitimate refreshes on defects only he can fix.
 */
import type { Worksheet } from 'exceljs';
import type { DataQualityFlag } from '../../src/contracts/index';

/** Money comparison tolerance. Well under any real payment, well over float noise. */
const TOLERANCE = 0.5;

/** One row of an amortization schedule, already column-resolved. */
export interface ScheduleRow {
  /** 1-based worksheet row, retained so flags can name the offending cell. */
  row: number;
  date: Date;
  interest: number | null;
  principal: number | null;
  /** Remaining balance, used for the independent principal reconciliation. */
  balance: number | null;
}

export interface CrossCheckInput {
  id: string;
  /** The FULL schedule as independently scanned — not bounded by the formula's range. */
  rows: ScheduleRow[];
  /** Last row the ELS formula actually sums, or null when it could not be determined. */
  declaredRangeEnd: number | null;
  /** Oxford-share multiplier applied by the formula (1.0 or 0.5). */
  share: number;
  bookInterest: number;
  /** null when the workbook's principal is synthetic (485 S Walnut: I16 = D16-E16). */
  bookPrincipal: number | null;
  asOf: Date;
}

/**
 * Excel `EDATE` semantics: add whole months, clamping the day to the target month's last day
 * rather than overflowing. EDATE(2026-08-31, 6) = 2027-02-28, not 2027-03-03.
 *
 * Retained from the withdrawn draft — the one piece of it that survived review. It was
 * differentially verified against Excel over 1990-2060 with 0 mismatches, negative months and
 * leap-February clamping both correct.
 */
export function edateMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const targetY = y + Math.floor(m / 12);
  const targetM = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetY, targetM + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetY, targetM, Math.min(d.getUTCDate(), lastDay)));
}

export interface ScheduleColumns {
  date?: string;
  interest?: string;
  principal?: string;
  balance?: string;
}

/**
 * Resolve schedule columns from a header row's own labels.
 *
 * Deliberately strict about "Interest Paid" vs "Payment Amount": a prototype of this check
 * guessed 29000 Information Lane's interest column as B ("Payment Amount") and over-reported
 * that loan by $54,895.55 — a false positive that would have read as a real workbook defect.
 */
export function resolveScheduleColumns(header: Record<string, string>): ScheduleColumns {
  const out: ScheduleColumns = {};
  for (const [col, raw] of Object.entries(header)) {
    const label = String(raw ?? '').trim().toLowerCase();
    if (label === 'payment date') out.date = col;
    else if (label === 'interest paid') out.interest = col;
    else if (label === 'principal paid' || label === 'principal reduction') out.principal = col;
    else if (label.startsWith('remaining balance')) out.balance ??= col;
  }
  return out;
}

const money = (n: number): string =>
  n.toLocaleString('en-US', { style: 'currency', currency: 'USD' });

/**
 * Cross-check one loan. Returns a flag per independent failure, or [] when everything
 * reconciles. Never throws on malformed input — a loan it cannot evaluate is reported, not
 * silently skipped (a verified null beats an inferred one).
 */
export function crossCheckSchedule(input: CrossCheckInput): DataQualityFlag[] {
  const { id, rows, declaredRangeEnd, share, bookInterest, bookPrincipal, asOf } = input;
  const flags: DataQualityFlag[] = [];

  if (rows.length === 0) {
    return [{
      entity: id,
      field: 'annualDebtService',
      issue: 'no amortization-schedule rows resolved — cross-check could not run',
      severity: 'warn',
    }];
  }

  const end = edateMonths(asOf, 12);
  const inWindow = rows.filter((r) => r.date > asOf && r.date <= end);

  // ── 1. total cross-check: our recomputation vs the workbook's own cached figure ──────────
  // Compares principal only when the workbook's principal is genuinely schedule-derived.
  const comparePrincipal = bookPrincipal !== null;
  const recomputed =
    inWindow.reduce(
      (s, r) => s + Math.abs(r.interest ?? 0) + (comparePrincipal ? Math.abs(r.principal ?? 0) : 0),
      0,
    ) * share;
  const book = Math.abs(bookInterest) + (comparePrincipal ? Math.abs(bookPrincipal) : 0);
  const delta = recomputed - book;

  if (Math.abs(delta) > TOLERANCE) {
    const payments = inWindow.length;
    flags.push({
      entity: id,
      field: 'annualDebtService',
      issue:
        `next-12-month debt service diverges from the schedule: workbook reports ${money(book)}, ` +
        `recomputing ${payments} scheduled payment(s) over (${iso(asOf)}, ${iso(end)}] gives ` +
        `${money(recomputed)} — a difference of ${money(delta)}. ` +
        `A difference close to one payment usually means the summing window captured 13 payments ` +
        `instead of 12 (OI-092); other magnitudes point at a truncated range or a mis-mapped column.`,
      rawValue: String(book),
      severity: 'warn',
    });
  }

  // ── 2. declared range vs the schedule's true extent (OI-094) ─────────────────────────────
  // Structural: fires even when today's delta is zero, because the excluded rows are simply
  // outside the current window. Banwick's excluded row 71 carries a $3.35M balloon that only
  // starts to matter around mid-2030 — by which point nothing would be watching.
  if (declaredRangeEnd !== null) {
    const lastRow = Math.max(...rows.map((r) => r.row));
    if (lastRow > declaredRangeEnd) {
      const excluded = rows.filter((r) => r.row > declaredRangeEnd);
      const amount = excluded.reduce(
        (s, r) => s + Math.abs(r.interest ?? 0) + Math.abs(r.principal ?? 0),
        0,
      );
      flags.push({
        entity: id,
        field: 'scheduleRange',
        issue:
          `the summing range is truncated: it ends at row ${declaredRangeEnd} but the schedule ` +
          `runs to row ${lastRow}. ${excluded.length} dated row(s) totalling ${money(amount)} ` +
          `(through ${iso(excluded[excluded.length - 1]!.date)}) can never be summed. ` +
          `Harmless only while those rows sit outside the forward window.`,
        rawValue: String(declaredRangeEnd),
        severity: 'warn',
      });
    }
  }

  // ── 3. duplicate payment dates (the 485 S Walnut double-count) ───────────────────────────
  // A date-predicate SUMPRODUCT sums every matching ROW, so two rows sharing a date are both
  // captured. At 485 S Walnut the final regular payment and the payoff row both carry
  // 2028-09-26, double-counting $1,365 of September interest.
  const byDate = new Map<number, ScheduleRow[]>();
  for (const r of inWindow) {
    const k = r.date.getTime();
    byDate.set(k, [...(byDate.get(k) ?? []), r]);
  }
  for (const [, dupes] of byDate) {
    if (dupes.length < 2) continue;
    const contributing = dupes.filter((r) => (r.interest ?? 0) !== 0 || (r.principal ?? 0) !== 0);
    if (contributing.length < 2) continue; // annotation rows carry no amounts — not a double-count
    flags.push({
      entity: id,
      field: 'duplicatePaymentDate',
      issue:
        `${contributing.length} schedule rows share the payment date ${iso(dupes[0]!.date)} ` +
        `(rows ${contributing.map((r) => r.row).join(', ')}), and each carries an amount. ` +
        `A date-predicate sum captures all of them, double-counting that payment.`,
      rawValue: iso(dupes[0]!.date),
      severity: 'warn',
    });
  }

  // ── 4. principal reconciliation against the remaining-balance column ─────────────────────
  // The one check that can see a balloon parked outside the principal column. Restoration
  // Church Trust's $1,945,102.73 balloon sits in PAYMENT AMOUNT, so a principal-column sum
  // misses it and the workbook and a naive recomputation agree while both understate Oxford's
  // returning capital by $972,551. Only the balance column exposes it.
  if (comparePrincipal) {
    const first = inWindow[0];
    const lastWithBalance = [...inWindow].reverse().find((r) => r.balance !== null);
    if (first && lastWithBalance && first.balance !== null) {
      // Balance entering the window = first in-window row's closing balance + its own principal.
      const opening = first.balance + Math.abs(first.principal ?? 0);
      const retired = opening - lastWithBalance.balance!;
      const summed = inWindow.reduce((s, r) => s + Math.abs(r.principal ?? 0), 0);
      const gap = retired - summed;
      if (Math.abs(gap) > TOLERANCE) {
        flags.push({
          entity: id,
          field: 'principalReconciliation',
          issue:
            `principal retired per the remaining-balance column (${money(retired)}) does not match ` +
            `the principal column summed over the same window (${money(summed)}) — ` +
            `${money(gap)} unaccounted for. A gap this shape usually means a balloon or payoff ` +
            `recorded outside the principal column, so it is invisible to the workbook's own sum.`,
          rawValue: String(gap),
          severity: 'warn',
        });
      }
    }
  }

  return flags;
}

function iso(d: Date): string {
  return d.toISOString().slice(0, 10);
}

// ── worksheet-facing helpers ─────────────────────────────────────────────────────────────────

const COLUMNS = 'ABCDEFGH'.split('');

function cellText(ws: Worksheet, col: string, row: number): string | null {
  const v = ws.getCell(`${col}${row}`).value;
  if (v === null || v === undefined) return null;
  if (typeof v === 'object' && 'result' in v) return v.result == null ? null : String(v.result);
  return String(v);
}

function cellNumber(ws: Worksheet, col: string, row: number): number | null {
  const v = ws.getCell(`${col}${row}`).value;
  const raw = v && typeof v === 'object' && 'result' in v ? v.result : v;
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function cellDate(ws: Worksheet, col: string, row: number): Date | null {
  const v = ws.getCell(`${col}${row}`).value;
  const raw = v && typeof v === 'object' && 'result' in v ? v.result : v;
  return raw instanceof Date && !Number.isNaN(raw.getTime()) ? raw : null;
}

/** Read a header row's labels into the shape `resolveScheduleColumns` expects. */
export function readHeader(ws: Worksheet, headerRow: number): Record<string, string> {
  const out: Record<string, string> = {};
  for (const c of COLUMNS) {
    const t = cellText(ws, c, headerRow);
    if (t) out[c] = t;
  }
  return out;
}

/**
 * Discover the schedule's TRUE extent by walking down from `firstRow` until the dated rows
 * stop. Deliberately independent of the formula's declared range — that independence is what
 * lets the truncation check work at all.
 *
 * `gapTolerance` spans the blank/among-section rows the real sheets carry (rate-phase banners
 * and the like) without running off into unrelated content further down the sheet.
 */
export function scanSchedule(
  ws: Worksheet,
  cols: ScheduleColumns,
  firstRow: number,
  opts: { maxProbe?: number; gapTolerance?: number } = {},
): ScheduleRow[] {
  const maxProbe = opts.maxProbe ?? 400;
  const gapTolerance = opts.gapTolerance ?? 6;
  if (!cols.date) return [];

  const rows: ScheduleRow[] = [];
  let gap = 0;
  for (let r = firstRow; r < firstRow + maxProbe; r++) {
    const date = cellDate(ws, cols.date, r);
    if (!date) {
      gap += 1;
      if (gap > gapTolerance && rows.length) break;
      continue;
    }
    gap = 0;
    rows.push({
      row: r,
      date,
      interest: cols.interest ? cellNumber(ws, cols.interest, r) : null,
      principal: cols.principal ? cellNumber(ws, cols.principal, r) : null,
      balance: cols.balance ? cellNumber(ws, cols.balance, r) : null,
    });
  }
  return rows;
}

export interface ElsFormulaRef {
  sheet: string;
  dateCol: string;
  rangeStart: number;
  rangeEnd: number;
  share: number;
}

/**
 * Extract the sheet, date column, declared row range and Oxford-share multiplier from an
 * `External Loans Summary` H/I formula.
 *
 * Reading the range from the formula (rather than hardcoding it, as the withdrawn draft's
 * SCHEDULE_SOURCES did) is what keeps the truncation check honest as the workbook evolves:
 * the declared range is the thing under test, so it must be observed, not assumed.
 */
export function parseElsFormula(formula: string | null | undefined): ElsFormulaRef | null {
  if (!formula) return null;
  const m = /'([^']+)'!\$?([A-H])\$?(\d+):\$?[A-H]\$?(\d+)/.exec(formula);
  if (!m) return null;
  const share = /\)\s*\*\s*0\.5\s*$/.test(formula.trim()) ? 0.5 : 1;
  return {
    sheet: m[1]!,
    dateCol: m[2]!,
    rangeStart: Number(m[3]),
    rangeEnd: Number(m[4]),
    share,
  };
}

function formulaOf(ws: Worksheet, addr: string): string | null {
  const v = ws.getCell(addr).value;
  return v && typeof v === 'object' && 'formula' in v ? String(v.formula) : null;
}

/** Rows of `External Loans Summary` that carry per-loan H/I figures (11 is a SUM subtotal). */
const ELS_LOAN_ROWS = [6, 7, 8, 9, 10, 14, 15, 16];

/**
 * Run the cross-check across every `External Loans Summary` loan row that is backed by an
 * amortization schedule.
 *
 * Rows whose H/I are computed arithmetically rather than from a schedule (H10 = G10*E10 for the
 * LAST Non note, H14 for the 1100 Rarig demand note, I16's synthetic D16-E16) have nothing to
 * cross-check against and are skipped — not flagged. Skipping them is safe precisely because
 * they never depended on the summing window that carried the defect.
 */
export function crossCheckDebtService(
  wb: { getWorksheet(name: string): Worksheet | undefined },
  asOf?: Date,
): DataQualityFlag[] {
  const els = wb.getWorksheet('External Loans Summary');
  if (!els) {
    return [{
      entity: 'meta',
      field: 'annualDebtService',
      issue: 'worksheet "External Loans Summary" not found — debt-service cross-check did not run',
      severity: 'warn',
    }];
  }

  // The window is anchored on the workbook's own "Loan As-Of Date" (Assumptions!B30), the same
  // cell the H/I formulas anchor on. Deriving it any other way would compare two windows rather
  // than two computations of the same window.
  const resolvedAsOf = asOf ?? readLoanAsOf(wb);
  if (!resolvedAsOf) {
    return [{
      entity: 'meta',
      field: 'annualDebtService',
      issue:
        'could not read the Loan As-Of Date (Assumptions!B30) — debt-service cross-check did not run. ' +
        'Reported rather than defaulted: a wrong anchor would silently compare two different windows.',
      severity: 'warn',
    }];
  }

  const flags: DataQualityFlag[] = [];
  for (const r of ELS_LOAN_ROWS) {
    const interestRef = parseElsFormula(formulaOf(els, `H${r}`));
    if (!interestRef) continue; // arithmetic row, no schedule to cross-check
    const principalRef = parseElsFormula(formulaOf(els, `I${r}`));

    const sheet = wb.getWorksheet(interestRef.sheet);
    if (!sheet) {
      flags.push({
        entity: `els-row-${r}`,
        field: 'annualDebtService',
        issue: `schedule sheet "${interestRef.sheet}" referenced by H${r} not found — cross-check did not run for this loan`,
        severity: 'warn',
      });
      continue;
    }

    // The header sits immediately above the formula's first data row on all six schedules.
    const cols = resolveScheduleColumns(readHeader(sheet, interestRef.rangeStart - 1));
    if (!cols.date || !cols.interest) {
      flags.push({
        entity: interestRef.sheet,
        field: 'annualDebtService',
        issue:
          `could not resolve ${!cols.date ? 'a "Payment Date"' : 'an "Interest Paid"'} column from ` +
          `row ${interestRef.rangeStart - 1} — cross-check did not run for this loan`,
        severity: 'warn',
      });
      continue;
    }

    const bookInterest = cellNumber(els, 'H', r) ?? 0;
    const bookPrincipal = principalRef ? cellNumber(els, 'I', r) : null;

    flags.push(
      ...crossCheckSchedule({
        id: String(cellText(els, 'B', r) ?? interestRef.sheet),
        rows: scanSchedule(sheet, cols, interestRef.rangeStart),
        declaredRangeEnd: interestRef.rangeEnd,
        share: interestRef.share,
        bookInterest,
        bookPrincipal,
        asOf: resolvedAsOf,
      }),
    );
  }
  return flags;
}

/** Read the workbook's own "Loan As-Of Date" (Assumptions!B30). Null when unreadable. */
export function readLoanAsOf(wb: {
  getWorksheet(name: string): Worksheet | undefined;
}): Date | null {
  const ws = wb.getWorksheet('Assumptions');
  if (!ws) return null;
  return cellDate(ws, 'B', 30);
}
