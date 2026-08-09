// tests/unit/debt-service-recompute.test.ts
//
// OI-092 detector REBUILD (the first attempt was withdrawn — see
// docs/superpowers/plans/withdrawn-detector-oi092/README.md). The withdrawn design counted
// payment rows inside a re-derived window, which can never detect a bug that lives in the
// workbook's OWN formula: reverting the workbook to the buggy `TODAY()+366` window still
// passed the count check while the dollar figure was wrong, and it false-fired on duplicate
// schedule dates because it counted rows instead of distinct dates.
//
// This suite encodes the CORRECT design: independently recompute each loan's next-12-month
// interest/principal from its FULL amortization schedule (open-ended scan — no lastRow) and
// cross-check the workbook's own `External Loans Summary` H/I/J figures against that
// recomputation. Two independent computations compared — a wrong window (OI-092), a
// truncated range (OI-094), a balloon-excluding basis (OI-095), a duplicate-date shape
// (OI-096), and a wrong column mapping all surface as dollar mismatches.
//
// Constraints under test (numbering follows the rebuild brief):
//   1. distinct dates, not row counts        → 'OI-096 duplicate-date shape' block
//   2. Oxford-share ×0.5 read from formulas  → 'Oxford-share multiplier' block
//   3. lender-row sign convention            → lender fixtures carry −ABS() signs throughout
//   4. new sheet access, not parseLoans      → module reads External Loans Summary directly
//   5. balloon-inclusive lender principal    → 'OI-095' block
//   6. WARN severity, never blocking         → every defect assertion checks severity==='warn'
//   7. no ">2 decimal places" heuristic      → detector compares recomputed dollars only
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DataQualityFlag } from '@contracts/index';
import {
  checkAnnualDebtService,
  eomonthMonths,
  extractTrailingMultiplier,
  normalizeLoanName,
  readNumericCell,
  SCHEDULE_RECOMPUTE_SOURCES,
  NO_SCHEDULE_LOANS,
} from '../../server/workbook/debt-service-recompute';
import { parseWorkbook } from '../../server/workbook/parse';

type Worksheet = ExcelJS.Worksheet;

// ── fixture builders ────────────────────────────────────────────────────────────────────

/** UTC date helper — ExcelJS surfaces workbook dates as JS Dates; UTC keeps math stable. */
function d(iso: string): Date {
  return new Date(`${iso}T00:00:00.000Z`);
}

/** Assumptions sheet with the MONTH-END LOAN CLOSE block (label col A, value col B — the
 *  real workbook's B30 layout, label-scanned rather than hardcoded to row 30). */
function addAssumptions(wb: ExcelJS.Workbook, asOf: Date | null): Worksheet {
  const ws = wb.addWorksheet('Assumptions');
  ws.getCell(29, 1).value = '── MONTH-END LOAN CLOSE ──';
  if (asOf) {
    ws.getCell(30, 1).value = 'Loan As-Of Date (current month-end):';
    // The real B30 is a formula whose cached result is a Date — mirror that shape.
    ws.getCell(30, 2).value = { formula: 'EOMONTH(TODAY(),0)', result: asOf } as ExcelJS.CellValue;
  }
  return ws;
}

interface ElsRow {
  name: string;
  role: 'Borrower' | 'Lender';
  /** H / I / J as either plain numbers or { formula, result } shells. */
  h?: ExcelJS.CellValue;
  i?: ExcelJS.CellValue;
  j?: ExcelJS.CellValue;
}

/** External Loans Summary with the real sheet's shape: header r4, borrower banner r5,
 *  loan rows from r6 (Role in col C anchors data rows; banners smear text across columns). */
function addEls(wb: ExcelJS.Workbook, rows: ElsRow[]): Worksheet {
  const ws = wb.addWorksheet('External Loans Summary');
  ws.getCell(4, 1).value = 'Loan Name';
  ws.getCell(4, 3).value = 'Role';
  ws.getCell(4, 8).value = 'Annual Interest\n(Next 12 Months)';
  ws.getCell(4, 9).value = 'Annual Principal\n(Next 12 Months)';
  ws.getCell(4, 10).value = 'Annual Debt\nService';
  const banner = '▼  WE ARE THE BORROWER  —  banner row (spans every column)';
  for (let c = 1; c <= 13; c++) ws.getCell(5, c).value = banner;
  let r = 6;
  for (const row of rows) {
    ws.getCell(r, 1).value = row.name;
    ws.getCell(r, 3).value = row.role;
    if (row.h !== undefined) ws.getCell(r, 8).value = row.h;
    if (row.i !== undefined) ws.getCell(r, 9).value = row.i;
    if (row.j !== undefined) ws.getCell(r, 10).value = row.j;
    r += 1;
  }
  // TOTALS row — no Role, must never be read as a loan.
  ws.getCell(r, 1).value = 'BORROWER TOTALS';
  ws.getCell(r, 8).value = 999999;
  return ws;
}

interface ScheduleRow {
  date: Date;
  /** column → value, e.g. { 4: 15000, 5: 7500 } for D/E. */
  cells: Record<number, ExcelJS.CellValue>;
}

/**
 * Banwick-shaped schedule: dates col B, payments from row 11, interest col D, principal
 * col E. Rows 1–10 mirror the real sheet's header block INCLUDING the adversarial part:
 * B7 holds a real Date ("First Payment Date") with NUMBERS beside it — harder than the live
 * sheet, where the adjacent cells are text. A detector that ignores `firstRow` and sweeps
 * the whole sheet would ingest row 7 and every clean-fixture test here would fail.
 */
function addBanwickSchedule(wb: ExcelJS.Workbook, rows: ScheduleRow[]): Worksheet {
  const ws = wb.addWorksheet('Banwick-Morrison');
  ws.getCell(1, 1).value = 'Banwick/Morrison — Amortization Schedule (fixture)';
  ws.getCell(4, 1).value = 'Original Principal';
  ws.getCell(4, 2).value = 3725000;
  ws.getCell(7, 1).value = 'First Payment Date';
  ws.getCell(7, 2).value = d('2026-06-05'); // Date in the DATE COLUMN, above firstRow
  ws.getCell(7, 4).value = 999999; // adversarial: numbers where the live sheet has text
  ws.getCell(7, 5).value = 999999;
  ws.getCell(10, 1).value = 'Payment #';
  ws.getCell(10, 2).value = 'Payment Date';
  ws.getCell(10, 4).value = 'Interest Paid';
  ws.getCell(10, 5).value = 'Principal Reduction';
  let r = 11;
  for (const row of rows) {
    ws.getCell(r, 2).value = row.date;
    for (const [c, v] of Object.entries(row.cells)) ws.getCell(r, Number(c)).value = v;
    r += 1;
  }
  // Post-schedule derived block (the real sheet's NOI derivation): a bare number in the
  // date column that must never be swept in as a payment.
  ws.getCell(r + 2, 1).value = 'NOI DERIVATION (fixture)';
  ws.getCell(r + 3, 2).value = 276714.48;
  return ws;
}

/** Monthly Banwick payment rows: `count` payments on the 5th, starting `firstIso`. */
function banwickPayments(firstIso: string, count: number, interest = 15000, principal = 7500): ScheduleRow[] {
  const out: ScheduleRow[] = [];
  const first = d(firstIso);
  for (let k = 0; k < count; k++) {
    const dt = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + k, first.getUTCDate()));
    out.push({ date: dt, cells: { 4: interest, 5: principal } });
  }
  return out;
}

function runCheck(wb: ExcelJS.Workbook): DataQualityFlag[] {
  const flags: DataQualityFlag[] = [];
  checkAnnualDebtService((name) => wb.getWorksheet(name), flags);
  return flags;
}

const ADS = (flags: DataQualityFlag[]) => flags.filter((f) => f.field === 'annualDebtService');

// ── pure helper units ───────────────────────────────────────────────────────────────────

describe('eomonthMonths — Excel EOMONTH semantics (the ratified window right edge)', () => {
  it('month-end anchor stays month-end 12 months out', () => {
    expect(eomonthMonths(d('2026-08-31'), 12).toISOString().slice(0, 10)).toBe('2027-08-31');
  });
  it('February month-end into a leap year lands on Feb 29 (the EDATE under-capture case)', () => {
    // EDATE(2027-02-28,12) = 2028-02-28 under-captured a month-end payer; EOMONTH = 2028-02-29.
    expect(eomonthMonths(d('2027-02-28'), 12).toISOString().slice(0, 10)).toBe('2028-02-29');
  });
  it('mid-month anchor snaps to the target month end', () => {
    expect(eomonthMonths(d('2026-01-15'), 12).toISOString().slice(0, 10)).toBe('2027-01-31');
  });
  it('handles negative month offsets', () => {
    expect(eomonthMonths(d('2026-03-31'), -1).toISOString().slice(0, 10)).toBe('2026-02-28');
  });
});

describe('readNumericCell — ExcelJS cell unwrapping', () => {
  it('passes plain finite numbers through', () => {
    expect(readNumericCell(146269.26)).toBe(146269.26);
  });
  it('unwraps a formula cell to its cached result', () => {
    expect(readNumericCell({ formula: 'SUM(A1:A2)', result: 275031.24 })).toBe(275031.24);
  });
  it('reads a formula cell with an ABSENT cached result as 0 (verified live: Excel omits cached zeros — ELS I14/I16)', () => {
    expect(readNumericCell({ formula: '0' })).toBe(0);
    expect(readNumericCell({ sharedFormula: 'H6', result: undefined })).toBe(0);
  });
  it('returns null for blanks, Dates, and rich text', () => {
    expect(readNumericCell(null)).toBeNull();
    expect(readNumericCell(undefined)).toBeNull();
    expect(readNumericCell(d('2026-08-31'))).toBeNull();
    expect(readNumericCell({ richText: [{ text: '12' }] })).toBeNull();
  });
  it('parses formatted numeric strings, rejects garbage', () => {
    expect(readNumericCell('$1,234.50')).toBe(1234.5);
    expect(readNumericCell('Demand')).toBeNull();
  });
});

describe('extractTrailingMultiplier — Oxford-share factor read from the workbook formula', () => {
  it('reads ×0.5 from the live 9050 Red Branch H-column formula shape', () => {
    expect(
      extractTrailingMultiplier(
        "SUMPRODUCT(('9050 Red Branch Road'!B$11:B$158>Assumptions!$B$30)*('9050 Red Branch Road'!B$11:B$158<=EOMONTH(Assumptions!$B$30,12))*'9050 Red Branch Road'!C$11:C$158)*0.5",
      ),
    ).toBe(0.5);
  });
  it('reads ×0.5 through the lender −ABS(...) wrapper (live RCT I-column shape)', () => {
    expect(
      extractTrailingMultiplier(
        "-ABS(SUMPRODUCT(ISNUMBER('Restoration Church Trust'!B11:B310)*('Restoration Church Trust'!B11:B310>Assumptions!$B$30)*('Restoration Church Trust'!B11:B310<=EOMONTH(Assumptions!$B$30,12))*'Restoration Church Trust'!E11:E310))*0.5",
      ),
    ).toBe(0.5);
  });
  it('defaults to 1 when no trailing factor exists (live 3540/Banwick/29000 shapes)', () => {
    expect(
      extractTrailingMultiplier(
        "SUMPRODUCT(('Banwick-Morrison'!B11:B71>Assumptions!$B$30)*('Banwick-Morrison'!B11:B71<=EOMONTH(Assumptions!$B$30,12))*'Banwick-Morrison'!D11:D71)",
      ),
    ).toBe(1);
    expect(extractTrailingMultiplier(null)).toBe(1);
  });
  it('reads an arbitrary factor — the multiplier is data, not a hardcoded loan property', () => {
    expect(extractTrailingMultiplier('SUMPRODUCT(X)*0.25')).toBe(0.25);
    expect(extractTrailingMultiplier('SUMPRODUCT(X)*2')).toBe(2);
  });
});

describe('normalizeLoanName — ELS display names resolve to mapping keys', () => {
  it('normalizes every live External Loans Summary display name to its mapping key', () => {
    expect(normalizeLoanName('3540 E. Fifth Ave')).toBe('3540efifthave');
    expect(normalizeLoanName('9050 Red Branch Road')).toBe('9050redbranchroad');
    expect(normalizeLoanName('29000 Information Lane')).toBe('29000informationlane');
    expect(normalizeLoanName('Banwick/Morrison')).toBe('banwickmorrison');
    expect(normalizeLoanName('Restoration Church Trust')).toBe('restorationchurchtrust');
    expect(normalizeLoanName('485 S. Walnut St.')).toBe('485swalnutst');
    expect(normalizeLoanName('3883 from Oxford')).toBe('3883fromoxford');
    expect(normalizeLoanName('1100 Rarig (Fenton)')).toBe('1100rarigfenton');
  });
  it('every mapping key and no-schedule key is reachable from a normalized name (no orphans)', () => {
    const reachable = new Set([
      '3540efifthave', '9050redbranchroad', '29000informationlane', 'banwickmorrison',
      'restorationchurchtrust', '485swalnutst', '3883fromoxford', '1100rarigfenton',
    ]);
    for (const key of Object.keys(SCHEDULE_RECOMPUTE_SOURCES)) expect(reachable.has(key), key).toBe(true);
    for (const key of NO_SCHEDULE_LOANS) expect(reachable.has(key), key).toBe(true);
  });
});

// ── the detector ────────────────────────────────────────────────────────────────────────

describe('checkAnnualDebtService — clean workbook', () => {
  it('a correct borrower loan raises no flags (and the header-block date row above firstRow is ignored)', () => {
    const wb = new ExcelJS.Workbook();
    addAssumptions(wb, d('2026-08-31'));
    // 24 monthly payments from 2026-06-05; window (2026-08-31, 2027-08-31] holds exactly 12.
    addBanwickSchedule(wb, banwickPayments('2026-06-05', 24));
    addEls(wb, [{
      name: 'Banwick/Morrison', role: 'Borrower',
      h: { formula: 'SUMPRODUCT(x)', result: 12 * 15000 } as ExcelJS.CellValue,
      i: { formula: 'SUMPRODUCT(x)', result: 12 * 7500 } as ExcelJS.CellValue,
      j: { formula: 'ABS(H6)+ABS(I6)', result: 12 * 22500 } as ExcelJS.CellValue,
    }]);
    expect(runCheck(wb)).toEqual([]);
  });

  it('stays FULLY silent when there is no External Loans Summary sheet at all (nothing to check)', () => {
    // Fixture workbooks without the summary sheet are the one legitimately-silent case —
    // there is nothing to verify, so no "disabled" notice either. Must not regress.
    const wb = new ExcelJS.Workbook();
    addAssumptions(wb, d('2026-08-31'));
    expect(runCheck(wb)).toEqual([]);
  });

  it('ELS present but the as-of anchor missing → ONE info flag, never silence (disabled ≠ clean)', () => {
    // REFUTE fix: a silent return here would let a single Assumptions label rename disable
    // the whole detector permanently with zero signal — the verified-null vs inferred-null
    // failure. A disabled detector must announce itself.
    const missingAnchorCases: ExcelJS.Workbook[] = [];

    const wb1 = new ExcelJS.Workbook(); // Assumptions sheet absent entirely
    addEls(wb1, [{ name: 'Banwick/Morrison', role: 'Borrower', h: 1, i: 1, j: 2 }]);
    missingAnchorCases.push(wb1);

    const wb2 = new ExcelJS.Workbook(); // Assumptions exists, "Loan As-Of Date" label absent
    addAssumptions(wb2, null);
    addEls(wb2, [{ name: 'Banwick/Morrison', role: 'Borrower', h: 1, i: 1, j: 2 }]);
    missingAnchorCases.push(wb2);

    for (const wb of missingAnchorCases) {
      const flags = runCheck(wb);
      expect(flags).toHaveLength(1);
      expect(flags[0]!.severity).toBe('info');
      expect(flags[0]!.field).toBe('annualDebtService');
      expect(flags[0]!.issue).toMatch(/disabled/i);
      expect(flags[0]!.issue).toMatch(/loan as-of date/i);
    }
  });
});

describe('OI-092 regression — the workbook window carried a 13th payment', () => {
  /** Fixture reproducing the original defect: `TODAY()` landed on the payment day-of-month,
   *  so the half-open 366-day window captured 13 payments. The schedule DATA is correct —
   *  only the workbook's cached H/I/J carry the inflated figures. */
  function buggyWindowWorkbook(): { wb: ExcelJS.Workbook; scheduleDates: Date[] } {
    const wb = new ExcelJS.Workbook();
    const asOf = d('2026-09-05'); // manual-override close on a payment day — the coincidence
    addAssumptions(wb, asOf);
    const rows = banwickPayments('2026-06-05', 24);
    addBanwickSchedule(wb, rows);
    // Buggy figures: [2026-09-05, 2027-09-06) captured 2026-09-05 AND 2027-09-05 → 13 payments.
    addEls(wb, [{
      name: 'Banwick/Morrison', role: 'Borrower',
      h: { formula: 'SUMPRODUCT(buggy window)', result: 13 * 15000 } as ExcelJS.CellValue,
      i: { formula: 'SUMPRODUCT(buggy window)', result: 13 * 7500 } as ExcelJS.CellValue,
      j: { formula: 'ABS(H6)+ABS(I6)', result: 13 * 22500 } as ExcelJS.CellValue,
    }]);
    return { wb, scheduleDates: rows.map((r) => r.date) };
  }

  it('flags the inflated annual debt service at WARN severity', () => {
    const { wb } = buggyWindowWorkbook();
    const flags = ADS(runCheck(wb));
    expect(flags).toHaveLength(1);
    const flag = flags[0]!;
    expect(flag.severity).toBe('warn'); // constraint 6: never blocking
    expect(flag.issue).toMatch(/recomputed/i);
    expect(flag.entity).toContain('banwick');
  });

  it('a count-only detector (the withdrawn shape) reports ALL-CLEAN on this same defect', () => {
    // The withdrawn design re-derived its own correct window and counted schedule rows in it.
    // The schedule data here is correct — exactly 12 distinct dates in the correct window —
    // so a count check passes while the workbook's dollars are wrong by one payment. This
    // test pins the shape difference: if the detector ever regresses to counting, the
    // previous test starts failing while this one keeps passing, flagging the resurrection.
    const { wb, scheduleDates } = buggyWindowWorkbook();
    const asOf = d('2026-09-05');
    const end = eomonthMonths(asOf, 12);
    const distinctInWindow = new Set(
      scheduleDates.filter((x) => x > asOf && x <= end).map((x) => x.toISOString()),
    ).size;
    expect(distinctInWindow).toBe(12); // count says clean…
    expect(ADS(runCheck(wb))).toHaveLength(1); // …the dollar cross-check says defect
  });
});

describe('OI-096 duplicate-date shape — 485 S Walnut two rows, one date (constraint 1)', () => {
  /** Walnut-shaped lender schedule in its CORRECTED form: 36 IO payments on the 26th, then a
   *  payoff row r46 sharing the final date (D=252,000 principal, E=0). Interest = col E,
   *  principal = D−E — the live sheet's column semantics. */
  function walnutWorkbook(): { wb: ExcelJS.Workbook; scheduleDates: Date[] } {
    const wb = new ExcelJS.Workbook();
    addAssumptions(wb, d('2027-10-31'));
    const ws = wb.addWorksheet('485 S Walnut St');
    ws.getCell(9, 1).value = 'Pmt #';
    ws.getCell(9, 2).value = 'Payment Date';
    ws.getCell(9, 4).value = 'Monthly Payment';
    ws.getCell(9, 5).value = 'Interest Paid';
    const first = d('2025-10-26');
    const dates: Date[] = [];
    for (let k = 0; k < 36; k++) {
      const dt = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth() + k, 26));
      dates.push(dt);
      ws.getCell(10 + k, 2).value = dt;
      ws.getCell(10 + k, 4).value = 1365;
      ws.getCell(10 + k, 5).value = 1365;
    }
    // r46: payoff row — SAME date as the 36th payment, pure balloon after the OI-096 fix.
    const balloonDate = dates[35]!;
    dates.push(balloonDate);
    ws.getCell(46, 2).value = balloonDate;
    ws.getCell(46, 4).value = 252000;
    ws.getCell(46, 5).value = 0;
    ws.getCell(47, 1).value = 'TOTALS';
    ws.getCell(47, 4).value = { formula: 'SUM(D10:D46)', result: 301140 } as ExcelJS.CellValue;
    // Window (2027-10-31, 2028-10-31]: 11 IO payments + the balloon principal.
    addEls(wb, [{
      name: '485 S. Walnut St.', role: 'Lender',
      h: { formula: '-ABS(SUMPRODUCT(x))', result: -(11 * 1365) } as ExcelJS.CellValue,
      i: { formula: '-ABS(SUMPRODUCT(x))', result: -252000 } as ExcelJS.CellValue,
      j: { formula: 'H16+I16', result: -(11 * 1365 + 252000) } as ExcelJS.CellValue,
    }]);
    return { wb, scheduleDates: dates };
  }

  it('does NOT false-fire on two schedule rows sharing one date (the withdrawn design did)', () => {
    const { wb, scheduleDates } = walnutWorkbook();
    // Document the trap: rows-in-window ≠ distinct-dates-in-window on this legitimate shape.
    const asOf = d('2027-10-31');
    const end = eomonthMonths(asOf, 12);
    const inWindow = scheduleDates.filter((x) => x > asOf && x <= end);
    const distinct = new Set(inWindow.map((x) => x.toISOString())).size;
    expect(inWindow.length).toBe(distinct + 1); // row count over-counts the duplicate date
    expect(runCheck(wb)).toEqual([]); // dollar cross-check stays quiet — no defect exists
  });

  it('lender-row −ABS() sign convention: magnitudes compare, signs never trip it (constraint 3)', () => {
    // H/I/J above are all negative (capital deployed by Oxford) while the recomputed sums are
    // positive magnitudes. Zero flags proves the comparison is sign-agnostic, matching
    // src/analytics/conditions.ts (annualDebtService: magnitude, never signed flow).
    const { wb } = walnutWorkbook();
    expect(runCheck(wb)).toEqual([]);
  });
});

describe('OI-095 regression — lender principal must be balloon-inclusive (constraint 5)', () => {
  /** RCT-shaped lender schedule: monthly 20th payments, a balloon row (E carries the full
   *  balloon after the Turn-149 fix), and the 50%-share MEMO row (col C only — D/E empty,
   *  it must never enter a D/E sum). H/I carry the −ABS(...)×0.5 Oxford-share shape. */
  function rctWorkbook(opts: { balloonExcludedFromI: boolean }): ExcelJS.Workbook {
    const wb = new ExcelJS.Workbook();
    addAssumptions(wb, d('2026-08-31'));
    const ws = wb.addWorksheet('Restoration Church Trust');
    ws.getCell(6, 1).value = 'Origination Date';
    ws.getCell(6, 2).value = d('2025-03-26'); // header Date in the date column, above firstRow
    ws.getCell(10, 1).value = 'Month #';
    ws.getCell(10, 2).value = 'Payment Date';
    ws.getCell(10, 3).value = 'Payment Amount';
    ws.getCell(10, 4).value = 'Interest Paid';
    ws.getCell(10, 5).value = 'Principal Reduction';
    const interest = 14600;
    const principal = 2100;
    // 6 payments 2026-09-20 … 2027-02-20, all inside (2026-08-31, 2027-08-31].
    for (let k = 0; k < 6; k++) {
      const dt = new Date(Date.UTC(2026, 8 + k, 20));
      ws.getCell(11 + k, 2).value = dt;
      ws.getCell(11 + k, 4).value = interest;
      ws.getCell(11 + k, 5).value = principal;
    }
    const balloon = 1945102.73;
    ws.getCell(17, 1).value = '★ BALLOON PAYMENT DUE 2/20/2027';
    ws.getCell(17, 2).value = d('2027-02-20');
    ws.getCell(17, 3).value = balloon; // Payment Amount
    ws.getCell(17, 5).value = balloon; // Principal Reduction (populated by the OI-095 fix)
    ws.getCell(18, 1).value = '  Oxford 50% Share of Balloon';
    ws.getCell(18, 2).value = d('2027-02-20');
    ws.getCell(18, 3).value = balloon / 2; // MEMO row: col C only, D/E deliberately empty
    const half = (x: number) => -Math.abs(x * 0.5);
    const correctI = half(6 * principal + balloon);
    const defectiveI = half(6 * principal); // the pre-fix basis: balloon absent
    const i = opts.balloonExcludedFromI ? defectiveI : correctI;
    const h = half(6 * interest);
    addEls(wb, [{
      name: 'Restoration Church Trust', role: 'Lender',
      h: { formula: '-ABS(SUMPRODUCT(x))*0.5', result: h } as ExcelJS.CellValue,
      i: { formula: '-ABS(SUMPRODUCT(x))*0.5', result: i } as ExcelJS.CellValue,
      j: { formula: 'H15+I15', result: h + i } as ExcelJS.CellValue,
    }]);
    return wb;
  }

  it('flags a lender row whose forward principal EXCLUDES a contractually-due balloon (WARN)', () => {
    const flags = ADS(runCheck(rctWorkbook({ balloonExcludedFromI: true })));
    expect(flags).toHaveLength(1);
    const flag = flags[0]!;
    expect(flag.severity).toBe('warn');
    expect(flag.issue).toMatch(/principal/i);
  });

  it('stays quiet on the corrected balloon-inclusive basis — and never double-counts the memo row', () => {
    // If the memo row's col-C half-share leaked into the principal sum, the recomputed figure
    // would exceed the workbook's by $972,551.37 and this would false-flag.
    expect(runCheck(rctWorkbook({ balloonExcludedFromI: false }))).toEqual([]);
  });
});

describe('Oxford-share multiplier is read from the formula, never hardcoded (constraint 2)', () => {
  it('a loan that normally carries ×0.5 passes at FULL figures when its formulas carry no factor', () => {
    // 9050 Red Branch is a ×0.5 loan in the live workbook. Present it WITHOUT the factor:
    // a detector with a hardcoded halving list would halve the recomputation and false-flag.
    const wb = new ExcelJS.Workbook();
    addAssumptions(wb, d('2026-08-31'));
    const ws = wb.addWorksheet('9050 Red Branch Road');
    ws.getCell(10, 1).value = 'Pmt #';
    ws.getCell(10, 2).value = 'Payment Date';
    ws.getCell(10, 3).value = 'Interest Paid';
    ws.getCell(10, 4).value = 'Principal Paid';
    for (let k = 0; k < 18; k++) {
      ws.getCell(11 + k, 2).value = new Date(Date.UTC(2026, 5 + k, 1));
      ws.getCell(11 + k, 3).value = 9000;
      ws.getCell(11 + k, 4).value = 15000;
    }
    addEls(wb, [{
      name: '9050 Red Branch Road', role: 'Borrower',
      h: { formula: 'SUMPRODUCT(x)', result: 12 * 9000 } as ExcelJS.CellValue, // no *0.5
      i: { formula: 'SUMPRODUCT(x)', result: 12 * 15000 } as ExcelJS.CellValue,
      j: { formula: 'ABS(H7)+ABS(I7)', result: 12 * 24000 } as ExcelJS.CellValue,
    }]);
    expect(runCheck(wb)).toEqual([]);
  });

  it('a loan that normally has NO factor passes at HALVED figures when its formulas carry ×0.5', () => {
    const wb = new ExcelJS.Workbook();
    addAssumptions(wb, d('2026-08-31'));
    addBanwickSchedule(wb, banwickPayments('2026-06-05', 24));
    addEls(wb, [{
      name: 'Banwick/Morrison', role: 'Borrower',
      h: { formula: 'SUMPRODUCT(x)*0.5', result: 12 * 15000 * 0.5 } as ExcelJS.CellValue,
      i: { formula: 'SUMPRODUCT(x)*0.5', result: 12 * 7500 * 0.5 } as ExcelJS.CellValue,
      j: { formula: 'ABS(H6)+ABS(I6)', result: 12 * 22500 * 0.5 } as ExcelJS.CellValue,
    }]);
    expect(runCheck(wb)).toEqual([]);
  });
});

describe('OI-094 regression — truncated range omits a balloon inside the window', () => {
  it('flags workbook figures computed over a range that stops one row short of the balloon', () => {
    const wb = new ExcelJS.Workbook();
    addAssumptions(wb, d('2026-08-31'));
    const rows = banwickPayments('2026-06-05', 12); // regular payments through 2027-05-05
    // Final schedule row: the balloon, 2027-06-05 — INSIDE the window (2026-08-31, 2027-08-31].
    rows.push({ date: d('2027-06-05'), cells: { 4: 15000, 5: 3333953.68 } });
    addBanwickSchedule(wb, rows);
    // Workbook figures baked from the TRUNCATED range B11:B22 (balloon row excluded):
    // 9 in-window regular payments, no balloon.
    addEls(wb, [{
      name: 'Banwick/Morrison', role: 'Borrower',
      h: { formula: 'SUMPRODUCT(truncated)', result: 9 * 15000 } as ExcelJS.CellValue,
      i: { formula: 'SUMPRODUCT(truncated)', result: 9 * 7500 } as ExcelJS.CellValue,
      j: { formula: 'ABS(H6)+ABS(I6)', result: 9 * 22500 } as ExcelJS.CellValue,
    }]);
    const flags = ADS(runCheck(wb));
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('warn');
    // The dangerous direction: debt service UNDERSTATED (DSCR overstated).
    expect(flags[0]!.issue).toMatch(/principal/i);
  });
});

describe('wrong column mapping — per-component comparison catches what a J-only check cannot', () => {
  it('flags swapped H/I even though their sum (J) still matches', () => {
    const wb = new ExcelJS.Workbook();
    addAssumptions(wb, d('2026-08-31'));
    addBanwickSchedule(wb, banwickPayments('2026-06-05', 24));
    addEls(wb, [{
      name: 'Banwick/Morrison', role: 'Borrower',
      h: { formula: 'SUMPRODUCT(wrong col)', result: 12 * 7500 } as ExcelJS.CellValue, // ← principal
      i: { formula: 'SUMPRODUCT(wrong col)', result: 12 * 15000 } as ExcelJS.CellValue, // ← interest
      j: { formula: 'ABS(H6)+ABS(I6)', result: 12 * 22500 } as ExcelJS.CellValue, // total unchanged
    }]);
    const flags = ADS(runCheck(wb));
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('warn');
    expect(flags[0]!.issue).toMatch(/interest/i);
    expect(flags[0]!.issue).toMatch(/principal/i);
  });
});

describe('coverage of the loan roster — nothing silently unchecked', () => {
  it('known no-schedule loans (3883 synthetic, 1100 Rarig demand note) raise no flags', () => {
    const wb = new ExcelJS.Workbook();
    addAssumptions(wb, d('2026-08-31'));
    addEls(wb, [
      {
        name: '3883 from Oxford', role: 'Borrower',
        h: { formula: 'G10*E10', result: 23113.08 } as ExcelJS.CellValue,
        i: { formula: 'D10-E10', result: 24782 } as ExcelJS.CellValue,
        j: { formula: 'ABS(H10)+ABS(I10)', result: 47895.08 } as ExcelJS.CellValue,
      },
      {
        name: '1100 Rarig (Fenton)', role: 'Lender',
        h: { formula: '-ABS(G14*E14)', result: -33182.7 } as ExcelJS.CellValue,
        i: { formula: '0' } as ExcelJS.CellValue, // cached zero omitted — the live I14 shape
        j: { formula: 'H14+I14', result: -33182.7 } as ExcelJS.CellValue,
      },
    ]);
    expect(runCheck(wb)).toEqual([]);
  });

  it('an UNMAPPED external loan raises an info flag instead of being silently skipped', () => {
    // The withdrawn design's carve-out silently suppressed exactly this class. A future
    // acquisition's loan must announce that it is not being independently verified.
    const wb = new ExcelJS.Workbook();
    addAssumptions(wb, d('2026-08-31'));
    addEls(wb, [{ name: '999 New Acquisition Loan', role: 'Borrower', h: 100, i: 200, j: 300 }]);
    const flags = runCheck(wb);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('info');
    expect(flags[0]!.issue).toMatch(/no schedule mapping|not independently verified/i);
  });

  it('a mapped loan whose amortization sheet is MISSING raises a warn flag (a restructure, not silence)', () => {
    const wb = new ExcelJS.Workbook();
    addAssumptions(wb, d('2026-08-31'));
    addEls(wb, [{ name: 'Banwick/Morrison', role: 'Borrower', h: 100, i: 200, j: 300 }]);
    const flags = runCheck(wb);
    expect(flags).toHaveLength(1);
    expect(flags[0]!.severity).toBe('warn');
    expect(flags[0]!.issue).toMatch(/sheet/i);
  });
});

describe('parseWorkbook wiring — the detector runs inside the normal parse pipeline', () => {
  it('a baked-in window defect surfaces as a warn DataQualityFlag from parseWorkbook()', async () => {
    const wb = new ExcelJS.Workbook();
    // Minimal viable core sheets (mirrors parse-workbook.test.ts's fixture contract).
    const props = wb.addWorksheet('Property NOI');
    props.addRow([
      1, 'Test Property Alpha (Fixture)', 'Industrial', 50000, 3, 0.92, new Date('2020-01-01'),
      5000000, 1, 5000000, 600000, 200000, 400000, 400000, 300000, 100000, 0.08, 1.3,
      'Fixture Bank', 3000000, 0.6, 100, 12, 1500000, 0.08, 5,
    ]);
    wb.addWorksheet('Master Tenant Rent Roll');
    const loans = wb.addWorksheet('Loan Index');
    loans.addRow(['IS BORROWER']);
    loans.addRow([
      1, 'Fixture Loan A', 'Fixture Bank', 3000000, 0.06, 18000,
      new Date('2030-01-01'), 42, 0.6, 'Current',
    ]);
    wb.addWorksheet('Cash Balances');
    wb.addWorksheet('Insurance Renewals');
    wb.addWorksheet('Monthly Checklist');
    addAssumptions(wb, d('2026-09-05'));
    addBanwickSchedule(wb, banwickPayments('2026-06-05', 24));
    addEls(wb, [{
      name: 'Banwick/Morrison', role: 'Borrower',
      h: { formula: 'SUMPRODUCT(buggy)', result: 13 * 15000 } as ExcelJS.CellValue,
      i: { formula: 'SUMPRODUCT(buggy)', result: 13 * 7500 } as ExcelJS.CellValue,
      j: { formula: 'ABS(H6)+ABS(I6)', result: 13 * 22500 } as ExcelJS.CellValue,
    }]);

    const dir = mkdtempSync(join(tmpdir(), 'debt-service-recompute-test-'));
    const file = join(dir, 'fixture.xlsx');
    await wb.xlsx.writeFile(file);

    const { flags } = await parseWorkbook(file);
    const adsFlags = flags.filter((f) => f.field === 'annualDebtService');
    expect(adsFlags).toHaveLength(1);
    expect(adsFlags[0]!.severity).toBe('warn'); // constraint 6: surfaces, never halts
  });
});
