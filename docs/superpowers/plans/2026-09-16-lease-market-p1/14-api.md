### Task 14: API sub-router + registration + mirror bake + refute path list

**Files:**
- Create: `server/warehouse/lease-market-api.ts`
- Modify: `server/warehouse/sub-routers.ts`, `scripts/bake-warehouse.ts`, `scripts/check-refute-required.ts`
- Test: `tests/unit/lease-market-api.test.ts`

**Interfaces:**
- Consumes: Task 02 schemas; Task 04 `toCellBenchmark`; Task 09 `loadLeaseMarketConfig`, `ingestCostarListingsFile` (tests); Task 10 `loadMarketState`, `isActive`, `comparablesForSpace`, `marketFreshness`, `marketDataQuality`, `domBins`, `leaseMarketKpis`, `latestExportEvents`, `withheldCandidateMarkets`, `runCompute` (tests); Task 11 `computePositioning`; `referenceDate()`; `PortfolioSnapshot`.
- Produces: `interface LeaseMarketApiDeps { loadConfig?: () => LeaseMarketConfig; getSnapshot?: () => Promise<PortfolioSnapshot | null>; now?: () => string }` and `leaseMarketApi(getDb, deps?): Hono` mounted at `/api/warehouse/lease-market`:
  - `GET /summary` → `LeaseMarketSummaryResponse`
  - `GET /positioning` → `PositioningResponse` (503 without snapshot)
  - `GET /radar` → `RadarResponse` (candidates from `lm_signal` radar rows, ranked by score desc then property id; latest decision per property; `monitor` = `withdrawn_after_stale` signals)
  - `GET /signals` → `SignalsResponse` (non-radar signals, severity high ▸ watch ▸ info, then kind, then id)
  - `GET /changes` → `ChangesResponse` (`latestExportEvents`)
  - `GET /history/:listingId` → `HistoryResponse` (404 unknown id) — live server only, not baked
  - `POST /radar/decision` body `RadarDecisionInput` → inserts `lm_radar_decision(property_id, decided_at = now(), decision, note)` → `RadarDecisionResponse`; 400 on invalid body; 404 when the property id does not exist

Error policy: 503 `{error:'warehouse unavailable'}` when `getDb()` throws; 500 on invalid config or unexpected errors (logged with `[lease-market-api]`). **Redaction** when `config.mirrorRowLevel === false`: `address`, `ownerName`, `brokerName`, `listingUrl` → null everywhere (curve points, signals + evidence keys `address`/`ownerName`/`brokerName` removed, radar candidates, changes, positioning via `computePositioning(..., rowLevel=false)`, history address).

- [ ] **Step 1: Write the failing test**

```ts
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
```

- [ ] **Step 2:** `npx vitest run tests/unit/lease-market-api.test.ts` — Expected: FAIL.

- [ ] **Step 3: Write the router**

```ts
// server/warehouse/lease-market-api.ts
//
// Lease Market Intelligence — Hono sub-router mounted at /api/warehouse/lease-market (sub-routers.ts).
// Routes: GET /summary · /positioning · /radar · /signals · /changes · /history/:listingId · POST /radar/decision.
// Pure route plumbing (math in src/analytics/lease-market/* and server/warehouse/lease-market/*); listed in
// DELIVERY_ONLY_PATHS. CoStar-derived rows are internal-only; config.mirrorRowLevel=false redacts identifiers.
import { Hono } from 'hono';
import type { WarehouseDb } from './db';
import { referenceDate } from '../config';
import {
  ChangesResponse, HistoryResponse, LeaseMarketSummaryResponse, PositioningResponse, RadarDecisionInput, RadarDecisionResponse,
  RadarResponse, SignalsResponse,
  type CellBenchmark, type CurvePoint, type EvidenceValue, type LeaseMarketConfig, type ListingEventKind, type RadarCandidate,
  type RadarDecisionKind, type SignalRow,
} from '../../src/contracts/lease-market';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { toCellBenchmark } from '../../src/analytics/lease-market/benchmarks';
import { loadLeaseMarketConfig } from './lease-market/config';
import {
  domBins, isActive, latestExportEvents, leaseMarketKpis, loadMarketState, marketDataQuality, marketFreshness, withheldCandidateMarkets,
} from './lease-market/compute';
import { computePositioning } from './lease-market/positioning';

export interface LeaseMarketApiDeps {
  loadConfig?: () => LeaseMarketConfig;
  getSnapshot?: () => Promise<PortfolioSnapshot | null>;
  now?: () => string;
}

async function liveSnapshot(): Promise<PortfolioSnapshot | null> {
  const { brain } = await import('../brain'); // dynamic import avoids a load-time cycle (same as lease-forecast-api.ts)
  return brain.getSnapshot();
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

const REDACTED_EVIDENCE_KEYS = ['address', 'ownerName', 'brokerName'] as const;

interface SignalDbRow {
  id: number; property_id: number; listing_id: number | null; kind: SignalRow['kind']; severity: SignalRow['severity']; score: number | null;
  confidence: SignalRow['confidence']; comp_basis: SignalRow['compBasis']; cell_key: string | null; computed_at: string; evidence_json: string;
  market_id: string; address_display: string; suite_norm: string | null;
}

export function leaseMarketApi(getDb: () => WarehouseDb, deps: LeaseMarketApiDeps = {}): Hono {
  const app = new Hono();
  const loadConfig = deps.loadConfig ?? (() => loadLeaseMarketConfig());
  const getSnapshot = deps.getSnapshot ?? liveSnapshot;
  const now = deps.now ?? (() => new Date().toISOString());

  async function guarded(handler: (db: WarehouseDb, config: LeaseMarketConfig) => Response | Promise<Response>): Promise<Response> {
    let db: WarehouseDb;
    try {
      db = getDb();
    } catch {
      return json(503, { error: 'warehouse unavailable' });
    }
    let config: LeaseMarketConfig;
    try {
      config = loadConfig();
    } catch (e) {
      return json(500, { error: `lease-market config invalid: ${e instanceof Error ? e.message : String(e)}` });
    }
    try {
      return await handler(db, config);
    } catch (e) {
      console.error('[lease-market-api]', e instanceof Error ? e.message : String(e));
      return json(500, { error: 'lease market request failed' });
    }
  }

  function readSignals(db: WarehouseDb, where: string): SignalDbRow[] {
    return db
      .prepare(
        `SELECT s.id, s.property_id, s.listing_id, s.kind, s.severity, s.score, s.confidence, s.comp_basis, s.cell_key, s.computed_at, s.evidence_json,
                p.market_id, p.address_display, l.suite_norm
         FROM lm_signal s JOIN lm_property p ON p.id = s.property_id LEFT JOIN lm_listing l ON l.id = s.listing_id
         WHERE ${where}
         ORDER BY CASE s.severity WHEN 'high' THEN 0 WHEN 'watch' THEN 1 ELSE 2 END, s.kind, s.id`,
      )
      .all() as SignalDbRow[];
  }

  function toSignalRow(r: SignalDbRow, rowLevel: boolean): SignalRow {
    const evidence = JSON.parse(r.evidence_json) as Record<string, EvidenceValue>;
    if (!rowLevel) for (const k of REDACTED_EVIDENCE_KEYS) delete evidence[k];
    const address = r.suite_norm ? `${r.address_display} Ste ${r.suite_norm}` : r.address_display;
    return {
      id: r.id, propertyId: r.property_id, listingId: r.listing_id, marketId: r.market_id, address: rowLevel ? address : null, kind: r.kind,
      severity: r.severity, score: r.score, confidence: r.confidence, compBasis: r.comp_basis, cellKey: r.cell_key, computedAt: r.computed_at, evidence,
    };
  }

  app.get('/summary', () =>
    guarded((db, config) => {
      const asOf = referenceDate();
      const state = loadMarketState(db, config, asOf);
      const benchmarks = new Map<string, CellBenchmark>();
      const curve: CurvePoint[] = [];
      for (const s of state.spaces) {
        if (!isActive(s)) continue;
        const latest = s.observations[s.observations.length - 1]!;
        if (!s.isOraOwned && s.sizeBand !== null) {
          const cell = toCellBenchmark(state.cellFor({ marketId: s.marketId, submarket: s.property.submarket, subtype: s.property.subtype, sizeBand: s.sizeBand, officeStratum: s.officeStratum }));
          benchmarks.set(cell.cellKey, cell);
        }
        if (latest.askingNnnEq !== null) {
          curve.push({
            listingId: s.listingId, propertyId: s.propertyId, marketId: s.marketId, subtype: s.property.subtype, availableSf: latest.availableSf,
            askingNnnEq: latest.askingNnnEq, solid: s.latestEligible, isOra: s.isOraOwned, address: config.mirrorRowLevel ? s.addressDisplay : null,
          });
        }
      }
      return json(200, LeaseMarketSummaryResponse.parse({
        asOf,
        rowLevel: config.mirrorRowLevel,
        kpis: leaseMarketKpis(db, config, state, asOf),
        freshness: marketFreshness(db, config, asOf),
        dataQuality: marketDataQuality(db, config, state),
        benchmarks: [...benchmarks.values()].sort((a, b) => a.cellKey.localeCompare(b.cellKey)),
        curve,
        domByMarket: domBins(state, asOf),
      }));
    }),
  );

  app.get('/positioning', () =>
    guarded(async (db, config) => {
      const snapshot = await getSnapshot();
      if (!snapshot) return json(503, { error: 'snapshot unavailable' });
      const asOf = referenceDate();
      const state = loadMarketState(db, config, asOf);
      const units = snapshot.leases.filter((l) => l.status === 'Vacant').map((l) => ({ propertyKey: l.propertyKey, unit: l.unit, sf: l.sf }));
      return json(200, PositioningResponse.parse({ asOf, ...computePositioning(units, config, state, config.mirrorRowLevel) }));
    }),
  );

  app.get('/radar', () =>
    guarded((db, config) => {
      const rowLevel = config.mirrorRowLevel;
      const decisions = new Map<number, { decision: RadarDecisionKind; decidedAt: string; note: string | null }>();
      const decisionRows = db
        .prepare('SELECT property_id, decision, decided_at, note FROM lm_radar_decision ORDER BY decided_at ASC, id ASC')
        .all() as Array<{ property_id: number; decision: RadarDecisionKind; decided_at: string; note: string | null }>;
      for (const d of decisionRows) decisions.set(d.property_id, { decision: d.decision, decidedAt: d.decided_at, note: d.note });

      const num = (v: EvidenceValue | undefined): number | null => (typeof v === 'number' ? v : null);
      const str = (v: EvidenceValue | undefined): string | null => (typeof v === 'string' ? v : null);
      const candidates: RadarCandidate[] = readSignals(db, "s.kind = 'radar_candidate'")
        .map((r) => {
          const e = JSON.parse(r.evidence_json) as Record<string, EvidenceValue>;
          return {
            propertyId: r.property_id,
            marketId: r.market_id,
            address: rowLevel ? r.address_display : null,
            subtype: e.subtype === 'flex' ? 'flex' : 'warehouse',
            buildingSf: num(e.buildingSf),
            score: r.score ?? 0,
            parts: {
              dom: num(e.part_dom) ?? 0, reductions: num(e.part_reductions) ?? 0, belowMarket: num(e.part_belowMarket) ?? 0,
              vacancy: num(e.part_vacancy) ?? 0, buyBoxFit: num(e.part_buyBoxFit) ?? 0, owner: num(e.part_owner) ?? 0,
            },
            confidence: r.confidence ?? 'LOW',
            vacancyShare: num(e.vacancyShare),
            maxEffectiveDom: num(e.maxEffectiveDom) ?? 0,
            reductionCount: num(e.reductionCount) ?? 0,
            cumulativeReductionPct: num(e.cumulativeReductionPct),
            bestGapPct: num(e.bestGapPct),
            comparableMedian: num(e.comparableMedian),
            indicativeRentGapUsd: num(e.indicativeRentGapUsd),
            ownerName: rowLevel ? str(e.ownerName) : null,
            ownerType: (str(e.ownerType) ?? 'unknown') as RadarCandidate['ownerType'],
            ownerListingCount: num(e.ownerListingCount) ?? 0,
            brokerName: rowLevel ? str(e.brokerName) : null,
            latestDecision: decisions.get(r.property_id) ?? null,
          } satisfies RadarCandidate;
        })
        .sort((a, b) => b.score - a.score || a.propertyId - b.propertyId);
      const monitor = readSignals(db, "s.kind = 'withdrawn_after_stale'").map((r) => toSignalRow(r, rowLevel));
      return json(200, RadarResponse.parse({ asOf: referenceDate(), candidatesWithheld: withheldCandidateMarkets(db, config), candidates, monitor }));
    }),
  );

  app.post('/radar/decision', (c) =>
    guarded(async (db) => {
      const parsed = RadarDecisionInput.safeParse(await c.req.json().catch(() => null));
      if (!parsed.success) return json(400, { error: 'invalid radar decision', issues: parsed.error.issues });
      const { propertyId, decision, note } = parsed.data;
      if (!db.prepare('SELECT id FROM lm_property WHERE id = ?').get(propertyId)) return json(404, { error: 'unknown property' });
      const info = db.prepare('INSERT INTO lm_radar_decision (property_id, decided_at, decision, note) VALUES (?, ?, ?, ?)').run(propertyId, now(), decision, note);
      return json(200, RadarDecisionResponse.parse({ ok: true, id: Number(info.lastInsertRowid) }));
    }),
  );

  app.get('/signals', () =>
    guarded((db, config) =>
      json(200, SignalsResponse.parse({
        asOf: referenceDate(),
        candidatesWithheld: withheldCandidateMarkets(db, config),
        signals: readSignals(db, "s.kind <> 'radar_candidate' AND s.kind <> 'withdrawn_after_stale'").map((r) => toSignalRow(r, config.mirrorRowLevel)),
      })),
    ),
  );

  app.get('/changes', () =>
    guarded((db, config) =>
      json(200, ChangesResponse.parse({
        asOf: referenceDate(),
        events: latestExportEvents(db, config).map((e) => (config.mirrorRowLevel ? e : { ...e, address: null })),
      })),
    ),
  );

  app.get('/history/:listingId', (c) =>
    guarded((db, config) => {
      const listingId = Number(c.req.param('listingId'));
      const listing = db
        .prepare('SELECT l.id, l.suite_norm, p.id AS property_id, p.market_id, p.address_display FROM lm_listing l JOIN lm_property p ON p.id = l.property_id WHERE l.id = ?')
        .get(Number.isInteger(listingId) ? listingId : -1) as { id: number; suite_norm: string; property_id: number; market_id: string; address_display: string } | undefined;
      if (!listing) return json(404, { error: 'unknown listing' });
      const address = config.mirrorRowLevel ? (listing.suite_norm ? `${listing.address_display} Ste ${listing.suite_norm}` : listing.address_display) : null;
      const observations = (db
        .prepare('SELECT observed_at, available_sf, asking_nnn_eq, rent_basis, confidence, costar_dom FROM lm_observation WHERE listing_id = ? ORDER BY observed_at, id')
        .all(listing.id) as Array<{ observed_at: string; available_sf: number; asking_nnn_eq: number | null; rent_basis: HistoryResponse['observations'][number]['rentBasis']; confidence: 'high' | 'low'; costar_dom: number | null }>)
        .map((o) => ({ observedAt: o.observed_at, availableSf: o.available_sf, askingNnnEq: o.asking_nnn_eq, rentBasis: o.rent_basis, confidence: o.confidence, costarDom: o.costar_dom }));
      const events = (db
        .prepare('SELECT id, kind, event_date, prev_value, new_value FROM lm_listing_event WHERE listing_id = ? ORDER BY event_date, id')
        .all(listing.id) as Array<{ id: number; kind: ListingEventKind; event_date: string; prev_value: number | null; new_value: number | null }>)
        .map((e) => ({ id: e.id, listingId: listing.id, propertyId: listing.property_id, marketId: listing.market_id, address, kind: e.kind, eventDate: e.event_date, prevValue: e.prev_value, newValue: e.new_value }));
      return json(200, HistoryResponse.parse({ listingId: listing.id, address, observations, events }));
    }),
  );

  return app;
}
```

- [ ] **Step 4: Register, bake, classify**

1. `server/warehouse/sub-routers.ts`: import `leaseMarketApi` and add `{ prefix: '/lease-market', factory: leaseMarketApi },` directly after `/leasing`.
2. `scripts/bake-warehouse.ts`: append `'/lease-market/summary', '/lease-market/positioning', '/lease-market/radar', '/lease-market/signals', '/lease-market/changes'` to `FIXED_ROUTES`; make them optional:
   ```ts
   // Lease-market routes are optional: no CoStar export yet, or no snapshot in the bake process, must not block the mirror.
   const REQUIRED_ROUTES = new Set<string>(FIXED_ROUTES.filter((r) => r !== '/brain/report' && !r.startsWith('/lease-market/')));
   ```
3. `scripts/check-refute-required.ts` `DELIVERY_ONLY_PATHS`: add, in the file's comment style, `'server/warehouse/lease-market-api.ts'` (pure route plumbing; math stays refute-required via prefixes).
4. `grep -rn "FIXED_ROUTES\|REQUIRED_ROUTES\|DELIVERY_ONLY_PATHS\|WAREHOUSE_SUB_ROUTERS" tests/unit` — update any exact-list assertion.
5. Run `npm run check:schema-drift`. The POST route writes `property_id, decided_at, decision, note` from `propertyId, decision, note` + a server timestamp. If the drift checker flags the camelCase→snake_case mapping or the server-supplied `decided_at`, follow how an existing POST (e.g. `tax-api.ts` `/appeals`) satisfies it — do not weaken the checker.

- [ ] **Step 5:** `npx vitest run tests/unit/lease-market-api.test.ts tests/unit/check-refute-required.test.ts && npm run governance && npm run check:schema-drift && npm run typecheck && npm run lint` and `npx vitest run $(grep -rln "bake-warehouse" tests/unit)` — Expected: PASS / clean.

- [ ] **Step 6: Commit** — `git add server/warehouse/lease-market-api.ts server/warehouse/sub-routers.ts scripts/bake-warehouse.ts scripts/check-refute-required.ts tests/unit/lease-market-api.test.ts <updated existing tests>` ("feat(api): lease-market summary, positioning, radar, signals, changes, history, decisions").
