import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const SPINE_TABLES = [
  'agent_runs',
  'audit_log',
  'deal_decisions',
  'documents',
  'entity_xref',
  'lease_facts',
  'obligations',
];

describe('migration 030 — record spine', () => {
  it('creates all seven tables', () => {
    const db = makeDb();
    const names = (
      db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name IN (${SPINE_TABLES.map(() => '?').join(',')})`,
        )
        .all(...SPINE_TABLES) as Array<{ name: string }>
    )
      .map((r) => r.name)
      .sort();
    expect(names).toEqual(SPINE_TABLES);
  });

  it('enforces one row per (system, entity_type, external_id) in entity_xref', () => {
    const db = makeDb();
    const ins = () =>
      db
        .prepare(
          `INSERT INTO entity_xref (entity_type, canonical_id, system, external_id, match_method)
           VALUES ('property', 'prop-1', 'ora_pm', 'x-1', 'exact_address')`,
        )
        .run();
    expect(ins).not.toThrow();
    expect(ins).toThrow();
  });

  it('rejects an unknown entity_type', () => {
    const db = makeDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO entity_xref (entity_type, canonical_id, system, external_id, match_method)
           VALUES ('spaceship', 'c1', 'notion', 'n1', 'manual')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('rejects a lease_facts row whose document_id does not exist', () => {
    const db = makeDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO lease_facts (fact_id, lease_canonical_id, field, value_json, document_id, page, quote,
                                    quote_on_page, confidence, extractor_version, run_id, status)
           VALUES ('f1','l1','expiration','"2027-01-31"','missing-doc',4,'quoted text',1,0.91,'v1','r1','extracted')`,
        )
        .run(),
    ).toThrow(/FOREIGN KEY/);
  });

  it('rejects an unknown lease_facts status', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO documents (document_id, sha256, path, doc_type, landed_at)
       VALUES ('d1','abc','C:/x.pdf','lease','2026-09-17T00:00:00Z')`,
    ).run();
    expect(() =>
      db
        .prepare(
          `INSERT INTO lease_facts (fact_id, lease_canonical_id, field, value_json, document_id, page, quote,
                                    quote_on_page, confidence, extractor_version, run_id, status)
           VALUES ('f1','l1','expiration','"2027-01-31"','d1',4,'q',1,0.9,'v1','r1','probably-fine')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });

  it('makes audit_log append-only', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO audit_log (at, actor, action, entity, entity_id)
       VALUES ('2026-09-17T00:00:00Z','gabriel','verify','lease_facts','f1')`,
    ).run();
    expect(() => db.prepare(`UPDATE audit_log SET actor='someone-else' WHERE seq=1`).run()).toThrow(
      /append-only/,
    );
    expect(() => db.prepare(`DELETE FROM audit_log WHERE seq=1`).run()).toThrow(/append-only/);
  });

  it('defaults an obligation to open and rejects an unknown responsible_party', () => {
    const db = makeDb();
    db.prepare(
      `INSERT INTO obligations (obligation_id, lease_canonical_id, kind, responsible_party, source_fact_ids)
       VALUES ('o1','l1','renewal_notice','tenant','["f1"]')`,
    ).run();
    expect(
      (db.prepare(`SELECT status FROM obligations WHERE obligation_id='o1'`).get() as {
        status: string;
      }).status,
    ).toBe('open');
    expect(() =>
      db
        .prepare(
          `INSERT INTO obligations (obligation_id, lease_canonical_id, kind, responsible_party, source_fact_ids)
           VALUES ('o2','l1','renewal_notice','the-broker','["f1"]')`,
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});
