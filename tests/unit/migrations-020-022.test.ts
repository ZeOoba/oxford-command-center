import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';

function makeMemoryDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedProperty(db: Database.Database, id = 'test-prop'): void {
  db.prepare(
    `INSERT INTO property_master (id, name, financial_mode, ownership_pct, ownership_status)
     VALUES (?, 'Test Property', 'pnl', 1.0, 'active')`,
  ).run(id);
}

describe('migration 020 — property_tax_assessments + tax_appeals', () => {
  it('creates both tables', () => {
    const db = makeMemoryDb();
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('property_tax_assessments','tax_appeals')")
      .all()
      .map((r) => (r as { name: string }).name)
      .sort();
    expect(tables).toEqual(['property_tax_assessments', 'tax_appeals']);
  });

  it('enforces UNIQUE(property_id, tax_year) on property_tax_assessments', () => {
    const db = makeMemoryDb();
    seedProperty(db);
    const insert = () =>
      db
        .prepare(
          `INSERT INTO property_tax_assessments (property_id, tax_year, source)
           VALUES ('test-prop', 2026, 'county-portal')`,
        )
        .run();
    expect(insert).not.toThrow();
    expect(insert).toThrow();
  });

  it('allows the same property across different tax years', () => {
    const db = makeMemoryDb();
    seedProperty(db);
    expect(() => {
      db.prepare(`INSERT INTO property_tax_assessments (property_id, tax_year, source) VALUES ('test-prop', 2025, 'county-portal')`).run();
      db.prepare(`INSERT INTO property_tax_assessments (property_id, tax_year, source) VALUES ('test-prop', 2026, 'county-portal')`).run();
    }).not.toThrow();
  });

  it('rejects tax_year outside 1990..2100', () => {
    const db = makeMemoryDb();
    seedProperty(db);
    expect(() =>
      db.prepare(`INSERT INTO property_tax_assessments (property_id, tax_year, source) VALUES ('test-prop', 1899, 'county-portal')`).run(),
    ).toThrow();
    expect(() =>
      db.prepare(`INSERT INTO property_tax_assessments (property_id, tax_year, source) VALUES ('test-prop', 2101, 'county-portal')`).run(),
    ).toThrow();
  });

  it('rejects assessment_ratio of 1.5 (out of (0, 1] range)', () => {
    const db = makeMemoryDb();
    seedProperty(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO property_tax_assessments (property_id, tax_year, assessment_ratio, source)
           VALUES ('test-prop', 2026, 1.5, 'county-portal')`,
        )
        .run(),
    ).toThrow();
  });

  it('accepts a valid assessment_ratio (e.g. 0.35)', () => {
    const db = makeMemoryDb();
    seedProperty(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO property_tax_assessments (property_id, tax_year, assessment_ratio, source)
           VALUES ('test-prop', 2026, 0.35, 'county-portal')`,
        )
        .run(),
    ).not.toThrow();
  });

  it('rejects a negative assessed_value / annual_tax_billed', () => {
    const db = makeMemoryDb();
    seedProperty(db);
    expect(() =>
      db.prepare(`INSERT INTO property_tax_assessments (property_id, tax_year, assessed_value, source) VALUES ('test-prop', 2026, -1, 'county-portal')`).run(),
    ).toThrow();
    expect(() =>
      db.prepare(`INSERT INTO property_tax_assessments (property_id, tax_year, annual_tax_billed, source) VALUES ('test-prop', 2027, -1, 'county-portal')`).run(),
    ).toThrow();
  });

  it('rejects an unrecognized tax_appeals.status value', () => {
    const db = makeMemoryDb();
    seedProperty(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO tax_appeals (id, property_id, tax_year, status) VALUES ('appeal-1', 'test-prop', 2026, 'bogus')`,
        )
        .run(),
    ).toThrow();
  });

  it('accepts every valid tax_appeals.status value', () => {
    const db = makeMemoryDb();
    seedProperty(db);
    const statuses = ['draft', 'filed', 'hearing', 'won', 'lost', 'withdrawn'];
    statuses.forEach((status, i) => {
      expect(() =>
        db
          .prepare(
            `INSERT INTO tax_appeals (id, property_id, tax_year, status) VALUES (?, 'test-prop', 2026, ?)`,
          )
          .run(`appeal-${i}`, status),
      ).not.toThrow();
    });
  });

  it('rejects a negative tax_appeals.est_savings_annual', () => {
    const db = makeMemoryDb();
    seedProperty(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO tax_appeals (id, property_id, tax_year, status, est_savings_annual) VALUES ('appeal-neg', 'test-prop', 2026, 'draft', -100)`,
        )
        .run(),
    ).toThrow();
  });

  it('rejects a property_tax_assessments row for a nonexistent property (FK)', () => {
    const db = makeMemoryDb();
    expect(() =>
      db.prepare(`INSERT INTO property_tax_assessments (property_id, tax_year, source) VALUES ('no-such-prop', 2026, 'county-portal')`).run(),
    ).toThrow();
  });
});

describe('migration 021 — recommendation_feedback', () => {
  it('creates the table', () => {
    const db = makeMemoryDb();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='recommendation_feedback'")
      .get();
    expect(row).toBeTruthy();
  });

  it('accepts a valid accept/dismiss row', () => {
    const db = makeMemoryDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO recommendation_feedback (id, subject_kind, subject_id, decision, decided_at)
           VALUES ('fb-1', 'insight', 'ins-1', 'accept', '2026-07-06T00:00:00Z')`,
        )
        .run(),
    ).not.toThrow();
  });

  it('rejects an unrecognized subject_kind', () => {
    const db = makeMemoryDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO recommendation_feedback (id, subject_kind, subject_id, decision, decided_at)
           VALUES ('fb-2', 'bogus', 'ins-1', 'accept', '2026-07-06T00:00:00Z')`,
        )
        .run(),
    ).toThrow();
  });

  it('rejects an unrecognized decision', () => {
    const db = makeMemoryDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO recommendation_feedback (id, subject_kind, subject_id, decision, decided_at)
           VALUES ('fb-3', 'alert', 'alert-1', 'maybe', '2026-07-06T00:00:00Z')`,
        )
        .run(),
    ).toThrow();
  });

  it('allows a second feedback row for the same subject (append-only, no UPDATE path)', () => {
    const db = makeMemoryDb();
    expect(() => {
      db.prepare(`INSERT INTO recommendation_feedback (id, subject_kind, subject_id, decision, decided_at) VALUES ('fb-4', 'allocation', 'alloc-1', 'dismiss', '2026-07-06T00:00:00Z')`).run();
      db.prepare(`INSERT INTO recommendation_feedback (id, subject_kind, subject_id, decision, decided_at) VALUES ('fb-5', 'allocation', 'alloc-1', 'accept', '2026-07-07T00:00:00Z')`).run();
    }).not.toThrow();
  });
});

describe('migration 022 — insurance_loss_events + property_insurance_policies columns', () => {
  it('creates the insurance_loss_events table', () => {
    const db = makeMemoryDb();
    const row = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='insurance_loss_events'")
      .get();
    expect(row).toBeTruthy();
  });

  it('enforces UNIQUE(property_id, loss_date, cause, gross_incurred) dedup', () => {
    const db = makeMemoryDb();
    seedProperty(db);
    const insert = () =>
      db
        .prepare(
          `INSERT INTO insurance_loss_events (id, property_id, loss_date, cause, gross_incurred, source)
           VALUES ('loss-1', 'test-prop', '2026-01-15', 'fire', 5000, 'broker')`,
        )
        .run();
    expect(insert).not.toThrow();
    // Same id would collide on PK too, but the point of this test is the UNIQUE tuple —
    // use a distinct id to isolate the tuple-uniqueness check from the PK check.
    const dup = () =>
      db
        .prepare(
          `INSERT INTO insurance_loss_events (id, property_id, loss_date, cause, gross_incurred, source)
           VALUES ('loss-2', 'test-prop', '2026-01-15', 'fire', 5000, 'broker')`,
        )
        .run();
    expect(dup).toThrow();
  });

  it('allows two loss events for the same property/date that differ in cause', () => {
    const db = makeMemoryDb();
    seedProperty(db);
    expect(() => {
      db.prepare(`INSERT INTO insurance_loss_events (id, property_id, loss_date, cause, gross_incurred, source) VALUES ('loss-a', 'test-prop', '2026-02-01', 'fire', 1000, 'broker')`).run();
      db.prepare(`INSERT INTO insurance_loss_events (id, property_id, loss_date, cause, gross_incurred, source) VALUES ('loss-b', 'test-prop', '2026-02-01', 'water', 1000, 'broker')`).run();
    }).not.toThrow();
  });

  it('rejects a negative gross_incurred', () => {
    const db = makeMemoryDb();
    seedProperty(db);
    expect(() =>
      db
        .prepare(
          `INSERT INTO insurance_loss_events (id, property_id, loss_date, cause, gross_incurred, source)
           VALUES ('loss-neg', 'test-prop', '2026-03-01', 'wind', -1, 'broker')`,
        )
        .run(),
    ).toThrow();
  });

  it('adds deductible and coverage_limit columns to property_insurance_policies', () => {
    const db = makeMemoryDb();
    const cols = db
      .prepare('PRAGMA table_info(property_insurance_policies)')
      .all()
      .map((c) => (c as { name: string }).name);
    expect(cols).toContain('deductible');
    expect(cols).toContain('coverage_limit');
  });

  it('allows inserting a policy row with deductible/coverage_limit populated', () => {
    const db = makeMemoryDb();
    expect(() =>
      db
        .prepare(
          `INSERT INTO property_insurance_policies
             (property_id, insurer, policy_type, source, source_date, ingested_by, deductible, coverage_limit)
           VALUES ('test-prop', 'Acme Insurance', 'property', 'workbook', '2026-01-01', 'test', 25000, 5000000)`,
        )
        .run(),
    ).not.toThrow();
  });
});
