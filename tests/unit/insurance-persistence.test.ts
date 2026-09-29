// @vitest-environment node
//
// tests/unit/insurance-persistence.test.ts
//
// Phase 5 G — insurance policy persistence layer.
// Verifies captureInsurance() write path and migration 008 schema.
//
// Uses an in-memory SQLite (tmpdir) — never touches data/warehouse/finance.sqlite.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { captureInsurance } from '../../server/warehouse/insurance';
import type { WarehouseInsurancePolicy } from '../../server/warehouse/insurance';

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'insurance-test-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

const policy1: WarehouseInsurancePolicy = {
  propertyId: 'prop-001',
  insurer: 'Acme Insurance Co.',
  policyNumber: 'POL-2024-001',
  effectiveDate: '2024-01-01',
  expirationDate: '2025-01-01',
  premiumAnnual: 12000,
  coverageTiv: 2000000,
  policyType: 'property',
  source: 'workbook-ingest',
  sourceDate: '2024-06-01',
  ingestedBy: 'test-runner',
};

const policy2: WarehouseInsurancePolicy = {
  propertyId: 'prop-002',
  insurer: 'Harbor General',
  policyNumber: 'POL-2024-002',
  effectiveDate: '2024-03-01',
  expirationDate: '2025-03-01',
  premiumAnnual: 8500,
  coverageTiv: 1500000,
  policyType: 'liability',
  source: 'workbook-ingest',
  sourceDate: '2024-06-01',
  ingestedBy: 'test-runner',
};

describe('captureInsurance — basic insert', () => {
  it('inserts 2 valid policies into property_insurance_policies', () => {
    const db = freshDb();
    captureInsurance(db, [policy1, policy2]);
    const rows = db.prepare('SELECT * FROM property_insurance_policies ORDER BY property_id').all() as Array<{ property_id: string }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.property_id).toBe('prop-001');
    expect(rows[1]?.property_id).toBe('prop-002');
  });

  it('persists all required fields correctly', () => {
    const db = freshDb();
    captureInsurance(db, [policy1]);
    const row = db.prepare('SELECT * FROM property_insurance_policies WHERE property_id = ?').get('prop-001') as {
      insurer: string;
      policy_number: string;
      effective_date: string;
      expiration_date: string;
      premium_annual: number;
      coverage_tiv: number;
      policy_type: string;
      source: string;
      source_date: string;
      ingested_by: string;
    };
    expect(row.insurer).toBe('Acme Insurance Co.');
    expect(row.policy_number).toBe('POL-2024-001');
    expect(row.effective_date).toBe('2024-01-01');
    expect(row.expiration_date).toBe('2025-01-01');
    expect(row.premium_annual).toBe(12000);
    expect(row.coverage_tiv).toBe(2000000);
    expect(row.policy_type).toBe('property');
    expect(row.source).toBe('workbook-ingest');
    expect(row.source_date).toBe('2024-06-01');
    expect(row.ingested_by).toBe('test-runner');
  });
});

describe('captureInsurance — idempotency', () => {
  it('re-inserting same (property_id, policy_number, effective_date) does not throw and leaves one row', () => {
    const db = freshDb();
    captureInsurance(db, [policy1]);
    captureInsurance(db, [policy1]);
    const count = (db.prepare('SELECT COUNT(*) AS c FROM property_insurance_policies WHERE property_id = ?').get('prop-001') as { c: number }).c;
    expect(count).toBe(1);
  });
});

describe('captureInsurance — fail-open on bad row', () => {
  it('does not throw when a row violates NOT NULL; writes a data_quality_issues row', () => {
    const db = freshDb();
    // Force a DB NOT NULL violation by passing null for insurer (NOT NULL column).
    const bad = {
      propertyId: 'prop-bad',
      insurer: null as unknown as string,
      policyType: 'other',
      source: 'test',
      sourceDate: '2024-01-01',
      ingestedBy: 'test-runner',
    } as WarehouseInsurancePolicy;
    expect(() => captureInsurance(db, [bad])).not.toThrow();
    const issues = (db.prepare('SELECT COUNT(*) AS c FROM data_quality_issues WHERE property_id = ?').get('prop-bad') as { c: number }).c;
    expect(issues).toBeGreaterThanOrEqual(1);
  });
});

describe('property_insurance_policies schema — NOT NULL provenance triad', () => {
  it('rejects a row with NULL source', () => {
    const db = freshDb();
    expect(() => {
      db.prepare(
        `INSERT INTO property_insurance_policies
          (property_id, insurer, policy_type, source, source_date, ingested_by)
         VALUES ('p1', 'I1', 'property', NULL, '2024-01-01', 'test')`,
      ).run();
    }).toThrow();
  });

  it('rejects a row with NULL source_date', () => {
    const db = freshDb();
    expect(() => {
      db.prepare(
        `INSERT INTO property_insurance_policies
          (property_id, insurer, policy_type, source, source_date, ingested_by)
         VALUES ('p1', 'I1', 'property', 'workbook-ingest', NULL, 'test')`,
      ).run();
    }).toThrow();
  });

  it('rejects a row with NULL ingested_by', () => {
    const db = freshDb();
    expect(() => {
      db.prepare(
        `INSERT INTO property_insurance_policies
          (property_id, insurer, policy_type, source, source_date, ingested_by)
         VALUES ('p1', 'I1', 'property', 'workbook-ingest', '2024-01-01', NULL)`,
      ).run();
    }).toThrow();
  });
});

describe('captureInsurance — deductible/limit pair guard at the writer (refute wf_de191779-d68)', () => {
  const row = (db: WarehouseDb) =>
    db.prepare('SELECT deductible, coverage_limit FROM property_insurance_policies WHERE property_id = ?').get('prop-001') as {
      deductible: number | null;
      coverage_limit: number | null;
    };
  const pairIssues = (db: WarehouseDb) =>
    (db.prepare(`SELECT COUNT(*) AS c FROM data_quality_issues WHERE property_id = ? AND detail LIKE '%exceeds coverage limit%'`).get('prop-001') as { c: number }).c;

  it.each([
    ['limit first, then deductible', { coverageLimit: 2_000_000 }, { deductible: 5_000_000 }],
    ['deductible first, then limit', { deductible: 5_000_000 }, { coverageLimit: 2_000_000 }],
  ])('%s: two individually valid captures never MERGE into a d > limit pair — prior pair kept, warn logged', (_l, first, second) => {
    const db = freshDb();
    captureInsurance(db, [{ ...policy1, ...first }]);
    const before = row(db);
    captureInsurance(db, [{ ...policy1, ...second }]);
    expect(row(db)).toEqual(before);
    expect(pairIssues(db)).toBe(1);
  });

  it('a valid merge (d <= limit) still fills the missing field, no pair warning', () => {
    const db = freshDb();
    captureInsurance(db, [{ ...policy1, coverageLimit: 2_000_000 }]);
    captureInsurance(db, [{ ...policy1, deductible: 25_000 }]);
    expect(row(db)).toEqual({ deductible: 25_000, coverage_limit: 2_000_000 });
    expect(pairIssues(db)).toBe(0);
  });

  it('a first INSERT carrying d > limit writes neither value and logs a warn (module contract does not rely on the caller)', () => {
    const db = freshDb();
    captureInsurance(db, [{ ...policy1, deductible: 5_000_000, coverageLimit: 2_000_000 }]);
    expect(row(db)).toEqual({ deductible: null, coverage_limit: null });
    expect(pairIssues(db)).toBe(1);
  });
});
