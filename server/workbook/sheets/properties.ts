// server/workbook/sheets/properties.ts
//
// Master Workbook parser: the Property NOI sheet. Moved verbatim out of
// server/workbook/parse.ts (2026-11-24 split, no behaviour change); parse.ts re-exports its public names.
import type ExcelJS from 'exceljs';
import { slug, type Property, type DataQualityFlag } from '../../../src/contracts/index';
import { GOVERNOR_INPUT_BLANK_FIELD, GOVERNOR_INPUT_LABEL, GOVERNOR_LENDER_NO_FIGURES_FIELD, type GovernorInputField } from '../../../src/analytics/governor-inputs';
import { namesAffiliateLender } from '../../../src/analytics/debt-basis';
import { inferMarket, inferType, isoOrNull, num, row, str } from './cells';
import { disambiguatePropertyIds } from './ids';
type Worksheet = ExcelJS.Worksheet;

// ── properties (Property NOI) ─────────────────────────────────────────────────
export interface PropertiesParseResult {
  properties: Property[];
  /** The workbook's own "Portfolio Total" row (NOI col 13 / Value col 10), captured during the
   *  same pass that skips that row from the per-property list -- no second read. Null if the
   *  workbook has no such row, so reconcile-runtime can skip the cross-check rather than false-flag. */
  workbookNoiTotal: number | null;
  workbookValueTotal: number | null;
}

/** Lender-column text that names no lender (a free-and-clear row's placeholder): no info note. */
const NO_LENDER_PLACEHOLDER = /^(?:n\/?a|none|no(?:ne)? lender|free\s*(?:&|and)\s*clear|unencumbered|paid\s*off|-+|—|–)$/i;

export function parseProperties(ws: Worksheet, flags: DataQualityFlag[]): PropertiesParseResult {
  const out: Property[] = [];
  let workbookNoiTotal: number | null = null;
  let workbookValueTotal: number | null = null;
  let foundPortfolioTotalRow = false;
  const pendingBlanks: { prop: Property; blanks: GovernorInputField[] }[] = [];
  const pendingLenderNotes: Property[] = [];
  for (let r = 1; r <= ws.rowCount; r++) {
    const idx = num(row(ws, r, 1));
    const name = str(row(ws, r, 2));
    if (name && /portfolio total/i.test(name)) {
      // First match wins (mirrors scripts/reconcile.ts's find(), which returns on its first hit) --
      // a second matching row (e.g. a footnote/banner row) is ignored rather than silently
      // overwriting an already-captured total.
      if (!foundPortfolioTotalRow) {
        foundPortfolioTotalRow = true;
        workbookNoiTotal = num(row(ws, r, 13));
        workbookValueTotal = num(row(ws, r, 10));
      }
      continue;
    }
    if (idx === null || !name) continue;
    const id = slug(name);
    // Governor inputs (audit 2026-11-12 HIGH #2). A blank cell still coerces to 0 below so every
    // non-governor surface keeps its number, but on a LEVERED row the blank is recorded and flagged
    // after id disambiguation, and the governor surfaces fail closed on it (src/analytics/governor-inputs).
    const noiCell = num(row(ws, r, 13));
    const debtServiceCell = num(row(ws, r, 15));
    const loanCell = num(row(ws, r, 20));
    const lender = str(row(ws, r, 19));
    const dscrCell = num(row(ws, r, 18));
    const ltvCell = num(row(ws, r, 21));
    // Levered evidence is NUMERIC only: a non-zero DSCR or LTV cell, or a non-zero debt figure. A
    // ratio cell reading 0 is formula output over blank debt (the same rule dscrOut/ltvOut apply
    // below). Lender text alone is NOT evidence: free-text notes ('Unlevered', 'No debt', 'Paid-off')
    // used to mark a free-and-clear row levered and blank both portfolio governors (refute
    // wf_6550093a-baa, wf_406ad3ef-7de). A lender named with no figure at all gets an info note below.
    const levered = (dscrCell ?? 0) !== 0 || (ltvCell ?? 0) !== 0 || (debtServiceCell ?? 0) !== 0 || (loanCell ?? 0) !== 0;
    const pos = (v: number | null): boolean => v !== null && v > 0;
    // A typed 0 that the row's own figures contradict is as unknown as a blank: a $0 balance beside a
    // positive LTV, debt service or DSCR; $0 debt service beside a positive DSCR or a positive
    // third-party balance (an affiliate note may legitimately accrue with no payment). Refute
    // wf_fe0c7b48-326, wf_406ad3ef-7de.
    const loanUnknown = loanCell === null || (loanCell === 0 && (pos(ltvCell) || pos(debtServiceCell) || pos(dscrCell)));
    const dsUnknown =
      debtServiceCell === null || (debtServiceCell === 0 && (pos(dscrCell) || (pos(loanCell) && !namesAffiliateLender(lender))));
    // NOI blankness is independent of leverage: cap rate, leasing risk and Σ NOI read it on a
    // free-and-clear row too (refute wf_2f05948b-aae). The debt inputs are gated on `levered`.
    const blanks: GovernorInputField[] = (
      [['noi', noiCell === null], ['debtService', levered && dsUnknown], ['loanBalance', levered && loanUnknown]] as const
    )
      .filter(([, unknown]) => unknown)
      .map(([k]) => k);
    const lenderWithoutFigures =
      !levered && lender !== null && !NO_LENDER_PLACEHOLDER.test(lender.trim()) && debtServiceCell === null && loanCell === null;
    // A ratio cell reading exactly 0 beside a blank input is the workbook formula evaluating over
    // that blank (NOI/DS with NOI blank; loan/value with loan blank), not a measurement. Left in, a
    // blank NOI fired a critical 0.00x DSCR alert on Base (refute wf_fe0c7b48-326). A non-zero cell
    // is kept: it is evidence (a typed figure), and the per-property alerts read it.
    const dscrOut = dscrCell === 0 && (blanks.includes('noi') || blanks.includes('debtService')) ? null : dscrCell;
    const ltvOut = ltvCell === 0 && blanks.includes('loanBalance') ? null : ltvCell;
    // Same rule for the NOI-derived ratios: a 0 cap rate / cash-on-cash over a blank NOI is formula
    // output, not a measurement (refute wf_2f05948b-aae: surfaces showed "NOI blank" beside "Cap 0.0%").
    const capRateCell = num(row(ws, r, 17));
    const cashOnCashCell = num(row(ws, r, 25));
    const capRateOut = capRateCell === 0 && blanks.includes('noi') ? null : capRateCell;
    // Cash-on-cash is computed over debt service as well: with Debt Service unknown the workbook figure
    // counts $0 debt service and overstates the return, whatever it reads (refute wf_c93c6154-6b8).
    const cashOnCashOut = blanks.includes('debtService') || (cashOnCashCell === 0 && blanks.includes('noi')) ? null : cashOnCashCell;
    const loanBalance = loanCell ?? 0;
    const occ = num(row(ws, r, 6)) ?? 0;
    if (occ > 1.0001)
      flags.push({ entity: id, field: 'occPct', issue: `occupancy > 100% (${occ})`, severity: 'warn' });
    out.push({
      id,
      index: Math.round(idx),
      name,
      address: name,
      city: null,
      state: null,
      market: inferMarket(name),
      type: inferType(str(row(ws, r, 3))),
      sf: num(row(ws, r, 4)) ?? 0,
      tenantCount: Math.round(num(row(ws, r, 5)) ?? 0),
      occPct: Math.min(occ, 1),
      acqDate: isoOrNull(row(ws, r, 7), flags, id, 'acqDate'),
      estValue100: num(row(ws, r, 8)) ?? 0,
      oxfordOwnPct: num(row(ws, r, 9)) ?? 1,
      oxfordValue: num(row(ws, r, 10)) ?? 0,
      grossIncome: num(row(ws, r, 11)) ?? 0,
      expenses: num(row(ws, r, 12)) ?? 0,
      noi: noiCell ?? 0,
      noiScenarioAdj: num(row(ws, r, 14)) ?? noiCell ?? 0,
      debtService: debtServiceCell ?? 0,
      netCashFlow: num(row(ws, r, 16)) ?? 0,
      capRate: capRateOut,
      dscr: dscrOut,
      lender,
      loanBalance,
      ltv: ltvOut,
      valuePerSf: num(row(ws, r, 22)),
      rentPerSf: num(row(ws, r, 23)),
      equityInvested: num(row(ws, r, 24)) ?? 0,
      cashOnCash: cashOnCashOut,
      holdYrs: num(row(ws, r, 26)),
      // A levered row with a blank balance is encumbered by an UNKNOWN amount, not free and clear.
      encumbered: loanBalance > 0 || blanks.includes('loanBalance'),
      flags: [],
    });
    if (blanks.length > 0) pendingBlanks.push({ prop: out[out.length - 1]!, blanks });
    if (lenderWithoutFigures) pendingLenderNotes.push(out[out.length - 1]!);
  }
  // Guarantee distinct property ids before leases/counterparties resolve against them.
  const properties = disambiguatePropertyIds(out, flags);
  // Flag after disambiguation so each flag's entity is the final id (and the residence exclusion's
  // dropFlagsFor can find it by that id).
  for (const { prop, blanks } of pendingBlanks) {
    for (const field of blanks) {
      const flag: DataQualityFlag = {
        entity: prop.id,
        field: GOVERNOR_INPUT_BLANK_FIELD,
        issue:
          field === 'noi'
            ? // No bound direction (a blank NOI may be negative) and no unconditional scoring claim (refute wf_da5abccb-d31).
              'blank NOI: portfolio NOI excludes this row (incomplete; the true NOI may be negative, so no bound is claimed), a 0 cap-rate or cash-on-cash cell derived from it is withheld, and capital allocation withholds NOI/SF and the implied cap until the workbook cell is filled'
            : `blank ${GOVERNOR_INPUT_LABEL[field]} on a row carrying debt figures, or a 0 that the row's own figures contradict: the DSCR/LTV governor figures that need it are shown as incomplete until the workbook cell is filled`,
        rawValue: field,
        severity: 'warn',
      };
      prop.flags.push(flag);
      flags.push(flag);
    }
  }
  for (const prop of pendingLenderNotes) {
    const flag: DataQualityFlag = {
      entity: prop.id,
      field: GOVERNOR_LENDER_NO_FIGURES_FIELD,
      issue: 'the Lender column names a lender but Debt Service, Loan Balance, DSCR and LTV are all blank: treated as free and clear for the DSCR/LTV governors; fill the debt figures if the property carries a loan, or clear the lender cell',
      severity: 'info',
    };
    prop.flags.push(flag);
    flags.push(flag);
  }
  return { properties, workbookNoiTotal, workbookValueTotal };
}
