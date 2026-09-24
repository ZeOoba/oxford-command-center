// tests/unit/lease-market-api-bake.test.ts
//
// Fix round 1, item 1 — bake-scoped redaction. Gabriel ratified listing-level data on the PRIVATE,
// Access-gated mirror, so config/lease-market.json keeps mirrorRowLevel:true as shipped. The
// public-safe/redacted bake mode must never carry CoStar row-level identifiers into
// public/warehouse.json regardless of that config value — this is the confidentiality boundary the
// Fat-Mirror bake (scripts/bake-warehouse.ts) must enforce independent of the router's own config.
import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse, type WarehouseDb } from '../../server/warehouse/db';
import { ingestCostarListingsFile } from '../../server/warehouse/lease-market/ingest';
import { runCompute } from '../../server/warehouse/lease-market/compute';
import { loadLeaseMarketConfig } from '../../server/warehouse/lease-market/config';
import { inProcessResolver, buildWarehouseEnvelope, leaseMarketBakeMode, bakeWarehouseJson } from '../../scripts/bake-warehouse';
import { LeaseMarketSummaryResponse, PositioningResponse } from '../../src/contracts/lease-market';
import { WAREHOUSE_SUB_ROUTERS } from '../../server/warehouse/sub-routers';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { stubScreen, testConfig, testHeaderMap, writeCostarFixture, type FixtureListing } from './lease-market-fixtures';

// inProcessResolver builds leaseMarketApi() with no injected getSnapshot, so a bake that plans
// /lease-market/positioning falls back to the live brain singleton. This suite never refreshes it,
// so the real one always answered null (positioning 503s and the bake drops it). The stub returns
// the same null without loading the rest of server/brain's graph: the workbook parser, date-fns
// (304 files) and chokidar. exceljs is already loaded here by the CoStar fixtures. At 100% CPU,
// a cold import of server/brain measured 13-289s, and date-fns alone ~30s.
vi.mock('../../server/brain', () => ({
  brain: { getSnapshot: vi.fn(() => null) },
}));
import { brain } from '../../server/brain';

const openDbs: WarehouseDb[] = [];
const openDirs: string[] = [];
afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of openDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** As-shipped config: mirrorRowLevel:true (ratified for the private Access-gated mirror). */
async function seededRatified(): Promise<WarehouseDb> {
  const dir = mkdtempSync(join(tmpdir(), 'lm-bake-'));
  openDirs.push(dir);
  const db = openWarehouse(join(dir, 't.sqlite'));
  openDbs.push(db);
  const config = testConfig({ mirrorRowLevel: true });
  const rows: FixtureListing[] = [{ id: 'C1', address: '900 Confidential Way', sf: 20000, rentLow: 8, owner: 'SECRET OWNER LLC', broker: 'Secret Broker' }];
  await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-15.xlsx', rows), {
    config, headerMap: testHeaderMap(), rawDir: join(dir, 'raw'), now: () => '2026-02-16T00:00:00Z', screen: stubScreen,
  });
  runCompute(db, config, '2026-03-01');
  return db;
}

describe('bake-warehouse — lease-market redacted-bake confidentiality boundary', () => {
  it('inProcessResolver with no override reads the shipped config (mirrorRowLevel:true) — baseline, unchanged behavior', async () => {
    const db = await seededRatified();
    const resolve = inProcessResolver(db);
    const res = await resolve('/lease-market/summary');
    expect(res.status).toBe(200);
    const body = LeaseMarketSummaryResponse.parse(res.json);
    expect(body.rowLevel).toBe(true);
    expect(body.curve.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).toContain('900 Confidential Way');
  });

  it('inProcessResolver({ leaseMarketRowLevel: false }) redacts lease-market payloads regardless of config.mirrorRowLevel', async () => {
    const db = await seededRatified();
    const resolve = inProcessResolver(db, { leaseMarketRowLevel: false });
    const res = await resolve('/lease-market/summary');
    expect(res.status).toBe(200);
    const body = LeaseMarketSummaryResponse.parse(res.json);
    expect(body.rowLevel).toBe(false);
    expect(body.curve.length).toBeGreaterThan(0);
    expect(JSON.stringify(body)).not.toContain('900 Confidential Way');
    expect(JSON.stringify(body)).not.toContain('SECRET OWNER LLC');
  });

  it('buildWarehouseEnvelope omits every /lease-market/* endpoint when includeLeaseMarket is false ' +
    '(applies uniformly regardless of resolver — bakeWarehouseJson now derives this flag from ' +
    'includeConfidential and wires it to BOTH the checkpoint-read/in-process path and the ' +
    'httpResolver/live-server path; see the bakeWarehouseJson orchestrator tests below for the ' +
    'fix round 3 regression this guards)', async () => {
    const db = await seededRatified();
    const resolver = inProcessResolver(db);
    const env = await buildWarehouseEnvelope(resolver, { now: Date.parse('2026-03-02T00:00:00.000Z'), warehouseSource: 'live-server', includeLeaseMarket: false });
    const leaseMarketKeys = Object.keys(env.endpoints).filter((k) => k.startsWith('/api/warehouse/lease-market/'));
    expect(leaseMarketKeys).toEqual([]);
  });

  it('buildWarehouseEnvelope includes /lease-market/* endpoints by default (includeLeaseMarket omitted) — unchanged from Task 14', async () => {
    const db = await seededRatified();
    vi.mocked(brain.getSnapshot).mockClear();
    const resolver = inProcessResolver(db);
    const env = await buildWarehouseEnvelope(resolver, { now: Date.parse('2026-03-02T00:00:00.000Z'), warehouseSource: 'checkpoint-read' });
    expect(env.endpoints['/api/warehouse/lease-market/summary']).toBeDefined();
    // Guards that /lease-market/positioning's liveSnapshot() resolves to the stub above; if it
    // didn't, the real server/brain import (and its load-time cost) would silently come back.
    expect(brain.getSnapshot).toHaveBeenCalled();
  });
});

// /lease-market/positioning through the bake's OWN resolver. lease-market-api.test.ts covers
// positioning redaction at the router level, but could not drive it through inProcessResolver: that
// resolver injects no getSnapshot, so positioning 503'd and its redaction leg was never exercised on
// the bake path. The server/brain stub above is that seam — it hands positioning a snapshot with a
// vacant unit at a property the SHIPPED config maps (inProcessResolver reads config/lease-market.json).
describe('bake-warehouse — /lease-market/positioning redaction via inProcessResolver', () => {
  const SECRETS = ['Confidential Way', 'SECRET OWNER LLC', 'Secret Broker'];
  const RENTS = [8.6, 8.8, 9.0, 9.2, 9.4, 9.6, 9.8, 10.0, 10.2, 10.4, 10.6, 10.8];
  const ORA_KEY = '1100 Rarig'; // any shipped oraProperties key works; the fixture derives the rest from it

  /** seededRatified()'s single listing never reaches positioning's confidence floor, and
   *  inProcessResolver reads the shipped config with no override seam, so this fixture is ingested
   *  and computed under that SAME shipped config: a comp set in ORA_KEY's configured market,
   *  submarket and subtype, sized like its typical unit. If that config changes enough to empty the
   *  comp set, the positive control below fails; it does not pass vacuously. */
  async function seededForShippedPositioning(): Promise<WarehouseDb> {
    const dir = mkdtempSync(join(tmpdir(), 'lm-bake-pos-'));
    openDirs.push(dir);
    const db = openWarehouse(join(dir, 't.sqlite'));
    openDbs.push(db);
    const shipped = loadLeaseMarketConfig();
    const ora = shipped.oraProperties.find((p) => p.propertyKey === ORA_KEY)!;
    const market = shipped.markets.find((m) => m.id === ora.marketId)!.costarMarketNames[0]!;
    const rows: FixtureListing[] = RENTS.map((rent, i) => ({
      id: `P${i}`, address: `${900 + i} Confidential Way`, market, submarket: ora.submarket,
      type: ora.subtype === 'flex' ? 'Flex' : 'Industrial', // testHeaderMap's subtypeMap
      sf: ora.typicalUnitSf, rba: 20000, rentLow: rent, owner: 'SECRET OWNER LLC', broker: 'Secret Broker',
    }));
    const fixture = await writeCostarFixture(dir, `costar-listings_${ora.marketId}_2026-02-15.xlsx`, rows);
    const ingest = await ingestCostarListingsFile(db, fixture, {
      config: shipped, headerMap: testHeaderMap(), rawDir: join(dir, 'raw'), now: () => '2026-02-16T00:00:00Z', screen: stubScreen,
    });
    expect(ingest.status).toBe('ingested'); // config drift fails here, at the root cause
    runCompute(db, shipped, '2026-03-01');
    return db;
  }
  const snapshotWithVacancy = (sf: number) => ({
    leases: [{
      id: 'V1', propertyKey: ORA_KEY, propertyId: null, tenantName: 'VACANT', unit: 'B', company: null, sf,
      monthlyRent: 0, rentPerSf: null, leaseStart: null, leaseEnd: null, escalationDate: null, escalationPct: null,
      status: 'Vacant', annualRent: 0, monthsToExpiry: null, flags: [],
    }],
  });

  afterEach(() => {
    vi.mocked(brain.getSnapshot).mockReset(); // back to the file-level () => null
  });

  async function positioningVia(opts: { leaseMarketRowLevel?: boolean }) {
    const db = await seededForShippedPositioning();
    const unitSf = loadLeaseMarketConfig().oraProperties.find((p) => p.propertyKey === ORA_KEY)!.typicalUnitSf;
    // Partial snapshot: positioning reads only leases[].status/propertyKey/unit/sf.
    vi.mocked(brain.getSnapshot).mockReturnValue(snapshotWithVacancy(unitSf) as unknown as PortfolioSnapshot);
    const res = await inProcessResolver(db, opts)('/lease-market/positioning');
    expect(res.status).toBe(200);
    return PositioningResponse.parse(res.json);
  }

  it('no override (shipped mirrorRowLevel:true): comps carry the fixture address (proves the redaction check below is not vacuous)', async () => {
    const body = await positioningVia({});
    expect(body.rows.length).toBeGreaterThan(0);
    const comps = body.rows.flatMap((r) => r.comps);
    expect(comps.length).toBeGreaterThan(0);
    // The address fields (comps, hygieneFlags, listedButLeased) are positioning's only row-level
    // identifiers; this fixture populates comps.
    expect(comps.every((c) => c.address?.includes('Confidential Way'))).toBe(true);
  });

  it('leaseMarketRowLevel: false: same comps, every address nulled, no fixture identifier anywhere in the payload', async () => {
    const body = await positioningVia({ leaseMarketRowLevel: false });
    const comps = body.rows.flatMap((r) => r.comps);
    expect(comps.length).toBeGreaterThan(0);
    expect(comps.every((c) => c.address === null)).toBe(true);
    expect(body.hygieneFlags.every((h) => h.address === null)).toBe(true);
    const blob = JSON.stringify(body);
    for (const secret of SECRETS) expect(blob, `expected redacted positioning to NOT contain "${secret}"`).not.toContain(secret);
  });
});

// Fix round 2, item 1(a): the includeConfidential -> { leaseMarketRowLevel, includeLeaseMarket }
// mapping extracted out of bakeWarehouseJson into a small pure function, tested directly without a
// DB, HTTP server, or filesystem write.
//
// Fix round 3 (whole-branch review, Finding 1 — confidentiality asymmetry, 2026-09-17): the two
// `.toEqual` values below were already correct — this function's mapping was never the bug. The
// bug was in bakeWarehouseJson, which only wired `includeLeaseMarket` to the httpResolver
// (live-server) branch and left the checkpoint-read (in-process, server-down) branch on its `true`
// initializer regardless of what this function returned. So the previous descriptions below — "…
// routes excluded on the http path" / "… routes included on the http path" — encoded that
// asymmetry as if it were intended. It was not: `includeLeaseMarket` now gates the endpoint PLAN on
// BOTH resolver paths uniformly (see the bakeWarehouseJson orchestrator tests further down for the
// regression this closes); only `leaseMarketRowLevel` remains in-process-only, as defence in depth.
describe('leaseMarketBakeMode (fix round 2, item 1a; descriptions corrected fix round 3)', () => {
  it('redacted (includeConfidential=false): rowLevel forced false (in-process defence-in-depth); routes excluded from the plan on BOTH paths', () => {
    expect(leaseMarketBakeMode(false)).toEqual({ leaseMarketRowLevel: false, includeLeaseMarket: false });
  });

  it('private (includeConfidential=true): rowLevel override undefined (falls through to config, in-process path); routes included in the plan on BOTH paths', () => {
    expect(leaseMarketBakeMode(true)).toEqual({ leaseMarketRowLevel: undefined, includeLeaseMarket: true });
  });
});

// Fix round 3 (whole-branch review, Finding 1 — confidentiality, 2026-09-17): exercises the real
// bakeWarehouseJson ORCHESTRATOR — not just buildWarehouseEnvelope — on the checkpoint-read path
// (brain server down), because the bug lived in the wiring between the two: `includeLeaseMarket`
// was initialised `true` and only reassigned inside the `brainServerUp()` branch, so with
// MIRROR_INCLUDE_CONFIDENTIAL unset (the default, redacted mode) the checkpoint-read path — the
// unattended scheduled-bake case — always PLANNED every `/lease-market/*` route regardless of
// includeConfidential. Per-listing data was still row-level-redacted (leaseMarketRowLevel:false),
// but the five endpoints themselves landed in public/warehouse.json — a non-Access-gated artifact.
//
// Deliberately does NOT chdir to an isolated cwd: the lease-market sub-router loads
// config/lease-market.json relative to process.cwd() (server/warehouse/lease-market/config.ts's
// defaultConfigPath()) with no override plumbed through inProcessResolver, so moving cwd would
// make that load ENOENT and every /lease-market/* route non-200 regardless of this fix — a false
// green that would not actually exercise the redaction/omission logic. Runs from the repo root
// (where the shipped config/lease-market.json — mirrorRowLevel:true — already matches this fixture's
// `testConfig({ mirrorRowLevel: true })`, the same pairing tests/unit/lease-market-api-bake.test.ts's
// own `seededRatified()` helper relies on above) with only WAREHOUSE_DB pointed at a temp fixture DB
// and BRAIN_BAKE_SOURCE_URL pointed at an unreachable port to deterministically force the
// checkpoint-read branch — the one the bug lived in. public/warehouse.json is gitignored and
// git-status-invisible; its pre-test state (absent, in this worktree) is captured and restored.
describe('bakeWarehouseJson — checkpoint-read path respects includeConfidential (fix round 3)', () => {
  const ORIGINAL_WAREHOUSE_DB = process.env.WAREHOUSE_DB;
  const ORIGINAL_BAKE_SOURCE_URL = process.env.BRAIN_BAKE_SOURCE_URL;
  const warehouseJsonPath = join(process.cwd(), 'public', 'warehouse.json');
  const hadWarehouseJson = existsSync(warehouseJsonPath);
  const originalWarehouseJson = hadWarehouseJson ? readFileSync(warehouseJsonPath, 'utf8') : null;

  afterEach(() => {
    if (ORIGINAL_WAREHOUSE_DB === undefined) delete process.env.WAREHOUSE_DB;
    else process.env.WAREHOUSE_DB = ORIGINAL_WAREHOUSE_DB;
    if (ORIGINAL_BAKE_SOURCE_URL === undefined) delete process.env.BRAIN_BAKE_SOURCE_URL;
    else process.env.BRAIN_BAKE_SOURCE_URL = ORIGINAL_BAKE_SOURCE_URL;
    // Restore whatever was (or wasn't) at public/warehouse.json before this describe block ran.
    if (hadWarehouseJson) writeFileSync(warehouseJsonPath, originalWarehouseJson!);
    else rmSync(warehouseJsonPath, { force: true });
  });

  async function bakeAgainstFixtureDb(includeConfidential: boolean | undefined): Promise<Record<string, unknown>> {
    const dbDir = mkdtempSync(join(tmpdir(), 'lm-bake-orch-db-'));
    openDirs.push(dbDir);
    const dbPath = join(dbDir, 't.sqlite');
    const db = openWarehouse(dbPath);
    const config = testConfig({ mirrorRowLevel: true }); // as-shipped: ratified true for the private mirror
    const rows: FixtureListing[] = [{
      id: 'ORCH1', address: '77 Orchestrator Confidential Ln', sf: 22000, rentLow: 11,
      owner: 'ORCH SECRET OWNER LLC', broker: 'Orchestrator Secret Broker',
    }];
    await ingestCostarListingsFile(db, await writeCostarFixture(dbDir, 'costar-listings_columbus_2026-02-15.xlsx', rows), {
      config, headerMap: testHeaderMap(), rawDir: join(dbDir, 'raw'), now: () => '2026-02-16T00:00:00Z', screen: stubScreen,
    });
    runCompute(db, config, '2026-03-01');
    db.close(); // bakeWarehouseJson opens its OWN handle on this path (the checkpoint-read branch)

    process.env.WAREHOUSE_DB = dbPath;
    // Reserved/typically-closed port: fetch fails fast (well under brainServerUp's 1500ms abort),
    // deterministically forcing the checkpoint-read branch — the one the bug lived in.
    process.env.BRAIN_BAKE_SOURCE_URL = 'http://127.0.0.1:1';

    const result = await bakeWarehouseJson({ now: Date.parse('2026-03-02T00:00:00.000Z'), includeConfidential });
    expect(result.warehouseSource).toBe('checkpoint-read');
    const written = JSON.parse(readFileSync(result.path, 'utf8')) as { endpoints: Record<string, unknown> };
    return written.endpoints;
  }

  it('redacted mode (includeConfidential omitted): the checkpoint-read path omits every /lease-market/* key, and no fixture address/owner/broker survives a whole-blob scan', async () => {
    const endpoints = await bakeAgainstFixtureDb(undefined);
    const leaseMarketKeys = Object.keys(endpoints).filter((k) => k.startsWith('/api/warehouse/lease-market/'));
    expect(leaseMarketKeys).toEqual([]);
    const blob = JSON.stringify(endpoints);
    expect(blob).not.toContain('77 Orchestrator Confidential Ln');
    expect(blob).not.toContain('ORCH SECRET OWNER LLC');
    expect(blob).not.toContain('Orchestrator Secret Broker');
  });

  it('redacted mode (includeConfidential: false, explicit): same omission as the default', async () => {
    const endpoints = await bakeAgainstFixtureDb(false);
    const leaseMarketKeys = Object.keys(endpoints).filter((k) => k.startsWith('/api/warehouse/lease-market/'));
    expect(leaseMarketKeys).toEqual([]);
  });

  it('confidential mode (includeConfidential: true): the checkpoint-read path includes /lease-market/* keys', async () => {
    const endpoints = await bakeAgainstFixtureDb(true);
    expect(endpoints['/api/warehouse/lease-market/summary']).toBeDefined();
    expect(JSON.stringify(endpoints)).toContain('77 Orchestrator Confidential Ln');
  });
});

// Fix round 2, item 3: bake-warehouse.ts's inProcessResolver hardcodes the string literal
// '/lease-market' to special-case this one prefix for bake-scoped redaction (see its doc comment's
// CROSS-REFERENCE note). This regression-guards the other half of that coupling: the prefix must
// still exist in WAREHOUSE_SUB_ROUTERS (server/warehouse/sub-routers.ts), the single source of truth
// both server/index.ts and this resolver mount from — if it's ever renamed there without updating the
// literal, the special case silently stops firing (see the CROSS-REFERENCE comment for the failure
// mode: the shared factory() branch would take over with no rowLevel override).
describe('bake-warehouse — /lease-market special-case prefix stays registered (fix round 2, item 3)', () => {
  it('WAREHOUSE_SUB_ROUTERS still has a "/lease-market" prefix entry', () => {
    expect(WAREHOUSE_SUB_ROUTERS.some((r) => r.prefix === '/lease-market')).toBe(true);
  });
});
