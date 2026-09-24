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
  effectiveDate?: string | null;
  expirationDate?: string | null;
  policyNumber?: string;
  sourceDate?: string;
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
    f.policyNumber ?? `POL-${f.propertyId}`,
    f.effectiveDate === undefined ? '2025-01-01' : f.effectiveDate,
    f.expirationDate ?? '2027-01-01',
    f.premiumAnnual ?? 5000,
    f.coverageTiv ?? 1_000_000,
    f.policyType,
    'test-fixture',
    f.sourceDate ?? '2026-06-01',
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

  it('a stale prior-term row never produces a second deductibleReviews row (2026-08-17 rollover fix)', async () => {
    // Regression for the rollover-supersession fix in insurance-analysis.ts: before that fix,
    // buildInsuranceAnalysis's renewalCalendar carried BOTH the old and new term of a rolled-over
    // policy (dedupeLatest's identity key doesn't recognize a new effective_date/policy_number as
    // the same logical policy), so this route's deductibleReviews loop (which iterates every
    // property-package policy in `policies`) reviewed the SAME loss events twice against two
    // different deductible/coverage-limit bases for one property — a silent double-review, not
    // just a display artifact. Confirms buildInsuranceAnalysis's collapse now narrows this to
    // exactly one row per property.
    const db = freshDb();
    seedProperty(db, '3540-e-5th-ave-columbus-oh', 'Property A');
    // Old term.
    insertPolicy(db, {
      propertyId: '3540-e-5th-ave-columbus-oh',
      policyType: 'Property Package',
      policyNumber: 'POL-A',
      effectiveDate: '2025-01-01',
      expirationDate: '2026-01-01',
      premiumAnnual: 5000,
      coverageTiv: 1_000_000,
      deductible: 10_000,
      coverageLimit: 500_000,
      sourceDate: '2025-01-05',
    });
    // Rolled-over term — same policy_number, new effective_date (the common case), superseding it.
    insertPolicy(db, {
      propertyId: '3540-e-5th-ave-columbus-oh',
      policyType: 'Property Package',
      policyNumber: 'POL-A',
      effectiveDate: '2026-01-01',
      expirationDate: '2027-01-01',
      premiumAnnual: 5300,
      coverageTiv: 1_000_000,
      deductible: 15_000,
      coverageLimit: 500_000,
      sourceDate: '2026-06-01',
    });

    const app = makeApp(db);
    const res = await app.request('/');
    expect(res.status).toBe(200);
    const parsed = InsuranceLossReport.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (parsed.success) {
      const rows = parsed.data.deductibleReviews.filter(
        (r) => r.propertyId === '3540-e-5th-ave-columbus-oh',
      );
      expect(rows).toHaveLength(1);
      expect(rows[0]?.deductible).toBe(15_000); // the CURRENT term's deductible, not the stale $10,000.
    }
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

// ── Policy-line key → property_master id → loss-event attachment (2026-09-23 review I-1) ──────
//
// buildInsuranceAnalysis resolves an 'ins-<stem>-<line>' policy key to its property_master id
// (T14). That resolution is FINANCIAL output for this route: buildInsuranceLossReport matches loss
// events to policies by `policy.propertyId`, and loss events are keyed by property_master id. With
// the pre-T14 wiring (propertyId = the raw policy-line key) nothing matched, so every deductible
// review and the self-insure roll-up for a policy-line-keyed property read $0. This pins the
// post-T14 behavior with hand-computed fixture math.
describe('GET /api/warehouse/insurance/loss — policy-line keys attach their property\'s loss events', () => {
  function insertLossEvent(db: WarehouseDb, f: { id: string; propertyId: string; lossDate: string; grossIncurred: number }): void {
    db.prepare(
      `INSERT INTO insurance_loss_events (id, property_id, policy_ref, loss_date, cause, gross_incurred, paid, reserve, source)
       VALUES (?, ?, NULL, ?, 'hail', ?, NULL, NULL, 'test-fixture')`,
    ).run(f.id, f.propertyId, f.lossDate, f.grossIncurred);
  }

  it('a policy keyed ins-9620state350-prop-hfd reviews the loss event recorded under 9620-e-state-route-350-raytown-mo', async () => {
    const db = freshDb();
    // property_master row exists ONLY under the resolved id — never under the raw policy key.
    seedProperty(db, '9620-e-state-route-350-raytown-mo', '9620 E State Route 350, Raytown MO');
    insertPolicy(db, {
      propertyId: 'ins-9620state350-prop-hfd',
      policyType: 'Property Package',
      premiumAnnual: 5000,
      coverageTiv: 1_000_000,
      deductible: 25_000,
      coverageLimit: 2_000_000,
    });
    // Loss runs carry property_master ids (FK), so the event lives under the resolved id.
    insertLossEvent(db, { id: 'EVT-9620-1', propertyId: '9620-e-state-route-350-raytown-mo', lossDate: '2024-01-01', grossIncurred: 42_000 });

    const res = await makeApp(db).request('/');
    expect(res.status).toBe(200);
    const parsed = InsuranceLossReport.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (!parsed.success) return;
    const report = parsed.data;

    // Warehouse-sourced loss runs (the table is non-empty), not the placeholder fixture.
    expect(report.lossDataSource).toBe('warehouse');

    // Deductible review — expected fixture math (d = 25,000; L = 2,000,000; gross = 42,000):
    //   retained    = min(42,000, 25,000)                     = 25,000
    //   transferred = max(0, min(42,000, 2,000,000) − 25,000) = 17,000
    //   overLimit   = max(0, 42,000 − 2,000,000)              = 0
    //   lossRatio   = 42,000 ÷ 5,000 premium                  = 8.4
    expect(report.deductibleReviews).toHaveLength(1);
    const review = report.deductibleReviews[0]!;
    // The $ figures first — under the pre-T14 wiring these read 0 (no event matched the raw key).
    expect(review.retainedUsd).toBe(25_000);
    expect(review.transferredUsd).toBe(17_000);
    expect(review.overLimitUsd).toBe(0);
    expect(review.eventsN).toBe(1);
    expect(review.lossesAboveDeductible).toBe(1);
    expect(review.lossRatio).toBeCloseTo(8.4, 10);
    expect(review.propertyId).toBe('9620-e-state-route-350-raytown-mo');
    expect(review.property).toBe('9620 E State Route 350, Raytown MO');

    // Self-insure roll-up counts that property once via its (only) policy.
    expect(report.selfInsure.retainedUsd).toBe(25_000);
    expect(report.selfInsure.transferredUsd).toBe(17_000);
    expect(report.selfInsure.premiumAnnualTotal).toBe(5000);

    // EAL row is named from the policy register (resolved name), not the bare id.
    expect(report.eal).toHaveLength(1);
    expect(report.eal[0]).toMatchObject({ propertyId: '9620-e-state-route-350-raytown-mo', property: '9620 E State Route 350, Raytown MO', eventsN: 1, grossIncurredTotal: 42_000 });

    // Still never a calibration write from this route.
    expect(calibrationVerdictCount(db)).toBe(0);
  });
});
