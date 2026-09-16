### Task 08: Config loaders + CoStar listings ingest (landing, identity, observations, completeness, removal)

**Files:**
- Create: `server/warehouse/lease-market/config.ts`
- Create: `server/warehouse/lease-market/ingest.ts`
- Test: `tests/unit/lease-market-ingest.test.ts`

**Interfaces:**
- Consumes: Task 01 tables; Task 02 `LeaseMarketConfig`; Task 03 `splitAddress`, `priceObservation`, `daysBetween`; Task 06 `CostarHeaderMap`, `CostarParseError`, `parseCostarListingsFile`, `sha256File`; Task 07 `OwnerScreenResult`; `openWarehouse(path)` / `WarehouseDb` from `server/warehouse/db.ts`.
- Produces:
  - config.ts: `expandHome(p: string): string`, `defaultConfigPath(): string`, `defaultHeaderMapPath(): string`, `loadLeaseMarketConfig(path?: string): LeaseMarketConfig` (expands `~` in `ownerScreenModulePath`), `loadCostarHeaderMap(path?: string): CostarHeaderMap`
  - ingest.ts: `interface IngestDeps { config: LeaseMarketConfig; headerMap: CostarHeaderMap; rawDir: string; now: () => string; screen: (names: string[]) => OwnerScreenResult }`
  - `interface IngestResult { file: string; status: 'ingested' | 'duplicate' | 'failed'; landingId: number | null; marketId: string | null; exportDate: string | null; completeness: 'complete' | 'partial' | null; partialReason: string | null; inserted: number; updated: number; skipped: number; markedMissing: number; markedRemoved: number; error: string | null }`
  - `parseListingFileName(name: string): { marketId: string; exportDate: string } | null` — pattern `costar-listings_<marketId>_<YYYY-MM-DD>.(xlsx|csv)`
  - `interface CompleteLanding { id: number; observed_at: string; row_count: number; header_fingerprint: string | null; owner_screen_ok: number }` and `latestCompleteLanding(db: WarehouseDb, marketId: string): CompleteLanding | undefined`
  - `ingestCostarListingsFile(db: WarehouseDb, filePath: string, deps: IngestDeps): Promise<IngestResult>`

Rules (spec §3.4): duplicate = same sha256 already `parse_status='ok'`. Parse errors write a `failed` landing (retry allowed later). Market id comes from the file name, else from the export's market column via `costarMarketNames` (must resolve to exactly one market); export date comes from the file name, else the file mtime. A header fingerprint different from the market's last complete landing ⇒ failed landing. Complete ⇔ row count < `exportRowCap` AND (no prior complete OR row count ≥ `exportMinRowRatio` × prior row count) AND (no prior complete OR export date > prior date); else partial with reasons joined by `; `. Everything for one file is one transaction. Only complete exports move T1 listings of that market: unseen `active` ⇒ `missing_once`; unseen `missing_once` ⇒ `removed` (removed_at = export date); seen ⇒ `active`. `costar_date_on_market` keeps the earliest date. A second row for the same space in one file is counted in `skipped`. `ora_property_key` is set when `addressNorm` is in a configured property's `addressNorms`.

- [ ] **Step 1: Write the failing test**

```ts
// tests/unit/lease-market-ingest.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse, type WarehouseDb } from '../../server/warehouse/db';
import { ingestCostarListingsFile, parseListingFileName, type IngestDeps } from '../../server/warehouse/lease-market/ingest';
import { stubScreen, testConfig, testHeaderMap, writeCostarFixture, type FixtureListing } from './lease-market-fixtures';

function setup() {
  const dir = mkdtempSync(join(tmpdir(), 'lm-ingest-'));
  const db: WarehouseDb = openWarehouse(join(dir, 'test.sqlite'));
  const deps: IngestDeps = { config: testConfig(), headerMap: testHeaderMap(), rawDir: join(dir, 'raw'), now: () => '2026-03-02T00:00:00Z', screen: stubScreen };
  return { dir, db, deps };
}
const THREE: FixtureListing[] = [
  { id: 'C1', address: '10 Alpha Rd', sf: 12000, rentLow: 8.5, dateOnMarket: '2025-10-01' },
  { id: 'C2', address: '20 Beta Dr', sf: 20000, owner: 'PROLOGIS FUND LP' },
  { address: '1100 Rarig Avenue', suite: 'B', sf: 8000, owner: 'OXFORD RARIG LLC' },
];
const status = (db: WarehouseDb, address: string) =>
  (db.prepare('SELECT status FROM lm_listing WHERE address_norm = ?').get(address) as { status: string }).status;

describe('parseListingFileName', () => {
  it('reads market and date', () => {
    expect(parseListingFileName('costar-listings_kansas-city_2026-03-01.xlsx')).toEqual({ marketId: 'kansas-city', exportDate: '2026-03-01' });
    expect(parseListingFileName('Export (3).xlsx')).toBeNull();
  });
});

describe('ingestCostarListingsFile', () => {
  it('ingests a first export as complete with identity, owner type, ORA match and pricing', async () => {
    const { dir, db, deps } = setup();
    const f = await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', THREE);
    const r = await ingestCostarListingsFile(db, f, deps);
    expect(r).toMatchObject({ status: 'ingested', marketId: 'columbus', exportDate: '2026-01-01', completeness: 'complete', inserted: 3, updated: 0 });
    const ora = db.prepare("SELECT ora_property_key, suite_norm, owner_type FROM lm_listing WHERE address_norm = '1100 RARIG AVE'").get();
    expect(ora).toEqual({ ora_property_key: '1100 Rarig', suite_norm: 'B', owner_type: 'affiliated' });
    expect((db.prepare("SELECT owner_type FROM lm_listing WHERE address_norm = '20 BETA DR'").get() as { owner_type: string }).owner_type).toBe('institutional');
    const o = db.prepare("SELECT o.asking_nnn_eq, o.confidence, o.costar_dom FROM lm_observation o JOIN lm_listing l ON l.id = o.listing_id WHERE l.address_norm = '10 ALPHA RD'").get();
    expect(o).toEqual({ asking_nnn_eq: 8.5, confidence: 'high', costar_dom: 92 });
    const landing = db.prepare('SELECT owner_screen_ok, completeness, row_count FROM lm_landing WHERE id = ?').get(r.landingId);
    expect(landing).toEqual({ owner_screen_ok: 1, completeness: 'complete', row_count: 3 });
  });

  it('treats identical bytes as a duplicate', async () => {
    const { dir, db, deps } = setup();
    const f = await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', THREE);
    await ingestCostarListingsFile(db, f, deps);
    expect((await ingestCostarListingsFile(db, f, deps)).status).toBe('duplicate');
  });

  it('moves unseen listings active -> missing_once -> removed, and back to active on return', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', THREE), deps);
    const withoutBeta = THREE.filter((l) => l.address !== '20 Beta Dr');
    const extra: FixtureListing[] = [{ address: '40 Delta Pkwy', sf: 5000 }];
    const r2 = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [...withoutBeta, ...extra]), deps);
    expect(r2).toMatchObject({ completeness: 'complete', markedMissing: 1, markedRemoved: 0 });
    expect(status(db, '20 BETA DR')).toBe('missing_once');
    const r3 = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-03-01.xlsx', [...withoutBeta, ...extra]), deps);
    expect(r3).toMatchObject({ markedRemoved: 1 });
    expect(status(db, '20 BETA DR')).toBe('removed');
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-04-01.xlsx', [...THREE, ...extra]), deps);
    expect(status(db, '20 BETA DR')).toBe('active');
  });

  it('marks a thin export partial and changes no statuses', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', THREE), deps);
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [THREE[0]!]), deps);
    expect(r.completeness).toBe('partial');
    expect(r.partialReason).toMatch(/row count 1 < 0.7/);
    expect(r.markedMissing).toBe(0);
    expect(status(db, '20 BETA DR')).toBe('active');
  });

  it('marks an export at the row cap partial', async () => {
    const { dir, db, deps } = setup();
    const capped = { ...deps, config: testConfig({ thresholds: { ...deps.config.thresholds, exportRowCap: 3 } }) };
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', THREE), capped);
    expect(r.partialReason).toMatch(/export cap 3/);
  });

  it('fails on a header change and on a pending header map, and allows a retry after the fix', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', THREE), deps);
    const changed = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', THREE, { extraHeader: 'Notes' }), deps);
    expect(changed).toMatchObject({ status: 'failed', error: expect.stringMatching(/header set changed/) });

    const f = await writeCostarFixture(dir, 'costar-listings_madison_2026-01-01.xlsx', [{ address: '5 Lake St', sf: 3000, market: 'Madison' }]);
    const pending = await ingestCostarListingsFile(db, f, { ...deps, headerMap: testHeaderMap({ status: 'pending-sample' }) });
    expect(pending.status).toBe('failed');
    expect((await ingestCostarListingsFile(db, f, deps)).status).toBe('ingested');
  });

  it('keeps the earliest CoStar date on market', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', THREE), deps);
    const relisted = THREE.map((l) => (l.id === 'C1' ? { ...l, dateOnMarket: '2026-01-20' } : l));
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', relisted), deps);
    const row = db.prepare("SELECT costar_date_on_market FROM lm_listing WHERE address_norm = '10 ALPHA RD'").get();
    expect(row).toEqual({ costar_date_on_market: '2025-10-01' });
    const doms = db.prepare("SELECT o.costar_dom FROM lm_observation o JOIN lm_listing l ON l.id = o.listing_id WHERE l.address_norm = '10 ALPHA RD' ORDER BY o.observed_at").all();
    expect(doms).toEqual([{ costar_dom: 92 }, { costar_dom: 12 }]);
  });

  it('infers the market from the market column when the file name has no convention', async () => {
    const { dir, db, deps } = setup();
    const f = await writeCostarFixture(dir, 'Export.xlsx', [{ address: '5 Lake St', sf: 3000, market: 'Madison' }]);
    expect((await ingestCostarListingsFile(db, f, deps)).marketId).toBe('madison');
    const mixed = await writeCostarFixture(dir, 'Export2.xlsx', [{ address: '6 Lake St', sf: 3000, market: 'Madison' }, { address: '7 Oak St', sf: 3000, market: 'Columbus' }]);
    expect((await ingestCostarListingsFile(db, mixed, deps)).error).toMatch(/spans 2 markets/);
  });

  it('records owner_screen_ok = 0 when the screen is unavailable', async () => {
    const { dir, db, deps } = setup();
    const down = { ...deps, screen: (names: string[]) => ({ ...stubScreen(names), available: false }) };
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', THREE), down);
    expect((db.prepare('SELECT owner_screen_ok FROM lm_landing WHERE id = ?').get(r.landingId) as { owner_screen_ok: number }).owner_screen_ok).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/lease-market-ingest.test.ts`
Expected: FAIL — cannot resolve `ingest`.

- [ ] **Step 3: Write config.ts**

```ts
// server/warehouse/lease-market/config.ts
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { LeaseMarketConfig } from '../../../src/contracts/lease-market';
import { CostarHeaderMap } from './costar-parse';

export function expandHome(p: string): string {
  return p === '~' || p.startsWith('~/') || p.startsWith('~\\') ? join(homedir(), p.slice(1)) : p;
}

export function defaultConfigPath(): string {
  return join(process.cwd(), 'config', 'lease-market.json');
}

export function defaultHeaderMapPath(): string {
  return join(process.cwd(), 'config', 'lease-market.costar-headers.json');
}

export function loadLeaseMarketConfig(path = defaultConfigPath()): LeaseMarketConfig {
  const parsed = LeaseMarketConfig.parse(JSON.parse(readFileSync(path, 'utf8')));
  return { ...parsed, ownerScreenModulePath: expandHome(parsed.ownerScreenModulePath) };
}

export function loadCostarHeaderMap(path = defaultHeaderMapPath()): CostarHeaderMap {
  return CostarHeaderMap.parse(JSON.parse(readFileSync(path, 'utf8')));
}
```

- [ ] **Step 4: Write ingest.ts**

```ts
// server/warehouse/lease-market/ingest.ts
//
// Lease Market Intelligence — CoStar listings ingest (spec §3.1–3.4).
// One transaction per file. Only COMPLETE exports move listings toward removal, and removal needs two
// consecutive complete exports without the space (missing_once -> removed). Financial-decision source.
import { copyFileSync, mkdirSync, statSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import type { WarehouseDb } from '../db';
import type { LeaseMarketConfig } from '../../../src/contracts/lease-market';
import { daysBetween, priceObservation, splitAddress } from '../../../src/analytics/lease-market/normalize';
import { CostarParseError, parseCostarListingsFile, sha256File, type CostarHeaderMap, type ParsedCostarExport } from './costar-parse';
import type { OwnerScreenResult } from './owner-screen';

export interface IngestDeps {
  config: LeaseMarketConfig;
  headerMap: CostarHeaderMap;
  rawDir: string;
  now: () => string;
  screen: (names: string[]) => OwnerScreenResult;
}

export interface IngestResult {
  file: string;
  status: 'ingested' | 'duplicate' | 'failed';
  landingId: number | null;
  marketId: string | null;
  exportDate: string | null;
  completeness: 'complete' | 'partial' | null;
  partialReason: string | null;
  inserted: number;
  updated: number;
  skipped: number;
  markedMissing: number;
  markedRemoved: number;
  error: string | null;
}

const FILE_RE = /^costar-listings_([a-z0-9-]+)_(\d{4}-\d{2}-\d{2})\.(xlsx|csv)$/i;

export function parseListingFileName(name: string): { marketId: string; exportDate: string } | null {
  const m = FILE_RE.exec(name);
  return m ? { marketId: m[1]!.toLowerCase(), exportDate: m[2]! } : null;
}

export interface CompleteLanding {
  id: number;
  observed_at: string;
  row_count: number;
  header_fingerprint: string | null;
  owner_screen_ok: number;
}

export function latestCompleteLanding(db: WarehouseDb, marketId: string): CompleteLanding | undefined {
  return db
    .prepare(
      `SELECT id, observed_at, row_count, header_fingerprint, owner_screen_ok FROM lm_landing
       WHERE source = 'costar_listings' AND market_id = ? AND parse_status = 'ok' AND completeness = 'complete'
       ORDER BY observed_at DESC, id DESC LIMIT 1`,
    )
    .get(marketId) as CompleteLanding | undefined;
}

export async function ingestCostarListingsFile(db: WarehouseDb, filePath: string, deps: IngestDeps): Promise<IngestResult> {
  const file = basename(filePath);
  const result: IngestResult = {
    file, status: 'failed', landingId: null, marketId: null, exportDate: null, completeness: null, partialReason: null,
    inserted: 0, updated: 0, skipped: 0, markedMissing: 0, markedRemoved: 0, error: null,
  };
  const sha = sha256File(filePath);
  const dup = db.prepare(`SELECT id FROM lm_landing WHERE sha256 = ? AND parse_status = 'ok'`).get(sha) as { id: number } | undefined;
  if (dup) return { ...result, status: 'duplicate', landingId: dup.id };

  const fail = (marketId: string | null, observedAt: string, error: string): IngestResult => {
    const info = db
      .prepare(
        `INSERT INTO lm_landing (source, source_ref, sha256, market_id, observed_at, received_at, completeness, parse_status, parse_error)
         VALUES ('costar_listings', ?, ?, ?, ?, ?, 'n/a', 'failed', ?)`,
      )
      .run(file, sha, marketId, observedAt, deps.now(), error);
    return { ...result, landingId: Number(info.lastInsertRowid), marketId, exportDate: observedAt, error };
  };

  const fromName = parseListingFileName(file);
  const exportDate = fromName?.exportDate ?? statSync(filePath).mtime.toISOString().slice(0, 10);

  let parsed: ParsedCostarExport;
  try {
    parsed = await parseCostarListingsFile(filePath, deps.headerMap);
  } catch (e) {
    if (e instanceof CostarParseError) return fail(fromName?.marketId ?? null, exportDate, e.message);
    throw e;
  }

  let marketId = fromName?.marketId ?? null;
  if (marketId === null) {
    const ids = new Set<string>();
    for (const name of parsed.marketNames) {
      const m = deps.config.markets.find((mk) => mk.costarMarketNames.some((c) => c.toLowerCase() === name.toLowerCase()));
      if (!m) return fail(null, exportDate, `market "${name}" is not in any configured market's costarMarketNames`);
      ids.add(m.id);
    }
    if (ids.size !== 1) {
      return fail(
        null,
        exportDate,
        ids.size === 0
          ? 'cannot determine market: name the file costar-listings_<marketId>_<YYYY-MM-DD>.xlsx or map the market column'
          : `export spans ${ids.size} markets; export one market per file`,
      );
    }
    marketId = [...ids][0]!;
  }
  const market = deps.config.markets.find((m) => m.id === marketId);
  if (!market) return fail(marketId, exportDate, `market id "${marketId}" is not in config/lease-market.json`);

  const prior = latestCompleteLanding(db, marketId);
  if (prior && prior.header_fingerprint !== null && prior.header_fingerprint !== parsed.headerFingerprint) {
    return fail(marketId, exportDate, `header set changed vs landing #${prior.id}; update config/lease-market.costar-headers.json, then re-ingest`);
  }

  const t = deps.config.thresholds;
  const reasons: string[] = [];
  if (parsed.rowCount >= t.exportRowCap) reasons.push(`row count ${parsed.rowCount} at export cap ${t.exportRowCap}`);
  if (prior && parsed.rowCount < t.exportMinRowRatio * prior.row_count) {
    reasons.push(`row count ${parsed.rowCount} < ${t.exportMinRowRatio} x prior ${prior.row_count}`);
  }
  if (prior && exportDate <= prior.observed_at) reasons.push(`export date ${exportDate} not after last complete export ${prior.observed_at}`);
  const complete = reasons.length === 0;

  const screen = deps.screen(parsed.rows.flatMap((r) => (r.ownerName ? [r.ownerName] : [])));

  mkdirSync(deps.rawDir, { recursive: true });
  const rawPath = join(deps.rawDir, `${sha}${extname(filePath).toLowerCase()}`);
  copyFileSync(filePath, rawPath);

  const counts = { inserted: 0, updated: 0, skipped: parsed.skipped.length, markedMissing: 0, markedRemoved: 0 };
  let landingId = 0;

  const run = db.transaction(() => {
    const landing = db
      .prepare(
        `INSERT INTO lm_landing (source, source_ref, sha256, market_id, observed_at, received_at, file_path, row_count,
           header_fingerprint, completeness, partial_reason, owner_screen_ok, parse_status)
         VALUES ('costar_listings', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok')`,
      )
      .run(file, sha, marketId, exportDate, deps.now(), rawPath, parsed.rowCount, parsed.headerFingerprint,
        complete ? 'complete' : 'partial', complete ? null : reasons.join('; '), screen.available ? 1 : 0);
    landingId = Number(landing.lastInsertRowid);

    const findByCostarId = db.prepare('SELECT id FROM lm_listing WHERE costar_property_id = ? AND suite_norm = ?');
    const findByAddress = db.prepare('SELECT id FROM lm_listing WHERE address_norm = ? AND suite_norm = ?');
    const insertListing = db.prepare(
      `INSERT INTO lm_listing (costar_property_id, address_norm, suite_norm, address_display, city, state, market_id, submarket,
         subtype, building_status, building_sf, year_built, clear_height_ft, docks, drive_ins, office_pct, owner_name, owner_type,
         ora_property_key, first_seen, last_seen, first_landing_id, costar_date_on_market, status, origin_tier)
       VALUES (@costarPropertyId, @addressNorm, @suiteNorm, @addressDisplay, @city, @state, @marketId, @submarket,
         @subtype, @buildingStatus, @buildingSf, @yearBuilt, @clearHeightFt, @docks, @driveIns, @officePct, @ownerName, @ownerType,
         @oraPropertyKey, @seen, @seen, @landingId, @dateOnMarket, 'active', 'T1')`,
    );
    const updateListing = db.prepare(
      `UPDATE lm_listing SET
         costar_property_id = COALESCE(@costarPropertyId, costar_property_id),
         address_display = @addressDisplay,
         city = COALESCE(@city, city), state = COALESCE(@state, state), submarket = COALESCE(@submarket, submarket),
         subtype = @subtype, building_status = @buildingStatus,
         building_sf = COALESCE(@buildingSf, building_sf), year_built = COALESCE(@yearBuilt, year_built),
         clear_height_ft = COALESCE(@clearHeightFt, clear_height_ft), docks = COALESCE(@docks, docks),
         drive_ins = COALESCE(@driveIns, drive_ins), office_pct = COALESCE(@officePct, office_pct),
         owner_name = COALESCE(@ownerName, owner_name),
         owner_type = CASE WHEN @ownerName IS NULL THEN owner_type ELSE @ownerType END,
         ora_property_key = @oraPropertyKey,
         last_seen = MAX(last_seen, @seen),
         costar_date_on_market = CASE
           WHEN costar_date_on_market IS NULL THEN @dateOnMarket
           WHEN @dateOnMarket IS NULL THEN costar_date_on_market
           ELSE MIN(costar_date_on_market, @dateOnMarket) END,
         status = 'active', removed_at = NULL, origin_tier = 'T1'
       WHERE id = @id`,
    );
    const insertObservation = db.prepare(
      `INSERT INTO lm_observation (listing_id, landing_id, observed_at, available_sf, min_divisible_sf, rent_low, rent_high,
         rent_period, rent_basis, is_sublease, asking_psf_yr, asking_nnn_eq, opex_est_psf, opex_source, costar_dom, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const seen = new Set<number>();
    for (const row of parsed.rows) {
      const { addressNorm, suiteNorm } = splitAddress(row.address, row.suite);
      const hit = ((row.costarPropertyId ? findByCostarId.get(row.costarPropertyId, suiteNorm) : undefined) ??
        findByAddress.get(addressNorm, suiteNorm)) as { id: number } | undefined;
      if (hit && seen.has(hit.id)) {
        counts.skipped++;
        continue;
      }
      const oraProperty = deps.config.oraProperties.find((p) => p.addressNorms.includes(addressNorm));
      const opex = market.opexDefaults[row.subtype];
      const priced = priceObservation(
        { rentLow: row.rentLow, rentHigh: row.rentHigh, rentPeriod: row.rentPeriod, rentBasis: row.rentBasis },
        opex,
        market.mgLandlordPays,
        t,
      );
      const listingFields = {
        costarPropertyId: row.costarPropertyId,
        addressDisplay: row.suite ? `${row.address} ${row.suite}` : row.address,
        city: row.city,
        state: row.state,
        submarket: row.submarket,
        subtype: row.subtype,
        buildingStatus: row.buildingStatus,
        buildingSf: row.buildingSf,
        yearBuilt: row.yearBuilt,
        clearHeightFt: row.clearHeightFt,
        docks: row.docks,
        driveIns: row.driveIns,
        officePct: row.officePct,
        ownerName: row.ownerName,
        ownerType: row.ownerName ? (screen.types.get(row.ownerName.trim()) ?? 'unknown') : 'unknown',
        oraPropertyKey: oraProperty?.propertyKey ?? null,
        seen: exportDate,
        dateOnMarket: row.costarDateOnMarket,
      };
      let listingId: number;
      if (hit) {
        updateListing.run({ ...listingFields, id: hit.id });
        listingId = hit.id;
        counts.updated++;
      } else {
        listingId = Number(insertListing.run({ ...listingFields, addressNorm, suiteNorm, marketId, landingId }).lastInsertRowid);
        counts.inserted++;
      }
      seen.add(listingId);
      const costarDom = row.costarDateOnMarket ? Math.max(0, daysBetween(row.costarDateOnMarket, exportDate)) : null;
      insertObservation.run(
        listingId, landingId, exportDate, row.availableSf, row.minDivisibleSf, row.rentLow, row.rentHigh, row.rentPeriod,
        priced.effectiveBasis, row.isSublease ? 1 : 0, priced.askingPsfYr, priced.askingNnnEq, priced.opexEstPsf,
        opex && priced.opexEstPsf !== null ? opex.source : null, costarDom, priced.confidence,
      );
    }

    if (complete) {
      const tracked = db
        .prepare(`SELECT id, status FROM lm_listing WHERE market_id = ? AND origin_tier = 'T1' AND status IN ('active', 'missing_once')`)
        .all(marketId) as Array<{ id: number; status: 'active' | 'missing_once' }>;
      const toMissing = db.prepare(`UPDATE lm_listing SET status = 'missing_once' WHERE id = ?`);
      const toRemoved = db.prepare(`UPDATE lm_listing SET status = 'removed', removed_at = ? WHERE id = ?`);
      for (const l of tracked) {
        if (seen.has(l.id)) continue;
        if (l.status === 'active') {
          toMissing.run(l.id);
          counts.markedMissing++;
        } else {
          toRemoved.run(exportDate, l.id);
          counts.markedRemoved++;
        }
      }
    }
  });
  run();

  return {
    ...result,
    status: 'ingested',
    landingId,
    marketId,
    exportDate,
    completeness: complete ? 'complete' : 'partial',
    partialReason: complete ? null : reasons.join('; '),
    ...counts,
  };
}
```

If better-sqlite3 rejects an object carrying named keys a statement does not use, the two objects above already pass exactly the keys each statement names (`insertListing` gets `addressNorm/suiteNorm/marketId/landingId`; `updateListing` gets `id`) — keep it that way.

The partial-reason text uses `x` (not `×`); the test regex `/row count 1 < 0.7/` matches it.

- [ ] **Step 5: Run tests, typecheck, lint**

Run: `npx vitest run tests/unit/lease-market-ingest.test.ts && npm run typecheck && npx eslint server/warehouse/lease-market tests/unit/lease-market-ingest.test.ts --max-warnings 0`
Expected: PASS / clean.

- [ ] **Step 6: Commit**

```bash
git add server/warehouse/lease-market/config.ts server/warehouse/lease-market/ingest.ts tests/unit/lease-market-ingest.test.ts
git commit -F <message-file>   # "feat(warehouse): CoStar listing ingest with completeness gating and two-strike removal"
```
