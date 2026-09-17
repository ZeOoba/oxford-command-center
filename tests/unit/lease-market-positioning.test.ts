// tests/unit/lease-market-positioning.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse, type WarehouseDb } from '../../server/warehouse/db';
import { ingestCostarListingsFile } from '../../server/warehouse/lease-market/ingest';
import { loadMarketState } from '../../server/warehouse/lease-market/compute';
import { computePositioning, recommendationFor } from '../../server/warehouse/lease-market/positioning';
import type { LeaseMarketConfig } from '../../src/contracts/lease-market';
import type { ResolvedComparables } from '../../src/analytics/lease-market/similarity';
import { stubScreen, testConfig, testHeaderMap, writeCostarFixture, type FixtureListing } from './lease-market-fixtures';

const stats = (patch: Partial<ResolvedComparables> = {}): ResolvedComparables => ({
  basis: 'similarity', n: 12, low: 7, p25: 9, median: 10, p75: 11, high: 12, values: [8, 9, 10, 11, 12], confidence: 'MEDIUM', cellKey: null, comps: [],
  // R3: similarity.ts's ResolvedComparables now carries the union of unknown components that drove the
  // confidence cap; this mock fixture has none unless a test patches it in.
  unknown: [], ...patch,
});

describe('recommendationFor', () => {
  it('covers every branch', () => {
    expect(recommendationFor({ asking: 10, matched: false, stats: null, bandPct: 0.1 })).toBe('No comparable asking rents yet for this size and type.');
    expect(recommendationFor({ asking: null, matched: false, stats: stats(), bandPct: 0.1 })).toBe('No ORA asking rent found in CoStar — confirm the unit is being marketed. Comparable range $9.00–$11.00.');
    expect(recommendationFor({ asking: null, matched: true, stats: stats(), bandPct: 0.1 })).toBe('ORA listing found in CoStar but its asking rent is withheld or not normalizable. Comparable range $9.00–$11.00.');
    expect(recommendationFor({ asking: 11.5, matched: true, stats: stats(), bandPct: 0.1 })).toBe('Asking is 15% above the comparable median ($10.00); comparable range $9.00–$11.00.');
    expect(recommendationFor({ asking: 8.5, matched: true, stats: stats(), bandPct: 0.1 })).toBe('Asking is 15% below the comparable median ($10.00); room to move toward $9.00–$10.00.');
    expect(recommendationFor({ asking: 10.5, matched: true, stats: stats(), bandPct: 0.1 })).toBe('Within the comparable range ($9.00–$11.00).');
    expect(recommendationFor({ asking: 10.5, matched: true, stats: stats({ confidence: 'LOW', n: 3 }), bandPct: 0.1 })).toBe('Thin comparable set (n=3) — indicative only. Within the comparable range ($9.00–$11.00).');
  });

  it('prints one decimal of percent when the rounded whole number equals the band threshold, to avoid reading as the boundary', () => {
    // gap = (11.04 - 10) / 10 = 0.104 -> rounds to 10% which would collide with the 10% band edge.
    expect(recommendationFor({ asking: 11.04, matched: true, stats: stats({ median: 10, p25: 9, p75: 11 }), bandPct: 0.1 })).toBe('Asking is 10.4% above the comparable median ($10.00); comparable range $9.00–$11.00.');
  });

  it('treats nominally-exact 10% gaps as in_band despite floating-point division noise', () => {
    expect(recommendationFor({ asking: 7.7, matched: true, stats: stats({ median: 7.0, p25: 6, p75: 8 }), bandPct: 0.1 })).toBe('Within the comparable range ($6.00–$8.00).');
    expect(recommendationFor({ asking: 8.1, matched: true, stats: stats({ median: 9.0, p25: 8, p75: 10 }), bandPct: 0.1 })).toBe('Within the comparable range ($8.00–$10.00).');
    expect(recommendationFor({ asking: 13.2, matched: true, stats: stats({ median: 12.0, p25: 11, p75: 13 }), bandPct: 0.1 })).toBe('Within the comparable range ($11.00–$13.00).');
  });

  it('guards a non-positive median instead of dividing by it', () => {
    expect(recommendationFor({ asking: 10, matched: true, stats: stats({ median: 0, p25: 5, p75: 6 }), bandPct: 0.1 })).toBe('Within the comparable range ($5.00–$6.00).');
  });
});

async function newDb() {
  const dir = mkdtempSync(join(tmpdir(), 'lm-pos-'));
  const db = openWarehouse(join(dir, 't.sqlite'));
  return { dir, db };
}

async function ingestInto(db: WarehouseDb, dir: string, config: LeaseMarketConfig, market: string, date: string, listings: FixtureListing[]) {
  return ingestCostarListingsFile(db, await writeCostarFixture(dir, `costar-listings_${market}_${date}.xlsx`, listings), {
    config, headerMap: testHeaderMap(), rawDir: join(dir, 'raw'), now: () => '2026-02-16T00:00:00Z', screen: stubScreen,
  });
}

const TEN_COMPS: FixtureListing[] = [8, 8.5, 9, 9.25, 9.5, 9.75, 10, 10.25, 10.5, 11].map((rent, i) => ({ id: `C${i}`, address: `${200 + i} Commerce Dr`, sf: 8000, rentLow: rent }));

async function state(extraOra: FixtureListing[] = []) {
  const { dir, db } = await newDb();
  const config = testConfig();
  const ora: FixtureListing[] = [{ address: '1100 Rarig Ave', suite: 'B', sf: 8000, rentLow: 11.5, owner: 'OXFORD RARIG LLC', broker: 'Lee Lister', url: 'https://example.test/rarig-b' }, ...extraOra];
  await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...TEN_COMPS, ...ora]);
  return { dir, db, config, s: loadMarketState(db, config, '2026-03-01') };
}

describe('computePositioning', () => {
  it('positions a matched ORA suite against similarity comps with evidence', async () => {
    const { config, s } = await state();
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'Suite B', sf: 8000 }], config, s, true);
    const row = r.rows[0]!;
    expect(row).toMatchObject({ propertyKey: '1100 Rarig', unit: 'Suite B', oraAskingNnnEq: 11.5, band: 'above', flags: [], brokerName: 'Lee Lister', listingUrl: 'https://example.test/rarig-b', dateListed: '2026-01-15', effectiveDom: 45 });
    expect(row.stats).toMatchObject({ basis: 'similarity', n: 10, confidence: 'MEDIUM', low: 8, high: 11 });
    expect(row.stats!.median).toBeCloseTo(9.625);
    expect(row.gapPct).toBeCloseTo(11.5 / 9.625 - 1);
    expect(row.percentile).toBe(1);
    expect(row.comps).toHaveLength(10);
    expect(row.comps[0]!.address).toMatch(/Commerce Dr/);
    expect(row.recommendation).toMatch(/^Asking is 19% above the comparable median \(\$9\.63\)/);
    expect(r.listedButLeased).toEqual([]);
  });

  it('flags a vacant unit that is not listed, and a listed suite that is not vacant', async () => {
    const { config, s } = await state([{ address: '1100 Rarig Ave', suite: 'C', sf: 6000, rentLow: 10, owner: 'OXFORD RARIG LLC' }]);
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'D', sf: 5000 }], config, s, true);
    expect(r.rows[0]).toMatchObject({ unit: 'D', oraAskingNnnEq: null, flags: ['not_listed'], band: 'unknown', effectiveDom: null });
    expect(r.rows[0]!.recommendation).toMatch(/^No ORA asking rent found in CoStar/);
    expect(r.listedButLeased.map((l) => l.suite).sort()).toEqual(['B', 'C']);
  });

  it('strips row-level identifiers and lists unconfigured properties', async () => {
    const { config, s } = await state();
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'B', sf: 8000 }, { propertyKey: 'Sepich', unit: '1', sf: 2000 }, { propertyKey: 'Sepich', unit: '2', sf: 2000 }], config, s, false);
    expect(r.unconfiguredPropertyKeys).toEqual(['Sepich']);
    expect(r.rows[0]).toMatchObject({ brokerName: null, listingUrl: null });
    expect(r.rows[0]!.comps.every((c) => c.address === null)).toBe(true);
  });

  // ── Fix round 1, item 1: only-space fallback ──────────────────────────────
  it('assigns exact-suite matches before any fallback, and refuses the fallback when a stated suite does not match', async () => {
    const { config, s } = await state();
    const r = computePositioning(
      [{ propertyKey: '1100 Rarig', unit: 'B', sf: 8000 }, { propertyKey: '1100 Rarig', unit: 'D', sf: 8000 }],
      config, s, true,
    );
    expect(r.rows[0]).toMatchObject({ unit: 'B', flags: [], oraAskingNnnEq: 11.5 });
    expect(r.rows[1]).toMatchObject({ unit: 'D', flags: ['not_listed'], oraAskingNnnEq: null });
    expect(r.listedButLeased).toEqual([]);
  });

  it('falls back to the only ORA space when the vacant unit carries no suite', async () => {
    const { config, s } = await state();
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: null, sf: 8000 }], config, s, true);
    expect(r.rows[0]).toMatchObject({ flags: [], oraAskingNnnEq: 11.5 });
  });

  it('falls back to the only ORA space when that space itself carries no suite, even if the unit states one', async () => {
    const { dir, db } = await newDb();
    const config = testConfig();
    const ora: FixtureListing[] = [{ address: '1100 Rarig Ave', sf: 8000, rentLow: 11.5, owner: 'OXFORD RARIG LLC' }]; // no suite
    await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...TEN_COMPS, ...ora]);
    const s = loadMarketState(db, config, '2026-03-01');
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'A', sf: 8000 }], config, s, true);
    expect(r.rows[0]).toMatchObject({ flags: [], oraAskingNnnEq: 11.5 });
  });

  it('does not fall back when there is more than one ORA space, even with a blank vacant-unit suite', async () => {
    const { config, s } = await state([{ address: '1100 Rarig Ave', suite: 'C', sf: 6000, rentLow: 10, owner: 'OXFORD RARIG LLC' }]);
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: null, sf: 8000 }], config, s, true);
    expect(r.rows[0]).toMatchObject({ flags: ['not_listed'], oraAskingNnnEq: null });
  });

  // ── Fix round 1, item 3: market scoping and deterministic ties ───────────
  it('scopes ORA matching to the configured market and breaks exact-suite ties by lowest listingId', async () => {
    const { dir, db } = await newDb();
    const config = testConfig({
      oraProperties: [
        {
          propertyKey: '1100 Rarig', marketId: 'columbus', submarket: 'East', subtype: 'warehouse', officePct: null, typicalUnitSf: 8000,
          leaseBasis: 'NNN', addressNorms: ['1100 RARIG AVE', '1200 RARIG AVE'], lat: null, lon: null, clearHeightFt: null, yearBuilt: null, docks: null, driveIns: null,
        },
      ],
    });
    const buildingA: FixtureListing = { address: '1100 Rarig Ave', suite: 'A', sf: 8000, rentLow: 9, owner: 'OXFORD RARIG LLC' };
    const buildingB: FixtureListing = { address: '1200 Rarig Ave', suite: 'A', sf: 8000, rentLow: 9.5, owner: 'OXFORD RARIG LLC' };
    await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...TEN_COMPS, buildingA, buildingB]);
    // An unrelated Madison-market listing, then retagged with the SAME ORA key as '1100 Rarig' via a
    // direct write — ingest.ts's own address+market matching would never produce this on its own, but
    // stale/legacy data (a pre-market-scoping ingest, a manual correction) can still leave a row like
    // this in the warehouse. positioning.ts must independently refuse to match across markets.
    await ingestInto(db, dir, config, 'madison', '2026-02-15', [{ address: '9999 Stray Ave', suite: 'Z', sf: 8000, rentLow: 8, market: 'Madison' }]);
    db.prepare(`UPDATE lm_property SET ora_property_key = '1100 Rarig' WHERE address_norm = '9999 STRAY AVE'`).run();

    const s = loadMarketState(db, config, '2026-03-01');
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'A', sf: 8000 }, { propertyKey: '1100 Rarig', unit: 'Z', sf: 8000 }], config, s, true);
    const rowA = r.rows[0]!;
    const rowZ = r.rows[1]!;
    // Both buildingA and buildingB carry suite "A"; the lower listingId (buildingA, inserted first) must win deterministically.
    expect(rowA.flags).toEqual([]);
    expect(rowA.oraAskingNnnEq).toBe(9);
    // The Madison-market row sharing the same ORA key must never match, regardless of its suite.
    expect(rowZ.flags).toEqual(['not_listed']);
    expect(rowZ.oraAskingNnnEq).toBeNull();
  });

  // ── Fix round 1, item 4: matched listing with a withheld/non-normalizable asking rent ──────
  it('distinguishes a matched listing with no normalizable asking rent from an unmatched unit', async () => {
    const { dir, db } = await newDb();
    const config = testConfig();
    // rentLow given as a withheld-style string -> parses to withheld/no askingNnnEq, but the listing still exists and matches by suite.
    const ora: FixtureListing = { address: '1100 Rarig Ave', suite: 'B', sf: 8000, rentLow: 'Negotiable', owner: 'OXFORD RARIG LLC' };
    await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...TEN_COMPS, ora]);
    const s = loadMarketState(db, config, '2026-03-01');
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'B', sf: 8000 }], config, s, true);
    expect(r.rows[0]).toMatchObject({ flags: [], oraAskingNnnEq: null, oraListingId: expect.any(Number) });
    expect(r.rows[0]!.recommendation).toMatch(/^ORA listing found in CoStar but its asking rent is withheld or not normalizable\./);
  });

  // ── Fix round 1, item 6: empty suites must not hide empty-suite listings from listedButLeased ──
  it('does not let a blank vacant-unit suite hide an empty-suite ORA listing from listedButLeased', async () => {
    const { dir, db } = await newDb();
    const config = testConfig();
    const blankSuite: FixtureListing = { address: '1100 Rarig Ave', sf: 8000, rentLow: 11.5, owner: 'OXFORD RARIG LLC' }; // suiteNorm ''
    const suiteC: FixtureListing = { address: '1100 Rarig Ave', suite: 'C', sf: 6000, rentLow: 10, owner: 'OXFORD RARIG LLC' };
    await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...TEN_COMPS, blankSuite, suiteC]);
    const s = loadMarketState(db, config, '2026-03-01');
    // Two ORA spaces -> no fallback applies; a blank vacant-unit suite must not be treated as "matches the blank listing".
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: null, sf: 5000 }], config, s, true);
    expect(r.rows[0]).toMatchObject({ flags: ['not_listed'] });
    expect(r.listedButLeased.map((l) => l.suite).sort()).toEqual(['', 'C']);
  });

  // ── Fix round 1, item 7: SF not stated, typicalUnitSf used ───────────────
  it('prefixes the recommendation when SF was not stated and typicalUnitSf was used to size the comp search', async () => {
    const { config, s } = await state();
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'Suite B', sf: 0 }], config, s, true);
    expect(r.rows[0]!.sf).toBe(0);
    expect(r.rows[0]!.recommendation).toMatch(/^SF not stated in the rent roll; analysed at 8000 SF\. /);
  });

  // ── Fix round 1, item 8: integration coverage ─────────────────────────────
  it('marks a thin comparable set LOW confidence and prefixes the recommendation', async () => {
    const { dir, db } = await newDb();
    const config = testConfig();
    // Only 6 comps: below similarityMinComps (8) so selectComps is insufficient; falls to the cell,
    // whose n (6) is >= benchmarkMinN (5) but < belowMarketMinN (10) -> LOW confidence with a real median.
    const thinComps: FixtureListing[] = [8, 8.5, 9, 9.5, 10, 10.5].map((rent, i) => ({ id: `T${i}`, address: `${300 + i} Thin Dr`, sf: 8000, rentLow: rent }));
    const ora: FixtureListing = { address: '1100 Rarig Ave', suite: 'B', sf: 8000, rentLow: 11.5, owner: 'OXFORD RARIG LLC' };
    await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...thinComps, ora]);
    const s = loadMarketState(db, config, '2026-03-01');
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'B', sf: 8000 }], config, s, true);
    const row = r.rows[0]!;
    expect(row.stats!.confidence).toBe('LOW');
    expect(row.stats!.basis).toBe('cell');
    expect(row.stats!.median).not.toBeNull();
    expect(row.recommendation).toMatch(/^Thin comparable set \(n=\d+\) — indicative only\./);
  });

  it('bands a below-market asking rent', async () => {
    const { dir, db } = await newDb();
    const config = testConfig();
    const ora: FixtureListing = { address: '1100 Rarig Ave', suite: 'B', sf: 8000, rentLow: 8.0, owner: 'OXFORD RARIG LLC' };
    await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...TEN_COMPS, ora]);
    const s = loadMarketState(db, config, '2026-03-01');
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'B', sf: 8000 }], config, s, true);
    const row = r.rows[0]!;
    expect(row.band).toBe('below');
    expect(row.recommendation).toMatch(/^Asking is \d+(\.\d)?% below the comparable median/);
  });

  it('bands an in-band asking rent', async () => {
    const { dir, db } = await newDb();
    const config = testConfig();
    const ora: FixtureListing = { address: '1100 Rarig Ave', suite: 'B', sf: 8000, rentLow: 9.7, owner: 'OXFORD RARIG LLC' };
    await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...TEN_COMPS, ora]);
    const s = loadMarketState(db, config, '2026-03-01');
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'B', sf: 8000 }], config, s, true);
    const row = r.rows[0]!;
    expect(row.band).toBe('in_band');
    expect(row.recommendation).toMatch(/^Within the comparable range \(/);
  });

  // Row-level (computePositioning, not the unit-level recommendationFor helper) counterpart to
  // "treats nominally-exact 10% gaps as in_band despite floating-point division noise" -- the
  // comparable median here is REAL (derived from similarity comps via quantileSorted), not a
  // hand-supplied literal, so this also exercises that gapPct's roundedGap guard survives the full
  // resolveComparables pipeline, not just a hand-constructed ResolvedComparables. 6.5 and 7.5 are
  // both exactly binary-representable, so their average (the median, at n=10) is exactly 7.00 --
  // (7.70 - 7.00) / 7.00 is 0.10000000000000003 in raw floating point, which a naive `> 0.1` compare
  // would misclassify as 'above' the 10% band.
  it('treats a row-level nominally-exact 10% gap (median 7.00, asking 7.70) as in_band, not above', async () => {
    const { dir, db } = await newDb();
    const config = testConfig();
    const comps: FixtureListing[] = [5, 5.5, 6, 6.25, 6.5, 7.5, 7.75, 8, 8.5, 9].map((rent, i) => ({ id: `E${i}`, address: `${500 + i} Edge Dr`, sf: 8000, rentLow: rent }));
    const ora: FixtureListing = { address: '1100 Rarig Ave', suite: 'B', sf: 8000, rentLow: 7.7, owner: 'OXFORD RARIG LLC' };
    await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...comps, ora]);
    const s = loadMarketState(db, config, '2026-03-01');
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'B', sf: 8000 }], config, s, true);
    const row = r.rows[0]!;
    expect(row.stats!.median).toBe(7);
    expect(row.oraAskingNnnEq).toBe(7.7);
    expect(row.band).toBe('in_band');
    expect(row.recommendation).toMatch(/^Within the comparable range \(/);
  });

  // Mirror of "scopes ORA matching to the configured market and breaks exact-suite ties by lowest
  // listingId" above, but with the two buildings' fixture-insertion order (and therefore listingId
  // order) REVERSED relative to their address's alphabetical order -- building B (1200 Rarig,
  // alphabetically LATER) is inserted first here and so gets the LOWER listingId. This proves the
  // winner is chosen by listingId, not by address string order or array (Map.find) iteration order
  // coincidentally lining up with listingId order, which the original test alone couldn't rule out
  // (there, the lower-listingId building also happened to sort first alphabetically and be
  // inserted first).
  it('breaks exact-suite ties by lowest listingId even when insertion/address order favors the other building', async () => {
    const { dir, db } = await newDb();
    const config = testConfig({
      oraProperties: [
        {
          propertyKey: '1100 Rarig', marketId: 'columbus', submarket: 'East', subtype: 'warehouse', officePct: null, typicalUnitSf: 8000,
          leaseBasis: 'NNN', addressNorms: ['1100 RARIG AVE', '1200 RARIG AVE'], lat: null, lon: null, clearHeightFt: null, yearBuilt: null, docks: null, driveIns: null,
        },
      ],
    });
    const buildingA: FixtureListing = { address: '1100 Rarig Ave', suite: 'A', sf: 8000, rentLow: 9, owner: 'OXFORD RARIG LLC' };
    const buildingB: FixtureListing = { address: '1200 Rarig Ave', suite: 'A', sf: 8000, rentLow: 9.5, owner: 'OXFORD RARIG LLC' };
    // Building B inserted FIRST -> gets the lower listingId, despite sorting after building A
    // alphabetically by address.
    await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...TEN_COMPS, buildingB, buildingA]);
    const s = loadMarketState(db, config, '2026-03-01');
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'A', sf: 8000 }], config, s, true);
    // Building B (rent 9.5) has the lower listingId here, so it must win the exact-suite tie --
    // NOT building A (rent 9), even though A sorts first alphabetically by address.
    expect(r.rows[0]!.oraAskingNnnEq).toBe(9.5);
  });

  it('reports no comparables for a unit whose size falls outside every size band', async () => {
    const { config, s } = await state();
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'Suite B', sf: 90000 }], config, s, true);
    const row = r.rows[0]!;
    expect(row.stats).toBeNull();
    expect(row.band).toBe('unknown');
    expect(row.recommendation).toBe('No comparable asking rents yet for this size and type.');
    // The match itself is unaffected by the comp size-band lookup — suite matching is independent.
    expect(row.flags).toEqual([]);
    expect(row.oraAskingNnnEq).toBe(11.5);
  });

  it('redacts listedButLeased addresses when rowLevel is false', async () => {
    const { config, s } = await state([{ address: '1100 Rarig Ave', suite: 'C', sf: 6000, rentLow: 10, owner: 'OXFORD RARIG LLC' }]);
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'D', sf: 5000 }], config, s, false);
    expect(r.listedButLeased.length).toBeGreaterThan(0);
    expect(r.listedButLeased.every((l) => l.address === null)).toBe(true);
  });

  it('caps comps at 15 even when more comparables are available', async () => {
    const { dir, db } = await newDb();
    const config = testConfig();
    const manyComps: FixtureListing[] = Array.from({ length: 20 }, (_, i) => ({ id: `M${i}`, address: `${400 + i} Many Dr`, sf: 8000, rentLow: 8 + i * 0.1 }));
    const ora: FixtureListing = { address: '1100 Rarig Ave', suite: 'B', sf: 8000, rentLow: 11.5, owner: 'OXFORD RARIG LLC' };
    await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...manyComps, ora]);
    const s = loadMarketState(db, config, '2026-03-01');
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'B', sf: 8000 }], config, s, true);
    expect(r.rows[0]!.comps.length).toBeLessThanOrEqual(15);
    expect(r.rows[0]!.comps.length).toBe(15);
  });
});
