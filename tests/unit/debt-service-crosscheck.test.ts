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
import ExcelJS from 'exceljs';
import {
  edateMonths,
  eomonthMonths,
  crossCheckSchedule,
  crossCheckDebtService,
  resolveScheduleColumns,
  parseElsFormula,
  scanSchedule,
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
 * A schedule whose final balloon is recorded OUTSIDE the principal column (the Note Party 02
 * shape: the balloon sits in Payment Amount, with the principal/interest cells empty), so a
 * principal-column sum misses it and only the remaining-balance column exposes the gap.
 */
function balloonOutsidePrincipalColumn(): ScheduleRow[] {
  const rows = schedule(2026, 9, 20, 6, 14600, 2100, { openingBalance: REDACTED-AMT });
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
  it('reports — rather than silently returning [] — when no schedule rows resolved', () => {
    const flags = crossCheckSchedule({
      id: 'no-schedule-loan',
      rows: [],
      declaredRangeEnd: null,
      share: 1,
      bookInterest: 12000,
      bookPrincipal: 4000,
      asOf: ASOF,
    });
    expect(flags).toEqual([{
      entity: 'no-schedule-loan',
      field: 'annualDebtService',
      issue: 'no amortization-schedule rows resolved — cross-check could not run',
      severity: 'warn',
    }]);
  });

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
    });
    expect(flags).toEqual([]);
  });

  it('does not flag a loan whose schedule legitimately ends inside the window', () => {
    // Note Party 02 shape: matures 2027-02-20, only 6 payments left. A short count
    // is CORRECT here, and over-capture is structurally impossible — no 13th payment exists.
    const rows = schedule(2026, 9, 20, 6, 14600, 2100);
    const flags = crossCheckSchedule({
      id: 'note-party-02',
      rows,
      declaredRangeEnd: rows[rows.length - 1]!.row,
      share: 1,
      bookInterest: 14600 * 6,
      bookPrincipal: 2100 * 6,
      asOf: ASOF,
    });
    expect(flags).toEqual([]);
  });

  it('compares interest only when the workbook principal is synthetic', () => {
    // 100 Note Party St: I16 = D16-E16, not a schedule sum. Principal must not be cross-checked.
    const rows = schedule(2026, 9, 26, 24, REDACTED-AMT, 0);
    const flags = crossCheckSchedule({
      id: 'note-party-03',
      rows,
      declaredRangeEnd: rows[rows.length - 1]!.row,
      share: 1,
      bookInterest: REDACTED-AMT * 12,
      bookPrincipal: null,
      asOf: ASOF,
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
    });
    expect(flags.filter((f) => f.field === 'annualDebtService')).toHaveLength(1);
  });

  it('FIRES on duplicate payment dates (the 100 Note Party St double-count)', () => {
    const rows = schedule(2026, 9, 26, 24, REDACTED-AMT, 0);
    // rows 45/46 both carry the same date — September interest counted twice.
    const dupe = rows[5]!;
    rows.splice(6, 0, { ...dupe, row: dupe.row + 100 });

    const flags = crossCheckSchedule({
      id: 'note-party-03',
      rows,
      declaredRangeEnd: Math.max(...rows.map((r) => r.row)),
      share: 1,
      bookInterest: REDACTED-AMT * 13, // the double-counted total the workbook actually produces
      bookPrincipal: null,
      asOf: ASOF,
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
      scanReachedDeclaredEnd: false,
    });

    const short = flags.filter((f) => f.field === 'scheduleRange');
    expect(short).toHaveLength(1);
    expect(short[0]!.issue).toMatch(/probe budget/i);
  });
});

describe('crossCheckSchedule — no borrower/lender exemption (superseded ruling, 2026-08-05)', () => {
  // Gabriel's FIRST ruling on Note Party 02's balloon exclusion (~17:00, 2026-08-05) held it as
  // intentional: "C = total payment, D/E = the itemized split a balloon legitimately doesn't
  // carry" — a principled borrower/lender asymmetry. That ruling was ITSELF superseded same-day
  // ("Turn 149"): the real root cause was I14/I15/I16 computing principal on three inconsistent
  // bases, not one deliberate design choice. All three were fixed to a single consistent
  // forward-looking basis, and Note Party 02's balloon is now genuinely included (I15 -$REDACTED-AMT,
  // confirmed live). The tracker records this explicitly as a detector constraint: "must NOT be
  // built to treat balloon-excluded lender principal as correct."
  //
  // An earlier version of this check carried an isLender exemption built against the FIRST
  // ruling. These tests pin its removal — a balloon excluded from a lender row's principal
  // column is now a real defect and must fire, exactly like a borrower row's would.
  it('FIRES on a lender-row balloon excluded from the principal column', () => {
    const flags = crossCheckSchedule({
      id: 'note-party-02',
      rows: balloonOutsidePrincipalColumn(),
      declaredRangeEnd: 17,
      share: 0.5,
      bookInterest: 14600 * 6 * 0.5,
      bookPrincipal: 2100 * 6 * 0.5,
      asOf: ASOF,
    });
    const gap = flags.filter((f) => f.field === 'principalReconciliation');
    expect(gap, JSON.stringify(flags, null, 2)).toHaveLength(1);
  });

  it('still cross-checks a lender row TOTAL the same as any other row', () => {
    const rows = schedule(2026, 9, 20, 6, 14600, 2100);
    const flags = crossCheckSchedule({
      id: 'note-party-02',
      rows,
      declaredRangeEnd: rows[rows.length - 1]!.row,
      share: 1,
      bookInterest: 14600 * 7, // one payment too many
      bookPrincipal: 2100 * 6,
      asOf: ASOF,
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
    // The prototype did exactly this on 29000 and over-reported by $REDACTED-AMT.
    const got = resolveScheduleColumns({ A: 'Payment Date', B: 'Payment Amount', D: 'Interest Paid' });
    expect(got.interest).toBe('D');
  });
});

// ── crossCheckDebtService — fixture-driven, end-to-end through a real ExcelJS workbook ────────
// The prior review's finding 9: nothing exercised the worksheet-facing orchestrator, and every
// confirmed defect in the subsequent REFUTE pass lived exactly there. These build a real
// (in-memory, no I/O) workbook rather than mocking ExcelJS, so formula/result cell shapes match
// what the live workbook actually produces.

function formulaCell(formula: string, result: number | Date) {
  return { formula, result } as unknown as ExcelJS.CellValue;
}

function countInWindow(
  asOf: Date,
  end: Date,
  startYear: number,
  startMonth: number,
  payDay: number,
  n: number,
): number {
  let count = 0;
  for (let i = 0; i < n; i++) {
    const date = edateMonths(d(startYear, startMonth, payDay), i);
    if (date > asOf && date <= end) count += 1;
  }
  return count;
}

/** A minimal but structurally real fixture: Assumptions + External Loans Summary + one schedule
 *  sheet per loan. Carries the sheet's own section banners as harmless decorative text — the
 *  detector no longer distinguishes borrower from lender rows (see the "no borrower/lender
 *  exemption" describe block below), but the banners are real content on the live sheet and
 *  keeping them here confirms the parser doesn't trip over them. */
function buildFixtureWorkbook(opts: {
  asOf?: Date;
  loans: {
    row: number;
    label: string;
    sheet: string;
    interest: number;
    principal: number;
    n: number;
    payDay: number;
    startYear?: number;
    startMonth?: number;
    wrapInAbs?: boolean; // sign-normalization shape — Math.abs() must make this a non-issue
    hFormulaOverride?: string; // for malformed-formula test cases
  }[];
}): ExcelJS.Workbook {
  const asOf = opts.asOf ?? d(2026, 8, 31);
  const wb = new ExcelJS.Workbook();

  const assumptions = wb.addWorksheet('Assumptions');
  assumptions.getCell('B30').value = asOf;

  const els = wb.addWorksheet('External Loans Summary');
  els.getCell('A5').value = String.raw`▼  WE ARE THE BORROWER  —  Oxford Holds the Debt`;
  els.getCell('A13').value = String.raw`▼  WE ARE THE LENDER  —  Capital Deployed by Oxford`;

  for (const loan of opts.loans) {
    els.getCell(`B${loan.row}`).value = loan.label;

    const startYear = loan.startYear ?? 2026;
    const startMonth = loan.startMonth ?? 9;
    const sched = wb.addWorksheet(loan.sheet);
    sched.getCell('B8').value = 'Payment Date';
    sched.getCell('D8').value = 'Interest Paid';
    sched.getCell('E8').value = 'Principal Reduction';
    sched.getCell('F8').value = 'Remaining Balance';
    let balance = loan.principal * loan.n;
    for (let i = 0; i < loan.n; i++) {
      const r = 9 + i;
      balance -= loan.principal;
      sched.getCell(`B${r}`).value = edateMonths(d(startYear, startMonth, loan.payDay), i);
      sched.getCell(`D${r}`).value = loan.interest;
      sched.getCell(`E${r}`).value = loan.principal;
      sched.getCell(`F${r}`).value = balance;
    }
    const rangeEnd = 9 + loan.n - 1;
    const end = eomonthMonths(asOf, 12);
    const winCount = countInWindow(asOf, end, startYear, startMonth, loan.payDay, loan.n);
    const inWindowInterest = loan.interest * winCount;
    const inWindowPrincipal = loan.principal * winCount;

    const wrap = (v: string) => (loan.wrapInAbs ? `-ABS(${v})` : v);
    const sumH = `SUMPRODUCT(('${loan.sheet}'!B9:B${rangeEnd}>Assumptions!$B$30)*('${loan.sheet}'!B9:B${rangeEnd}<=EOMONTH(Assumptions!$B$30,12))*'${loan.sheet}'!D9:D${rangeEnd})`;
    const sumI = `SUMPRODUCT(('${loan.sheet}'!B9:B${rangeEnd}>Assumptions!$B$30)*('${loan.sheet}'!B9:B${rangeEnd}<=EOMONTH(Assumptions!$B$30,12))*'${loan.sheet}'!E9:E${rangeEnd})`;
    const hFormula = loan.hFormulaOverride ?? wrap(sumH);

    els.getCell(`H${loan.row}`).value = formulaCell(hFormula, inWindowInterest);
    els.getCell(`I${loan.row}`).value = formulaCell(wrap(sumI), inWindowPrincipal);
  }

  return wb;
}

describe('crossCheckDebtService — fixture end-to-end', () => {
  it('stays silent on a clean two-loan workbook (one borrower row, one lender row)', () => {
    const wb = buildFixtureWorkbook({
      loans: [
        { row: 6, label: '3540 E Fifth Ave', sheet: 'Sched-3540', interest: 12000, principal: 4000, n: 24, payDay: 1 },
        { row: 15, label: 'Note Party 02', sheet: 'Sched-RCT', interest: 14600, principal: 2100, n: 24, payDay: 20, wrapInAbs: true },
      ],
    });
    const flags = crossCheckDebtService(wb);
    expect(flags, JSON.stringify(flags, null, 2)).toEqual([]);
  });

  it('does NOT let a -ABS(...)-wrapped formula escape the principal-reconciliation check', () => {
    // The sign-normalization wrapper must never gate this check — every comparison inside it
    // uses Math.abs(), so a -ABS(...)-wrapped row (a sign-normalization accident, or a
    // copy-paste from elsewhere on the sheet) must still be checked exactly like any other row.
    // Start the schedule well before the window so a real prior-period row exists — the fixed
    // opening-balance logic reads from that row; a schedule beginning INSIDE the window has no
    // independent predecessor to read and falls back to the (still-limited) origination case.
    const wb = buildFixtureWorkbook({
      loans: [
        {
          row: 6, label: '3540 E Fifth Ave', sheet: 'Sched-3540', interest: 12000, principal: 4000,
          n: 36, payDay: 1, startYear: 2025, startMonth: 9, wrapInAbs: true,
        },
      ],
    });
    // Hide principal on the first in-window row (2026-09-01) — only the balance-column
    // reconciliation can see it.
    const sched = wb.getWorksheet('Sched-3540')!;
    sched.getCell('E21').value = null; // row 9 + 12 months = the first row inside (asOf, +12mo]

    const flags = crossCheckDebtService(wb);
    const gap = flags.filter((f) => f.field === 'principalReconciliation');
    expect(gap.length, JSON.stringify(flags, null, 2)).toBeGreaterThan(0);
  });

  it('FIRES on a lender-row balloon excluded from the principal column, -ABS wrapping notwithstanding', () => {
    // Superseded-ruling regression test (see the dedicated describe block above for the full
    // history): a balloon excluded from a LENDER row's principal column is a real defect, not an
    // exempt design choice — and the -ABS(...) sign wrapper must not matter either way.
    const wb = buildFixtureWorkbook({
      loans: [
        { row: 15, label: 'Note Party 02', sheet: 'Sched-RCT', interest: 14600, principal: 2100, n: 6, payDay: 20, wrapInAbs: true },
      ],
    });
    const sched = wb.getWorksheet('Sched-RCT')!;
    const lastRow = 9 + 6 - 1;
    const removedPrincipal = sched.getCell(`E${lastRow}`).value as number;
    sched.getCell(`E${lastRow}`).value = null; // balloon recorded outside Principal Reduction
    const els = wb.getWorksheet('External Loans Summary')!;
    const iCell = els.getCell('I15').value as { formula: string; result: number };
    els.getCell('I15').value = formulaCell(iCell.formula, iCell.result - removedPrincipal);

    const flags = crossCheckDebtService(wb);
    const gap = flags.filter((f) => f.field === 'principalReconciliation');
    expect(gap.length, JSON.stringify(flags, null, 2)).toBeGreaterThan(0);
  });

  it('flags a known schedule-backed row pasted to a literal value, not a self-referential floor', () => {
    // Finding C from the REFUTE pass: a floor derived by re-parsing the live formula drops along
    // with a real coverage loss (Paste-Special-Values, an openpyxl round-trip). The fixed
    // KNOWN_SCHEDULE_BACKED_ROWS list catches row 6 losing its formula regardless.
    const wb = buildFixtureWorkbook({
      loans: [{ row: 6, label: '3540 E Fifth Ave', sheet: 'Sched-3540', interest: 12000, principal: 4000, n: 24, payDay: 1 }],
    });
    const els = wb.getWorksheet('External Loans Summary')!;
    const hCell = els.getCell('H6').value as { result: number };
    els.getCell('H6').value = hCell.result; // paste-to-value: formula gone, bare number remains

    const flags = crossCheckDebtService(wb);
    const coverage = flags.filter(
      (f) => f.field === 'annualDebtService' && /NOT cross-checked|schedule-backed/.test(f.issue),
    );
    expect(coverage.length, JSON.stringify(flags, null, 2)).toBeGreaterThan(0);
  });

  it('does not claim "no cached value" when the cached principal is legitimately 0', () => {
    // Live defect, 2026-08-09: Note Party 03 LLC (100 Note Party St, ELS row 16) is an
    // interest-only position — no principal is contractually scheduled in the next 12 months, so
    // I16's cached value is a real 0 (`<v>0</v>` in the sheet XML). ExcelJS's public `cell.value`
    // getter OMITS `result` whenever it is falsy, so cellNumber() read undefined and the detector
    // reported "I16 is a schedule formula but has no cached value — recalculate and save the
    // workbook in Excel." That instruction is unachievable (no recalc can make a true 0 non-zero)
    // and, worse, it means the principal side of every zero-principal loan silently goes
    // un-cross-checked. `cell.model.result` carries the 0 correctly.
    const wb = buildFixtureWorkbook({
      loans: [{ row: 6, label: '3540 E Fifth Ave', sheet: 'Sched-3540', interest: 12000, principal: 0, n: 24, payDay: 1 }],
    });
    const els = wb.getWorksheet('External Loans Summary')!;

    // Guard the premise: the getter really does drop the 0 this fixture wrote.
    expect((els.getCell('I6').value as { result?: number }).result).toBeUndefined();
    expect((els.getCell('I6') as unknown as { model: { result?: number } }).model.result).toBe(0);

    const flags = crossCheckDebtService(wb);
    const bogus = flags.filter(
      (f) => f.field === 'annualDebtService' && /has no cached value/.test(f.issue),
    );
    expect(bogus, JSON.stringify(flags, null, 2)).toHaveLength(0);
  });

  it('STILL flags a schedule formula whose cached value is genuinely absent', () => {
    // REFUTE guard for the cached-0 fix above. Recovering a falsy `result` from `cell.model` must
    // not blunt the detector's actual purpose: a formula that was never calculated (no <v> at all
    // — the openpyxl round-trip signature) has to keep reporting. Without this test the zero-fix
    // could disable the check entirely and the suite would stay green.
    const wb = buildFixtureWorkbook({
      loans: [{ row: 6, label: '3540 E Fifth Ave', sheet: 'Sched-3540', interest: 12000, principal: 4000, n: 24, payDay: 1 }],
    });
    const els = wb.getWorksheet('External Loans Summary')!;
    const iFormula = (els.getCell('I6').value as { formula: string }).formula;
    els.getCell('I6').value = { formula: iFormula } as unknown as ExcelJS.CellValue; // no result

    // Premise guard: neither the getter nor the model carries a cached value here.
    expect((els.getCell('I6').value as { result?: number }).result).toBeUndefined();
    expect((els.getCell('I6') as unknown as { model: { result?: number } }).model.result).toBeUndefined();

    const flags = crossCheckDebtService(wb);
    const absent = flags.filter(
      (f) => f.field === 'annualDebtService' && /has no cached value/.test(f.issue),
    );
    expect(absent.length, JSON.stringify(flags, null, 2)).toBeGreaterThan(0);
  });

  it('flags — rather than silently skips — an unquoted sheet name on a row outside the known list', () => {
    // Row 20 is neither a KNOWN_SCHEDULE_BACKED row nor an ELS_LOAN_ROWS row — this specifically
    // exercises the "looks like a schedule formula but isn't a known row" path, distinct from the
    // "known row lost its formula" path covered by the paste-to-value test above.
    const wb = buildFixtureWorkbook({
      loans: [{
        row: 20,
        label: 'Some Later Loan',
        sheet: 'Sched-Later',
        interest: 12000,
        principal: 4000,
        n: 24,
        payDay: 1,
        hFormulaOverride:
          'SUMPRODUCT((SchedLater!B9:B32>Assumptions!$B$30)*(SchedLater!B9:B32<=EOMONTH(Assumptions!$B$30,12))*SchedLater!D9:D32)',
      }],
    });
    const flags = crossCheckDebtService(wb);
    expect(flags.some((f) => /could not be parsed/.test(f.issue))).toBe(true);
  });

  it('finds a loan outside the hardcoded ELS_LOAN_ROWS list via the row-band scan', () => {
    const wb = buildFixtureWorkbook({
      loans: [{ row: 45, label: 'New Loan Added Later', sheet: 'Sched-New', interest: 5000, principal: 1000, n: 24, payDay: 10 }],
    });
    // Corrupt it so it produces a visible flag, proving row 45 was actually reached and checked.
    const els = wb.getWorksheet('External Loans Summary')!;
    const hCell = els.getCell('H45').value as { formula: string; result: number };
    els.getCell('H45').value = formulaCell(hCell.formula, hCell.result + 999999);

    const flags = crossCheckDebtService(wb);
    expect(flags.some((f) => f.entity === 'New Loan Added Later')).toBe(true);
  });

  it('flags — rather than silently skips — an unresolvable "Remaining Balance" header', () => {
    // Independent review finding (2026-08-05): every other unresolvable-column path here is
    // flagged (cols.date/cols.interest at the top of the loop, cols.principal below), but
    // cols.balance was never validated. crossCheckSchedule cannot tell "column absent" from
    // "loan genuinely has no balance data" — every row's balance just reads null either way —
    // so its principal-reconciliation check (finding #4, the ONE check that can see a balloon
    // parked outside the Principal column, e.g. the real RCT case) silently no-ops. A borrower
    // loan whose balance header gets renamed would read as clean while that entire check is
    // dark for it.
    const wb = buildFixtureWorkbook({
      loans: [{ row: 6, label: '3540 E Fifth Ave', sheet: 'Sched-3540', interest: 12000, principal: 4000, n: 24, payDay: 1 }],
    });
    wb.getWorksheet('Sched-3540')!.getCell('F8').value = 'Balance Post-Payment'; // no longer starts with "remaining balance"

    const flags = crossCheckDebtService(wb);
    expect(flags.some((f) => f.entity === '3540 E Fifth Ave' && /Remaining Balance/.test(f.issue))).toBe(true);
  });
});

describe('crossCheckSchedule — F-1: opening balance is read independently, not reconstructed', () => {
  it('FIRES when the FIRST in-window row understates principal, given prior-period rows exist', () => {
    // Before the fix, `opening` was reconstructed as `first.balance + first.principal`, which
    // moves in lockstep with a defect on that exact row and can never detect one there. With many
    // months of schedule before the window (the realistic case), the true prior balance is
    // available and independent of the row under test.
    const rows = schedule(2025, 9, 5, 36, 15000, 7900); // starts a year before ASOF, runs past it
    const windowStart = rows.findIndex((r) => r.date > ASOF);
    expect(windowStart).toBeGreaterThan(0); // sanity: there ARE prior-period rows

    const corrupted = rows.map((r, i) => (i === windowStart ? { ...r, principal: 0 } : r));
    const bookPrincipalOnly = corrupted
      .filter((r) => r.date > ASOF && r.date <= eomonthMonths(ASOF, 12))
      .reduce((s, r) => s + Math.abs(r.principal ?? 0), 0);

    const flags = crossCheckSchedule({
      id: 'test-loan',
      rows: corrupted,
      declaredRangeEnd: corrupted[corrupted.length - 1]!.row,
      share: 1,
      bookInterest: 15000 * 12,
      bookPrincipal: bookPrincipalOnly, // the workbook's own I matches the same corrupted figure
      asOf: ASOF,
    });

    expect(flags.filter((f) => f.field === 'principalReconciliation')).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// 2026-08-11 weekly integrity sweep. Six defects, all found by adversarial refuters against a
// green suite. Grouped here because they share the module, not because they share a cause.
// ─────────────────────────────────────────────────────────────────────────────────────────────

/**
 * M3 (determinism lens). Check 4 keyed on PHYSICAL row order — `findIndex`, the physical
 * predecessor, and `[...inWindow].reverse().find(...)` for the closing balance — while the
 * workbook quantity it audits (a date-predicate SUMPRODUCT) is row-order-INSENSITIVE. So two
 * sheets with identical financial content and swapped row positions were indistinguishable to
 * Excel yet got opposite verdicts. The same-date pair is the documented RCT r35/r36 shape.
 */
describe('crossCheckSchedule — M3: check 4 must be invariant under same-date row permutation', () => {
  /** Prior-period row, then a final regular payment and a payoff row sharing one date. */
  function sameDatePair(payoffPrincipal: number | null, closingBalance: number) {
    const prior: ScheduleRow = { row: 34, date: d(2026, 8, 1), interest: 0, principal: 5000, balance: 1_000_000 };
    const payoff: ScheduleRow = { row: 35, date: d(2027, 3, 1), interest: null, principal: payoffPrincipal, balance: 0 };
    const regular: ScheduleRow = { row: 36, date: d(2027, 3, 1), interest: 4000, principal: 5000, balance: closingBalance };
    return { prior, payoff, regular };
  }

  function run(rows: ScheduleRow[], bookPrincipal: number) {
    return crossCheckSchedule({
      id: 'perm-loan',
      rows,
      declaredRangeEnd: 36,
      share: 1,
      bookInterest: 4000,
      bookPrincipal,
      asOf: ASOF,
    }).filter((f) => f.field === 'principalReconciliation');
  }

  it('FIRES on a real balloon-outside-principal defect regardless of which row is physically last', () => {
    // Balloon parked outside the principal column: $995,000 retired per the balance column,
    // only $5,000 in the principal column. This is the defect check 4 exists to catch.
    const { prior, payoff, regular } = sameDatePair(null, 995_000);

    const payoffLast = run([prior, regular, payoff], 5000);
    const payoffFirst = run([prior, payoff, regular], 5000);

    expect(payoffLast).toHaveLength(1);
    // Same row SET, same dates, same amounts — only physical position differs.
    expect(payoffFirst).toHaveLength(1);
  });

  it('stays SILENT on a correct workbook regardless of physical order (no false accusation)', () => {
    // Balloon correctly recorded IN the principal column: 5,000 + 995,000 = 1,000,000 retired.
    const { prior, payoff, regular } = sameDatePair(995_000, 995_000);

    expect(run([prior, regular, payoff], 1_000_000)).toHaveLength(0);
    expect(run([prior, payoff, regular], 1_000_000)).toHaveLength(0);
  });

  it('reports a schedule whose dates run backwards in row order rather than trusting position', () => {
    const rows: ScheduleRow[] = [
      { row: 11, date: d(2026, 10, 1), interest: 100, principal: 100, balance: 900 },
      { row: 12, date: d(2026, 9, 1), interest: 100, principal: 100, balance: 800 },
    ];
    const flags = crossCheckSchedule({
      id: 'non-monotone', rows, declaredRangeEnd: 12, share: 1,
      bookInterest: 200, bookPrincipal: 200, asOf: ASOF,
    });
    expect(flags.some((f) => /row order|non-monoton|out of date order/i.test(f.issue))).toBe(true);
  });
});

/**
 * L1 (correctness + determinism lenses, independently). `opening = priorRow?.balance ?? recon` —
 * `??` also fires when priorRow EXISTS with balance null, silently rebuilding the opening balance
 * from the first in-window row's own principal: exactly the self-referential construction F-1 was
 * closed for. The comment claimed the fallback applied "only when no prior-period row was scanned
 * at all". A verified null must beat an inferred one.
 */
describe('crossCheckSchedule — L1: an unreadable pre-window balance must not silently reconstruct', () => {
  const rows: ScheduleRow[] = [
    { row: 34, date: d(2026, 8, 1), interest: 0, principal: 5000, balance: null }, // prior, unreadable
    { row: 35, date: d(2026, 9, 1), interest: 0, principal: 5000, balance: 950_000 },
    { row: 36, date: d(2026, 10, 1), interest: 0, principal: 5000, balance: 945_000 },
  ];

  it('reports that the reconciliation did not run instead of quietly passing', () => {
    const flags = crossCheckSchedule({
      id: 'null-prior-balance', rows, declaredRangeEnd: 36, share: 1,
      bookInterest: 0, bookPrincipal: 10_000, asOf: ASOF,
    });
    expect(flags.some((f) => /unreadable|not run|could not be read/i.test(f.issue))).toBe(true);
  });

  it('still reconstructs when the loan genuinely originates inside the window (no prior row)', () => {
    // windowStartIdx === 0: the first in-window row IS the origination row, so reconstruction is
    // legitimate there and must stay silent.
    const originating = rows.slice(1);
    const flags = crossCheckSchedule({
      id: 'originates-in-window', rows: originating, declaredRangeEnd: 36, share: 1,
      bookInterest: 0, bookPrincipal: 10_000, asOf: ASOF,
    });
    expect(flags.filter((f) => /unreadable|not run/i.test(f.issue))).toHaveLength(0);
  });
});

/**
 * M2 (edges lens). `scanStoppedOnGap` was declared on CrossCheckInput, documented as load-bearing
 * ("without this, an early-terminating scan silently disables the truncation check"), computed and
 * returned by scanSchedule — and never passed or read. A >6-row undated gap starting right where
 * the summing range ends leaves lastRow === declaredRangeEnd, so neither check-2 branch can fire
 * and a continuation below the gap is invisible to ALL FOUR checks, permanently.
 */
describe('crossCheckSchedule — M2: a schedule continuation below a gap must not read as clean', () => {
  const rows = schedule(2026, 9, 1, 12, 1000, 500, { firstRow: 29 }); // rows 29..40

  it('FIRES when a dated row was observed below the gap the scan stopped on', () => {
    const flags = crossCheckSchedule({
      id: 'continuation', rows, declaredRangeEnd: 40, share: 1,
      bookInterest: 12_000, bookPrincipal: 6000, asOf: ASOF,
      scanFirstRowBeyondGap: 48,
    });
    const hit = flags.filter((f) => f.field === 'scheduleRange');
    expect(hit).toHaveLength(1);
    expect(hit[0]!.issue).toMatch(/continue|continuation/i);
    expect(hit[0]!.issue).toContain('48');
  });

  it('stays SILENT when the schedule genuinely ended at the gap (nothing observed below)', () => {
    // This is also the ordinary case of a range that covers its schedule exactly — an earlier
    // heuristic version of this check false-positived on precisely that shape.
    const flags = crossCheckSchedule({
      id: 'genuine-end', rows, declaredRangeEnd: 40, share: 1,
      bookInterest: 12_000, bookPrincipal: 6000, asOf: ASOF,
      scanFirstRowBeyondGap: null,
    });
    expect(flags.filter((f) => f.field === 'scheduleRange')).toHaveLength(0);
  });
});

describe('scanSchedule — M2: the gap lookahead observes a continuation without adopting it', () => {
  /** Dated rows 11..40, a 7-row banner gap at 41..47, then a continuation at 48..50. */
  function sheetWithContinuation() {
    return {
      rowCount: 50,
      getCell: (addr: string) => {
        const row = Number(/\d+/.exec(addr)?.[0] ?? 0);
        const dated = (row >= 11 && row <= 40) || (row >= 48 && row <= 50);
        return dated
          ? { value: d(2026, 9, 1), model: { result: d(2026, 9, 1) } }
          : { value: null, model: {} };
      },
    } as unknown as Parameters<typeof scanSchedule>[0];
  }

  it('reports the first dated row below the gap and leaves rows untouched', () => {
    const out = scanSchedule(sheetWithContinuation(), { date: 'B', interest: 'D' }, 11, { minLastRow: 40 });

    expect(out.stoppedOnGap).toBe(true);
    // Totals must be unchanged — the continuation is detected, never adopted.
    expect(out.rows).toHaveLength(30);
    expect(out.rows[out.rows.length - 1]!.row).toBe(40);
    expect(out.firstRowBeyondGap).toBe(48);
  });

  it('reports null when the schedule really does end at the gap', () => {
    const ws = {
      rowCount: 50,
      getCell: (addr: string) => {
        const row = Number(/\d+/.exec(addr)?.[0] ?? 0);
        return row >= 11 && row <= 40
          ? { value: d(2026, 9, 1), model: { result: d(2026, 9, 1) } }
          : { value: null, model: {} };
      },
    } as unknown as Parameters<typeof scanSchedule>[0];

    const out = scanSchedule(ws, { date: 'B', interest: 'D' }, 11, { minLastRow: 40 });

    expect(out.stoppedOnGap).toBe(true);
    expect(out.firstRowBeyondGap).toBeNull();
  });
});

/**
 * M1 (correctness lens as MEDIUM, edges lens as LOW — same root cause). crossCheckSchedule received
 * `declaredRangeEnd: interestRef.rangeEnd` only; principalRef.rangeEnd was parsed then discarded. So
 * check 2's structural guarantee — which the header says must fire even when today's delta is zero —
 * held for the H (interest) column alone. A truncated I (principal) range excluding a future-dated
 * balloon produced ZERO flags until that balloon entered the 12-month window.
 */
describe('crossCheckSchedule — M1: the principal column’s declared range is checked too', () => {
  // 12 in-window payments (rows 11..22) plus a future-dated balloon at row 23, outside the window.
  const rows: ScheduleRow[] = [
    ...schedule(2026, 9, 1, 12, 1000, 500, { firstRow: 11, openingBalance: 341_000 }),
    { row: 23, date: d(2030, 6, 5), interest: 0, principal: 335_000, balance: 0 },
  ];

  it('FIRES when only the I-column range is truncated and the excluded rows are future-dated', () => {
    const flags = crossCheckSchedule({
      id: 'i-truncated', rows,
      declaredRangeEnd: 23,        // H is intact
      principalRangeEnd: 22,       // I is one row short — excludes the 2030 balloon
      share: 1,
      bookInterest: 12_000, bookPrincipal: 6000, asOf: ASOF,
    });
    expect(flags.some((f) => f.field === 'scheduleRange' && /principal|I\b/i.test(f.issue))).toBe(true);
  });

  it('stays SILENT when both declared ranges cover the schedule', () => {
    const flags = crossCheckSchedule({
      id: 'both-intact', rows,
      declaredRangeEnd: 23, principalRangeEnd: 23, share: 1,
      bookInterest: 12_000, bookPrincipal: 6000, asOf: ASOF,
    });
    expect(flags.filter((f) => f.field === 'scheduleRange')).toHaveLength(0);
  });
});

/**
 * L4 (edges lens). Share detection matched only a trailing `)*0.5`. Equivalent spellings read as
 * share=1.0 against a halved cached H/I, producing a permanent ~50% false divergence on every
 * refresh — never a false clean, but a standing loud false positive is how a warn channel gets
 * ignored, which would then bury a real OI-092 recurrence.
 */
describe('parseElsFormula — L4: Oxford-share detection across equivalent spellings', () => {
  const body = "SUMPRODUCT(('Banwick'!B9:B33>Assumptions!$B$30)*('Banwick'!B9:B33<=EOMONTH(Assumptions!$B$30,12))*'Banwick'!D9:D33)";

  it('reads 0.5 for every spelling Excel treats as a half-share', () => {
    for (const f of [
      `=${body}*0.5`,
      `=${body}*0.50`,
      `=${body}*.5`,
      `=${body}*50%`,
      `=${body}/2`,
      `=0.5*${body}`,
      `=${body} * 0.5 `,
    ]) {
      expect(parseElsFormula(f)?.share, `share for ${f}`).toBe(0.5);
    }
  });

  it('reads 1.0 for a full-share formula', () => {
    expect(parseElsFormula(`=${body}`)?.share).toBe(1);
    // A *0.5 buried in an unrelated inner term is not a whole-formula share multiplier.
    expect(parseElsFormula(`=SUMPRODUCT(('Banwick'!B9:B33>Assumptions!$B$30)*0.5*'Banwick'!D9:D33)+1`)?.share).toBe(1);
  });
});

/**
 * L3 (correctness lens). maxProbe = max(400, rangeEnd - firstRow + slack) and the gap-break requires
 * r > floor, so the walk could never terminate early INSIDE the declared range. A declared end of
 * 1048576 — what Excel produces when a whole-column reference materialises — forced ~1M ws.getCell
 * calls, which in ExcelJS CREATE row/cell objects for absent cells, inside every parseWorkbook.
 */
describe('scanSchedule — L3: the probe is bounded by the sheet’s own extent', () => {
  it('does not walk a pasted whole-column-equivalent range end', () => {
    let reads = 0;
    const ws = {
      rowCount: 40,
      getCell: (addr: string) => {
        reads += 1;
        const row = Number(/\d+/.exec(addr)?.[0] ?? 0);
        // Dated rows 11..40, nothing below.
        return row >= 11 && row <= 40
          ? { value: d(2026, 9, 1), model: { result: d(2026, 9, 1) } }
          : { value: null, model: {} };
      },
    } as unknown as Parameters<typeof scanSchedule>[0];

    const out = scanSchedule(ws, { date: 'B', interest: 'D' }, 11, { minLastRow: 1_048_576 });

    expect(out.rows.length).toBe(30);
    // Bounded by the sheet, not by the absurd declared end.
    expect(reads).toBeLessThan(5000);
    // Reaching the sheet's physical end IS reaching everything that can exist: rows past rowCount
    // are absent from the sheet XML, so nothing was left unread and the caller must not be told the
    // loan is "unverified". (Corrected after the refute pass — see the RCT case below.)
    expect(out.reachedDeclaredEnd).toBe(true);
  });

  /**
   * REFUTE-PASS REGRESSION (HIGH, confirmed by execution against the live Master Workbook).
   *
   * The first version of the L3 cap made Note Party 02 — H15 declares
   * 'Note Party 02'!B11:B310 while the sheet's rowCount is 60 — report "ran out of probe
   * budget ... this loan's total and its truncation check are both unverified" on EVERY refresh.
   * Old code: 0 flags. New code: 1 permanent false flag on a real loan, in the DSCR-denominator
   * audit channel. That over-declared shape is the exact one ScanResult's own doc calls NORMAL and
   * says "must stay silent", and my in-code comment asserting the firing was correct was wrong.
   *
   * The 24 tests added in the first pass structurally could not catch it: every mock either set
   * rowCount at/above its declared end, or omitted rowCount entirely (which the escape hatch maps
   * to old behavior). None modeled declaredEnd >> rowCount.
   */
  it('stays silent on the live RCT shape: declared end 310 over a 60-row sheet', () => {
    const ws = {
      rowCount: 60,
      getCell: (addr: string) => {
        const row = Number(/\d+/.exec(addr)?.[0] ?? 0);
        return row >= 11 && row <= 37
          ? { value: d(2026, 9, 1), model: { result: d(2026, 9, 1) } }
          : { value: null, model: {} };
      },
    } as unknown as Parameters<typeof scanSchedule>[0];

    const out = scanSchedule(ws, { date: 'B', interest: 'D' }, 11, { minLastRow: 310 });

    expect(out.rows).toHaveLength(27);
    expect(out.reachedDeclaredEnd).toBe(true);

    // And end-to-end: no scheduleRange flag of any kind for this loan.
    const flags = crossCheckSchedule({
      id: 'Note Party 02', rows: out.rows, declaredRangeEnd: 310, share: 1,
      bookInterest: 0, bookPrincipal: null, asOf: ASOF,
      scanReachedDeclaredEnd: out.reachedDeclaredEnd,
      scanFirstRowBeyondGap: out.firstRowBeyondGap,
    });
    expect(flags.filter((f) => f.field === 'scheduleRange')).toHaveLength(0);
  });
});

/**
 * REFUTE-PASS REGRESSION (MEDIUM). The first parseShare dropped the old regex's requirement that
 * the half-multiplier follow a closing paren, so it read a SUBTERM multiplier as a whole-formula
 * share: `=SUMPRODUCT(...)-'Escrow'!B2*0.5` halved the entire recomputation where the old code
 * correctly read 1. By Excel's operator precedence the half binds the subterm only. Effect is a
 * permanent ~50% false divergence — the exact standing-noise class L4 existed to remove.
 */
describe('parseElsFormula — REFUTE: a subterm multiplier is not a whole-formula share', () => {
  const body = "SUMPRODUCT(('Banwick'!B9:B33>Assumptions!$B$30)*('Banwick'!B9:B33<=EOMONTH(Assumptions!$B$30,12))*'Banwick'!D9:D33)";

  it('reads 1.0 when the half applies only to a trailing or leading subterm', () => {
    for (const f of [
      `=${body}-'Escrow'!B2*0.5`,
      `=${body}+Assumptions!B31/2`,
      `=${body}-C5/2`,
      `=0.5*Assumptions!B31+${body}`,
      `=${body}+H50*0.5`,
    ]) {
      expect(parseElsFormula(f)?.share, `share for ${f}`).toBe(1);
    }
  });

  it('still reads 0.5 for a genuine whole-formula half-share', () => {
    for (const f of [`=${body}*0.5`, `=${body}*0.50`, `=${body}*.5`, `=${body}*50%`, `=${body}/2`, `=0.5*${body}`]) {
      expect(parseElsFormula(f)?.share, `share for ${f}`).toBe(0.5);
    }
  });
});

/**
 * REFUTE-PASS REGRESSION (MEDIUM, reproduced by execution). The M3 rewrite applied `laterOf` to
 * priorRow and lastWithBalance but selected windowStartRow with a bare `r.date < ...`, so on a date
 * tie it kept the first PHYSICAL row with no balance tie-break — breaking its own stated contract on
 * the origination-inside-window path. And when that row's balance was null the code fell to a bare
 * `opening = null` with NO flag, contradicting L1's own "a verified null beats an inferred one".
 */
describe('crossCheckSchedule — REFUTE: the origination path must be permutation-invariant too', () => {
  const origination: ScheduleRow = { row: 10, date: d(2026, 9, 1), interest: 0, principal: 0, balance: 1_000_000 };
  const payment: ScheduleRow = { row: 12, date: d(2026, 10, 1), interest: 4000, principal: 10_000, balance: 990_000 };

  function run(rows: ScheduleRow[]) {
    return crossCheckSchedule({
      id: 'originates-in-window', rows, declaredRangeEnd: 12, share: 1,
      bookInterest: 4000, bookPrincipal: 10_000, asOf: ASOF,
    }).filter((f) => f.field === 'principalReconciliation');
  }

  it('does not fire a false accusation when a same-dated balance-0 row is physically first', () => {
    // A holdback/annotation row sharing the origination date. Financially identical either way.
    const annotation: ScheduleRow = { row: 11, date: d(2026, 9, 1), interest: null, principal: null, balance: 0 };

    expect(run([origination, annotation, payment])).toHaveLength(0);
    expect(run([annotation, origination, payment])).toHaveLength(0);
  });

  it('reports rather than silently skipping when the origination balance is unreadable', () => {
    // Real defect present: principal column says 5,000 but the balance column moved 10,000.
    const nullBal: ScheduleRow = { row: 11, date: d(2026, 9, 1), interest: null, principal: null, balance: null };
    const defective: ScheduleRow = { ...payment, principal: 5000 };

    for (const rows of [[origination, nullBal, defective], [nullBal, origination, defective]]) {
      const flags = crossCheckSchedule({
        id: 'unreadable-origination', rows, declaredRangeEnd: 12, share: 1,
        bookInterest: 4000, bookPrincipal: 5000, asOf: ASOF,
      });
      // Either the defect is caught, or the inability to check it is reported — never silence.
      expect(flags.some((f) => f.field === 'principalReconciliation')).toBe(true);
    }
  });
});

describe('crossCheckSchedule — D: duplicate-date detection tolerates a rounding cent', () => {
  it('still FIRES when the repeated amount is one cent off, not bit-identical', () => {
    const rows = schedule(2027, 3, 26, 6, REDACTED-AMT, 0); // interest-only, matches Note Party 03's shape
    const dupeDate = rows[2]!.date;
    rows.push({ row: rows[rows.length - 1]!.row + 1, date: dupeDate, interest: 1365.01, principal: null, balance: 0 });

    const flags = crossCheckSchedule({
      id: 'note-party-03',
      rows,
      declaredRangeEnd: rows[rows.length - 1]!.row,
      share: 1,
      bookInterest: rows.reduce((s, r) => s + (r.interest ?? 0), 0),
      bookPrincipal: null,
      asOf: ASOF,
    });

    expect(flags.filter((f) => f.field === 'duplicatePaymentDate')).toHaveLength(1);
  });

  it('stays silent when two same-date rows carry genuinely different amounts', () => {
    // Not every shared date is the duplicate-row defect — two distinct schedule events (a regular
    // payment and an unrelated fee/adjustment row, say) can legitimately land on the same calendar
    // date. Only a REPEATED amount signals the double-counting shape; two rows that merely share a
    // date but disagree on both interest and principal must not fire.
    const rows = schedule(2027, 3, 26, 6, REDACTED-AMT, 500);
    const dupeDate = rows[2]!.date;
    rows.push({ row: rows[rows.length - 1]!.row + 1, date: dupeDate, interest: 9999, principal: 8888, balance: 0 });

    const flags = crossCheckSchedule({
      id: 'distinct-same-date-rows',
      rows,
      declaredRangeEnd: rows[rows.length - 1]!.row,
      share: 1,
      bookInterest: rows.reduce((s, r) => s + (r.interest ?? 0), 0),
      bookPrincipal: rows.reduce((s, r) => s + (r.principal ?? 0), 0),
      asOf: ASOF,
    });

    expect(flags.filter((f) => f.field === 'duplicatePaymentDate')).toEqual([]);
  });
});
