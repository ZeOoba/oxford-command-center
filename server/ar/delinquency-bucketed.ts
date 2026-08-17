// server/ar/delinquency-bucketed.ts
//
// Format B parser: the two-bucket "Delinquency" export (2203-2207 Northwood, SVN/RentManager) named
// as an unsupported shape in ar-aging.ts's module doc.
//
// This export carries NO TENANT NAME — identity is unit-only, under a property group header. It
// therefore emits BucketedUnitRow, NOT ArAgingRow: putting an empty string in ArAgingRow.tenant would
// let a nameless row enter match-tenant.ts, score zero against every lease, and route to review
// forever while looking like it parsed fine. Resolution to a Lease.id is resolve-by-unit.ts's job.
//
// Merged-cell artifact (same hazard class as delinquency-transactional.ts's Format C fix, verified
// against the real 2203-2207 Northwood file, 2026-08-16): a property-group-header row merges its
// text across ALL columns in the header block, including Amount Receivable — so ExcelJS's per-cell
// `.value` echoes the SAME banner string into that column too, not null/empty as a naive reader would
// assume. "Is Amount Receivable populated" is therefore NOT a valid header-vs-unit discriminator.
// The correct signal: a banner row has Unit === Amount Receivable (both the identical merged string);
// a genuine unit row's Amount Receivable is always numeric and can never equal its own short unit
// label. Applying the same value-equality idiom rent-manager-delinquency.ts and
// delinquency-transactional.ts already use for their own merged-banner hazards.
//
// Buckets: the export gives '0-30' and '30+' only. d30plus is left unsplit rather than guessed into
// d60/d90/d90plus — the report does not say, and inventing an age would feed a wrong number to the
// collections alert.

import type ExcelJS from 'exceljs';

export interface BucketedUnitRow {
  /** Unit/suite label exactly as printed (e.g. '4A', '11-12A', 'C 1-2'). */
  unit: string;
  /** Property group header this unit appeared under, verbatim (may carry source typos, e.g.
   *  'Nothwood' for 'Northwood' — never corrected here; correction belongs in the alias ledger). */
  property: string | null;
  /** 1-30 days past due. */
  d30: number;
  /** 30+ days past due, age not further resolvable from this export. */
  d30plus: number;
}

const COL = { unit: 1, receivable: 2, d30: 9, d30plus: 10 } as const;

// Matches rent-manager-delinquency.ts's cellString/server/workbook/parse.ts's convention: ExcelJS
// returns rich-text cells (the header/banner rows here — 'Exported On:', 'Properties:', the group
// headers) as a { richText: [...] } object, not a plain string. A naive String(v) on that object
// yields "[object Object]", which is why a first pass of this detector failed against the real file.
function text(ws: ExcelJS.Worksheet, row: number, col: number): string {
  const v = ws.getRow(row).getCell(col).value;
  if (v === null || v === undefined) return '';
  if (typeof v === 'object' && 'richText' in v) return v.richText.map((t) => t.text).join('').trim();
  return String(v).trim();
}

function num(v: ExcelJS.CellValue): number {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (typeof v === 'string') {
    const p = Number.parseFloat(v.replace(/[$,\s]/g, ''));
    return Number.isFinite(p) ? p : 0;
  }
  return 0;
}

/** True only for the two-bucket 'Delinquency' export. Row 1 must match EXACTLY — Format A's title
 *  ('Delinquency (Detail)') shares the prefix, so a startsWith check would steal its files. */
export function detectDelinquencyBucketed(ws: ExcelJS.Worksheet): boolean {
  if (text(ws, 1, 1).toLowerCase() !== 'delinquency') return false;
  return text(ws, 2, 1).toLowerCase().startsWith('exported on:');
}

function headerRow(ws: ExcelJS.Worksheet): number {
  for (let r = 1; r <= Math.min(ws.rowCount, 30); r++) {
    if (text(ws, r, COL.unit).toLowerCase() === 'unit') return r;
  }
  return -1;
}

export function parseDelinquencyBucketed(ws: ExcelJS.Worksheet): BucketedUnitRow[] {
  const hdr = headerRow(ws);
  if (hdr === -1) return [];

  const out: BucketedUnitRow[] = [];
  let property: string | null = null;

  for (let r = hdr + 1; r <= ws.rowCount; r++) {
    const label = text(ws, r, COL.unit);
    if (label === '') continue; // per-property subtotal row: blank Unit
    if (label.toLowerCase() === 'total') continue; // grand total row

    const receivableText = text(ws, r, COL.receivable);
    if (receivableText === label) {
      // Merged property-group banner: Unit and Amount Receivable echo the same string.
      property = label;
      continue;
    }

    out.push({
      unit: label,
      property,
      d30: Math.max(0, num(ws.getRow(r).getCell(COL.d30).value)),
      d30plus: Math.max(0, num(ws.getRow(r).getCell(COL.d30plus).value)),
    });
  }
  return out;
}
