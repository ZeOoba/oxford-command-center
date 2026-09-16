### Task 09: Compute — market state, signals + feed persistence, freshness, DOM bins

**Files:**
- Create: `server/warehouse/lease-market/compute.ts`
- Test: `tests/unit/lease-market-compute.test.ts`

**Interfaces:**
- Consumes: Task 02 types; Task 03 `addDays`, `daysBetween`, `isBenchmarkEligible`, `officeStratumFor`, `sizeBandFor`; Task 04 `cellIndex`, `BenchRow`, `CellTarget`, `ComputedCell`; Task 05 `completedDomBaseline`, `effectiveDom`, `listingSignals`, `staleThresholdDays`, `ListingHistory`, `ObservationPoint`, `SignalDraft`; Task 08 `latestCompleteLanding`.
- Produces:
  - `interface ListingState extends ListingHistory { suiteNorm: string; submarket: string | null; subtype: LmSubtype; sizeBand: SizeBand | null; officeStratum: OfficeStratum; oraPropertyKey: string | null; originTier: OriginTier; latestEligible: boolean }`
  - `interface MarketState { listings: ListingState[]; benchRows: BenchRow[]; cellFor: (t: CellTarget) => ComputedCell }`
  - `loadMarketState(db: WarehouseDb, config: LeaseMarketConfig): MarketState` — current = status `active` or `missing_once`; ORA-owned listings are in `listings` but NEVER in `benchRows`
  - `cellTargetFor(l: ListingState): CellTarget | null`
  - `withheldCandidateMarkets(db: WarehouseDb, config: LeaseMarketConfig): Array<{ marketId: string; reason: string }>`
  - `marketFreshness(db: WarehouseDb, config: LeaseMarketConfig, asOf: string): MarketFreshness[]`
  - `domBins(state: MarketState, asOf: string): Array<{ marketId: string; bins: DomBin[] }>` — bins `0-90d`, `90-180d`, `180-365d`, `365d+` over non-ORA T1 listings
  - `interface ComputeResult { signals: number; byKind: Record<string, number>; feedRows: number; withheldMarkets: string[] }`
  - `runCompute(db: WarehouseDb, config: LeaseMarketConfig, asOf: string): ComputeResult` — one transaction: replaces ALL `lm_signal` rows and ALL `lm_market_rent_feed` rows

Rules: stale threshold per market = `staleThresholdDays(completedDomBaseline(effective DOM at removal of T1 listings removed in the trailing 365 days, completedDomMinN), tier)`. Owner screen is available for a market only when its latest complete landing has `owner_screen_ok = 1`. `ownerListingCount` counts current listings with the same trimmed, upper-cased owner name. Feed: for each `oraProperties` entry with `leaseBasis === 'NNN'`, cell = (market, submarket, subtype, `sizeBandFor(typicalUnitSf)`, office stratum); write the median only when it is non-null and the cell is not low coverage. Freshness `stale` = no complete landing, OR days since it > `freshnessDays`, OR the latest landing is partial.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lease-market-compute.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse } from '../../server/warehouse/db';
import { ingestCostarListingsFile } from '../../server/warehouse/lease-market/ingest';
import { domBins, loadMarketState, marketFreshness, runCompute } from '../../server/warehouse/lease-market/compute';
import { stubScreen, testConfig, testHeaderMap, writeCostarFixture, type FixtureListing } from './lease-market-fixtures';

// 12 warehouse NNN spaces, 20,000 SF each in 40,000 SF buildings (vacancy share 50%), submarket East.
// Sorted rents: median 9.30, P25 8.75, 0.85 x median 7.905 => 5.50 and 6.00 are below market.
const RENTS = [5.5, 6.0, 8.6, 8.8, 9.0, 9.2, 9.4, 9.6, 9.8, 10.0, 10.2, 10.4];

function listings(): FixtureListing[] {
  const rows: FixtureListing[] = RENTS.map((rent, i) => ({
    id: `C${i}`, address: `${100 + i} Industrial Pkwy`, sf: 20000, rentLow: rent,
    owner: rent === 5.5 ? 'PROLOGIS FUND LP' : 'SMITH FAMILY LLC',
  }));
  rows.push({ address: '1100 Rarig Ave', suite: 'B', sf: 8000, rentLow: 12, owner: 'OXFORD RARIG LLC' });
  return rows;
}

async function seeded(screenAvailable = true) {
  const dir = mkdtempSync(join(tmpdir(), 'lm-compute-'));
  const db = openWarehouse(join(dir, 't.sqlite'));
  const config = testConfig();
  const file = await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-15.xlsx', listings());
  const r = await ingestCostarListingsFile(db, file, {
    config, headerMap: testHeaderMap(), rawDir: join(dir, 'raw'), now: () => '2026-02-16T00:00:00Z',
    screen: (names) => ({ ...stubScreen(names), available: screenAvailable }),
  });
  expect(r.status).toBe('ingested');
  return { db, config };
}

describe('loadMarketState', () => {
  it('keeps ORA listings out of benchmark rows', async () => {
    const { db, config } = await seeded();
    const s = loadMarketState(db, config);
    expect(s.listings).toHaveLength(13);
    expect(s.benchRows).toHaveLength(12);
    expect(s.listings.find((l) => l.oraPropertyKey === '1100 Rarig')?.isOraOwned).toBe(true);
    expect(s.listings.every((l) => l.isNewInLatestExport)).toBe(true);
  });
});

describe('runCompute', () => {
  it('persists below-market signals, one screened candidate, and the market-rent feed', async () => {
    const { db, config } = await seeded();
    const r = runCompute(db, config, '2026-03-01');
    expect(r.byKind).toEqual({ new_listing: 12, below_market: 2, acq_candidate: 1 });
    expect(r).toMatchObject({ signals: 15, feedRows: 1, withheldMarkets: [] });

    const cand = db
      .prepare(`SELECT l.address_display, s.evidence_json FROM lm_signal s JOIN lm_listing l ON l.id = s.listing_id WHERE s.kind = 'acq_candidate'`)
      .get() as { address_display: string; evidence_json: string };
    expect(cand.address_display).toBe('101 Industrial Pkwy');
    expect(JSON.parse(cand.evidence_json)).toMatchObject({ belowMarket: true, highVacancy: true, ownerListingCount: 11, ownerType: 'private' });

    const feed = db.prepare('SELECT * FROM lm_market_rent_feed').all() as Array<Record<string, unknown>>;
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ ora_property_key: '1100 Rarig', cell_key: 'columbus|East|warehouse|<5K~15-30K|all', n: 12, quoted_share: 1, computed_at: '2026-03-01' });
    expect(feed[0]!.asking_nnn_eq as number).toBeCloseTo(9.3);
  });

  it('replaces signals on re-run', async () => {
    const { db, config } = await seeded();
    runCompute(db, config, '2026-03-01');
    runCompute(db, config, '2026-03-01');
    expect((db.prepare('SELECT COUNT(*) AS n FROM lm_signal').get() as { n: number }).n).toBe(15);
  });

  it('withholds candidates when the owner screen was unavailable', async () => {
    const { db, config } = await seeded(false);
    const r = runCompute(db, config, '2026-03-01');
    expect(r.byKind.acq_candidate).toBeUndefined();
    expect(r.withheldMarkets).toEqual(['columbus']);
  });

  it('skips the feed for non-NNN ORA properties', async () => {
    const { db, config } = await seeded();
    const mg = testConfig({ oraProperties: config.oraProperties.map((p) => ({ ...p, leaseBasis: 'MG' as const })) });
    expect(runCompute(db, mg, '2026-03-01').feedRows).toBe(0);
  });
});

describe('freshness and DOM bins', () => {
  it('reports per-market freshness', async () => {
    const { db, config } = await seeded();
    const fresh = marketFreshness(db, config, '2026-03-01');
    expect(fresh.find((f) => f.marketId === 'columbus')).toMatchObject({ lastCompleteDate: '2026-02-15', lastCompleteness: 'complete', stale: false });
    expect(fresh.find((f) => f.marketId === 'madison')).toMatchObject({ lastCompleteDate: null, stale: true });
    expect(marketFreshness(db, config, '2026-04-01').find((f) => f.marketId === 'columbus')?.stale).toBe(true);
  });

  it('bins effective DOM for non-ORA listings', async () => {
    const { db, config } = await seeded();
    expect(domBins(loadMarketState(db, config), '2026-03-01')).toEqual([
      { marketId: 'columbus', bins: [{ label: '0-90d', count: 12 }, { label: '90-180d', count: 0 }, { label: '180-365d', count: 0 }, { label: '365d+', count: 0 }] },
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/lease-market-compute.test.ts`
Expected: FAIL — cannot resolve `compute`.

- [ ] **Step 3: Write the implementation**

```ts
// server/warehouse/lease-market/compute.ts
//
// Lease Market Intelligence — load current listings, build benchmark cells, persist signals and the
// market-rent feed (spec §3.5–3.7). Financial-decision source: refute pass required.
import type { WarehouseDb } from '../db';
import type {
  BuildingStatus, DomBin, LeaseMarketConfig, LmSubtype, MarketFreshness, OfficeStratum, OriginTier, OwnerType, RentBasis, SizeBand,
} from '../../../src/contracts/lease-market';
import { addDays, daysBetween, isBenchmarkEligible, officeStratumFor, sizeBandFor } from '../../../src/analytics/lease-market/normalize';
import { cellIndex, type BenchRow, type CellTarget, type ComputedCell } from '../../../src/analytics/lease-market/benchmarks';
import {
  completedDomBaseline, effectiveDom, listingSignals, staleThresholdDays,
  type ListingHistory, type ObservationPoint, type SignalDraft,
} from '../../../src/analytics/lease-market/signals';
import { latestCompleteLanding } from './ingest';

export interface ListingState extends ListingHistory {
  suiteNorm: string;
  submarket: string | null;
  subtype: LmSubtype;
  sizeBand: SizeBand | null;
  officeStratum: OfficeStratum;
  oraPropertyKey: string | null;
  originTier: OriginTier;
  latestEligible: boolean;
}

export interface MarketState {
  listings: ListingState[];
  benchRows: BenchRow[];
  cellFor: (t: CellTarget) => ComputedCell;
}

interface ListingDbRow {
  id: number;
  address_display: string;
  suite_norm: string;
  market_id: string;
  submarket: string | null;
  subtype: LmSubtype;
  building_status: BuildingStatus;
  building_sf: number | null;
  year_built: number | null;
  clear_height_ft: number | null;
  docks: number | null;
  office_pct: number | null;
  owner_name: string | null;
  owner_type: OwnerType;
  ora_property_key: string | null;
  first_seen: string;
  first_landing_id: number;
  costar_date_on_market: string | null;
  origin_tier: OriginTier;
}

interface ObservationDbRow {
  listing_id: number;
  observed_at: string;
  available_sf: number;
  asking_nnn_eq: number | null;
  rent_low: number | null;
  rent_basis: RentBasis;
  is_sublease: number;
  costar_dom: number | null;
  confidence: 'high' | 'low';
}

export function loadMarketState(db: WarehouseDb, config: LeaseMarketConfig): MarketState {
  const t = config.thresholds;
  const rows = db
    .prepare(
      `SELECT id, address_display, suite_norm, market_id, submarket, subtype, building_status, building_sf, year_built,
         clear_height_ft, docks, office_pct, owner_name, owner_type, ora_property_key, first_seen, first_landing_id,
         costar_date_on_market, origin_tier
       FROM lm_listing WHERE status IN ('active', 'missing_once') ORDER BY id`,
    )
    .all() as ListingDbRow[];
  const obsRows = db
    .prepare(
      `SELECT o.listing_id, o.observed_at, o.available_sf, o.asking_nnn_eq, o.rent_low, o.rent_basis, o.is_sublease, o.costar_dom, o.confidence
       FROM lm_observation o JOIN lm_listing l ON l.id = o.listing_id
       WHERE l.status IN ('active', 'missing_once')
       ORDER BY o.listing_id, o.observed_at, o.id`,
    )
    .all() as ObservationDbRow[];

  const byListing = new Map<number, ObservationDbRow[]>();
  for (const o of obsRows) {
    const list = byListing.get(o.listing_id);
    if (list) list.push(o);
    else byListing.set(o.listing_id, [o]);
  }

  const latestComplete = new Map<string, number | null>();
  const latestCompleteId = (marketId: string): number | null => {
    if (!latestComplete.has(marketId)) latestComplete.set(marketId, latestCompleteLanding(db, marketId)?.id ?? null);
    return latestComplete.get(marketId) ?? null;
  };

  const listings: ListingState[] = [];
  const benchRows: BenchRow[] = [];
  for (const l of rows) {
    const history = byListing.get(l.id) ?? [];
    if (history.length === 0) continue;
    const observations: ObservationPoint[] = history.map((o) => ({
      observedAt: o.observed_at,
      availableSf: o.available_sf,
      askingNnnEq: o.asking_nnn_eq,
      rentLow: o.rent_low,
      costarDom: o.costar_dom,
      isSublease: o.is_sublease === 1,
      eligible: isBenchmarkEligible(
        {
          confidence: o.confidence, effectiveBasis: o.rent_basis, isSublease: o.is_sublease === 1, originTier: l.origin_tier,
          buildingStatus: l.building_status, askingNnnEq: o.asking_nnn_eq, buildingSf: l.building_sf,
        },
        t.benchmarkMaxBuildingSf,
      ),
    }));
    const latest = observations[observations.length - 1]!;
    const sizeBand = sizeBandFor(latest.availableSf);
    const officeStratum = officeStratumFor(l.subtype, l.office_pct, t.flexOfficeSplitPct);
    listings.push({
      listingId: l.id,
      marketId: l.market_id,
      addressDisplay: l.address_display,
      buildingStatus: l.building_status,
      buildingSf: l.building_sf,
      yearBuilt: l.year_built,
      clearHeightFt: l.clear_height_ft,
      docks: l.docks,
      ownerName: l.owner_name,
      ownerType: l.owner_type,
      isOraOwned: l.ora_property_key !== null,
      firstSeen: l.first_seen,
      costarDateOnMarket: l.costar_date_on_market,
      isNewInLatestExport: l.first_landing_id === latestCompleteId(l.market_id),
      observations,
      suiteNorm: l.suite_norm,
      submarket: l.submarket,
      subtype: l.subtype,
      sizeBand,
      officeStratum,
      oraPropertyKey: l.ora_property_key,
      originTier: l.origin_tier,
      latestEligible: latest.eligible,
    });
    if (sizeBand !== null && l.ora_property_key === null) {
      benchRows.push({
        listingId: l.id, marketId: l.market_id, submarket: l.submarket, subtype: l.subtype, sizeBand, officeStratum,
        askingNnnEq: latest.askingNnnEq, eligible: latest.eligible, clearHeightFt: l.clear_height_ft, yearBuilt: l.year_built, docks: l.docks,
      });
    }
  }
  return { listings, benchRows, cellFor: cellIndex(benchRows, { minN: t.benchmarkMinN, lowCoverageShare: t.lowCoverageQuotedShare }) };
}

export function cellTargetFor(l: ListingState): CellTarget | null {
  return l.sizeBand === null
    ? null
    : { marketId: l.marketId, submarket: l.submarket, subtype: l.subtype, sizeBand: l.sizeBand, officeStratum: l.officeStratum };
}

export function withheldCandidateMarkets(db: WarehouseDb, config: LeaseMarketConfig): Array<{ marketId: string; reason: string }> {
  return config.markets.flatMap((m) => {
    const c = latestCompleteLanding(db, m.id);
    return c && c.owner_screen_ok !== 1
      ? [{ marketId: m.id, reason: 'owner screen unavailable on the latest complete export; acquisition candidates withheld' }]
      : [];
  });
}

export function marketFreshness(db: WarehouseDb, config: LeaseMarketConfig, asOf: string): MarketFreshness[] {
  const latestStmt = db.prepare(
    `SELECT observed_at, completeness, partial_reason FROM lm_landing
     WHERE source = 'costar_listings' AND market_id = ? AND parse_status = 'ok'
     ORDER BY observed_at DESC, id DESC LIMIT 1`,
  );
  return config.markets.map((m) => {
    const last = latestStmt.get(m.id) as { observed_at: string; completeness: 'complete' | 'partial'; partial_reason: string | null } | undefined;
    const complete = latestCompleteLanding(db, m.id);
    const stale =
      !complete || daysBetween(complete.observed_at, asOf) > config.thresholds.freshnessDays || last?.completeness === 'partial';
    return {
      marketId: m.id,
      label: m.label,
      lastLandingDate: last?.observed_at ?? null,
      lastCompleteDate: complete?.observed_at ?? null,
      lastCompleteness: last?.completeness ?? null,
      partialReason: last?.partial_reason ?? null,
      stale,
    };
  });
}

const DOM_BINS: ReadonlyArray<{ label: string; min: number; max: number }> = [
  { label: '0-90d', min: 0, max: 90 },
  { label: '90-180d', min: 90, max: 180 },
  { label: '180-365d', min: 180, max: 365 },
  { label: '365d+', min: 365, max: Number.POSITIVE_INFINITY },
];

export function domBins(state: MarketState, asOf: string): Array<{ marketId: string; bins: DomBin[] }> {
  const byMarket = new Map<string, number[]>();
  for (const l of state.listings) {
    if (l.isOraOwned || l.originTier !== 'T1') continue;
    const list = byMarket.get(l.marketId) ?? [];
    list.push(effectiveDom(l, asOf));
    byMarket.set(l.marketId, list);
  }
  return [...byMarket.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([marketId, doms]) => ({
      marketId,
      bins: DOM_BINS.map((b) => ({ label: b.label, count: doms.filter((d) => d >= b.min && d < b.max).length })),
    }));
}

export interface ComputeResult {
  signals: number;
  byKind: Record<string, number>;
  feedRows: number;
  withheldMarkets: string[];
}

export function runCompute(db: WarehouseDb, config: LeaseMarketConfig, asOf: string): ComputeResult {
  const t = config.thresholds;
  const state = loadMarketState(db, config);

  const removed = db
    .prepare(
      `SELECT market_id, first_seen, costar_date_on_market, removed_at FROM lm_listing
       WHERE status = 'removed' AND origin_tier = 'T1' AND removed_at >= ?`,
    )
    .all(addDays(asOf, -365)) as Array<{ market_id: string; first_seen: string; costar_date_on_market: string | null; removed_at: string }>;
  const domsAtRemoval = new Map<string, number[]>();
  for (const r of removed) {
    const list = domsAtRemoval.get(r.market_id) ?? [];
    list.push(effectiveDom({ firstSeen: r.first_seen, costarDateOnMarket: r.costar_date_on_market }, r.removed_at));
    domsAtRemoval.set(r.market_id, list);
  }

  const ownerCounts = new Map<string, number>();
  for (const l of state.listings) {
    if (!l.ownerName) continue;
    const key = l.ownerName.trim().toUpperCase();
    ownerCounts.set(key, (ownerCounts.get(key) ?? 0) + 1);
  }

  const withheld = withheldCandidateMarkets(db, config);
  const screenOk = new Map(config.markets.map((m) => [m.id, latestCompleteLanding(db, m.id)?.owner_screen_ok === 1]));
  const marketById = new Map(config.markets.map((m) => [m.id, m]));
  const thresholdByMarket = new Map<string, number>();

  const drafts: SignalDraft[] = [];
  for (const l of state.listings) {
    const market = marketById.get(l.marketId);
    if (!market) continue;
    let threshold = thresholdByMarket.get(l.marketId);
    if (threshold === undefined) {
      threshold = staleThresholdDays(completedDomBaseline(domsAtRemoval.get(l.marketId) ?? [], t.completedDomMinN), market.tier, t);
      thresholdByMarket.set(l.marketId, threshold);
    }
    const target = cellTargetFor(l);
    const ownerKey = l.ownerName?.trim().toUpperCase();
    drafts.push(
      ...listingSignals(l, {
        asOf,
        cell: target ? state.cellFor(target) : null,
        staleThresholdDays: threshold,
        ownerListingCount: ownerKey ? (ownerCounts.get(ownerKey) ?? 1) : 0,
        ownerScreenAvailable: screenOk.get(l.marketId) === true,
        thresholds: t,
      }),
    );
  }

  const feed: Array<{ key: string; value: number; cellKey: string; n: number; quotedShare: number }> = [];
  for (const p of config.oraProperties) {
    if (p.leaseBasis !== 'NNN') continue;
    const band = sizeBandFor(p.typicalUnitSf);
    if (band === null) continue;
    const cell = state.cellFor({
      marketId: p.marketId, submarket: p.submarket, subtype: p.subtype, sizeBand: band,
      officeStratum: officeStratumFor(p.subtype, p.officePct, t.flexOfficeSplitPct),
    });
    if (cell.median === null || cell.lowCoverage) continue;
    feed.push({ key: p.propertyKey, value: cell.median, cellKey: cell.cellKey, n: cell.n, quotedShare: cell.quotedShare });
  }

  db.transaction(() => {
    db.prepare('DELETE FROM lm_signal').run();
    const insertSignal = db.prepare(
      `INSERT INTO lm_signal (listing_id, kind, severity, cell_key, computed_at, evidence_json) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const d of drafts) insertSignal.run(d.listingId, d.kind, d.severity, d.cellKey, asOf, JSON.stringify(d.evidence));
    db.prepare('DELETE FROM lm_market_rent_feed').run();
    const insertFeed = db.prepare(
      `INSERT INTO lm_market_rent_feed (ora_property_key, asking_nnn_eq, cell_key, n, quoted_share, computed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (const f of feed) insertFeed.run(f.key, f.value, f.cellKey, f.n, f.quotedShare, asOf);
  })();

  const byKind: Record<string, number> = {};
  for (const d of drafts) byKind[d.kind] = (byKind[d.kind] ?? 0) + 1;
  return { signals: drafts.length, byKind, feedRows: feed.length, withheldMarkets: withheld.map((w) => w.marketId) };
}
```

- [ ] **Step 4: Run tests, typecheck, lint**

Run: `npx vitest run tests/unit/lease-market-compute.test.ts tests/unit/lease-market-ingest.test.ts && npm run typecheck && npx eslint server/warehouse/lease-market tests/unit/lease-market-compute.test.ts --max-warnings 0`
Expected: PASS / clean.

- [ ] **Step 5: Commit**

```bash
git add server/warehouse/lease-market/compute.ts tests/unit/lease-market-compute.test.ts
git commit -F <message-file>   # "feat(warehouse): lease market compute — signals, feed, freshness"
```
