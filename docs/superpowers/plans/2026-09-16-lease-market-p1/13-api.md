### Task 13: API sub-router + registration + mirror bake + refute path list

**Files:**
- Create: `server/warehouse/lease-market-api.ts`
- Modify: `server/warehouse/sub-routers.ts` (one import + one entry)
- Modify: `scripts/bake-warehouse.ts` (`FIXED_ROUTES`, `REQUIRED_ROUTES`)
- Modify: `scripts/check-refute-required.ts` (`DELIVERY_ONLY_PATHS`)
- Test: `tests/unit/lease-market-api.test.ts`

**Interfaces:**
- Consumes: Task 02 response schemas; Task 04 `toCellBenchmark`; Task 05 `effectiveDom`; Task 08 `loadLeaseMarketConfig`, `ingestCostarListingsFile` (tests); Task 09 `loadMarketState`, `cellTargetFor`, `marketFreshness`, `domBins`, `withheldCandidateMarkets`, `runCompute` (tests); Task 10 `computePositioning`; `referenceDate()`; `PortfolioSnapshot` from `src/contracts/index.ts`.
- Produces:
  - `interface LeaseMarketApiDeps { loadConfig?: () => LeaseMarketConfig; getSnapshot?: () => Promise<PortfolioSnapshot | null> }`
  - `leaseMarketApi(getDb: () => WarehouseDb, deps?: LeaseMarketApiDeps): Hono` mounted at `/api/warehouse/lease-market`
  - `GET /summary` → `LeaseMarketSummaryResponse` · `GET /positioning` → `PositioningResponse` · `GET /signals` → `SignalsResponse`

Error policy (mirrors `lease-forecast-api.ts`): 503 `{error:'warehouse unavailable'}` when `getDb()` throws; 503 `{error:'snapshot unavailable'}` on `/positioning` without a snapshot; 500 on invalid config or unexpected errors (logged with the `[lease-market-api]` prefix). `config.mirrorRowLevel === false` ⇒ `address: null` on distribution points and signals, and `address` / `ownerName` removed from signal evidence.

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
import { LeaseMarketSummaryResponse, PositioningResponse, SignalsResponse, type LeaseMarketConfig } from '../../src/contracts/lease-market';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { stubScreen, testConfig, testHeaderMap, writeCostarFixture, type FixtureListing } from './lease-market-fixtures';

const RENTS = [5.5, 6.0, 8.6, 8.8, 9.0, 9.2, 9.4, 9.6, 9.8, 10.0, 10.2, 10.4];

async function seeded(config: LeaseMarketConfig = testConfig()): Promise<WarehouseDb> {
  const dir = mkdtempSync(join(tmpdir(), 'lm-api-'));
  const db = openWarehouse(join(dir, 't.sqlite'));
  const rows: FixtureListing[] = RENTS.map((rent, i) => ({
    id: `C${i}`, address: `${100 + i} Industrial Pkwy`, sf: 20000, rentLow: rent, owner: rent === 5.5 ? 'PROLOGIS FUND LP' : 'SMITH FAMILY LLC',
  }));
  rows.push({ address: '1100 Rarig Ave', suite: 'B', sf: 8000, rentLow: 12, owner: 'OXFORD RARIG LLC' });
  const file = await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-15.xlsx', rows);
  await ingestCostarListingsFile(db, file, { config, headerMap: testHeaderMap(), rawDir: join(dir, 'raw'), now: () => '2026-02-16T00:00:00Z', screen: stubScreen });
  runCompute(db, config, '2026-03-01');
  return db;
}

const snapshot = {
  leases: [
    { id: 'V1', propertyKey: '1100 Rarig', propertyId: null, tenantName: 'VACANT', unit: 'B', company: null, sf: 8000, monthlyRent: 0, rentPerSf: null, leaseStart: null, leaseEnd: null, escalationDate: null, escalationPct: null, status: 'Vacant', annualRent: 0, monthsToExpiry: null, flags: [] },
    { id: 'V2', propertyKey: 'Unmapped Property', propertyId: null, tenantName: 'VACANT', unit: '1', company: null, sf: 2000, monthlyRent: 0, rentPerSf: null, leaseStart: null, leaseEnd: null, escalationDate: null, escalationPct: null, status: 'Vacant', annualRent: 0, monthsToExpiry: null, flags: [] },
  ],
} as unknown as PortfolioSnapshot;

let prevReportDate: string | undefined;
beforeEach(() => {
  prevReportDate = process.env.REPORT_DATE;
  process.env.REPORT_DATE = '2026-03-01';
});
afterEach(() => {
  if (prevReportDate === undefined) delete process.env.REPORT_DATE;
  else process.env.REPORT_DATE = prevReportDate;
});

describe('lease-market API', () => {
  it('GET /summary returns freshness, benchmarks, distribution and DOM bins', async () => {
    const config = testConfig();
    const db = await seeded(config);
    const app = leaseMarketApi(() => db, { loadConfig: () => config, getSnapshot: async () => snapshot });
    const res = await app.request('/summary');
    expect(res.status).toBe(200);
    const body = LeaseMarketSummaryResponse.parse(await res.json());
    expect(body.asOf).toBe('2026-03-01');
    expect(body.freshness.find((f) => f.marketId === 'columbus')?.stale).toBe(false);
    expect(body.distribution).toHaveLength(13);
    expect(body.distribution.filter((d) => d.isOra)).toHaveLength(1);
    expect(body.benchmarks).toHaveLength(1);
    expect(body.benchmarks[0]!.median).toBeCloseTo(9.3);
    expect(body.domByMarket[0]!.bins[0]).toEqual({ label: '0-90d', count: 12 });
    expect(body.distribution.every((d) => d.address !== null)).toBe(true);
  });

  it('GET /positioning places the vacant ORA unit and lists unmapped properties', async () => {
    const config = testConfig();
    const db = await seeded(config);
    const app = leaseMarketApi(() => db, { loadConfig: () => config, getSnapshot: async () => snapshot });
    const body = PositioningResponse.parse(await (await app.request('/positioning')).json());
    expect(body.unconfiguredPropertyKeys).toEqual(['Unmapped Property']);
    expect(body.rows[0]).toMatchObject({ propertyKey: '1100 Rarig', oraAskingNnnEq: 12, band: 'above', effectiveDom: 45 });
    expect(body.rows[0]!.gapPct).toBeCloseTo((12 - 9.3) / 9.3);
  });

  it('GET /signals orders high severity first', async () => {
    const config = testConfig();
    const db = await seeded(config);
    const app = leaseMarketApi(() => db, { loadConfig: () => config, getSnapshot: async () => snapshot });
    const body = SignalsResponse.parse(await (await app.request('/signals')).json());
    expect(body.signals).toHaveLength(15);
    expect(body.signals[0]!.kind).toBe('acq_candidate');
    expect(body.signals[0]!.evidence.ownerName).toBe('SMITH FAMILY LLC');
    expect(body.candidatesWithheld).toEqual([]);
  });

  it('strips row-level identifiers when mirrorRowLevel is false', async () => {
    const config = testConfig({ mirrorRowLevel: false });
    const db = await seeded(config);
    const app = leaseMarketApi(() => db, { loadConfig: () => config, getSnapshot: async () => snapshot });
    const summary = LeaseMarketSummaryResponse.parse(await (await app.request('/summary')).json());
    expect(summary.rowLevel).toBe(false);
    expect(summary.distribution.every((d) => d.address === null)).toBe(true);
    const signals = SignalsResponse.parse(await (await app.request('/signals')).json());
    expect(signals.signals.every((s) => s.address === null && !('address' in s.evidence) && !('ownerName' in s.evidence))).toBe(true);
  });

  it('returns 503 without a warehouse or snapshot', async () => {
    const config = testConfig();
    const noDb = leaseMarketApi(() => { throw new Error('no db'); }, { loadConfig: () => config });
    expect((await noDb.request('/summary')).status).toBe(503);
    const db = await seeded(config);
    const noSnap = leaseMarketApi(() => db, { loadConfig: () => config, getSnapshot: async () => null });
    expect((await noSnap.request('/positioning')).status).toBe(503);
  });

  it('returns 500 on an invalid config', async () => {
    const db = await seeded();
    const bad = leaseMarketApi(() => db, { loadConfig: () => { throw new Error('bad json'); } });
    expect((await bad.request('/signals')).status).toBe(500);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/lease-market-api.test.ts`
Expected: FAIL — cannot resolve `lease-market-api`.

- [ ] **Step 3: Write the router**

```ts
// server/warehouse/lease-market-api.ts
//
// Lease Market Intelligence — Hono sub-router, mounted at /api/warehouse/lease-market via sub-routers.ts.
//
// Routes:
//   GET /summary     — LeaseMarketSummaryResponse (freshness, cell benchmarks, asking-rent distribution, DOM bins)
//   GET /positioning — PositioningResponse (vacant ORA units vs. their comparable cell; needs the live snapshot)
//   GET /signals     — SignalsResponse (persisted by `npm run lease-market:compute`)
//
// Pure route plumbing: math lives in src/analytics/lease-market/* and server/warehouse/lease-market/*.
// Listed in DELIVERY_ONLY_PATHS (scripts/check-refute-required.ts).
// Data handling: CoStar-derived rows are internal-only; config.mirrorRowLevel=false strips addresses/owners.
import { Hono } from 'hono';
import type { WarehouseDb } from './db';
import { referenceDate } from '../config';
import {
  LeaseMarketSummaryResponse, PositioningResponse, SignalsResponse,
  type CellBenchmark, type DistributionPoint, type EvidenceValue, type LeaseMarketConfig, type SignalRow,
} from '../../src/contracts/lease-market';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { toCellBenchmark } from '../../src/analytics/lease-market/benchmarks';
import { effectiveDom } from '../../src/analytics/lease-market/signals';
import { loadLeaseMarketConfig } from './lease-market/config';
import { cellTargetFor, domBins, loadMarketState, marketFreshness, withheldCandidateMarkets } from './lease-market/compute';
import { computePositioning } from './lease-market/positioning';

export interface LeaseMarketApiDeps {
  loadConfig?: () => LeaseMarketConfig;
  getSnapshot?: () => Promise<PortfolioSnapshot | null>;
}

async function liveSnapshot(): Promise<PortfolioSnapshot | null> {
  // Dynamic import avoids a circular dependency at module load (same pattern as lease-forecast-api.ts).
  const { brain } = await import('../brain');
  return brain.getSnapshot();
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

export function leaseMarketApi(getDb: () => WarehouseDb, deps: LeaseMarketApiDeps = {}): Hono {
  const app = new Hono();
  const loadConfig = deps.loadConfig ?? (() => loadLeaseMarketConfig());
  const getSnapshot = deps.getSnapshot ?? liveSnapshot;

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

  app.get('/summary', () =>
    guarded((db, config) => {
      const asOf = referenceDate();
      const state = loadMarketState(db, config);
      const benchmarks = new Map<string, CellBenchmark>();
      const distribution: DistributionPoint[] = [];
      for (const l of state.listings) {
        const latest = l.observations[l.observations.length - 1];
        if (!l.isOraOwned) {
          const target = cellTargetFor(l);
          if (target) {
            const cell = toCellBenchmark(state.cellFor(target));
            benchmarks.set(cell.cellKey, cell);
          }
        }
        if (latest && latest.askingNnnEq !== null && l.sizeBand !== null) {
          distribution.push({
            listingId: l.listingId, marketId: l.marketId, subtype: l.subtype, sizeBand: l.sizeBand, askingNnnEq: latest.askingNnnEq,
            solid: l.latestEligible, isOra: l.isOraOwned, address: config.mirrorRowLevel ? l.addressDisplay : null,
          });
        }
      }
      return json(
        200,
        LeaseMarketSummaryResponse.parse({
          asOf,
          rowLevel: config.mirrorRowLevel,
          freshness: marketFreshness(db, config, asOf),
          benchmarks: [...benchmarks.values()].sort((a, b) => a.cellKey.localeCompare(b.cellKey)),
          distribution,
          domByMarket: domBins(state, asOf),
        }),
      );
    }),
  );

  app.get('/positioning', () =>
    guarded(async (db, config) => {
      const snapshot = await getSnapshot();
      if (!snapshot) return json(503, { error: 'snapshot unavailable' });
      const asOf = referenceDate();
      const state = loadMarketState(db, config);
      const units = snapshot.leases
        .filter((l) => l.status === 'Vacant')
        .map((l) => ({ propertyKey: l.propertyKey, unit: l.unit, sf: l.sf }));
      const oraListings = state.listings.flatMap((l) =>
        l.oraPropertyKey === null
          ? []
          : [{ oraPropertyKey: l.oraPropertyKey, suiteNorm: l.suiteNorm, askingNnnEq: l.observations[l.observations.length - 1]?.askingNnnEq ?? null, effectiveDom: effectiveDom(l, asOf) }],
      );
      const { rows, unconfiguredPropertyKeys } = computePositioning(units, config, oraListings, state.cellFor);
      return json(200, PositioningResponse.parse({ asOf, unconfiguredPropertyKeys, rows }));
    }),
  );

  app.get('/signals', () =>
    guarded((db, config) => {
      const rows = db
        .prepare(
          `SELECT s.id, s.listing_id, s.kind, s.severity, s.cell_key, s.computed_at, s.evidence_json, l.market_id, l.address_display
           FROM lm_signal s JOIN lm_listing l ON l.id = s.listing_id
           WHERE s.dismissed_at IS NULL
           ORDER BY CASE s.severity WHEN 'high' THEN 0 WHEN 'watch' THEN 1 ELSE 2 END, s.kind, s.id`,
        )
        .all() as Array<{
          id: number; listing_id: number; kind: SignalRow['kind']; severity: SignalRow['severity']; cell_key: string | null;
          computed_at: string; evidence_json: string; market_id: string; address_display: string;
        }>;
      const signals: SignalRow[] = rows.map((r) => {
        const full = JSON.parse(r.evidence_json) as Record<string, EvidenceValue>;
        const { address: _address, ownerName: _ownerName, ...redacted } = full;
        return {
          id: r.id, listingId: r.listing_id, marketId: r.market_id, address: config.mirrorRowLevel ? r.address_display : null,
          kind: r.kind, severity: r.severity, cellKey: r.cell_key, computedAt: r.computed_at,
          evidence: config.mirrorRowLevel ? full : redacted,
        };
      });
      return json(200, SignalsResponse.parse({ asOf: referenceDate(), candidatesWithheld: withheldCandidateMarkets(db, config), signals }));
    }),
  );

  return app;
}
```

- [ ] **Step 4: Register, bake, and classify**

1. `server/warehouse/sub-routers.ts`: add `import { leaseMarketApi } from './lease-market-api';` with the other imports and add `{ prefix: '/lease-market', factory: leaseMarketApi },` to `WAREHOUSE_SUB_ROUTERS` directly after the `/leasing` entry. (`leaseMarketApi`'s optional second parameter keeps it assignable to `factory: (getDb) => Hono`.)
2. `scripts/bake-warehouse.ts`: append `'/lease-market/summary', '/lease-market/signals', '/lease-market/positioning'` to `FIXED_ROUTES`, and change the `REQUIRED_ROUTES` filter so lease-market routes are optional (a fresh warehouse with no exports, or a bake without a snapshot, must not fail the whole mirror):

```ts
const REQUIRED_ROUTES = new Set<string>(FIXED_ROUTES.filter((r) => r !== '/brain/report' && !r.startsWith('/lease-market/')));
```

   Add a comment above it: `// Lease-market routes are optional: no CoStar export yet, or no snapshot in the bake process, must not block the mirror.`
3. `scripts/check-refute-required.ts`: add to `DELIVERY_ONLY_PATHS`, with a comment in the file's existing style:

```ts
  // Lease Market Intelligence: pure route plumbing; math lives in src/analytics/lease-market/* and
  // server/warehouse/lease-market/* (both still refute-required via their prefixes).
  'server/warehouse/lease-market-api.ts',
```

4. Run `grep -rn "FIXED_ROUTES\|REQUIRED_ROUTES\|DELIVERY_ONLY_PATHS\|WAREHOUSE_SUB_ROUTERS" tests/unit` and update any test that pins those lists exactly.

- [ ] **Step 5: Run tests, governance, typecheck, lint**

Run: `npx vitest run tests/unit/lease-market-api.test.ts tests/unit/check-refute-required.test.ts && npm run governance && npm run check:schema-drift && npm run typecheck && npm run lint`
Also run the bake tests: `npx vitest run $(grep -rln "bake-warehouse" tests/unit)`.
Expected: all PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add server/warehouse/lease-market-api.ts server/warehouse/sub-routers.ts scripts/bake-warehouse.ts scripts/check-refute-required.ts tests/unit/lease-market-api.test.ts <any updated existing test files>
git commit -F <message-file>   # "feat(api): lease-market summary, positioning and signals routes"
```
