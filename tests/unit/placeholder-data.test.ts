// @vitest-environment node
//
// tests/unit/placeholder-data.test.ts
//
// Warehouse-first cutover resolvers (P4c/C2). Schema note: the brief's original test
// INSERTs targeted a hypothetical property_insurance_policies shape; adjusted here to the
// real schema in server/warehouse/migrations/008_insurance_policies.sql +
// 022_insurance_loss_events.sql —
//   - property_insurance_policies.id is INTEGER PRIMARY KEY AUTOINCREMENT (not a supplied
//     text id), so policy rows are inserted without an id and the resulting
//     `lastInsertRowid` is used as the resolveDecPages() map key.
//   - property_insurance_policies has NOT NULL columns beyond the brief's list:
//     policy_type and ingested_by (in addition to insurer, source, source_date). Both are
//     supplied below.
//   - the "premium" column does not exist; the real column is premium_annual.
//   - insurance_loss_events matches the brief's INSERT verbatim — no adjustment needed.
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../server/warehouse/migrate';
import { resolveLossEvents, resolveDecPages, resolveDepreciableBasis, resolveFiledReturns } from '../../server/warehouse/placeholder-data';

function freshDb() {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare('INSERT INTO property_master (id, name) VALUES (?, ?)').run('3540-e-5th-ave-columbus-oh', '3540 E 5th Ave');
  db.prepare('INSERT INTO property_master (id, name) VALUES (?, ?)').run('3034-westerville-rd-columbus-oh', '3034 Westerville Rd');
  return db;
}

describe('resolveLossEvents cutover', () => {
  it('empty table -> placeholder fixture, filtered to known properties, drops disclosed', () => {
    const r = resolveLossEvents(freshDb());
    expect(r.source).toBe('placeholder');
    expect(r.rows.length).toBeGreaterThan(0);
    expect(r.rows.every((e) => ['3540-e-5th-ave-columbus-oh', '3034-westerville-rd-columbus-oh'].includes(e.propertyId))).toBe(true);
    expect(r.droppedRows).toBeGreaterThan(0); // fixture rows for unseeded properties dropped
    // Post-condition of the negative-gross guard in parseLossEventFixtureRow: no resolved row
    // carries a negative grossIncurred (a negative fixture row is skipped + counted in
    // droppedRows). The drop itself isn't directly exercisable here — the fixture path is
    // module-relative and the parse helper unexported; mocking node:fs to reach that one line
    // would contort the design (the refute pass reads the guard directly).
    expect(r.rows.every((e) => e.grossIncurred >= 0)).toBe(true);
  });

  it('one real row -> warehouse source, fixture ignored', () => {
    const db = freshDb();
    db.prepare(
      `INSERT INTO insurance_loss_events (id, property_id, policy_ref, loss_date, cause, gross_incurred, paid, reserve, source)
       VALUES ('REAL-1', '3540-e-5th-ave-columbus-oh', 'P-1', '2025-01-01', 'wind', 12345, 12345, 0, 'broker-loss-run.xlsx')`,
    ).run();
    const r = resolveLossEvents(db);
    expect(r.source).toBe('warehouse');
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.grossIncurred).toBe(12345);
  });

  it("NULL ids (migration 022's TEXT PRIMARY KEY lacks NOT NULL) are coerced to '' at the source, for every downstream reader", () => {
    const db = freshDb();
    const ins = db.prepare(
      `INSERT INTO insurance_loss_events (id, property_id, policy_ref, loss_date, cause, gross_incurred, paid, reserve, source)
       VALUES (NULL, '3540-e-5th-ave-columbus-oh', ?, '2025-01-01', ?, 100, 100, 0, 'broker-loss-run.xlsx')`,
    );
    // SQLite admits any number of NULLs in a non-INTEGER PRIMARY KEY; causes differ for UNIQUE.
    ins.run('P-1', 'wind');
    ins.run('P-2', 'hail');
    const r = resolveLossEvents(db);
    expect(r.source).toBe('warehouse');
    expect(r.rows.map((e) => e.id)).toEqual(['', '']);
    expect(r.rows.every((e) => typeof e.id === 'string')).toBe(true);
  });
});

describe('resolveDecPages', () => {
  it('null columns -> blanket placeholder; real value wins per policy', () => {
    const db = freshDb();
    const pol1 = db
      .prepare(
        `INSERT INTO property_insurance_policies (property_id, insurer, policy_number, premium_annual, policy_type, source, source_date, ingested_by)
         VALUES ('3540-e-5th-ave-columbus-oh', 'Acme', 'PN-1', 10000, 'property', 'workbook', '2026-01-01', 'test-runner')`,
      )
      .run();
    const pol2 = db
      .prepare(
        `INSERT INTO property_insurance_policies (property_id, insurer, policy_number, premium_annual, deductible, coverage_limit, policy_type, source, source_date, ingested_by)
         VALUES ('3034-westerville-rd-columbus-oh', 'Acme', 'PN-2', 8000, 50000, 5000000, 'property', 'dec-page', '2026-01-01', 'test-runner')`,
      )
      .run();
    const r = resolveDecPages(db);
    expect(r.byPolicyId.get(String(pol1.lastInsertRowid))).toEqual({ deductible: 25000, coverageLimit: 2000000, source: 'placeholder' });
    expect(r.byPolicyId.get(String(pol2.lastInsertRowid))).toEqual({ deductible: 50000, coverageLimit: 5000000, source: 'warehouse' });
    expect(r.anyPlaceholder).toBe(true);
  });
});

describe('fixture-only resolvers', () => {
  it('basis rows filter to known properties and expose the placeholder schedule', () => {
    const r = resolveDepreciableBasis(freshDb());
    expect(r.source).toBe('placeholder');
    expect(r.rows.length).toBe(2); // only the two seeded properties survive
    expect(r.droppedRows).toBe(3);
    expect(r.bonusPctByYear['2026']).toBe(0.4);
    expect(r.scheduleNote).toMatch(/PLACEHOLDER/);
  });

  it('filed returns are metadata-only placeholder rows', () => {
    const r = resolveFiledReturns();
    expect(r.source).toBe('placeholder');
    expect(r.rows.every((x) => x.entity.includes('PLACEHOLDER'))).toBe(true);
  });
});
