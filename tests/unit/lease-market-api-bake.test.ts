// tests/unit/lease-market-api-bake.test.ts
//
// Fix round 1, item 1 — bake-scoped redaction. Gabriel ratified listing-level data on the PRIVATE,
// Access-gated mirror, so config/lease-market.json keeps mirrorRowLevel:true as shipped. The
// public-safe/redacted bake mode must never carry CoStar row-level identifiers into
// public/warehouse.json regardless of that config value — this is the confidentiality boundary the
// Fat-Mirror bake (scripts/bake-warehouse.ts) must enforce independent of the router's own config.
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse, type WarehouseDb } from '../../server/warehouse/db';
import { ingestCostarListingsFile } from '../../server/warehouse/lease-market/ingest';
import { runCompute } from '../../server/warehouse/lease-market/compute';
import { inProcessResolver, buildWarehouseEnvelope, leaseMarketBakeMode } from '../../scripts/bake-warehouse';
import { LeaseMarketSummaryResponse } from '../../src/contracts/lease-market';
import { WAREHOUSE_SUB_ROUTERS } from '../../server/warehouse/sub-routers';
import { stubScreen, testConfig, testHeaderMap, writeCostarFixture, type FixtureListing } from './lease-market-fixtures';

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
    '(the httpResolver/live-server + redacted-bake path, which cannot override an already-mounted ' +
    'router\'s config over HTTP — excluding is the safe fallback)', async () => {
    const db = await seededRatified();
    const resolver = inProcessResolver(db);
    const env = await buildWarehouseEnvelope(resolver, { now: Date.parse('2026-03-02T00:00:00.000Z'), warehouseSource: 'live-server', includeLeaseMarket: false });
    const leaseMarketKeys = Object.keys(env.endpoints).filter((k) => k.startsWith('/api/warehouse/lease-market/'));
    expect(leaseMarketKeys).toEqual([]);
  });

  it('buildWarehouseEnvelope includes /lease-market/* endpoints by default (includeLeaseMarket omitted) — unchanged from Task 14', async () => {
    const db = await seededRatified();
    const resolver = inProcessResolver(db);
    const env = await buildWarehouseEnvelope(resolver, { now: Date.parse('2026-03-02T00:00:00.000Z'), warehouseSource: 'checkpoint-read' });
    expect(env.endpoints['/api/warehouse/lease-market/summary']).toBeDefined();
  });
});

// Fix round 2, item 1(a): the includeConfidential -> { leaseMarketRowLevel, includeLeaseMarket }
// mapping extracted out of bakeWarehouseJson into a small pure function, tested directly without a
// DB, HTTP server, or filesystem write.
describe('leaseMarketBakeMode (fix round 2, item 1a)', () => {
  it('redacted (includeConfidential=false): rowLevel forced false on the in-process path; routes excluded on the http path', () => {
    expect(leaseMarketBakeMode(false)).toEqual({ leaseMarketRowLevel: false, includeLeaseMarket: false });
  });

  it('private (includeConfidential=true): rowLevel override undefined (falls through to config) on the in-process path; routes included on the http path', () => {
    expect(leaseMarketBakeMode(true)).toEqual({ leaseMarketRowLevel: undefined, includeLeaseMarket: true });
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
