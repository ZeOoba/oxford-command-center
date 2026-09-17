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

import { seedFromLeaseMarket } from '../../server/warehouse/entity-xref';

/** Real migration-029 lm_property, not a stub — 029 is on main as of 2026-09-17. */
function addLmProperty(
  db: Database.Database,
  id: number,
  marketId: string,
  addressNorm: string,
  oraPropertyKey: string | null,
  ownerType = 'unknown',
): void {
  db.prepare(
    `INSERT INTO lm_property (id, identity_key, address_norm, address_display, city_norm, market_id,
                              subtype, building_status, ora_property_key, owner_type, first_seen, last_seen)
     VALUES (?, ?, ?, ?, '', ?, 'warehouse', 'existing', ?, ?, '2026-09-01', '2026-09-01')`,
  ).run(
    id, `addr:${marketId}|x|${addressNorm}:${id}`, addressNorm, addressNorm, marketId,
    oraPropertyKey, ownerType,
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
