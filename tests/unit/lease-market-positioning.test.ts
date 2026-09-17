// tests/unit/lease-market-positioning.test.ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse, type WarehouseDb } from '../../server/warehouse/db';
import { ingestCostarListingsFile } from '../../server/warehouse/lease-market/ingest';
import { loadMarketState, oraSubject } from '../../server/warehouse/lease-market/compute';
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
    expect(row).toMatchObject({ propertyKey: '1100 Rarig', unit: 'Suite B', oraAskingNnnEq: 11.5, band: 'above', flags: [], effectiveDom: 45, source: 'rent-roll' });
    expect(row.stats).toMatchObject({ basis: 'similarity', n: 10, confidence: 'MEDIUM', low: 8, high: 11 });
    expect(row.stats!.median).toBeCloseTo(9.625);
    expect(row.gapPct).toBeCloseTo(11.5 / 9.625 - 1);
    expect(row.percentile).toBe(1);
    expect(row.comps).toHaveLength(10);
    expect(row.comps[0]!.address).toMatch(/Commerce Dr/);
    expect(row.recommendation).toMatch(/^Asking is 19% above the comparable median \(\$9\.63\)/);
    expect(r.listedButLeased).toEqual([]);
  });

  // Go-live change (2026-09-17): a vacant rent-roll unit that matches NOTHING still keeps today's
  // "not listed" row (the unmarketed-vacancy signal). But the two ORA suites it did NOT match (B and
  // C) are no longer dropped into listedButLeased — each now gets its own listing-sourced Rent
  // Position row, per Gabriel's decision that the listings themselves ARE the marketed space.
  it('keeps the not-listed signal for an unmatched rent-roll unit, and positions the unmatched ORA suites as their own listing rows', async () => {
    const { config, s } = await state([{ address: '1100 Rarig Ave', suite: 'C', sf: 6000, rentLow: 10, owner: 'OXFORD RARIG LLC' }]);
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'D', sf: 5000 }], config, s, true);
    expect(r.rows[0]).toMatchObject({ unit: 'D', oraAskingNnnEq: null, flags: ['not_listed'], band: 'unknown', effectiveDom: null, source: 'rent-roll' });
    expect(r.rows[0]!.recommendation).toMatch(/^No ORA asking rent found in CoStar/);
    const listingRows = r.rows.filter((row) => row.source === 'listing');
    expect(listingRows.map((row) => row.unit).sort()).toEqual(['B', 'C']);
    expect(listingRows.every((row) => row.flags.length === 0)).toBe(true);
    expect(listingRows.find((row) => row.unit === 'B')!.oraAskingNnnEq).toBe(11.5);
    expect(listingRows.find((row) => row.unit === 'C')!.oraAskingNnnEq).toBe(10);
    expect(r.listedButLeased).toEqual([]);
  });

  it('strips row-level identifiers and lists unconfigured properties', async () => {
    const { config, s } = await state();
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'B', sf: 8000 }, { propertyKey: 'Sepich', unit: '1', sf: 2000 }, { propertyKey: 'Sepich', unit: '2', sf: 2000 }], config, s, false);
    expect(r.unconfiguredPropertyKeys).toEqual(['Sepich']);
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
    // flags: [] (not 'not_listed') is the matched signal now that oraListingId has been removed from
    // the wire (whole-branch review finding 6 — no UI consumer read it).
    expect(r.rows[0]).toMatchObject({ flags: [], oraAskingNnnEq: null, source: 'rent-roll' });
    expect(r.rows[0]!.recommendation).toMatch(/^ORA listing found in CoStar but its asking rent is withheld or not normalizable\./);
  });

  // ── Fix round 1, item 6 / go-live change: a blank vacant-unit suite must not be treated as
  // "matches the blank-suite listing" — and (per Gabriel's decision) neither unmatched ORA listing
  // is dropped: each gets its own listing row, distinct from the other, not merged and not lost.
  it('positions a blank-suite and a lettered-suite ORA listing as two distinct listing rows when neither matches the vacant unit', async () => {
    const { dir, db } = await newDb();
    const config = testConfig();
    const blankSuite: FixtureListing = { address: '1100 Rarig Ave', sf: 8000, rentLow: 11.5, owner: 'OXFORD RARIG LLC' }; // suiteNorm ''
    const suiteC: FixtureListing = { address: '1100 Rarig Ave', suite: 'C', sf: 6000, rentLow: 10, owner: 'OXFORD RARIG LLC' };
    await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...TEN_COMPS, blankSuite, suiteC]);
    const s = loadMarketState(db, config, '2026-03-01');
    // Two ORA spaces -> no fallback applies; a blank vacant-unit suite must not be treated as "matches the blank listing".
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: null, sf: 5000 }], config, s, true);
    expect(r.rows[0]).toMatchObject({ flags: ['not_listed'], source: 'rent-roll' });
    expect(r.listedButLeased).toEqual([]);
    const listingRows = r.rows.filter((row) => row.source === 'listing');
    expect(listingRows).toHaveLength(2);
    expect(listingRows.find((row) => row.unit === null)?.oraAskingNnnEq).toBe(11.5);
    expect(listingRows.find((row) => row.unit === 'C')?.oraAskingNnnEq).toBe(10);
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

  // Go-live change (2026-09-17): unmatched ORA suites are now their own listing rows rather than
  // listedButLeased entries — redaction coverage moves to their `comps[].address`, the only
  // address-shaped field a listing row carries.
  it('redacts comps addresses on listing-sourced rows when rowLevel is false (listedButLeased stays empty)', async () => {
    const { config, s } = await state([{ address: '1100 Rarig Ave', suite: 'C', sf: 6000, rentLow: 10, owner: 'OXFORD RARIG LLC' }]);
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'D', sf: 5000 }], config, s, false);
    expect(r.listedButLeased).toEqual([]);
    const listingRows = r.rows.filter((row) => row.source === 'listing');
    expect(listingRows.length).toBeGreaterThan(0);
    expect(listingRows.every((row) => row.comps.every((c) => c.address === null))).toBe(true);
  });

  // Deferred R2: an owner-screened ORA-self listing (ownerType 'affiliated') at an address NOT in
  // config.oraProperties.addressNorms has no oraPropertyKey, so it can never become a PositioningRow
  // or a listedButLeased entry — it needs its own hygiene surface.
  it('flags an ORA-self-owned listing at an unmapped address as a hygiene issue, redacted when rowLevel is false', async () => {
    const { config, s } = await state([{ address: '500 Unmapped Ave', sf: 6000, rentLow: 9, owner: 'OXFORD UNLISTED HOLDINGS LLC' }]);
    const trueLevel = computePositioning([], config, s, true);
    expect(trueLevel.hygieneFlags).toHaveLength(1);
    expect(trueLevel.hygieneFlags[0]).toMatchObject({
      address: '500 Unmapped Ave',
      reason: 'CoStar shows an ORA-owned listing at an address that is not mapped — add it to oraProperties',
    });
    expect(trueLevel.hygieneFlags[0]!.marketId).toBe('columbus');

    const redacted = computePositioning([], config, s, false);
    expect(redacted.hygieneFlags).toHaveLength(1);
    expect(redacted.hygieneFlags[0]!.address).toBeNull();
  });

  it('does not flag a listing whose owner is not affiliated, or an ORA listing that IS mapped', async () => {
    const { config, s } = await state();
    const r = computePositioning([], config, s, true);
    // The default fixture's only ORA-owned listing (1100 Rarig Ave, owner OXFORD RARIG LLC) is
    // correctly mapped via config.oraProperties.addressNorms — must not be flagged.
    expect(r.hygieneFlags).toEqual([]);
  });

  // R3 (deferred UI-fix round): resolveComparables' `unknown` union is threaded onto stats so a
  // MEDIUM/LOW confidence caused by missing subject data is explainable, not just asserted.
  it('surfaces resolveComparables.unknown on row stats when the ORA subject has missing physical fields', async () => {
    const { dir, db } = await newDb();
    const config = testConfig({
      oraProperties: [
        {
          propertyKey: '1100 Rarig', marketId: 'columbus', submarket: null, subtype: 'warehouse', officePct: null, typicalUnitSf: 8000,
          leaseBasis: 'NNN', addressNorms: ['1100 RARIG AVE'], lat: null, lon: null, clearHeightFt: null, yearBuilt: null, docks: null, driveIns: null,
        },
      ],
    });
    // The ORA listing's own ingested property row carries no physical data either, so oraSubject's
    // `p.field ?? matched?.field ?? null` fallback stays null on both sides, not just the config.
    const ora: FixtureListing = {
      address: '1100 Rarig Ave', suite: 'B', sf: 8000, rentLow: 11.5, owner: 'OXFORD RARIG LLC',
      submarket: null, lat: null, lon: null, clear: null, yearBuilt: null, docks: null, driveIns: null,
    };
    await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...TEN_COMPS, ora]);
    const s = loadMarketState(db, config, '2026-03-01');
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'B', sf: 8000 }], config, s, true);
    const row = r.rows[0]!;
    expect(row.stats!.unknown.length).toBeGreaterThanOrEqual(3);
    expect(row.stats!.unknown).toEqual(expect.arrayContaining(['location', 'clearHeight']));
    // 3+ unknown components caps confidence at LOW regardless of comp count (similarity.ts REFUTE R3).
    expect(row.stats!.confidence).toBe('LOW');
  });

  // ── I-2: R9's building-designator normalization broke rent-roll<->CoStar matching for multi-
  // building complexes — a rent-roll unit "A" stays "A", but the R9-normalized CoStar suite for
  // building 1's "A" is "B1-A", so the exact match failed, the unit rendered "Not listed" with a null
  // asking, AND the same space simultaneously showed up in "Listed in CoStar but not vacant in the rent
  // roll" — a double mis-report of the same real space. ──────────────────────────────────────────
  describe('building-designator matching (I-2)', () => {
    it('matches a rent-roll unit "A" against a CoStar suite "B1-A"', async () => {
      const { dir, db } = await newDb();
      const config = testConfig();
      const bldg1A: FixtureListing = { address: '1100 Rarig Ave Bldg 1', suite: 'A', sf: 8000, rentLow: 9, owner: 'OXFORD RARIG LLC' };
      await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...TEN_COMPS, bldg1A]);
      const s = loadMarketState(db, config, '2026-03-01');
      const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'A', sf: 8000 }], config, s, true);
      expect(r.rows[0]).toMatchObject({ unit: 'A', flags: [], oraAskingNnnEq: 9 });
      expect(r.listedButLeased).toEqual([]);
    });

    it('does not cross-match two rent-roll units against two buildings sharing a suite letter; the tie resolves deterministically to the lowest listingId', async () => {
      const { dir, db } = await newDb();
      const config = testConfig();
      const bldg1A: FixtureListing = { address: '1100 Rarig Ave Bldg 1', suite: 'A', sf: 8000, rentLow: 9, owner: 'OXFORD RARIG LLC' };
      const bldg2A: FixtureListing = { address: '1100 Rarig Ave Bldg 2', suite: 'A', sf: 8000, rentLow: 9.5, owner: 'OXFORD RARIG LLC' };
      // Inserted in order -> bldg1A gets the lower listingId.
      await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...TEN_COMPS, bldg1A, bldg2A]);
      const s = loadMarketState(db, config, '2026-03-01');
      const r = computePositioning(
        [{ propertyKey: '1100 Rarig', unit: 'A', sf: 8000 }, { propertyKey: '1100 Rarig', unit: 'B', sf: 8000 }],
        config, s, true,
      );
      const rowA = r.rows[0]!;
      const rowB = r.rows[1]!;
      // Both "B1-A" and "B2-A" strip to "A"; the lower listingId (building 1, inserted first) wins.
      expect(rowA.flags).toEqual([]);
      expect(rowA.oraAskingNnnEq).toBe(9);
      // Unit "B" (a literal suite named "B", not building B) must not cross-match building 2's space —
      // neither CoStar suite strips to "B".
      expect(rowB.flags).toEqual(['not_listed']);
      expect(rowB.oraAskingNnnEq).toBeNull();
      // Go-live change: building 2's space is genuinely unmatched — it now reports exactly once, as
      // its own listing-sourced row, never silently dropped, never double-counted, and never routed
      // through listedButLeased (which every mapped active ORA listing now bypasses entirely).
      expect(r.listedButLeased).toEqual([]);
      const listingRow = r.rows.find((row) => row.source === 'listing');
      expect(listingRow).toMatchObject({ propertyKey: '1100 Rarig', unit: 'B2-A', oraAskingNnnEq: 9.5, flags: [] });
    });

    it('reports a genuinely unmatched building-suite space once, as its own listing row, not a duplicated "not listed"', async () => {
      const { dir, db } = await newDb();
      const config = testConfig();
      const bldg1Z: FixtureListing = { address: '1100 Rarig Ave Bldg 1', suite: 'Z', sf: 8000, rentLow: 9, owner: 'OXFORD RARIG LLC' };
      await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...TEN_COMPS, bldg1Z]);
      const s = loadMarketState(db, config, '2026-03-01');
      const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'A', sf: 8000 }], config, s, true);
      expect(r.rows[0]).toMatchObject({ unit: 'A', flags: ['not_listed'], oraAskingNnnEq: null, source: 'rent-roll' });
      expect(r.listedButLeased).toEqual([]);
      const listingRow = r.rows.find((row) => row.source === 'listing');
      expect(listingRow).toMatchObject({ propertyKey: '1100 Rarig', unit: 'B1-Z', oraAskingNnnEq: 9, flags: [] });
    });
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

// ── Go-live change (2026-09-17): the first real CoStar export carries 138 rent-roll leases and ZERO
// vacant rows — vacancy simply isn't recorded that way — so the six real ORA-owned listings below are
// exactly the scenario Gabriel's decision addresses: Rent Position must source ORA available space from
// these listings directly, priced off each listing's OWN asking rent, never a fabricated or
// property-level figure. Shapes (address, SF, rent, basis) are the real listings from the go-live
// export; the numbers are illustrative fixture values, not hardcoded into source. ─────────────────────
describe("Gabriel's go-live decision — Rent Position sourced from real ORA CoStar listings", () => {
  function goLiveConfig(): LeaseMarketConfig {
    return testConfig({
      markets: [
        {
          id: 'columbus', label: 'Columbus', tier: 'established', enabled: true, costarMarketNames: ['Columbus'], mgLandlordPays: ['tax', 'ins'],
          opexDefaults: {
            warehouse: { tax: 1, ins: 0.25, cam: 0.5, source: 'test fixture', asOf: '2026-01-01' },
            flex: { tax: 1, ins: 0.3, cam: 0.6, source: 'test fixture', asOf: '2026-01-01' },
          },
        },
        { id: 'madison', label: 'Madison', tier: 'entry', enabled: true, costarMarketNames: ['Madison'], mgLandlordPays: ['tax', 'ins'], opexDefaults: { warehouse: null, flex: null } },
      ],
      oraProperties: [
        {
          propertyKey: '1100 Rarig', marketId: 'columbus', submarket: 'Airport', subtype: 'flex', officePct: null, typicalUnitSf: 3000,
          leaseBasis: 'MG', addressNorms: ['1100 RARIG AVE'], lat: null, lon: null, clearHeightFt: null, yearBuilt: null, docks: null, driveIns: null,
        },
        {
          propertyKey: 'Banwick', marketId: 'columbus', submarket: null, subtype: 'flex', officePct: null, typicalUnitSf: 1500,
          leaseBasis: 'MG', addressNorms: ['2800-2826 BANWICK RD'], lat: null, lon: null, clearHeightFt: null, yearBuilt: null, docks: null, driveIns: null,
        },
        // One propertyKey, two listings on different lease bases (MG and NNN) — proves NNN-equivalent
        // conversion is driven per-listing, not collapsed to one figure for the property.
        {
          propertyKey: 'Zettler', marketId: 'columbus', submarket: null, subtype: 'flex', officePct: null, typicalUnitSf: 1800,
          leaseBasis: 'UNKNOWN', addressNorms: ['2012-2026 ZETTLER RD', '2002 ZETTLER RD'], lat: null, lon: null, clearHeightFt: null, yearBuilt: null, docks: null, driveIns: null,
        },
        {
          propertyKey: '3875-3883 E Livingston', marketId: 'columbus', submarket: null, subtype: 'warehouse', officePct: null, typicalUnitSf: 7500,
          leaseBasis: 'UNKNOWN', addressNorms: ['3887 E LIVINGSTON AVE'], lat: null, lon: null, clearHeightFt: null, yearBuilt: null, docks: null, driveIns: null,
        },
        // 9017-9019 Heritage Dr is DELIBERATELY NOT mapped here — it must surface only via hygieneFlags.
      ],
    });
  }

  const RARIG: FixtureListing = { address: '1100 Rarig Ave', submarket: 'Airport', type: 'Flex', sf: 4800, rentLow: 13.0, rentType: 'MG', owner: 'OXFORD RARIG LLC' };
  const BANWICK: FixtureListing = { address: '2800-2826 Banwick Rd', suite: 'Suite 2802', type: 'Flex', sf: 1500, rentLow: 13.2, rentType: 'MG', owner: 'OXFORD BANWICK LLC' };
  const ZETTLER_MG: FixtureListing = { address: '2012-2026 Zettler Rd', suite: 'Suite 2014', type: 'Flex', sf: 1800, rentLow: 11.67, rentType: 'MG', owner: 'OXFORD ZETTLER LLC' };
  const ZETTLER_NNN: FixtureListing = { address: '2002 Zettler Rd', type: 'Flex', sf: 5000, rentLow: 9.0, rentType: 'NNN', owner: 'OXFORD ZETTLER LLC' };
  // A real case: a sublet with no quoted rent.
  const LIVINGSTON_SUBLET: FixtureListing = { address: '3887 E Livingston Ave', type: 'Industrial', sf: 7525, rentLow: 'Upon Request', spaceUse: 'Sublet', owner: 'OXFORD LIVINGSTON LLC' };
  // Deliberately not mapped in oraProperties; owner screens 'affiliated' via the OXFORD name heuristic
  // (stubScreen), same as the real listing hygiene case.
  const HERITAGE_UNMAPPED: FixtureListing = { address: '9017-9019 Heritage Dr', city: 'Plain City', type: 'Flex', sf: 2940, rentLow: 7.5, owner: 'Oxford Realty' };

  async function goLiveState() {
    const { dir, db } = await newDb();
    const config = goLiveConfig();
    await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...TEN_COMPS, RARIG, BANWICK, ZETTLER_MG, ZETTLER_NNN, LIVINGSTON_SUBLET, HERITAGE_UNMAPPED]);
    return { config, s: loadMarketState(db, config, '2026-03-01') };
  }

  it('produces a listing-sourced Rent Position row for every active, mapped ORA listing when the rent roll has zero vacant rows', async () => {
    const { config, s } = await goLiveState();
    // The real rent roll: 138 leases, zero vacant rows.
    const r = computePositioning([], config, s, true);
    const rowFor = (propertyKey: string, unit: string | null) => r.rows.find((row) => row.propertyKey === propertyKey && row.unit === unit);

    const rarig = rowFor('1100 Rarig', null);
    expect(rarig).toMatchObject({ sf: 4800, oraAskingNnnEq: 13 - 1.3, source: 'listing', flags: [] });

    const banwick = rowFor('Banwick', '2802');
    expect(banwick).toMatchObject({ sf: 1500, oraAskingNnnEq: 13.2 - 1.3, source: 'listing', flags: [] });

    // Two listings share the "Zettler" propertyKey with different lease bases — each converts to
    // NNN-equivalent from ITS OWN quoted basis, never a property-level figure: the MG listing's asking
    // is reduced by the market opex estimate, the NNN listing's is not.
    const zettlerMg = rowFor('Zettler', '2014');
    const zettlerNnn = rowFor('Zettler', null);
    expect(zettlerMg).toMatchObject({ sf: 1800, oraAskingNnnEq: 11.67 - 1.3, source: 'listing', flags: [] });
    expect(zettlerNnn).toMatchObject({ sf: 5000, oraAskingNnnEq: 9, source: 'listing', flags: [] });
    expect(zettlerMg!.oraAskingNnnEq).not.toBe(zettlerNnn!.oraAskingNnnEq);

    // M1: a TENANT subletting ORA's building (Lease Type = Sublet) is a tenant-exit signal, not ORA's
    // own marketed ask — it must never produce a Rent Position row (which would otherwise misread as
    // "ORA listing found in CoStar but its asking rent is withheld", implying ORA itself withheld a
    // rent it never quoted). It surfaces only via hygieneFlags.
    expect(r.rows.some((row) => row.propertyKey === '3875-3883 E Livingston')).toBe(false);

    // Heritage Dr is deliberately unmapped — it must never appear as a Rent Position row...
    expect(r.rows.some((row) => row.propertyKey === '9017-9019 Heritage Dr')).toBe(false);
    // ...but neither it nor the Livingston sublet silently vanishes — both surface through hygieneFlags.
    expect(r.hygieneFlags).toHaveLength(2);
    expect(r.hygieneFlags).toContainEqual(
      expect.objectContaining({
        address: '9017-9019 Heritage Dr',
        reason: 'CoStar shows an ORA-owned listing at an address that is not mapped — add it to oraProperties',
      }),
    );
    // Concurrent H3 fix (ingest.ts, out of this task's scope): a blank-suite Sublet row is stored with
    // a distinct 'SUBLET' suite marker (not '') so it never collides with a same-address Direct
    // listing — addressDisplay reflects that marker.
    expect(r.hygieneFlags).toContainEqual(
      expect.objectContaining({ address: '3887 E Livingston Ave Ste SUBLET', reason: expect.stringMatching(/tenant sublease/) }),
    );

    // With zero rent-roll vacancies, every mapped active ORA listing already has its own row above —
    // "listed but not vacant" must not resurrect the old inverted behaviour.
    expect(r.listedButLeased).toEqual([]);
    expect(r.unconfiguredPropertyKeys).toEqual([]);
  });

  it('redacts comps addresses on the real-listing rows the same way as any other row when rowLevel is false', async () => {
    const { config, s } = await goLiveState();
    const r = computePositioning([], config, s, false);
    const listingRows = r.rows.filter((row) => row.source === 'listing');
    expect(listingRows.length).toBeGreaterThan(0);
    expect(listingRows.every((row) => row.comps.every((c) => c.address === null))).toBe(true);
    expect(r.hygieneFlags[0]!.address).toBeNull();
  });
});

// ── H2 (refute round 2) — the listing-sourced and rent-roll/feed-sourced subject profiles must resolve
// the SAME benchmark cell for the same ORA building. Real disagreement: CoStar carries 1100 Rarig as
// Industrial|Warehouse (lm_property.subtype = 'warehouse', the TEST_HEADERS/testHeaderMap default) while
// config.oraProperties declares it 'flex' — exactly the real 1100 Rarig / Zettler disagreement. ────────
describe('H2 — unified subject profile across the listing and rent-roll/feed paths', () => {
  function flexConfig(): LeaseMarketConfig {
    return testConfig({
      oraProperties: [
        {
          propertyKey: '1100 Rarig', marketId: 'columbus', submarket: 'East', subtype: 'flex', officePct: null, typicalUnitSf: 8000,
          leaseBasis: 'NNN', addressNorms: ['1100 RARIG AVE'], lat: null, lon: null, clearHeightFt: null, yearBuilt: null, docks: null, driveIns: null,
        },
      ],
    });
  }

  it('prices a listing-sourced row against the CONFIG subtype cell, not the CoStar-derived subtype, and matches oraSubject exactly', async () => {
    const { dir, db } = await newDb();
    const config = flexConfig();
    // Default fixture type/secondary ('Industrial'/'Warehouse') maps via subtypeMap 'Industrial|*' ->
    // 'warehouse', so lm_property.subtype ends up 'warehouse' while config says 'flex'.
    const ora: FixtureListing = { address: '1100 Rarig Ave', suite: 'B', sf: 8000, rentLow: 11.5, owner: 'OXFORD RARIG LLC' };
    await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...TEN_COMPS, ora]);
    const s = loadMarketState(db, config, '2026-03-01');
    const space = s.spaces.find((sp) => sp.property.oraPropertyKey === '1100 Rarig')!;
    expect(space.property.subtype).toBe('warehouse'); // confirms the real disagreement exists in this fixture

    const r = computePositioning([], config, s, true);
    const row = r.rows.find((row) => row.propertyKey === '1100 Rarig')!;
    expect(row.source).toBe('listing');
    expect(row.stats!.cellKey).toContain('flex'); // must use config's subtype, never CoStar's 'warehouse'
    expect(row.stats!.cellKey).not.toContain('warehouse');

    // The rent-roll/feed path (oraSubject) must resolve the identical cell for the same building.
    const { target } = oraSubject(config.oraProperties[0]!, s, 8000, config.thresholds);
    expect(target).not.toBeNull();
    const feedCell = s.cellFor(target!);
    expect(feedCell.cellKey).toBe(row.stats!.cellKey);
  });

  it('flags the subtype disagreement by name, once per property, without suppressing the listing row', async () => {
    const { dir, db } = await newDb();
    const config = flexConfig();
    const ora: FixtureListing = { address: '1100 Rarig Ave', suite: 'B', sf: 8000, rentLow: 11.5, owner: 'OXFORD RARIG LLC' };
    await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...TEN_COMPS, ora]);
    const s = loadMarketState(db, config, '2026-03-01');
    const r = computePositioning([], config, s, true);

    expect(r.rows.some((row) => row.propertyKey === '1100 Rarig')).toBe(true); // still gets its row
    const flag = r.hygieneFlags.find((f) => f.reason.includes('subtype'));
    expect(flag).toBeDefined();
    expect(flag!.reason).toContain("'warehouse'");
    expect(flag!.reason).toContain("'flex'");
    expect(flag!.address).toBe('1100 Rarig Ave');
  });

  it('does not flag a subtype disagreement when config and CoStar agree', async () => {
    const { config, s } = await state(); // default fixture: config subtype 'warehouse', CoStar Industrial|Warehouse -> 'warehouse'
    const r = computePositioning([], config, s, true);
    expect(r.hygieneFlags.some((f) => f.reason.includes('subtype'))).toBe(false);
  });
});

// ── M1 (refute round 2) — a tenant subletting ORA's own space must never be priced as ORA's own ask. ──
describe('M1 — a tenant sublease of ORA space is routed to hygiene, never a positioning row', () => {
  it('excludes a sublease space from positioning rows and from matching a vacant rent-roll unit, but keeps the genuine-withheld-rent row for a real ORA listing', async () => {
    const { dir, db } = await newDb();
    const config = testConfig();
    const sublease: FixtureListing = { address: '1100 Rarig Ave', suite: 'C', sf: 6000, owner: 'OXFORD RARIG LLC', spaceUse: 'Sublet', rentLow: null };
    const genuineWithheld: FixtureListing = { address: '1100 Rarig Ave', suite: 'B', sf: 8000, owner: 'OXFORD RARIG LLC', rentLow: 'Negotiable' };
    await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...TEN_COMPS, sublease, genuineWithheld]);
    const s = loadMarketState(db, config, '2026-03-01');
    const subleaseSpace = s.spaces.find((sp) => sp.suiteNorm === 'C')!;
    expect(subleaseSpace.observations.at(-1)!.isSublease).toBe(true);

    // No rent roll at all: the sublease must never surface as its own listing row.
    const r = computePositioning([], config, s, true);
    expect(r.rows.some((row) => row.unit === 'C')).toBe(false);
    expect(r.hygieneFlags).toContainEqual(
      expect.objectContaining({ listingId: subleaseSpace.listingId, reason: expect.stringMatching(/tenant sublease/) }),
    );
    // The genuine withheld-rent listing (suite B, not a sublease) still gets its own row, unaffected.
    const rowB = r.rows.find((row) => row.unit === 'B')!;
    expect(rowB).toBeDefined();
    expect(rowB.oraAskingNnnEq).toBeNull();
    expect(rowB.recommendation).toMatch(/^ORA listing found in CoStar but its asking rent is withheld/);

    // A vacant rent-roll unit for suite C must not silently match the sublease space either — it should
    // read 'not_listed', not price against a tenant's own sublease ask.
    const r2 = computePositioning([{ propertyKey: '1100 Rarig', unit: 'C', sf: 6000 }], config, s, true);
    const rowC = r2.rows.find((row) => row.propertyKey === '1100 Rarig' && row.unit === 'C')!;
    expect(rowC.flags).toEqual(['not_listed']);
    expect(rowC.oraAskingNnnEq).toBeNull();
    expect(r2.listedButLeased).toEqual([]);
  });

  it('falls back to the genuinely-only non-sublease ORA space, skipping a sublease when counting "only one space"', async () => {
    const { dir, db } = await newDb();
    const config = testConfig();
    // Two ORA spaces total, but one is a sublease -- the "only ORA space" fallback (for a blank-suite
    // vacant unit) must treat the non-sublease space as the only ELIGIBLE one.
    const sublease: FixtureListing = { address: '1100 Rarig Ave', suite: 'C', sf: 6000, owner: 'OXFORD RARIG LLC', spaceUse: 'Sublet', rentLow: null };
    const onlyReal: FixtureListing = { address: '1100 Rarig Ave', sf: 8000, rentLow: 11.5, owner: 'OXFORD RARIG LLC' }; // no suite
    await ingestInto(db, dir, config, 'columbus', '2026-02-15', [...TEN_COMPS, sublease, onlyReal]);
    const s = loadMarketState(db, config, '2026-03-01');
    const r = computePositioning([{ propertyKey: '1100 Rarig', unit: 'A', sf: 8000 }], config, s, true);
    expect(r.rows[0]).toMatchObject({ flags: [], oraAskingNnnEq: 11.5 });
  });
});

// ── M2 (refute round 2) — positioning-layer coverage: the config-driven ORA-owner-name check reaches
// the hygiene surface even when the address is unmapped and the owner screen never ran. ──────────────
describe('M2 — config-driven ORA-owner-name check surfaces a hygiene flag independent of the owner screen', () => {
  it('flags a pattern-matched owner at an unmapped address, and does not flag an unrelated third-party owner', async () => {
    const { dir, db } = await newDb();
    const config = testConfig({ oraOwnerNamePatterns: ['Oxford Realty'] });
    const heritage: FixtureListing = { address: '9017-9019 Heritage Dr', city: 'Plain City', sf: 5888, rentLow: 7.5, owner: 'Oxford Realty' };
    const thirdParty: FixtureListing = { address: '123 Someone Else Dr', sf: 6000, rentLow: 8, owner: 'Smith Family LLC' };
    // Screen unavailable: owner_type stays 'unknown' on both new properties, regardless of owner name.
    const r0 = await ingestCostarListingsFile(
      db,
      await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-15.xlsx', [...TEN_COMPS, heritage, thirdParty]),
      { config, headerMap: testHeaderMap(), rawDir: join(dir, 'raw'), now: () => '2026-02-16T00:00:00Z', screen: (names) => ({ ...stubScreen(names), available: false }) },
    );
    expect(r0.status).toBe('ingested');
    const s = loadMarketState(db, config, '2026-03-01');
    const r = computePositioning([], config, s, true);

    const heritageSpace = s.spaces.find((sp) => sp.property.addressDisplay === '9017-9019 Heritage Dr')!;
    expect(r.hygieneFlags).toContainEqual(
      expect.objectContaining({
        listingId: heritageSpace.listingId,
        address: '9017-9019 Heritage Dr',
        reason: 'CoStar shows an ORA-owned listing at an address that is not mapped — add it to oraProperties',
      }),
    );
    // Never in a positioning row (unmapped -- no propertyKey to key a row off).
    expect(r.rows.some((row) => row.propertyKey === '9017-9019 Heritage Dr')).toBe(false);
    // The unrelated third-party owner must not be flagged.
    const thirdPartySpace = s.spaces.find((sp) => sp.property.addressDisplay === '123 Someone Else Dr');
    expect(r.hygieneFlags.some((f) => f.listingId === thirdPartySpace?.listingId)).toBe(false);
  });

  it('does not flag anything when oraOwnerNamePatterns is empty (the default), even for the same owner name', async () => {
    const { dir, db } = await newDb();
    const config = testConfig({ oraOwnerNamePatterns: [] });
    const heritage: FixtureListing = { address: '9017-9019 Heritage Dr', city: 'Plain City', sf: 5888, rentLow: 7.5, owner: 'Oxford Realty' };
    await ingestCostarListingsFile(
      db,
      await writeCostarFixture(dir, 'costar-listings_columbus_2026-02-15.xlsx', [...TEN_COMPS, heritage]),
      { config, headerMap: testHeaderMap(), rawDir: join(dir, 'raw'), now: () => '2026-02-16T00:00:00Z', screen: (names) => ({ ...stubScreen(names), available: false }) },
    );
    const s = loadMarketState(db, config, '2026-03-01');
    const r = computePositioning([], config, s, true);
    expect(r.hygieneFlags).toEqual([]);
  });
});
