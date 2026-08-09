/**
 * Annual-debt-service recomputation cross-check (OI-092 detector, REBUILD).
 *
 * The first detector (preserved at docs/superpowers/plans/withdrawn-detector-oi092/) counted
 * payment rows inside a re-derived window. That shape was withdrawn before shipping: it
 * computes its own correct window and tests the schedule DATA against it, so it can never
 * observe the workbook FORMULA that carried the OI-092 bug — reverting the window to
 * `TODAY()+366` left it reporting all-clean while annual debt service re-inflated by one
 * payment. It also false-fired on two schedule rows sharing one date (OI-096) because it
 * counted rows, not distinct dates. Do not rebuild that shape.
 *
 * This module does the opposite: it independently RECOMPUTES each external loan's
 * next-12-month interest and principal from the loan's FULL amortization schedule (an
 * open-ended scan — no lastRow to go stale) and cross-checks the workbook's own
 * `External Loans Summary` H (annual interest), I (annual principal) and J (annual debt
 * service) figures against that recomputation. Two independent computations compared:
 *   - a wrong window in the workbook formula (OI-092)   → dollar mismatch
 *   - a truncated SUMPRODUCT range (OI-094)             → dollar mismatch
 *   - a lender basis that drops a due balloon (OI-095)  → dollar mismatch
 *   - a wrong column mapping (even when J still sums)   → per-component mismatch
 *   - duplicate schedule dates (OI-096)                 → no mismatch, correctly quiet
 *
 * Design rulings baked in (memory: reference_workbook_annual_debt_service_366day_overcapture,
 * open-items-tracker OI-092/094/095/096):
 *   - Window = (asOf, EOMONTH(asOf, 12)] anchored on `Assumptions` "Loan As-Of Date" — the
 *     ratified month-end pair fix. EOMONTH (not EDATE) is the right edge: EDATE under-captures
 *     a month-end payer across a Feb-28→leap-Feb boundary.
 *   - Oxford-share multipliers (e.g. the ×0.5 on 9050 Red Branch / RCT) are read from the
 *     workbook's own H/I formula text at runtime — never from a hardcoded loan list.
 *   - Lender rows sign their figures negative via `-ABS(...)` (capital deployed), but the
 *     sign is not internally consistent across rows, so ALL comparisons are on magnitudes —
 *     the same convention as src/analytics/conditions.ts annualDebtService().
 *   - Lender principal is balloon-INCLUSIVE (OI-095 final ruling, 2026-08-05, superseding the
 *     same-day "intentional exclusion" reading): a lender row whose forward principal excludes
 *     a contractually-due balloon inside the window is WRONG and must flag.
 *   - Severity is WARN (Gabriel, 2026-08-05) — a finding surfaces through the normal
 *     DataQualityFlag stream and never blocks a refresh. The only non-warn emission is the
 *     info-severity "unmapped loan" notice.
 *   - The ">2 decimal places" tell-tale is explicitly NOT a detector — it fires on 6 of 11
 *     loans, all correct (synthetic annual÷12 figures, Oxford-share halving).
 *
 * `parseLoans()` (parse.ts) reads only the `Loan Index` sheet, so everything here is new
 * sheet access: `External Loans Summary`, `Assumptions`, and the per-loan schedule sheets.
 *
 * SCOPE LIMITATIONS — a clean run means less than it looks like it means:
 *
 * (A) This detector validates SUMMARY-vs-SCHEDULE consistency: the workbook's own cached
 *     H/I/J against the amortization schedule the workbook itself points to. It does NOT
 *     validate SCHEDULE-vs-CONTRACT correctness. A defect where the schedule and the summary
 *     agree with each other but both are wrong relative to the actual loan terms — the
 *     historical OI-095 shape, where RCT's balloon sat in a column neither the formula nor a
 *     naive reader summed — is invisible here. A clean run says "the summary faithfully
 *     reflects the schedule," never "the schedule is right."
 *
 * (B) The Oxford-share multiplier is READ from the workbook's own formula text and applied
 *     as-is — this detector never judges whether that multiplier is itself correct. A
 *     wrongly-added or wrongly-dropped ×0.5 on a loan is followed silently, by design:
 *     reading the factor from the formula (rather than hardcoding a loan list) is what keeps
 *     the detector maintenance-free across workbook edits, and the price is that multiplier
 *     correctness is out of scope.
 */

import type ExcelJS from 'exceljs';
import { slug, type DataQualityFlag } from '../../src/contracts/index';

type Worksheet = ExcelJS.Worksheet;

/** Dollar tolerance for the cross-check. The recomputation reads the same underlying cells
 *  the workbook sums, so a genuine defect is at least one payment (hundreds of dollars);
 *  anything under a dollar is float noise / cached-value rounding. */
const TOLERANCE_USD = 1.0;

/** Plausible schedule-date years — a date-formatted stray number (e.g. Banwick's NOI block)
 *  decodes to an implausible year and must never be swept in as a payment. */
const MIN_YEAR = 1990;
const MAX_YEAR = 2100;

// ── pure helpers ────────────────────────────────────────────────────────────────────────

/** Excel EOMONTH: the last day of the month `months` whole months after `d` (UTC). */
export function eomonthMonths(d: Date, months: number): Date {
  // Date.UTC day 0 of month m+1 = last day of month m; UTC keeps ExcelJS dates stable.
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + months + 1, 0));
}

/**
 * Unwrap an ExcelJS cell value to a finite number, or null when the cell is not numeric.
 *
 * A formula cell whose cached `result` is ABSENT resolves to 0, not null: Excel omits cached
 * zero results from the file, and ExcelJS surfaces them as `undefined` (verified live on
 * `External Loans Summary` I14/I16, both genuinely 0). Treating that as "unreadable" would
 * skip real zero figures; treating it as 0 is exact for any workbook Excel has saved.
 */
export function readNumericCell(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[$,%\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === 'object') {
    if ('formula' in v || 'sharedFormula' in v) {
      const r = (v as { result?: unknown }).result;
      if (r === null || r === undefined) return 0; // cached zero omitted from the file
      return readNumericCell(r);
    }
  }
  return null;
}

/** The formula text of a cell value, when it carries one. Shared-formula follower cells do
 *  not carry the full text — they resolve to null and the multiplier defaults to 1 (the live
 *  H/I cells are all standalone formulas; verified 2026-08-05). */
function cellFormulaText(v: unknown): string | null {
  if (v && typeof v === 'object' && 'formula' in v) {
    const f = (v as { formula?: unknown }).formula;
    return typeof f === 'string' ? f : null;
  }
  return null;
}

/**
 * Extract a trailing `*<factor>` from a summary formula — the workbook's own Oxford-share
 * multiplier (e.g. `SUMPRODUCT(...)*0.5`, `-ABS(SUMPRODUCT(...))*0.5`). Returns 1 when the
 * formula carries no trailing factor or no formula text is available. Reading the factor
 * from the formula (not a per-loan constant) means a loan gaining or losing a share
 * multiplier in the workbook is followed automatically.
 */
export function extractTrailingMultiplier(formulaText: string | null): number {
  if (!formulaText) return 1;
  const m = /\)\s*\*\s*(\d+(?:\.\d+)?)\s*$/.exec(formulaText.trim());
  if (!m) return 1;
  const factor = parseFloat(m[1]!);
  return Number.isFinite(factor) && factor > 0 ? factor : 1;
}

/** Normalize an `External Loans Summary` display name to its mapping key: lowercase,
 *  alphanumerics only — "485 S. Walnut St." and "485 S Walnut St" resolve identically. */
export function normalizeLoanName(name: string): string {
  return name.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
}

// ── per-loan schedule layout (structural knowledge, verified against the live workbook) ──

/** Where an amount lives on a schedule row: a single column, or a difference of two
 *  (485 S Walnut carries no principal column — principal = Payment − Interest). */
export interface AmountSpec {
  col: number;
  minusCol?: number;
}

export interface ScheduleSource {
  sheet: string;
  /** Column holding the payment date. */
  dateCol: number;
  /** First payment row. Header blocks above it can carry REAL dates in the date column
   *  (Banwick B7 "First Payment Date", RCT B6 "Origination Date"), so the scan must not
   *  start at row 1. There is deliberately NO lastRow: the scan runs to the sheet's end so a
   *  truncated workbook range (OI-094) cannot also truncate the recomputation. Trailing
   *  non-payment rows (TOTALS, NOI-derivation blocks) carry no plausible Date in the date
   *  column and fall out of the scan naturally. */
  firstRow: number;
  interest: AmountSpec;
  principal: AmountSpec;
}

/**
 * Keyed by normalizeLoanName() of the `External Loans Summary` display name. Column
 * semantics differ per sheet — each entry was verified cell-by-cell against the live
 * workbook 2026-08-05 (they mirror what the ELS H/I formulas sum, independently re-read):
 *
 *   3540:    B=date, D=Payment,  E=Interest, F=Principal      (H sums E, I sums F)
 *   9050:    B=date, C=Interest, D=Principal, E=P&I           (H sums C, I sums D; ×0.5)
 *   29000:   A=date, B=Payment,  C=Principal, D=Interest      (H sums D, I sums C)
 *   Banwick: B=date, C=Payment,  D=Interest,  E=Principal     (H sums D, I sums E)
 *   RCT:     B=date, C=Payment,  D=Interest,  E=Principal     (H sums D, I sums E; ×0.5;
 *            r37 memo row carries Oxford's half-share in col C ONLY — D/E empty, so a D/E
 *            sum can never double-count it)
 *   Walnut:  B=date, D=Payment,  E=Interest;  principal = D−E (H sums E, I sums D−E)
 *
 * A new loan sheet must be added here (and to the ELS) to be checked; until then its ELS
 * row raises an info flag rather than being silently unverified.
 */
export const SCHEDULE_RECOMPUTE_SOURCES: Readonly<Record<string, ScheduleSource>> = {
  '3540efifthave': {
    sheet: '3540 E Fifth Ave', dateCol: 2, firstRow: 9,
    interest: { col: 5 }, principal: { col: 6 },
  },
  '9050redbranchroad': {
    sheet: '9050 Red Branch Road', dateCol: 2, firstRow: 11,
    interest: { col: 3 }, principal: { col: 4 },
  },
  '29000informationlane': {
    sheet: '29000 Information Lane', dateCol: 1, firstRow: 9,
    interest: { col: 4 }, principal: { col: 3 },
  },
  banwickmorrison: {
    sheet: 'Banwick-Morrison', dateCol: 2, firstRow: 11,
    interest: { col: 4 }, principal: { col: 5 },
  },
  restorationchurchtrust: {
    sheet: 'Restoration Church Trust', dateCol: 2, firstRow: 11,
    interest: { col: 4 }, principal: { col: 5 },
  },
  '485swalnutst': {
    sheet: '485 S Walnut St', dateCol: 2, firstRow: 10,
    interest: { col: 5 }, principal: { col: 4, minusCol: 5 },
  },
};

/** Loans with no amortization schedule BY DESIGN — checked nowhere, flagged never:
 *  "3883 from Oxford" (no schedule at all; H = rate × balance is synthetic) and
 *  "1100 Rarig (Fenton)" (demand note; nothing contractually scheduled, I ruled 0). */
export const NO_SCHEDULE_LOANS: ReadonlySet<string> = new Set([
  '3883fromoxford',
  '1100rarigfenton',
]);

// ── sheet readers ───────────────────────────────────────────────────────────────────────

/** Unwrap a cell value to a plausible schedule Date (direct or cached formula result). */
function cellDate(v: unknown): Date | null {
  const raw =
    v instanceof Date
      ? v
      : v && typeof v === 'object' && ('formula' in v || 'sharedFormula' in v)
        ? (v as { result?: unknown }).result
        : null;
  if (!(raw instanceof Date) || Number.isNaN(raw.getTime())) return null;
  const y = raw.getUTCFullYear();
  return y >= MIN_YEAR && y <= MAX_YEAR ? raw : null;
}

function amountAt(ws: Worksheet, r: number, spec: AmountSpec): number {
  const base = readNumericCell(ws.getRow(r).getCell(spec.col).value) ?? 0;
  if (spec.minusCol === undefined) return base;
  return base - (readNumericCell(ws.getRow(r).getCell(spec.minusCol).value) ?? 0);
}

/**
 * Recompute the forward-window interest/principal sums from the FULL schedule.
 * Duplicate dates are legitimate (485 S Walnut rows 45/46 share the payoff date) — this is
 * a dollar sum over rows, never a payment count, so they simply contribute their amounts.
 */
export function recomputeWindowSums(
  ws: Worksheet,
  src: ScheduleSource,
  asOf: Date,
): { interest: number; principal: number } {
  const end = eomonthMonths(asOf, 12);
  let interest = 0;
  let principal = 0;
  for (let r = src.firstRow; r <= ws.rowCount; r++) {
    const dt = cellDate(ws.getRow(r).getCell(src.dateCol).value);
    if (!dt || dt <= asOf || dt > end) continue;
    interest += amountAt(ws, r, src.interest);
    principal += amountAt(ws, r, src.principal);
  }
  return { interest, principal };
}

/** `Assumptions` "Loan As-Of Date" — label in col A, value (or cached formula Date) in
 *  col B. Label-scanned, not pinned to B30, so the block can move without breaking this. */
export function readLoanAsOf(ws: Worksheet): Date | null {
  for (let r = 1; r <= ws.rowCount; r++) {
    const label = ws.getRow(r).getCell(1).value;
    if (typeof label === 'string' && /loan as-of date/i.test(label)) {
      const dt = cellDate(ws.getRow(r).getCell(2).value);
      if (dt) return dt;
    }
  }
  return null;
}

// ── the check ───────────────────────────────────────────────────────────────────────────

const ELS_SHEET = 'External Loans Summary';
const ASSUMPTIONS_SHEET = 'Assumptions';
/** ELS columns (header row 4 of the live sheet): A name, C role, H/I/J figures. */
const COL_NAME = 1;
const COL_ROLE = 3;
const COL_H = 8;
const COL_I = 9;
const COL_J = 10;

const fmt = (n: number): string =>
  n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Cross-check every `External Loans Summary` loan row against a schedule recomputation and
 * append DataQualityFlags. Warn-severity findings only (plus the info-severity unmapped-loan
 * notice) — this check must never block a refresh (Gabriel, 2026-08-05).
 *
 * Silence policy (REFUTE fix, 2026-08-09): silence is legitimate ONLY when there is nothing
 * to check — no `External Loans Summary` sheet at all (fixture workbooks, pre-restructure
 * snapshots). When the summary IS present but the Assumptions "Loan As-Of Date" anchor is
 * missing or unreadable, the check emits one info-severity flag saying it is DISABLED rather
 * than returning silently: a single label rename in the workbook would otherwise switch this
 * detector off permanently with zero signal, and a disabled detector must never be
 * indistinguishable from a clean run (verified-null vs inferred-null standing rule). At the
 * LOAN level silence is likewise not allowed: a mapped loan with a missing schedule sheet
 * warns, and an unmapped loan announces itself — the withdrawn design's silent carve-out is
 * exactly how a truncated/stale schedule went unnoticed.
 */
export function checkAnnualDebtService(
  getSheet: (name: string) => Worksheet | undefined,
  flags: DataQualityFlag[],
): void {
  const els = getSheet(ELS_SHEET);
  if (!els) return; // nothing to check — the only legitimately-silent case
  const assumptions = getSheet(ASSUMPTIONS_SHEET);
  const asOf = assumptions ? readLoanAsOf(assumptions) : null;
  if (!asOf) {
    flags.push({
      entity: 'loans',
      field: 'annualDebtService',
      issue:
        `annual-debt-service cross-check DISABLED: "${ELS_SHEET}" is present but the ` +
        `Assumptions "Loan As-Of Date" anchor was not found, so no loan could be verified. ` +
        `A disabled detector is not a clean run — restore the Assumptions month-end close ` +
        `block (label "Loan As-Of Date", value beside it) to re-enable.`,
      severity: 'info',
    });
    return;
  }
  const end = eomonthMonths(asOf, 12);
  const windowLabel = `(${asOf.toISOString().slice(0, 10)}, ${end.toISOString().slice(0, 10)}]`;

  for (let r = 1; r <= els.rowCount; r++) {
    const row = els.getRow(r);
    const roleRaw = row.getCell(COL_ROLE).value;
    const role = typeof roleRaw === 'string' ? roleRaw.trim().toLowerCase() : '';
    if (role !== 'borrower' && role !== 'lender') continue; // banners, headers, totals
    const nameRaw = row.getCell(COL_NAME).value;
    const name = typeof nameRaw === 'string' ? nameRaw.trim() : '';
    if (!name) continue;

    const key = normalizeLoanName(name);
    if (NO_SCHEDULE_LOANS.has(key)) continue; // no schedule by design — not checkable
    const entity = slug(`${role}-${name}`);

    const src = SCHEDULE_RECOMPUTE_SOURCES[key];
    if (!src) {
      flags.push({
        entity,
        field: 'annualDebtService',
        issue:
          `External Loans Summary row ${r} ("${name}") has no schedule mapping — its annual ` +
          `debt service is not independently verified. Add the loan's amortization sheet to ` +
          `SCHEDULE_RECOMPUTE_SOURCES (server/workbook/debt-service-recompute.ts).`,
        rawValue: name,
        severity: 'info',
      });
      continue;
    }

    const ws = getSheet(src.sheet);
    if (!ws) {
      flags.push({
        entity,
        field: 'annualDebtService',
        issue:
          `amortization sheet "${src.sheet}" not found — cannot recompute annual debt service ` +
          `for "${name}". The workbook was likely restructured; update SCHEDULE_RECOMPUTE_SOURCES.`,
        rawValue: src.sheet,
        severity: 'warn',
      });
      continue;
    }

    const hCell = row.getCell(COL_H).value;
    const iCell = row.getCell(COL_I).value;
    const jCell = row.getCell(COL_J).value;
    const wbH = readNumericCell(hCell);
    const wbI = readNumericCell(iCell);
    const wbJ = readNumericCell(jCell);
    if (wbH === null && wbI === null && wbJ === null) {
      flags.push({
        entity,
        field: 'annualDebtService',
        issue:
          `External Loans Summary row ${r} ("${name}") carries no readable H/I/J figures — ` +
          `annual debt service cannot be cross-checked.`,
        rawValue: name,
        severity: 'warn',
      });
      continue;
    }

    // Oxford-share multipliers, read from the workbook's own formulas (never hardcoded).
    const sums = recomputeWindowSums(ws, src, asOf);
    const expInterest = Math.abs(sums.interest * extractTrailingMultiplier(cellFormulaText(hCell)));
    const expPrincipal = Math.abs(sums.principal * extractTrailingMultiplier(cellFormulaText(iCell)));
    const expTotal = expInterest + expPrincipal;

    // Magnitude comparisons only — lender rows sign via -ABS(...) and the sign convention is
    // not consistent across rows (conditions.ts precedent).
    const deltas: string[] = [];
    if (wbH !== null && Math.abs(Math.abs(wbH) - expInterest) > TOLERANCE_USD) {
      deltas.push(`interest H=$${fmt(Math.abs(wbH))} vs recomputed $${fmt(expInterest)}`);
    }
    if (wbI !== null && Math.abs(Math.abs(wbI) - expPrincipal) > TOLERANCE_USD) {
      deltas.push(`principal I=$${fmt(Math.abs(wbI))} vs recomputed $${fmt(expPrincipal)}`);
    }
    if (wbJ !== null && Math.abs(Math.abs(wbJ) - expTotal) > TOLERANCE_USD) {
      deltas.push(`total J=$${fmt(Math.abs(wbJ))} vs recomputed $${fmt(expTotal)}`);
    }
    if (deltas.length === 0) continue;

    flags.push({
      entity,
      field: 'annualDebtService',
      issue:
        `"${name}": workbook next-12-month figures disagree with an independent full-schedule ` +
        `recomputation over ${windowLabel} — ${deltas.join('; ')}. Annual debt service (and ` +
        `therefore DSCR) may be mis-stated; check the External Loans Summary window/range/column ` +
        `formulas against the "${src.sheet}" schedule.`,
      rawValue: wbJ !== null ? String(wbJ) : String(wbH ?? wbI),
      severity: 'warn',
    });
  }
}
