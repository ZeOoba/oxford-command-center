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
  /**
   * Last row the I (PRINCIPAL) formula sums, when it differs from the H (interest) one above.
   *
   * The two are parsed separately and genuinely can diverge. Passing only H's end meant check 2's
   * structural truncation guarantee — the one that must fire even when today's delta is zero,
   * because the excluded rows are simply outside the current window — held for the interest column
   * ALONE. A truncated I range excluding a future-dated balloon produced ZERO flags and stayed
   * silent until that balloon entered the 12-month window: exactly the late-detection failure mode
   * OI-094 was closed for. (2026-08-11 integrity sweep, M1.)
   */
  principalRangeEnd?: number | null;
  /** Oxford-share multiplier applied by the formula (1.0 or 0.5). */
  share: number;
  bookInterest: number;
  /** null when the workbook's principal is synthetic (485 S Walnut: I16 = D16-E16). */
  bookPrincipal: number | null;
  asOf: Date;
  /**
   * True when `scanSchedule` terminated on a run of undated rows rather than reaching the end of
   * its probe. Without this, an early-terminating scan silently disables the truncation check,
   * because that check can only fire when the scan runs PAST the declared range end.
   */
  scanStoppedOnGap?: boolean;
  /**
   * The first dated row found BELOW the gap the scan stopped on, or null when the schedule genuinely
   * ended there. Non-null means the extent is ambiguous: rows past the gap are summed by neither the
   * workbook's formula nor this recomputation, so the two agree while both may understate.
   */
  scanFirstRowBeyondGap?: number | null;
  /** False when the scan never reached the declared range end — see ScanResult. */
  scanReachedDeclaredEnd?: boolean;
}

export interface ScanResult {
  rows: ScheduleRow[];
  /** Whether the walk ended on undated rows (vs exhausting its probe budget). */
  stoppedOnGap: boolean;
  /** First dated row below that gap, if any — detection only, never adopted into `rows`. */
  firstRowBeyondGap: number | null;
  /**
   * Whether the walk actually inspected every row up to the formula's declared range end.
   * A schedule that simply stops early inside a generously over-declared range (Restoration
   * Church Trust declares B11:B310 for a 26-row schedule) is NORMAL and must stay silent; the
   * real hazard is running out of probe budget before reaching the declared end, which would
   * leave the truncation check unable to fire.
   */
  reachedDeclaredEnd: boolean;
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

/**
 * Excel `EOMONTH` semantics: the LAST day of the month `months` away. EOMONTH(2027-02-28, 12)
 * = 2028-02-29, where EDATE would give 2028-02-28.
 *
 * This — not `edateMonths` — is the window's right edge, because the workbook's own formulas use
 * `EOMONTH(Assumptions!$B$30,12)`. They were moved off EDATE precisely because EDATE under-captures
 * (11 payments) for a month-end payer on a February as-of date in a pre-leap year. Computing the
 * end any other way would compare two different windows instead of two computations of one window,
 * and would accuse a correct workbook of the very defect this check exists to find.
 */
export function eomonthMonths(d: Date, months: number): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months + 1, 0));
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
  const {
    id, rows, declaredRangeEnd, principalRangeEnd = null, share, bookInterest, bookPrincipal, asOf,
    scanReachedDeclaredEnd = true, scanFirstRowBeyondGap = null,
  } = input;
  const flags: DataQualityFlag[] = [];

  if (rows.length === 0) {
    return [{
      entity: id,
      field: 'annualDebtService',
      issue: 'no amortization-schedule rows resolved — cross-check could not run',
      severity: 'warn',
    }];
  }

  const end = eomonthMonths(asOf, 12);
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
    // rows is scan-ordered ascending (scanSchedule walks r upward), so the last element is the
    // max — avoids a `Math.max(...spread)` stack overflow on a pathologically large schedule.
    const lastRow = rows[rows.length - 1]!.row;
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
    } else if (!scanReachedDeclaredEnd) {
      // The truncation test above is one-directional, so an early-terminating scan would
      // silently disable it: with lastRow < declaredRangeEnd it can never fire, and a genuinely
      // truncated range reads clean. Report the short scan instead of inferring "no truncation".
      flags.push({
        entity: id,
        field: 'scheduleRange',
        issue:
          `the schedule scan ran out of probe budget at row ${lastRow} without reaching the ` +
          `declared range end (row ${declaredRangeEnd}), so rows in between were never read. ` +
          `This loan's total and its truncation check are both unverified.`,
        rawValue: String(lastRow),
        severity: 'warn',
      });
    }
  }

  // ── 2a. a schedule CONTINUATION below the gap the scan stopped on ─────────────────────────
  // scanSchedule stops after `gapTolerance` undated rows and concludes the schedule ended. When it
  // does so at/after the declared range end, all four checks operate on the truncated row set, so a
  // continuation below the gap is invisible to the recomputation AND to the workbook's own sum
  // IDENTICALLY -- recomputed == book, zero flags, permanently, not merely early. That falsifies
  // this module's contract ("0 flags must mean checked and clean, never checked nothing") in the
  // governor-relevant direction: H under-captures next-12-month debt service, so the DSCR
  // denominator is understated and DSCR reads high.
  //
  // This is reported from an OBSERVATION, not a heuristic. An earlier attempt flagged whenever the
  // scan stopped on a gap at exactly the declared end, which also describes the perfectly normal
  // case of a range that covers its schedule precisely -- it false-positived on the clean fixture.
  // scanSchedule now probes PAST the gap (bounded by the sheet's own extent) purely to detect
  // whether dated rows exist below it, without adopting them into the totals: adopting them could
  // absorb an unrelated dated block further down a hand-maintained sheet and corrupt a figure that
  // is correct today. So the extent is reported as AMBIGUOUS and a human decides.
  // (2026-08-11 integrity sweep, M2 -- the safeguard field was declared and documented as
  // load-bearing, but never passed or read.)
  if (scanFirstRowBeyondGap !== null && rows.length > 0) {
    const lastRow = rows[rows.length - 1]!.row;
    flags.push({
      entity: id,
      field: 'scheduleRange',
      issue:
        `the schedule appears to continue below a blank gap: dated rows stop at row ${lastRow}, but ` +
        `row ${scanFirstRowBeyondGap} carries another date. Rows below that gap are summed by ` +
        `neither the workbook's formula nor this cross-check, so both agree while both may be ` +
        `understating debt service. Either extend the summing range to cover the continuation, or ` +
        `confirm row ${scanFirstRowBeyondGap} is unrelated content rather than a second rate phase.`,
      rawValue: String(scanFirstRowBeyondGap),
      severity: 'warn',
    });
  }

  // ── 2b. the SAME structural test for the I (PRINCIPAL) formula's declared range ───────────
  // Run separately rather than folded into the loop above so the existing H-column message and its
  // pinned assertions stay byte-identical. Skipped when the two ends agree (the common case) so a
  // single truncation cannot be double-reported.
  if (
    principalRangeEnd !== null &&
    principalRangeEnd !== declaredRangeEnd &&
    bookPrincipal !== null
  ) {
    const lastRow = rows[rows.length - 1]!.row;
    if (lastRow > principalRangeEnd) {
      const excluded = rows.filter((r) => r.row > principalRangeEnd);
      const amount = excluded.reduce((s, r) => s + Math.abs(r.principal ?? 0), 0);
      flags.push({
        entity: id,
        field: 'scheduleRange',
        issue:
          `the PRINCIPAL summing range (column I) is truncated independently of the interest range: ` +
          `it ends at row ${principalRangeEnd} but the schedule runs to row ${lastRow}. ` +
          `${excluded.length} dated row(s) carrying ${money(amount)} of principal ` +
          `(through ${iso(excluded[excluded.length - 1]!.date)}) can never be summed. ` +
          `Harmless only while those rows sit outside the forward window — a balloon among them ` +
          `becomes a live understatement of debt service the moment it enters.`,
        rawValue: String(principalRangeEnd),
        severity: 'warn',
      });
    }
  }

  // ── 2c. row order vs payment chronology ──────────────────────────────────────────────────
  // Check 4 below is now date-driven and therefore correct under any row order, but a schedule
  // whose rows run backwards still means the sheet is not what anyone reading it assumes. Verify
  // the assumption instead of silently depending on it.
  if (rows.some((r, i) => i > 0 && r.date < rows[i - 1]!.date)) {
    flags.push({
      entity: id,
      field: 'scheduleOrder',
      issue:
        `schedule rows are not in ascending date order — row order and payment chronology disagree. ` +
        `The cross-check itself is unaffected (it selects rows by date, not position), but a sheet ` +
        `in this state usually means rows were inserted or re-sorted by hand.`,
      severity: 'warn',
    });
  }

  // ── 3. duplicate payment dates (the OI-096-shaped double-count) ──────────────────────────
  // A date-predicate SUMPRODUCT sums every matching ROW, so two rows sharing a date are both
  // captured. 485 S Walnut's r45/r46 shape (final regular payment and payoff row both dated
  // 2028-09-26, both carrying that month's interest) is the reference case, since fixed at
  // source — but the check must still catch its recurrence anywhere else.
  const byDate = new Map<number, ScheduleRow[]>();
  for (const r of inWindow) {
    const k = r.date.getTime();
    byDate.set(k, [...(byDate.get(k) ?? []), r]);
  }
  for (const [, dupes] of byDate) {
    if (dupes.length < 2) continue;
    // Two rows CAN legitimately share a date: a balloon settles on the same day as the final
    // regular payment (Restoration Church Trust r35/r36). That is not a double-count. The
    // double-count signature is the SAME amount repeated in the SAME column — compared with
    // TOLERANCE, not bit-for-bit equality, since a payoff row is typically computed differently
    // from the amortizing rows above it and can land a cent off an otherwise-identical figure.
    const contributing = dupes.filter((r) => (r.interest ?? 0) !== 0 || (r.principal ?? 0) !== 0);
    if (contributing.length < 2) continue; // annotation rows carry no amounts
    const repeated = (pick: (r: ScheduleRow) => number) => {
      const seen: number[] = [];
      return contributing.some((r) => {
        const v = Math.abs(pick(r) ?? 0);
        if (v === 0) return false;
        if (seen.some((s) => Math.abs(s - v) <= TOLERANCE)) return true;
        seen.push(v);
        return false;
      });
    };
    if (!repeated((r) => r.interest ?? 0) && !repeated((r) => r.principal ?? 0)) continue;
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
  // The one check that can see a balloon parked outside the principal column. Restoration Church
  // Trust's $1,945,102.73 balloon originally sat in PAYMENT AMOUNT, so a principal-column sum
  // missed it and the workbook and a naive recomputation agreed while both understated Oxford's
  // returning capital by $972,551. Only the balance column exposes that shape.
  //
  // Applies uniformly to every loan, lender rows included — this was NOT always the design.
  // Gabriel's first-pass ruling on RCT's exclusion (2026-08-05, ~17:00) held it as intentional:
  // "C = total payment, D/E = the itemized split a balloon legitimately doesn't carry" — a
  // principled borrower/lender asymmetry, with 3540's borrower balloon belonging in debt service
  // and RCT's lender balloon not. That ruling was ITSELF superseded same-day ("Turn 149"): the
  // real root cause was that I14/I15/I16 computed principal on three inconsistent bases, not one
  // deliberate design choice. All three were fixed to a single consistent forward-looking basis,
  // and RCT's balloon is now included (I15 -$978,763.425, confirmed live). The tracker records
  // this explicitly as a detector constraint: "must NOT be built to treat balloon-excluded lender
  // principal as correct." A prior version of this check carried an `isLender` exemption built
  // against the first, superseded ruling — removed; it would have silently exempted a real
  // borrower-side OR lender-side defect from ever being caught, exactly the failure mode this
  // check exists to close.
  if (comparePrincipal) {
    // Opening balance is read from the row IMMEDIATELY BEFORE the window in the full schedule
    // (`rows`, not `inWindow`) — not reconstructed from the first in-window row's own principal.
    // Reconstructing it that way makes the check blind to a defect on exactly that row: understate
    // the first in-window row's principal and the same figure that built `opening` shrinks with
    // it, so `retired` and `summed` move together and the gap stays zero. Reading the true prior
    // period's balance instead means a hidden defect on the window's leading row still surfaces
    // as a mismatch against an independent number.
    // Selected by DATE, never by physical row position. The quantity this check audits is a
    // date-predicate SUMPRODUCT, which is row-order-INSENSITIVE — so two sheets with identical
    // financial content and swapped row positions are indistinguishable to Excel and must be
    // indistinguishable here. The previous positional reads (findIndex, the physical predecessor,
    // and reverse().find for the closing balance) flipped the verdict in BOTH directions on the
    // documented RCT r35/r36 same-date pair: a payoff row placed above its same-dated final regular
    // payment MASKED a real $995K balloon-outside-principal defect, and on a correct workbook the
    // reverse arrangement fired a false $995K accusation. These sheets are hand-maintained and
    // multi-section (gapTolerance exists because of interior banners), so nothing guarantees
    // chronological row order. (2026-08-11 integrity sweep, M3.)
    //
    // Same-date tie-breaks both take the LOWER balance: an amortizing balance is non-increasing in
    // time, so among rows sharing a date the smallest balance is the latest state of that day.
    const laterOf = (a: ScheduleRow, b: ScheduleRow): ScheduleRow => {
      if (a.date > b.date) return a;
      if (a.date < b.date) return b;
      if (a.balance === null) return b;
      if (b.balance === null) return a;
      return a.balance <= b.balance ? a : b;
    };
    let priorRow: ScheduleRow | null = null;
    for (const r of rows) {
      if (r.date > asOf) continue;
      priorRow = priorRow === null ? r : laterOf(priorRow, r);
    }
    let lastWithBalance: ScheduleRow | null = null;
    for (const r of inWindow) {
      if (r.balance === null) continue;
      lastWithBalance = lastWithBalance === null ? r : laterOf(lastWithBalance, r);
    }
    let windowStartRow: ScheduleRow | null = null;
    for (const r of inWindow) {
      if (windowStartRow === null || r.date < windowStartRow.date) windowStartRow = r;
    }

    // A prior-period row that EXISTS but carries no readable balance must not fall through to the
    // origination reconstruction. `?? ` used to do exactly that, contradicting this block's own
    // comment ("only when no prior-period row was scanned at all") and silently re-opening the F-1
    // blindness: rebuilding `opening` from the first in-window row's own principal makes a defect on
    // that row move in lockstep, so the gap stays zero and nothing is reported. Every other
    // unreadable input in this module raises a flag; a verified null beats an inferred one.
    // (2026-08-11 integrity sweep, L1 — found by 2 lenses independently.)
    let opening: number | null;
    if (priorRow !== null && priorRow.balance === null) {
      flags.push({
        entity: id,
        field: 'principalReconciliation',
        issue:
          `the last schedule row before the window (row ${priorRow.row}) carries no readable ` +
          `Remaining Balance, so the opening balance could not be read and the principal ` +
          `reconciliation was NOT run for this loan. Reconstructing it from the first in-window row ` +
          `instead would make the check blind to a defect on exactly that row.`,
        rawValue: String(priorRow.row),
        severity: 'warn',
      });
      opening = null;
    } else if (priorRow !== null) {
      opening = priorRow.balance;
    } else if (windowStartRow !== null && windowStartRow.balance !== null) {
      // No prior-period row at all: the loan originates inside this window, so the first in-window
      // row genuinely IS the origination row and its principal is the full origination amount.
      opening = windowStartRow.balance + Math.abs(windowStartRow.principal ?? 0);
    } else {
      opening = null;
    }
    if (opening !== null && lastWithBalance) {
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

/**
 * The cached value behind a cell, whether it is a literal or a formula result.
 *
 * ExcelJS's public `cell.value` getter builds its formula object with a falsy-check, so it OMITS
 * `result` entirely whenever the cached value is `0` — making "cached 0" indistinguishable from
 * "never calculated". The underlying `cell.model.result` keeps it.
 *
 * This is not hypothetical: ELS `I16` (610 Northampton St. LLC / 485 S Walnut) is an interest-only
 * position with no principal scheduled in the next 12 months, so its cached value is a real `0`
 * (`<v>0</v>` in the sheet XML). Reading the getter alone made the detector report "I16 is a
 * schedule formula but has no cached value — recalculate and save the workbook in Excel", which is
 * both unachievable (no recalc turns a true 0 into a non-zero) and actively harmful: it means the
 * principal side of every zero-principal loan was silently never cross-checked. 2026-08-09.
 */
function cachedValue(ws: Worksheet, col: string, row: number): unknown {
  const cell = ws.getCell(`${col}${row}`);
  const v = cell.value;
  if (v && typeof v === 'object' && 'result' in v) return (v as { result: unknown }).result;
  const model = (cell as unknown as { model?: { result?: unknown } }).model;
  if (model && model.result !== undefined) return model.result;
  return v;
}

function cellNumber(ws: Worksheet, col: string, row: number): number | null {
  const raw = cachedValue(ws, col, row);
  return typeof raw === 'number' && Number.isFinite(raw) ? raw : null;
}

function cellDate(ws: Worksheet, col: string, row: number): Date | null {
  const raw = cachedValue(ws, col, row);
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
  opts: { maxProbe?: number; gapTolerance?: number; minLastRow?: number } = {},
): ScanResult {
  const gapTolerance = opts.gapTolerance ?? 6;
  // Probe past the formula's declared end even when the dated rows stop earlier. Otherwise a
  // blank gap inside a schedule ends the walk short of the declared range, and the truncation
  // check -- which can only fire on an OVER-run -- goes quietly inert.
  const floor = opts.minLastRow ?? 0;
  const requested = Math.max(opts.maxProbe ?? 400, floor - firstRow + gapTolerance + 2);
  // Bound the walk by the sheet's OWN extent. The gap-break can never fire inside the declared
  // range (it requires r > floor), so a declared end of 1048576 -- what Excel produces once a
  // whole-column reference materialises, or a drag-fill "cover everything" edit -- forced ~1M
  // ws.getCell calls, and ExcelJS CREATES row/cell objects for absent cells. That is a CPU/memory
  // blowup inside every parseWorkbook, on both CLI writers and the live server, which parse.ts's
  // try/catch cannot contain (it catches a throw, not an OOM or a multi-minute stall). Capping is
  // safe for detection: the scan then legitimately fails to reach the declared end, and check 2's
  // existing `!scanReachedDeclaredEnd` branch reports exactly that. A degenerate/unknown rowCount
  // (0, or above the first data row) disables the cap rather than scanning nothing.
  // (2026-08-11 integrity sweep, L3.)
  const sheetLastRow = Math.max(0, Number((ws as { rowCount?: number }).rowCount ?? 0));
  const maxProbe =
    sheetLastRow >= firstRow
      ? Math.min(requested, sheetLastRow - firstRow + 1 + gapTolerance + 2)
      : requested;
  if (!cols.date) {
    return { rows: [], stoppedOnGap: false, firstRowBeyondGap: null, reachedDeclaredEnd: false };
  }

  const rows: ScheduleRow[] = [];
  let gap = 0;
  let stoppedOnGap = false;
  let lastProbed = firstRow - 1;
  let stoppedAt = 0;
  for (let r = firstRow; r < firstRow + maxProbe; r++) {
    lastProbed = r;
    const date = cellDate(ws, cols.date, r);
    if (!date) {
      gap += 1;
      // Never stop before the declared range end -- that region is exactly what must be inspected.
      if (gap > gapTolerance && rows.length && r > floor) {
        stoppedOnGap = true;
        stoppedAt = r;
        break;
      }
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

  // Look PAST the gap for a continuation, without adopting it. Detection only: a dated row below the
  // gap means this schedule's true extent is ambiguous, and crossCheckSchedule reports that rather
  // than guessing. Adopting the rows instead could absorb an unrelated dated block further down a
  // hand-maintained sheet and corrupt totals that are correct today, so the choice is deliberately
  // left to a human. Bounded by the same sheet-extent cap as the main walk, so this cannot become
  // the unbounded scan that cap exists to prevent. (2026-08-11 integrity sweep, M2.)
  let firstRowBeyondGap: number | null = null;
  if (stoppedOnGap) {
    for (let r = stoppedAt + 1; r < firstRow + maxProbe; r++) {
      if (cellDate(ws, cols.date, r)) {
        firstRowBeyondGap = r;
        break;
      }
    }
  }
  return { rows, stoppedOnGap, firstRowBeyondGap, reachedDeclaredEnd: lastProbed >= floor };
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
/**
 * The WHOLE-FORMULA Oxford-share multiplier: 0.5 when the formula halves its result, else 1.
 *
 * Until 2026-08-11 this was a single `/\)\s*\*\s*0\.5\s*$/`, which missed `*0.50`, `*.5`, `*50%`,
 * `/2` and a LEADING `0.5*SUMPRODUCT(...)` — all of which Excel treats identically. A miss reads
 * share=1 against a halved cached H/I and produces a permanent ~50%-of-that-loan false divergence
 * on EVERY refresh. That is never a false clean (the error direction always flags), but a standing
 * loud false positive is how the whole warn channel comes to be ignored, which would then bury a
 * real OI-092 recurrence. Anchored to the formula's start/end so a `*0.5` inside an unrelated inner
 * term is not mistaken for a share multiplier.
 */
function parseShare(formula: string): number {
  const t = formula.trim();
  const half = String.raw`0?\.50?|50\s*%`;
  if (new RegExp(String.raw`\*\s*(?:${half})\s*$`).test(t)) return 0.5;
  if (/\/\s*2(?:\.0*)?\s*$/.test(t)) return 0.5;
  if (new RegExp(String.raw`^=?\s*(?:${half})\s*\*`).test(t)) return 0.5;
  return 1;
}

export function parseElsFormula(formula: string | null | undefined): ElsFormulaRef | null {
  if (!formula) return null;
  const m = /'([^']+)'!\$?([A-H])\$?(\d+):\$?[A-H]\$?(\d+)/.exec(formula);
  if (!m) return null;
  const share = parseShare(formula);
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

/**
 * All known `External Loans Summary` loan rows. Two of these (10, 14) are computed
 * arithmetically rather than from a schedule and are legitimately skipped.
 */
const ELS_LOAN_ROWS = [6, 7, 8, 9, 10, 14, 15, 16];

/**
 * The subset of `ELS_LOAN_ROWS` that IS schedule-backed today (excludes 10, the LAST Non note
 * computed as `G10*E10`, and 14, the 1100 Rarig demand note computed as `-ABS(G14*E14)`).
 *
 * This is the coverage FLOOR, and it is deliberately NOT derived by re-parsing the live
 * formulas — a floor computed from the thing it's meant to guard is self-defeating: paste a
 * schedule formula to a literal value (what Paste-Special-Values or an openpyxl round-trip
 * does) and a self-referential floor silently drops with it, so a real loss of coverage reads
 * as a clean run. Fixed against known structure, any of these rows failing to parse is always
 * reported below, regardless of what its formula currently looks like.
 */
const KNOWN_SCHEDULE_BACKED_ROWS = [6, 7, 8, 9, 15, 16];

/** Minimum row band to scan for loans outside `ELS_LOAN_ROWS` — widened to the sheet's own
 *  extent below, this is only the floor for a pathologically small/malformed sheet. */
const ELS_SCAN_ROWS_MIN = 40;
/** Sanity cap — a loan block legitimately living past this would be a workbook redesign. */
const ELS_SCAN_ROWS_MAX = 500;

/** Does this cell hold a summing formula that SHOULD have been parseable as a schedule ref? */
function looksLikeScheduleFormula(formula: string | null): boolean {
  return /\bSUMPRODUCT\s*\(|\bSUMIFS?\s*\(/i.test(formula ?? '');
}

/**
 * Run the cross-check across every `External Loans Summary` loan row backed by an amortization
 * schedule.
 *
 * Rows whose H/I are computed arithmetically rather than from a schedule (H10 = G10*E10, H14 for
 * the 1100 Rarig demand note, I16's synthetic D16-E16) have nothing to cross-check and are skipped
 * silently — safe precisely because they never depended on the summing window that carried the
 * defect. Every OTHER reason for not checking a loan is reported, never skipped.
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

  // The window is anchored on the workbook's own "Loan As-Of Date" (Assumptions!B30), the same cell
  // the H/I formulas anchor on. Deriving it any other way would compare two windows rather than two
  // computations of the same window.
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
  let checked = 0;
  const checkedRows = new Set<number>();

  // Scan a band of rows rather than only the known list, so a loan added below the current block
  // is picked up instead of silently going unchecked. Driven off the sheet's own extent, not a
  // fixed constant — a hardcoded band just relocates the same hole to whatever row sits outside it.
  const scanBand = Math.min(Math.max(els.rowCount, ELS_SCAN_ROWS_MIN), ELS_SCAN_ROWS_MAX);
  const candidates = new Set<number>([
    ...ELS_LOAN_ROWS,
    ...Array.from({ length: scanBand }, (_, i) => i + 1),
  ]);

  for (const r of [...candidates].sort((a, b) => a - b)) {
    const hFormula = formulaOf(els, `H${r}`);
    const interestRef = parseElsFormula(hFormula);
    const rawLabel = cellText(els, 'B', r);
    const label = String(rawLabel ?? `External Loans Summary row ${r}`);
    // A known row only counts against the coverage floor once it's actually populated (column B
    // carries a loan name) — on the live sheet all six always are, so this changes nothing there;
    // it only stops the floor firing on partial fixtures that never claimed to model that row.
    const isKnownAndPopulated = KNOWN_SCHEDULE_BACKED_ROWS.includes(r) && rawLabel !== null;

    if (!interestRef) {
      // A row known to be schedule-backed that no longer parses as one is ALWAYS a coverage
      // hole, regardless of what its formula currently looks like — this is what stops a
      // paste-to-value edit from silently vanishing from the floor it should be measured
      // against. Any other row is flagged only when its shape still looks like an attempted
      // schedule sum (an unquoted sheet name, a whole-column range).
      if (isKnownAndPopulated || looksLikeScheduleFormula(hFormula)) {
        flags.push({
          entity: label,
          field: 'annualDebtService',
          issue: isKnownAndPopulated
            ? `H${r} is expected to be a schedule-summing formula but is not (formula: ` +
              `${(hFormula ?? '(no formula — likely pasted to a literal value)').slice(0, 100)}). ` +
              `This loan was NOT cross-checked.`
            : `H${r} is a summing formula but its schedule reference could not be parsed, so this ` +
              `loan was NOT cross-checked. Unquoted sheet names and whole-column ranges are the ` +
              `usual causes. Reported rather than skipped — an unchecked loan must not read as a ` +
              `clean one.`,
          rawValue: (hFormula ?? '').slice(0, 120),
          severity: 'warn',
        });
      }
      continue;
    }

    const sheet = wb.getWorksheet(interestRef.sheet);
    if (!sheet) {
      flags.push({
        entity: label,
        field: 'annualDebtService',
        issue:
          `schedule sheet "${interestRef.sheet}" referenced by H${r} not found — cross-check did ` +
          `not run for this loan`,
        severity: 'warn',
      });
      continue;
    }

    // The header sits immediately above the formula's first data row on all six schedules.
    const headerRow = interestRef.rangeStart - 1;
    const cols = resolveScheduleColumns(readHeader(sheet, headerRow));
    if (!cols.date || !cols.interest) {
      flags.push({
        entity: label,
        field: 'annualDebtService',
        issue:
          `could not resolve ${!cols.date ? 'a "Payment Date"' : 'an "Interest Paid"'} column from ` +
          `row ${headerRow} of "${interestRef.sheet}" — cross-check did not run for this loan`,
        severity: 'warn',
      });
      continue;
    }

    // Unlike date/interest/principal above, an unresolvable balance column does NOT skip the
    // loan — checks 1-3 (total, share, duplicate-date) don't need it. But without this flag, a
    // renamed/missing "Remaining Balance" header degrades to every row reading balance: null,
    // and crossCheckSchedule's principal-reconciliation check (the ONE check that can see a
    // balloon parked outside the Principal column — the RCT case, and per the ruling below the
    // one every loan is expected to pass) silently no-ops: it cannot distinguish "column absent"
    // from "loan genuinely has no balance data" on its own.
    if (!cols.balance) {
      flags.push({
        entity: label,
        field: 'annualDebtService',
        issue:
          `no "Remaining Balance" header could be resolved from row ${headerRow} of ` +
          `"${interestRef.sheet}" — the principal-reconciliation check (which catches a balloon ` +
          `recorded outside the Principal column) was NOT run for this loan.`,
        severity: 'warn',
      });
    }

    // A missing cached result means "cannot compare", NOT "the workbook says zero". Treating it as
    // 0 would report a spurious six-figure divergence after any openpyxl-mediated workbook edit,
    // which drops every cached value in the file.
    const bookInterest = cellNumber(els, 'H', r);
    if (bookInterest === null) {
      flags.push({
        entity: label,
        field: 'annualDebtService',
        issue:
          `H${r} has no cached value, so there is nothing to cross-check against — recalculate and ` +
          `save the workbook in Excel. (Editing via openpyxl drops every cached formula result.)`,
        severity: 'warn',
      });
      continue;
    }

    const principalRef = parseElsFormula(formulaOf(els, `I${r}`));
    let bookPrincipal: number | null = null;
    if (principalRef) {
      const cached = cellNumber(els, 'I', r);
      if (cached === null) {
        // Distinguish "deliberately synthetic" from "unreadable" — collapsing them would silently
        // degrade to an interest-only check and hide every principal-side defect.
        flags.push({
          entity: label,
          field: 'annualDebtService',
          issue:
            `I${r} is a schedule formula but has no cached value — the principal side of this loan ` +
            `was NOT cross-checked. Recalculate and save the workbook in Excel.`,
          severity: 'warn',
        });
      } else if (!cols.principal) {
        flags.push({
          entity: label,
          field: 'annualDebtService',
          issue:
            `I${r} sums a principal column, but no "Principal Paid"/"Principal Reduction" header ` +
            `could be resolved on "${interestRef.sheet}" — the principal side was NOT cross-checked. ` +
            `A header-label change is the usual cause.`,
          severity: 'warn',
        });
      } else {
        bookPrincipal = cached;
      }
      // H and I are parsed independently but only H's sheet/start/share are actually USED (the scan
      // and the share multiplier both derive from it). When they disagree, the comparison silently
      // mixes bases: a divergent share applies H's multiplier to both sides of the total, and a
      // divergent sheet or start row compares I's cached figure against principal scanned from H's
      // rows. Neither can falsely CLEAR — both directions flag — but the flag text would misattribute
      // the cause, so say it plainly here. (2026-08-11 integrity sweep, M1.)
      const disagreements: string[] = [];
      if (principalRef.sheet !== interestRef.sheet) {
        disagreements.push(`sheet ("${interestRef.sheet}" vs "${principalRef.sheet}")`);
      }
      if (principalRef.rangeStart !== interestRef.rangeStart) {
        disagreements.push(`first data row (${interestRef.rangeStart} vs ${principalRef.rangeStart})`);
      }
      if (principalRef.share !== interestRef.share) {
        disagreements.push(`Oxford share (${interestRef.share} vs ${principalRef.share})`);
      }
      if (disagreements.length > 0) {
        flags.push({
          entity: label,
          field: 'annualDebtService',
          issue:
            `H${r} and I${r} disagree on ${disagreements.join(', ')}. The cross-check derives its ` +
            `scan and share from H alone, so the principal side is being compared on a different ` +
            `basis than it was summed on — treat any divergence reported for this loan as ` +
            `unattributed until the two formulas agree.`,
          severity: 'warn',
        });
      }
    }

    const scan = scanSchedule(sheet, cols, interestRef.rangeStart, {
      minLastRow: interestRef.rangeEnd,
    });

    // Only count a loan as meaningfully checked when the scan actually produced rows to compare
    // — otherwise `checked` could be satisfied by loans crossCheckSchedule immediately bails on
    // (its own "no rows resolved" flag fires below), letting the coverage floor pass on paper
    // while nothing was really verified.
    if (scan.rows.length > 0) {
      checked += 1;
      checkedRows.add(r);
    }
    flags.push(
      ...crossCheckSchedule({
        id: label,
        rows: scan.rows,
        declaredRangeEnd: interestRef.rangeEnd,
        // The I formula's own declared range, so check 2b can test it independently of H's.
        principalRangeEnd: principalRef?.rangeEnd ?? null,
        share: interestRef.share,
        bookInterest,
        bookPrincipal,
        asOf: resolvedAsOf,
        scanReachedDeclaredEnd: scan.reachedDeclaredEnd,
        scanFirstRowBeyondGap: scan.firstRowBeyondGap,
      }),
    );
  }

  // Coverage is asserted against the FIXED expected set, not the live formulas — see
  // KNOWN_SCHEDULE_BACKED_ROWS. "0 flags" must mean "checked and clean", never "checked nothing",
  // and a floor derived from the thing it guards could shrink along with a real coverage loss.
  const populatedKnownRows = KNOWN_SCHEDULE_BACKED_ROWS.filter((r) => cellText(els, 'B', r) !== null);
  const missingKnown = populatedKnownRows.filter((r) => !checkedRows.has(r));
  if (missingKnown.length > 0) {
    flags.push({
      entity: 'meta',
      field: 'annualDebtService',
      issue:
        `only ${checked} of ${populatedKnownRows.length} known schedule-backed loans were ` +
        `cross-checked (missing row(s): ${missingKnown.join(', ')}) — the rest were skipped for the ` +
        `reasons flagged above. A clean run with reduced coverage is not a clean workbook.`,
      severity: 'warn',
    });
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
