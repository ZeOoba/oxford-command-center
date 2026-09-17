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
