// tests/unit/warehouse-mirror-bake.test.ts
//
// The deterministic CONTRACT test for the Fat Mirror bake (Eric Live Phase 1b): warehouse.json's
// shape must MATCH what the corresponding server endpoints return. The bake invokes the REAL Hono
// warehouse router in-process (app.request), so a baked payload is identical-by-construction to the
// live route — this test proves (a) every planned endpoint is present, (b) each baked payload
// validates against the SAME contract Zod schema the server `.parse()`s before `c.json`, and
// (c) byte-parity with a fresh router request for a parameterized endpoint.
//
// Fixture writer + SEED are copied locally (tests never import across test files) — the same
// committed 2024+2025 Rarig warehouse used by tests/unit/warehouse-api.test.ts.
import ExcelJS from 'exceljs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, beforeAll, afterAll, vi } from 'vitest';
import { warehouseRoutes } from '../../server/warehouse/api';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { ingestFile } from '../../server/warehouse/ingest';
import { seedMappings } from '../../server/warehouse/mapping';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import {
  MetricsResponseSchema, ScoresResponseSchema, GrowthResponseSchema, AnomaliesResponseSchema,
  PmScorecardsResponseSchema, BenchmarksResponseSchema, DriversResponseSchema,
  CalibrationLogResponseSchema, CalibrationPendingResponseSchema, CalibrationReportSchema,
} from '../../src/contracts/warehouse';
import { BrainReport } from '../../src/contracts/brain-report';
import { LeaseRunRollupResponse, LeaseRunProjectionEnvelope } from '../../src/contracts/lease-run';
import { WAREHOUSE_MIRROR_SCHEMA_VERSION } from '../../src/lib/warehouse-mirror';
import { TrendsHistoryResponseSchema } from '../../src/contracts/trends';
import { buildWarehouseEnvelope, inProcessResolver, warehouseEndpointPlan } from '../../scripts/bake-warehouse';

// The bake plans /lease-market/positioning, whose route falls back to the live brain singleton
// (inProcessResolver injects no getSnapshot). This suite never refreshes it, so the real one always
// answered null (positioning 503s and the bake drops it). The stub returns the same null without
// loading the rest of server/brain's graph: the workbook parser, date-fns (304 files) and
// chokidar. exceljs is already loaded here by the fixture writer. At 100% CPU, a cold import of
// server/brain measured 13-289s, and date-fns alone ~30s. That import ran inside beforeAll.
vi.mock('../../server/brain', () => ({
  brain: { getSnapshot: vi.fn(() => null) },
}));
import { brain } from '../../server/brain';

const RARIG = '1100-rarig-ave-columbus-oh';

async function writeFixture(path: string, periodLine: string, rent: number, hvac: number): Promise<void> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Sheet1');
  const rows: Array<[string | null, string | null, string | null, number | null]> = [
    ['Profit & Loss', null, null, null],
    ['Property: 1100 Rarig Ave', null, null, null],
    [periodLine, null, null, null],
    [null, 'INCOME', null, null],
    [null, null, '     5002 RENTAL INCOME', null],
    [null, null, '          5064 Rent', rent],
    [null, 'EXPENSE', null, null],
    [null, null, '     6160 REPAIR', null],
    [null, null, '          6285 HVAC Repair', hvac],
    [null, 'NON OPERATING EXPENSE', null, null],
    [null, null, '          7402 Distribution to Owner', 25000],
  ];
  for (const r of rows) ws.addRow(r);
  await wb.xlsx.writeFile(path);
}

const SEED = [
  { account: 'Rent', code: '5064', normalized_category: 'Rental Revenue', classification: 'revenue' },
  { account: 'HVAC Repair', code: '6285', normalized_category: 'Repairs & Maintenance', classification: 'opex' },
  { account: 'Distribution to Owner', code: '7402', normalized_category: 'Distributions', classification: 'excluded' },
];

/** Two committed Rarig imports (2024 + 2025) → analytics have a consecutive full-year pair. */
async function populatedWarehouse(): Promise<WarehouseDb> {
  const dir = mkdtempSync(join(tmpdir(), 'whbake-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  seedMappings(db, SEED);
  const f2024 = join(dir, 'P&L 2024 -- 1100 Rarig.xlsx');
  await writeFixture(f2024, '01/01/24 - 12/31/24  (cash basis)', 90000, 4000);
  expect((await ingestFile(db, f2024, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' })).status)
    .toBe('committed');
  const f2025 = join(dir, 'P&L 2025 -- 1100 Rarig.xlsx');
  await writeFixture(f2025, '01/01/25 - 12/31/25  (cash basis)', 100000, 5000);
  expect((await ingestFile(db, f2025, { rawDir: join(dir, 'raw'), importedAt: '2026-06-12T00:00:00Z' })).status)
    .toBe('committed');
  return db;
}

describe('Fat Mirror bake — warehouse.json shape matches the server endpoints', () => {
  let db: WarehouseDb;
  let endpoints: Record<string, unknown>;

  beforeAll(async () => {
    db = await populatedWarehouse();
    const env = await buildWarehouseEnvelope(inProcessResolver(db), {
      now: Date.parse('2026-06-15T00:00:00.000Z'),
      warehouseSource: 'checkpoint-read',
    });
    expect(env.schemaVersion).toBe(WAREHOUSE_MIRROR_SCHEMA_VERSION);
    expect(env.warehouseSource).toBe('checkpoint-read');
    expect(env.bakedAt).toBe('2026-06-15T00:00:00.000Z');
    endpoints = env.endpoints;
  });

  afterAll(() => db.close());

  it('resolves /lease-market/positioning through the brain stub (null snapshot: 503, not baked)', () => {
    // Guards that the stub intercepts; if it didn't, the real server/brain import would come back.
    expect(brain.getSnapshot).toHaveBeenCalled();
    expect(endpoints['/api/warehouse/lease-market/positioning']).toBeUndefined();
  });

  it('bakes every required fixed PFI + calibration endpoint', () => {
    for (const k of [
      '/api/warehouse/noi', '/api/warehouse/imports', '/api/warehouse/issues',
      '/api/warehouse/analytics/metrics', '/api/warehouse/analytics/scores',
      '/api/warehouse/analytics/pm', '/api/warehouse/analytics/growth',
      '/api/warehouse/analytics/anomalies', '/api/warehouse/analytics/lease-run',
      '/api/warehouse/calibration/log', '/api/warehouse/calibration/pending',
      '/api/warehouse/calibration/report', '/api/warehouse/brain/report',
    ]) {
      expect(endpoints[k], `missing baked endpoint ${k}`).toBeDefined();
    }
  });

  it('bakes the Command Brain report via its OWN sub-router, not warehouseRoutes() (brainApi is ' +
    'mounted separately in server/index.ts — see inProcessResolver\'s WAREHOUSE_SUB_ROUTERS dispatch)', () => {
    const key = '/api/warehouse/brain/report';
    expect(endpoints[key], `missing baked endpoint ${key}`).toBeDefined();
    expect(() => BrainReport.parse(endpoints[key])).not.toThrow();
  });

  it('FIXED 2026-08-21 (adversarial review finding): a /brain/report failure does not abort the ' +
    'rest of the bake — brain was removed from REQUIRED_ROUTES precisely so one complex, ' +
    'multi-source endpoint failing can\'t take NOI/analytics/calibration down with it', async () => {
    const real = inProcessResolver(db);
    const failingBrain: typeof real = async (routerPath) =>
      routerPath === '/brain/report' ? { status: 500, json: null } : real(routerPath);

    const env = await buildWarehouseEnvelope(failingBrain, {
      now: Date.parse('2026-06-15T00:00:00.000Z'),
      warehouseSource: 'checkpoint-read',
    });

    // Every OTHER required endpoint still baked — the failure did not abort buildWarehouseEnvelope.
    expect(env.endpoints['/api/warehouse/noi']).toBeDefined();
    expect(env.endpoints['/api/warehouse/analytics/metrics']).toBeDefined();
    expect(env.endpoints['/api/warehouse/calibration/report']).toBeDefined();
    // The failed brain endpoint is simply omitted (a 500 is not required), not a thrown bake.
    expect(env.endpoints['/api/warehouse/brain/report']).toBeUndefined();
  });

  it('Portfolio Trends Wave 2: plans and bakes /analytics/trends/history (fixed path, parses with the contract)', () => {
    expect(warehouseEndpointPlan([], [])).toContain('/analytics/trends/history');
    const key = '/api/warehouse/analytics/trends/history';
    expect(endpoints[key], `missing baked endpoint ${key}`).toBeDefined();
    expect(() => TrendsHistoryResponseSchema.parse(endpoints[key])).not.toThrow();
    // Empty points is the valid fresh-warehouse shape; a populated point parses too.
    expect(() => TrendsHistoryResponseSchema.parse({ points: [] })).not.toThrow();
    expect(() => TrendsHistoryResponseSchema.parse({
      points: [{
        propertyId: RARIG, month: '2026-09', capturedThrough: '2026-09-30', totalSf: 10000, leasedSf: 9000,
        inPlaceRent: 90000, leaseCount: 3, occPct: 0.9, frozen: false,
      }],
    })).not.toThrow();
  });

  it('Portfolio Trends Wave 2: a /analytics/trends/history failure is NOT required — it omits that ' +
    'one endpoint instead of aborting the bake (new in Wave 2, empty/absent on an older warehouse)', async () => {
    const real = inProcessResolver(db);
    const failing: typeof real = async (routerPath) =>
      routerPath === '/analytics/trends/history' ? { status: 503, json: null } : real(routerPath);

    const env = await buildWarehouseEnvelope(failing, {
      now: Date.parse('2026-06-15T00:00:00.000Z'),
      warehouseSource: 'checkpoint-read',
    });

    expect(env.endpoints['/api/warehouse/noi']).toBeDefined();
    expect(env.endpoints['/api/warehouse/analytics/metrics']).toBeDefined();
    expect(env.endpoints['/api/warehouse/analytics/trends/history']).toBeUndefined();
  });

  it('FIXED 2026-08-21 (adversarial review finding): inProcessResolver dispatches to sub-routers ' +
    'generically via WAREHOUSE_SUB_ROUTERS, not just a hardcoded brain special-case — proven here ' +
    'against a DIFFERENT sub-router (insurance/analysis) that was never wired into the old ' +
    'BRAIN_PREFIX-only branch', async () => {
    const resolve = inProcessResolver(db);
    const res = await resolve('/insurance/analysis');
    expect(res.status).not.toBe(404);
    expect(res.status).toBe(200);
  });

  it('inProcessResolver matches the longest sub-router prefix first (/insurance/analysis vs ' +
    '/insurance/loss must not collide)', async () => {
    const resolve = inProcessResolver(db);
    const analysis = await resolve('/insurance/analysis');
    const loss = await resolve('/insurance/loss');
    expect(analysis.status).toBe(200);
    expect(loss.status).toBe(200);
    expect(analysis.json).not.toEqual(loss.json);
  });

  it('each baked payload validates against the SAME contract schema the server parses', () => {
    expect(() => MetricsResponseSchema.parse(endpoints['/api/warehouse/analytics/metrics'])).not.toThrow();
    expect(() => ScoresResponseSchema.parse(endpoints['/api/warehouse/analytics/scores'])).not.toThrow();
    expect(() => GrowthResponseSchema.parse(endpoints['/api/warehouse/analytics/growth'])).not.toThrow();
    expect(() => AnomaliesResponseSchema.parse(endpoints['/api/warehouse/analytics/anomalies'])).not.toThrow();
    expect(() => PmScorecardsResponseSchema.parse(endpoints['/api/warehouse/analytics/pm'])).not.toThrow();
    expect(() => LeaseRunRollupResponse.parse(endpoints['/api/warehouse/analytics/lease-run'])).not.toThrow();
    expect(() => CalibrationLogResponseSchema.parse(endpoints['/api/warehouse/calibration/log'])).not.toThrow();
    expect(() => CalibrationPendingResponseSchema.parse(endpoints['/api/warehouse/calibration/pending'])).not.toThrow();
    expect(() => CalibrationReportSchema.parse(endpoints['/api/warehouse/calibration/report'])).not.toThrow();
  });

  it('bakes the parameterized benchmarks endpoints (every present FY × metric) with byte-parity', async () => {
    const app = warehouseRoutes(() => db);
    for (const period of ['2024', '2025']) {
      const url = `/analytics/benchmarks?period=${period}&metric=noiPerSf`;
      const key = `/api/warehouse${url}`;
      expect(endpoints[key], `missing ${key}`).toBeDefined();
      const live = await (await app.request(url)).json();
      expect(endpoints[key]).toEqual(live);
      expect(() => BenchmarksResponseSchema.parse(endpoints[key])).not.toThrow();
    }
  });

  it('bakes a per-property drivers slice for the full-year pair (2024→2025) with byte-parity', async () => {
    const app = warehouseRoutes(() => db);
    const url = `/analytics/drivers/${RARIG}?from=2024&to=2025`;
    const key = `/api/warehouse${url}`;
    expect(endpoints[key], `missing ${key}`).toBeDefined();
    const live = await (await app.request(url)).json();
    expect(endpoints[key]).toEqual(live);
    expect(() => DriversResponseSchema.parse(endpoints[key])).not.toThrow();
  });

  it('bakes a per-property lease-run envelope (empty projection when no lease terms)', () => {
    const key = `/api/warehouse/analytics/lease-run/${RARIG}`;
    expect(endpoints[key], `missing ${key}`).toBeDefined();
    expect(() => LeaseRunProjectionEnvelope.parse(endpoints[key])).not.toThrow();
  });

  it('does NOT bake a 503 or a non-200 payload (only successful route responses are stored)', () => {
    // Every stored value is a real JSON object/array, never the 503 {error} sentinel.
    for (const [k, v] of Object.entries(endpoints)) {
      expect(v, `endpoint ${k} stored null`).not.toBeNull();
      expect(v, `endpoint ${k} stored a non-object`).toBeTypeOf('object');
      expect((v as { error?: string }).error, `endpoint ${k} stored an error payload`).toBeUndefined();
    }
  });
});
