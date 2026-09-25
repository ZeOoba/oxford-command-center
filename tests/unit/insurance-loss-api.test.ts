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
      // The real fixture's policyRef is the 'PLACEHOLDER' sentinel (docs/placeholder-data.md):
      // synthetic refs are never a "loss-run typo", so the data-quality list is empty here.
      expect(parsed.data.unmatchedPolicyRefs).toEqual([]);
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
      expect(parsed.data.unmatchedPolicyRefs).toEqual([]);
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

// ── Policy-line keys resolve to property_master ids; loss events attach by term (2026-09-24) ──
//
// property_insurance_policies.property_id holds policy-line keys ('ins-<stem>-<line>'), while
// insurance_loss_events.property_id is a property_master id (FK). Before this fix nothing ever
// matched, so every deductible review / self-insure line read $0. buildInsuranceAnalysis now
// resolves propertyId via the stem map, and buildInsuranceLossReport attaches each event to the
// ONE policy whose term covers its loss date (policy_ref match first) — so two concurrently
// in-force policies at 9620 Raytown no longer make the attachment order-dependent.
function insertLossEvent(db: WarehouseDb, f: { id: string; propertyId: string; lossDate: string; grossIncurred: number; policyRef?: string }): void {
  db.prepare(
    `INSERT INTO insurance_loss_events (id, property_id, policy_ref, loss_date, cause, gross_incurred, paid, reserve, source)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(f.id, f.propertyId, f.policyRef ?? null, f.lossDate, 'wind', f.grossIncurred, f.grossIncurred, 0, 'test-loss-run');
}

describe('GET /api/warehouse/insurance/loss — policy-line keys attach loss events', () => {
  const RAYTOWN = '9620-e-state-route-350-raytown-mo';

  it('a loss event under the master id reaches the ins-9620state350-prop-hfd policy: retained 25k / transferred 17k / lossRatio 8.4', async () => {
    const db = freshDb();
    // property_master row exists ONLY under the resolved id — never under the raw policy key.
    seedProperty(db, RAYTOWN, '9620 E State Route 350, Raytown MO');
    insertPolicy(db, {
      propertyId: 'ins-9620state350-prop-hfd',
      policyType: 'Property Package',
      premiumAnnual: 5000,
      coverageTiv: 1_000_000,
      deductible: 25_000,
      coverageLimit: 2_000_000,
      effectiveDate: '2025-01-01',
      expirationDate: '2027-01-01',
    });
    insertLossEvent(db, { id: 'L1', propertyId: RAYTOWN, lossDate: '2026-03-01', grossIncurred: 42_000 });

    const res = await makeApp(db).request('/');
    expect(res.status).toBe(200);
    const parsed = InsuranceLossReport.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (!parsed.success) return;
    const report = parsed.data;

    expect(report.lossDataSource).toBe('warehouse');
    expect(report.deductibleReviews).toHaveLength(1);
    const review = report.deductibleReviews[0]!;
    expect(review.property).toBe('9620 E State Route 350, Raytown MO');
    expect(review.propertyId).toBe(RAYTOWN);
    // d=25,000, L=2M, gross 42,000 → retained 25,000 / transferred 17,000; 42,000 / 5,000 = 8.4
    expect(review).toMatchObject({ eventsN: 1, retainedUsd: 25_000, transferredUsd: 17_000, overLimitUsd: 0 });
    expect(review.lossRatio).toBeCloseTo(8.4, 10);
    expect(report.selfInsure).toMatchObject({ retainedUsd: 25_000, transferredUsd: 17_000 });

    // Still never a calibration write from this route.
    expect(calibrationVerdictCount(db)).toBe(0);
  });

  it('overlapping 9620 terms: a 2026-07-04 loss uses the Hartford policy, not the lexicographically-first Westchester one', async () => {
    const db = freshDb();
    seedProperty(db, RAYTOWN, '9620 E State Route 350, Raytown MO');
    // Live shape (policy ids 1734 / 1735): Westchester 2025-10-18 → 2026-10-18,
    // Hartford BOP 2026-05-28 → 2027-05-28 — both in force on 2026-07-04. Westchester is inserted
    // first so it gets the lower row id, i.e. it is the one a lexicographic "primary" pick chose.
    insertPolicy(db, {
      propertyId: 'ins-9620state350-prop',
      policyType: 'Property',
      policyNumber: 'REDACTED-477',
      effectiveDate: '2025-10-18',
      expirationDate: '2026-10-18',
      premiumAnnual: 6000,
      coverageTiv: 1_000_000,
      deductible: 10_000,
      coverageLimit: 2_000_000,
    });
    insertPolicy(db, {
      propertyId: 'ins-9620state350-prop-hfd',
      policyType: 'Property (Hartford Spectrum BOP)',
      policyNumber: 'REDACTED-519',
      effectiveDate: '2026-05-28',
      expirationDate: '2027-05-28',
      premiumAnnual: 5000,
      coverageTiv: 1_000_000,
      deductible: 25_000,
      coverageLimit: 2_000_000,
    });
    insertLossEvent(db, { id: 'L1', propertyId: RAYTOWN, lossDate: '2026-07-04', grossIncurred: 42_000 });

    const res = await makeApp(db).request('/');
    expect(res.status).toBe(200);
    const parsed = InsuranceLossReport.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (!parsed.success) return;
    const report = parsed.data;

    expect(report.deductibleReviews).toHaveLength(2);
    const hartford = report.deductibleReviews.find((r) => r.deductible === 25_000)!;
    const westchester = report.deductibleReviews.find((r) => r.deductible === 10_000)!;
    expect(hartford).toMatchObject({ propertyId: RAYTOWN, eventsN: 1, retainedUsd: 25_000, transferredUsd: 17_000 });
    expect(hartford.lossRatio).toBeCloseTo(8.4, 10);
    expect(westchester).toMatchObject({ propertyId: RAYTOWN, eventsN: 0, retainedUsd: 0, transferredUsd: 0 });
    // Counted once, against the Hartford terms — not 10k/32k (Westchester) and not both.
    expect(report.selfInsure).toMatchObject({ retainedUsd: 25_000, transferredUsd: 17_000 });
  });
});

describe('GET /api/warehouse/insurance/loss — live-shaped book with no TIV on any current term', () => {
  it('property lines are reviewed without TIV; the tenant ACORD certificate and the GL line are not', async () => {
    const db = freshDb();
    seedProperty(db, '9620-e-state-route-350-raytown-mo', '9620 E State Route 350, Raytown MO');
    seedProperty(db, '7658-fishel-dr-n-dublin-oh', '7658 Fishel Dr N, Dublin OH');
    // coverageTiv 0 → the analysis engine's 'excluded-null-tiv' cohort (same branch as NULL; the
    // fixture helper defaults a null TIV to 1,000,000).
    insertPolicy(db, {
      propertyId: 'ins-9620state350-prop-hfd', policyType: 'Property (Hartford Spectrum BOP)', policyNumber: 'REDACTED-519',
      effectiveDate: '2026-05-28', expirationDate: '2027-05-28', premiumAnnual: 5000, coverageTiv: 0,
      deductible: 25_000, coverageLimit: 2_000_000,
    });
    insertPolicy(db, {
      propertyId: 'ins-9620state350-gl', policyType: 'General Liability (GL)', policyNumber: 'REDACTED-446',
      effectiveDate: '2025-10-18', expirationDate: '2026-10-18', premiumAnnual: 900, coverageTiv: 0,
    });
    insertPolicy(db, {
      propertyId: 'ins-7658fishel-acord28', policyType: 'Evidence of Property Insurance (ACORD 28)',
      effectiveDate: '2026-01-01', expirationDate: '2027-01-01', premiumAnnual: 0, coverageTiv: 0,
    });
    insertLossEvent(db, { id: 'L1', propertyId: '9620-e-state-route-350-raytown-mo', lossDate: '2026-07-04', grossIncurred: 42_000 });
    insertLossEvent(db, { id: 'L2', propertyId: '7658-fishel-dr-n-dublin-oh', lossDate: '2026-03-01', grossIncurred: 8_000 });

    const res = await makeApp(db).request('/');
    expect(res.status).toBe(200);
    const parsed = InsuranceLossReport.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (!parsed.success) return;
    const report = parsed.data;

    expect(report.deductibleReviews).toHaveLength(1);
    expect(report.deductibleReviews[0]).toMatchObject({
      propertyId: '9620-e-state-route-350-raytown-mo', eventsN: 1, retainedUsd: 25_000, transferredUsd: 17_000,
    });
    expect(report.selfInsure).toMatchObject({ retainedUsd: 25_000, transferredUsd: 17_000 });
    // The Fishel loss stays in EAL only.
    expect(report.eal.map((e) => e.propertyId).sort()).toEqual(['7658-fishel-dr-n-dublin-oh', '9620-e-state-route-350-raytown-mo']);
  });
});

describe('GET /api/warehouse/insurance/loss — policy_ref resolves superseded numbers on the same line', () => {
  it('a loss run citing the pre-reissue number (live 1310 → 1734 shape) books to the surviving Westchester row, not Hartford', async () => {
    const db = freshDb();
    const RAYTOWN = '9620-e-state-route-350-raytown-mo';
    seedProperty(db, RAYTOWN, '9620 E State Route 350, Raytown MO');
    // Same line + same term, reissued under a new number and captured later: the current-term
    // collapse keeps only the -002 row.
    insertPolicy(db, {
      propertyId: 'ins-9620state350-prop', policyType: 'Property', policyNumber: 'REDACTED-600',
      effectiveDate: '2025-10-18', expirationDate: '2026-10-18', premiumAnnual: 6000, coverageTiv: 0,
      deductible: 10_000, coverageLimit: 2_000_000, sourceDate: '2026-08-16',
    });
    insertPolicy(db, {
      propertyId: 'ins-9620state350-prop', policyType: 'Property', policyNumber: 'REDACTED-477',
      effectiveDate: '2025-10-18', expirationDate: '2026-10-18', premiumAnnual: 6000, coverageTiv: 0,
      deductible: 10_000, coverageLimit: 2_000_000, sourceDate: '2026-09-23',
    });
    insertPolicy(db, {
      propertyId: 'ins-9620state350-prop-hfd', policyType: 'Property (Hartford Spectrum BOP)', policyNumber: 'REDACTED-519',
      effectiveDate: '2026-05-28', expirationDate: '2027-05-28', premiumAnnual: 5000, coverageTiv: 0,
      deductible: 25_000, coverageLimit: 2_000_000,
    });
    insertLossEvent(db, { id: 'L1', propertyId: RAYTOWN, lossDate: '2026-07-01', grossIncurred: 40_000, policyRef: 'REDACTED-600' });

    const res = await makeApp(db).request('/');
    expect(res.status).toBe(200);
    const parsed = InsuranceLossReport.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (!parsed.success) return;
    const report = parsed.data;

    expect(report.deductibleReviews).toHaveLength(2); // the reissue collapsed to one Westchester row
    const westchester = report.deductibleReviews.find((r) => r.deductible === 10_000)!;
    const hartford = report.deductibleReviews.find((r) => r.deductible === 25_000)!;
    // d=10,000: gross 40,000 → retained 10,000 / transferred 30,000.
    expect(westchester).toMatchObject({ eventsN: 1, retainedUsd: 10_000, transferredUsd: 30_000 });
    expect(hartford.eventsN).toBe(0);
  });
});

