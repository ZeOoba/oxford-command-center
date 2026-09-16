### Task 06: CoStar export parser (header-map driven) + shared test fixtures

**Files:**
- Create: `server/warehouse/lease-market/costar-parse.ts`
- Create: `config/lease-market.costar-headers.json`
- Create: `tests/unit/lease-market-fixtures.ts` (helper module, not a test file)
- Test: `tests/unit/lease-market-costar-parse.test.ts`

**Interfaces:**
- Consumes: Task 02 `CanonicalListingRow`, `RentBasis`, `LmSubtype`, `BuildingStatus`, `LeaseMarketConfig`, `LmThresholds`; Task 03 `parseRentText`.
- Produces:
  - `CostarHeaderMap` (Zod schema + type), `type HeaderField = keyof CostarHeaderMap['fields']`
  - `class CostarParseError extends Error`
  - `interface SkippedRow { rowNumber: number; reason: string }`
  - `interface ParsedCostarExport { headerFingerprint: string; marketNames: string[]; rows: CanonicalListingRow[]; skipped: SkippedRow[]; rowCount: number }`
  - `sha256File(path: string): string`, `cellText(value: unknown): string`, `parseNumber(text: string): number | null`, `parseIsoDate(text: string): string | null`
  - `parseCostarListingsFile(filePath: string, map: CostarHeaderMap): Promise<ParsedCostarExport>`
  - Fixtures: `TEST_HEADERS`, `interface FixtureListing`, `writeCostarFixture(dir, fileName, listings, opts?)`, `testHeaderMap(patch?)`, `TEST_THRESHOLDS`, `testConfig(patch?)`

Parser rules: refuses a map whose `status` is not `verified`; a mapped column missing from the export is a hard `CostarParseError`; unmapped property type / building status / rent basis values are hard errors naming the value; rows with blank address are ignored silently (blank / footer rows); rows with missing or zero available SF go to `skipped`; rows failing `CanonicalListingRow` go to `skipped` with the Zod message. No rent numbers ⇒ `WITHHELD`. `officePct` values in (0, 1] are fractions ⇒ ×100. `headerFingerprint` = sha256 of the sorted, de-duplicated non-empty header labels.

- [ ] **Step 1: Write the shared fixtures**

```ts
// tests/unit/lease-market-fixtures.ts
//
// Shared lease-market test fixtures. The column labels below are TEST labels, NOT real CoStar export
// headers. The production map (config/lease-market.costar-headers.json) is filled from real exports.
import ExcelJS from 'exceljs';
import { join } from 'node:path';
import type { LeaseMarketConfig, LmThresholds } from '../../src/contracts/lease-market';
import type { CostarHeaderMap } from '../../server/warehouse/lease-market/costar-parse';

export const TEST_HEADERS = [
  'Property ID', 'Address', 'Suite', 'City', 'State', 'Market', 'Submarket', 'Type', 'Secondary Type', 'Status',
  'RBA', 'Year Built', 'Clear Height', 'Docks', 'Drive Ins', 'Office %', 'Owner', 'SF Available', 'Rent Low',
  'Rent High', 'Rent Type', 'Space Use', 'Date On Market',
] as const;

export interface FixtureListing {
  id?: string | null;
  address: string;
  suite?: string | null;
  city?: string;
  state?: string;
  market?: string;
  submarket?: string | null;
  type?: string;
  secondary?: string;
  status?: string | null;
  rba?: number | null;
  yearBuilt?: number | null;
  clear?: number | null;
  docks?: number | null;
  driveIns?: number | null;
  officePct?: number | null;
  owner?: string | null;
  sf: number;
  rentLow?: number | string | null;
  rentHigh?: number | null;
  rentType?: string | null;
  spaceUse?: string;
  dateOnMarket?: Date | string | null;
}

function pick<K extends keyof FixtureListing>(l: FixtureListing, key: K, fallback: FixtureListing[K]): FixtureListing[K] {
  return key in l ? l[key] : fallback;
}

function rowValues(l: FixtureListing): unknown[] {
  return [
    pick(l, 'id', null), l.address, pick(l, 'suite', null), pick(l, 'city', 'Columbus'), pick(l, 'state', 'OH'),
    pick(l, 'market', 'Columbus'), pick(l, 'submarket', 'East'), pick(l, 'type', 'Industrial'), pick(l, 'secondary', 'Warehouse'),
    pick(l, 'status', 'Existing'), pick(l, 'rba', 40000), pick(l, 'yearBuilt', 1990), pick(l, 'clear', 20), pick(l, 'docks', 2),
    pick(l, 'driveIns', 1), pick(l, 'officePct', null), pick(l, 'owner', 'SMITH FAMILY LLC'), l.sf, pick(l, 'rentLow', 9),
    pick(l, 'rentHigh', null), pick(l, 'rentType', 'NNN'), pick(l, 'spaceUse', 'Direct'), pick(l, 'dateOnMarket', '2026-01-15'),
  ];
}

export async function writeCostarFixture(
  dir: string,
  fileName: string,
  listings: FixtureListing[],
  opts: { extraHeader?: string; omitHeader?: (typeof TEST_HEADERS)[number] } = {},
): Promise<string> {
  const wb = new ExcelJS.Workbook();
  // Distinct bytes per file name: ingest dedups on sha256, and two fixtures with the same rows written in
  // the same second would otherwise collide. Re-ingesting the SAME path still yields identical bytes.
  wb.subject = fileName;
  const ws = wb.addWorksheet('Listings');
  const omitIdx = opts.omitHeader ? TEST_HEADERS.indexOf(opts.omitHeader) : -1;
  const keep = <T,>(values: readonly T[]): T[] => values.filter((_, i) => i !== omitIdx);
  const headers: string[] = keep(TEST_HEADERS);
  if (opts.extraHeader) headers.push(opts.extraHeader);
  ws.addRow(headers);
  for (const l of listings) {
    const values = keep(rowValues(l));
    if (opts.extraHeader) values.push(null);
    ws.addRow(values);
  }
  const path = join(dir, fileName);
  await wb.xlsx.writeFile(path);
  return path;
}

export function testHeaderMap(patch: Partial<CostarHeaderMap> = {}): CostarHeaderMap {
  return {
    status: 'verified',
    sheetName: null,
    headerRow: 1,
    rentPeriodDefault: 'yr',
    fields: {
      costarPropertyId: 'Property ID', address: 'Address', suite: 'Suite', city: 'City', state: 'State', market: 'Market',
      submarket: 'Submarket', propertyType: 'Type', secondaryType: 'Secondary Type', buildingStatus: 'Status', buildingSf: 'RBA',
      yearBuilt: 'Year Built', clearHeightFt: 'Clear Height', docks: 'Docks', driveIns: 'Drive Ins', officePct: 'Office %',
      ownerName: 'Owner', availableSf: 'SF Available', minDivisibleSf: null, rentLow: 'Rent Low', rentHigh: 'Rent High',
      rentText: null, rentBasis: 'Rent Type', spaceType: 'Space Use', dateOnMarket: 'Date On Market',
    },
    subtypeMap: { 'Industrial|*': 'warehouse', 'Flex|*': 'flex' },
    buildingStatusMap: { Existing: 'existing', Proposed: 'proposed', 'Under Construction': 'under_construction' },
    rentBasisMap: { NNN: 'NNN', MG: 'MG', IG: 'IG', Gross: 'GROSS', FS: 'FSG' },
    subleaseValues: ['Sublet'],
    ...patch,
  };
}

export const TEST_THRESHOLDS: LmThresholds = {
  benchmarkMinN: 5, belowMarketMinN: 10, belowMarketMedianRatio: 0.85, lowCoverageQuotedShare: 0.5,
  staleFloorDays: 180, staleBaselineMultiple: 1.5, staleFallbackDays: { established: 180, entry: 270 },
  completedDomMinN: 10, vacancyShareMin: 0.3, candidateMaxBuildingSf: 50000, benchmarkMaxBuildingSf: 80000,
  positioningBandPct: 0.1, rangeMaxSpread: 0.2, monthlyValueCeiling: 3, exportMinRowRatio: 0.7,
  exportRowCap: 2000, freshnessDays: 35, flexOfficeSplitPct: 40,
};

export function testConfig(patch: Partial<LeaseMarketConfig> = {}): LeaseMarketConfig {
  return {
    version: 1,
    mirrorRowLevel: true,
    ownerScreenModulePath: 'unused-in-tests',
    markets: [
      {
        id: 'columbus', label: 'Columbus', tier: 'established', costarMarketNames: ['Columbus'], mgLandlordPays: ['tax', 'ins'],
        opexDefaults: { warehouse: { tax: 1, ins: 0.25, cam: 0.5, source: 'test fixture', asOf: '2026-01-01' }, flex: null },
      },
      { id: 'madison', label: 'Madison', tier: 'entry', costarMarketNames: ['Madison'], mgLandlordPays: ['tax', 'ins'], opexDefaults: { warehouse: null, flex: null } },
    ],
    oraProperties: [
      { propertyKey: '1100 Rarig', marketId: 'columbus', submarket: 'East', subtype: 'warehouse', officePct: null, typicalUnitSf: 8000, leaseBasis: 'NNN', addressNorms: ['1100 RARIG AVE'] },
    ],
    thresholds: TEST_THRESHOLDS,
    ...patch,
  };
}
```

If lint flags the `<T,>` generic arrow in a `.ts` file, rewrite `keep` as a nested `function keep<T>(values: readonly T[]): T[]`.

- [ ] **Step 2: Write the failing test**

```ts
// tests/unit/lease-market-costar-parse.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCostarListingsFile } from '../../server/warehouse/lease-market/costar-parse';
import { testHeaderMap, writeCostarFixture } from './lease-market-fixtures';

const dir = () => mkdtempSync(join(tmpdir(), 'lm-parse-'));

describe('parseCostarListingsFile', () => {
  it('refuses a pending-sample header map', async () => {
    const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 1000 }]);
    await expect(parseCostarListingsFile(f, testHeaderMap({ status: 'pending-sample' }))).rejects.toThrow(/pending-sample/);
  });

  it('maps rows to canonical listings and skips rows without SF', async () => {
    const f = await writeCostarFixture(dir(), 'a.xlsx', [
      { id: 'C1', address: '10 Alpha Rd', suite: 'Suite 100', sf: 12000, rentLow: 8.5, rentType: 'NNN', officePct: 0.25, dateOnMarket: new Date(Date.UTC(2025, 10, 1)) },
      { id: 'C2', address: '20 Beta Dr', type: 'Flex', sf: 3000, rentLow: null, rentType: null, spaceUse: 'Sublet' },
      { address: '30 Gamma Way', sf: 0 },
    ]);
    const r = await parseCostarListingsFile(f, testHeaderMap());
    expect(r.rowCount).toBe(3);
    expect(r.marketNames).toEqual(['Columbus']);
    expect(r.skipped).toEqual([{ rowNumber: 4, reason: expect.stringMatching(/available SF/) }]);
    expect(r.rows[0]).toEqual({
      costarPropertyId: 'C1', address: '10 Alpha Rd', suite: 'Suite 100', city: 'Columbus', state: 'OH', submarket: 'East',
      subtype: 'warehouse', buildingStatus: 'existing', buildingSf: 40000, yearBuilt: 1990, clearHeightFt: 20, docks: 2,
      driveIns: 1, officePct: 25, ownerName: 'SMITH FAMILY LLC', availableSf: 12000, minDivisibleSf: null, rentLow: 8.5,
      rentHigh: null, rentPeriod: 'yr', rentBasis: 'NNN', isSublease: false, costarDateOnMarket: '2025-11-01',
    });
    expect(r.rows[1]).toMatchObject({ costarPropertyId: 'C2', subtype: 'flex', rentBasis: 'WITHHELD', isSublease: true, costarDateOnMarket: '2026-01-15' });
  });

  it('hard-fails on a missing mapped column', async () => {
    const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 1000 }], { omitHeader: 'Docks' });
    await expect(parseCostarListingsFile(f, testHeaderMap())).rejects.toThrow(/missing column "Docks"/);
  });

  it('hard-fails on unmapped property type and rent basis values', async () => {
    const d = dir();
    const retail = await writeCostarFixture(d, 'r.xlsx', [{ address: '1 Main St', sf: 1000, type: 'Retail' }]);
    await expect(parseCostarListingsFile(retail, testHeaderMap())).rejects.toThrow(/unmapped property type "Retail\|Warehouse"/);
    const net = await writeCostarFixture(d, 'n.xlsx', [{ address: '1 Main St', sf: 1000, rentType: 'Net' }]);
    await expect(parseCostarListingsFile(net, testHeaderMap())).rejects.toThrow(/unmapped rent basis "Net"/);
  });

  it('fingerprints the header set, not the rows', async () => {
    const d = dir();
    const a = await parseCostarListingsFile(await writeCostarFixture(d, 'a.xlsx', [{ address: '1 Main St', sf: 1000 }]), testHeaderMap());
    const b = await parseCostarListingsFile(await writeCostarFixture(d, 'b.xlsx', [{ address: '2 Main St', sf: 2000 }]), testHeaderMap());
    const c = await parseCostarListingsFile(await writeCostarFixture(d, 'c.xlsx', [{ address: '3 Main St', sf: 3000 }], { extraHeader: 'Notes' }), testHeaderMap());
    expect(a.headerFingerprint).toBe(b.headerFingerprint);
    expect(c.headerFingerprint).not.toBe(a.headerFingerprint);
  });

  it('parses a free-text rent column when mapped', async () => {
    const f = await writeCostarFixture(dir(), 'a.xlsx', [{ address: '1 Main St', sf: 1000, rentLow: '$0.75/SF/MO IG', rentType: null }]);
    const base = testHeaderMap();
    const map = testHeaderMap({ fields: { ...base.fields, rentText: 'Rent Low', rentLow: null, rentHigh: null, rentBasis: null } });
    const r = await parseCostarListingsFile(f, map);
    expect(r.rows[0]).toMatchObject({ rentLow: 0.75, rentHigh: 0.75, rentPeriod: 'mo', rentBasis: 'IG' });
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/lease-market-costar-parse.test.ts`
Expected: FAIL — cannot resolve `costar-parse`.

- [ ] **Step 4: Write the parser**

```ts
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

function lookupCI<T>(record: Record<string, T>, key: string): T | undefined {
  const k = Object.keys(record).find((x) => x.toLowerCase() === key.toLowerCase());
  return k === undefined ? undefined : record[k];
}

function toInt(text: string): number | null {
  const n = parseNumber(text);
  return n === null ? null : Math.round(n);
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
    if (idx.rentLow !== null) {
      rentLow = parseNumber(get('rentLow'));
      rentHigh = idx.rentHigh !== null ? parseNumber(get('rentHigh')) : null;
    }
    if (rentLow === null && rentHigh === null && idx.rentText !== null) {
      const parsed = parseRentText(get('rentText'));
      rentLow = parsed.rentLow;
      rentHigh = parsed.rentHigh;
      if (parsed.rentPeriod) rentPeriod = parsed.rentPeriod;
      if (parsed.withheld) rentBasis = 'WITHHELD';
      else if (!basisText && parsed.basis) rentBasis = parsed.basis;
    }
    if (rentLow === null && rentHigh === null) rentBasis = 'WITHHELD';

    const market = get('market');
    if (market) marketNames.add(market);

    const officeRaw = parseNumber(get('officePct'));
    const officePct = officeRaw !== null && officeRaw > 0 && officeRaw <= 1 ? officeRaw * 100 : officeRaw;
    const nullIfEmpty = (s: string): string | null => (s === '' ? null : s);

    const candidate = {
      costarPropertyId: nullIfEmpty(get('costarPropertyId')),
      address,
      suite: nullIfEmpty(get('suite')),
      city: nullIfEmpty(get('city')),
      state: nullIfEmpty(get('state')),
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
      rentBasis,
      isSublease: subleaseSet.has(get('spaceType').toLowerCase()),
      costarDateOnMarket: parseIsoDate(get('dateOnMarket')),
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
```

Note: `rentHigh` for a single-value NNN row stays `null` (the fixture test expects `rentHigh: null`); `priceObservation` treats a null high as equal to low.

- [ ] **Step 5: Write the production header map (pending)**

```json
{
  "status": "pending-sample",
  "note": "Fill every non-null column label from a REAL CoStar Suite lease-listing export header row (Task 99). Leave a field null only if the export has no such column. The parser refuses to run until status is \"verified\". Never guess labels.",
  "sheetName": null,
  "headerRow": 1,
  "rentPeriodDefault": null,
  "fields": {
    "costarPropertyId": null, "address": null, "suite": null, "city": null, "state": null, "market": null,
    "submarket": null, "propertyType": null, "secondaryType": null, "buildingStatus": null, "buildingSf": null,
    "yearBuilt": null, "clearHeightFt": null, "docks": null, "driveIns": null, "officePct": null, "ownerName": null,
    "availableSf": null, "minDivisibleSf": null, "rentLow": null, "rentHigh": null, "rentText": null, "rentBasis": null,
    "spaceType": null, "dateOnMarket": null
  },
  "subtypeMap": {},
  "buildingStatusMap": {},
  "rentBasisMap": {},
  "subleaseValues": []
}
```

Save as `config/lease-market.costar-headers.json`. Add this assertion to the end of the test file's `describe` block and re-run:

```ts
  it('the shipped header map parses and is still pending a real sample', async () => {
    const { readFileSync } = await import('node:fs');
    const { CostarHeaderMap } = await import('../../server/warehouse/lease-market/costar-parse');
    const shipped = CostarHeaderMap.parse(JSON.parse(readFileSync(join(process.cwd(), 'config', 'lease-market.costar-headers.json'), 'utf8')));
    expect(['pending-sample', 'verified']).toContain(shipped.status);
  });
```

- [ ] **Step 6: Run tests, typecheck, lint**

Run: `npx vitest run tests/unit/lease-market-costar-parse.test.ts && npm run typecheck && npx eslint server/warehouse/lease-market tests/unit/lease-market-fixtures.ts tests/unit/lease-market-costar-parse.test.ts --max-warnings 0`
Expected: PASS / clean. If `ExcelJS.Worksheet` typing of `wb.csv.readFile` differs, keep the behavior and adjust only the type annotation.

- [ ] **Step 7: Commit**

```bash
git add server/warehouse/lease-market/costar-parse.ts config/lease-market.costar-headers.json tests/unit/lease-market-fixtures.ts tests/unit/lease-market-costar-parse.test.ts
git commit -F <message-file>   # "feat(warehouse): header-mapped CoStar lease listing parser"
```
