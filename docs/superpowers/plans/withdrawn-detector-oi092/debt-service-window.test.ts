import { describe, it, expect } from 'vitest';
import {
  edateMonths,
  countPaymentsInWindow,
  evaluateDebtServiceWindow,
} from '../../server/workbook/debt-service-window';

/**
 * Regression cover for the 2026-08-05 annual-debt-service over-capture (OI-092).
 *
 * `External Loans Summary` used to compute next-12-month interest/principal over
 * `[TODAY(), TODAY()+366)`. On a loan's payment day-of-month that half-open 366-day
 * span swallowed BOTH this month's payment and next year's anniversary payment —
 * 13 payments, not 12 — inflating annual debt service by exactly one payment and
 * depressing DSCR. Banwick / Morrison: $297,950.51 vs. the correct $275,031.24.
 *
 * The window is now `(asOf, EDATE(asOf,12)]`, anchored on month-end. These tests
 * pin the payment-count invariant that detects the defect class regardless of how
 * the window is spelled.
 */

const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

/** Monthly schedule on `day`, `n` payments, starting the month after `startY/startM`. */
const monthly = (startY: number, startM: number, day: number, n: number): Date[] =>
  Array.from({ length: n }, (_, i) => {
    const m = startM - 1 + i;
    return new Date(Date.UTC(startY + Math.floor(m / 12), m % 12, day));
  });

describe('edateMonths — Excel EDATE semantics', () => {
  it('adds whole months', () => {
    expect(edateMonths(utc(2026, 8, 31), 12).toISOString().slice(0, 10)).toBe('2027-08-31');
  });

  it('clamps to month end when the target month is shorter', () => {
    // EDATE(2026-08-31, 6) = 2027-02-28, not an overflow into March.
    expect(edateMonths(utc(2026, 8, 31), 6).toISOString().slice(0, 10)).toBe('2027-02-28');
  });

  it('clamps to Feb 29 in a leap year', () => {
    expect(edateMonths(utc(2027, 8, 31), 6).toISOString().slice(0, 10)).toBe('2028-02-29');
  });
});

describe('countPaymentsInWindow — half-open (asOf, asOf+12mo]', () => {
  const asOf = utc(2026, 8, 31); // month-end close

  it('counts exactly 12 for a level monthly schedule paying on the 5th', () => {
    // 2026-09-05 .. 2027-08-05 inclusive = 12
    expect(countPaymentsInWindow(monthly(2026, 9, 5, 24), asOf)).toBe(12);
  });

  it('counts exactly 12 for a schedule paying on the 1st', () => {
    expect(countPaymentsInWindow(monthly(2026, 9, 1, 24), asOf)).toBe(12);
  });

  it('excludes a payment falling exactly on asOf (left edge is exclusive)', () => {
    const dates = [utc(2026, 8, 31), ...monthly(2026, 9, 30, 12)];
    // the 08-31 payment must not be counted
    expect(countPaymentsInWindow(dates, asOf)).toBe(12);
  });

  it('includes a payment falling exactly on the anniversary (right edge is inclusive)', () => {
    // last-day-of-month payer: 2026-09-30 .. 2027-08-31, the 2027-08-31 must count
    const dates = monthly(2026, 9, 30, 11).concat([utc(2027, 8, 31)]);
    expect(countPaymentsInWindow(dates, asOf)).toBe(12);
  });

  it('THE DEFECT: a 366-day span on a payment day captures 13', () => {
    // Reproduce the old behaviour: asOf on Banwick's payment day, window [asOf, asOf+366).
    // Both 2026-08-05 and 2027-08-05 land inside — the extra payment.
    const payDay = utc(2026, 8, 5);
    const dates = monthly(2026, 8, 5, 24);
    const legacyEnd = new Date(payDay.getTime() + 366 * 86_400_000);
    const legacyCount = dates.filter((d) => d >= payDay && d < legacyEnd).length;
    expect(legacyCount).toBe(13); // documents the bug

    // The corrected window over the same schedule yields 12.
    expect(countPaymentsInWindow(dates, payDay)).toBe(12);
  });

  it('ignores nulls and non-dates in the schedule column', () => {
    const dates = [...monthly(2026, 9, 5, 12), null, undefined] as unknown as Date[];
    expect(countPaymentsInWindow(dates, asOf)).toBe(12);
  });
});

describe('evaluateDebtServiceWindow — warn-severity data-quality flag', () => {
  const asOf = utc(2026, 8, 31);

  it('returns null when exactly 12 payments fall in the window', () => {
    const flag = evaluateDebtServiceWindow({
      id: 'borrower-banwick-morrison',
      dates: monthly(2026, 9, 5, 24),
      asOf,
    });
    expect(flag).toBeNull();
  });

  it('flags an over-capture (13) at warn severity, naming the count', () => {
    const flag = evaluateDebtServiceWindow({
      id: 'borrower-banwick-morrison',
      dates: monthly(2026, 9, 5, 24).concat([utc(2027, 8, 20)]),
      asOf,
    });
    expect(flag).not.toBeNull();
    expect(flag!.severity).toBe('warn');
    expect(flag!.entity).toBe('borrower-banwick-morrison');
    expect(flag!.field).toBe('annualDebtService');
    expect(flag!.issue).toMatch(/13/);
  });

  it('does NOT flag a legitimate near-maturity taper (schedule ends inside the window)', () => {
    // 9050 Red Branch behaviour: matures 2028-01-01, so as maturity nears the
    // window legitimately holds fewer than 12 payments.
    const flag = evaluateDebtServiceWindow({
      id: 'borrower-9050-red-branch-road',
      dates: monthly(2026, 9, 1, 5), // schedule simply ends
      asOf,
    });
    expect(flag).toBeNull();
  });

  it('DOES flag an under-count not explained by maturity (schedule continues past the window)', () => {
    // A gap in the middle of an otherwise-continuing schedule is a real defect.
    const dates = monthly(2026, 9, 5, 24).filter((_, i) => i !== 3);
    const flag = evaluateDebtServiceWindow({ id: 'borrower-3540-e-fifth-ave', dates, asOf });
    expect(flag).not.toBeNull();
    expect(flag!.severity).toBe('warn');
    expect(flag!.issue).toMatch(/11/);
  });

  it('stays silent for a loan with no amortization schedule at all', () => {
    // 3883 from Oxford and 1100 Rarig have no schedule — interest is rate x balance.
    // These must never be flagged; that was the fatal flaw in the ">2 decimal places"
    // detector, which fired on 6 of 11 loans, all of them correct.
    expect(evaluateDebtServiceWindow({ id: 'borrower-3883-from-oxford-50', dates: [], asOf })).toBeNull();
  });
});
