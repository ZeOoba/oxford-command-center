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
