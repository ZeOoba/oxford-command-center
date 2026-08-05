// tests/unit/debt-service-crosscheck.test.ts
//
// OI-092 detector, REDESIGN. The first attempt (server/workbook/debt-service-window.ts) was
// withdrawn before shipping because it could not observe the defect it existed for: it computed
// its own correct window and counted schedule rows against it, never reading the `External Loans
// Summary` formula's own output. Reverting the formula to the buggy `TODAY()+366` left its output
// byte-identical. It tested the schedule DATA; the bug lived in the FORMULA.
//
// This redesign is a CROSS-CHECK of two independent computations: recompute next-12-month debt
// service from the full amortization schedule, then compare against the workbook's own cached
// H/I. Divergence is the signal. That shape catches a wrong window (OI-092), a truncated range
// (OI-094), and a wrong column mapping alike.
//
// Three properties are pinned deliberately, each a documented failure of the withdrawn draft:
//   (1) it FIRES under the buggy 13-payment window          (the draft was silent — fatal);
//   (2) it FIRES on a truncated range / dropped row         (the draft's carve-out hid these);
//   (3) fixture dates CLAMP rather than overflow            (the draft used Date.UTC(y,m,day),
//       which rolls 2027-02-31 into March, so its 29th/30th/31st payer cases never ran).
import { describe, it, expect } from 'vitest';
import {
  edateMonths,
  eomonthMonths,
  crossCheckSchedule,
  resolveScheduleColumns,
  type ScheduleRow,
} from '../../server/workbook/debt-service-crosscheck';

/** Build a UTC date, CLAMPING the day to the month's length (never overflowing into the next). */
function d(y: number, m: number, day: number): Date {
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1, Math.min(day, last)));
}

/** A clean monthly schedule paying `payDay` each month, `n` payments from `startY/startM`. */
function schedule(
  startY: number,
  startM: number,
  payDay: number,
  n: number,
  interest: number,
  principal: number,
  opts: { firstRow?: number; openingBalance?: number } = {},
): ScheduleRow[] {
  const firstRow = opts.firstRow ?? 11;
  let balance = opts.openingBalance ?? principal * n;
  const rows: ScheduleRow[] = [];
  for (let i = 0; i < n; i++) {
    const date = edateMonths(d(startY, startM, payDay), i);
    balance -= principal;
    rows.push({ row: firstRow + i, date, interest, principal, balance });
  }
  return rows;
}

const ASOF = d(2026, 8, 31);

/**
 * A schedule whose final balloon is recorded OUTSIDE the principal column (the Restoration Church
 * Trust shape: the balloon sits in Payment Amount, with the principal/interest cells empty), so a
 * principal-column sum misses it and only the remaining-balance column exposes the gap.
 */
function balloonOutsidePrincipalColumn(): ScheduleRow[] {
  const rows = schedule(2026, 9, 20, 6, 14600, 2100, { openingBalance: 1_957_526.85 });
  const last = rows[rows.length - 1]!;
  rows.push({ row: last.row + 1, date: last.date, interest: null, principal: null, balance: 0 });
  return rows;
}

/** Sum interest+principal over the correct (asOf, EOMONTH(asOf,12)] window. */
function correctTotal(rows: ScheduleRow[], asOf: Date, share = 1): number {
  const end = eomonthMonths(asOf, 12);
  return (
    rows
      .filter((r) => r.date > asOf && r.date <= end)
      .reduce((s, r) => s + Math.abs(r.interest ?? 0) + Math.abs(r.principal ?? 0), 0) * share
  );
}

describe('edateMonths — Excel EDATE semantics', () => {
  it('clamps to the target month, never overflows', () => {
    expect(edateMonths(d(2026, 8, 31), 6)).toEqual(d(2027, 2, 28));
    expect(edateMonths(d(2027, 8, 31), 6)).toEqual(d(2028, 2, 29)); // leap
    expect(edateMonths(d(2026, 1, 31), 1)).toEqual(d(2026, 2, 28));
  });

  it('adds exactly 12 months for the forward window', () => {
    expect(edateMonths(d(2026, 8, 31), 12)).toEqual(d(2027, 8, 31));
    expect(edateMonths(d(2026, 2, 29), 12)).toEqual(d(2027, 2, 28));
  });

  it('handles negative months', () => {
    expect(edateMonths(d(2026, 1, 15), -1)).toEqual(d(2025, 12, 15));
    expect(edateMonths(d(2026, 3, 31), -1)).toEqual(d(2026, 2, 28));
  });
});

describe('fixture integrity — the withdrawn draft never tested these', () => {
  it('clamps month-end fixture dates instead of overflowing', () => {
    // Date.UTC(2027, 1, 31) silently becomes 2027-03-03. d() must not.
    expect(d(2027, 2, 31)).toEqual(d(2027, 2, 28));
    expect(d(2026, 4, 31)).toEqual(d(2026, 4, 30));
  });

  it('builds true 12-payment windows for 29th/30th/31st payers', () => {
    for (const payDay of [28, 29, 30, 31]) {
      const rows = schedule(2026, 9, payDay, 24, 1000, 500);
      const end = edateMonths(ASOF, 12);
      const inWindow = rows.filter((r) => r.date > ASOF && r.date <= end);
      expect(inWindow, `payDay ${payDay}`).toHaveLength(12);
    }
  });
});

describe('crossCheckSchedule — clean cases stay silent', () => {
  it('emits no flag when the workbook matches the recomputation', () => {
    const rows = schedule(2026, 9, 5, 24, 15000, 7900);
    const flags = crossCheckSchedule({
      id: 'banwick-morrison',
      rows,
      declaredRangeEnd: rows[rows.length - 1]!.row,
      share: 1,
      bookInterest: 15000 * 12,
      bookPrincipal: 7900 * 12,
      asOf: ASOF,
      isLender: false,
    });
    expect(flags).toEqual([]);
  });

  it('honours a 50% Oxford-share multiplier', () => {
    const rows = schedule(2026, 9, 1, 24, 4500, 7700);
    const flags = crossCheckSchedule({
      id: '9050-red-branch',
      rows,
      declaredRangeEnd: rows[rows.length - 1]!.row,
      share: 0.5,
      bookInterest: 4500 * 12 * 0.5,
      bookPrincipal: 7700 * 12 * 0.5,
      asOf: ASOF,
      isLender: false,
    });
    expect(flags).toEqual([]);
  });

  it('does not flag a loan whose schedule legitimately ends inside the window', () => {
    // Restoration Church Trust shape: matures 2027-02-20, only 6 payments left. A short count
    // is CORRECT here, and over-capture is structurally impossible — no 13th payment exists.
    const rows = schedule(2026, 9, 20, 6, 14600, 2100);
    const flags = crossCheckSchedule({
      id: 'restoration-church-trust',
      rows,
      declaredRangeEnd: rows[rows.length - 1]!.row,
      share: 1,
      bookInterest: 14600 * 6,
      bookPrincipal: 2100 * 6,
      asOf: ASOF,
      isLender: false,
    });
    expect(flags).toEqual([]);
  });

  it('compares interest only when the workbook principal is synthetic', () => {
    // 485 S Walnut: I16 = D16-E16, not a schedule sum. Principal must not be cross-checked.
    const rows = schedule(2026, 9, 26, 24, 1365, 0);
    const flags = crossCheckSchedule({
      id: '485-s-walnut',
      rows,
      declaredRangeEnd: rows[rows.length - 1]!.row,
      share: 1,
      bookInterest: 1365 * 12,
      bookPrincipal: null,
      asOf: ASOF,
      isLender: false,
    });
    expect(flags).toEqual([]);
  });
});

describe('crossCheckSchedule — REFUTE: the defect the withdrawn draft could not see', () => {
  it('FIRES when the workbook total carries the 13th payment (OI-092)', () => {
    const rows = schedule(2026, 9, 5, 24, 15000, 7900);
    const correct = correctTotal(rows, ASOF);
    const buggy = correct + 15000 + 7900; // one extra payment, the [TODAY(), TODAY()+366) shape

    const flags = crossCheckSchedule({
      id: 'banwick-morrison',
      rows,
      declaredRangeEnd: rows[rows.length - 1]!.row,
      share: 1,
      bookInterest: buggy * (15000 / 22900),
      bookPrincipal: buggy * (7900 / 22900),
      asOf: ASOF,
      isLender: false,
    });

    const total = flags.filter((f) => f.field === 'annualDebtService');
    expect(total).toHaveLength(1);
    expect(total[0]!.issue).toMatch(/diverge/i);
    expect(total[0]!.severity).toBe('warn');
  });

  it('FIRES on a truncated declared range even when the delta is currently zero (OI-094)', () => {
    // Banwick: schedule runs to r71 (the 2031-06-05 balloon) but the formula sums B11:B70.
    // Immaterial today, $3.35M understatement from ~mid-2030. Must be caught structurally.
    const rows = schedule(2026, 9, 5, 60, 15000, 7900);
    const flags = crossCheckSchedule({
      id: 'banwick-morrison',
      rows,
      declaredRangeEnd: rows[rows.length - 1]!.row - 1, // one short
      share: 1,
      bookInterest: 15000 * 12,
      bookPrincipal: 7900 * 12,
      asOf: ASOF,
      isLender: false,
    });

    const trunc = flags.filter((f) => f.field === 'scheduleRange');
    expect(trunc).toHaveLength(1);
    expect(trunc[0]!.issue).toMatch(/truncat/i);
  });

  it('FIRES on a dropped schedule row', () => {
    const rows = schedule(2026, 9, 5, 24, 15000, 7900);
    const full = correctTotal(rows, ASOF);
    const dropped = rows.filter((_, i) => i !== 3);

    const flags = crossCheckSchedule({
      id: 'banwick-morrison',
      rows: dropped,
      declaredRangeEnd: dropped[dropped.length - 1]!.row,
      share: 1,
      bookInterest: full * (15000 / 22900),
      bookPrincipal: full * (7900 / 22900),
      asOf: ASOF,
      isLender: false,
    });
    expect(flags.filter((f) => f.field === 'annualDebtService')).toHaveLength(1);
  });

  it('FIRES on duplicate payment dates (the 485 S Walnut double-count)', () => {
    const rows = schedule(2026, 9, 26, 24, 1365, 0);
    // rows 45/46 both carry the same date — September interest counted twice.
    const dupe = rows[5]!;
    rows.splice(6, 0, { ...dupe, row: dupe.row + 100 });

    const flags = crossCheckSchedule({
      id: '485-s-walnut',
      rows,
      declaredRangeEnd: Math.max(...rows.map((r) => r.row)),
      share: 1,
      bookInterest: 1365 * 13, // the double-counted total the workbook actually produces
      bookPrincipal: null,
      asOf: ASOF,
      isLender: false,
    });
    expect(flags.filter((f) => f.field === 'duplicatePaymentDate')).toHaveLength(1);
  });

  it('FIRES on a BORROWER balloon recorded outside the principal column', () => {
    // A balloon parked in the payment-amount column is invisible to a principal-column sum, so
    // the workbook and a naive recompute agree while both understate. Only reconciling against
    // the remaining-balance column sees it. On a borrower loan the balloon is cash Oxford must
    // pay, so it genuinely belongs in debt service (ruling 2, 2026-08-05).
    const flags = crossCheckSchedule({
      id: '3540-e-fifth-ave',
      rows: balloonOutsidePrincipalColumn(),
      declaredRangeEnd: 17,
      share: 1,
      bookInterest: 14600 * 6,
      bookPrincipal: 2100 * 6,
      asOf: ASOF,
      isLender: false,
    });

    const gap = flags.filter((f) => f.field === 'principalReconciliation');
    expect(gap).toHaveLength(1);
    expect(gap[0]!.issue).toMatch(/balance/i);
  });

  it('FIRES when the scan never reaches the declared range end', () => {
    // The truncation check is one-directional — it can only fire when the scan runs PAST the
    // declared end. An early-terminating scan would therefore silently disable it, and a genuinely
    // truncated range would read clean. That is the OI-094 false negative, restored.
    const rows = schedule(2026, 9, 5, 24, 15000, 7900);
    const flags = crossCheckSchedule({
      id: 'banwick-morrison',
      rows,
      declaredRangeEnd: rows[rows.length - 1]!.row + 20, // declared range extends well past the scan
      share: 1,
      bookInterest: 15000 * 12,
      bookPrincipal: 7900 * 12,
      asOf: ASOF,
      isLender: false,
      scanReachedDeclaredEnd: false,
    });

    const short = flags.filter((f) => f.field === 'scheduleRange');
    expect(short).toHaveLength(1);
    expect(short[0]!.issue).toMatch(/probe budget/i);
  });
});

describe('crossCheckSchedule — encodes the OI-095 ruling, not the raw arithmetic', () => {
  // Ruling 2026-08-05 (OI-095, CLOSED): excluding a balloon from a LENDER row's principal is
  // INTENTIONAL. "Annual debt service" means recurring P&I only; a lender balloon is capital
  // returning to Oxford, not debt service. Flagging the raw arithmetic here would fire
  // permanently on Restoration Church Trust with a $1.9M "unaccounted for" figure on a workbook
  // already adjudicated correct — the costliest kind of false positive.
  it('stays SILENT on a lender balloon excluded from the principal column', () => {
    const flags = crossCheckSchedule({
      id: 'restoration-church-trust',
      rows: balloonOutsidePrincipalColumn(),
      declaredRangeEnd: 17,
      share: 0.5,
      bookInterest: 14600 * 6 * 0.5,
      bookPrincipal: 2100 * 6 * 0.5,
      asOf: ASOF,
      isLender: true,
    });
    expect(flags.filter((f) => f.field === 'principalReconciliation')).toEqual([]);
  });

  it('still cross-checks a lender row TOTAL — the exemption is scoped to the balloon check', () => {
    const rows = schedule(2026, 9, 20, 6, 14600, 2100);
    const flags = crossCheckSchedule({
      id: 'restoration-church-trust',
      rows,
      declaredRangeEnd: rows[rows.length - 1]!.row,
      share: 1,
      bookInterest: 14600 * 7, // one payment too many
      bookPrincipal: 2100 * 6,
      asOf: ASOF,
      isLender: true,
    });
    expect(flags.filter((f) => f.field === 'annualDebtService')).toHaveLength(1);
  });
});

describe('eomonthMonths — the window end the workbook actually uses', () => {
  it('returns the LAST day of the target month', () => {
    expect(eomonthMonths(d(2026, 8, 31), 12)).toEqual(d(2027, 8, 31));
    expect(eomonthMonths(d(2026, 9, 15), 12)).toEqual(d(2027, 9, 30));
  });

  it('diverges from EDATE exactly where the workbook was moved off EDATE', () => {
    // Feb month-end anchor in a pre-leap year: EDATE under-captures (11 payments), which is why
    // all 11 window cells now use EOMONTH. A detector still on EDATE would compute a different
    // window from the workbook and accuse a correct sheet of the OI-092 defect.
    expect(eomonthMonths(d(2027, 2, 28), 12)).toEqual(d(2028, 2, 29));
    expect(edateMonths(d(2027, 2, 28), 12)).toEqual(d(2028, 2, 28));
    expect(eomonthMonths(d(2031, 2, 28), 12)).toEqual(d(2032, 2, 29));
  });
});

describe('resolveScheduleColumns — header-derived, not hardcoded', () => {
  // Hardcoding columns to mirror the ELS formula would make a wrong-column mapping invisible,
  // and the six real sheets genuinely disagree on layout.
  const cases: { name: string; header: Record<string, string>; want: Record<string, string> }[] = [
    {
      name: '3540 E Fifth Ave',
      header: { B: 'Payment Date', E: 'Interest Paid', F: 'Principal Paid', G: 'Remaining Balance' },
      want: { date: 'B', interest: 'E', principal: 'F', balance: 'G' },
    },
    {
      name: '9050 Red Branch Road',
      header: { B: 'Payment Date', C: 'Interest Paid', D: 'Principal Paid', F: 'Remaining Balance (Full)' },
      want: { date: 'B', interest: 'C', principal: 'D', balance: 'F' },
    },
    {
      name: '29000 Information Lane',
      header: { A: 'Payment Date', C: 'Principal Paid', D: 'Interest Paid', E: 'Remaining Balance' },
      want: { date: 'A', interest: 'D', principal: 'C', balance: 'E' },
    },
    {
      name: 'Banwick-Morrison',
      header: { B: 'Payment Date', D: 'Interest Paid', E: 'Principal Reduction', F: 'Remaining Balance' },
      want: { date: 'B', interest: 'D', principal: 'E', balance: 'F' },
    },
  ];

  for (const c of cases) {
    it(`maps ${c.name} from its own header row`, () => {
      expect(resolveScheduleColumns(c.header)).toMatchObject(c.want);
    });
  }

  it('reports the columns it could not resolve rather than guessing', () => {
    const got = resolveScheduleColumns({ B: 'Payment Date', D: 'Monthly Payment' });
    expect(got.interest).toBeUndefined();
    expect(got.principal).toBeUndefined();
  });

  it('does not confuse "Payment Amount" with "Interest Paid"', () => {
    // The prototype did exactly this on 29000 and over-reported by $54,895.55.
    const got = resolveScheduleColumns({ A: 'Payment Date', B: 'Payment Amount', D: 'Interest Paid' });
    expect(got.interest).toBe('D');
  });
});
