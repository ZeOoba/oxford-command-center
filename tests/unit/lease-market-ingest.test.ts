// tests/unit/lease-market-ingest.test.ts
import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse, type WarehouseDb } from '../../server/warehouse/db';
import { ingestCostarListingsFile, parseListingFileName, type IngestDeps } from '../../server/warehouse/lease-market/ingest';
import { stubScreen, testConfig, testHeaderMap, writeCostarFixture, type FixtureListing } from './lease-market-fixtures';

function setup(deps: Partial<IngestDeps> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lm-ingest-'));
  const db: WarehouseDb = openWarehouse(join(dir, 'test.sqlite'));
  // Far beyond every export date used by a test that doesn't override `now` itself (the latest is
  // 2026-06-01) — the A4 future-date-landing check (deps.now() + 1 day) must never trip on these
  // multi-export narratives, which only care about the export dates marching forward, not about "now".
  const full: IngestDeps = { config: testConfig(), headerMap: testHeaderMap(), rawDir: join(dir, 'raw'), now: () => '2026-12-31T00:00:00Z', screen: stubScreen, ...deps };
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

  it('a header change degrades to partial (no lockout); the same new header can go complete again', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', FOUR), deps);
    const changed = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', FOUR, { extraHeader: 'Notes' }), deps);
    expect(changed).toMatchObject({ status: 'ingested', completeness: 'partial', markedMissing: 0, markedRemoved: 0 });
    expect(changed.partialReason).toMatch(/header set changed vs landing #\d+ \(mapped columns verified by parser\)/);
    expect(spaceStatus(db, '20 BETA DR')).toBe('active');
    const noBeta = FOUR.filter((l) => l.id !== 'C2');
    const r3 = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-03-01.xlsx', [...noBeta, { address: '40 Delta Pkwy', sf: 5000 }], { extraHeader: 'Notes' }), deps);
    expect(r3).toMatchObject({ status: 'ingested', completeness: 'complete', markedMissing: 1 });
    expect(spaceStatus(db, '20 BETA DR')).toBe('missing_once');
  });

  it('fails on disabled market and pending map; retries after the fix', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', FOUR), deps);
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

  // ── Fix round 1 ──────────────────────────────────────────────────────────

  it('does not fire a price event when NNN-eq drifts only because the opex median moved (opex-drift guard)', async () => {
    const config = testConfig();
    config.markets = config.markets.map((m) => ({ ...m, opexDefaults: { warehouse: null, flex: null } }));
    const base = testHeaderMap();
    const headerMap = testHeaderMap({ fields: { ...base.fields, rentText: 'Rent Low', rentLow: null, rentHigh: null, rentBasis: null } });
    const { dir, db, deps } = setup({ config, headerMap });
    const gross: FixtureListing = { address: '99 Gross Way', sf: 10000, rentLow: '$11.00/SF/YR Gross', rentType: null };
    const comps1: FixtureListing[] = [1.8, 1.9, 2.0, 2.1, 2.2].map((opex, i) => ({ address: `${i + 1} Opex Ln`, sf: 10000, rentLow: `$7.00/SF/YR + $${opex.toFixed(2)} NNN`, rentType: null }));
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', [...comps1, gross]), deps);
    const first = db.prepare("SELECT asking_nnn_eq FROM lm_observation o JOIN lm_listing l ON l.id = o.listing_id JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = '99 GROSS WAY'").get() as { asking_nnn_eq: number };
    const comps2: FixtureListing[] = [3.8, 3.9, 4.0, 4.1, 4.2].map((opex, i) => ({ address: `${i + 1} Opex Ln`, sf: 10000, rentLow: `$7.00/SF/YR + $${opex.toFixed(2)} NNN`, rentType: null }));
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [...comps2, gross]), deps);
    const second = db.prepare("SELECT asking_nnn_eq FROM lm_observation o JOIN lm_listing l ON l.id = o.listing_id JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = '99 GROSS WAY' ORDER BY o.observed_at DESC LIMIT 1").get() as { asking_nnn_eq: number };
    expect(second.asking_nnn_eq).not.toBe(first.asking_nnn_eq); // the median genuinely moved
    expect(eventsFor(db, '99 GROSS WAY').map((e) => (e as { kind: string }).kind)).toEqual(['new']); // no price_cut/price_increase
  });

  it('quoted opex counts at most once per listing across many prior exports', async () => {
    const config = testConfig();
    config.markets = config.markets.map((m) => ({ ...m, opexDefaults: { warehouse: null, flex: null } }));
    const base = testHeaderMap();
    const headerMap = testHeaderMap({ fields: { ...base.fields, rentText: 'Rent Low', rentLow: null, rentHigh: null, rentBasis: null } });
    const { dir, db, deps } = setup({ config, headerMap });
    const opexQuotes = [1.8, 1.9, 2.0, 2.1, 2.2];
    for (let i = 0; i < opexQuotes.length; i++) {
      const listing: FixtureListing = { address: '1 Opex Ln', sf: 10000, rentLow: `$7.00/SF/YR + $${opexQuotes[i]!.toFixed(2)} NNN`, rentType: null };
      await ingestCostarListingsFile(db, await writeCostarFixture(dir, `costar-listings_columbus_2026-0${i + 1}-01.xlsx`, [listing]), deps);
    }
    const gross: FixtureListing = { address: '99 Gross Way', sf: 10000, rentLow: '$11.00/SF/YR Gross', rentType: null };
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-06-01.xlsx', [gross]), deps);
    expect(db.prepare("SELECT rent_basis, asking_nnn_eq, opex_est_psf, opex_source, confidence FROM lm_observation o JOIN lm_listing l ON l.id = o.listing_id JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = '99 GROSS WAY'").get())
      .toEqual({ rent_basis: 'GROSS', asking_nnn_eq: null, opex_est_psf: null, opex_source: null, confidence: 'low' });
  });

  it('does not fire a price event when the previous observation was rejected', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', [{ address: '1 Big Num St', sf: 16000, rentLow: 12000 }]), deps);
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [{ address: '1 Big Num St', sf: 16000, rentLow: 8.5 }]), deps);
    expect(r.events).toMatchObject({ price_cut: 0, price_increase: 0 });
    expect(eventsFor(db, '1 BIG NUM ST').map((e) => (e as { kind: string }).kind)).toEqual(['new']);
  });

  it('a partial export after removal keeps the space removed and emits no returned event', async () => {
    const { dir, db, deps } = setup();
    const extra: FixtureListing = { address: '40 Delta Pkwy', sf: 5000 };
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', FOUR), deps);
    const noBeta = FOUR.filter((l) => l.id !== 'C2');
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [...noBeta, extra]), deps);
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-03-01.xlsx', [...noBeta, extra]), deps);
    expect(spaceStatus(db, '20 BETA DR')).toBe('removed');
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-04-01.xlsx', [FOUR[1]!]), deps);
    expect(r.completeness).toBe('partial');
    expect(spaceStatus(db, '20 BETA DR')).toBe('removed');
    expect(eventsFor(db, '20 BETA DR').map((e) => (e as { kind: string }).kind)).toEqual(['new', 'missing', 'removed']);
  });

  it('a back-dated (or same-day) re-export writes the observation but emits no events', async () => {
    const { dir, db, deps } = setup();
    const alpha1: FixtureListing = { address: '10 Alpha Rd', sf: 12000, rentLow: 8.5, dateOnMarket: '2025-10-01' };
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', [alpha1]), deps);
    const alpha2: FixtureListing = { address: '10 Alpha Rd', sf: 12000, rentLow: 7.5, dateOnMarket: '2026-02-15' };
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-03-01.xlsx', [alpha2]), deps);
    const before = eventsFor(db, '10 ALPHA RD');
    expect(before.map((e) => (e as { kind: string }).kind)).toEqual(['new', 'price_cut', 'dom_reset']);
    // Back-dated: this file's export date (2026-02-01) is before the space's last_seen (2026-03-01).
    const alpha3: FixtureListing = { address: '10 Alpha Rd', sf: 12000, rentLow: 8.5, dateOnMarket: '2026-02-15' };
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [alpha3]), deps);
    expect(eventsFor(db, '10 ALPHA RD')).toEqual(before);
    expect((db.prepare("SELECT COUNT(*) AS n FROM lm_observation o JOIN lm_listing l ON l.id = o.listing_id JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = '10 ALPHA RD'").get() as { n: number }).n).toBe(3);
  });

  it('first_seen lowers when a back-dated file predates it, and first_landing_id follows', async () => {
    const { dir, db, deps } = setup();
    const zeta: FixtureListing = { address: '1 Zeta Ct', sf: 9000 };
    const l1 = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [zeta]), deps);
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-03-01.xlsx', [zeta]), deps);
    const before = db.prepare("SELECT l.first_seen AS listingFirstSeen, p.first_seen AS propertyFirstSeen, l.first_landing_id AS firstLandingId FROM lm_listing l JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = '1 ZETA CT'").get();
    expect(before).toEqual({ listingFirstSeen: '2026-02-01', propertyFirstSeen: '2026-02-01', firstLandingId: l1.landingId });
    const l3 = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-15.xlsx', [zeta]), deps);
    const after = db.prepare("SELECT l.first_seen AS listingFirstSeen, p.first_seen AS propertyFirstSeen, l.first_landing_id AS firstLandingId FROM lm_listing l JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = '1 ZETA CT'").get();
    expect(after).toEqual({ listingFirstSeen: '2026-01-15', propertyFirstSeen: '2026-01-15', firstLandingId: l3.landingId });
  });

  it('two different CoStar ids at the same address create two properties', async () => {
    const { dir, db, deps } = setup();
    const rows: FixtureListing[] = [
      { id: 'X1', address: '10 Alpha Rd', sf: 5000 },
      { id: 'X2', address: '10 Alpha Rd', sf: 5000 },
    ];
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', rows), deps);
    const props = db.prepare("SELECT costar_property_id FROM lm_property WHERE address_norm = '10 ALPHA RD' ORDER BY id").all();
    expect(props).toEqual([{ costar_property_id: 'X1' }, { costar_property_id: 'X2' }]);
  });

  it('the same address in two markets is two properties; a complete export of one market never marks the other missing', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', [{ address: '10 Alpha Rd', sf: 5000 }]), deps);
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_madison_2026-01-01.xlsx', [{ address: '10 Alpha Rd', sf: 5000, market: 'Madison' }]), deps);
    const props = db.prepare("SELECT market_id FROM lm_property WHERE address_norm = '10 ALPHA RD' ORDER BY market_id").all();
    expect(props).toEqual([{ market_id: 'columbus' }, { market_id: 'madison' }]);
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [{ address: '1 Zeta Ct', sf: 9000 }]), deps);
    const columbusAlpha = db.prepare("SELECT l.status FROM lm_listing l JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = '10 ALPHA RD' AND p.market_id = 'columbus'").get() as { status: string };
    const madisonAlpha = db.prepare("SELECT l.status FROM lm_listing l JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = '10 ALPHA RD' AND p.market_id = 'madison'").get() as { status: string };
    expect(columbusAlpha.status).toBe('missing_once');
    expect(madisonAlpha.status).toBe('active');
  });

  it('a no-id row later seen with a CoStar id adopts into the same property', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', [{ address: '10 Alpha Rd', sf: 12000 }]), deps);
    const before = db.prepare("SELECT COUNT(*) AS n FROM lm_property WHERE address_norm = '10 ALPHA RD'").get() as { n: number };
    expect(before.n).toBe(1);
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [{ id: 'X9', address: '10 Alpha Rd', sf: 12000 }]), deps);
    const rows = db.prepare("SELECT costar_property_id, identity_key FROM lm_property WHERE address_norm = '10 ALPHA RD'").all();
    expect(rows).toEqual([{ costar_property_id: 'X9', identity_key: 'costar:X9' }]);
  });

  it('updates lm_landing.skipped_count to the final total (parser skips + in-file duplicates)', async () => {
    const { dir, db, deps } = setup();
    const rows: FixtureListing[] = [
      ...FOUR,
      { address: '10 Alpha Rd', sf: 12000, rentLow: 8.5, dateOnMarket: '2025-10-01' }, // duplicate of C1
      { address: '0 Zero SF Ln', sf: 0 }, // parser skip: available SF missing/zero
    ];
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', rows), deps);
    expect(r.skipped).toBe(2);
    expect((db.prepare('SELECT skipped_count FROM lm_landing WHERE id = ?').get(r.landingId) as { skipped_count: number }).skipped_count).toBe(2);
  });

  it('a duplicate space row in the same file does not overwrite the property (e.g. building_sf)', async () => {
    const { dir, db, deps } = setup();
    const rows: FixtureListing[] = [
      { address: '10 Alpha Rd', sf: 12000, rba: 8000 },
      { address: '10 Alpha Rd', sf: 12000, rba: 99999 },
    ];
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', rows), deps);
    expect(r.skipped).toBe(1);
    expect((db.prepare("SELECT building_sf FROM lm_property WHERE address_norm = '10 ALPHA RD'").get() as { building_sf: number }).building_sf).toBe(8000);
  });

  it('never overwrites an existing property owner_type when the screen is unavailable', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', FOUR), deps);
    expect((db.prepare("SELECT owner_type FROM lm_property WHERE address_norm = '20 BETA DR'").get() as { owner_type: string }).owner_type).toBe('institutional');
    // A REAL down screen returns no resolved types at all (empty Map) — if the update path failed to
    // gate on `available`, this would overwrite owner_type with 'unknown', not merely re-write the
    // same value back.
    const down = { ...deps, screen: () => ({ available: false, guardOk: false, types: new Map(), error: 'down' }) };
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', FOUR), down);
    expect((db.prepare("SELECT owner_type FROM lm_property WHERE address_norm = '20 BETA DR'").get() as { owner_type: string }).owner_type).toBe('institutional');
  });

  it('an invalid calendar date in the file name fails the landing', async () => {
    const { dir, db, deps } = setup();
    const f = await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-30.xlsx', [{ address: '5 Lake St', sf: 3000 }]);
    const r = await ingestCostarListingsFile(db, f, deps);
    expect(r).toMatchObject({ status: 'failed', error: 'invalid export date in file name' });
  });

  it('falls back to the local mtime date when the file name has no date convention', async () => {
    const { dir, db, deps } = setup();
    const f = await writeCostarFixture(dir, 'Export.xlsx', [{ address: '5 Lake St', sf: 3000, market: 'Madison' }]);
    // 23:30 LOCAL time: in any negative-UTC-offset zone (all US zones) this rolls into the next UTC
    // calendar day, so the old UTC-based `mtime.toISOString().slice(0,10)` formula would date the file
    // one day later than the correct local date.
    const target = new Date(2026, 5, 14, 23, 30, 0);
    utimesSync(f, target, target);
    const r = await ingestCostarListingsFile(db, f, deps);
    const local = `${target.getFullYear()}-${String(target.getMonth() + 1).padStart(2, '0')}-${String(target.getDate()).padStart(2, '0')}`;
    const utcOfSameInstant = target.toISOString().slice(0, 10);
    expect(r.exportDate).toBe(local);
    if (utcOfSameInstant !== local) {
      // This machine's local offset crosses midnight at 23:30 local — the old (UTC) formula would have
      // produced `utcOfSameInstant` instead, so this assertion distinguishes old vs new behavior.
      expect(r.exportDate).not.toBe(utcOfSameInstant);
    }
    // Else: this machine's local zone doesn't cross a day boundary at 23:30 (e.g. it runs at UTC, or an
    // offset that keeps 23:30 local same-day in UTC) — local and UTC coincide here, so this run cannot
    // distinguish old vs new behavior by date value alone. The `r.exportDate === local` assertion above
    // still correctly pins the LOCAL-date contract either way.
  });

  it('a file-name market that contradicts the market column fails the landing', async () => {
    const { dir, db, deps } = setup();
    const f = await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', [{ address: '5 Lake St', sf: 3000, market: 'Madison' }]);
    const r = await ingestCostarListingsFile(db, f, deps);
    expect(r).toMatchObject({ status: 'failed', error: expect.stringMatching(/file name market columbus contradicts market column madison/) });
  });

  // ── Fix round 2 ──────────────────────────────────────────────────────────

  it('a no-id row with a blank city later matches by address, backfilling city_norm and the addr: key', async () => {
    const { dir, db, deps } = setup();
    const cityless = testHeaderMap({ fields: { ...testHeaderMap().fields, city: null } });
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', [{ address: '10 Alpha Rd', sf: 12000 }]), { ...deps, headerMap: cityless });
    const blank = db.prepare("SELECT city_norm, identity_key FROM lm_property WHERE address_norm = '10 ALPHA RD'").get() as { city_norm: string; identity_key: string };
    expect(blank).toEqual({ city_norm: '', identity_key: 'addr:columbus||10 ALPHA RD' });
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [{ address: '10 Alpha Rd', sf: 12000, city: 'Columbus' }]), deps);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM lm_property WHERE address_norm = '10 ALPHA RD'").get() as { n: number }).n;
    expect(count).toBe(1);
    const after = db.prepare("SELECT city_norm, identity_key FROM lm_property WHERE address_norm = '10 ALPHA RD'").get() as { city_norm: string; identity_key: string };
    expect(after).toEqual({ city_norm: 'COLUMBUS', identity_key: 'addr:columbus|COLUMBUS|10 ALPHA RD' });
  });

  it('a different city at the same address is a different property (documented behavior)', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', [{ address: '10 Alpha Rd', sf: 12000, city: 'Columbus' }]), deps);
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [{ address: '10 Alpha Rd', sf: 12000, city: 'Worthington' }]), deps);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM lm_property WHERE address_norm = '10 ALPHA RD'").get() as { n: number }).n;
    expect(count).toBe(2);
  });

  it('a back-dated complete-shaped export stays partial when a later landing already exists (no resurrection, no strikes)', async () => {
    const { dir, db, deps } = setup();
    const extra: FixtureListing = { address: '40 Delta Pkwy', sf: 5000 };
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', FOUR), deps);
    const noBeta = FOUR.filter((l) => l.id !== 'C2');
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [...noBeta, extra]), deps);
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-03-01.xlsx', [...noBeta, extra]), deps);
    expect(spaceStatus(db, '20 BETA DR')).toBe('removed');
    // A thin (partial) export dated AFTER the removal, then a complete-shaped file dated BEFORE it.
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-04-01.xlsx', [FOUR[0]!]), deps);
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-03-15.xlsx', FOUR), deps);
    expect(r.completeness).toBe('partial');
    expect(r.markedMissing).toBe(0);
    expect(r.markedRemoved).toBe(0);
    expect(spaceStatus(db, '20 BETA DR')).toBe('removed');
    expect(eventsFor(db, '20 BETA DR').map((e) => (e as { kind: string }).kind)).toEqual(['new', 'missing', 'removed']);
  });

  it('the opex exclusion/dedupe key is property identity + suite, not address|suite', async () => {
    const config = testConfig();
    config.markets = config.markets.map((m) => ({ ...m, opexDefaults: { warehouse: null, flex: null } }));
    const base = testHeaderMap();
    const headerMap = testHeaderMap({ fields: { ...base.fields, rentText: 'Rent Low', rentLow: null, rentHigh: null, rentBasis: null } });
    const { dir, db, deps } = setup({ config, headerMap });
    // A and B share the SAME address+suite text but are two DIFFERENT properties (two CoStar ids). An
    // address|suite exclusion key would conflate them; an identity_key-based key must not.
    const a: FixtureListing = { id: 'PA', address: '1 Twin St', sf: 10000, rentLow: '$7.00/SF/YR + $1.80 NNN', rentType: null };
    const b1: FixtureListing = { id: 'PB', address: '1 Twin St', sf: 10000, rentLow: '$7.00/SF/YR + $1.90 NNN', rentType: null };
    const c: FixtureListing = { address: '2 Solo St', sf: 10000, rentLow: '$7.00/SF/YR + $2.00 NNN', rentType: null };
    const d: FixtureListing = { address: '3 Solo St', sf: 10000, rentLow: '$7.00/SF/YR + $2.10 NNN', rentType: null };
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', [a, b1, c, d]), deps);
    // File 2: B reappears (its current value should be used instead of its prior one, but A/C/D's prior
    // values must still count) plus a 5th comp and the GROSS listing needing conversion.
    const b2: FixtureListing = { id: 'PB', address: '1 Twin St', sf: 10000, rentLow: '$7.00/SF/YR + $1.90 NNN', rentType: null };
    const e: FixtureListing = { address: '4 Solo St', sf: 10000, rentLow: '$7.00/SF/YR + $2.20 NNN', rentType: null };
    const gross: FixtureListing = { address: '99 Gross Way', sf: 10000, rentLow: '$11.00/SF/YR Gross', rentType: null };
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [b2, e, gross]), deps);
    // n = A(1.80) + C(2.00) + D(2.10) [prior, correctly NOT excluded] + B(1.90) + E(2.20) [current] = 5
    // => median 2.00 => converts. Under an address|suite key, A's AND B's prior quotes would both be
    // wrongly excluded (same address text as B's current row), leaving n = 4 => no conversion.
    expect(db.prepare("SELECT o.rent_basis, o.asking_nnn_eq, o.opex_est_psf, o.opex_source FROM lm_observation o JOIN lm_listing l ON l.id = o.listing_id JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = '99 GROSS WAY'").get())
      .toEqual({ rent_basis: 'GROSS', asking_nnn_eq: 9, opex_est_psf: 2, opex_source: 'quoted-market-median n=5' });
  });

  it('a CoStar id already used by a different market is skipped, not attached cross-market', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', [{ id: 'X1', address: '10 Alpha Rd', sf: 12000 }]), deps);
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_madison_2026-01-01.xlsx', [{ id: 'X1', address: '5 Lake St', sf: 3000, market: 'Madison' }]), deps);
    expect(r).toMatchObject({ status: 'ingested', completeness: 'complete', skipped: 1, insertedSpaces: 0, newProperties: 0 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM lm_property WHERE market_id = 'madison'").get() as { n: number }).n).toBe(0);
    expect((db.prepare("SELECT market_id FROM lm_property WHERE costar_property_id = 'X1'").get() as { market_id: string }).market_id).toBe('columbus');
  });

  it('a sighting in a partial export clears missing_once back to active (removed spaces stay untouched)', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', FOUR), deps);
    const noBeta = FOUR.filter((l) => l.id !== 'C2');
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [...noBeta, { address: '40 Delta Pkwy', sf: 5000 }]), deps);
    expect(spaceStatus(db, '20 BETA DR')).toBe('missing_once');
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-03-01.xlsx', [FOUR[1]!]), deps);
    expect(r.completeness).toBe('partial');
    expect(spaceStatus(db, '20 BETA DR')).toBe('active');
    expect(eventsFor(db, '20 BETA DR').map((e) => (e as { kind: string }).kind)).toEqual(['new', 'missing']);
  });

  it('an expired space seen again on a complete export returns to active with a returned event', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', FOUR), deps);
    db.prepare(
      "UPDATE lm_listing SET status = 'expired' WHERE id = (SELECT l.id FROM lm_listing l JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = '20 BETA DR')",
    ).run();
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', FOUR), deps);
    expect(r.completeness).toBe('complete');
    expect(spaceStatus(db, '20 BETA DR')).toBe('active');
    expect(eventsFor(db, '20 BETA DR').map((e) => (e as { kind: string }).kind)).toEqual(['new', 'returned']);
  });

  it('the ORA property-config match requires the market (the same address in another market is not tagged ORA)', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_madison_2026-01-01.xlsx', [{ address: '1100 Rarig Avenue', sf: 8000, market: 'Madison' }]), deps);
    expect((db.prepare("SELECT ora_property_key FROM lm_property WHERE address_norm = '1100 RARIG AVE' AND market_id = 'madison'").get() as { ora_property_key: string | null }).ora_property_key).toBeNull();
  });

  // ── Final triage round (spec §A) ────────────────────────────────────────

  it('a CoStar-id row with a known city adopts an existing blank-city property when the exact-city match misses (A1 forward)', async () => {
    const { dir, db, deps } = setup();
    const cityless = testHeaderMap({ fields: { ...testHeaderMap().fields, city: null } });
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', [{ address: '10 Alpha Rd', sf: 12000 }]), { ...deps, headerMap: cityless });
    const before = db.prepare("SELECT costar_property_id, city_norm, identity_key FROM lm_property WHERE address_norm = '10 ALPHA RD'").get();
    expect(before).toEqual({ costar_property_id: null, city_norm: '', identity_key: 'addr:columbus||10 ALPHA RD' });
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [{ id: 'X9', address: '10 Alpha Rd', sf: 12000, city: 'Columbus' }]), deps);
    const count = (db.prepare("SELECT COUNT(*) AS n FROM lm_property WHERE address_norm = '10 ALPHA RD'").get() as { n: number }).n;
    expect(count).toBe(1);
    const after = db.prepare("SELECT costar_property_id, city_norm, identity_key FROM lm_property WHERE address_norm = '10 ALPHA RD'").get();
    expect(after).toEqual({ costar_property_id: 'X9', city_norm: 'COLUMBUS', identity_key: 'costar:X9' });
  });

  it('a blank-city no-id row adopts the sole existing non-blank-city property at that address (A1 reverse)', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', [{ address: '10 Alpha Rd', sf: 12000, city: 'Columbus' }]), deps);
    const before = db.prepare("SELECT city_norm, identity_key FROM lm_property WHERE address_norm = '10 ALPHA RD'").get();
    expect(before).toEqual({ city_norm: 'COLUMBUS', identity_key: 'addr:columbus|COLUMBUS|10 ALPHA RD' });
    const cityless = testHeaderMap({ fields: { ...testHeaderMap().fields, city: null } });
    // building_sf is sourced from RBA (not the "sf"/available-SF fixture field) — set it explicitly so
    // it distinguishes "the adopted property was updated" from "a stray second property was inserted".
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [{ address: '10 Alpha Rd', sf: 15000, rba: 55000 }]), { ...deps, headerMap: cityless });
    const count = (db.prepare("SELECT COUNT(*) AS n FROM lm_property WHERE address_norm = '10 ALPHA RD'").get() as { n: number }).n;
    expect(count).toBe(1);
    const after = db.prepare("SELECT building_sf, city_norm, identity_key FROM lm_property WHERE address_norm = '10 ALPHA RD'").get();
    expect(after).toEqual({ building_sf: 55000, city_norm: 'COLUMBUS', identity_key: 'addr:columbus|COLUMBUS|10 ALPHA RD' });
  });

  it('a back-dated partial (dated before the last complete landing) never clears a missing_once strike (A2)', async () => {
    const { dir, db, deps } = setup();
    const extra: FixtureListing = { address: '40 Delta Pkwy', sf: 5000 };
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', FOUR), deps); // T1 complete, Beta active
    const noBeta = FOUR.filter((l) => l.id !== 'C2');
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [...noBeta, extra]), deps); // T2 complete, Beta -> missing_once
    expect(spaceStatus(db, '20 BETA DR')).toBe('missing_once');
    // Delivered out of order: dated BEFORE T2 (the latest complete landing) even though it lands after it.
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-15.xlsx', [FOUR[1]!]), deps);
    expect(r.completeness).toBe('partial');
    expect(spaceStatus(db, '20 BETA DR')).toBe('missing_once');
  });

  it('records a market_mismatch skip reason on the landing and warns once with the count (A3)', async () => {
    const { dir, db, deps } = setup();
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', [{ id: 'X1', address: '10 Alpha Rd', sf: 12000 }]), deps);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_madison_2026-01-01.xlsx', [{ id: 'X1', address: '5 Lake St', sf: 3000, market: 'Madison' }]), deps);
    expect(r.skipped).toBe(1);
    expect(r.partialReason).toMatch(/market_mismatch: 1 row\(s\) skipped/);
    expect((db.prepare('SELECT partial_reason FROM lm_landing WHERE id = ?').get(r.landingId) as { partial_reason: string | null }).partial_reason).toBe(r.partialReason);
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]![0]).toMatch(/market_mismatch: 1 row\(s\) skipped/);
    warnSpy.mockRestore();
  });

  it('a landing dated more than 1 day after deps.now() fails without writing rows (A4)', async () => {
    const { dir, db, deps } = setup({ now: () => '2026-03-02T00:00:00Z' });
    const f = await writeCostarFixture(dir, 'costar-listings_columbus_2026-03-04.xlsx', [{ address: '5 Lake St', sf: 3000 }]);
    const r = await ingestCostarListingsFile(db, f, deps);
    expect(r).toMatchObject({ status: 'failed', error: expect.stringMatching(/more than 1 day after 2026-03-02/) });
    expect((db.prepare('SELECT COUNT(*) AS n FROM lm_property').get() as { n: number }).n).toBe(0);
  });

  it('a landing dated exactly 1 day after deps.now() is not rejected by the future-date check (A4 boundary)', async () => {
    const { dir, db, deps } = setup({ now: () => '2026-03-02T00:00:00Z' });
    const f = await writeCostarFixture(dir, 'costar-listings_columbus_2026-03-03.xlsx', [{ address: '5 Lake St', sf: 3000 }]);
    const r = await ingestCostarListingsFile(db, f, deps);
    expect(r.status).toBe('ingested');
  });

  // ── REFUTE fix round (warehouse: R4, R5, R10, R11, R17) ─────────────────

  it('suppresses a price event when confidence changes (high<->low), even under the same basis (R4)', async () => {
    const { dir, db, deps } = setup();
    const base = testHeaderMap();
    const headerMap = testHeaderMap({ fields: { ...base.fields, rentText: 'Rent Low', rentLow: null, rentHigh: null } });
    // First observation: a bare, unit-less amount below monthlyValueCeiling ($3.00) infers a MONTHLY
    // rate (period-inferred => confidence 'low'): $2.50 -> $30.00/SF/yr.
    const inferred: FixtureListing = { address: '1 Confidence Way', sf: 10000, rentLow: '$2.50', rentType: 'NNN' };
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', [inferred]), { ...deps, headerMap });
    const first = db.prepare(
      "SELECT asking_psf_yr, confidence FROM lm_observation o JOIN lm_listing l ON l.id = o.listing_id JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = '1 CONFIDENCE WAY'",
    ).get();
    expect(first).toEqual({ asking_psf_yr: 30, confidence: 'low' });
    // Second observation: an EXPLICIT annual rate (confidence 'high'). Same effective basis (NNN), but a
    // different confidence level -- comparing 30.00 to 9.00 raw would otherwise read as a huge phantom
    // price_cut, when the two figures were never derived under comparable interpretation confidence.
    const explicit: FixtureListing = { address: '1 Confidence Way', sf: 10000, rentLow: '$9.00/SF/YR', rentType: 'NNN' };
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [explicit]), { ...deps, headerMap });
    const second = db.prepare(
      "SELECT asking_psf_yr, confidence FROM lm_observation o JOIN lm_listing l ON l.id = o.listing_id JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = '1 CONFIDENCE WAY' ORDER BY o.observed_at DESC LIMIT 1",
    ).get();
    expect(second).toEqual({ asking_psf_yr: 9, confidence: 'high' });
    expect(r.events).toMatchObject({ price_cut: 0, price_increase: 0 });
    expect(eventsFor(db, '1 CONFIDENCE WAY').map((e) => (e as { kind: string }).kind)).toEqual(['new']);
  });

  // ── M-3: a real cut suppressed by a confidence flip must not vanish silently ─────────────────
  it('warns when a genuine price change is suppressed by a same-pair confidence flip (M-3)', async () => {
    const { dir, db, deps } = setup();
    const base = testHeaderMap();
    const headerMap = testHeaderMap({ fields: { ...base.fields, rentText: 'Rent Low', rentLow: null, rentHigh: null } });
    // Same narrative as the R4 test above (30 -> 9, confidence low -> high) — that pair genuinely
    // differs in value, which is exactly the case R4's own suppression can't tell apart from a phantom
    // move.
    const inferred: FixtureListing = { address: '2 Warn Way', sf: 10000, rentLow: '$2.50', rentType: 'NNN' };
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', [inferred]), { ...deps, headerMap });
    const explicit: FixtureListing = { address: '2 Warn Way', sf: 10000, rentLow: '$9.00/SF/YR', rentType: 'NNN' };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [explicit]), { ...deps, headerMap });
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('[lease-market]') && String(c[0]).toLowerCase().includes('confidence flipped'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('does not warn about an ordinary same-confidence price cut', async () => {
    const { dir, db, deps } = setup();
    const l1: FixtureListing = { address: '3 Normal St', sf: 10000, rentLow: 10, rentType: 'NNN' };
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', [l1]), deps);
    const l2: FixtureListing = { address: '3 Normal St', sf: 10000, rentLow: 8, rentType: 'NNN' };
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [l2]), deps);
    expect(r.events).toMatchObject({ price_cut: 1 });
    expect(warnSpy.mock.calls.some((c) => String(c[0]).toLowerCase().includes('confidence flipped'))).toBe(false);
    warnSpy.mockRestore();
  });

  it('a total quote compares the raw total, not asking_psf_yr — an SF change alone never fires a phantom price event, either direction (R5)', async () => {
    const { dir, db, deps } = setup();
    const base = testHeaderMap();
    const headerMap = testHeaderMap({ fields: { ...base.fields, rentText: 'Rent Low', rentLow: null, rentHigh: null } });
    const l = (sf: number, total = '$2,500/MO'): FixtureListing[] => [{ address: '9 Total Ct', sf, rentLow: total, rentType: 'NNN' }];
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', l(5000)), { ...deps, headerMap });
    // SF shrinks 20% (well over sfChangePct); the quoted total is unchanged.
    const shrink = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', l(4000)), { ...deps, headerMap });
    expect(shrink.events).toMatchObject({ price_cut: 0, price_increase: 0, sf_change: 1 });
    // SF grows back; still unchanged total.
    const grow = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-03-01.xlsx', l(6000)), { ...deps, headerMap });
    expect(grow.events).toMatchObject({ price_cut: 0, price_increase: 0, sf_change: 1 });
    // A genuine cut to the quoted total still fires as a real price_cut.
    const cut = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-04-01.xlsx', l(6000, '$2,200/MO')), { ...deps, headerMap });
    expect(cut.events).toMatchObject({ price_cut: 1, price_increase: 0, sf_change: 0 });
    expect(eventsFor(db, '9 TOTAL CT').map((e) => (e as { kind: string }).kind)).toEqual(['new', 'sf_change', 'sf_change', 'price_cut']);
  });

  it('a space whose first sighting is a landing dated before the latest complete landing starts missing_once, not active (R10)', async () => {
    const { dir, db, deps } = setup();
    const base: FixtureListing[] = Array.from({ length: 5 }, (_, i) => ({ id: `B${i}`, address: `${i + 1} Base St`, sf: 8000, rentLow: 9.0 }));
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', base), deps); // T1 complete
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-03-01.xlsx', base), deps); // T2 complete (latest)
    // A back-dated file lands out of order: dated between T1 and T2, but arrives after both. It carries
    // a brand-new space (N1) that the more current T2 complete export never saw.
    const feb = await ingestCostarListingsFile(
      db,
      await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [...base, { id: 'N1', address: '99 New Rd', sf: 8000, rentLow: 9.0 }]),
      deps,
    );
    expect(feb.completeness).toBe('partial');
    expect(feb.events.new).toBe(1);
    expect(spaceStatus(db, '99 NEW RD')).toBe('missing_once');
  });

  it('warns and notes when a row count lands on a common CoStar export cap, without forcing partial (R11)', async () => {
    const { dir, db, deps } = setup({ config: testConfig({ thresholds: { ...testConfig().thresholds, exportRowCap: 999999 } }) });
    const rows: FixtureListing[] = Array.from({ length: 500 }, (_, i) => ({ address: `${i + 1} Round Cap Rd`, sf: 5000 + i }));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', rows), deps);
    expect(r.completeness).toBe('complete'); // not the configured cap -> still complete
    expect(r.partialReason).toMatch(/row count 500 matches a common CoStar export cap \(500\)/);
    expect((db.prepare('SELECT partial_reason FROM lm_landing WHERE id = ?').get(r.landingId) as { partial_reason: string | null }).partial_reason).toBe(r.partialReason);
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('matches a common CoStar export cap (500)'))).toBe(true);
    warnSpy.mockRestore();
  });

  it('never persists or logs an owner name for a failing owner screen, only the error text (R17)', async () => {
    const { dir, db, deps } = setup({
      screen: () => ({ available: false, guardOk: false, types: new Map(), error: 'never-call guard file unreadable (screen degraded to ORA-self only)' }),
    });
    const rows: FixtureListing[] = [{ address: '1 Secret Owner Rd', sf: 5000, owner: 'SUPER SECRET HOLDCO LLC' }];
    const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', rows), deps);
    expect(r.partialReason).toContain('owner_screen_error: never-call guard file unreadable (screen degraded to ORA-self only)');
    expect(r.partialReason).not.toContain('SUPER SECRET HOLDCO');
    const stored = (db.prepare('SELECT partial_reason FROM lm_landing WHERE id = ?').get(r.landingId) as { partial_reason: string | null }).partial_reason;
    expect(stored).toBe(r.partialReason);
    expect(stored).not.toContain('SUPER SECRET HOLDCO');
  });

  // H3: keying a space purely on (property, suite_norm) collapses two genuinely different blank-suite
  // listings — most commonly a Direct listing and a Sublet listing of the same address, quoted
  // separately by two different brokers — into one lm_listing row. Whichever row happened to land
  // first in the export "won" the blank suite_norm and the other silently vanished (not even counted
  // with a reason), and a reordered re-export could flip which one survived. Fixed by folding Lease
  // Type into the identity for the blank-suite case only (spaceIdentityOf in ingest.ts) — see the
  // real 400 E Wilson Bridge Rd / 648 Clymer Rd rows from the first production export below.
  describe('H3: blank-suite space identity folds in Lease Type (Direct vs Sublet)', () => {
    it('400 E Wilson Bridge Rd: a blank-suite Sublet listing and a blank-suite Direct listing at the same address both survive as distinct spaces', async () => {
      const { dir, db, deps } = setup();
      const rows: FixtureListing[] = [
        { address: '400 E Wilson Bridge Rd', sf: 14632, rentLow: 5.84, rentType: 'NNN', spaceUse: 'Sublet' },
        { address: '400 E Wilson Bridge Rd', sf: 3420, rentLow: 9, rentType: 'NNN', spaceUse: 'Direct' },
      ];
      const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', rows), deps);
      expect(r).toMatchObject({ insertedSpaces: 2, skipped: 0 });
      const listings = db
        .prepare("SELECT suite_norm FROM lm_listing l JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = '400 E WILSON BRIDGE RD' ORDER BY suite_norm")
        .all();
      // Direct keeps the unchanged blank suite_norm (the common case, byte-for-byte unaffected);
      // Sublet gets the distinct marker — both rows survive instead of one silently dropping.
      expect(listings).toEqual([{ suite_norm: '' }, { suite_norm: 'SUBLET' }]);
    });

    it('648 Clymer Rd: two blank-suite Direct listings at the same address still collapse (indistinguishable) — but the loss is now reported with a "duplicate space" reason', async () => {
      const { dir, db, deps } = setup();
      const rows: FixtureListing[] = [
        { address: '648 Clymer Rd', sf: 215, rentLow: 10, rentType: 'NNN', spaceUse: 'Direct' }, // kept
        { address: '648 Clymer Rd', sf: 11700, rentLow: 7.5, rentType: 'NNN', spaceUse: 'Direct' }, // dropped — the real $7.50 NNN comp
      ];
      const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', rows), deps);
      expect(r).toMatchObject({ insertedSpaces: 1, skipped: 1 });
      expect(r.partialReason).toMatch(/duplicate space: 1 row\(s\) skipped/);
      const stored = (db.prepare('SELECT partial_reason FROM lm_landing WHERE id = ?').get(r.landingId) as { partial_reason: string | null }).partial_reason;
      expect(stored).toContain('duplicate space');
      // The kept observation is the FIRST row's ($10, 215 SF) — unchanged first-wins behavior for a
      // true duplicate; only the reason for the loss is new, not which row wins.
      expect(
        db.prepare("SELECT o.rent_low FROM lm_observation o JOIN lm_listing l ON l.id = o.listing_id JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = '648 CLYMER RD'").get(),
      ).toEqual({ rent_low: 10 });
    });

    it('the Direct/Sublet split is deterministic on Lease Type, not on which row appears first in the file — a reordered re-export still updates the SAME two spaces', async () => {
      const { dir, db, deps } = setup();
      const forward: FixtureListing[] = [
        { address: '77 Order Test Rd', sf: 5000, rentLow: 6, rentType: 'NNN', spaceUse: 'Sublet' },
        { address: '77 Order Test Rd', sf: 8000, rentLow: 9, rentType: 'NNN', spaceUse: 'Direct' },
      ];
      const r1 = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', forward), deps);
      expect(r1).toMatchObject({ insertedSpaces: 2, updatedSpaces: 0, skipped: 0 });

      const reversed: FixtureListing[] = [
        { address: '77 Order Test Rd', sf: 8200, rentLow: 9.25, rentType: 'NNN', spaceUse: 'Direct' }, // Direct listed FIRST this time
        { address: '77 Order Test Rd', sf: 5100, rentLow: 6.1, rentType: 'NNN', spaceUse: 'Sublet' },
      ];
      const r2 = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', reversed), deps);
      expect(r2).toMatchObject({ insertedSpaces: 0, updatedSpaces: 2, skipped: 0 });
    });
  });

  // L1: month-end-clamped duration arithmetic ("Time on Market" free text, converted via
  // timeOnMarketTextToDate) can derive a slightly EARLIER on-market date from a LATER export than an
  // earlier export derived — nothing about the listing changed. The naive "any backward dip fires
  // dom_reset" + "costar_date_on_market = MIN(...) pins the earliest-ever derivation forever" combo
  // then produces a false dom_reset and pins a too-early date through every later export. Real pair
  // from the finding: "1 Month 30 Days" on 2026-03-30 derives 2026-01-29; "2 Months" on 2026-03-31
  // (one calendar day later) derives 2026-01-31 — a 1-day backward wobble in costar_dom (60 -> 59)
  // with nothing else different. An explicit dateOnMarket column is unchanged (see the existing "keeps
  // the earliest CoStar date" test above, which uses the default explicit-column setup and passes
  // unmodified against this fix).
  describe('L1: duration-derived costar_date_on_market tolerates a small backward wobble; prefers the latest derivation over MIN', () => {
    function durationDeps(dir: string): IngestDeps {
      const base = testHeaderMap();
      return {
        config: testConfig(),
        headerMap: testHeaderMap({ fields: { ...base.fields, dateOnMarket: null, timeOnMarketText: 'Time On Market' } }),
        rawDir: join(dir, 'raw'),
        now: () => '2026-12-31T00:00:00Z',
        screen: stubScreen,
      };
    }
    const domOf = (db: WarehouseDb, address: string) =>
      db.prepare("SELECT costar_date_on_market FROM lm_listing l JOIN lm_property p ON p.id = l.property_id WHERE p.address_norm = ?").get(address);

    it('the real 03-30/03-31 pair: a 1-day wobble does not fire dom_reset, and costar_date_on_market follows the LATEST derivation, not MIN', async () => {
      const { dir, db } = setup();
      const deps = durationDeps(dir);
      const rows1: FixtureListing[] = [{ address: '1 Wobble Rd', sf: 8000, rentLow: 9, timeOnMarket: '1 Month 30 Days' }];
      await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-03-30.xlsx', rows1), deps);
      expect(domOf(db, '1 WOBBLE RD')).toEqual({ costar_date_on_market: '2026-01-29' });

      const rows2: FixtureListing[] = [{ address: '1 Wobble Rd', sf: 8000, rentLow: 9, timeOnMarket: '2 Months' }];
      const r2 = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-03-31.xlsx', rows2), deps);
      expect(r2.events.dom_reset).toBe(0); // costar_dom 60 -> 59: a 1-day dip, tolerated
      expect(eventsFor(db, '1 WOBBLE RD').map((e) => (e as { kind: string }).kind)).not.toContain('dom_reset');
      // Prefers the LATEST derivation (2026-01-31) over MIN(2026-01-29, 2026-01-31) = 2026-01-29.
      expect(domOf(db, '1 WOBBLE RD')).toEqual({ costar_date_on_market: '2026-01-31' });
    });

    it('a genuine reset (a dip past the 3-day wobble tolerance) still fires dom_reset even in duration-derived mode', async () => {
      const { dir, db } = setup();
      const deps = durationDeps(dir);
      const rows1: FixtureListing[] = [{ address: '2 Genuine Reset Rd', sf: 8000, rentLow: 9, timeOnMarket: '6 Months' }];
      await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', rows1), deps);
      // A fresh, much-shorter duration on the next export: the space was genuinely re-listed.
      const rows2: FixtureListing[] = [{ address: '2 Genuine Reset Rd', sf: 8000, rentLow: 9, timeOnMarket: '5 Days' }];
      const r2 = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', rows2), deps);
      expect(r2.events.dom_reset).toBe(1);
    });
  });
});
