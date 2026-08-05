/**
 * Annual-debt-service window integrity check (OI-092).
 *
 * `External Loans Summary` derives each loan's next-12-month interest and principal by
 * summing its amortization schedule over a date window. That window used to be
 * `[TODAY(), TODAY()+366)` — a half-open 366-day span, which on a loan's payment
 * day-of-month captured BOTH this month's payment and next year's anniversary payment:
 * 13 payments instead of 12. Annual debt service was inflated by exactly one payment and
 * DSCR correspondingly depressed (Banwick / Morrison: $REDACTED-AMT vs. the true
 * $REDACTED-AMT, DSCR 2.641 vs. 2.861). It fired ~6 days per loan per year and self-corrected
 * the next day, so it never looked like a persistent defect.
 *
 * The workbook now uses `(Assumptions!B30, EDATE(Assumptions!B30,12)]` anchored on
 * month-end, which makes the payment-day coincidence structurally impossible. This module
 * is the independent check on that invariant: count the schedule rows the window actually
 * covers and assert it is exactly 12.
 *
 * WHY A COUNT, AND NOT THE "REPEATING DECIMAL" SIGNATURE: an inflated annual ÷ 12 does
 * produce a long repeating decimal (REDACTED-AMT), but so do several perfectly
 * correct loans — `9050 Red Branch` carries a half-cent from its `*0.5` Oxford-share
 * multiplier, and `3883 from Oxford` has no amortization schedule at all (its interest is
 * rate x balance), so its "monthly payment" is a synthetic annual÷12 and is *always*
 * repeating. That signature fires on 6 of 11 loans, every one of them correct. The payment
 * count tests the actual invariant instead.
 *
 * Severity is `warn`, not `error` (Gabriel, 2026-08-05): a blocking flag here would gate
 * legitimate refreshes on a schedule-shape surprise, and the structural fix already closes
 * the original recurrence path.
 */

import type { Worksheet } from 'exceljs';
import type { DataQualityFlag } from '@contracts/index';

/** Payments expected in a full forward-12-month window. */
const EXPECTED_PAYMENTS = 12;

/**
 * Excel `EDATE` semantics: add whole months, clamping the day to the target month's last
 * day rather than overflowing. EDATE(2026-08-31, 6) = 2027-02-28, not 2027-03-03.
 */
export function edateMonths(d: Date, months: number): Date {
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + months;
  const targetY = y + Math.floor(m / 12);
  const targetM = ((m % 12) + 12) % 12;
  const lastDay = new Date(Date.UTC(targetY, targetM + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetY, targetM, Math.min(d.getUTCDate(), lastDay)));
}

/** Valid `Date` values only — schedule columns carry blanks, labels and formula shells. */
function validDates(dates: readonly unknown[]): Date[] {
  return dates.filter((d): d is Date => d instanceof Date && !Number.isNaN(d.getTime()));
}

/**
 * Count scheduled payments in `(asOf, EDATE(asOf,12)]`.
 *
 * Left edge exclusive, right edge inclusive — that pairing is what makes the count exactly
 * 12 for a monthly schedule no matter which day of the month it pays on. Widening either
 * edge reintroduces the 13th payment.
 */
export function countPaymentsInWindow(dates: readonly unknown[], asOf: Date): number {
  const end = edateMonths(asOf, 12);
  return validDates(dates).filter((d) => d > asOf && d <= end).length;
}

/**
 * Evaluate one loan's schedule against the window.
 *
 * Returns `null` when the count is right, when the loan has no schedule, or when a
 * short count is explained by the schedule ending inside the window (a genuine
 * near-maturity taper — `9050 Red Branch` legitimately returns fewer than 12 as its
 * 2028-01-01 maturity approaches).
 */
export function evaluateDebtServiceWindow(args: {
  id: string;
  dates: readonly unknown[];
  asOf: Date;
}): DataQualityFlag | null {
  const { id, asOf } = args;
  const valid = validDates(args.dates);
  if (valid.length === 0) return null; // non-amortizing loan — nothing to check

  const count = countPaymentsInWindow(valid, asOf);
  if (count === EXPECTED_PAYMENTS) return null;

  const end = edateMonths(asOf, 12);

  if (count < EXPECTED_PAYMENTS) {
    // A schedule that simply runs out inside the window is a real taper, not a defect.
    const lastScheduled = valid.reduce((a, b) => (a > b ? a : b));
    if (lastScheduled <= end) return null;
  }

  const direction = count > EXPECTED_PAYMENTS ? 'over-captures' : 'under-captures';
  return {
    entity: id,
    field: 'annualDebtService',
    issue:
      `amortization schedule ${direction} the forward-12-month window: ${count} payments ` +
      `in (${asOf.toISOString().slice(0, 10)}, ${end.toISOString().slice(0, 10)}], expected ` +
      `${EXPECTED_PAYMENTS}. Annual debt service — and therefore DSCR — is off by ` +
      `${Math.abs(count - EXPECTED_PAYMENTS)} payment(s).`,
    rawValue: String(count),
    severity: 'warn',
  };
}

/**
 * Where each loan's amortization schedule lives.
 *
 * Keyed by snapshot loan id. Every sheet lays its schedule out differently — this mapping
 * mirrors the ranges the `External Loans Summary` SUMPRODUCT formulas themselves address,
 * so it must be updated alongside them. A loan absent from this map (`3883 from Oxford`,
 * `1100 Rarig`) has no schedule by design and is simply not checked.
 */
export const SCHEDULE_SOURCES: Readonly<
  Record<string, { sheet: string; dateCol: number; firstRow: number; lastRow: number }>
> = {
  'borrower-3540-e-fifth-ave': { sheet: '3540 E Fifth Ave', dateCol: 2, firstRow: 9, lastRow: 92 },
  'borrower-9050-red-branch-road': { sheet: '9050 Red Branch Road', dateCol: 2, firstRow: 11, lastRow: 158 },
  'borrower-29000-information-lane': { sheet: '29000 Information Lane', dateCol: 1, firstRow: 9, lastRow: 69 },
  'borrower-banwick-morrison': { sheet: 'Banwick-Morrison', dateCol: 2, firstRow: 11, lastRow: 70 },
  'REDACTED-211': { sheet: 'REDACTED-306', dateCol: 2, firstRow: 11, lastRow: 310 },
  'REDACTED-336': { sheet: 'REDACTED-457', dateCol: 2, firstRow: 10, lastRow: 46 },
};

/** Unwrap an ExcelJS cell value (formula cells arrive as `{ result }`). */
function cellDate(ws: Worksheet, r: number, c: number): unknown {
  const v = ws.getRow(r).getCell(c).value;
  if (v && typeof v === 'object' && 'result' in v) return (v as { result: unknown }).result;
  return v;
}

/** Read one schedule's date column. */
export function readScheduleDates(
  ws: Worksheet,
  src: { dateCol: number; firstRow: number; lastRow: number },
): Date[] {
  const out: Date[] = [];
  for (let r = src.firstRow; r <= src.lastRow; r++) {
    const v = cellDate(ws, r, src.dateCol);
    if (v instanceof Date && !Number.isNaN(v.getTime())) out.push(v);
  }
  return out;
}

/**
 * Read `Assumptions!B30` — "Loan As-Of Date (current month-end)", the anchor the
 * `External Loans Summary` windows are measured from. Unlike the alert-threshold rows on
 * that sheet (category in col 1, label in col 2, value in col 3), the MONTH-END LOAN CLOSE
 * block puts its label in col 1 and its value in col 2.
 */
export function readLoanAsOf(ws: Worksheet): Date | null {
  for (let r = 1; r <= ws.rowCount; r++) {
    const label = ws.getRow(r).getCell(1).value;
    if (typeof label === 'string' && /loan as-of date/i.test(label)) {
      const v = cellDate(ws, r, 2);
      if (v instanceof Date && !Number.isNaN(v.getTime())) return v;
    }
  }
  return null;
}

/**
 * Check every mapped loan schedule and append warn-severity flags.
 *
 * Deliberately tolerant: a missing sheet or an unreadable as-of date is skipped rather
 * than thrown, so a workbook restructure degrades this check instead of breaking
 * extraction outright.
 */
export function checkDebtServiceWindows(
  getSheet: (name: string) => Worksheet | undefined,
  loanIds: readonly string[],
  flags: DataQualityFlag[],
): void {
  const assumptions = getSheet('Assumptions');
  if (!assumptions) return;
  const asOf = readLoanAsOf(assumptions);
  if (!asOf) return;

  for (const id of loanIds) {
    const src = SCHEDULE_SOURCES[id];
    if (!src) continue;
    const ws = getSheet(src.sheet);
    if (!ws) continue;
    const flag = evaluateDebtServiceWindow({ id, dates: readScheduleDates(ws, src), asOf });
    if (flag) flags.push(flag);
  }
}
