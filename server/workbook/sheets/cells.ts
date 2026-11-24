// server/workbook/sheets/cells.ts
//
// Master Workbook parser: cell readers, market/type inference and the sheet dateline. Moved verbatim out of
// server/workbook/parse.ts (2026-11-24 split, no behaviour change); parse.ts re-exports its public names.
import type ExcelJS from 'exceljs';
import type { DataQualityFlag, Market, PropertyType } from '../../../src/contracts/index';
type Worksheet = ExcelJS.Worksheet;
type CellValue = ExcelJS.CellValue;

// ── cell helpers ────────────────────────────────────────────────────────────
export function cv(v: CellValue | undefined): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') {
    if (v instanceof Date) return v;
    if ('result' in v) return (v as { result?: unknown }).result ?? null;
    if ('richText' in v)
      return (v as { richText: { text: string }[] }).richText.map((t) => t.text).join('');
    if ('text' in v) return (v as { text: unknown }).text;
    return null;
  }
  return v;
}
export function num(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v.replace(/[$,%\s]/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
export function str(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' || s === '—' || s === '-' ? null : s;
}
export function isoOrNull(
  v: unknown,
  flags: DataQualityFlag[],
  entity: string,
  field: string,
): string | null {
  let d: Date | null = null;
  if (v instanceof Date) {
    if (!Number.isNaN(v.getTime())) d = v;
  } else if (typeof v === 'string') {
    const p = new Date(v);
    if (!Number.isNaN(p.getTime())) d = p;
  }
  if (!d) return null;
  const y = d.getUTCFullYear();
  if (y < 1990 || y > 2100) {
    flags.push({
      entity,
      field,
      issue: `implausible date (${y})`,
      rawValue: String(v),
      severity: 'warn',
    });
    return null;
  }
  return d.toISOString().slice(0, 10);
}
/** Insurance deductible / coverage-limit pair. deductible > limit (transposed cells, or a sublimit
 *  typed in the limit column) is the shape the dec-page importer rejects: the loss engine's
 *  retained/transferred/overLimit split only partitions gross when d ≤ limit. Null BOTH and flag it
 *  LOUDLY rather than let it reach the warehouse — never guess which cell is wrong. */
export function decPairOrFlag(
  deductible: number | null,
  coverageLimit: number | null,
  flags: DataQualityFlag[],
  entity: string,
): { deductible: number | null; coverageLimit: number | null } {
  if (deductible !== null && coverageLimit !== null && deductible > coverageLimit) {
    flags.push({
      entity,
      field: 'deductible',
      issue: `deductible exceeds coverage limit (${deductible} > ${coverageLimit}) — both ignored for this capture; correct the source cells`,
      rawValue: `${deductible} / ${coverageLimit}`,
      severity: 'warn',
    });
    return { deductible: null, coverageLimit: null };
  }
  return { deductible, coverageLimit };
}

export function row(ws: Worksheet, r: number, c: number): unknown {
  return cv(ws.getRow(r).getCell(c).value);
}

export function inferMarket(text: string): Market {
  const t = text.toLowerCase();
  if (/raytown|kansas city|\bmo\b|missouri/.test(t)) return 'Kansas City MO';
  if (/toledo|secor|mcgregor/.test(t)) return 'Toledo OH';
  if (/twinsburg|cleveland/.test(t)) return 'Cleveland MSA';
  if (/indianapolis|richardt/.test(t)) return 'Indianapolis IN';
  if (
    /columbus|dublin|westerville|livingston|rarig|banwick|morrison|zettler|fishel|5th ave|fifth ave|state route 350|\boh\b|ohio/.test(
      t,
    )
  )
    return 'Columbus OH';
  if (
    /owings mills|columbia|baltimore|easton|salisbury|cambridge|potomac|broadway|owings|\bmd\b|maryland/.test(
      t,
    )
  )
    return 'Mid-Atlantic';
  return 'Other';
}
export function inferType(raw: string | null): PropertyType {
  const t = (raw ?? '').toLowerCase();
  if (t.includes('flex')) return 'Flex';
  if (t.includes('retail')) return 'Retail';
  if (t.includes('indust')) return 'Industrial';
  if (t.includes('residen')) return 'Residence';
  return 'Other';
}

// ── workbook dateline (provenance "As of") ──────────────────────────────────
const MONTH_INDEX: Record<string, number> = {
  january: 1, february: 2, march: 3, april: 4, may: 5, june: 6,
  july: 7, august: 8, september: 9, october: 10, november: 11, december: 12,
};

/**
 * Extract an ISO date from a sheet dateline like
 * "As of July 17, 2026   │   137 tenants   │   513,000 SF leased" (rent roll / assumptions,
 * TEXT(TODAY(),...) cached at last save) or "As of July 10, 2026" (Cash Balances,
 * data-derived MAX of the Cash Data date row). Deterministic string parse — deliberately no
 * `new Date(text)` round-trip, whose local-timezone midnight can shift the ISO day (OI-023).
 */
export function datelineToIso(text: string): string | null {
  const m = /as of\s+([a-z]+)\.?\s+(\d{1,2}),?\s+(\d{4})/i.exec(text);
  if (!m) return null;
  const token = m[1]!.toLowerCase();
  const month =
    MONTH_INDEX[token] ??
    (token.length >= 3
      ? Object.entries(MONTH_INDEX).find(([name]) => name.startsWith(token))?.[1] ?? null
      : null);
  if (!month) return null;
  const day = Number(m[2]);
  const year = Number(m[3]);
  if (day < 1 || day > 31 || year < 1990 || year > 2100) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Scan the top of a sheet (column A) for its own "As of …" dateline. The real workbook stores
 * these as formulas; ExcelJS surfaces the CACHED result from the last save, which cv() unwraps.
 * Returns null when no parseable dateline exists (e.g. programmatic fixtures with no cached
 * formula results) — callers fall back LOUDLY via a DataQualityFlag, never silently (OI-023).
 */
export function sheetDataAsOf(ws: Worksheet, maxRows = 6): string | null {
  const last = Math.min(maxRows, ws.rowCount);
  for (let r = 1; r <= last; r++) {
    const text = str(row(ws, r, 1));
    if (!text) continue;
    const iso = datelineToIso(text);
    if (iso) return iso;
  }
  return null;
}
