// tests/unit/lease-market-api.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse, type WarehouseDb } from '../../server/warehouse/db';
import { ingestCostarListingsFile } from '../../server/warehouse/lease-market/ingest';
import { runCompute } from '../../server/warehouse/lease-market/compute';
import { leaseMarketApi } from '../../server/warehouse/lease-market-api';
import {
  ChangesResponse, HistoryResponse, LeaseMarketSummaryResponse, PositioningResponse, RadarResponse, SignalsResponse, type LeaseMarketConfig,
} from '../../src/contracts/lease-market';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { stubScreen, testConfig, testHeaderMap, writeCostarFixture, type FixtureListing } from './lease-market-fixtures';

const RENTS = [5.5, 6.0, 8.6, 8.8, 9.0, 9.2, 9.4, 9.6, 9.8, 10.0, 10.2, 10.4];

async function seeded(config: LeaseMarketConfig = testConfig()): Promise<WarehouseDb> {
  const dir = mkdtempSync(join(tmpdir(), 'lm-api-'));
  const db = openWarehouse(join(dir, 't.sqlite'));
  const rows: FixtureListing[] = RENTS.map((rent, i) => ({ id: `C${i}`, address: `${100 + i} Industrial Pkwy`, sf: 20000, rentLow: rent, owner: rent === 5.5 ? 'PROLOGIS FUND LP' : 'SMITH FAMILY LLC' }));
  rows.push({ address: '1100 Rarig Ave', suite: 'B', sf: 8000, rentLow: 12, owner: 'OXFORD RARIG LLC' });
  await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-15.xlsx', rows), {
    config, headerMap: testHeaderMap(), rawDir: join(dir, 'raw'), now: () => '2026-02-16T00:00:00Z', screen: stubScreen,
  });
  runCompute(db, config, '2026-03-01');
  return db;
}

const vacant = (id: string, propertyKey: string, unit: string, sf: number) => ({
  id, propertyKey, propertyId: null, tenantName: 'VACANT', unit, company: null, sf, monthlyRent: 0, rentPerSf: null, leaseStart: null, leaseEnd: null,
  escalationDate: null, escalationPct: null, status: 'Vacant', annualRent: 0, monthsToExpiry: null, flags: [],
});
const snapshot = { leases: [vacant('V1', '1100 Rarig', 'B', 8000), vacant('V2', 'Unmapped Property', '1', 2000)] } as unknown as PortfolioSnapshot;

let prev: string | undefined;
beforeEach(() => {
  prev = process.env.REPORT_DATE;
  process.env.REPORT_DATE = '2026-03-01';
});
afterEach(() => {
  if (prev === undefined) delete process.env.REPORT_DATE;
  else process.env.REPORT_DATE = prev;
});

async function appFor(config = testConfig()) {
  const db = await seeded(config);
  return { db, app: leaseMarketApi(() => db, { loadConfig: () => config, getSnapshot: async () => snapshot, now: () => '2026-03-02T09:00:00Z' }) };
}
const json = async (res: Response) => (await res.json()) as unknown;

describe('lease-market API', () => {
  it('GET /summary: KPIs, freshness, data quality, benchmarks, rent curve, DOM', async () => {
    const { app } = await appFor();
    const res = await app.request('/summary');
    expect(res.status).toBe(200);
    const body = LeaseMarketSummaryResponse.parse(await json(res));
    expect(body.kpis).toEqual({ marketsFresh: 1, marketsEnabled: 2, activeSpaces: 13, newInLatest: 13, priceCutsInLatest: 0, stale: 0, radarCandidates: 1 });
    expect(body.curve).toHaveLength(13);
    expect(body.curve.filter((p) => p.isOra)).toHaveLength(1);
    expect(body.curve.every((p) => p.address !== null)).toBe(true);
    expect(body.benchmarks.length).toBeGreaterThan(0);
    expect(body.dataQuality.find((q) => q.marketId === 'columbus')?.quotedShare).toBe(1);
  });

  it('GET /positioning: rent position, comps, hygiene, unmapped properties', async () => {
    const { app } = await appFor();
    const body = PositioningResponse.parse(await json(await app.request('/positioning')));
    expect(body.unconfiguredPropertyKeys).toEqual(['Unmapped Property']);
    expect(body.rows[0]).toMatchObject({ propertyKey: '1100 Rarig', oraAskingNnnEq: 12, band: 'above', flags: [] });
    expect(body.rows[0]!.stats).toMatchObject({ basis: 'similarity', confidence: 'MEDIUM', n: 12 });
    expect(body.listedButLeased).toEqual([]);
  });

  it('GET /radar ranks candidates and shows the latest decision; POST records decisions', async () => {
    const { app } = await appFor();
    let radar = RadarResponse.parse(await json(await app.request('/radar')));
    expect(radar.candidates).toHaveLength(1);
    const c = radar.candidates[0]!;
    expect(c).toMatchObject({ address: '101 Industrial Pkwy', score: 55, parts: { dom: 0, reductions: 0, belowMarket: 25, vacancy: 15, buyBoxFit: 10, owner: 5 }, ownerType: 'private', ownerListingCount: 11, latestDecision: null });
    expect(c.indicativeRentGapUsd).toBeCloseTo(68000);

    const post = await app.request('/radar/decision', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ propertyId: c.propertyId, decision: 'investigate', note: 'call broker' }) });
    expect(post.status).toBe(200);
    expect(await json(post)).toMatchObject({ ok: true });
    radar = RadarResponse.parse(await json(await app.request('/radar')));
    expect(radar.candidates[0]!.latestDecision).toEqual({ decision: 'investigate', decidedAt: '2026-03-02T09:00:00Z', note: 'call broker' });

    expect((await app.request('/radar/decision', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ propertyId: c.propertyId, decision: 'buy', note: null }) })).status).toBe(400);
    expect((await app.request('/radar/decision', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ propertyId: 99999, decision: 'pass', note: null }) })).status).toBe(404);
  });

  it('GET /signals excludes radar rows and orders by severity', async () => {
    const { app } = await appFor();
    const body = SignalsResponse.parse(await json(await app.request('/signals')));
    expect(body.signals).toHaveLength(14);
    expect(body.signals.some((s) => s.kind === 'radar_candidate')).toBe(false);
    expect(body.signals[0]!.kind).toBe('below_market');
  });

  it('GET /changes and GET /history/:id', async () => {
    const { app, db } = await appFor();
    const changes = ChangesResponse.parse(await json(await app.request('/changes')));
    expect(changes.events).toHaveLength(13);
    const id = (db.prepare("SELECT l.id FROM lm_listing l JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = '101 INDUSTRIAL PKWY'").get() as { id: number }).id;
    const history = HistoryResponse.parse(await json(await app.request(`/history/${id}`)));
    expect(history.observations).toEqual([{ observedAt: '2026-02-15', availableSf: 20000, askingNnnEq: 6, rentBasis: 'NNN', confidence: 'high', costarDom: 31 }]);
    expect(history.events.map((e) => e.kind)).toEqual(['new']);
    expect((await app.request('/history/99999')).status).toBe(404);
  });

  it('redacts row-level identifiers when mirrorRowLevel is false', async () => {
    const { app } = await appFor(testConfig({ mirrorRowLevel: false }));
    const summary = LeaseMarketSummaryResponse.parse(await json(await app.request('/summary')));
    expect(summary.rowLevel).toBe(false);
    expect(summary.curve.every((p) => p.address === null)).toBe(true);
    const signals = SignalsResponse.parse(await json(await app.request('/signals')));
    expect(signals.signals.every((s) => s.address === null && !('address' in s.evidence) && !('ownerName' in s.evidence))).toBe(true);
    const radar = RadarResponse.parse(await json(await app.request('/radar')));
    expect(radar.candidates.every((r) => r.address === null && r.ownerName === null && r.brokerName === null)).toBe(true);
    const changes = ChangesResponse.parse(await json(await app.request('/changes')));
    expect(changes.events.every((e) => e.address === null)).toBe(true);
  });

  it('503 without warehouse or snapshot; 500 on bad config', async () => {
    const config = testConfig();
    expect((await leaseMarketApi(() => { throw new Error('no db'); }, { loadConfig: () => config }).request('/summary')).status).toBe(503);
    const db = await seeded(config);
    expect((await leaseMarketApi(() => db, { loadConfig: () => config, getSnapshot: async () => null }).request('/positioning')).status).toBe(503);
    expect((await leaseMarketApi(() => db, { loadConfig: () => { throw new Error('bad'); } }).request('/signals')).status).toBe(500);
  });
});
