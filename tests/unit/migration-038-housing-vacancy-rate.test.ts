// @vitest-environment node
// 2026-11-27 review (Gabriel): census-acs rows carry ACS B25002/B25004 HOUSING vacancy. Migration 038
// renames their metric vacancy_rate -> housing_vacancy_rate so nothing can read it as industrial
// vacancy. Idempotent; a tuple that already has a housing_vacancy_rate row keeps its legacy row as-is
// (never deleted; the reader ignores the legacy metric).
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runMigrations } from '../../server/warehouse/migrate';

const SQL = readFileSync(join('server', 'warehouse', 'migrations', '038_census_housing_vacancy_rate.sql'), 'utf8');

function makeDb() {
  const db = new Database(':memory:');
  runMigrations(db);
  return db;
}
const ins = (db: Database.Database, cluster: string, asOf: string, source: string, metric: string, value: number) =>
  db.prepare('INSERT INTO market_series (cluster, as_of, source, metric, value, confidence) VALUES (?, ?, ?, ?, ?, 1)')
    .run(cluster, asOf, source, metric, value);
const rows = (db: Database.Database) =>
  db.prepare('SELECT cluster, as_of, source, metric, value FROM market_series ORDER BY cluster, as_of, source, metric').all();

describe('migration 038 census housing_vacancy_rate', () => {
  it('is registered: a fresh warehouse applies it', () => {
    const db = makeDb();
    const names = (db.prepare('SELECT filename FROM _migrations').all() as { filename: string }[]).map((r) => r.filename);
    expect(names).toContain('038_census_housing_vacancy_rate.sql');
  });

  it('renames legacy census vacancy_rate rows, leaves other sources alone, and is idempotent', () => {
    const db = makeDb();
    ins(db, 'Alpha', '2026-01-29', 'census-acs', 'vacancy_rate', 7);
    ins(db, 'Beta', '2025-12-11', 'census-acs', 'vacancy_rate', 5.5);
    ins(db, 'Alpha', '2026-09-01', 'comps-ai', 'cap_rate', 6.5);
    ins(db, 'Alpha', '2026-09-01', 'comps-ai', 'vacancy_rate', 4); // not census: untouched
    db.exec(SQL);
    const once = rows(db);
    expect(once).toEqual([
      { cluster: 'Alpha', as_of: '2026-01-29', source: 'census-acs', metric: 'housing_vacancy_rate', value: 7 },
      { cluster: 'Alpha', as_of: '2026-09-01', source: 'comps-ai', metric: 'cap_rate', value: 6.5 },
      { cluster: 'Alpha', as_of: '2026-09-01', source: 'comps-ai', metric: 'vacancy_rate', value: 4 },
      { cluster: 'Beta', as_of: '2025-12-11', source: 'census-acs', metric: 'housing_vacancy_rate', value: 5.5 },
    ]);
    db.exec(SQL);
    expect(rows(db)).toEqual(once);
  });

  it('a tuple that already holds housing_vacancy_rate keeps both rows (no UNIQUE violation, nothing deleted)', () => {
    const db = makeDb();
    ins(db, 'Alpha', '2026-01-29', 'census-acs', 'vacancy_rate', 7);
    ins(db, 'Alpha', '2026-01-29', 'census-acs', 'housing_vacancy_rate', 7.1);
    expect(() => db.exec(SQL)).not.toThrow();
    expect(rows(db)).toEqual([
      { cluster: 'Alpha', as_of: '2026-01-29', source: 'census-acs', metric: 'housing_vacancy_rate', value: 7.1 },
      { cluster: 'Alpha', as_of: '2026-01-29', source: 'census-acs', metric: 'vacancy_rate', value: 7 },
    ]);
  });
});
