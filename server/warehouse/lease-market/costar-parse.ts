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
  // R12: whether the officePct column stores a fraction (e.g. 0.25 meaning 25%) rather than already
  // being in percentage points. Optional (defaults false, i.e. NOT fractional) so an existing header
  // map missing this field keeps parsePercent's plain-percentage-points behavior rather than silently
  // reinterpreting values via a value-magnitude guess.
  officePctIsFraction: z.boolean().optional(),
  fields: z.object({
    costarPropertyId: Col, address: Col, suite: Col, city: Col, state: Col, market: Col, submarket: Col,
    propertyType: Col, secondaryType: Col, buildingStatus: Col, buildingSf: Col, yearBuilt: Col, clearHeightFt: Col,
    docks: Col, driveIns: Col, officePct: Col, ownerName: Col, availableSf: Col, minDivisibleSf: Col, rentLow: Col,
    rentHigh: Col, rentText: Col, rentBasis: Col, spaceType: Col, dateOnMarket: Col,
    zip: Col, lat: Col, lon: Col, brokerName: Col, brokerCompany: Col, listingUrl: Col, description: Col,
    // timeOnMarketText: a DURATION string ("3 Months 12 Days") some CoStar exports carry instead of an
    // actual on-market date. Converted to costarDateOnMarket by subtracting from the export date — see
    // parseTimeOnMarketDuration/timeOnMarketTextToDate below.
    timeOnMarketText: Col,
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

// A CoStar "Time on Market" DURATION string ("3 Months 12 Days"), not a date. Parsed case-insensitively;
// singular/plural accepted for every unit. Units may appear in any combination but ONLY in strictly
// descending magnitude (years, then months, then days) — every real value observed in the first
// production export takes this form. An ascending or repeated-unit order ("12 Days 3 Months",
// "3 Months 1 Month") is a shape we have never seen and must be rejected, not guessed at. Any leftover
// text after matching known unit tokens (stray punctuation, an unrecognized unit) also rejects the
// whole string — the caller reports blank/unparseable input as a null date, never a throw and never a
// best-effort guess, because this date drives days-on-market and the acquisition radar's stale signal.
const DURATION_TOKEN_RE = /(\d+)\s*(years?|months?|days?)/gi;
const DURATION_UNIT_KIND: Readonly<Record<string, 'years' | 'months' | 'days'>> = {
  year: 'years', years: 'years', month: 'months', months: 'months', day: 'days', days: 'days',
};
const DURATION_UNIT_RANK: Readonly<Record<'years' | 'months' | 'days', number>> = { years: 3, months: 2, days: 1 };

export interface CalendarDuration { years: number; months: number; days: number }

export function parseTimeOnMarketDuration(text: string): CalendarDuration | null {
  const t = text.trim();
  if (!t) return null;
  const matches = [...t.matchAll(DURATION_TOKEN_RE)];
  if (matches.length === 0) return null;
  // Reject any input where the recognized tokens don't reconstruct the full string (normalized on
  // whitespace) — a stray character or an unrecognized unit word must fail closed, not be ignored.
  const reconstructed = matches.map((m) => `${m[1]} ${m[2]}`).join(' ');
  if (reconstructed.toLowerCase() !== t.replace(/\s+/g, ' ').toLowerCase()) return null;

  const duration: CalendarDuration = { years: 0, months: 0, days: 0 };
  let lastRank = Number.POSITIVE_INFINITY;
  const seen = new Set<'years' | 'months' | 'days'>();
  for (const m of matches) {
    const kind = DURATION_UNIT_KIND[m[2]!.toLowerCase()]!;
    if (seen.has(kind)) return null; // repeated unit
    seen.add(kind);
    const rank = DURATION_UNIT_RANK[kind];
    if (rank >= lastRank) return null; // not strictly descending magnitude
    lastRank = rank;
    const n = Number(m[1]);
    if (!Number.isFinite(n)) return null;
    duration[kind] = n;
  }
  return duration;
}

// Subtracts a calendar duration from an ISO date using WHOLE-MONTH arithmetic: years and months are
// subtracted first as calendar months (clamped to the last valid day of the resulting month — e.g.
// Mar 31 minus 1 month lands on Feb 28/29, never rolls into March), THEN days are subtracted as a plain
// day count (which may cross month/year boundaries freely, since it no longer needs clamping).
function subtractCalendarDuration(isoDate: string, duration: CalendarDuration): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]); // 1-based
  const day = Number(m[3]);
  const totalMonthsBack = duration.years * 12 + duration.months;
  const monthIndex = (year * 12 + (month - 1)) - totalMonthsBack; // months since year 0, 0-based month
  const targetYear = Math.floor(monthIndex / 12);
  const targetMonth0 = ((monthIndex % 12) + 12) % 12; // 0-based, always in [0, 11]
  const daysInTargetMonth = new Date(Date.UTC(targetYear, targetMonth0 + 1, 0)).getUTCDate();
  const clampedDay = Math.min(day, daysInTargetMonth);
  const dt = new Date(Date.UTC(targetYear, targetMonth0, clampedDay));
  dt.setUTCDate(dt.getUTCDate() - duration.days);
  return dt.toISOString().slice(0, 10);
}

const DURATION_MIN_DATE = '1990-01-01';

// Converts a "Time on Market" duration string to the listing's on-market date by subtracting it from
// the export date. Bounded: a resolved date before 1990-01-01 or after the export date itself is
// rejected as null rather than trusted — this date feeds days-on-market, the stale signal, and radar
// scoring, so an out-of-bounds result is a wrong acquisition signal, not a display quirk.
export function timeOnMarketTextToDate(text: string, exportDateIso: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(exportDateIso)) return null;
  const duration = parseTimeOnMarketDuration(text);
  if (duration === null) return null;
  const resolved = subtractCalendarDuration(exportDateIso, duration);
  if (resolved === null) return null;
  if (resolved < DURATION_MIN_DATE || resolved > exportDateIso) return null;
  return resolved;
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
// number is converted to percentage points (x100) ONLY when the header map says this column is
// fractional (`isFraction`) — R12: a value-magnitude heuristic ("a bare number in (0,1] must be a
// fraction") previously multiplied a genuine "1%" office share (stored as the bare number 1) by 100,
// silently turning 1% office into 100%. There is no way to distinguish "1" meaning 1% from "1" meaning
// a 1/100 fraction by value alone — only the export's own column semantics (declared once, per export
// layout, in the header map) can say which it is.
export function parsePercent(text: string, isFraction: boolean = false): number | null {
  const t = text.trim();
  if (t.endsWith('%')) return parseNumber(t.slice(0, -1));
  const n = parseNumber(t);
  return n === null ? null : isFraction ? n * 100 : n;
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

// `exportDate` (ISO yyyy-mm-dd) is the anchor a mapped `timeOnMarketText` duration is subtracted from.
// Ingest always passes its own already-resolved export date (file name or mtime); it defaults to
// today (UTC) only for callers — tests, mainly — that never map timeOnMarketText and so never read it.
export async function parseCostarListingsFile(filePath: string, map: CostarHeaderMap, exportDate?: string): Promise<ParsedCostarExport> {
  if (map.status !== 'verified') {
    throw new CostarParseError(
      'config/lease-market.costar-headers.json is still "pending-sample": fill every column from a real CoStar export header row and set status "verified" before ingesting.',
    );
  }
  const effectiveExportDate = exportDate ?? new Date().toISOString().slice(0, 10);
  for (const f of ['address', 'propertyType', 'availableSf'] as const) {
    if (!map.fields[f]) throw new CostarParseError(`header map field "${f}" is required`);
  }
  if (!map.fields.rentText && !map.fields.rentLow) throw new CostarParseError('header map needs fields.rentText or fields.rentLow');
  // R4: a numeric fields.rentLow/rentHigh column carries no unit of its own -- rentPeriodDefault is the
  // ONLY thing that says whether its figures are annual or monthly (unlike rentText, which states its
  // own period or falls back to the monthlyValueCeiling heuristic per row). Mapping rentLow with
  // rentPeriodDefault left null would silently read a monthly rate as annual — hard-fail here, before
  // any row is read, rather than mis-price every listing in the export.
  if (map.fields.rentLow && map.rentPeriodDefault === null) {
    throw new CostarParseError(
      'header map maps fields.rentLow but rentPeriodDefault is null — a numeric rent column has no period of its own; set rentPeriodDefault to "yr" or "mo"',
    );
  }

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
    // R14: a blank Address is not silently dropped — it must be counted as skipped (and so in
    // rowCount) so the completeness ratio (exportMinRowRatio) and the Data Quality tab's
    // lastExportSkipped both reflect the real loss instead of understating it.
    const address = get('address');
    if (!address) {
      skipped.push({ rowNumber: r, reason: 'address missing or blank' });
      continue;
    }

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

    const officePct = parsePercent(get('officePct'), map.officePctIsFraction ?? false);
    const listingUrlIdx = idx.listingUrl;
    const listingUrlRaw = listingUrlIdx === null ? null : row.getCell(listingUrlIdx).value;

    // costarDateOnMarket: a mapped, explicit `dateOnMarket` column always wins over `timeOnMarketText` —
    // per-row, not just when both happen to be populated. Only when the header map itself leaves
    // dateOnMarket unmapped does a mapped timeOnMarketText duration get converted (via the export date)
    // into the on-market date. A blank or unparseable value on either path yields null, never a throw.
    const costarDateOnMarket =
      idx.dateOnMarket !== null
        ? parseIsoDate(get('dateOnMarket'))
        : idx.timeOnMarketText !== null
          ? timeOnMarketTextToDate(get('timeOnMarketText'), effectiveExportDate)
          : null;

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
      costarDateOnMarket,
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
