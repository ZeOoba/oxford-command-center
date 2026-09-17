// tests/unit/lease-market-fixtures.ts
//
// Shared lease-market test fixtures. The column labels below are TEST labels, NOT real CoStar export
// headers. The production map (config/lease-market.costar-headers.json) is filled from real exports.
import ExcelJS from 'exceljs';
import { join } from 'node:path';
import type { LeaseMarketConfig, LmThresholds, OwnerType } from '../../src/contracts/lease-market';
import type { CostarHeaderMap } from '../../server/warehouse/lease-market/costar-parse';
import type { OwnerScreenResult } from '../../server/warehouse/lease-market/owner-screen';

export const TEST_HEADERS = [
  'Property ID', 'Address', 'Suite', 'City', 'State', 'Market', 'Submarket', 'Type', 'Secondary Type', 'Status',
  'RBA', 'Year Built', 'Clear Height', 'Docks', 'Drive Ins', 'Office %', 'Owner', 'SF Available', 'Rent Low',
  'Rent High', 'Rent Type', 'Space Use', 'Date On Market', 'Zip', 'Latitude', 'Longitude', 'Leasing Broker',
  'Leasing Company', 'Listing URL',
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
  zip?: string | null;
  lat?: number | null;
  lon?: number | null;
  broker?: string | null;
  brokerCompany?: string | null;
  url?: string | null;
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
    pick(l, 'zip', '43219'), pick(l, 'lat', 39.99), pick(l, 'lon', -82.93), pick(l, 'broker', 'Pat Broker'),
    pick(l, 'brokerCompany', 'Acme Realty'), pick(l, 'url', null),
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
      rentText: null, rentBasis: 'Rent Type', spaceType: 'Space Use', dateOnMarket: 'Date On Market', zip: 'Zip',
      lat: 'Latitude', lon: 'Longitude', brokerName: 'Leasing Broker', brokerCompany: 'Leasing Company',
      listingUrl: 'Listing URL', description: null,
    },
    subtypeMap: { 'Industrial|*': 'warehouse', 'Flex|*': 'flex' },
    buildingStatusMap: { Existing: 'existing', Proposed: 'proposed', 'Under Construction': 'under_construction' },
    rentBasisMap: { NNN: 'NNN', MG: 'MG', IG: 'IG', Gross: 'GROSS', FS: 'FSG' },
    subleaseValues: ['Sublet'],
    ...patch,
  };
}

export const TEST_THRESHOLDS: LmThresholds = {
  benchmarkMinN: 5,
  belowMarketMinN: 10,
  belowMarketMedianRatio: 0.85,
  lowCoverageQuotedShare: 0.5,
  staleFloorDays: 180,
  staleBaselineMultiple: 1.5,
  staleFallbackDays: { established: 180, entry: 270 },
  completedDomMinN: 10,
  vacancyShareMin: 0.3,
  candidateMaxBuildingSf: 50000,
  benchmarkMaxBuildingSf: 80000,
  positioningBandPct: 0.1,
  rangeMaxSpread: 0.2,
  monthlyValueCeiling: 3,
  rentMinPsfYr: 1,
  rentMaxPsfYr: 60,
  quotedOpexMinN: 5,
  exportMinRowRatio: 0.7,
  exportRowCap: 2000,
  freshnessDays: 35,
  flexOfficeSplitPct: 40,
  similarityMinScore: 60,
  similarityTopK: 15,
  similarityMinComps: 8,
  similarityHighComps: 15,
  similarityPerPropertyCap: 3,
  similarityUnknownLowCap: 3,
  radarMinScore: 50,
  radarPushScore: 70,
  withdrawnLookbackDays: 90,
  sfChangePct: 0.05,
};

export function stubScreen(names: string[]): OwnerScreenResult {
  const unique = [...new Set(names.map((n) => n.trim()).filter(Boolean))];
  const types = new Map<string, OwnerType>();
  for (const n of unique) {
    const upper = n.toUpperCase();
    types.set(n, upper.includes('PROLOGIS') ? 'institutional' : upper.includes('OXFORD') ? 'affiliated' : 'private');
  }
  return { available: true, guardOk: true, types, error: null };
}

export function testConfig(patch: Partial<LeaseMarketConfig> = {}): LeaseMarketConfig {
  return {
    version: 1,
    mirrorRowLevel: true,
    ownerScreenModulePath: 'unused-in-tests',
    markets: [
      {
        id: 'columbus', label: 'Columbus', tier: 'established', enabled: true, costarMarketNames: ['Columbus'], mgLandlordPays: ['tax', 'ins'],
        opexDefaults: { warehouse: { tax: 1, ins: 0.25, cam: 0.5, source: 'test fixture', asOf: '2026-01-01' }, flex: null },
      },
      {
        id: 'madison', label: 'Madison', tier: 'entry', enabled: true, costarMarketNames: ['Madison'], mgLandlordPays: ['tax', 'ins'],
        opexDefaults: { warehouse: null, flex: null },
      },
    ],
    oraProperties: [
      {
        propertyKey: '1100 Rarig', marketId: 'columbus', submarket: 'East', subtype: 'warehouse', officePct: null, typicalUnitSf: 8000,
        leaseBasis: 'NNN', addressNorms: ['1100 RARIG AVE'], lat: null, lon: null, clearHeightFt: null, yearBuilt: null, docks: null,
        driveIns: null,
      },
    ],
    similarityWeights: { location: 30, size: 25, clearHeight: 15, age: 10, loading: 10, office: 10 },
    thresholds: TEST_THRESHOLDS,
    ...patch,
  };
}
