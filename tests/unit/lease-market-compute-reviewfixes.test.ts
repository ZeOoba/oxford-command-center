// tests/unit/lease-market-compute-reviewfixes.test.ts
//
// Task 10 (lease-market compute) review fix round — regression coverage for each reviewer finding.
// Kept separate from lease-market-compute.test.ts (which Task 10's own report already covers end to
// end) so each fix gets its own narrowly-scoped, easy-to-audit scenario.
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse, type WarehouseDb } from '../../server/warehouse/db';
import { ingestCostarListingsFile } from '../../server/warehouse/lease-market/ingest';
import {
  comparablesForSpace, isActive, latestExportEvents, loadMarketState, oraSubject, runCompute, staleThresholdsByMarket,
  type ComputeResult,
} from '../../server/warehouse/lease-market/compute';
import { stubScreen, testConfig, testHeaderMap, writeCostarFixture, type FixtureListing } from './lease-market-fixtures';

async function ingestFixture(db: WarehouseDb, dir: string, fileName: string, listings: FixtureListing[], observedAt: string) {
  const config = testConfig();
  return ingestCostarListingsFile(db, await writeCostarFixture(dir, fileName, listings), {
    config, headerMap: testHeaderMap(), rawDir: join(dir, 'raw'), now: () => `${observedAt}T00:00:00Z`, screen: (names) => stubScreen(names),
  });
}

// ── Fix round 2, requirement 1: the "latest export" event window ─────────────────────────────────
describe('latest-export event window (requirement 1)', () => {
  it('counts events from a partial landing sandwiched between two complete landings, and drops the superseded complete landing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lm-fix-window-'));
    const db = openWarehouse(join(dir, 't.sqlite'));
    const config = testConfig();
    const base = (): FixtureListing[] =>
      Array.from({ length: 10 }, (_, i) => ({ id: `W${i}`, address: `${200 + i} Window Pkwy`, sf: 20000, rentLow: 9, owner: 'SMITH FAMILY LLC' }));

    const a = await ingestFixture(db, dir, 'costar-listings_columbus_2026-01-05.xlsx', base(), '2026-01-05');
    expect(a.completeness).toBe('complete');

    // Partial: row-count-ratio breach (6 rows < 0.7 x prior complete's 10), but it lands a brand-new
    // listing not present in A — that listing's 'new' event must still count as "the latest export".
    const bListings: FixtureListing[] = [
      ...base().slice(0, 5),
      { id: 'W-NEW-B', address: '999 Bravo Way', sf: 20000, rentLow: 9, owner: 'SMITH FAMILY LLC' },
    ];
    const b = await ingestFixture(db, dir, 'costar-listings_columbus_2026-01-10.xlsx', bListings, '2026-01-10');
    expect(b.completeness).toBe('partial');

    // Complete again; one original listing's rent drops, producing a price_cut on C's own landing.
    const cListings = base().map((l, i) => (i === 0 ? { ...l, rentLow: 7 } : l));
    const c = await ingestFixture(db, dir, 'costar-listings_columbus_2026-01-20.xlsx', cListings, '2026-01-20');
    expect(c.completeness).toBe('complete');

    const events = latestExportEvents(db, config);
    // A is now the SECOND-latest complete landing — its own 'new' events are superseded, not "latest".
    expect(events.some((e) => e.kind === 'new' && e.address === '200 Window Pkwy')).toBe(false);
    // B's new listing counts even though B itself was only partial.
    expect(events.some((e) => e.kind === 'new' && e.address === '999 Bravo Way')).toBe(true);
    // C's price cut counts too.
    expect(events.some((e) => e.kind === 'price_cut' && e.address === '200 Window Pkwy')).toBe(true);

    // Same window feeds loadMarketState's isNewInLatestExport for the space B introduced.
    const state = loadMarketState(db, config, '2026-02-01');
    const bravo = state.spaces.find((s) => s.addressDisplay === '999 Bravo Way');
    expect(bravo?.isNewInLatestExport).toBe(true);
  });
});

// ── Fix round 2, requirement 2: oraSubject is market-filtered and deterministic ───────────────────
describe('oraSubject market-filtered, deterministic lookup (requirement 2)', () => {
  function insertProperty(db: WarehouseDb, p: { identityKey: string; marketId: string; oraKey: string; clearHeightFt: number }): number {
    return Number(
      db
        .prepare(
          `INSERT INTO lm_property (identity_key, address_norm, address_display, city_norm, market_id, subtype, building_status, owner_type, ora_property_key, clear_height_ft, first_seen, last_seen)
           VALUES (?, '1100 RARIG AVE', '1100 Rarig Ave', '', ?, 'warehouse', 'existing', 'unknown', ?, ?, '2026-01-01', '2026-01-01')`,
        )
        .run(p.identityKey, p.marketId, p.oraKey, p.clearHeightFt).lastInsertRowid,
    );
  }

  it('matches only the lowest-id property in the configured market, never a same-keyed row in another market or a later duplicate', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lm-fix-orasubject-'));
    const db = openWarehouse(join(dir, 't.sqlite'));
    const config = testConfig(); // oraProperties[0]: propertyKey '1100 Rarig', marketId 'columbus'

    // Wrong-market row sharing the same ora_property_key — must never be picked regardless of id order.
    insertProperty(db, { identityKey: 'costar:wrong-market', marketId: 'madison', oraKey: '1100 Rarig', clearHeightFt: 99 });
    // The correct row, in the correct market.
    const correctId = insertProperty(db, { identityKey: 'costar:correct', marketId: 'columbus', oraKey: '1100 Rarig', clearHeightFt: 15 });
    // A later same-market duplicate — must lose the tie-break to the lower id.
    insertProperty(db, { identityKey: 'costar:dup', marketId: 'columbus', oraKey: '1100 Rarig', clearHeightFt: 77 });

    const state = loadMarketState(db, config, '2026-03-01');
    const result = oraSubject(config.oraProperties[0]!, state, config.oraProperties[0]!.typicalUnitSf, config.thresholds);
    expect(result.matchedPropertyId).toBe(correctId);
    expect(result.profile.clearHeightFt).toBe(15);
  });
});

// ── Fix round 2, requirement 3: multi-market comparable isolation ────────────────────────────────
describe('multi-market comparable isolation (requirement 3)', () => {
  it("a Columbus space's comparables never include another market's rows", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lm-fix-multimarket-'));
    const db = openWarehouse(join(dir, 't.sqlite'));
    const config = testConfig();

    const columbusListings: FixtureListing[] = Array.from({ length: 5 }, (_, i) => ({
      id: `CX${i}`, address: `${300 + i} Columbus Way`, sf: 20000, rentLow: 9, owner: 'SMITH FAMILY LLC', market: 'Columbus',
    }));
    const madisonListings: FixtureListing[] = Array.from({ length: 5 }, (_, i) => ({
      id: `MD${i}`, address: `${400 + i} Madison Way`, sf: 20000, rentLow: 50, owner: 'SMITH FAMILY LLC', market: 'Madison', city: 'Madison',
    }));

    await ingestFixture(db, dir, 'costar-listings_columbus_2026-01-05.xlsx', columbusListings, '2026-01-05');
    await ingestFixture(db, dir, 'costar-listings_madison_2026-01-05.xlsx', madisonListings, '2026-01-05');

    const state = loadMarketState(db, config, '2026-02-01');
    expect(state.candidates).toHaveLength(10); // 5 Columbus + 5 Madison
    const subject = state.spaces.find((s) => s.addressDisplay === '300 Columbus Way')!;
    const comps = comparablesForSpace(state, subject, config)!;
    expect(comps.n).toBeGreaterThan(0);
    expect(comps.values.every((v) => v < 15)).toBe(true); // never picks up Madison's $50 rows
  });
});

// ── Fix round 2, requirement 4: the whole compute is one atomic run ──────────────────────────────
describe('runCompute atomicity (requirement 4)', () => {
  async function seededSmall() {
    const dir = mkdtempSync(join(tmpdir(), 'lm-fix-atomic-'));
    const db = openWarehouse(join(dir, 't.sqlite'));
    const config = testConfig();
    const listings: FixtureListing[] = Array.from({ length: 6 }, (_, i) => ({ id: `AT${i}`, address: `${500 + i} Atomic Ave`, sf: 20000, rentLow: 9, owner: 'SMITH FAMILY LLC' }));
    await ingestFixture(db, dir, 'costar-listings_columbus_2026-01-05.xlsx', listings, '2026-01-05');
    return { db, config };
  }

  it('opens exactly one IMMEDIATE transaction around the entire run', async () => {
    const { db, config } = await seededSmall();
    interface TxLike {
      immediate: () => ComputeResult;
    }
    const original = db.transaction.bind(db) as (fn: () => ComputeResult) => TxLike;
    let transactionCalls = 0;
    let immediateUsed = false;
    (db as unknown as { transaction: (fn: () => ComputeResult) => TxLike }).transaction = (fn: () => ComputeResult): TxLike => {
      transactionCalls++;
      const wrapped = original(fn);
      return {
        immediate: () => {
          immediateUsed = true;
          return wrapped.immediate();
        },
      };
    };

    runCompute(db, config, '2026-03-01');
    expect(transactionCalls).toBe(1);
    expect(immediateUsed).toBe(true);
  });
});

// ── Fix round 2, requirement 5: stale-baseline n >= 10, ORA and future removals excluded ──────────
describe('stale-threshold baseline (requirement 5)', () => {
  function insertLanding(db: WarehouseDb, marketId: string, observedAt: string, ref: string): number {
    return Number(
      db
        .prepare(
          `INSERT INTO lm_landing (source, source_ref, sha256, market_id, observed_at, received_at, row_count, skipped_count, completeness, owner_screen_ok, parse_status)
           VALUES ('costar_listings', ?, ?, ?, ?, ?, 0, 0, 'complete', 1, 'ok')`,
        )
        .run(ref, `sha-${ref}`, marketId, observedAt, observedAt).lastInsertRowid,
    );
  }
  function insertProperty(db: WarehouseDb, opts: { identityKey: string; marketId: string; oraKey: string | null }): number {
    return Number(
      db
        .prepare(
          `INSERT INTO lm_property (identity_key, address_norm, address_display, city_norm, market_id, subtype, building_status, owner_type, ora_property_key, first_seen, last_seen)
           VALUES (?, ?, ?, '', ?, 'warehouse', 'existing', 'unknown', ?, '2025-01-01', '2025-01-01')`,
        )
        .run(opts.identityKey, opts.identityKey, opts.identityKey, opts.marketId, opts.oraKey).lastInsertRowid,
    );
  }
  function insertRemovedListing(
    db: WarehouseDb,
    opts: { propertyId: number; landingId: number; suiteNorm: string; firstSeen: string; removedAt: string },
  ): void {
    db.prepare(
      `INSERT INTO lm_listing (property_id, suite_norm, first_seen, last_seen, first_landing_id, status, removed_at, origin_tier)
       VALUES (?, ?, ?, ?, ?, 'removed', ?, 'T1')`,
    ).run(opts.propertyId, opts.suiteNorm, opts.firstSeen, opts.removedAt, opts.landingId, opts.removedAt);
  }
  function addDaysStr(iso: string, days: number): string {
    return new Date(Date.parse(iso) + days * 86_400_000).toISOString().slice(0, 10);
  }

  it('uses only non-ORA removed T1 listings removed at-or-before asOf, n >= completedDomMinN', () => {
    const dir = mkdtempSync(join(tmpdir(), 'lm-fix-baseline-'));
    const db = openWarehouse(join(dir, 't.sqlite'));
    const config = testConfig(); // completedDomMinN = 10, staleFloorDays = 180, staleBaselineMultiple = 1.5
    const asOf = '2026-06-01';
    const removedAt = '2026-03-01';
    const landingId = insertLanding(db, 'columbus', removedAt, 'baseline-landing');

    // 10 valid comparables: five at DOM=100, five at DOM=300 -> median 200 -> threshold max(180, 300) = 300.
    const doms = [...Array(5).fill(100), ...Array(5).fill(300)];
    doms.forEach((dom, i) => {
      const propertyId = insertProperty(db, { identityKey: `valid-${i}`, marketId: 'columbus', oraKey: null });
      insertRemovedListing(db, { propertyId, landingId, suiteNorm: `V${i}`, firstSeen: addDaysStr(removedAt, -dom), removedAt });
    });

    // Extra ORA-owned removed listing at DOM=100 — if wrongly included, it would pull the median DOWN
    // to 100 (six values at 100 vs five at 300) and the threshold down to 180.
    const oraPropertyId = insertProperty(db, { identityKey: 'ora-owned', marketId: 'columbus', oraKey: 'Some ORA Property' });
    insertRemovedListing(db, { propertyId: oraPropertyId, landingId, suiteNorm: 'ORA', firstSeen: addDaysStr(removedAt, -100), removedAt });

    // Extra non-ORA removal dated AFTER asOf — must not leak into a point-in-time baseline either.
    const futurePropertyId = insertProperty(db, { identityKey: 'future-removed', marketId: 'columbus', oraKey: null });
    const futureRemovedAt = addDaysStr(asOf, 30);
    insertRemovedListing(db, { propertyId: futurePropertyId, landingId, suiteNorm: 'FUT', firstSeen: addDaysStr(futureRemovedAt, -100), removedAt: futureRemovedAt });

    const thresholds = staleThresholdsByMarket(db, config, asOf);
    expect(thresholds.get('columbus')).toBe(300);
  });
});

// ── Fix round 2, requirement 7: additional coverage ───────────────────────────────────────────────
describe('feed skips LOW-confidence comparables (requirement 7)', () => {
  it('does not publish a market-rent feed row when the resolved comparables are LOW confidence', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lm-fix-feedlow-'));
    const db = openWarehouse(join(dir, 't.sqlite'));
    const config = testConfig({
      oraProperties: [
        {
          propertyKey: 'Sparse Madison', marketId: 'madison', submarket: null, subtype: 'warehouse', officePct: null, typicalUnitSf: 20000,
          leaseBasis: 'NNN', addressNorms: ['999 SPARSE AVE'], lat: null, lon: null, clearHeightFt: null, yearBuilt: null, docks: null, driveIns: null,
        },
      ],
    });
    // Only 2 Madison comps: below similarityMinComps (8) and belowMarketMinN (10) -> cell confidence LOW.
    const listings: FixtureListing[] = [
      { id: 'SP0', address: '990 Sparse Ave', sf: 20000, rentLow: 9, owner: 'SMITH FAMILY LLC', market: 'Madison', city: 'Madison' },
      { id: 'SP1', address: '991 Sparse Ave', sf: 20000, rentLow: 9.5, owner: 'SMITH FAMILY LLC', market: 'Madison', city: 'Madison' },
    ];
    await ingestFixture(db, dir, 'costar-listings_madison_2026-01-05.xlsx', listings, '2026-01-05');

    const r = runCompute(db, config, '2026-02-01');
    expect(r.feedRows).toBe(0);
  });
});

describe('withdrawn_after_stale end-to-end through compute (requirement 7)', () => {
  it('a space removed after a long, stale run generates a withdrawn_after_stale signal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lm-fix-withdrawn-'));
    const db = openWarehouse(join(dir, 't.sqlite'));
    const config = testConfig();
    const filler = (): FixtureListing[] =>
      Array.from({ length: 4 }, (_, i) => ({ id: `WS${i}`, address: `${800 + i} Filler Ave`, sf: 20000, rentLow: 9, owner: 'SMITH FAMILY LLC' }));
    const target: FixtureListing = { id: 'WS-TARGET', address: '900 Stale Rd', sf: 20000, rentLow: 9, owner: 'SMITH FAMILY LLC', dateOnMarket: '2025-06-01' };

    await ingestFixture(db, dir, 'costar-listings_columbus_2026-01-05.xlsx', [...filler(), target], '2026-01-05');
    const r2 = await ingestFixture(db, dir, 'costar-listings_columbus_2026-02-01.xlsx', filler(), '2026-02-01');
    expect(r2.completeness).toBe('complete'); // target now missing_once
    const r3 = await ingestFixture(db, dir, 'costar-listings_columbus_2026-03-01.xlsx', filler(), '2026-03-01');
    expect(r3.completeness).toBe('complete'); // second consecutive miss -> removed

    const state = loadMarketState(db, config, '2026-03-10');
    const targetSpace = state.spaces.find((s) => s.addressDisplay === '900 Stale Rd')!;
    expect(targetSpace.status).toBe('removed');

    runCompute(db, config, '2026-03-10');
    const rows = db
      .prepare(`SELECT evidence_json FROM lm_signal WHERE kind = 'withdrawn_after_stale' AND listing_id = ?`)
      .all(targetSpace.listingId) as Array<{ evidence_json: string }>;
    expect(rows).toHaveLength(1);
    const ev = JSON.parse(rows[0]!.evidence_json) as Record<string, unknown>;
    expect(ev.domAtRemoval as number).toBeGreaterThanOrEqual(180);
  });
});

describe('missing_once semantics (requirement 7)', () => {
  it('one missed complete export keeps the space active, not removed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lm-fix-missing-'));
    const db = openWarehouse(join(dir, 't.sqlite'));
    const config = testConfig();
    const present: FixtureListing[] = Array.from({ length: 4 }, (_, i) => ({ id: `MO${i}`, address: `${700 + i} Missing Ave`, sf: 20000, rentLow: 9, owner: 'SMITH FAMILY LLC' }));

    await ingestFixture(db, dir, 'costar-listings_columbus_2026-01-05.xlsx', present, '2026-01-05');
    const without700 = present.filter((l) => l.address !== '700 Missing Ave');
    const r2 = await ingestFixture(db, dir, 'costar-listings_columbus_2026-01-12.xlsx', without700, '2026-01-12');
    expect(r2.completeness).toBe('complete');

    const state = loadMarketState(db, config, '2026-01-20');
    const missed = state.spaces.find((s) => s.addressDisplay === '700 Missing Ave')!;
    expect(missed.status).toBe('missing_once');
    expect(isActive(missed)).toBe(true);

    runCompute(db, config, '2026-01-20');
    const withdrawn = db
      .prepare(`SELECT COUNT(*) AS n FROM lm_signal WHERE kind = 'withdrawn_after_stale' AND listing_id = ?`)
      .get(missed.listingId) as { n: number };
    expect(withdrawn.n).toBe(0);
  });
});
