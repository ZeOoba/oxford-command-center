import { describe, it, expect, vi } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse } from '../../server/warehouse/db';
import { ingestCostarListingsFile } from '../../server/warehouse/lease-market/ingest';
import {
  domBins, latestExportEvents, leaseMarketKpis, loadMarketState, marketDataQuality, marketFreshness, runCompute,
} from '../../server/warehouse/lease-market/compute';
import { stubScreen, testConfig, testHeaderMap, writeCostarFixture, type FixtureListing } from './lease-market-fixtures';

// 12 identical warehouse spaces (20,000 SF in 40,000 SF buildings, same coordinates and physicals) + one ORA space.
// For the $6.00 space, its similarity comps are the other 11: median 9.40, P25 8.90 => below market; radar 55.
const RENTS = [5.5, 6.0, 8.6, 8.8, 9.0, 9.2, 9.4, 9.6, 9.8, 10.0, 10.2, 10.4];
function listings(): FixtureListing[] {
  const rows: FixtureListing[] = RENTS.map((rent, i) => ({
    id: `C${i}`, address: `${100 + i} Industrial Pkwy`, sf: 20000, rentLow: rent, owner: rent === 5.5 ? 'PROLOGIS FUND LP' : 'SMITH FAMILY LLC',
  }));
  rows.push({ address: '1100 Rarig Ave', suite: 'B', sf: 8000, rentLow: 12, owner: 'OXFORD RARIG LLC' });
  return rows;
}
async function seeded(screenAvailable = true) {
  const dir = mkdtempSync(join(tmpdir(), 'lm-compute-'));
  const db = openWarehouse(join(dir, 't.sqlite'));
  const config = testConfig();
  const r = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-15.xlsx', listings()), {
    config, headerMap: testHeaderMap(), rawDir: join(dir, 'raw'), now: () => '2026-02-16T00:00:00Z',
    screen: (names) => ({ ...stubScreen(names), available: screenAvailable }),
  });
  expect(r.status).toBe('ingested');
  return { db, config };
}
const evidenceOf = (db: ReturnType<typeof openWarehouse>, kind: string) =>
  db.prepare('SELECT s.score, s.severity, s.confidence, s.comp_basis, s.evidence_json, p.address_display FROM lm_signal s JOIN lm_property p ON p.id = s.property_id WHERE s.kind = ?').all(kind) as Array<{ score: number | null; severity: string; confidence: string | null; comp_basis: string | null; evidence_json: string; address_display: string }>;

describe('loadMarketState', () => {
  it('keeps ORA spaces out of benchmarks and comparable candidates', async () => {
    const { db, config } = await seeded();
    const s = loadMarketState(db, config, '2026-03-01');
    expect(s.spaces).toHaveLength(13);
    expect(s.benchRows).toHaveLength(12);
    expect(s.candidates).toHaveLength(12);
    expect(s.spaces.find((x) => x.property.oraPropertyKey === '1100 Rarig')?.isOraOwned).toBe(true);
    expect(s.spaces.every((x) => x.isNewInLatestExport)).toBe(true);
  });
});

describe('runCompute', () => {
  it('persists similarity-based below-market signals, one radar candidate, and the feed', async () => {
    const { db, config } = await seeded();
    const r = runCompute(db, config, '2026-03-01');
    expect(r.byKind).toEqual({ new_listing: 12, below_market: 2, radar_candidate: 1 });
    expect(r).toMatchObject({ signals: 15, radarCandidates: 1, feedRows: 1, withheldMarkets: [] });

    const below = evidenceOf(db, 'below_market');
    expect(below.every((b) => b.comp_basis === 'similarity' && b.confidence === 'MEDIUM')).toBe(true);

    const [radar] = evidenceOf(db, 'radar_candidate');
    expect(radar!.address_display).toBe('101 Industrial Pkwy');
    expect(radar!.score).toBe(55);
    expect(radar!.severity).toBe('watch');
    // Minor fix (controller decision): the radar signal's comp_basis column records the best-gap
    // space's comparables basis, not a hardcoded null.
    expect(radar!.comp_basis).toBe('similarity');
    const ev = JSON.parse(radar!.evidence_json) as Record<string, unknown>;
    expect(ev).toMatchObject({ part_dom: 0, part_reductions: 0, part_belowMarket: 25, part_vacancy: 15, part_buyBoxFit: 10, part_owner: 5, ownerType: 'private', ownerListingCount: 11, indicativeRentGapLabel: 'gross, vacant space only — not NOI', gateFailures: '' });
    expect(ev.comparableMedian as number).toBeCloseTo(9.4);
    expect(ev.indicativeRentGapUsd as number).toBeCloseTo(68000);

    const feed = db.prepare('SELECT * FROM lm_market_rent_feed').all() as Array<Record<string, unknown>>;
    expect(feed).toHaveLength(1);
    expect(feed[0]).toMatchObject({ ora_property_key: '1100 Rarig', comp_basis: 'similarity', confidence: 'MEDIUM', n: 12, computed_at: '2026-03-01' });
    expect(feed[0]!.asking_nnn_eq as number).toBeCloseTo(9.3);
  });

  it('replaces signals on re-run and never touches radar decisions', async () => {
    const { db, config } = await seeded();
    db.prepare(`INSERT INTO lm_radar_decision (property_id, decided_at, decision, note) VALUES (1, '2026-03-01', 'investigate', 'call broker')`).run();
    runCompute(db, config, '2026-03-01');
    runCompute(db, config, '2026-03-01');
    expect((db.prepare('SELECT COUNT(*) AS n FROM lm_signal').get() as { n: number }).n).toBe(15);
    expect((db.prepare('SELECT COUNT(*) AS n FROM lm_radar_decision').get() as { n: number }).n).toBe(1);
  });

  it('withholds radar candidates when the owner screen was unavailable', async () => {
    const { db, config } = await seeded(false);
    const r = runCompute(db, config, '2026-03-01');
    expect(r.byKind.radar_candidate).toBeUndefined();
    expect(r.withheldMarkets).toEqual(['columbus']);
  });

  it('skips the feed for non-NNN ORA properties', async () => {
    const { db, config } = await seeded();
    const mg = testConfig({ oraProperties: config.oraProperties.map((p) => ({ ...p, leaseBasis: 'MG' as const })) });
    expect(runCompute(db, mg, '2026-03-01').feedRows).toBe(0);
  });
});

describe('read models', () => {
  it('freshness, data quality, DOM bins, KPIs and latest-export changes', async () => {
    const { db, config } = await seeded();
    runCompute(db, config, '2026-03-01');
    const state = loadMarketState(db, config, '2026-03-01');

    const fresh = marketFreshness(db, config, '2026-03-01');
    expect(fresh.find((f) => f.marketId === 'columbus')).toMatchObject({ enabled: true, lastCompleteDate: '2026-02-15', lastCompleteness: 'complete', stale: false });
    expect(fresh.find((f) => f.marketId === 'madison')).toMatchObject({ lastCompleteDate: null, stale: true });
    expect(marketFreshness(db, config, '2026-04-01').find((f) => f.marketId === 'columbus')?.stale).toBe(true);

    expect(marketDataQuality(db, config, state).find((q) => q.marketId === 'columbus')).toEqual({
      marketId: 'columbus', activeSpaces: 13, lastExportRows: 13, lastExportSkipped: 0, quotedShare: 1, coordsShare: 1, lowConfidenceShare: 0, rejectedRents: 0,
    });
    expect(domBins(state, '2026-03-01')).toEqual([
      { marketId: 'columbus', bins: [{ label: '0-90d', count: 12 }, { label: '90-180d', count: 0 }, { label: '180-365d', count: 0 }, { label: '365d+', count: 0 }] },
    ]);
    // newInLatest excludes ORA's own space (fix round 2, requirement 6): 12 of the 13 'new' events are
    // market comps; activeSpaces stays 13 (it's an inventory count, ORA included — see compute.ts).
    expect(leaseMarketKpis(db, config, state, '2026-03-01')).toEqual({ marketsFresh: 1, marketsEnabled: 2, activeSpaces: 13, newInLatest: 12, priceCutsInLatest: 0, stale: 0, radarCandidates: 1 });
    const events = latestExportEvents(db, config);
    expect(events).toHaveLength(13);
    expect(events.every((e) => e.kind === 'new' && e.marketId === 'columbus' && e.eventDate === '2026-02-15')).toBe(true);
  });
});

// ── REFUTE fix round (warehouse: R2, R10, R13, R16) ─────────────────────────

describe('R2 — ORA-self owner excluded even when unmapped to any configured address', () => {
  it('excludes an affiliated-owner listing from candidates, benchmarks, signals and radar', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lm-compute-r2-'));
    const db = openWarehouse(join(dir, 't.sqlite'));
    const config = testConfig();
    const rows: FixtureListing[] = [
      // ORA's own listing at an address NOT in oraProperties.addressNorms ('1100 RARIG AVE') — the
      // owner screen still correctly verdicts it 'affiliated' (ORA-SELF), but ora_property_key stays
      // null since no config entry matches this address.
      { address: '1100-1120 Rarig Ave', suite: 'B', sf: 8000, rentLow: 5.0, owner: 'OXFORD RARIG LLC' },
      ...Array.from({ length: 10 }, (_, i) => ({ id: `M${i}`, address: `${i + 1} Market St`, sf: 8000, rentLow: 9.0 })),
    ];
    const r0 = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', rows), {
      config, headerMap: testHeaderMap(), rawDir: join(dir, 'raw'), now: () => '2026-01-02T00:00:00Z', screen: stubScreen,
    });
    expect(r0.status).toBe('ingested');
    const row = db.prepare("SELECT owner_type, ora_property_key FROM lm_property WHERE address_norm = '1100-1120 RARIG AVE'").get();
    expect(row).toEqual({ owner_type: 'affiliated', ora_property_key: null });

    const state = loadMarketState(db, config, '2026-02-01');
    const oraSelf = state.spaces.find((s) => s.property.addressDisplay === '1100-1120 Rarig Ave');
    expect(oraSelf).toBeDefined();
    expect(oraSelf?.isOraOwned).toBe(true);
    expect(state.candidates.some((c) => c.listingId === oraSelf?.listingId)).toBe(false);
    expect(state.benchRows.some((b) => b.listingId === oraSelf?.listingId)).toBe(false);

    runCompute(db, config, '2026-02-01');
    const signalsOnSelf = db.prepare('SELECT s.kind FROM lm_signal s JOIN lm_property p ON p.id = s.property_id WHERE p.address_norm = ?').all('1100-1120 RARIG AVE');
    expect(signalsOnSelf).toEqual([]); // no new_listing / stale / below_market / radar_candidate signal
  });
});

describe('R10 — back-dated first sighting excluded from "new in latest export"', () => {
  it('a space whose first sighting predates the latest complete landing is not new-in-latest, in either the signal or the KPI', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lm-compute-r10-'));
    const db = openWarehouse(join(dir, 't.sqlite'));
    const config = testConfig();
    const deps = { config, headerMap: testHeaderMap(), rawDir: join(dir, 'raw'), now: () => '2026-09-17T00:00:00Z', screen: stubScreen };
    const base: FixtureListing[] = Array.from({ length: 5 }, (_, i) => ({ id: `B${i}`, address: `${i + 1} Base St`, sf: 8000, rentLow: 9.0 }));
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-01-01.xlsx', base), deps);
    await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-03-01.xlsx', base), deps);
    const feb = await ingestCostarListingsFile(
      db,
      await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-01.xlsx', [...base, { id: 'N1', address: '99 New Rd', sf: 8000, rentLow: 9.0 }]),
      deps,
    );
    expect(feb.completeness).toBe('partial');

    const state = loadMarketState(db, config, '2026-09-17');
    expect(state.spaces.find((s) => s.property.addressDisplay === '99 New Rd')?.isNewInLatestExport).toBe(false);

    const r = runCompute(db, config, '2026-09-17');
    expect(r.byKind.new_listing ?? 0).toBe(0);

    const kpis = leaseMarketKpis(db, config, state, '2026-09-17');
    expect(kpis.newInLatest).toBe(0);
  });
});

describe('R13 — ora_property_key is re-applied idempotently at every compute run', () => {
  it('flags and excludes an existing property once oraProperties is filled in after ingest', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lm-compute-r13-'));
    const db = openWarehouse(join(dir, 't.sqlite'));
    const bare = testConfig({ oraProperties: [] });
    const rows: FixtureListing[] = [
      // A non-affiliated owner name, so any exclusion below is caused ONLY by the ora_property_key
      // re-stamp (R13), not by the ownerType === 'affiliated' path (R2).
      { address: '1100 Rarig Ave', suite: 'B', sf: 8000, rentLow: 12, owner: 'SMITH FAMILY LLC' },
      ...RENTS.map((rent, i) => ({ id: `C${i}`, address: `${100 + i} Industrial Pkwy`, sf: 20000, rentLow: rent })),
    ];
    const r0 = await ingestCostarListingsFile(db, await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-15.xlsx', rows), {
      config: bare, headerMap: testHeaderMap(), rawDir: join(dir, 'raw'), now: () => '2026-02-16T00:00:00Z', screen: stubScreen,
    });
    expect(r0.status).toBe('ingested');
    expect((db.prepare("SELECT ora_property_key FROM lm_property WHERE address_norm = '1100 RARIG AVE'").get() as { ora_property_key: string | null }).ora_property_key).toBeNull();

    const filled = testConfig(); // has the '1100 Rarig' oraProperties entry (addressNorms: ['1100 RARIG AVE'])
    runCompute(db, filled, '2026-03-01');
    expect((db.prepare("SELECT ora_property_key FROM lm_property WHERE address_norm = '1100 RARIG AVE'").get() as { ora_property_key: string | null }).ora_property_key).toBe('1100 Rarig');

    const state = loadMarketState(db, filled, '2026-03-01');
    const rarig = state.spaces.find((s) => s.property.addressDisplay === '1100 Rarig Ave');
    expect(rarig?.isOraOwned).toBe(true);
    expect(state.candidates.some((c) => c.listingId === rarig?.listingId)).toBe(false);

    // Idempotent: running compute again with the same config does not error or double-apply.
    expect(() => runCompute(db, filled, '2026-03-02')).not.toThrow();
    expect((db.prepare("SELECT ora_property_key FROM lm_property WHERE address_norm = '1100 RARIG AVE'").get() as { ora_property_key: string | null }).ora_property_key).toBe('1100 Rarig');
  });
});

describe('R16 — loud warning when config.oraProperties is empty', () => {
  it('warns naming the consequence when oraProperties is empty, and does not warn when it is populated', async () => {
    const { db, config } = await seeded();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    runCompute(db, testConfig({ oraProperties: [] }), '2026-03-01');
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('[lease-market]') && String(c[0]).toLowerCase().includes('oraproperties'))).toBe(true);
    warnSpy.mockClear();
    runCompute(db, config, '2026-03-01'); // config has a populated oraProperties list
    expect(warnSpy.mock.calls.some((c) => String(c[0]).toLowerCase().includes('oraproperties'))).toBe(false);
    warnSpy.mockRestore();
  });
});
