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
      policyNumber: 'MMF17962784-002',
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
      policyNumber: '37 SBA CB6KKB',
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

describe('GET /api/warehouse/insurance/loss — NULL loss-event id with an unmatched policy_ref', () => {
  const RAYTOWN = '9620-e-state-route-350-raytown-mo';

  it('still 200s: migration 022 declares id TEXT PRIMARY KEY without NOT NULL, so a NULL id row is listed as eventId \'\' rather than 500ing the report', async () => {
    const db = freshDb();
    seedProperty(db, RAYTOWN, '9620 E State Route 350, Raytown MO');
    insertPolicy(db, {
      propertyId: 'ins-9620state350-prop-hfd',
      policyType: 'Property Package',
      policyNumber: '37SBACB6KKB',
      premiumAnnual: 5000,
      coverageTiv: 1_000_000,
      deductible: 25_000,
      coverageLimit: 2_000_000,
      effectiveDate: '2025-01-01',
      expirationDate: '2027-01-01',
    });
    // Raw INSERT with a NULL id — SQLite admits it (no NOT NULL on the TEXT PRIMARY KEY).
    db.prepare(
      `INSERT INTO insurance_loss_events (id, property_id, policy_ref, loss_date, cause, gross_incurred, paid, reserve, source)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(RAYTOWN, 'NOT-ON-FILE', '2026-03-01', 'wind', 42_000, 42_000, 0, 'test-loss-run');

    const res = await makeApp(db).request('/');
    expect(res.status).toBe(200);
    const parsed = InsuranceLossReport.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (!parsed.success) return;
    const report = parsed.data;

    expect(report.lossDataSource).toBe('warehouse');
    expect(report.unmatchedPolicyRefs).toEqual([expect.objectContaining({ eventId: '', propertyId: RAYTOWN, policyRef: 'NOT-ON-FILE' })]);
    // Attachment unaffected: the event still books by covering term (d=25k on 42k).
    expect(report.deductibleReviews).toHaveLength(1);
    expect(report.deductibleReviews[0]).toMatchObject({ eventsN: 1, retainedUsd: 25_000, transferredUsd: 17_000 });
    expect(calibrationVerdictCount(db)).toBe(0);
  });

  it('TWO NULL-id rows at one property with the SAME loss_date still 200 (refute wf_5326581d-04f: the per-property (lossDate, id) sort must not see null)', async () => {
    const db = freshDb();
    seedProperty(db, RAYTOWN, '9620 E State Route 350, Raytown MO');
    insertPolicy(db, {
      propertyId: 'ins-9620state350-prop-hfd',
      policyType: 'Property Package',
      policyNumber: '37SBACB6KKB',
      premiumAnnual: 5000,
      coverageTiv: 1_000_000,
      deductible: 25_000,
      coverageLimit: 2_000_000,
      effectiveDate: '2025-01-01',
      expirationDate: '2027-01-01',
    });
    // SQLite allows any number of NULLs in a non-INTEGER PRIMARY KEY; the causes differ to satisfy
    // the UNIQUE(property_id, loss_date, cause, gross_incurred) constraint.
    const ins = db.prepare(
      `INSERT INTO insurance_loss_events (id, property_id, policy_ref, loss_date, cause, gross_incurred, paid, reserve, source)
       VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    ins.run(RAYTOWN, 'NOT-ON-FILE', '2026-03-01', 'wind', 42_000, 42_000, 0, 'test-loss-run');
    ins.run(RAYTOWN, 'ALSO-NOT-ON-FILE', '2026-03-01', 'hail', 8_000, 8_000, 0, 'test-loss-run');

    const res = await makeApp(db).request('/');
    expect(res.status).toBe(200);
    const parsed = InsuranceLossReport.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (!parsed.success) return;
    const report = parsed.data;

    // Content order, not insertion order: eventId ties on '' so the cause tiebreak decides — hail < wind.
    expect(report.unmatchedPolicyRefs.map((u) => [u.eventId, u.policyRef, u.cause])).toEqual([['', 'ALSO-NOT-ON-FILE', 'hail'], ['', 'NOT-ON-FILE', 'wind']]);
    // Attachment unaffected: both book against the one covering term — retained 25k + 8k, transferred 17k + 0.
    expect(report.deductibleReviews).toHaveLength(1);
    expect(report.deductibleReviews[0]).toMatchObject({ eventsN: 2, retainedUsd: 33_000, transferredUsd: 17_000 });
    expect(calibrationVerdictCount(db)).toBe(0);
  });
});

describe('GET /api/warehouse/insurance/loss — loosely-typed SQL text columns (only raw SQL can write them; the importer rejects them)', () => {
  const RAYTOWN = '9620-e-state-route-350-raytown-mo';

  function seedRaytownWithPolicy(db: WarehouseDb): void {
    seedProperty(db, RAYTOWN, '9620 E State Route 350, Raytown MO');
    insertPolicy(db, {
      propertyId: 'ins-9620state350-prop-hfd',
      policyType: 'Property Package',
      policyNumber: '37SBACB6KKB',
      premiumAnnual: 5000,
      coverageTiv: 1_000_000,
      deductible: 25_000,
      coverageLimit: 2_000_000,
      effectiveDate: '2025-01-01',
      expirationDate: '2027-01-01',
    });
  }

  async function expectContractValid200(db: WarehouseDb) {
    const res = await makeApp(db).request('/');
    expect(res.status).toBe(200);
    const parsed = InsuranceLossReport.safeParse(await res.json());
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(calibrationVerdictCount(db)).toBe(0);
    return parsed.data;
  }

  it('F1: a BLOB policy_ref with a third-party cause still 200s (detection normalizes the ref before attachEvent\'s early return)', async () => {
    const db = freshDb();
    seedRaytownWithPolicy(db);
    db.prepare(
      `INSERT INTO insurance_loss_events (id, property_id, policy_ref, loss_date, cause, gross_incurred, paid, reserve, source)
       VALUES ('B1', ?, X'41', '2026-03-01', 'bodily injury', 40000, 40000, 0, 'test-loss-run')`,
    ).run(RAYTOWN);
    const report = await expectContractValid200(db);
    // A non-string ref is normalized to null at the loader: nothing to match, nothing to flag.
    expect(report.unmatchedPolicyRefs).toEqual([]);
    expect(report.lossDataSource).toBe('warehouse');
  });

  it('F2: a BLOB cause with an unmatched ref still 200s, listed with cause null', async () => {
    const db = freshDb();
    seedRaytownWithPolicy(db);
    db.prepare(
      `INSERT INTO insurance_loss_events (id, property_id, policy_ref, loss_date, cause, gross_incurred, paid, reserve, source)
       VALUES ('B2', ?, 'NOPE', '2026-03-01', X'02', 42000, 42000, 0, 'test-loss-run')`,
    ).run(RAYTOWN);
    const report = await expectContractValid200(db);
    expect(report.unmatchedPolicyRefs).toEqual([expect.objectContaining({ eventId: 'B2', policyRef: 'NOPE', cause: null })]);
    // Attachment unaffected: covering term, d=25k on 42k.
    expect(report.deductibleReviews[0]).toMatchObject({ eventsN: 1, retainedUsd: 25_000, transferredUsd: 17_000 });
  });

  it('F3: a BLOB loss_date (TEXT NOT NULL stores a BLOB as-is) still 200s — a single event, no sort needed to trip isoDay().trim()', async () => {
    const db = freshDb();
    seedRaytownWithPolicy(db);
    db.prepare(
      `INSERT INTO insurance_loss_events (id, property_id, policy_ref, loss_date, cause, gross_incurred, paid, reserve, source)
       VALUES ('B3', ?, 'NOPE', X'323032362D30332D3031', 'wind', 42000, 42000, 0, 'test-loss-run')`,
    ).run(RAYTOWN);
    const report = await expectContractValid200(db);
    // '' date: no calendar year → not an observation year; term narrowing skipped → most recent
    // policy still attaches it; the unmatched entry carries lossDate ''.
    expect(report.unmatchedPolicyRefs).toEqual([expect.objectContaining({ eventId: 'B3', policyRef: 'NOPE', lossDate: '' })]);
    expect(report.deductibleReviews[0]).toMatchObject({ eventsN: 1, retainedUsd: 25_000, transferredUsd: 17_000 });
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
      propertyId: 'ins-9620state350-prop-hfd', policyType: 'Property (Hartford Spectrum BOP)', policyNumber: '37 SBA CB6KKB',
      effectiveDate: '2026-05-28', expirationDate: '2027-05-28', premiumAnnual: 5000, coverageTiv: 0,
      deductible: 25_000, coverageLimit: 2_000_000,
    });
    insertPolicy(db, {
      propertyId: 'ins-9620state350-gl', policyType: 'General Liability (GL)', policyNumber: 'GLWF18677015-001',
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
      propertyId: 'ins-9620state350-prop', policyType: 'Property', policyNumber: 'MMF17962784',
      effectiveDate: '2025-10-18', expirationDate: '2026-10-18', premiumAnnual: 6000, coverageTiv: 0,
      deductible: 10_000, coverageLimit: 2_000_000, sourceDate: '2026-08-16',
    });
    insertPolicy(db, {
      propertyId: 'ins-9620state350-prop', policyType: 'Property', policyNumber: 'MMF17962784-002',
      effectiveDate: '2025-10-18', expirationDate: '2026-10-18', premiumAnnual: 6000, coverageTiv: 0,
      deductible: 10_000, coverageLimit: 2_000_000, sourceDate: '2026-09-23',
    });
    insertPolicy(db, {
      propertyId: 'ins-9620state350-prop-hfd', policyType: 'Property (Hartford Spectrum BOP)', policyNumber: '37 SBA CB6KKB',
      effectiveDate: '2026-05-28', expirationDate: '2027-05-28', premiumAnnual: 5000, coverageTiv: 0,
      deductible: 25_000, coverageLimit: 2_000_000,
    });
    insertLossEvent(db, { id: 'L1', propertyId: RAYTOWN, lossDate: '2026-07-01', grossIncurred: 40_000, policyRef: 'MMF17962784' });

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


describe('GET /api/warehouse/insurance/loss — #383 refute follow-ups: every loader column normalized (raw-SQL-only values)', () => {
  const RAYTOWN = '9620-e-state-route-350-raytown-mo';
  const POLICY_KEY = 'ins-9620state350-prop-hfd';

  function seed(db: WarehouseDb): void {
    seedProperty(db, RAYTOWN, '9620 E State Route 350, Raytown MO');
    insertPolicy(db, {
      propertyId: POLICY_KEY,
      policyType: 'Property Package',
      policyNumber: '37SBACB6KKB',
      premiumAnnual: 5000,
      coverageTiv: 1_000_000,
      deductible: 25_000,
      coverageLimit: 2_000_000,
      effectiveDate: '2025-01-01',
      expirationDate: '2027-01-01',
    });
  }

  function insertLoss(db: WarehouseDb, id: string, lossDateSql: string, grossSql: string, cause = 'wind'): void {
    db.prepare(
      `INSERT INTO insurance_loss_events (id, property_id, policy_ref, loss_date, cause, gross_incurred, paid, reserve, source)
       VALUES (?, ?, '37SBACB6KKB', ${lossDateSql}, ?, ${grossSql}, 0, 0, 'test-loss-run')`,
    ).run(id, RAYTOWN, cause);
  }

  async function get200(db: WarehouseDb) {
    const res = await makeApp(db).request('/');
    const body: unknown = await res.json();
    expect(res.status, JSON.stringify(body)).toBe(200);
    const parsed = InsuranceLossReport.safeParse(body);
    expect(parsed.success, JSON.stringify(parsed.success ? null : parsed.error.issues)).toBe(true);
    if (!parsed.success) throw new Error('unreachable');
    expect(calibrationVerdictCount(db)).toBe(0);
    return parsed.data;
  }

  // ── 1. dec-page deductible / coverage_limit ─────────────────────────────────────────────
  it.each([
    ['a BLOB deductible', `deductible = X'3235'`],
    ['a non-numeric text deductible', `deductible = 'abc'`],
    ['an Infinity deductible', `deductible = 9e999`],
    ['a BLOB coverage_limit', `coverage_limit = X'3130'`],
    ['a negative coverage_limit', `coverage_limit = -5`],
    ['a deductible above the coverage limit (the importer rejects d > limit)', `deductible = 3000000, coverage_limit = 2000000`],
  ])('D: %s is unusable dec data — the policy reads absent (no placeholder blanket), and the split stays numeric', async (_label, set) => {
    const db = freshDb();
    seed(db);
    db.exec(`UPDATE property_insurance_policies SET ${set}`);
    insertLoss(db, 'L1', `'2026-03-01'`, '42000');
    const report = await get200(db);
    const review = report.deductibleReviews[0];
    expect(review).toBeDefined();
    // Present-but-unusable is NOT "pending dec pages": no placeholder blanket is substituted for a
    // real captured value — the policy reads absent (fully transferred), never the $25K/$2M fixture.
    expect(review?.decSource).toBe('absent');
    expect(report.decPageDataSource).not.toBe('placeholder');
    expect(Number.isFinite(review?.retainedUsd)).toBe(true);
    expect(Number.isFinite(review?.transferredUsd)).toBe(true);
    expect((review?.retainedUsd ?? 0) + (review?.transferredUsd ?? 0) + (review?.overLimitUsd ?? 0)).toBe(42_000);
  });

  // ── 2. loadPolicyTerms ──────────────────────────────────────────────────────────────────
  it.each([
    ['a BLOB effective_date', `effective_date = X'32303235'`],
    ['a BLOB expiration_date', `expiration_date = X'32303237'`],
    ['a BLOB policy_number', `policy_number = X'41'`],
    ['an integer policy_number', `policy_number = 12345`],
    ['a numeric effective_date (TEXT affinity stores 1717200000.0)', `effective_date = 1717200000.0`],
    ['a US-format expiration_date', `expiration_date = '01/01/2027'`],
  ])('T: %s on the policy row still 200s and still attaches the loss', async (_label, set) => {
    const db = freshDb();
    seed(db);
    db.exec(`UPDATE property_insurance_policies SET ${set}`);
    insertLoss(db, 'L1', `'2026-03-01'`, '42000');
    const report = await get200(db);
    expect(report.deductibleReviews[0]).toMatchObject({ eventsN: 1, retainedUsd: 25_000, transferredUsd: 17_000 });
  });

  // ── 3. loss_date must be ISO YYYY-MM-DD ─────────────────────────────────────────────────
  it.each([
    ['an epoch REAL (TEXT affinity stores 1717200000.0)', '1717200000.0'],
    ['a YYYYMMDD REAL', '20240601.0'],
    ['a US-format string', `'06/01/2024'`],
    ['an impossible calendar date', `'2024-02-30'`],
  ])('Y: %s mints no phantom observation year and is counted as coerced', async (_label, dateSql) => {
    const db = freshDb();
    seed(db);
    insertLoss(db, 'GOOD', `'2026-03-01'`, '42000');
    insertLoss(db, 'BAD', dateSql, '1000', 'hail');
    const report = await get200(db);
    expect(report.selfInsure.observationYears).toBe(1);
    expect(report.coercedLossEventRows).toBe(1);
    // Still counted toward the gross total — only the date is dropped.
    expect(report.eal[0]).toMatchObject({ eventsN: 2, grossIncurredTotal: 43_000 });
  });

  // ── 4. coerced-row counter ──────────────────────────────────────────────────────────────
  it('C: a BLOB / text gross_incurred is counted; a NULL gross (a legitimate "not yet valued") is not', async () => {
    const db = freshDb();
    seed(db);
    insertLoss(db, 'OK', `'2026-03-01'`, '42000');
    insertLoss(db, 'NUL', `'2026-03-02'`, 'NULL', 'hail');
    insertLoss(db, 'BLB', `'2026-03-03'`, `X'3130'`, 'fire');
    insertLoss(db, 'TXT', `'2026-03-04'`, `'lots'`, 'flood');
    const report = await get200(db);
    expect(report.coercedLossEventRows).toBe(2);
    expect(report.eal[0]).toMatchObject({ eventsN: 4, grossIncurredTotal: 42_000 });
  });

  it('C: a clean warehouse book and the placeholder path both report 0', async () => {
    const clean = freshDb();
    seed(clean);
    insertLoss(clean, 'OK', `'2026-03-01'`, '42000');
    expect((await get200(clean)).coercedLossEventRows).toBe(0);
    const empty = freshDb();
    seed(empty);
    const placeholder = await get200(empty);
    expect(placeholder.lossDataSource).not.toBe('warehouse');
    expect(placeholder.coercedLossEventRows).toBe(0);
  });

  // ── 5. gross_incurred upper bound ───────────────────────────────────────────────────────
  it('G: two 1e308 rows at one property cannot sum to Infinity (which JSON-serializes as null and breaks the client parse)', async () => {
    const db = freshDb();
    seed(db);
    insertLoss(db, 'H1', `'2025-03-01'`, '1e308');
    insertLoss(db, 'H2', `'2026-03-01'`, '1e308', 'hail');
    const report = await get200(db);
    expect(Number.isFinite(report.eal[0]?.grossIncurredTotal)).toBe(true);
    expect(Number.isFinite(report.selfInsure.transferredUsd)).toBe(true);
    expect(report.coercedLossEventRows).toBe(2);
  });
});

describe('GET /api/warehouse/insurance/loss — partial dec data still takes the placeholder blanket (unchanged)', () => {
  it('a valid deductible beside a NULL coverage_limit is "not yet captured", not "unusable": decSource placeholder', async () => {
    const db = freshDb();
    seedProperty(db, '9620-e-state-route-350-raytown-mo', '9620 E State Route 350, Raytown MO');
    insertPolicy(db, {
      propertyId: 'ins-9620state350-prop-hfd',
      policyType: 'Property Package',
      policyNumber: '37SBACB6KKB',
      deductible: 25_000,
      coverageLimit: null,
    });
    const res = await makeApp(db).request('/');
    expect(res.status).toBe(200);
    const report = InsuranceLossReport.parse(await res.json());
    expect(report.deductibleReviews[0]?.decSource).toBe('placeholder');
  });
});
