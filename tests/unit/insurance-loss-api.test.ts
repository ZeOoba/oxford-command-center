// @vitest-environment node
//
// tests/unit/insurance-loss-api.test.ts
//
// server/warehouse/insurance-loss-api.ts sub-router tests (P4c placeholder buildout, Task 5).
// Mirrors the withDb 503-guard pattern established in insurance-analysis-api.ts /
// lease-forecast-api.test.ts. In-memory better-sqlite3 + runMigrations (architecture/
// coding-standards.md pattern) — never touches data/warehouse/finance.sqlite.
//
// HARD REQUIREMENT UNDER TEST: this route must NEVER write to calibration_verdict. The loss
// engine's inputs (renewalCalendar policies + placeholder-fallback dec pages/loss runs) are
// placeholder-tainted whenever the warehouse tables are empty, and a placeholder-tainted verdict
// must never enter calibration history (see insurance-loss-analysis.ts module header).
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../server/warehouse/migrate';
import type { WarehouseDb } from '../../server/warehouse/db';
import { insuranceLossApi } from '../../server/warehouse/insurance-loss-api';
import { InsuranceLossReport } from '../../src/contracts/insurance-loss';

function freshDb(): WarehouseDb {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function seedProperty(db: WarehouseDb, id: string, name: string): void {
  db.prepare('INSERT INTO property_master (id, name) VALUES (?, ?)').run(id, name);
}

interface PolicyFixture {
  propertyId: string;
  policyType: string;
  premiumAnnual?: number | null;
  coverageTiv?: number | null;
  deductible?: number | null;
  coverageLimit?: number | null;
  expirationDate?: string | null;
}

function insertPolicy(db: WarehouseDb, f: PolicyFixture): void {
  db.prepare(
    `INSERT INTO property_insurance_policies
       (property_id, insurer, policy_number, effective_date, expiration_date,
        premium_annual, coverage_tiv, policy_type, source, source_date, ingested_by,
        deductible, coverage_limit)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    f.propertyId,
    'Test Insurer',
    `POL-${f.propertyId}`,
    '2025-01-01',
    f.expirationDate ?? '2027-01-01',
    f.premiumAnnual ?? 5000,
    f.coverageTiv ?? 1_000_000,
    f.policyType,
    'test-fixture',
    '2026-06-01',
    'test-runner',
    f.deductible ?? null,
    f.coverageLimit ?? null,
  );
}

function makeApp(db: WarehouseDb) {
  return insuranceLossApi(() => db);
}

function makeAppUnavailableDb() {
  return insuranceLossApi(() => {
    throw new Error('warehouse unavailable in test');
  });
}

function calibrationVerdictCount(db: WarehouseDb): number {
  const row = db.prepare('SELECT count(*) AS c FROM calibration_verdict').get() as { c: number };
  return row.c;
}

// ── GET / ─────────────────────────────────────────────────────────────────────────────────

describe('GET /api/warehouse/insurance/loss', () => {
  it('503s when the warehouse is unavailable', async () => {
    const app = makeAppUnavailableDb();
    const res = await app.request('/');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'warehouse unavailable' });
  });

  it('200s with a contract-valid, placeholder-sourced report and writes ZERO calibration_verdict rows', async () => {
    const db = freshDb();
    // Two properties that also appear in loss-runs.placeholder.json, so the (fail-soft,
    // warehouse-first) loss-run resolver actually attributes events to them — exercising the
    // full engine wiring (EAL/deductible review), not just an empty-report happy path.
    seedProperty(db, '3540-e-5th-ave-columbus-oh', 'Property A');
    seedProperty(db, '3034-westerville-rd-columbus-oh', 'Property B');
    // Policy 1 carries REAL dec-page values (deductible/coverage_limit already in the warehouse).
    insertPolicy(db, {
      propertyId: '3540-e-5th-ave-columbus-oh',
      policyType: 'Property Package',
      premiumAnnual: 5000,
      coverageTiv: 1_000_000,
      deductible: 10_000,
      coverageLimit: 500_000,
    });
    // Policy 2 has no dec-page values -> falls back to the blanket placeholder fixture.
    insertPolicy(db, {
      propertyId: '3034-westerville-rd-columbus-oh',
      policyType: 'Property Package',
      premiumAnnual: 6000,
      coverageTiv: 1_200_000,
    });

    const before = calibrationVerdictCount(db);
    const app = makeApp(db);
    const res = await app.request('/');
    expect(res.status).toBe(200);

    const body = await res.json();
    const parsed = InsuranceLossReport.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.lossDataSource).toBe('placeholder');
      expect(parsed.data.advisoryOnly).toBe(true);
      // At least one property's events were attributed (real data flowed through the pipeline).
      expect(parsed.data.eal.length).toBeGreaterThan(0);
      expect(parsed.data.deductibleReviews.length).toBe(2);
    }

    // The hard requirement: this route must never write to calibration_verdict, regardless of
    // how placeholder-tainted the inputs are.
    const after = calibrationVerdictCount(db);
    expect(after).toBe(before);
    expect(after).toBe(0);
  });

  it('200s with an empty, contract-valid report on a fully empty book', async () => {
    const db = freshDb();
    const app = makeApp(db);
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const parsed = InsuranceLossReport.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (parsed.success) {
      expect(parsed.data.eal).toEqual([]);
      expect(parsed.data.deductibleReviews).toEqual([]);
      expect(parsed.data.rebidPipeline).toEqual([]);
    }
    expect(calibrationVerdictCount(db)).toBe(0);
  });

  it('500s and reports a stable error shape when the underlying query fails unexpectedly', async () => {
    // A raw, un-migrated in-memory db: getDb() itself succeeds (no 503), but the handler's own
    // query against property_insurance_policies throws once it runs — exercising the route's
    // own try/catch, distinct from the withDb 503 guard.
    const rawDb = new Database(':memory:');
    const app = makeApp(rawDb);
    const res = await app.request('/');
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: 'insurance loss analysis failed' });
  });
});
