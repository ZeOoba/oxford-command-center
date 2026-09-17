// server/warehouse/lease-market/costar-parse.ts
//
// Lease Market Intelligence — CoStar Suite lease-listing export parser (spec §3.1).
// The ONLY component that depends on real CoStar column labels, and it gets them exclusively from
// config/lease-market.costar-headers.json. Human-run exports only: nothing here touches CoStar itself.
import ExcelJS from 'exceljs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import { z } from 'zod';
import {
  BuildingStatus, CanonicalListingRow, LmSubtype, RentBasis,
  type BuildingStatus as BuildingStatusT, type RentBasis as RentBasisT,
} from '../../../src/contracts/lease-market';
import { parseRentText } from '../../../src/analytics/lease-market/normalize';

const Col = z.string().min(1).nullable();

export const CostarHeaderMap = z.object({
  status: z.enum(['pending-sample', 'verified']),
  note: z.string().optional(),
  sheetName: z.string().nullable(),
  headerRow: z.number().int().positive(),
  rentPeriodDefault: z.enum(['yr', 'mo']).nullable(),
  fields: z.object({
    costarPropertyId: Col, address: Col, suite: Col, city: Col, state: Col, market: Col, submarket: Col,
    propertyType: Col, secondaryType: Col, buildingStatus: Col, buildingSf: Col, yearBuilt: Col, clearHeightFt: Col,
    docks: Col, driveIns: Col, officePct: Col, ownerName: Col, availableSf: Col, minDivisibleSf: Col, rentLow: Col,
    rentHigh: Col, rentText: Col, rentBasis: Col, spaceType: Col, dateOnMarket: Col,
    zip: Col, lat: Col, lon: Col, brokerName: Col, brokerCompany: Col, listingUrl: Col, description: Col,
  }),
  subtypeMap: z.record(z.string(), LmSubtype), // key "PropertyType|SecondaryType" or "PropertyType|*"
  buildingStatusMap: z.record(z.string(), BuildingStatus),
  rentBasisMap: z.record(z.string(), RentBasis),
  subleaseValues: z.array(z.string()),
});
export type CostarHeaderMap = z.infer<typeof CostarHeaderMap>;
export type HeaderField = keyof CostarHeaderMap['fields'];

export class CostarParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CostarParseError';
  }
}

export interface SkippedRow { rowNumber: number; reason: string }
export interface ParsedCostarExport {
  headerFingerprint: string;
  marketNames: string[];
  rows: CanonicalListingRow[];
  skipped: SkippedRow[];
  rowCount: number;
}

export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    const v = value as { richText?: Array<{ text: string }>; text?: unknown; result?: unknown };
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('').trim();
    if (typeof v.text === 'string') return v.text.trim();
    if ('result' in v) return cellText(v.result);
    return '';
  }
  return String(value).trim();
}

// Strips a leading "$", thousands commas, and a trailing unit word (sf/ft/feet), then accepts ONLY a
// plain signed decimal — anything left over (a range "2,000 - 5,000", a parenthesized "(5)", stray
// text) is rejected as null rather than silently coerced by Number()'s permissive parsing.
const UNIT_SUFFIX_RE = /\s*(?:sf|ft|feet)\s*$/i;
const NUMBER_RE = /^-?(?:\d+\.?\d*|\.\d+)$/;

export function parseNumber(text: string): number | null {
  const cleaned = text.replace(/\$/g, '').replace(/,/g, '').trim().replace(UNIT_SUFFIX_RE, '').trim();
  if (!NUMBER_RE.test(cleaned)) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function parseIsoDate(text: string): string | null {
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

// A coordinate of 0 is treated as missing — CoStar uses it as an "unknown" sentinel rather than a
// real Gulf-of-Guinea reading — reject it along with anything outside the valid range for the axis
// (lat: ±90, lon: ±180).
export function parseCoordinate(text: string, limit: number): number | null {
  const n = parseNumber(text);
  return n === null || Math.abs(n) > limit || n === 0 ? null : n;
}

// Feet-inches notation ("24'0\"", "24' 6\"", "24'") or a plain number/unit string ("24 ft", "24").
const FEET_INCHES_RE = /^(\d+(?:\.\d+)?)\s*'\s*(?:(\d+(?:\.\d+)?)\s*")?\s*$/;

export function parseClearHeight(text: string): number | null {
  const t = text.trim();
  if (!t) return null;
  const m = FEET_INCHES_RE.exec(t);
  if (m) {
    const feet = Number(m[1]!);
    const inches = m[2] !== undefined ? Number(m[2]) : 0;
    return Number.isFinite(feet) && Number.isFinite(inches) ? feet + inches / 12 : null;
  }
  return parseNumber(t);
}

// A "%"-suffixed value is already stated in percentage points ("1%" => 1, not 100). Otherwise, a bare
// fraction in (0, 1] is assumed to be a fraction of whole (=> ×100); any other bare number is already
// in percentage points.
export function parsePercent(text: string): number | null {
  const t = text.trim();
  if (t.endsWith('%')) return parseNumber(t.slice(0, -1));
  const n = parseNumber(t);
  return n === null ? null : n > 0 && n <= 1 ? n * 100 : n;
}

// ExcelJS represents a hyperlinked cell as { text, hyperlink }. Returns the URL, or null when the cell
// isn't a hyperlink (callers fall back to cellText for a plain-text URL column).
export function cellHyperlink(value: unknown): string | null {
  if (value !== null && typeof value === 'object' && 'hyperlink' in value) {
    const h = (value as { hyperlink?: unknown }).hyperlink;
    return typeof h === 'string' && h !== '' ? h : null;
  }
  return null;
}

function lookupCI<T>(record: Record<string, T>, key: string): T | undefined {
  const k = Object.keys(record).find((x) => x.toLowerCase() === key.toLowerCase());
  return k === undefined ? undefined : record[k];
}

function toInt(text: string): number | null {
  const n = parseNumber(text);
  return n === null ? null : Math.round(n);
}

function nullIfEmpty(s: string): string | null {
  return s === '' ? null : s;
}

export async function parseCostarListingsFile(filePath: string, map: CostarHeaderMap): Promise<ParsedCostarExport> {
  if (map.status !== 'verified') {
    throw new CostarParseError(
      'config/lease-market.costar-headers.json is still "pending-sample": fill every column from a real CoStar export header row and set status "verified" before ingesting.',
    );
  }
  for (const f of ['address', 'propertyType', 'availableSf'] as const) {
    if (!map.fields[f]) throw new CostarParseError(`header map field "${f}" is required`);
  }
  if (!map.fields.rentText && !map.fields.rentLow) throw new CostarParseError('header map needs fields.rentText or fields.rentLow');

  const wb = new ExcelJS.Workbook();
  const ext = extname(filePath).toLowerCase();
  let sheet: ExcelJS.Worksheet | undefined;
  if (ext === '.xlsx') {
    await wb.xlsx.readFile(filePath);
    sheet = map.sheetName ? wb.getWorksheet(map.sheetName) : wb.worksheets[0];
  } else if (ext === '.csv') {
    sheet = await wb.csv.readFile(filePath);
  } else {
    throw new CostarParseError(`unsupported export extension "${ext}" (expected .xlsx or .csv)`);
  }
  if (!sheet) throw new CostarParseError(`worksheet "${map.sheetName ?? '#1'}" not found`);

  const colIndex = new Map<string, number>();
  const labelCounts = new Map<string, number>();
  const headerRow = sheet.getRow(map.headerRow);
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const label = cellText(cell.value);
    if (!label) return;
    labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    if (!colIndex.has(label)) colIndex.set(label, colNumber);
  });
  const headerFingerprint = createHash('sha256').update([...colIndex.keys()].sort().join('\n')).digest('hex');

  const idx = {} as Record<HeaderField, number | null>;
  for (const [field, column] of Object.entries(map.fields) as Array<[HeaderField, string | null]>) {
    if (column === null) {
      idx[field] = null;
      continue;
    }
    if ((labelCounts.get(column) ?? 0) > 1) {
      throw new CostarParseError(`export has a duplicate header column "${column}" (mapped to ${field}) — CoStar export headers must be unique`);
    }
    const i = colIndex.get(column);
    if (i === undefined) throw new CostarParseError(`export is missing column "${column}" (mapped to ${field})`);
    idx[field] = i;
  }

  const subleaseSet = new Set(map.subleaseValues.map((s) => s.toLowerCase()));
  const rows: CanonicalListingRow[] = [];
  const skipped: SkippedRow[] = [];
  const marketNames = new Set<string>();

  for (let r = map.headerRow + 1; r <= sheet.rowCount; r++) {
    const row = sheet.getRow(r);
    const get = (f: HeaderField): string => {
      const i = idx[f];
      return i === null ? '' : cellText(row.getCell(i).value);
    };
    const address = get('address');
    if (!address) continue;

    const pt = get('propertyType');
    const st = get('secondaryType');
    const subtype = lookupCI(map.subtypeMap, `${pt}|${st}`) ?? lookupCI(map.subtypeMap, `${pt}|*`);
    if (!subtype) throw new CostarParseError(`row ${r}: unmapped property type "${pt}|${st}" — add it to subtypeMap`);

    let buildingStatus: BuildingStatusT = 'unknown';
    const statusText = get('buildingStatus');
    if (statusText) {
      const mapped = lookupCI(map.buildingStatusMap, statusText);
      if (!mapped) throw new CostarParseError(`row ${r}: unmapped building status "${statusText}" — add it to buildingStatusMap`);
      buildingStatus = mapped;
    }

    let rentBasis: RentBasisT = 'UNKNOWN';
    const basisText = get('rentBasis');
    if (basisText) {
      const mapped = lookupCI(map.rentBasisMap, basisText);
      if (!mapped) throw new CostarParseError(`row ${r}: unmapped rent basis "${basisText}" — add it to rentBasisMap`);
      rentBasis = mapped;
    }

    const availableSf = parseNumber(get('availableSf'));
    if (availableSf === null || availableSf <= 0) {
      skipped.push({ rowNumber: r, reason: 'available SF missing, zero or unparseable' });
      continue;
    }

    let rentLow: number | null = null;
    let rentHigh: number | null = null;
    let rentPeriod = map.rentPeriodDefault;
    let rentIsTotal = false;
    let opexQuotedPsf: number | null = null;
    // Tracks whether parseRentText itself already resolved this row to an ambiguous (UNKNOWN) quote —
    // including the performance-guard-capped case, which returns rentLow/rentHigh both null alongside
    // ambiguous: true. The WITHHELD fallback below must not clobber that UNKNOWN with WITHHELD just
    // because rentLow/rentHigh both happen to be null.
    let textAmbiguous = false;
    if (idx.rentLow !== null) {
      rentLow = parseNumber(get('rentLow'));
      rentHigh = idx.rentHigh !== null ? parseNumber(get('rentHigh')) : null;
    }
    if (rentLow === null && rentHigh === null && idx.rentText !== null) {
      const parsed = parseRentText(get('rentText'));
      rentLow = parsed.rentLow;
      rentHigh = parsed.rentHigh;
      // The free-text quote states its own period (or none) — it must never silently inherit
      // map.rentPeriodDefault, which applies only to the numeric rentLow/rentHigh columns.
      rentPeriod = parsed.rentPeriod;
      rentIsTotal = parsed.isTotal;
      // An ambiguous quote's parsed add-on opex is exactly as suspect as its basis/rent figures — it
      // must never feed the market quoted-opex median.
      opexQuotedPsf = parsed.ambiguous ? null : parsed.opexQuoted;
      textAmbiguous = parsed.ambiguous;
      if (parsed.withheld) rentBasis = 'WITHHELD';
      else if (parsed.ambiguous) rentBasis = 'UNKNOWN';
      else if (parsed.basis) {
        if (!basisText) rentBasis = parsed.basis;
        // Both a mapped rentBasis column value and a text-parsed basis exist: agreement keeps the
        // (already column-mapped) rentBasis as-is; disagreement is a contradiction between two
        // independent inputs and must never be silently resolved by picking one — UNKNOWN instead.
        else if (rentBasis !== parsed.basis) rentBasis = 'UNKNOWN';
      }
    }
    // A text-parsed ambiguous quote (including parseRentText's own performance-guard-capped result,
    // which returns rentLow/rentHigh both null alongside ambiguous: true) already set rentBasis to
    // UNKNOWN above and must stay UNKNOWN — WITHHELD means "no quote at all," which is a different,
    // stronger claim than "a quote existed but couldn't be trusted." Guard against clobbering it.
    if (rentLow === null && rentHigh === null && !textAmbiguous) rentBasis = 'WITHHELD';

    const market = get('market');
    if (market) marketNames.add(market);

    const officePct = parsePercent(get('officePct'));
    const listingUrlIdx = idx.listingUrl;
    const listingUrlRaw = listingUrlIdx === null ? null : row.getCell(listingUrlIdx).value;

    const candidate = {
      costarPropertyId: nullIfEmpty(get('costarPropertyId')),
      address,
      suite: nullIfEmpty(get('suite')),
      city: nullIfEmpty(get('city')),
      state: nullIfEmpty(get('state')),
      zip: nullIfEmpty(get('zip')),
      lat: parseCoordinate(get('lat'), 90),
      lon: parseCoordinate(get('lon'), 180),
      submarket: nullIfEmpty(get('submarket')),
      subtype,
      buildingStatus,
      buildingSf: parseNumber(get('buildingSf')),
      yearBuilt: toInt(get('yearBuilt')),
      clearHeightFt: parseClearHeight(get('clearHeightFt')),
      docks: toInt(get('docks')),
      driveIns: toInt(get('driveIns')),
      officePct,
      ownerName: nullIfEmpty(get('ownerName')),
      availableSf,
      minDivisibleSf: parseNumber(get('minDivisibleSf')),
      rentLow,
      rentHigh,
      rentPeriod,
      rentIsTotal,
      rentBasis,
      opexQuotedPsf,
      isSublease: subleaseSet.has(get('spaceType').toLowerCase()),
      costarDateOnMarket: parseIsoDate(get('dateOnMarket')),
      brokerName: nullIfEmpty(get('brokerName')),
      brokerCompany: nullIfEmpty(get('brokerCompany')),
      listingUrl: nullIfEmpty(cellHyperlink(listingUrlRaw) ?? get('listingUrl')),
      description: nullIfEmpty(get('description'))?.slice(0, 4000) ?? null,
      sourceRow: r,
    };
    const parsedRow = CanonicalListingRow.safeParse(candidate);
    if (!parsedRow.success) {
      const issue = parsedRow.error.issues[0];
      skipped.push({ rowNumber: r, reason: issue ? `${issue.path.join('.')}: ${issue.message}` : 'invalid row' });
      continue;
    }
    rows.push(parsedRow.data);
  }

  return { headerFingerprint, marketNames: [...marketNames].sort(), rows, skipped, rowCount: rows.length + skipped.length };
}
