### Task 09: Config loaders + CoStar listings ingest (property/space identity, observations, events, completeness, removal)

**Files:**
- Create: `server/warehouse/lease-market/config.ts`
- Create: `server/warehouse/lease-market/ingest.ts`
- Test: `tests/unit/lease-market-ingest.test.ts`

**Interfaces:**
- Consumes: Task 01 tables; Task 02 config types; Task 03 `splitAddress`, `priceObservation`, `resolveOpex`, `daysBetween`, `addDays`; Task 07 `CostarHeaderMap`, `CostarParseError`, `parseCostarListingsFile`, `sha256File`, `ParsedCostarExport`; Task 08 `OwnerScreenResult`; `WarehouseDb`, `openWarehouse`.
- Produces:
  - config.ts: `expandHome`, `defaultConfigPath()`, `defaultHeaderMapPath()`, `loadLeaseMarketConfig(path?)` (expands `~` in `ownerScreenModulePath`), `loadCostarHeaderMap(path?)` — identical to rev 1 (`git show a4f075a:docs/superpowers/plans/2026-09-16-lease-market-p1/08-ingest.md`).
  - ingest.ts: `IngestDeps { config; headerMap; rawDir; now: () => string; screen: (names: string[]) => OwnerScreenResult }`
  - `IngestResult { file; status: 'ingested'|'duplicate'|'failed'; landingId; marketId; exportDate; completeness: 'complete'|'partial'|null; partialReason; insertedSpaces; updatedSpaces; newProperties; skipped; markedMissing; markedRemoved; events: Record<ListingEventKind, number>; error }`
  - `parseListingFileName(name): { marketId; exportDate } | null` — `costar-listings_<marketId>_<YYYY-MM-DD>.(xlsx|csv)`
  - `CompleteLanding { id; observed_at; row_count; header_fingerprint; owner_screen_ok }` and `latestCompleteLanding(db, marketId): CompleteLanding | undefined`
  - `ingestCostarListingsFile(db, filePath, deps): Promise<IngestResult>`

**Rules (spec rev 3 §3.1–3.5):** Pre-flight exactly as rev 1 (sha dup ⇒ duplicate; parse error ⇒ failed landing, retry allowed; market from file name else market column via `costarMarketNames`, exactly one; export date from file name else mtime; header fingerprint change ⇒ failed; completeness reasons row cap / 0.7 × prior / date not after prior). **New:** a market with `enabled: false` ⇒ failed landing `market "<id>" is not enabled … (Columbus-first validation gate)`. Opex estimate per subtype = `resolveOpex(market.opexDefaults[subtype], quoted values, quotedOpexMinN)` where quoted values = this market's `opex_quoted_psf` observations of that subtype in the trailing 365 days **plus** this file's rows. **Property identity:** CoStar property id ▸ `address_norm`; insert or update (COALESCE physical fields, overwrite subtype/status, owner type only when the row has an owner, `ora_property_key` from config `addressNorms`, `last_seen` = max). **Space identity:** property + `suite_norm`; a second row for an already-seen space in the same file ⇒ `skipped`. Space update: `last_seen` max, earliest `costar_date_on_market`, status `active`, `removed_at` null, broker/URL/description COALESCE. **Events:** `new` for a new space (new_value = asking NNN-eq); `returned` when the space was `removed`; versus the space's previous observation: `price_cut` / `price_increase` on asking NNN-eq when both present, else on `rent_low` when both present and neither row is a total quote (> $0.005); `sf_change` when |Δ available SF| ÷ previous ≥ `sfChangePct`; `dom_reset` when CoStar DOM decreased. **Removal** (complete exports only, spaces of properties in this market with origin T1): unseen `active` ⇒ `missing_once` + `missing` event; unseen `missing_once` ⇒ `removed` (removed_at = export date) + `removed` event. One transaction per file.

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

function setup(deps: Partial<IngestDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lm-ingest-'));
  const db: WarehouseDb = openWarehouse(join(dir, 'test.sqlite'));
  const full: IngestDeps = { config: testConfig(), headerMap: testHeaderMap(), rawDir: join(dir, 'raw'), now: () => '2026-03-02T00:00:00Z', screen: stubScreen, ...deps };
  return { dir, db, deps: full };
}
const FOUR: FixtureListing[] = [
  { id: 'C1', address: '10 Alpha Rd', sf: 12000, rentLow: 8.5, dateOnMarket: '2025-10-01' },
  { id: 'C2', address: '20 Beta Dr', sf: 20000, owner: 'PROLOGIS FUND LP' },
  { address: '1100 Rarig Avenue', suite: 'B', sf: 8000, owner: 'OXFORD RARIG LLC' },
  { address: '1100 Rarig Avenue', suite: 'C', sf: 6000, owner: 'OXFORD RARIG LLC' },
];
const spaceStatus = (db: WarehouseDb, address: string) =>
  (db.prepare('SELECT l.status FROM lm_listing l JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = ?').get(address) as { status: string }).status;
const eventsFor = (db: WarehouseDb, address: string) =>
  db.prepare('SELECT e.kind, e.prev_value, e.new_value, e.event_date FROM lm_listing_event e JOIN lm_listing l ON l.id = e.listing_id JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = ? ORDER BY e.id').all(address);

describe('parseListingFileName', () => {
  it('reads market and date', () => {
    expect(parseListingFileName('costar-listings_kansas-city_2026-03-01.xlsx')).toEqual({ marketId: 'kansas-city', exportDate: '2026-03-01' });
    expect(parseListingFileName('Export (3).xlsx')).toBeNull();
  });
});

describe('ingestCostarListingsFile', () => {
  it('first export: properties vs spaces, ORA match, owner types, pricing, new events', async () => {
    const { dir, db, deps } = setup();
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', FOUR), deps);
    expect(r).toMatchObject({ status: 'ingested', marketId: 'columbus', completeness: 'complete', insertedSpaces: 4, updatedSpaces: 0, newProperties: 3 });
    expect(r.events.new).toBe(4);
    expect((db.prepare('SELECT COUNT(*) AS n FROM lm_property').get() as { n: number }).n).toBe(3);
    expect(db.prepare("SELECT ora_property_key, owner_type, lat, lon, zip FROM lm_property WHERE address_norm = '1100 RARIG AVE'").get()).toEqual({ ora_property_key: '1100 Rarig', owner_type: 'affiliated', lat: 39.99, lon: -82.93, zip: '43219' });
    expect((db.prepare("SELECT owner_type FROM lm_property WHERE address_norm = '20 BETA DR'").get() as { owner_type: string }).owner_type).toBe('institutional');
    expect(db.prepare("SELECT o.asking_nnn_eq, o.confidence, o.costar_dom, o.source_row, l.broker_name FROM lm_observation o JOIN lm_listing l ON l.id = o.listing_id JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = '10 ALPHA RD'").get())
      .toEqual({ asking_nnn_eq: 8.5, confidence: 'high', costar_dom: 92, source_row: 2, broker_name: 'Pat Broker' });
    expect(db.prepare('SELECT owner_screen_ok, completeness, row_count, skipped_count FROM lm_landing WHERE id = ?').get(r.landingId)).toEqual({ owner_screen_ok: 1, completeness: 'complete', row_count: 4, skipped_count: 0 });
  });

  it('identical bytes are a duplicate', async () => {
    const { dir, db, deps } = setup();
    const f = await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', FOUR);
    await ingestCostarListingsFile(db, f, deps);
    expect((await ingestCostarListingsFile(db, f, deps)).status).toBe('duplicate');
  });

  it('records price, size and DOM-reset events and keeps the earliest CoStar date', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', FOUR), deps);
    const next = FOUR.map((l) => (l.id === 'C1' ? { ...l, rentLow: 8.0, dateOnMarket: '2026-01-20' } : l.id === 'C2' ? { ...l, sf: 15000, rentLow: 9.5 } : l));
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', next), deps);
    expect(r.events).toMatchObject({ price_cut: 1, price_increase: 1, sf_change: 1, dom_reset: 1 });
    expect(eventsFor(db, '10 ALPHA RD')).toEqual([
      { kind: 'new', prev_value: null, new_value: 8.5, event_date: '2026-01-01' },
      { kind: 'price_cut', prev_value: 8.5, new_value: 8, event_date: '2026-02-01' },
      { kind: 'dom_reset', prev_value: 92, new_value: 12, event_date: '2026-02-01' },
    ]);
    expect(eventsFor(db, '20 BETA DR').map((e) => (e as { kind: string }).kind)).toEqual(['new', 'price_increase', 'sf_change']);
    expect((db.prepare("SELECT l.costar_date_on_market AS d FROM lm_listing l JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = '10 ALPHA RD'").get() as { d: string }).d).toBe('2025-10-01');
    const m = db.prepare("SELECT reduction_count, original_asking, current_asking FROM lm_v_listing_metrics v JOIN lm_listing l ON l.id = v.listing_id JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = '10 ALPHA RD'").get();
    expect(m).toEqual({ reduction_count: 1, original_asking: 8.5, current_asking: 8 });
  });

  it('two-strike removal with missing/removed/returned events', async () => {
    const { dir, db, deps } = setup();
    const extra: FixtureListing = { address: '40 Delta Pkwy', sf: 5000 };
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', FOUR), deps);
    const noBeta = FOUR.filter((l) => l.id !== 'C2');
    expect(await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [...noBeta, extra]), deps)).toMatchObject({ markedMissing: 1, markedRemoved: 0 });
    expect(spaceStatus(db, '20 BETA DR')).toBe('missing_once');
    expect(await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-03-01.xlsx', [...noBeta, extra]), deps)).toMatchObject({ markedRemoved: 1 });
    expect(spaceStatus(db, '20 BETA DR')).toBe('removed');
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-04-01.xlsx', [...FOUR, extra]), deps);
    expect(spaceStatus(db, '20 BETA DR')).toBe('active');
    expect(eventsFor(db, '20 BETA DR').map((e) => (e as { kind: string }).kind)).toEqual(['new', 'missing', 'removed', 'returned']);
  });

  it('partial exports change no statuses', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', FOUR), deps);
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [FOUR[0]!]), deps);
    expect(r).toMatchObject({ completeness: 'partial', markedMissing: 0 });
    expect(r.partialReason).toMatch(/row count 1 < 0.7/);
    expect(spaceStatus(db, '20 BETA DR')).toBe('active');
    const capped = setup({ config: testConfig({ thresholds: { ...testConfig().thresholds, exportRowCap: 4 } }) });
    expect((await ingestCostarListingsFile(capped.db, await writeCostarFixture(capped.dir, 'costar-listings_columbus_2026-01-01.xlsx', FOUR), capped.deps)).partialReason).toMatch(/export cap 4/);
  });

  it('fails on header change, disabled market, and pending map; retries after the fix', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', FOUR), deps);
    expect(await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', FOUR, { extraHeader: 'Notes' }), deps)).toMatchObject({ status: 'failed', error: expect.stringMatching(/header set changed/) });
    const disabled = testConfig();
    disabled.markets = disabled.markets.map((m) => (m.id === 'madison' ? { ...m, enabled: false } : m));
    const mad = await writeCostarFixture(dir, 'costar-listings_madison_2026-01-01.xlsx', [{ address: '5 Lake St', sf: 3000, market: 'Madison' }]);
    expect(await ingestCostarListingsFile(db, mad, { ...deps, config: disabled })).toMatchObject({ status: 'failed', error: expect.stringMatching(/not enabled/) });
    expect((await ingestCostarListingsFile(db, mad, { ...deps, headerMap: testHeaderMap({ status: 'pending-sample' }) })).status).toBe('failed');
    expect((await ingestCostarListingsFile(db, mad, deps)).status).toBe('ingested');
  });

  it('infers the market from the market column; rejects multi-market files', async () => {
    const { dir, db, deps } = setup();
    expect((await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'Export.xlsx', [{ address: '5 Lake St', sf: 3000, market: 'Madison' }]), deps)).marketId).toBe('madison');
    const mixed = await writeCostarFixture(dir, 'Export2.xlsx', [{ address: '6 Lake St', sf: 3000, market: 'Madison' }, { address: '7 Oak St', sf: 3000, market: 'Columbus' }]);
    expect((await ingestCostarListingsFile(db, mixed, deps)).error).toMatch(/spans 2 markets/);
  });

  it('records owner_screen_ok = 0 when the screen is unavailable', async () => {
    const { dir, db, deps } = setup({ screen: (names) => ({ ...stubScreen(names), available: false }) });
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', FOUR), deps);
    expect((db.prepare('SELECT owner_screen_ok FROM lm_landing WHERE id = ?').get(r.landingId) as { owner_screen_ok: number }).owner_screen_ok).toBe(0);
  });

  it('converts gross quotes with the market quoted-opex median when no default exists', async () => {
    const config = testConfig();
    config.markets = config.markets.map((m) => ({ ...m, opexDefaults: { warehouse: null, flex: null } }));
    const base = testHeaderMap();
    const headerMap = testHeaderMap({ fields: { ...base.fields, rentText: 'Rent Low', rentLow: null, rentHigh: null, rentBasis: null } });
    const { dir, db, deps } = setup({ config, headerMap });
    const nnnWithOpex: FixtureListing[] = [1.8, 1.9, 2.0, 2.1, 2.2].map((opex, i) => ({ address: `${i + 1} Opex Ln`, sf: 10000, rentLow: `$7.00/SF/YR + $${opex.toFixed(2)} NNN`, rentType: null }));
    const gross: FixtureListing = { address: '99 Gross Way', sf: 10000, rentLow: '$11.00/SF/YR Gross', rentType: null };
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', [...nnnWithOpex, gross]), deps);
    expect(db.prepare("SELECT o.rent_basis, o.asking_nnn_eq, o.opex_est_psf, o.opex_source, o.confidence FROM lm_observation o JOIN lm_listing l ON l.id = o.listing_id JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = '99 GROSS WAY'").get())
      .toEqual({ rent_basis: 'GROSS', asking_nnn_eq: 9, opex_est_psf: 2, opex_source: 'quoted-market-median n=5', confidence: 'low' });
  });

  it('keeps out-of-bounds rents as UNKNOWN with a reason', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', [{ address: '1 Big Num St', sf: 16000, rentLow: 12000 }]), deps);
    expect(db.prepare('SELECT rent_basis, asking_nnn_eq, rejected_reason FROM lm_observation').get()).toEqual({ rent_basis: 'UNKNOWN', asking_nnn_eq: null, rejected_reason: expect.stringMatching(/outside/) });
  });
});
```

- [ ] **Step 2:** `npx vitest run tests/unit/lease-market-ingest.test.ts` — Expected: FAIL.

- [ ] **Step 3: Write config.ts** — copy rev 1 verbatim.

- [ ] **Step 4: Write ingest.ts**

The pre-flight half (through `copyFileSync`) is the rev 1 code with two changes: after resolving `market`, add

```ts
  if (!market.enabled) {
    return fail(marketId, exportDate, `market "${marketId}" is not enabled in config/lease-market.json (Columbus-first validation gate)`);
  }
```

and add `skipped_count` to the landing insert. The rest replaces the rev 1 transaction:

```ts
// server/warehouse/lease-market/ingest.ts (transaction half)
import type { ListingEventKind, LmSubtype } from '../../../src/contracts/lease-market';
import { addDays, daysBetween, priceObservation, resolveOpex, splitAddress, type OpexEstimate } from '../../../src/analytics/lease-market/normalize';

const EVENT_KINDS: readonly ListingEventKind[] = ['new', 'returned', 'price_cut', 'price_increase', 'sf_change', 'dom_reset', 'missing', 'removed'];
const CENT = 0.005;

  // … after completeness, screen, raw copy (rev 1) …

  const quotedRows = db
    .prepare(
      `SELECT p.subtype AS subtype, o.opex_quoted_psf AS v FROM lm_observation o
       JOIN lm_listing l ON l.id = o.listing_id JOIN lm_property p ON p.id = l.property_id
       WHERE p.market_id = ? AND o.opex_quoted_psf IS NOT NULL AND o.observed_at >= ?`,
    )
    .all(marketId, addDays(exportDate, -365)) as Array<{ subtype: LmSubtype; v: number }>;
  const quoted: Record<LmSubtype, number[]> = { warehouse: [], flex: [] };
  for (const q of quotedRows) quoted[q.subtype].push(q.v);
  for (const r of parsed.rows) if (r.opexQuotedPsf !== null) quoted[r.subtype].push(r.opexQuotedPsf);
  const opexBySubtype: Record<LmSubtype, OpexEstimate | null> = {
    warehouse: resolveOpex(market.opexDefaults.warehouse, quoted.warehouse, t.quotedOpexMinN),
    flex: resolveOpex(market.opexDefaults.flex, quoted.flex, t.quotedOpexMinN),
  };

  const events = Object.fromEntries(EVENT_KINDS.map((k) => [k, 0])) as Record<ListingEventKind, number>;
  const counts = { insertedSpaces: 0, updatedSpaces: 0, newProperties: 0, skipped: parsed.skipped.length, markedMissing: 0, markedRemoved: 0 };
  let landingId = 0;

  db.transaction(() => {
    landingId = Number(
      db.prepare(
        `INSERT INTO lm_landing (source, source_ref, sha256, market_id, observed_at, received_at, file_path, row_count, skipped_count,
           header_fingerprint, completeness, partial_reason, owner_screen_ok, parse_status)
         VALUES ('costar_listings', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'ok')`,
      ).run(file, sha, marketId, exportDate, deps.now(), rawPath, parsed.rowCount, parsed.skipped.length, parsed.headerFingerprint,
        complete ? 'complete' : 'partial', complete ? null : reasons.join('; '), screen.available ? 1 : 0).lastInsertRowid,
    );

    const findPropertyByCostarId = db.prepare('SELECT id FROM lm_property WHERE costar_property_id = ? ORDER BY id LIMIT 1');
    const findPropertyByAddress = db.prepare('SELECT id FROM lm_property WHERE address_norm = ?');
    const insertProperty = db.prepare(
      `INSERT INTO lm_property (costar_property_id, address_norm, address_display, city, state, zip, lat, lon, market_id, submarket, subtype,
         building_status, building_sf, year_built, clear_height_ft, docks, drive_ins, office_pct, owner_name, owner_type, ora_property_key, first_seen, last_seen)
       VALUES (@costarPropertyId, @addressNorm, @addressDisplay, @city, @state, @zip, @lat, @lon, @marketId, @submarket, @subtype,
         @buildingStatus, @buildingSf, @yearBuilt, @clearHeightFt, @docks, @driveIns, @officePct, @ownerName, @ownerType, @oraPropertyKey, @seen, @seen)`,
    );
    const updateProperty = db.prepare(
      `UPDATE lm_property SET
         costar_property_id = COALESCE(@costarPropertyId, costar_property_id), address_display = @addressDisplay,
         city = COALESCE(@city, city), state = COALESCE(@state, state), zip = COALESCE(@zip, zip),
         lat = COALESCE(@lat, lat), lon = COALESCE(@lon, lon), submarket = COALESCE(@submarket, submarket),
         subtype = @subtype, building_status = @buildingStatus,
         building_sf = COALESCE(@buildingSf, building_sf), year_built = COALESCE(@yearBuilt, year_built),
         clear_height_ft = COALESCE(@clearHeightFt, clear_height_ft), docks = COALESCE(@docks, docks),
         drive_ins = COALESCE(@driveIns, drive_ins), office_pct = COALESCE(@officePct, office_pct),
         owner_name = COALESCE(@ownerName, owner_name),
         owner_type = CASE WHEN @ownerName IS NULL THEN owner_type ELSE @ownerType END,
         ora_property_key = COALESCE(@oraPropertyKey, ora_property_key),
         last_seen = MAX(last_seen, @seen)
       WHERE id = @id`,
    );
    const findSpace = db.prepare('SELECT id, status FROM lm_listing WHERE property_id = ? AND suite_norm = ?');
    const insertSpace = db.prepare(
      `INSERT INTO lm_listing (property_id, suite_norm, first_seen, last_seen, first_landing_id, costar_date_on_market, status, origin_tier,
         broker_name, broker_company, listing_url, description)
       VALUES (@propertyId, @suiteNorm, @seen, @seen, @landingId, @dateOnMarket, 'active', 'T1', @brokerName, @brokerCompany, @listingUrl, @description)`,
    );
    const updateSpace = db.prepare(
      `UPDATE lm_listing SET
         last_seen = MAX(last_seen, @seen),
         costar_date_on_market = CASE WHEN costar_date_on_market IS NULL THEN @dateOnMarket WHEN @dateOnMarket IS NULL THEN costar_date_on_market
                                      ELSE MIN(costar_date_on_market, @dateOnMarket) END,
         status = 'active', removed_at = NULL, origin_tier = 'T1',
         broker_name = COALESCE(@brokerName, broker_name), broker_company = COALESCE(@brokerCompany, broker_company),
         listing_url = COALESCE(@listingUrl, listing_url), description = COALESCE(@description, description)
       WHERE id = @id`,
    );
    const previousObservation = db.prepare(
      'SELECT asking_nnn_eq, rent_low, rent_is_total, available_sf, costar_dom FROM lm_observation WHERE listing_id = ? ORDER BY observed_at DESC, id DESC LIMIT 1',
    );
    const insertObservation = db.prepare(
      `INSERT INTO lm_observation (listing_id, landing_id, observed_at, source_row, available_sf, min_divisible_sf, rent_low, rent_high, rent_period,
         rent_is_total, rent_basis, is_sublease, asking_psf_yr, asking_nnn_eq, opex_quoted_psf, opex_est_psf, opex_source, costar_dom, confidence, rejected_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEvent = db.prepare('INSERT INTO lm_listing_event (listing_id, landing_id, event_date, kind, prev_value, new_value) VALUES (?, ?, ?, ?, ?, ?)');
    const event = (listingId: number, kind: ListingEventKind, prev: number | null, next: number | null) => {
      insertEvent.run(listingId, landingId, exportDate, kind, prev, next);
      events[kind]++;
    };

    const seenSpaces = new Set<number>();
    for (const row of parsed.rows) {
      const { addressNorm, suiteNorm } = splitAddress(row.address, row.suite);
      const oraProperty = deps.config.oraProperties.find((p) => p.addressNorms.includes(addressNorm));
      const propertyFields = {
        costarPropertyId: row.costarPropertyId, addressDisplay: row.address, city: row.city, state: row.state, zip: row.zip,
        lat: row.lat, lon: row.lon, submarket: row.submarket, subtype: row.subtype, buildingStatus: row.buildingStatus,
        buildingSf: row.buildingSf, yearBuilt: row.yearBuilt, clearHeightFt: row.clearHeightFt, docks: row.docks, driveIns: row.driveIns,
        officePct: row.officePct, ownerName: row.ownerName,
        ownerType: row.ownerName ? (screen.types.get(row.ownerName.trim()) ?? 'unknown') : 'unknown',
        oraPropertyKey: oraProperty?.propertyKey ?? null, seen: exportDate,
      };
      const propertyHit = ((row.costarPropertyId ? findPropertyByCostarId.get(row.costarPropertyId) : undefined) ??
        findPropertyByAddress.get(addressNorm)) as { id: number } | undefined;
      let propertyId: number;
      if (propertyHit) {
        updateProperty.run({ ...propertyFields, id: propertyHit.id });
        propertyId = propertyHit.id;
      } else {
        propertyId = Number(insertProperty.run({ ...propertyFields, addressNorm, marketId }).lastInsertRowid);
        counts.newProperties++;
      }

      const spaceHit = findSpace.get(propertyId, suiteNorm) as { id: number; status: string } | undefined;
      if (spaceHit && seenSpaces.has(spaceHit.id)) {
        counts.skipped++;
        continue;
      }
      const prev = spaceHit
        ? (previousObservation.get(spaceHit.id) as { asking_nnn_eq: number | null; rent_low: number | null; rent_is_total: number; available_sf: number; costar_dom: number | null } | undefined)
        : undefined;
      const spaceFields = {
        seen: exportDate, dateOnMarket: row.costarDateOnMarket, brokerName: row.brokerName, brokerCompany: row.brokerCompany,
        listingUrl: row.listingUrl, description: row.description,
      };
      let listingId: number;
      if (spaceHit) {
        updateSpace.run({ ...spaceFields, id: spaceHit.id });
        listingId = spaceHit.id;
        counts.updatedSpaces++;
      } else {
        listingId = Number(insertSpace.run({ ...spaceFields, propertyId, suiteNorm, landingId }).lastInsertRowid);
        counts.insertedSpaces++;
      }
      seenSpaces.add(listingId);

      const opex = opexBySubtype[row.subtype];
      const priced = priceObservation(
        { rentLow: row.rentLow, rentHigh: row.rentHigh, rentPeriod: row.rentPeriod, rentBasis: row.rentBasis, rentIsTotal: row.rentIsTotal, availableSf: row.availableSf },
        opex, market.mgLandlordPays, t,
      );
      const costarDom = row.costarDateOnMarket ? Math.max(0, daysBetween(row.costarDateOnMarket, exportDate)) : null;
      insertObservation.run(
        listingId, landingId, exportDate, row.sourceRow, row.availableSf, row.minDivisibleSf, row.rentLow, row.rentHigh, row.rentPeriod,
        row.rentIsTotal ? 1 : 0, priced.effectiveBasis, row.isSublease ? 1 : 0, priced.askingPsfYr, priced.askingNnnEq, row.opexQuotedPsf,
        priced.opexEstPsf, priced.opexSource, costarDom, priced.confidence, priced.rejectedReason,
      );

      if (!spaceHit) {
        event(listingId, 'new', null, priced.askingNnnEq);
        continue;
      }
      if (spaceHit.status === 'removed') event(listingId, 'returned', null, priced.askingNnnEq);
      if (prev) {
        let before: number | null = null;
        let after: number | null = null;
        if (prev.asking_nnn_eq !== null && priced.askingNnnEq !== null) {
          before = prev.asking_nnn_eq;
          after = priced.askingNnnEq;
        } else if (prev.rent_low !== null && row.rentLow !== null && prev.rent_is_total === 0 && !row.rentIsTotal) {
          before = prev.rent_low;
          after = row.rentLow;
        }
        if (before !== null && after !== null) {
          if (after < before - CENT) event(listingId, 'price_cut', before, after);
          else if (after > before + CENT) event(listingId, 'price_increase', before, after);
        }
        if (prev.available_sf > 0 && Math.abs(row.availableSf - prev.available_sf) / prev.available_sf >= t.sfChangePct) {
          event(listingId, 'sf_change', prev.available_sf, row.availableSf);
        }
        if (prev.costar_dom !== null && costarDom !== null && costarDom < prev.costar_dom) event(listingId, 'dom_reset', prev.costar_dom, costarDom);
      }
    }

    if (complete) {
      const tracked = db
        .prepare(
          `SELECT l.id, l.status FROM lm_listing l JOIN lm_property p ON p.id = l.property_id
           WHERE p.market_id = ? AND l.origin_tier = 'T1' AND l.status IN ('active', 'missing_once')`,
        )
        .all(marketId) as Array<{ id: number; status: 'active' | 'missing_once' }>;
      const toMissing = db.prepare(`UPDATE lm_listing SET status = 'missing_once' WHERE id = ?`);
      const toRemoved = db.prepare(`UPDATE lm_listing SET status = 'removed', removed_at = ? WHERE id = ?`);
      for (const l of tracked) {
        if (seenSpaces.has(l.id)) continue;
        if (l.status === 'active') {
          toMissing.run(l.id);
          event(l.id, 'missing', null, null);
          counts.markedMissing++;
        } else {
          toRemoved.run(exportDate, l.id);
          event(l.id, 'removed', null, null);
          counts.markedRemoved++;
        }
      }
    }
  })();

  return {
    ...result, status: 'ingested', landingId, marketId, exportDate,
    completeness: complete ? 'complete' : 'partial', partialReason: complete ? null : reasons.join('; '),
    ...counts, events,
  };
```

`result` (the rev 1 failed-result template) must carry the new fields: `insertedSpaces: 0, updatedSpaces: 0, newProperties: 0, skipped: 0, markedMissing: 0, markedRemoved: 0, events: <all kinds 0>`. The named-parameter objects pass exactly the keys each statement uses (`insertProperty` adds `addressNorm`, `marketId`; `updateProperty` adds `id`; `insertSpace` adds `propertyId`, `suiteNorm`, `landingId`; `updateSpace` adds `id`) — keep it that way.

- [ ] **Step 5:** `npx vitest run tests/unit/lease-market-ingest.test.ts && npm run typecheck && npx eslint server/warehouse/lease-market tests/unit/lease-market-ingest.test.ts --max-warnings 0` — Expected: PASS / clean.

- [ ] **Step 6: Commit** — `git add server/warehouse/lease-market/config.ts server/warehouse/lease-market/ingest.ts tests/unit/lease-market-ingest.test.ts` ("feat(warehouse): CoStar ingest with property/space identity, events and two-strike removal").
