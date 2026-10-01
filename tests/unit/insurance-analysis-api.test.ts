// @vitest-environment node
//
// tests/unit/insurance-analysis-api.test.ts
//
// buildInsuranceAnalysis read-path hardening (refute wf_0ef2e213-4e2 follow-up). SQLite column
// affinities are not constraints: a raw-SQL write can leave an integer, a BLOB or a numeric date in
// any property_insurance_policies TEXT column. The importer rejects such values, so only raw SQL can
// create them — but before this fix one such row made `policy_type.trim()` throw inside
// collapseToCurrentTerm, 500ing BOTH routes that run the engine:
//   GET /api/warehouse/insurance        (insurance-analysis-api.ts)
//   GET /api/warehouse/insurance/loss   (insurance-loss-api.ts — buildInsuranceAnalysis runs first)
// In-memory better-sqlite3 + runMigrations — never touches data/warehouse/finance.sqlite.
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../server/warehouse/migrate';
import type { WarehouseDb } from '../../server/warehouse/db';
import { insuranceAnalysisApi } from '../../server/warehouse/insurance-analysis-api';
import { insuranceLossApi } from '../../server/warehouse/insurance-loss-api';
import { buildInsuranceAnalysis } from '../../server/warehouse/insurance-analysis';
import { InsuranceAnalysisReport } from '../../src/contracts/insurance-analysis';
import { InsuranceLossReport } from '../../src/contracts/insurance-loss';

const ASOF = '2026-06-01';

function freshDb(): WarehouseDb {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare('INSERT INTO property_master (id, name) VALUES (?, ?)').run('p1', 'Property One');
  db.prepare('INSERT INTO property_master (id, name) VALUES (?, ?)').run('p2', 'Property Two');
  return db;
}

/** One clean, contract-valid policy row; returns its rowid so a test can corrupt one column. */
function insertPolicy(
  db: WarehouseDb,
  propertyId: string,
  policyNumber: string,
  over: Partial<{ eff: string; exp: string; premium: number; tiv: number; type: string; src: string }> = {},
): number {
  const r = db
    .prepare(
      `INSERT INTO property_insurance_policies
         (property_id, insurer, policy_number, effective_date, expiration_date,
          premium_annual, coverage_tiv, policy_type, source, source_date, ingested_by)
       VALUES (?, 'Test Insurer', ?, ?, ?, ?, ?, ?, 'test-fixture', ?, 'test-runner')`,
    )
    .run(
      propertyId,
      policyNumber,
      over.eff ?? '2026-01-01',
      over.exp ?? '2027-01-01',
      over.premium ?? 5000,
      over.tiv ?? 1_000_000,
      over.type ?? 'Property Package',
      over.src ?? '2026-05-01',
    );
  return Number(r.lastInsertRowid);
}

/** Raw-SQL corruption: the ONLY way these values reach the table (the importer rejects them). */
function corrupt(db: WarehouseDb, id: number, column: string, sqlValue: string): void {
  db.exec(`UPDATE property_insurance_policies SET ${column} = ${sqlValue} WHERE id = ${id}`);
}

// Each case is one raw-SQL write the engine used to trust. Every non-rowid column is covered.
const CASES: Array<[string, string]> = [
  ['policy_type', '42'],
  ['policy_type', "X'41'"],
  ['property_id', '7'],
  ['property_id', "X'7031'"],
  ['insurer', "X'41'"],
  ['policy_number', '12345'],
  ['policy_number', "X'41'"],
  ['effective_date', '20260101'],
  ['effective_date', "X'41'"],
  ['expiration_date', '1717200000'],
  ['expiration_date', "X'41'"],
  ['source_date', '20260501'],
  ['source_date', "X'41'"],
  ['premium_annual', "X'41'"],
  ['premium_annual', "'abc'"],
  ['coverage_tiv', "X'41'"],
  ['coverage_tiv', "'abc'"],
];

describe('GET /api/warehouse/insurance — raw-SQL non-string / non-numeric policy columns', () => {
  for (const [column, value] of CASES) {
    it(`${column} = ${value} → contract-valid 200, not a 500`, async () => {
      const db = freshDb();
      insertPolicy(db, 'p1', 'POL-1');
      const bad = insertPolicy(db, 'p2', 'POL-2');
      corrupt(db, bad, column, value);
      const res = await insuranceAnalysisApi(() => db).request('/');
      expect(res.status).toBe(200);
      const body = InsuranceAnalysisReport.parse(await res.json());
      // The clean row is never lost to its corrupted neighbour.
      expect(body.policiesN).toBeGreaterThanOrEqual(1);
    });
  }
});

describe('GET /api/warehouse/insurance/loss — buildInsuranceAnalysis runs first on this route', () => {
  const LOSS_CASES: Array<[string, string]> = [
    ['policy_type', '42'],
    ['policy_type', "X'41'"],
    ['effective_date', '20260101'],
    ['property_id', "X'7031'"],
  ];
  for (const [column, value] of LOSS_CASES) {
    it(`${column} = ${value} → contract-valid 200, not a 500`, async () => {
      const db = freshDb();
      insertPolicy(db, 'p1', 'POL-1');
      const bad = insertPolicy(db, 'p2', 'POL-2');
      corrupt(db, bad, column, value);
      const res = await insuranceLossApi(() => db).request('/');
      expect(res.status).toBe(200);
      InsuranceLossReport.parse(await res.json());
    });
  }
});

describe('buildInsuranceAnalysis — normalization semantics', () => {
  it('a non-string policy_type reads as blank: the row is kept, never a property-package rate', () => {
    const db = freshDb();
    const bad = insertPolicy(db, 'p2', 'POL-2');
    corrupt(db, bad, 'policy_type', "X'41'");
    const report = buildInsuranceAnalysis(db, ASOF);
    expect(report.policiesN).toBe(1);
    expect(report.renewalCalendar[0]?.cohort).not.toBe('property-package');
  });

  // Ruling (Gabriel, 2026-09-28): a row whose effective_date / expiration_date / source_date holds a
  // present-but-invalid value is KEPT (its loss events must still attach — #398's pinned behavior) and
  // flagged once in data_quality_issues. Its term ranking is deliberately NOT recovered (refute rounds
  // wf_d23d3a9d-381 / wf_269ac84f-c8d: every recovery rule mis-ranked some other shape) — so these
  // tests pin the crash fix + the flag, never which term wins.
  it.each([
    ['effective_date', '1717200000'],
    ['effective_date', "X'41'"],
    ['expiration_date', "'01/01/2027'"],
    ['source_date', "X'41'"],
  ])('a present-but-invalid %s (%s) is kept and flagged once with its policy_id and column', (column, value) => {
    const db = freshDb();
    insertPolicy(db, 'p1', 'POL-1');
    const bad = insertPolicy(db, 'p2', 'POL-2');
    corrupt(db, bad, column, value);
    const report = buildInsuranceAnalysis(db, ASOF);
    expect(report.policiesN).toBe(2);
    const flags = db
      .prepare(`SELECT property_id, detail FROM data_quality_issues WHERE kind = 'insurance-policy-bad-date' AND status = 'open'`)
      .all() as Array<{ property_id: string | null; detail: string }>;
    expect(flags).toHaveLength(1);
    expect(flags[0]!.property_id).toBe('p2');
    expect(flags[0]!.detail).toContain(`policy_id=${bad} `);
    expect(flags[0]!.detail).toContain(column);
  });

  it.each([["'2026-01-01 '"], ["'2026-01-01T00:00:00Z'"], ["'2026-02-30'"]])(
    'a near-valid %s (leading YYYY-MM-DD, not the importer-strict form) is flagged',
    (value) => {
      const db = freshDb();
      const id = insertPolicy(db, 'p1', 'POL-1');
      corrupt(db, id, 'effective_date', value);
      buildInsuranceAnalysis(db, ASOF);
      const n = db
        .prepare(`SELECT count(*) AS c FROM data_quality_issues WHERE kind = 'insurance-policy-bad-date'`)
        .get() as { c: number };
      expect(n.c).toBe(1);
    },
  );

  it('the open-flag guard does not confuse policy_id=1 with policy_id=10', () => {
    const db = freshDb();
    const ids = Array.from({ length: 10 }, (_, i) => insertPolicy(db, 'p1', `POL-${i + 1}`));
    expect(ids[0]).toBe(1);
    expect(ids[9]).toBe(10);
    corrupt(db, 10, 'source_date', "X'41'");
    buildInsuranceAnalysis(db, ASOF); // flags policy_id=10 only
    corrupt(db, 1, 'source_date', "X'41'");
    buildInsuranceAnalysis(db, ASOF); // policy_id=1 must still get its own flag
    const details = (
      db.prepare(`SELECT detail FROM data_quality_issues WHERE kind = 'insurance-policy-bad-date'`).all() as Array<{
        detail: string;
      }>
    ).map((r) => r.detail.split(' ')[0]);
    expect(details.sort()).toEqual(['policy_id=1', 'policy_id=10']);
  });

  it('GET / on a rebid-sized book with a corrupt candidate still logs every rebid verdict (fingerprint + identity paths, not masked by fail-open)', async () => {
    const db = freshDb();
    // Six property-package policies at one TIV, so the cohort (MIN_COHORT_N=5) yields rebid candidates.
    const premiums = [10_000, 12_000, 15_000, 18_000, 20_000, 30_000];
    const ids = premiums.map((premium, i) => {
      db.prepare('INSERT OR IGNORE INTO property_master (id, name) VALUES (?, ?)').run(`c${i}`, `Cohort ${i}`);
      return insertPolicy(db, `c${i}`, `POL-C${i}`, { premium, tiv: 5_000_000, exp: '2027-06-01' });
    });
    corrupt(db, ids[5]!, 'effective_date', "X'41'"); // the highest-premium (a rebid) candidate
    const res = await insuranceAnalysisApi(() => db).request('/');
    expect(res.status).toBe(200);
    const body = InsuranceAnalysisReport.parse(await res.json());
    expect(body.rebidCandidates.length).toBeGreaterThan(0);
    const n = (
      db.prepare("SELECT COUNT(*) AS n FROM calibration_verdict WHERE verdict_kind = 'insurance-rebid'").get() as {
        n: number;
      }
    ).n;
    expect(n).toBe(body.rebidCandidates.length);
  });

  it('a clean book writes no bad-date flag', () => {
    const db = freshDb();
    insertPolicy(db, 'p1', 'POL-1');
    buildInsuranceAnalysis(db, ASOF);
    const n = db
      .prepare(`SELECT count(*) AS c FROM data_quality_issues WHERE kind = 'insurance-policy-bad-date'`)
      .get() as { c: number };
    expect(n.c).toBe(0);
  });

  it('the bad-date flag is written once per policy, not on every GET', () => {
    const db = freshDb();
    const bad = insertPolicy(db, 'p1', 'POL-1');
    corrupt(db, bad, 'expiration_date', "X'41'");
    buildInsuranceAnalysis(db, ASOF);
    buildInsuranceAnalysis(db, ASOF);
    const n = db
      .prepare(`SELECT count(*) AS c FROM data_quality_issues WHERE kind = 'insurance-policy-bad-date'`)
      .get() as { c: number };
    expect(n.c).toBe(1);
  });

  it('a NULL date is a legitimate "not captured", not corruption: kept, never flagged', () => {
    const db = freshDb();
    const id = insertPolicy(db, 'p1', 'POL-1');
    corrupt(db, id, 'expiration_date', 'NULL');
    const report = buildInsuranceAnalysis(db, ASOF);
    expect(report.policiesN).toBe(1);
    const n = db
      .prepare(`SELECT count(*) AS c FROM data_quality_issues WHERE kind = 'insurance-policy-bad-date'`)
      .get() as { c: number };
    expect(n.c).toBe(0);
  });

  it('a BLOB premium/TIV reads as null (premium 0, TIV unknown), never NaN in the totals', () => {
    const db = freshDb();
    insertPolicy(db, 'p1', 'POL-1', { premium: 5000 });
    const bad = insertPolicy(db, 'p2', 'POL-2');
    corrupt(db, bad, 'premium_annual', "X'41'");
    corrupt(db, bad, 'coverage_tiv', "X'41'");
    const report = buildInsuranceAnalysis(db, ASOF);
    expect(report.premiumAnnualTotal).toBe(5000);
    expect(report.tivKnownN).toBe(1);
  });

  it('valid data: collapse ordering is unchanged (newer source_date wins a same-term reissue)', () => {
    const db = freshDb();
    insertPolicy(db, 'p1', 'POL-A', { premium: 4000, src: '2026-04-01' });
    insertPolicy(db, 'p1', 'POL-B', { premium: 6000, src: '2026-05-01' });
    const report = buildInsuranceAnalysis(db, ASOF);
    expect(report.policiesN).toBe(1);
    expect(report.renewalCalendar[0]?.premium).toBe(6000);
  });
});
