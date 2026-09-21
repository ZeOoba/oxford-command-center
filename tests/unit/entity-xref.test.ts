import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';
import { linkEntity, canonicalIdFor, unmatchedReport } from '../../server/warehouse/entity-xref';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

describe('linkEntity / canonicalIdFor', () => {
  it('stores a link and reads it back', () => {
    const db = makeDb();
    linkEntity(db, {
      entityType: 'property',
      canonicalId: 'prop-1',
      system: 'ora_pm',
      externalId: 'pm-42',
      matchMethod: 'exact_address',
    });
    expect(canonicalIdFor(db, 'ora_pm', 'property', 'pm-42')).toBe('prop-1');
    expect(canonicalIdFor(db, 'ora_pm', 'property', 'nope')).toBeNull();
  });

  it('is idempotent — re-linking the same pair does not throw or duplicate', () => {
    const db = makeDb();
    const link = {
      entityType: 'property' as const,
      canonicalId: 'prop-1',
      system: 'notion',
      externalId: 'n-1',
      matchMethod: 'manual' as const,
    };
    linkEntity(db, link);
    linkEntity(db, link);
    expect((db.prepare('SELECT COUNT(*) AS n FROM entity_xref').get() as { n: number }).n).toBe(1);
  });

  it('refuses to silently repoint an external id at a different canonical id', () => {
    const db = makeDb();
    linkEntity(db, {
      entityType: 'property',
      canonicalId: 'prop-1',
      system: 'notion',
      externalId: 'n-1',
      matchMethod: 'manual',
    });
    expect(() =>
      linkEntity(db, {
        entityType: 'property',
        canonicalId: 'prop-2',
        system: 'notion',
        externalId: 'n-1',
        matchMethod: 'manual',
      }),
    ).toThrow(/already linked to prop-1/);
  });
});

describe('unmatchedReport', () => {
  it('lists warehouse properties that have no link in any other system', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO property_master (id, name, financial_mode, ownership_pct, ownership_status)
       VALUES ('prop-1','Linked','pnl',1.0,'active')`,
    ).run();
    db.prepare(
      `INSERT INTO property_master (id, name, financial_mode, ownership_pct, ownership_status)
       VALUES ('prop-2','Orphan','pnl',1.0,'active')`,
    ).run();
    linkEntity(db, {
      entityType: 'property',
      canonicalId: 'prop-1',
      system: 'ora_pm',
      externalId: 'pm-1',
      matchMethod: 'exact_id',
    });
    expect(unmatchedReport(db, 'property')).toEqual([{ canonicalId: 'prop-2', name: 'Orphan' }]);
  });
});

import { marketIdCandidates, seedFromLeaseMarket } from '../../server/warehouse/entity-xref';

/** Real migration-029 lm_property, not a stub — 029 is on main as of 2026-09-17. */
function addLmProperty(
  db: Database.Database,
  id: number,
  marketId: string,
  addressNorm: string,
  oraPropertyKey: string | null,
  ownerType = 'unknown',
  cityNorm = '',
): void {
  db.prepare(
    `INSERT INTO lm_property (id, identity_key, address_norm, address_display, city_norm, market_id,
                              subtype, building_status, ora_property_key, owner_type, first_seen, last_seen)
     VALUES (?, ?, ?, ?, ?, ?, 'warehouse', 'existing', ?, ?, '2026-09-01', '2026-09-01')`,
  ).run(
    // identity_key is UNIQUE and unread by the seeder; the id keeps fixtures distinct where a
    // real duplicate address would instead be distinguished by a costar: key.
    id, `addr:${marketId}|${cityNorm}|${addressNorm}#${id}`, addressNorm, addressNorm, cityNorm,
    marketId, oraPropertyKey, ownerType,
  );
}

function addProperty(
  db: Database.Database,
  id: string,
  address: string | null,
  market = 'Columbus',
): void {
  db.prepare(
    `INSERT INTO property_master (id, name, financial_mode, ownership_pct, ownership_status, address, market)
     VALUES (?, ?, 'pnl', 1.0, 'active', ?, ?)`,
  ).run(id, `Property ${id}`, address, market);
}

describe('marketIdCandidates', () => {
  it('maps the production property_master labels onto lease-market ids', () => {
    expect(marketIdCandidates('Columbus OH')).toContain('columbus');
    expect(marketIdCandidates('Columbus, OH')).toContain('columbus');
    expect(marketIdCandidates('Kansas City MO')).toContain('kansas-city');
    // the state suffix is part of this id, so the full slug must be a candidate too
    expect(marketIdCandidates('Eastern Shore MD')).toContain('eastern-shore-md');
    expect(marketIdCandidates('Columbus')).toEqual(['columbus']);
  });

  it('leaves a hyphenated region intact — it names no single lease-market id', () => {
    expect(marketIdCandidates('Mid-Atlantic')).toEqual(['mid-atlantic']);
  });

  it('keeps an empty label distinct rather than inventing a market', () => {
    expect(marketIdCandidates(null)).toEqual(['']);
    expect(marketIdCandidates('  ')).toEqual(['']);
  });
});

describe('seedFromLeaseMarket — production market labels (weekly sweep 2026-09-21)', () => {
  // property_master.market is 'Columbus OH' in production; lm_property.market_id is 'columbus'. The
  // fixtures elsewhere in this file write 'Columbus', which is why the seeder passed every test while
  // linking nothing in production.
  it("links a 'Columbus OH' property to a 'columbus' listing", () => {
    const db = makeDb();
    addProperty(db, '1100-rarig-ave-columbus-oh', '1100 Rarig Ave.', 'Columbus OH');
    addLmProperty(db, 7, 'columbus', '1100 RARIG AVE', 'Rarig');

    const result = seedFromLeaseMarket(db);
    expect(result.linked).toBe(1);
    expect(result.proposed).toEqual([]);
    expect(canonicalIdFor(db, 'lease_market', 'property', '7')).toBe('1100-rarig-ave-columbus-oh');
  });

  it("links 'Kansas City MO' to 'kansas-city' and keeps the state suffix where the id has it", () => {
    const db = makeDb();
    addProperty(db, 'prop-kc', '900 Main St', 'Kansas City MO');
    addProperty(db, 'prop-es', '12 Shore Rd', 'Eastern Shore MD');
    addLmProperty(db, 21, 'kansas-city', '900 MAIN ST', 'KC');
    addLmProperty(db, 22, 'eastern-shore-md', '12 SHORE RD', 'ES');

    const result = seedFromLeaseMarket(db);
    expect(result.linked).toBe(2);
    expect(canonicalIdFor(db, 'lease_market', 'property', '21')).toBe('prop-kc');
    expect(canonicalIdFor(db, 'lease_market', 'property', '22')).toBe('prop-es');
  });

  it('still refuses across markets: Columbus OH does not match a kansas-city listing', () => {
    const db = makeDb();
    addProperty(db, 'prop-oh', '500 Main St', 'Columbus OH');
    addLmProperty(db, 23, 'kansas-city', '500 MAIN ST', 'Main');

    const result = seedFromLeaseMarket(db);
    expect(result.linked).toBe(0);
    expect(result.proposed[0]!.reason).toBe('no_address_match');
  });

  it("reports (does not guess) for a region label like 'Mid-Atlantic'", () => {
    const db = makeDb();
    addProperty(db, 'prop-md', '29000 Information Ln', 'Mid-Atlantic');
    addLmProperty(db, 24, 'baltimore', '29000 INFORMATION LN', 'Info');

    const result = seedFromLeaseMarket(db);
    expect(result.linked).toBe(0);
    expect(result.proposed[0]!.reason).toBe('no_address_match');
  });

  it("two labels for one market ('Columbus OH' and 'Columbus') at one address stay ambiguous", () => {
    const db = makeDb();
    addProperty(db, 'prop-a', '500 Main Street', 'Columbus OH');
    addProperty(db, 'prop-b', '500 Main St', 'Columbus');
    addLmProperty(db, 25, 'columbus', '500 MAIN ST', 'Main');

    const result = seedFromLeaseMarket(db);
    expect(result.linked).toBe(0);
    expect(result.proposed[0]!.reason).toBe('ambiguous_address');
  });
});

describe('seedFromLeaseMarket', () => {
  it('skips cleanly when the lease-market tables are absent', () => {
    const bare = new Database(':memory:');
    expect(seedFromLeaseMarket(bare)).toEqual({
      linked: 0,
      proposed: [],
      skipped: ['lm_property table absent'],
    });
    bare.close();
  });

  it('mirrors a config-blessed link into both id spaces', () => {
    const db = makeDb();
    addProperty(db, '1100-rarig-ave-columbus-oh', '1100 Rarig Ave.');
    addLmProperty(db, 7, 'columbus', '1100 RARIG AVE', 'Rarig');

    const result = seedFromLeaseMarket(db);
    expect(result.linked).toBe(1);
    expect(result.proposed).toEqual([]);
    expect(canonicalIdFor(db, 'lease_market', 'property', '7')).toBe('1100-rarig-ave-columbus-oh');
    // the third id space: the raw rent-roll label the config speaks
    expect(canonicalIdFor(db, 'workbook', 'property', 'Rarig')).toBe('1100-rarig-ave-columbus-oh');
  });

  it('proposes rather than links when no human has blessed the row', () => {
    const db = makeDb();
    addProperty(db, 'prop-1', '1100 Rarig Ave.');
    addLmProperty(db, 8, 'columbus', '1100 RARIG AVE', null);

    const result = seedFromLeaseMarket(db);
    expect(result.linked).toBe(0);
    expect(result.proposed).toHaveLength(1);
    expect(result.proposed[0]!.reason).toBe('no_config_link');
    expect(result.proposed[0]!.candidateCanonicalIds).toEqual(['prop-1']);
    expect((db.prepare('SELECT COUNT(*) AS n FROM entity_xref').get() as { n: number }).n).toBe(0);
  });

  it('does not link across markets when a street address coincides', () => {
    const db = makeDb();
    addProperty(db, 'prop-md', '500 Main St', 'Baltimore');
    addLmProperty(db, 9, 'columbus', '500 MAIN ST', 'Main');

    const result = seedFromLeaseMarket(db);
    expect(result.linked).toBe(0);
    expect(result.proposed[0]!.reason).toBe('no_address_match');
  });

  it('refuses when two warehouse properties share one address in a market', () => {
    const db = makeDb();
    addProperty(db, 'prop-1', '500 Main Street');
    addProperty(db, 'prop-2', '500 Main St');
    addLmProperty(db, 10, 'columbus', '500 MAIN ST', 'Main');

    const result = seedFromLeaseMarket(db);
    expect(result.linked).toBe(0);
    expect(result.proposed[0]!.reason).toBe('ambiguous_address');
    expect(result.proposed[0]!.candidateCanonicalIds).toEqual(['prop-1', 'prop-2']);
  });

  it('refuses when two listings compete for one warehouse property', () => {
    const db = makeDb();
    addProperty(db, 'prop-1', '500 Main St');
    addLmProperty(db, 11, 'columbus', '500 MAIN ST', 'Main');
    addLmProperty(db, 12, 'columbus', '500 MAIN ST', 'Main');

    const result = seedFromLeaseMarket(db);
    expect(result.linked).toBe(0);
    expect(result.proposed).toHaveLength(2);
    expect(result.proposed.every((p) => p.reason === 'ambiguous_address')).toBe(true);
  });

  it('keeps a building-designator address on the same canonical property', () => {
    // "Bldg 1" moves to suiteNorm, so addressNorm still matches the parent building.
    const db = makeDb();
    addProperty(db, 'prop-1', '1100 Rarig Ave Bldg 1');
    addLmProperty(db, 13, 'columbus', '1100 RARIG AVE', 'Rarig');
    expect(seedFromLeaseMarket(db).linked).toBe(1);
  });
});

describe('seedFromLeaseMarket — ORA-owned but unmapped', () => {
  it('flags an affiliated owner with no config key as ORA-owned, not third-party', () => {
    // The lease-market session's case: CoStar carries an ORA-owned building whose address is not
    // in config addressNorms, so ora_property_key stays null. owner_type is the independent
    // owner-NAME verdict. Reporting it as an ordinary unmatched comp would hide an ORA building.
    const db = makeDb();
    addProperty(db, 'prop-heritage', '9017 Heritage Dr');
    addLmProperty(db, 20, 'columbus', '9017 HERITAGE DR', null, 'affiliated');

    const result = seedFromLeaseMarket(db);
    expect(result.linked).toBe(0);
    expect(result.proposed[0]!.reason).toBe('ora_owned_unmapped');
    expect(result.proposed[0]!.ownerType).toBe('affiliated');
  });

  it('still reports a genuine third-party listing as no_config_link', () => {
    const db = makeDb();
    addProperty(db, 'prop-1', '500 Main St');
    addLmProperty(db, 21, 'columbus', '500 MAIN ST', null, 'private');
    expect(seedFromLeaseMarket(db).proposed[0]!.reason).toBe('no_config_link');
  });

  it('refuses to repoint one rent-roll key at a second property and reports it', () => {
    // addressNorms is many-addresses-to-one-key (Zettler carries two). If those addresses resolve
    // to DIFFERENT warehouse properties the key cannot mean both, so the second is refused rather
    // than silently overwriting the first.
    const db = makeDb();
    addProperty(db, 'prop-zettler-a', '2012 Zettler Rd');
    addProperty(db, 'prop-zettler-b', '2002 Zettler Rd');
    addLmProperty(db, 22, 'columbus', '2012 ZETTLER RD', 'Zettler');
    addLmProperty(db, 23, 'columbus', '2002 ZETTLER RD', 'Zettler');

    const result = seedFromLeaseMarket(db);
    expect(result.linked).toBe(1);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]).toMatch(/already linked to prop-zettler-a/);
  });

  it('links both listings when one key maps to one property at two addresses', () => {
    const db = makeDb();
    addProperty(db, 'prop-zettler', '2012 Zettler Rd');
    addLmProperty(db, 24, 'columbus', '2012 ZETTLER RD', 'Zettler');
    const result = seedFromLeaseMarket(db);
    expect(result.linked).toBe(1);
    expect(canonicalIdFor(db, 'workbook', 'property', 'Zettler')).toBe('prop-zettler');
  });
});

describe('seedFromLeaseMarket — defects found by adversarial review', () => {
  it('refuses to fuse two buildings that share an address in different municipalities', () => {
    // The reviewer's case: 'columbus' is a METRO market spanning dozens of municipalities, and
    // property_master has no city column. Both sides are unique on market+address, so both
    // one-to-one guards passed and two different buildings were permanently fused.
    const db = makeDb();
    addProperty(db, '100-commerce-dr-columbus-oh', '100 Commerce Dr');
    addLmProperty(db, 30, 'columbus', '100 COMMERCE DR', 'Commerce', 'unknown', 'westerville');

    const result = seedFromLeaseMarket(db);
    expect(result.linked).toBe(0);
    expect(result.proposed[0]!.reason).toBe('city_unverifiable');
  });

  it('links when the canonical slug confirms the city', () => {
    const db = makeDb();
    addProperty(db, '100-commerce-dr-westerville-oh', '100 Commerce Dr');
    addLmProperty(db, 31, 'columbus', '100 COMMERCE DR', 'Commerce', 'unknown', 'westerville');
    expect(seedFromLeaseMarket(db).linked).toBe(1);
  });

  it('reports loudly when property_master carries no usable address data', () => {
    // Production reality on 2026-09-17: all 14 rows have a NULL address, so every listing would
    // have reported no_address_match and looked like "no ORA buildings matched" rather than a bug.
    const db = makeDb();
    db.prepare(
      `INSERT INTO property_master (id, name, financial_mode, ownership_pct, ownership_status)
       VALUES ('prop-1','No Address','pnl',1.0,'active')`,
    ).run();
    addLmProperty(db, 32, 'columbus', '500 MAIN ST', 'Main');

    const result = seedFromLeaseMarket(db);
    expect(result.linked).toBe(0);
    expect(result.skipped[0]).toMatch(/no usable address data.*1 rows, 0 with a non-empty address/);
  });

  it('does not treat an empty ora_property_key as a config blessing', () => {
    const db = makeDb();
    addProperty(db, 'prop-1', '500 Main St');
    addLmProperty(db, 33, 'columbus', '500 MAIN ST', '   ');
    const result = seedFromLeaseMarket(db);
    expect(result.linked).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS n FROM entity_xref').get() as { n: number }).n).toBe(0);
  });

  it('leaves no orphan half when the workbook link conflicts', () => {
    // The pair must be atomic: previously lease_market committed and workbook threw, so the row
    // was reported skipped while half of it was already in the table.
    const db = makeDb();
    addProperty(db, 'prop-a', '2012 Zettler Rd');
    addProperty(db, 'prop-b', '2002 Zettler Rd');
    addLmProperty(db, 34, 'columbus', '2012 ZETTLER RD', 'Zettler');
    addLmProperty(db, 35, 'columbus', '2002 ZETTLER RD', 'Zettler');

    const result = seedFromLeaseMarket(db);
    expect(result.linked).toBe(1);
    expect(result.skipped).toHaveLength(1);
    // the refused row must have written NOTHING, not just no workbook row
    expect(canonicalIdFor(db, 'lease_market', 'property', '35')).toBeNull();
    expect((db.prepare('SELECT COUNT(*) AS n FROM entity_xref').get() as { n: number }).n).toBe(2);
  });

  it('counts the reverse direction through the same normalization', () => {
    // Two listings for one building whose stored norms differ only in case/whitespace must still
    // trip the ambiguity guard, not land in separate buckets and link.
    const db = makeDb();
    addProperty(db, 'prop-1', '500 Main St');
    addLmProperty(db, 36, 'columbus', '500 MAIN ST', 'Main');
    addLmProperty(db, 37, 'columbus', '500  main st ', 'Main');

    const result = seedFromLeaseMarket(db);
    expect(result.linked).toBe(0);
    expect(result.proposed.every((p) => p.reason === 'ambiguous_address')).toBe(true);
  });

  it('records auto-derived links as exact_address, not manual', () => {
    const db = makeDb();
    addProperty(db, 'prop-1', '500 Main St');
    addLmProperty(db, 38, 'columbus', '500 MAIN ST', 'Main');
    expect(seedFromLeaseMarket(db).linked).toBe(1);
    const m = db.prepare('SELECT DISTINCT match_method FROM entity_xref').all() as Array<{
      match_method: string;
    }>;
    expect(m.map((r) => r.match_method)).toEqual(['exact_address']);
  });
});
