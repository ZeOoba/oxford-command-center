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

export function parseNumber(text: string): number | null {
  const cleaned = text.replace(/[^0-9.-]/g, '');
  if (cleaned === '' || cleaned === '-' || cleaned === '.') return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function parseIsoDate(text: string): string | null {
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) return text;
  const t = Date.parse(text);
  return Number.isNaN(t) ? null : new Date(t).toISOString().slice(0, 10);
}

// A coordinate of exactly 0 is CoStar's "unknown" sentinel, not the Gulf of Guinea — reject it along
// with anything outside the valid range for the axis (lat: ±90, lon: ±180).
export function parseCoordinate(text: string, limit: number): number | null {
  const n = parseNumber(text);
  return n === null || Math.abs(n) > limit || n === 0 ? null : n;
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
  const headerRow = sheet.getRow(map.headerRow);
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const label = cellText(cell.value);
    if (label && !colIndex.has(label)) colIndex.set(label, colNumber);
  });
  const headerFingerprint = createHash('sha256').update([...colIndex.keys()].sort().join('\n')).digest('hex');

  const idx = {} as Record<HeaderField, number | null>;
  for (const [field, column] of Object.entries(map.fields) as Array<[HeaderField, string | null]>) {
    if (column === null) {
      idx[field] = null;
      continue;
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
      skipped.push({ rowNumber: r, reason: 'available SF missing or zero' });
      continue;
    }

    let rentLow: number | null = null;
    let rentHigh: number | null = null;
    let rentPeriod = map.rentPeriodDefault;
    let rentIsTotal = false;
    let opexQuotedPsf: number | null = null;
    if (idx.rentLow !== null) {
      rentLow = parseNumber(get('rentLow'));
      rentHigh = idx.rentHigh !== null ? parseNumber(get('rentHigh')) : null;
    }
    if (rentLow === null && rentHigh === null && idx.rentText !== null) {
      const parsed = parseRentText(get('rentText'));
      rentLow = parsed.rentLow;
      rentHigh = parsed.rentHigh;
      if (parsed.rentPeriod) rentPeriod = parsed.rentPeriod;
      rentIsTotal = parsed.isTotal;
      opexQuotedPsf = parsed.opexQuoted;
      if (parsed.withheld) rentBasis = 'WITHHELD';
      else if (parsed.ambiguous) rentBasis = 'UNKNOWN';
      else if (!basisText && parsed.basis) rentBasis = parsed.basis;
    }
    // No unconditional-UNKNOWN guard needed here: parseRentText only ever sets `ambiguous` (and thus
    // rentBasis='UNKNOWN' above) alongside a non-null rentLow, so whenever both are null this line's
    // own condition already excludes the ambiguous case — it never clobbers an ambiguity-driven UNKNOWN.
    if (rentLow === null && rentHigh === null) rentBasis = 'WITHHELD';

    const market = get('market');
    if (market) marketNames.add(market);

    const officeRaw = parseNumber(get('officePct'));
    const officePct = officeRaw !== null && officeRaw > 0 && officeRaw <= 1 ? officeRaw * 100 : officeRaw;

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
      clearHeightFt: parseNumber(get('clearHeightFt')),
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
      listingUrl: nullIfEmpty(get('listingUrl')),
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
