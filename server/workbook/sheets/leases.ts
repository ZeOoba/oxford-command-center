// server/workbook/sheets/leases.ts
//
// Master Workbook parser: the Master Tenant Rent Roll sheet. Moved verbatim out of
// server/workbook/parse.ts (2026-11-24 split, no behaviour change); parse.ts re-exports its public names.
import type ExcelJS from 'exceljs';
import { differenceInCalendarMonths, parseISO } from 'date-fns';
import { slug, type Property, type Lease, type DataQualityFlag, type LeaseStatus } from '../../../src/contracts/index';
import { classifyLeaseStatus } from '../lease-status';
import { cv, isoOrNull, num, row, str } from './cells';
import { disambiguateLeaseIds } from './ids';
import { resolvePropertyId } from './resolve-property';
type Worksheet = ExcelJS.Worksheet;
type CellValue = ExcelJS.CellValue;

// ── leases (Master Tenant Rent Roll) ──────────────────────────────────────────
/** Banner that opens a trailing DERIVED block on the rent roll — everything at or below it is a
 *  view of leases already parsed above, not tenancy data. See the latch in parseLeases. */
const LEASE_SECTION_TERMINATOR = /vacancy\s*&\s*upcoming availability/i;

/** Legacy per-lease annual-rent column, used only when the sheet has no recognisable header. */
const LEGACY_ANNUAL_RENT_COL = 13;

/** Columns to try, in order, for the rent roll's "Portfolio Total" cell. In the live layout the total
 *  sits in the SAME column as the per-lease Annual Rent. The pre-2026-10 layout had it one column RIGHT
 *  of the per-row annual rent (13 -> 14), so the offset is tried ONLY for that documented position: on
 *  any other layout the adjacent column is some unrelated field (the live sheet's is "Esc. Exception")
 *  and adopting it would put a wrong number in the tie-out. Shared with scripts/reconcile.ts so the gate
 *  and the runtime read the same cells. */
export function rentTotalColumns(annualCol: number | null, abatedCol: number | null = null): number[] {
  if (annualCol === null) return [LEGACY_ANNUAL_RENT_COL + 1];
  // Legacy layout: the verified total position (one column right) FIRST, the annual column only as a
  // fallback, so a stray number in the annual column of the totals row cannot displace the real total.
  // Only when the layout is genuinely legacy: a sheet with an Abated Months header is the CURRENT layout even
  // if its Annual Rent column sits at 13 (a dropped 'Notice to Vacate' column), and there col 14 is unrelated.
  return annualCol === LEGACY_ANNUAL_RENT_COL && abatedCol === null ? [annualCol + 1, annualCol] : [annualCol];
}

/** How a numeric rent-roll cell reads, judged from the RAW ExcelJS value rather than cv(). cv()
 *  collapses a formula with no cached result to null, which is indistinguishable from a blank cell, and
 *  ExcelJS (4.4.0) drops a cached formula result of 0 -- so on the live sheet, where Annual Rent is the
 *  formula F x (12 - R), a fully abated lease (N = 0) arrived as null and silently fell back to
 *  monthly x 12. 'uncached' is a formula with no usable result (a dropped 0, or an uncalculated
 *  workbook); 'unreadable' is an error value, non-numeric text, a date or a boolean. A dash reads as
 *  blank, matching str()'s own convention. (An empty-string formula result is ALSO dropped on read, like
 *  a 0, so from a real file it arrives as 'uncached'; the in-memory '' -> blank rule is kept for
 *  hand-built sheets only.) */
type RentCell =
  | { kind: 'number'; value: number }
  | { kind: 'blank' }
  | { kind: 'uncached' }
  | { kind: 'unreadable'; detail: string };

function classifyRentCell(ws: Worksheet, r: number, c: number): RentCell {
  const raw: unknown = ws.getRow(r).getCell(c).value;
  const fromText = (s: string): RentCell => {
    const t = s.trim();
    if (t === '' || t === '-' || t === '—') return { kind: 'blank' };
    const n = num(t);
    return n === null ? { kind: 'unreadable', detail: t } : { kind: 'number', value: n };
  };
  if (raw === null || raw === undefined) return { kind: 'blank' };
  if (typeof raw === 'number') return Number.isFinite(raw) ? { kind: 'number', value: raw } : { kind: 'unreadable', detail: String(raw) };
  if (typeof raw === 'string') return fromText(raw);
  if (typeof raw === 'object' && !(raw instanceof Date)) {
    const o = raw as { formula?: unknown; sharedFormula?: unknown; result?: unknown; error?: unknown };
    if ('error' in o && o.error !== undefined) return { kind: 'unreadable', detail: String(o.error) };
    if ('formula' in o || 'sharedFormula' in o) {
      const res = o.result;
      if (res === undefined || res === null) return { kind: 'uncached' };
      if (typeof res === 'number') return Number.isFinite(res) ? { kind: 'number', value: res } : { kind: 'unreadable', detail: String(res) };
      if (typeof res === 'string') return fromText(res);
      if (typeof res === 'object' && res !== null && 'error' in res) return { kind: 'unreadable', detail: String((res as { error: unknown }).error) };
      return { kind: 'unreadable', detail: 'formula result of an unexpected type' };
    }
    const n = num(cv(raw as CellValue));
    return n === null ? { kind: 'unreadable', detail: 'non-numeric cell' } : { kind: 'number', value: n };
  }
  return { kind: 'unreadable', detail: raw instanceof Date ? 'date' : typeof raw };
}

/** The columns parseLeases reads by FIXED index, with the header label each should carry. Only the
 *  annual-rent and abated-months columns are header-driven; if a column is inserted or moved ahead of
 *  these, the positional reads silently land on the wrong data (Monthly Rent as 0, Status as Unknown) while
 *  the header-driven Annual Rent still ties to the workbook total. The header row is checked against this
 *  table so that case is VISIBLE. It is a warning, never a refusal: it is matched against normalised labels,
 *  yet a cosmetic header edit must not be able to take down every scheduled refresh. A BLANK header cell in
 *  one of these columns is a mismatch too (an unlabelled column inserted ahead of Status shows up as a blank). */
const POSITIONAL_LEASE_COLUMNS: readonly (readonly [number, string, RegExp])[] = [
  [1, 'Property', /^property$/],
  [2, 'Tenant Name', /^tenant name$/],
  [3, 'Unit', /^unit$/],
  [4, 'Company', /^company$/],
  [5, 'Sq Ft', /^sq ?ft$/],
  [6, 'Monthly Rent', /^monthly rent$/],
  [7, 'Rent / SF', /^rent ?\/ ?sf$/],
  [8, 'Lease Start', /^lease start$/],
  [9, 'Lease End', /^lease end$/],
  [10, 'Escalation Date', /^escalation date$/],
  [11, 'Escalation %', /^escalation ?%$/],
  [12, 'Status', /^status$/],
];

/** Header-label normaliser: collapses whitespace including NBSP and Alt+Enter line breaks, drops periods
 *  ("Sq. Ft." -> "sq ft") and trailing ':' / '#', and lower-cases. */
function normalizeHeaderLabel(raw: string): string {
  return raw.replace(/[\s\u00a0]+/g, ' ').replace(/\./g, '').replace(/[:#]+$/, '').trim().toLowerCase();
}

/** Locate the per-lease annualised-rent column by its header label ("Annual Rent" / "Annualized
 *  Rent"). A label only counts inside the header row -- the first row above the vacancy banner (and, once a
 *  lease row has been seen, above the Portfolio Total) that also holds a "Tenant Name" cell and at least one
 *  other known label. `annualCol` is null when no such header exists; `headerRowFound` distinguishes "a legacy
 *  sheet with no header" (silent, every fixture) from "a real header row that lost its annual-rent label"
 *  (renamed column: flagged).
 *
 *  Why a header and not a fixed column (2026-10-06): the live rent roll gained a "Notice to Vacate"
 *  column at col 13 and its "Annual Rent" column moved to col 14 -- the SAME column as the Portfolio
 *  Total, and net of abated months (monthly x (12 - Abated Months)). The fixed col-13 read landed on
 *  the notice flag, returned null, and silently fell back to monthly x 12, which only surfaced when
 *  one abated month on a $5,300/mo lease opened a $5,300 gap against the workbook's own total and the
 *  extract's reconciliation refused. Header-driven so the next column insert cannot do it again. */
export function findRentRollColumns(ws: Worksheet): {
  annualCol: number | null;
  abatedCol: number | null;
  headerRowFound: boolean;
  /** 1-based row of the header, null when no header row was found. */
  headerRow: number | null;
  /** More than one header cell matched an annual-rent label (e.g. both "Annual Rent" and
   *  "Annualized Rent"); the LEFTMOST is used, so the choice depends on column order. */
  annualAmbiguous: boolean;
  /** Fixed-index columns whose header label disagrees with that index (see POSITIONAL_LEASE_COLUMNS). */
  layoutMismatches: string[];
} {
  // The whole sheet down to the vacancy banner: a title block or notes of any length above the header must
  // not silently revert the read to the legacy column. The roster header always sits ABOVE the roster, so
  // once a lease-shaped row has been seen the scan also stops at the Portfolio Total row (a derived block's
  // own header row below it can then never be mistaken for the roster header); a Portfolio Total row seen
  // BEFORE any lease row (a totals-on-top summary line) is skipped, not treated as the end of the roster.
  const lastRow = ws.rowCount;
  const maxCol = Math.min(Math.max(ws.columnCount, 30), 200);
  let sawLeaseShapedRow = false;
  for (let r = 1; r <= lastRow; r++) {
    const lead = `${str(row(ws, r, 1)) ?? ''} ${str(row(ws, r, 2)) ?? ''}`;
    if (LEASE_SECTION_TERMINATOR.test(lead)) break;
    if (/portfolio total/i.test(lead)) {
      if (sawLeaseShapedRow) break;
      continue;
    }
    let hasTenantNameHeader = false;
    let annualCol: number | null = null;
    let annualMatches = 0;
    let abatedCol: number | null = null;
    // A legend / note row can carry a bare "Tenant Name" cell above the real header, so a candidate row
    // must also carry at least one OTHER known header label to count as the header row.
    let otherKnownLabels = 0;
    for (let c = 1; c <= maxCol; c++) {
      const label = normalizeHeaderLabel(str(row(ws, r, c)) ?? '');
      if (!label) continue;
      if (/^tenant name$/.test(label)) hasTenantNameHeader = true;
      else if (/^annual(?:ized|ised)? rent$/.test(label)) {
        annualMatches++;
        otherKnownLabels++;
        if (annualCol === null) annualCol = c;
      } else if (/^abated months$/.test(label)) {
        otherKnownLabels++;
        if (abatedCol === null) abatedCol = c;
      } else if (/^(property|unit|company|sq ?ft|monthly rent|rent ?\/ ?sf|lease start|lease end|status)$/.test(label)) otherKnownLabels++;
    }
    if (hasTenantNameHeader && otherKnownLabels >= 1) {
      const layoutMismatches: string[] = [];
      for (const [col, name, re] of POSITIONAL_LEASE_COLUMNS) {
        const cell = ws.getRow(r).getCell(col);
        // A merged header cell echoes its master's value into every slave cell: not a real column.
        if (cell.isMerged && cell.master && cell.master.address !== cell.address) {
          // ...unless this column's expected label sits in ANOTHER column of the row: that is a shifted column
          // whose header was merged into its neighbour, not a cosmetic merge.
          let shifted = false;
          for (let c = 1; c <= maxCol && !shifted; c++) shifted = c !== col && re.test(normalizeHeaderLabel(str(row(ws, r, c)) ?? ''));
          if (shifted) layoutMismatches.push(`column ${col} is merged into ${cell.master.address}'s header, expected "${name}" (its label appears in another column)`);
          continue;
        }
        const rawLabel = str(row(ws, r, col)) ?? '';
        if (!re.test(normalizeHeaderLabel(rawLabel))) {
          const shown = rawLabel.replace(/\u00a0/g, '<NBSP>').replace(/\r?\n/g, '<LF>');
          layoutMismatches.push(rawLabel ? `column ${col} is "${shown}", expected "${name}"` : `column ${col} is blank, expected "${name}"`);
        }
      }
      return { annualCol, abatedCol, headerRowFound: true, headerRow: r, annualAmbiguous: annualMatches > 1, layoutMismatches };
    }
    // Lease-shaped = property + tenant text, numeric Monthly Rent and a Status: a KPI/summary line above the
    // header rarely carries all four, so it cannot arm the Portfolio Total break by itself.
    if (str(row(ws, r, 1)) && str(row(ws, r, 2)) && num(row(ws, r, 6)) !== null && str(row(ws, r, 12))) sawLeaseShapedRow = true;
  }
  return { annualCol: null, abatedCol: null, headerRowFound: false, headerRow: null, annualAmbiguous: false, layoutMismatches: [] };
}

interface LeasesParseResult {
  leases: Lease[];
  /** The workbook's own "Portfolio Total" row. Read from the SAME column as the per-lease annual rent
   *  when the header is found (the live layout: col 14, a SUM over the lease rows above it); the legacy
   *  layout (no header) carried per-row annualRent at col 13 and the total one column to the right, at
   *  col 14. Captured during the same pass that skips that row from the per-lease list -- no second
   *  read. Null if no such row is found, or if the row has no numeric total (flagged). */
  workbookRentTotal: number | null;
}

export function parseLeases(
  ws: Worksheet,
  properties: Property[],
  flags: DataQualityFlag[],
  referenceDateIso: string,
): LeasesParseResult {
  const out: Lease[] = [];
  const pendingRowFlags: { lease: Lease; rowFlags: DataQualityFlag[] }[] = [];
  const header = findRentRollColumns(ws);
  const annualRentCol = header.annualCol ?? LEGACY_ANNUAL_RENT_COL;
  const totalCols = rentTotalColumns(header.annualCol, header.abatedCol);
  const totalCol = totalCols[0] as number;
  if (header.headerRowFound && header.annualCol === null) {
    flags.push({
      entity: 'rent-roll',
      field: 'annualRentHeader',
      issue: `the rent roll's header row has no "Annual Rent" / "Annualized Rent" column (renamed or removed?) — per-lease annual rent falls back to legacy column ${LEGACY_ANNUAL_RENT_COL}, then monthly × 12, and the Portfolio Total is read from column ${totalCol}; abated months will not be honoured`,
      severity: 'warn',
    });
  }
  if (header.layoutMismatches.length > 0) {
    // 'warn', deliberately not 'error': this is visibility, not a refusal. An error would refuse every scheduled
    // extract on a cosmetic header edit, and only the CLI writers honour an entity-'rent-roll' error anyway.
    flags.push({
      entity: 'rent-roll',
      field: 'rentRollLayout',
      issue: `the rent roll's header labels do not match the parser's fixed columns (${header.layoutMismatches.join('; ')}) — a column may have been inserted or moved, in which case rent, status, dates or escalations are being read from the wrong columns even though Annual Rent still ties to the total; check the sheet`,
      severity: 'warn',
    });
  }
  if (header.annualAmbiguous) {
    flags.push({
      entity: 'rent-roll',
      field: 'annualRentHeader',
      issue: `more than one "Annual Rent" / "Annualized Rent" header cell on the rent roll's header row — using the leftmost (column ${header.annualCol}); per-lease annual rent and the Portfolio Total follow that column, so reordering columns would change the numbers`,
      severity: 'warn',
    });
  }
  // Not for the pre-2026-10 header layout (Annual Rent at col 13): that sheet never HAD an Abated Months
  // column to lose, so warning on every parse of an archived copy would be pure noise.
  if (header.headerRowFound && header.annualCol !== null && header.abatedCol === null && header.annualCol !== LEGACY_ANNUAL_RENT_COL) {
    // Without the Abated Months column the per-lease check can only compare against monthly × 12, which
    // flags a LEGITIMATE abatement too. That is deliberate: it restores the detection the old behaviour
    // had (annual rent always equalled monthly × 12, so the workbook-total tie-out caught any bad cell)
    // for a sheet whose column was renamed, instead of going silent.
    flags.push({
      entity: 'rent-roll',
      field: 'abatedMonthsHeader',
      issue: `the rent roll's header row has no "Abated Months" column (renamed or removed?) — each lease's Annual Rent can only be checked against monthly rent × 12, so a legitimate abatement will also be flagged until the header is restored`,
      severity: 'warn',
    });
  }
  let workbookRentTotal: number | null = null;
  let foundPortfolioTotalRow = false;
  // A "Portfolio Total" line at/above the header row (totals-on-top): kept as a fallback total.
  let topTotalRentRow: number | null = null;
  let topTotalRent: number | null = null;
  let trailingSectionReached = false;
  // Σ of per-lease Annual Rent residuals (annual − monthly × (12 − abated)) that each stay inside the $1
  // per-lease tolerance. A systematic sub-$1 overstatement (rounded-up cents) is invisible lease by
  // lease; summed, it is reported once when it exceeds the aggregate tolerance.
  let toleratedResidualSum = 0;
  // Lease rows whose Annual Rent formula has no cached result AND derives to a non-zero value.
  let uncachedAnnualCount = 0;
  // Day-count reference = the RUN date, NOT the workbook data date: a June-pinned
  // WORKBOOK_AS_OF froze every monthsToExpiry while the calendar advanced (frozen-dateline
  // defect, 2026-07). WORKBOOK_AS_OF still governs data-month selection (monthCol in
  // parseTasks below) — do not conflate the two. Data-snapshot labels (meta.asOf, cash.asOf,
  // assumptions.asOf) read the workbook's OWN dateline since OI-023 (2026-07-22), with
  // WORKBOOK_AS_OF as the flagged fallback. The caller resolves the exact day-count
  // reference (the brief passes its ET send date; other callers pass the UTC default).
  const asOf = parseISO(referenceDateIso);
  for (let r = 1; r <= ws.rowCount; r++) {
    // A property key is never a date in a valid roster row. str() STRINGIFIES a Date rather than
    // returning null ("Tue Sep 29 2026 20:00:00 GMT-0400 (...)"), so without this a dated row sails
    // through the emptiness guard below and becomes a lease. That is precisely how the trailing
    // vacancy block (see LEASE_SECTION_TERMINATOR) was ingested. Kept as a second, text-independent
    // line of defence: the banner match above stops working the moment the block is retitled.
    // Narrowed to this column deliberately -- str() is shared by every parser in this file and
    // must keep its current behaviour for genuinely date-like text elsewhere.
    const propertyKeyRaw = row(ws, r, 1);
    const propertyKeyIsDate = propertyKeyRaw instanceof Date;
    const propertyKey = propertyKeyIsDate ? null : str(propertyKeyRaw);
    const tenantName = str(row(ws, r, 2));
    if (/portfolio total/i.test(`${propertyKey ?? ''} ${tenantName ?? ''}`)) {
      // First match wins -- see the identical rationale in parseProperties above. A "Portfolio Total" line
      // at or above the header row is a summary/title line, not the roster total (the same rule
      // findRentRollColumns applies): latching it would null the tie-out and hide the real total below.
      const aboveHeader = header.headerRow !== null && r <= header.headerRow;
      if (aboveHeader) {
        // Remembered, never dropped: used only if no total appears below the header (see after the loop).
        if (topTotalRentRow === null) {
          topTotalRentRow = r;
          for (const c of totalCols) {
            topTotalRent = num(row(ws, r, c));
            if (topTotalRent !== null) break;
          }
        }
      } else if (!foundPortfolioTotalRow) {
        foundPortfolioTotalRow = true;
        // Header column first; the one-column-right offset only for the documented pre-2026-10 layout
        // (see rentTotalColumns), never on the live layout where the adjacent column is unrelated.
        for (const c of totalCols) {
          workbookRentTotal = num(row(ws, r, c));
          if (workbookRentTotal !== null) break;
        }
        if (workbookRentTotal === null) {
          // A null total silently disables the Σ-lease-rent vs workbook-total tie-out downstream
          // (checkSnapshot skips a null total), so "the check passed" and "the check never ran" read
          // identically. Say so.
          flags.push({
            entity: 'rent-roll-total',
            field: 'workbookRentTotal',
            issue: `a "Portfolio Total" row exists but column ${totalCol} holds no numeric rent total — the Σ lease rent vs workbook total tie-out is disabled for this snapshot`,
            severity: 'warn',
          });
        }
      }
      continue;
    }
    // The rent roll ends with DERIVED summary blocks -- currently "VACANCY & UPCOMING AVAILABILITY
    // -- VACANT + NOTICE TO VACATE (sorted by Lease End)", added to the live workbook 2026-08. Every
    // row in such a block is a cross-reference formula back into the roster ABOVE it, and its
    // columns sit one to the right of the roster's (col 1 is a Move-Out Date, col 6 is SF where the
    // roster's col 6 is monthlyRent). They are views of leases already parsed, never tenancies of
    // their own. Once a block begins, no later row on the sheet is a lease -- so latch and skip the
    // remainder rather than trying to re-align columns.
    //
    // Deliberately checked AFTER the portfolio-total capture above and via a latch rather than
    // `break`, so a totals row placed BELOW a banner would still be captured. Do not "simplify"
    // this into a break: that would silently couple workbookRentTotal to sheet row ordering.
    if (LEASE_SECTION_TERMINATOR.test(`${propertyKey ?? ''} ${tenantName ?? ''}`)) {
      trailingSectionReached = true;
    }
    if (trailingSectionReached) continue;
    // Past this point a dated property key is UNEXPECTED — the row is not inside any block we
    // recognise, so it is either a derived block that has been retitled/moved (the terminator
    // above no longer matching) or a genuine roster row Excel has coerced to a date. Both need a
    // human. Dropping it is still right, but dropping it SILENTLY is not: "no lease and no flag"
    // reads identically to "there was nothing here", which is precisely how the phantom leases
    // shipped under a "Data-quality flags: 0" banner.
    //
    // Deliberately NOT raised for rows inside a recognised block above: that block is a permanent,
    // legitimate part of the sheet, and ora-cc-snapshot-refresh alerts whenever flags > 0 — so
    // flagging the expected case would mean an alert email 3x/weekday forever. Flag the anomaly,
    // stay silent on the understood. Gated on tenantName so the block's header/total rows, which
    // carry no tenant, never trip it.
    if (propertyKeyIsDate && tenantName) {
      flags.push({
        entity: `rent-roll-row-${r}`,
        field: 'propertyKey',
        issue:
          'row skipped — property key is a date, not a property name (an unrecognised derived block, or a roster row Excel coerced to a date)',
        rawValue: String(propertyKeyRaw),
        severity: 'warn',
      });
    }
    if (!propertyKey || !tenantName) continue;
    if (/tenant roster/i.test(propertyKey)) continue;
    if (normalizeHeaderLabel(tenantName) === 'tenant name') continue; // header
    // Monthly Rent keeps the original literal read. (A round-3 change that read an uncached formula as 0
    // retained rows that were always dropped, and a $0 phantom twin could then take the base id of the
    // real lease and capture its arrears / renewal overlay: reverted.)
    const monthlyRent = num(row(ws, r, 6));
    // Raw status text / tenant name, read early: the derivation below treats an IF-zeroed vacant row as 0,
    // and a vacant placeholder is often identified only by its name when its Status formula reads blank.
    const statusText = (str(row(ws, r, 12)) ?? '').toLowerCase();
    // The name signal applies ONLY when Status is blank (the case it exists for): a real tenant whose name
    // starts with "Vacant" (status Active) must keep its per-lease check and its derived rent.
    const rowIsVacant = statusText.includes('vacant') || (statusText === '' && /^\s*vacant\b/i.test(tenantName ?? ''));
    // Annual Rent: with the header found it is classified from the RAW cell, because on the live sheet it
    // is a FORMULA and cv() collapses a formula with no cached result (ExcelJS drops a cached 0) to null,
    // i.e. to "blank". With no header the legacy literal col-13 read is unchanged.
    const annualCell = header.annualCol !== null ? classifyRentCell(ws, r, annualRentCol) : null;
    let annualRent = annualCell === null ? num(row(ws, r, annualRentCol)) : annualCell.kind === 'number' ? annualCell.value : null;
    // Abated Months for this row: blank, and a formula with no cached result (a dropped 0), both mean 0;
    // text / an error value is unreadable and must not be coerced to 0.
    let abated = 0;
    let abatedUnreadable = false;
    if (header.annualCol !== null && header.abatedCol !== null) {
      const abatedCell = classifyRentCell(ws, r, header.abatedCol);
      if (abatedCell.kind === 'number') abated = abatedCell.value;
      else if (abatedCell.kind === 'unreadable') abatedUnreadable = true;
    }
    if (monthlyRent === null && annualRent === null) {
      // Skipping a row with no usable rent is the long-standing behaviour; but when its Annual Rent cell holds
      // an error / text (not merely blank or an uncached formula), "no lease and no flag" reads like "nothing
      // was there". Name it.
      if (annualCell !== null && annualCell.kind === 'unreadable' && tenantName && (header.headerRow === null || r > header.headerRow)) {
        flags.push({
          entity: `rent-roll-row-${r}`,
          field: 'annualRent',
          issue: `row skipped — Monthly Rent is blank and the Annual Rent cell is not numeric (${annualCell.detail}) for tenant "${tenantName}"`,
          rawValue: String(ws.getRow(r).getCell(annualRentCol).value ?? ''),
          severity: 'warn',
        });
      }
      continue;
    }
    // A formula Annual Rent with no usable cached number (a dropped 0, an error, an uncalculated workbook)
    // is derived from monthly x (12 - abated) instead of silently falling back to monthly x 12: that
    // fallback overstated a fully abated lease by a whole year of rent.
    let annualDerived = false;
    let annualBlankDerived = false;
    if (annualCell !== null && monthlyRent !== null && !abatedUnreadable) {
      if (annualCell.kind === 'uncached' || annualCell.kind === 'unreadable') {
        // A conditional formula (=IF(status="Vacant",0,...)) that really evaluates to 0 is indistinguishable
        // from a dropped cached 0 here, so a vacant row derives 0, never asking rent x 12.
        annualRent = rowIsVacant ? 0 : monthlyRent * (12 - abated);
        annualDerived = true;
      } else if (annualCell.kind === 'blank' && abated > 0) {
        // A deleted/blank Annual Rent on a row that RECORDS an abatement must not silently ignore it.
        annualRent = rowIsVacant ? 0 : monthlyRent * (12 - abated);
        annualDerived = true;
        annualBlankDerived = true;
      }
    }
    const unit = str(row(ws, r, 3));
    // Tenant identity is part of the id, not just the fallback for a missing unit: a suite
    // turnover (same unit, new tenant) must produce a DIFFERENT id, or every overlay entry keyed
    // to the old id (tenantArrears, renewalStages, marketRents) silently re-attaches to the new
    // tenant's lease -- a real defect a mandatory adversarial review round found (financial data
    // silently misattributed to the wrong counterparty on the routine suite-turnover case).
    const tenantSlug = slug(str(row(ws, r, 4)) ?? tenantName);
    const id = unit
      ? `${slug(propertyKey)}-${slug(unit)}-${tenantSlug}`
      : `${slug(propertyKey)}-${tenantSlug}`;
    // Date-quality flags for this row are collected locally, not pushed to `flags` directly:
    // `id` here is pre-disambiguation and may be renamed once disambiguateLeaseIds runs over the
    // full `out` array below, which would otherwise leave a stale `entity` on any flag raised
    // before the rename -- misattributing a data-quality warning to the wrong lease on a collision.
    const rowFlags: DataQualityFlag[] = [];
    const leaseEnd = isoOrNull(row(ws, r, 9), rowFlags, id, 'leaseEnd');
    const rawStatusCell = str(row(ws, r, 12)) ?? '';
    const rawStatus = rawStatusCell.toLowerCase(); // still read below (vacant-row check)
    const classified = classifyLeaseStatus(rawStatusCell);
    const status: LeaseStatus = classified.status;
    if (classified.inactiveSubstring) {
      rowFlags.push({
        entity: id,
        field: 'status',
        issue: 'Status contains "Inactive" but reads as Active (substring match); confirm whether this lease is live',
        rawValue: rawStatusCell,
        severity: 'warn',
      });
    }
    const resolvedPropertyId = resolvePropertyId(propertyKey, properties);
    // A lease that fails to resolve to a property is not dropped -- it still counts toward
    // that property's rent -- but propertyId:null silently zeroes it out of every per-property
    // leasing input (WALT, expiration schedule, Capital Allocation's leasing-risk component)
    // with no signal that anything is missing. "no flag" reads identically to "nothing here",
    // the exact failure class the 2026-08-03 phantom-lease incident and the verified-null-vs-
    // inferred-null rule exist to prevent. checkSnapshot (reconcile-runtime.ts) aggregates this
    // against workbookTotals.rent so a material share of unresolved rent fails the snapshot,
    // not just this one row.
    if (resolvedPropertyId === null) {
      rowFlags.push({
        entity: id,
        field: 'propertyId',
        issue: `lease could not be resolved to a property (propertyKey="${propertyKey}") — its rent ($${(annualRent ?? (rowIsVacant && header.annualCol !== null ? 0 : (monthlyRent ?? 0) * 12)).toLocaleString()}/yr) is excluded from every per-property leasing metric`,
        rawValue: propertyKey,
        severity: 'warn',
      });
    }
    let resolvedAnnualRent = annualRent ?? (rowIsVacant && header.annualCol !== null ? 0 : (monthlyRent ?? 0) * 12);
    let clampedNegative = false;
    if (resolvedAnnualRent < 0) {
      // The sheet's Annual Rent is monthly × (12 − Abated Months), so Abated Months above 12 (a
      // typo) goes negative. The Lease contract requires annualRent ≥ 0, so an unclamped value would
      // abort the whole snapshot parse on one bad cell. Clamp, flag the row, and let the Σ vs
      // workbook-total tie-out refuse the extract until the cell is fixed.
      rowFlags.push({
        entity: id,
        field: 'annualRent',
        issue: `negative Annual Rent (${resolvedAnnualRent}) — usually Abated Months above 12; clamped to 0 so the snapshot still parses, but it will not tie to the workbook total until the cell is fixed`,
        rawValue: String(row(ws, r, annualRentCol) ?? ''),
        severity: 'warn',
      });
      resolvedAnnualRent = 0;
      clampedNegative = true;
    }
    // An Annual Rent cell that is an error value or text: say so by row (never a silent fallback).
    if (annualCell !== null && annualCell.kind === 'unreadable') {
      rowFlags.push({
        entity: id,
        field: 'annualRent',
        issue: `the Annual Rent cell is not numeric (${annualCell.detail}) — ${annualDerived ? `derived from monthly rent × (12 − abated months) = ${(annualRent ?? 0).toLocaleString()}` : 'using monthly rent × 12'}`,
        rawValue: String(ws.getRow(r).getCell(annualRentCol).value ?? ''),
        severity: 'warn',
      });
    }
    if (annualBlankDerived) {
      rowFlags.push({
        entity: id,
        field: 'annualRent',
        issue: `the Annual Rent cell is blank on a row with ${abated} abated month(s) — derived from monthly rent × (12 − abated months) = ${(annualRent ?? 0).toLocaleString()}; restore the cell's formula`,
        rawValue: '',
        severity: 'warn',
      });
    }
    // An uncomputable Annual Rent AND an unreadable Abated Months cell: nothing can be derived, so the lease
    // falls back to monthly x 12. Say so instead of reporting both cells as clean.
    if (annualCell !== null && (annualCell.kind === 'uncached' || annualCell.kind === 'unreadable') && abatedUnreadable && annualCell.kind === 'uncached') {
      rowFlags.push({
        entity: id,
        field: 'annualRent',
        issue: `the Annual Rent formula has no cached result AND the Abated Months cell is not numeric — using monthly rent × 12`,
        rawValue: String(ws.getRow(r).getCell(header.abatedCol as number).value ?? ''),
        severity: 'warn',
      });
    }
    // A formula with no cached result and a NON-zero derived value (a dropped 0 is the benign, expected
    // case and is not counted); reported once after the loop.
    if (annualDerived && annualCell !== null && annualCell.kind === 'uncached' && annualRent !== 0) uncachedAnnualCount++;
    // Abated Months outside 0-12 is named on its row whatever kind the Annual Rent cell is (a derived
    // value would otherwise carry it silently). A clamped negative already explains its own cell.
    let rangeFlagged = false;
    if (header.annualCol !== null && header.abatedCol !== null && !abatedUnreadable && monthlyRent !== null && (abated < 0 || abated > 12) && !clampedNegative) {
      rangeFlagged = true;
      rowFlags.push({
        entity: id,
        field: 'annualRent',
        issue: `Abated Months ${abated} is outside 0–12 — an abatement cannot exceed a year or be negative`,
        rawValue: String(abated),
        severity: 'warn',
      });
    }
    // Per-lease self-consistency, the check the aggregate Σ(monthly×12) vs Σ annual comparison cannot
    // do once abatement exists: with the Annual Rent column identified by header and a LITERAL annual
    // value, each lease's annual rent must equal monthly × (12 − abated), where `abated` comes from the
    // Abated Months column (0 when that column is absent: then any abatement is flagged too, see the
    // abatedMonthsHeader flag). A hard-coded or typo'd Annual Rent cell (in either direction, any size)
    // is otherwise invisible: the workbook's Portfolio Total is a SUM of the same cells and ties to it by
    // construction (the 2026-09-07 zeroed-cells incident passed the total gate for the same reason).
    // 'warn' per the report-don't-refuse rule for plausible events; the Σ vs workbook-total gate still
    // refuses. Skipped for vacant rows (raw status text, since the derived enum routes some vacant
    // suites to Expired/Unknown): they carry an asking rent in Monthly Rent and a zero Annual Rent by
    // design. Also skipped for a $0 Annual Rent on any status that is not Active / Expiring Soon,
    // mirroring the zero-rent warning's own gating: there $0 is an expected vacated/expired suite, not a
    // typo, and warning on it would trip the flags>0 alert on every refresh.
    const isVacantRow = rowIsVacant || rawStatus.includes('vacant') || status === 'Vacant';
    // A LITERAL annual value: the header-found cell's number, or (no header) the legacy col-13 read.
    const literalAnnual: number | null = annualCell === null ? annualRent : annualCell.kind === 'number' ? annualCell.value : null;
    // $0 is expected only on an Expired row. A blank / unrecognised status (MTM, Holdover) at $0 with a
    // monthly rent is NOT expected: the aggregate Σ guard is range-based and cannot see it, so this check
    // must (it used to be skipped for every status other than Active / Expiring Soon).
    const expectedZero = literalAnnual === 0 && status === 'Expired';
    let perLeaseFlagged = rangeFlagged;
    if (literalAnnual !== null && monthlyRent !== null && !isVacantRow && !expectedZero) {
      if (abatedUnreadable) {
        perLeaseFlagged = true;
        rowFlags.push({
          entity: id,
          field: 'annualRent',
          issue: `the Abated Months cell is not numeric (text, or an error value) — Annual Rent ${literalAnnual.toLocaleString()} could not be checked against monthly rent × (12 − abated months)`,
          rawValue: String(ws.getRow(r).getCell(header.abatedCol as number).value ?? ''),
          severity: 'warn',
        });
      } else {
        const expectedAnnual = monthlyRent * (12 - abated);
        const residual = literalAnnual - expectedAnnual;
        if (Math.abs(residual) > 1) {
          perLeaseFlagged = true;
          rowFlags.push({
            entity: id,
            field: 'annualRent',
            issue: `Annual Rent ${literalAnnual.toLocaleString()} ≠ monthly rent × (12 − abated months) = $${monthlyRent.toLocaleString()} × (12 − ${abated}) = ${expectedAnnual.toLocaleString()} — a hard-coded or mistyped Annual Rent cell, or an unrecorded abatement${header.abatedCol === null ? ' (the sheet has no Abated Months column to explain it)' : ''}`,
            rawValue: String(row(ws, r, annualRentCol) ?? ''),
            severity: 'warn',
          });
        } else {
          toleratedResidualSum += residual;
        }
      }
    }
    // A LIVE tenancy at $0 rent needs a human (2026-09-07 refresh, commit 85dfecf, found by the
    // 2026-09-14 financial-code sweep): three retained rows went from real rent to $0 in one
    // scheduled run, and nothing in the pipeline said so -- the count floor saw no add/remove, the
    // drift check compared ids and leaseEnd only, and the Σannual-vs-workbook-total gate PASSED
    // because the workbook itself carried the zeroed cells. Two of the three were 'Expired'
    // (expected to carry stale/zero rent -- a vacated suite), so this is gated to Active and
    // Expiring Soon only: there, $0 is either a real vacancy nobody re-statused or a zeroed cell,
    // and both are worth a line. 'warn', never a refusal or a throw -- a genuine rent zero-out is a
    // legitimate business event, and the reader judges. The aggregate lens on the same shape is
    // scripts/lease-snapshot-drift-check.ts's rentChanged bucket (prior vs current, across
    // snapshots); this row flag is what reaches the live Brain refresh path, which never diffs.
    // A clamped negative already carries its own flag; a second "zero rent" line for the same cell is noise.
    // A fully abated year that the sheet's own Abated Months column records (12 on a numeric cell) is explained;
    // warning on it would alert on every refresh for twelve months. Blank / zero abated months at $0 still warn.
    const fullyAbatedExplained = header.annualCol !== null && header.abatedCol !== null && !abatedUnreadable && abated >= 12;
    if (resolvedAnnualRent === 0 && !clampedNegative && !perLeaseFlagged && !fullyAbatedExplained && (status === 'Active' || status === 'Expiring Soon')) {
      rowFlags.push({
        entity: id,
        field: 'annualRent',
        issue: `zero rent on a retained lease still marked "${status}" (end ${leaseEnd ?? '—'}) — confirm the suite is vacant or on notice; if the tenancy is live, the rent-roll cell was zeroed${monthlyRent !== null && monthlyRent > 0 ? ` (monthly rent is $${monthlyRent.toLocaleString()}, so this is a fully abated year or a zeroed Annual Rent cell)` : ''}`,
        rawValue: String(row(ws, r, annualRentCol) ?? ''),
        severity: 'warn',
      });
    }
    const lease: Lease = {
      id,
      propertyKey,
      propertyId: resolvedPropertyId,
      tenantName,
      unit,
      company: str(row(ws, r, 4)),
      sf: num(row(ws, r, 5)) ?? 0,
      monthlyRent: monthlyRent ?? 0,
      rentPerSf: num(row(ws, r, 7)),
      leaseStart: isoOrNull(row(ws, r, 8), rowFlags, id, 'leaseStart'),
      leaseEnd,
      escalationDate: isoOrNull(row(ws, r, 10), rowFlags, id, 'escalationDate'),
      escalationPct: num(row(ws, r, 11)),
      status,
      annualRent: resolvedAnnualRent,
      monthsToExpiry: leaseEnd ? differenceInCalendarMonths(parseISO(leaseEnd), asOf) : null,
      flags: [],
    };
    out.push(lease);
    pendingRowFlags.push({ lease, rowFlags });
  }
  if (uncachedAnnualCount > 0) {
    flags.push({
      entity: 'rent-roll',
      field: 'annualRent',
      issue: `${uncachedAnnualCount} lease row(s) have an Annual Rent formula with no cached result — either an uncalculated workbook, or a formula whose true value is 0 for a reason other than abatement — each was derived from monthly rent × (12 − abated months); verify against the sheet`,
      severity: 'warn',
    });
  }
  const toleratedCents = Math.round(toleratedResidualSum * 100) / 100;
  if (Math.abs(toleratedCents) > 5) {
    flags.push({
      entity: 'rent-roll',
      field: 'annualRent',
      issue: `per-lease Annual Rent cells each sit within $1 of monthly rent × (12 − abated months), but together they are off by $${toleratedCents.toFixed(2)} — a systematic rounding or hard-coding pattern the per-lease tolerance cannot see`,
      severity: 'warn',
    });
  }
  const finalLeases = disambiguateLeaseIds(out, flags);
  // Now that every lease's id is final, re-home each row's locally-collected flags onto the real
  // `flags` array with the corrected (possibly disambiguated) entity -- see the rowFlags comment
  // above. Correlated by object reference (`lease`), not by id string, so it stays correct even
  // when two leases shared the same pre-dedup base id.
  for (const { lease, rowFlags } of pendingRowFlags) {
    for (const f of rowFlags) flags.push({ ...f, entity: lease.id });
  }
  if (workbookRentTotal === null && topTotalRentRow !== null) {
    if (topTotalRent !== null) {
      // The sheet's only numeric total sits on top (totals-on-top): adopt it so the tie-out still runs.
      workbookRentTotal = topTotalRent;
      for (let i = flags.length - 1; i >= 0; i--) {
        if (flags[i]!.entity === 'rent-roll-total' && flags[i]!.field === 'workbookRentTotal') flags.splice(i, 1);
      }
    } else if (!foundPortfolioTotalRow) {
      flags.push({
        entity: 'rent-roll-total',
        field: 'workbookRentTotal',
        issue: `a "Portfolio Total" row exists above the header (row ${topTotalRentRow}) but holds no numeric rent total — the Σ lease rent vs workbook total tie-out is disabled for this snapshot`,
        severity: 'warn',
      });
    }
  }
  return { leases: finalLeases, workbookRentTotal };
}
