// server/workbook/sheets/cash.ts
//
// Master Workbook parser: the Cash Balances sheet. Moved verbatim out of
// server/workbook/parse.ts (2026-11-24 split, no behaviour change); parse.ts re-exports its public names.
import type ExcelJS from 'exceljs';
import { slug, type CashEntity, type CashHistoryPoint, type DataQualityFlag } from '../../../src/contracts/index';
import { cv, isoOrNull, num, row, sheetDataAsOf, str } from './cells';
type Worksheet = ExcelJS.Worksheet;

// ── cash (Cash Balances) ──────────────────────────────────────────────────────
/**
 * A dollar move as a fraction of the balance it is measured against, or null when that balance is
 * missing or <= 0 (no meaningful base -- and the sign would invert). See the deltaPct comment in
 * parseCash for the live incident.
 */
function pctOfBase(dollar: number | null, base: number | null): number | null {
  if (dollar === null || base === null || base <= 0) return null;
  return dollar / base;
}

/**
 * @param fallbackAsOf Provenance fallback when the sheet carries no parseable "As of" dateline
 *   (the resolved workbook dateline, itself falling back to WORKBOOK_AS_OF — OI-023). The Cash
 *   Balances dateline is data-derived (MAX of the Cash Data date row) and can legitimately sit
 *   earlier than the rent roll's TODAY()-cached stamp, so it is read per-sheet, not shared.
 */
export function parseCash(ws: Worksheet, flags: DataQualityFlag[], fallbackAsOf: string) {
  const entities: CashEntity[] = [];
  let totalCash: number | null = null;

  // Locate the entity-summary header ("Entity / LLC").
  let ehdr = -1;
  for (let r = 1; r <= ws.rowCount; r++) {
    if (/entity \/ llc/i.test(String(cv(ws.getRow(r).getCell(1).value) ?? ''))) {
      ehdr = r;
      break;
    }
  }
  if (ehdr > 0) {
    for (let r = ehdr + 1; r <= ws.rowCount; r++) {
      const entity = str(row(ws, r, 1));
      if (!entity) break;
      if (/total portfolio/i.test(entity)) {
        totalCash = num(row(ws, r, 2));
        break;
      }
      const arrow = String(row(ws, r, 13) ?? '');
      const trend = arrow.includes('↑') ? 'up' : arrow.includes('↓') ? 'down' : 'flat';
      const priorBalance = num(row(ws, r, 3));
      const deltaDollar = num(row(ws, r, 4));
      const bal12moAgo = num(row(ws, r, 9));
      const growth12Dollar = num(row(ws, r, 10));
      entities.push({
        entity,
        id: slug(entity),
        currentBalance: num(row(ws, r, 2)) ?? 0,
        priorBalance,
        deltaDollar,
        // Cols 5 and 11 (the workbook's own Δ% and 12-mo Δ% cells) are deliberately NOT read. They
        // divide by the prior / 12-month-ago balance as-is, so when that balance is NEGATIVE (an
        // overdrawn operating account, a start-up entity) the cell's sign inverts against its own
        // dollar figure -- found live 2026-09-14: a negative deltaDollar served beside a positive deltaPct,
        // a positive growth12Dollar beside a large negative growth12Pct, and the UI colours the percent green or
        // red on its own sign. Recomputed here from the dollar move and the balance it is measured
        // against; a denominator <= 0 or missing yields null -- "verified null over a wrong-signed
        // number" -- because a percent of a negative or zero base has no meaning a reader can act on.
        // checkCashInvariants (server/reconcile-runtime.ts) is the backstop over the snapshot itself.
        deltaPct: pctOfBase(deltaDollar, priorBalance),
        avg3: num(row(ws, r, 6)),
        minAllTime: num(row(ws, r, 7)),
        maxAllTime: num(row(ws, r, 8)),
        bal12moAgo,
        growth12Dollar,
        growth12Pct: pctOfBase(growth12Dollar, bal12moAgo),
        pctOfPortfolio: num(row(ws, r, 12)),
        trend,
        flags: [],
      });
    }
  }

  // Historical matrix — first row whose col1 === "Date".
  let mhdr = -1;
  for (let r = 1; r <= ws.rowCount; r++) {
    if (String(cv(ws.getRow(r).getCell(1).value) ?? '').trim() === 'Date') {
      mhdr = r;
      break;
    }
  }
  const cols: { col: number; name: string }[] = [];
  let totalCol = -1;
  if (mhdr > 0) {
    for (let c = 2; c <= 40; c++) {
      const n = str(row(ws, mhdr, c));
      if (!n) break;
      if (/^total/i.test(n)) {
        totalCol = c;
        break;
      }
      cols.push({ col: c, name: n });
    }
  }
  const history: CashHistoryPoint[] = [];
  if (mhdr > 0) {
    for (let r = mhdr + 1; r <= ws.rowCount; r++) {
      const dateIso = isoOrNull(row(ws, r, 1), flags, 'cash-history', `row${r}`);
      if (!dateIso) break;
      const balances: Record<string, number> = {};
      for (const { col, name } of cols) {
        const b = num(row(ws, r, col));
        if (b !== null) balances[name] = b;
      }
      history.push({
        date: dateIso,
        total: totalCol > 0 ? (num(row(ws, r, totalCol)) ?? 0) : 0,
        balances,
      });
    }
  }

  const computedTotal = entities.reduce((s, e) => s + e.currentBalance, 0);
  const total = totalCash ?? computedTotal;
  const sorted = [...entities].sort((a, b) => b.currentBalance - a.currentBalance);
  const largest = sorted[0] ?? null;

  const ownAsOf = sheetDataAsOf(ws);
  if (!ownAsOf) {
    flags.push({
      entity: 'cash',
      field: 'asOf',
      issue: `no parseable "As of" dateline on the Cash Balances sheet — provenance falls back to ${fallbackAsOf}`,
      severity: 'warn',
    });
  }
  // The dateline is documented as data-derived (MAX of the Cash Data date row -- see the
  // @param note above), so it must never sit LATER than the last history row this same function
  // just read. Found live 2026-09-14: the sheet said "As of September 10, 2026" while its history
  // matrix stopped at 2026-07-10 -- the 08-10 and 09-10 rows were never entered, and the July
  // slot carried September's total. That mismatch is exactly what let a September as-of coexist
  // with a July-ending history through every downstream check. Detection only: the as-of stays
  // the sheet's own dateline (the OI-023 provenance rule) and the missing rows are a workbook
  // problem for a human -- nothing here backfills or invents a history point. ISO strings compare
  // lexically as dates.
  const latestHistoryDate = history.reduce<string | null>((max, h) => (max === null || h.date > max ? h.date : max), null);
  if (ownAsOf && latestHistoryDate && ownAsOf > latestHistoryDate) {
    flags.push({
      entity: 'cash',
      field: 'asOf',
      issue: `Cash Balances "As of" ${ownAsOf} is later than the last Cash Data history row ${latestHistoryDate} — the history matrix is missing the rows between (the dateline should be the MAX of the date row, not ahead of it)`,
      rawValue: ownAsOf,
      severity: 'warn',
    });
  }

  return {
    asOf: ownAsOf ?? fallbackAsOf,
    totalCash: total,
    activeEntities: entities.length,
    largestEntity: largest?.entity ?? null,
    concentrationTopPct: largest && total ? largest.currentBalance / total : null,
    cagr: null as number | null,
    entities,
    history,
  };
}
