// tests/unit/lease-market-api.test.ts
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
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

// Fix round 1, item 8: every DB opened and every tmpdir created by a test is tracked here and torn
// down in afterEach — the original version left both open for the whole file's run.
const openDbs: WarehouseDb[] = [];
const openDirs: string[] = [];

async function seeded(config: LeaseMarketConfig = testConfig(), seedOpts: { oraListingUrl?: string | null } = {}): Promise<WarehouseDb> {
  const dir = mkdtempSync(join(tmpdir(), 'lm-api-'));
  openDirs.push(dir);
  const db = openWarehouse(join(dir, 't.sqlite'));
  openDbs.push(db);
  const rows: FixtureListing[] = RENTS.map((rent, i) => ({ id: `C${i}`, address: `${100 + i} Industrial Pkwy`, sf: 20000, rentLow: rent, owner: rent === 5.5 ? 'PROLOGIS FUND LP' : 'SMITH FAMILY LLC' }));
  rows.push({ address: '1100 Rarig Ave', suite: 'B', sf: 8000, rentLow: 12, owner: 'OXFORD RARIG LLC', url: seedOpts.oraListingUrl ?? null });
  await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-15.xlsx', rows), {
    config, headerMap: testHeaderMap(), rawDir: join(dir, 'raw'), now: () => '2026-02-16T00:00:00Z', screen: stubScreen,
  });
  runCompute(db, config, '2026-03-01');
  return db;
}

/** Direct SQL insert of a synthetic lm_signal row — used to exercise API-layer behavior (redaction,
 *  radar evidence guards) independent of whether the compute engine's own gates happen to produce
 *  that exact signal shape under this fixture (that engine behavior has its own dedicated coverage
 *  in lease-market-signals.test.ts / lease-market-radar.test.ts). */
function insertSignal(
  db: WarehouseDb,
  row: {
    propertyId: number; listingId: number | null; kind: string; severity: string; score: number | null;
    confidence: 'HIGH' | 'MEDIUM' | 'LOW' | null; evidence: Record<string, unknown>;
  },
): void {
  db.prepare(
    `INSERT INTO lm_signal (property_id, listing_id, kind, severity, score, confidence, comp_basis, cell_key, computed_at, evidence_json)
     VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, '2026-03-01', ?)`,
  ).run(row.propertyId, row.listingId, row.kind, row.severity, row.score, row.confidence, JSON.stringify(row.evidence));
}

function listingByAddressNorm(db: WarehouseDb, addressNorm: string): { listingId: number; propertyId: number } {
  return db
    .prepare('SELECT l.id AS listingId, l.property_id AS propertyId FROM lm_listing l JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = ?')
    .get(addressNorm) as { listingId: number; propertyId: number };
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
afterEach(() => {
  for (const db of openDbs.splice(0)) {
    try {
      db.close();
    } catch {
      // already closed by the test itself — fine
    }
  }
  for (const dir of openDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function appFor(config = testConfig(), seedOpts: { oraListingUrl?: string | null } = {}) {
  const db = await seeded(config, seedOpts);
  return { db, app: leaseMarketApi(() => db, { loadConfig: () => config, getSnapshot: async () => snapshot, now: () => '2026-03-02T09:00:00Z' }) };
}
const json = async (res: Response) => (await res.json()) as unknown;

describe('lease-market API', () => {
  it('GET /summary: KPIs, freshness, data quality, benchmarks, rent curve, DOM', async () => {
    const { app } = await appFor();
    const res = await app.request('/summary');
    expect(res.status).toBe(200);
    const body = LeaseMarketSummaryResponse.parse(await json(res));
    // newInLatest is 12, not 13 (fixture has 13 rows total): compute.ts (d83cc05) deliberately
    // excludes the ORA-owned space (1100 Rarig Ave Ste B) from the "new" KPI count — an ORA listing
    // appearing in a CoStar export isn't a market "new listing" signal the same way a third-party
    // one is, so it's counted in activeSpaces/curve but not newInLatest.
    expect(body.kpis).toEqual({ marketsFresh: 1, marketsEnabled: 2, activeSpaces: 13, newInLatest: 12, priceCutsInLatest: 0, stale: 0, radarCandidates: 1 });
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

  it('503 without warehouse or snapshot; 500 on bad config', async () => {
    const config = testConfig();
    expect((await leaseMarketApi(() => { throw new Error('no db'); }, { loadConfig: () => config }).request('/summary')).status).toBe(503);
    const db = await seeded(config);
    expect((await leaseMarketApi(() => db, { loadConfig: () => config, getSnapshot: async () => null }).request('/positioning')).status).toBe(503);
    expect((await leaseMarketApi(() => db, { loadConfig: () => { throw new Error('bad'); } }).request('/signals')).status).toBe(500);
  });
});

// Fix round 1, items 3 & 4: the 503/500 bodies must stay generic (never echo e.message), but the
// underlying detail must still be logged server-side with the '[lease-market-api]' prefix so an
// operator can diagnose it from server logs.
describe('lease-market API — error logging vs response body boundary', () => {
  it('503: logs the underlying getDb() error server-side; response body is the generic sentinel only', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const res = await leaseMarketApi(() => {
        throw new Error('pool exhausted: connection-secret-detail-9f2e');
      }, { loadConfig: () => testConfig() }).request('/summary');
      expect(res.status).toBe(503);
      const body = (await json(res)) as { error: string };
      expect(body).toEqual({ error: 'warehouse unavailable' });
      expect(JSON.stringify(body)).not.toContain('connection-secret-detail-9f2e');
      expect(
        errorSpy.mock.calls.some((args) => args.some((a) => String(a).includes('[lease-market-api]')) && args.some((a) => String(a).includes('connection-secret-detail-9f2e'))),
      ).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('500: logs the underlying config error server-side; response body is generic with no e.message', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const config = testConfig();
      const db = await seeded(config);
      const res = await leaseMarketApi(() => db, {
        loadConfig: () => {
          throw new Error('bad-config-detail-xyz-7a1c');
        },
      }).request('/signals');
      expect(res.status).toBe(500);
      const body = (await json(res)) as { error: string };
      expect(body).toEqual({ error: 'invalid lease-market config' });
      expect(JSON.stringify(body)).not.toContain('bad-config-detail-xyz-7a1c');
      expect(
        errorSpy.mock.calls.some((args) => args.some((a) => String(a).includes('[lease-market-api]')) && args.some((a) => String(a).includes('bad-config-detail-xyz-7a1c'))),
      ).toBe(true);
    } finally {
      errorSpy.mockRestore();
    }
  });
});

// Fix round 1, item 1: LeaseMarketApiDeps.rowLevel overrides config.mirrorRowLevel — the mechanism
// the redacted-mode bake uses to force rowLevel=false on the in-process router regardless of the
// shipped config value (which stays mirrorRowLevel:true, ratified for the private Access-gated
// mirror). Proven both directions so it is a real override, not just an AND with config.
describe('lease-market API — LeaseMarketApiDeps.rowLevel override', () => {
  it('forces redaction on when config.mirrorRowLevel is true', async () => {
    const config = testConfig({ mirrorRowLevel: true });
    const db = await seeded(config);
    const app = leaseMarketApi(() => db, { loadConfig: () => config, rowLevel: false });
    const body = LeaseMarketSummaryResponse.parse(await json(await app.request('/summary')));
    expect(body.rowLevel).toBe(false);
    expect(body.curve.length).toBeGreaterThan(0);
    expect(body.curve.every((p) => p.address === null)).toBe(true);
  });

  it('forces redaction off when config.mirrorRowLevel is false', async () => {
    const config = testConfig({ mirrorRowLevel: false });
    const db = await seeded(config);
    const app = leaseMarketApi(() => db, { loadConfig: () => config, rowLevel: true });
    const body = LeaseMarketSummaryResponse.parse(await json(await app.request('/summary')));
    expect(body.rowLevel).toBe(true);
    expect(body.curve.length).toBeGreaterThan(0);
    expect(body.curve.some((p) => p.address !== null)).toBe(true);
  });
});

// Fix round 1, item 2: hardened redaction boundary — a fixture that guarantees a non-empty radar
// candidate AND a non-empty withdrawn_after_stale monitor row, both carrying broker names; every one
// of the 6 GET routes (plus /history) is checked for byte-level absence of every fixture secret
// (street addresses, owner names, broker names, listing URLs) when mirrorRowLevel=false, with a
// same-fixture rowLevel=true run proving those secrets are genuinely present in the payload (so the
// redacted-mode assertion isn't vacuously true).
describe('lease-market API — redaction boundary hardening (mirrorRowLevel=false)', () => {
  const ORA_URL = 'https://costar.example.test/listing/rarig-b';
  const SECRETS = ['101 Industrial Pkwy', '1100 Rarig Ave', 'SMITH FAMILY LLC', 'Pat Broker', ORA_URL, '102 Industrial Pkwy'];

  async function runFor(rowLevel: boolean) {
    const config = testConfig({ mirrorRowLevel: rowLevel });
    const db = await seeded(config, { oraListingUrl: ORA_URL });
    const app = leaseMarketApi(() => db, { loadConfig: () => config, getSnapshot: async () => snapshot, now: () => '2026-03-02T09:00:00Z' });
    // Synthetic withdrawn_after_stale monitor row (see insertSignal's doc comment) so /radar's
    // `monitor` array and /history's confidentiality boundary both have live, non-empty coverage.
    const { listingId, propertyId } = listingByAddressNorm(db, '102 INDUSTRIAL PKWY');
    insertSignal(db, {
      propertyId, listingId, kind: 'withdrawn_after_stale', severity: 'info', score: null, confidence: null,
      evidence: { address: '102 Industrial Pkwy', removedAt: '2026-02-20', domAtRemoval: 220, staleThresholdDays: 180, lastAskingNnnEq: 6.5, availableSf: 20000, outcome: 'unknown' },
    });

    const summary = LeaseMarketSummaryResponse.parse(await json(await app.request('/summary')));
    const positioning = PositioningResponse.parse(await json(await app.request('/positioning')));
    const radar = RadarResponse.parse(await json(await app.request('/radar')));
    const signals = SignalsResponse.parse(await json(await app.request('/signals')));
    const changes = ChangesResponse.parse(await json(await app.request('/changes')));
    const listingRow = db.prepare("SELECT l.id FROM lm_listing l JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = '101 INDUSTRIAL PKWY'").get() as { id: number };
    const history = HistoryResponse.parse(await json(await app.request(`/history/${listingRow.id}`)));
    return { summary, positioning, radar, signals, changes, history };
  }

  it('rowLevel=true baseline actually carries every secret (proves the assertions below are not vacuous)', async () => {
    const { summary, positioning, radar, signals, changes, history } = await runFor(true);
    expect(radar.candidates.length).toBeGreaterThan(0);
    expect(radar.monitor.length).toBeGreaterThan(0);
    expect(signals.signals.length).toBeGreaterThan(0);
    expect(changes.events.length).toBeGreaterThan(0);
    expect(summary.curve.length).toBeGreaterThan(0);

    const blob = JSON.stringify({ summary, positioning, radar, signals, changes, history });
    for (const secret of SECRETS) expect(blob, `expected true-mode payload to contain "${secret}"`).toContain(secret);

    expect(radar.candidates[0]!.ownerName).not.toBeNull();
    expect(radar.candidates[0]!.brokerName).not.toBeNull();
    expect(history.address).not.toBeNull();
  });

  it('rowLevel=false strips every secret from all 6 GET routes, including /history and radar ownerName/brokerName', async () => {
    const { summary, positioning, radar, signals, changes, history } = await runFor(false);
    expect(summary.rowLevel).toBe(false);
    // Non-empty on the SAME fixture as the true-mode run above — redaction is being exercised, not
    // vacuously satisfied by an empty array.
    expect(radar.candidates.length).toBeGreaterThan(0);
    expect(radar.monitor.length).toBeGreaterThan(0);
    expect(signals.signals.length).toBeGreaterThan(0);
    expect(changes.events.length).toBeGreaterThan(0);
    expect(summary.curve.length).toBeGreaterThan(0);

    const blob = JSON.stringify({ summary, positioning, radar, signals, changes, history });
    for (const secret of SECRETS) expect(blob, `expected redacted payload to NOT contain "${secret}"`).not.toContain(secret);

    expect(history.address).toBeNull();
    expect(radar.candidates.every((r) => r.address === null && r.ownerName === null && r.brokerName === null)).toBe(true);
    expect(radar.monitor.every((s) => s.address === null && !('address' in s.evidence))).toBe(true);
    expect(signals.signals.every((s) => s.address === null && !('address' in s.evidence) && !('ownerName' in s.evidence) && !('brokerName' in s.evidence))).toBe(true);
    expect(changes.events.every((e) => e.address === null)).toBe(true);
    expect(positioning.rows.every((r) => r.listingUrl === null)).toBe(true);
  });
});

// Fix round 1, item 5: a radar_candidate signal missing a finite score, a valid confidence label, or
// any of the 6 part_* score components is SKIPPED (with a console.warn) rather than silently
// defaulted to 0/LOW — a defaulted 0/LOW candidate would misrepresent an incomplete/corrupt compute
// row as a real, low-scoring lead.
describe('lease-market API — radar evidence guards', () => {
  it('skips malformed radar_candidate rows and logs a warning; the well-formed pre-existing candidate is unaffected', async () => {
    const { app, db } = await appFor();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const validParts = { part_dom: 10, part_reductions: 0, part_belowMarket: 20, part_vacancy: 10, part_buyBoxFit: 10, part_owner: 5 };
      const p103 = listingByAddressNorm(db, '103 INDUSTRIAL PKWY').propertyId;
      const p104 = listingByAddressNorm(db, '104 INDUSTRIAL PKWY').propertyId;
      const p105 = listingByAddressNorm(db, '105 INDUSTRIAL PKWY').propertyId;

      // Non-finite (null) score.
      insertSignal(db, { propertyId: p103, listingId: null, kind: 'radar_candidate', severity: 'watch', score: null, confidence: 'MEDIUM', evidence: { subtype: 'warehouse', buildingSf: 20000, ...validParts } });
      // Missing (null) confidence.
      insertSignal(db, { propertyId: p104, listingId: null, kind: 'radar_candidate', severity: 'watch', score: 60, confidence: null, evidence: { subtype: 'warehouse', buildingSf: 20000, ...validParts } });
      // Missing part_owner.
      insertSignal(db, { propertyId: p105, listingId: null, kind: 'radar_candidate', severity: 'watch', score: 60, confidence: 'MEDIUM', evidence: { subtype: 'warehouse', buildingSf: 20000, part_dom: 10, part_reductions: 0, part_belowMarket: 20, part_vacancy: 10, part_buyBoxFit: 10 } });

      const radar = RadarResponse.parse(await json(await app.request('/radar')));
      const candidatePropertyIds = radar.candidates.map((c) => c.propertyId);
      expect(candidatePropertyIds).not.toContain(p103);
      expect(candidatePropertyIds).not.toContain(p104);
      expect(candidatePropertyIds).not.toContain(p105);
      // Only the pre-existing, well-formed 101 Industrial Pkwy candidate survives.
      expect(radar.candidates).toHaveLength(1);
      expect(radar.candidates[0]!.address).toBe('101 Industrial Pkwy');

      expect(warnSpy.mock.calls.length).toBeGreaterThanOrEqual(3);
      expect(warnSpy.mock.calls.every((args) => args.some((a) => String(a).includes('[lease-market-api]')))).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });
});
