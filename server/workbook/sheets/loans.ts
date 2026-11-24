// server/workbook/sheets/loans.ts
//
// Master Workbook parser: the Loan Index sheet. Moved verbatim out of
// server/workbook/parse.ts (2026-11-24 split, no behaviour change); parse.ts re-exports its public names.
import type ExcelJS from 'exceljs';
import { slug, type Loan, type DataQualityFlag } from '../../../src/contracts/index';
import { cv, isoOrNull, num, row, str } from './cells';
type Worksheet = ExcelJS.Worksheet;

/**
 * Rows Gabriel has retired in place rather than deleted, so the workbook keeps its own
 * audit trail — e.g. Loan Index r24, `⚠ DUPLICATE OF ROW 22 — DO NOT USE` (2026-08-05).
 *
 * These must not become Loan records: `debt_positions` is keyed `ON CONFLICT(id,
 * snapshot_date)`, so a tombstone would claim a warehouse key on every snapshot and
 * inflate the loan count. Matching is deliberately narrow — the bare word "duplicate" is
 * not a marker, only `DUPLICATE OF <something>` — so a real counterparty name can't be
 * swallowed. OI-093 residual.
 */
export function isTombstonedLoanRow(name: string): boolean {
  // `DUPLICATE OF` is ANCHORED to the start of the cell (after any ⚠ / whitespace / dash), because
  // the marker REPLACES the loan name rather than annotating it. Matching it anywhere, as this did
  // until 2026-08-11, swallowed any live row whose name merely carried the phrase -- e.g. "Fifth
  // Third (consolidated -- duplicate of prior facility retired)". That direction matters: a skipped
  // row's balance leaves aggregate debt, so portfolio LTV reads LOWER than reality and the
  // Hard-Invariant-4 40% ceiling is evaluated against an understated numerator -- the falsely
  // CLEARING direction. (2026-08-11 integrity sweep, L2.)
  //
  // `DO NOT USE` deliberately still matches anywhere, case-insensitively: the workbook uses it as a
  // trailing annotation too ("Old note -- DO NOT USE"), which the tests pin.
  // The marker must be the LEADING CLAUSE, optionally preceded by punctuation/emoji and one of the
  // retirement words a human actually types. Requiring literally no leading word (the first pass's
  // `^\W*`) traded the false positive for a SILENT false negative: "RETIRED — DUPLICATE OF row 9",
  // "(VOID) DUPLICATE OF #7" and "2019 DUPLICATE OF consolidated note" were all caught by the
  // original unanchored regex and all missed by the anchored one. A missed tombstone is ingested as a
  // live loan, so its stale balance double-counts the duplicated facility in aggregate debt and it
  // claims a debt_positions key -- and that direction emits NO flag at all, because the warn below
  // only fires on a match. Caught by the refute pass on this branch.
  const leadIn = String.raw`(?:\W|RETIRED|VOID|OLD|DEFUNCT|SUPERSEDED|CLOSED|\d+)*`;
  return (
    /DO\s+NOT\s+USE/i.test(name) ||
    new RegExp(String.raw`^${leadIn}\s*DUPLICATE\s+OF\s+\S`, 'i').test(name)
  );
}

// ── loans (Loan Index — section-aware) ────────────────────────────────────────
export function parseLoans(ws: Worksheet, flags: DataQualityFlag[]): Loan[] {
  const out: Loan[] = [];
  let section: Loan['direction'] | null = null;
  for (let r = 1; r <= ws.rowCount; r++) {
    const c1 = String(cv(ws.getRow(r).getCell(1).value) ?? '');
    const c2 = str(row(ws, r, 2));
    const banner = `${c1} ${c2 ?? ''}`.toUpperCase();
    if (/WE PAY|IS BORROWER/.test(banner)) { section = 'borrower'; continue; }
    if (/WE RECEIVE|IS LENDER/.test(banner)) { section = 'lender'; continue; }
    if (/INTERNAL LOAN JOURNAL/.test(banner)) { section = 'internal'; continue; }
    if (/PORTFOLIO SNAPSHOT|BALLOON ALERT|HOW TO USE/.test(banner)) { section = null; continue; }
    if (!section) continue;
    const idx = num(row(ws, r, 1));
    const rawName = c2;
    if (idx === null || !rawName) continue;
    const name = rawName.replace(/\s*→\s*$/, '').trim();
    if (isTombstonedLoanRow(name)) {
      // Skipped, but never silently — an invisible skip is indistinguishable from a
      // parser that stopped seeing the row at all.
      flags.push({
        entity: 'loans',
        field: 'name',
        issue: `Loan Index row ${r} is tombstoned in the workbook and was skipped, so it cannot claim a snapshot id or warehouse key`,
        rawValue: name,
        // 'warn', not 'info': skipping a row removes its balance from aggregate debt, which moves a
        // GOVERNOR input (portfolio LTV) in the falsely-clearing direction. An info flag no gate
        // reads is too quiet for that. (2026-08-11 integrity sweep, L2.)
        severity: 'warn',
      });
      continue;
    }
    const id = slug(`${section}-${name}`);
    const balance = num(row(ws, r, 4)) ?? 0;
    const maturityStr = section === 'internal' ? null : str(row(ws, r, 7));
    const isDemand = (maturityStr ?? '').toLowerCase() === 'demand' || section === 'internal';
    const status = section === 'internal' ? str(row(ws, r, 8)) : str(row(ws, r, 10));
    out.push({
      id,
      name,
      counterparty: str(row(ws, r, 3)),
      direction: section,
      originalPrincipal: null,
      currentBalance: balance,
      absBalance: Math.abs(balance),
      rate: num(row(ws, r, 5)),
      monthlyPmt: num(row(ws, r, 6)),
      annualInterest: null,
      annualPrincipal: null,
      loanType: status,
      status,
      isDemand,
      maturity: isDemand ? null : isoOrNull(row(ws, r, 7), flags, id, 'maturity'),
      monthsToMaturity: section === 'internal' ? null : num(row(ws, r, 8)),
      ltv: num(row(ws, r, 9)),
      lender: section === 'borrower' ? str(row(ws, r, 3)) : null,
      balloon: /balloon/i.test(`${name} ${status ?? ''}`),
      flags: [],
      // Col 11 = Property display name (Gabriel adds this column); borrower only.
      // null for lender/internal rows — never misattributed.
      collateralProperty: section === 'borrower' ? (str(row(ws, r, 11)) ?? null) : null,
    });
  }
  return out;
}
