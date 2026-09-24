// @vitest-environment node
//
// tests/unit/insurance-analysis.test.ts
//
// Phase 4a.3 — Insurance reasoning layer: buildInsuranceAnalysis() + logRebidVerdicts().
// In-memory SQLite (architecture/coding-standards.md pattern) — never touches
// data/warehouse/finance.sqlite. No mocking — real schema, real reads.
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../server/warehouse/migrate';
import type { WarehouseDb } from '../../server/warehouse/db';
import { buildInsuranceAnalysis, logRebidVerdicts } from '../../server/warehouse/insurance-analysis';
import { InsuranceAnalysisReport } from '../../src/contracts/insurance-analysis';

const AS_OF = '2026-07-06';

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
  policyNumber?: string | null;
  effectiveDate?: string | null;
  expirationDate?: string | null;
  premiumAnnual?: number | null;
  coverageTiv?: number | null;
  policyType: string;
  insurer?: string;
  sourceDate?: string;
}

function insertPolicy(db: WarehouseDb, f: PolicyFixture): void {
  db.prepare(
    `INSERT INTO property_insurance_policies
       (property_id, insurer, policy_number, effective_date, expiration_date,
        premium_annual, coverage_tiv, policy_type, source, source_date, ingested_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    f.propertyId,
    f.insurer ?? 'Test Insurer',
    f.policyNumber ?? null,
    f.effectiveDate ?? null,
    f.expirationDate ?? null,
    f.premiumAnnual ?? null,
    f.coverageTiv ?? null,
    f.policyType,
    'test-fixture',
    f.sourceDate ?? '2026-06-01',
    'test-runner',
  );
}

/** Add days to an ISO date string and return an ISO date string (UTC, mirrors insurance-conditions.test.ts). */
function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

describe('buildInsuranceAnalysis — empty book', () => {
  it('returns a fully-empty, contract-valid report', () => {
    const db = freshDb();
    const report = buildInsuranceAnalysis(db, AS_OF);

    expect(report.policiesN).toBe(0);
    expect(report.tivKnownN).toBe(0);
    expect(report.premiumAnnualTotal).toBe(0);
    expect(report.benchmark.cohortN).toBe(0);
    expect(report.benchmark.sufficient).toBe(false);
    expect(report.benchmark.medianRatePer100Tiv).toBeNull();
    expect(report.benchmark.basisNote).toBe('own-book median — dispersion, not market rate');
    expect(report.rebidCandidates).toEqual([]);
    expect(report.renewalCalendar).toEqual([]);
    expect(report.advisoryOnly).toBe(true);
    expect(() => InsuranceAnalysisReport.parse(report)).not.toThrow();
  });
});

describe('buildInsuranceAnalysis — single policy (insufficient cohort)', () => {
  it('benchmark is insufficient/null and the lone policy carries no excess', () => {
    const db = freshDb();
    insertPolicy(db, {
      propertyId: 'p-solo',
      policyType: 'Property',
      premiumAnnual: 5_000,
      coverageTiv: 2_000_000,
    });

    const report = buildInsuranceAnalysis(db, AS_OF);

    expect(report.policiesN).toBe(1);
    expect(report.benchmark.cohortN).toBe(1); // one property-package policy with a non-null rate
    expect(report.benchmark.sufficient).toBe(false); // 1 < MIN_COHORT_N (5)
    expect(report.benchmark.medianRatePer100Tiv).toBeNull();
    expect(report.rebidCandidates).toEqual([]);

    const policy = report.renewalCalendar.find((p) => p.propertyId === 'p-solo');
    expect(policy?.cohort).toBe('property-package');
    expect(policy?.ratePer100Tiv).toBeCloseTo(0.25, 6); // 5000 / 2,000,000 * 100
    expect(policy?.excessPremiumVsMedian).toBeNull(); // benchmark insufficient -> never computed
  });
});

describe('buildInsuranceAnalysis — 6-policy property-package cohort (hand-verified)', () => {
  // Fixture: 6 property-package policies, all TIV=$10,000,000, premiums chosen so
  // ratePer100Tiv = premium / tiv * 100 lands on round numbers:
  //   p-a: premium 10,000 -> rate 0.10   p-d: premium 18,000 -> rate 0.18
  //   p-b: premium 12,000 -> rate 0.12   p-e: premium 20,000 -> rate 0.20
  //   p-c: premium 15,000 -> rate 0.15   p-f: premium 30,000 -> rate 0.30
  // Sorted rates: [0.10, 0.12, 0.15, 0.18, 0.20, 0.30] -> n=6 (even) -> median = avg(0.15, 0.18) = 0.165.
  // excessPremiumVsMedian = (rate - median) / 100 * tiv (tiv = 10,000,000, so /100*tiv = *100,000):
  //   p-a: (0.10 - 0.165) * 100,000 = -6,500     p-d: (0.18 - 0.165) * 100,000 =  1,500
  //   p-b: (0.12 - 0.165) * 100,000 = -4,500     p-e: (0.20 - 0.165) * 100,000 =  3,500
  //   p-c: (0.15 - 0.165) * 100,000 = -1,500     p-f: (0.30 - 0.165) * 100,000 = 13,500
  // rebidCandidates (excess > 0), sorted desc: p-f (13,500), p-e (3,500), p-d (1,500).
  // premiumAnnualTotal = 10,000+12,000+15,000+18,000+20,000+30,000 = 105,000.
  const RATES: Array<{ id: string; name: string; premium: number }> = [
    { id: 'p-a', name: 'Property A', premium: 10_000 },
    { id: 'p-b', name: 'Property B', premium: 12_000 },
    { id: 'p-c', name: 'Property C', premium: 15_000 },
    { id: 'p-d', name: 'Property D', premium: 18_000 },
    { id: 'p-e', name: 'Property E', premium: 20_000 },
    { id: 'p-f', name: 'Property F', premium: 30_000 },
  ];
  const TIV = 10_000_000;

  function seedCohort(db: WarehouseDb): void {
    for (const r of RATES) {
      seedProperty(db, r.id, r.name);
      insertPolicy(db, {
        propertyId: r.id,
        policyType: 'Property Package',
        premiumAnnual: r.premium,
        coverageTiv: TIV,
      });
    }
  }

  it('computes the correct median, cohortN, and excess for every policy', () => {
    const db = freshDb();
    seedCohort(db);

    const report = buildInsuranceAnalysis(db, AS_OF);

    expect(report.policiesN).toBe(6);
    expect(report.tivKnownN).toBe(6);
    expect(report.premiumAnnualTotal).toBeCloseTo(105_000, 2);
    expect(report.benchmark.cohortN).toBe(6);
    expect(report.benchmark.sufficient).toBe(true);
    expect(report.benchmark.medianRatePer100Tiv).toBeCloseTo(0.165, 6);

    const byId = new Map(report.renewalCalendar.map((p) => [p.propertyId, p]));
    expect(byId.get('p-a')?.excessPremiumVsMedian).toBeCloseTo(-6_500, 2);
    expect(byId.get('p-b')?.excessPremiumVsMedian).toBeCloseTo(-4_500, 2);
    expect(byId.get('p-c')?.excessPremiumVsMedian).toBeCloseTo(-1_500, 2);
    expect(byId.get('p-d')?.excessPremiumVsMedian).toBeCloseTo(1_500, 2);
    expect(byId.get('p-e')?.excessPremiumVsMedian).toBeCloseTo(3_500, 2);
    expect(byId.get('p-f')?.excessPremiumVsMedian).toBeCloseTo(13_500, 2);
  });

  it('rebidCandidates holds only the excess>0 policies, sorted desc, with resolved property names', () => {
    const db = freshDb();
    seedCohort(db);

    const report = buildInsuranceAnalysis(db, AS_OF);

    expect(report.rebidCandidates.map((p) => p.propertyId)).toEqual(['p-f', 'p-e', 'p-d']);
    expect(report.rebidCandidates[0]?.excessPremiumVsMedian).toBeCloseTo(13_500, 2);
    expect(report.rebidCandidates[0]?.property).toBe('Property F');
    expect(report.rebidCandidates[1]?.excessPremiumVsMedian).toBeCloseTo(3_500, 2);
    expect(report.rebidCandidates[2]?.excessPremiumVsMedian).toBeCloseTo(1_500, 2);
  });

  it('the full report parses through the InsuranceAnalysisReport Zod contract', () => {
    const db = freshDb();
    seedCohort(db);
    const report = buildInsuranceAnalysis(db, AS_OF);
    expect(() => InsuranceAnalysisReport.parse(report)).not.toThrow();
  });
});

describe('buildInsuranceAnalysis — all-null TIV', () => {
  it('excludes every policy from rate math regardless of policy_type; tivKnownN is 0', () => {
    const db = freshDb();
    insertPolicy(db, { propertyId: 'p-null-1', policyType: 'Property', premiumAnnual: 1_000, coverageTiv: null });
    insertPolicy(db, { propertyId: 'p-null-2', policyType: 'Auto', premiumAnnual: 2_000, coverageTiv: null });
    insertPolicy(db, { propertyId: 'p-null-3', policyType: 'Property Package', premiumAnnual: 3_000, coverageTiv: 0 });

    const report = buildInsuranceAnalysis(db, AS_OF);

    expect(report.policiesN).toBe(3);
    expect(report.tivKnownN).toBe(0);
    expect(report.benchmark.cohortN).toBe(0);
    expect(report.benchmark.sufficient).toBe(false);
    expect(report.benchmark.medianRatePer100Tiv).toBeNull();
    expect(report.rebidCandidates).toEqual([]);
    // Still listed so the register stays complete.
    expect(report.renewalCalendar).toHaveLength(3);
    for (const p of report.renewalCalendar) {
      expect(p.cohort).toBe('excluded-null-tiv');
      expect(p.ratePer100Tiv).toBeNull();
      expect(p.excessPremiumVsMedian).toBeNull();
    }
  });
});

describe('buildInsuranceAnalysis — renewal buckets', () => {
  it('buckets now-45 / soon-90 / later / expired / unknown correctly and sorts soonest-first', () => {
    const db = freshDb();
    insertPolicy(db, { propertyId: 'p-r5-expired', policyType: 'Other', expirationDate: addDays(AS_OF, -10) });
    insertPolicy(db, { propertyId: 'p-r1-now45', policyType: 'Other', expirationDate: addDays(AS_OF, 10) });
    insertPolicy(db, { propertyId: 'p-r2-now45-boundary', policyType: 'Other', expirationDate: addDays(AS_OF, 45) });
    insertPolicy(db, { propertyId: 'p-r3-soon90', policyType: 'Other', expirationDate: addDays(AS_OF, 60) });
    insertPolicy(db, { propertyId: 'p-r4-later', policyType: 'Other', expirationDate: addDays(AS_OF, 200) });
    insertPolicy(db, { propertyId: 'p-r6-unknown', policyType: 'Other', expirationDate: null });

    const report = buildInsuranceAnalysis(db, AS_OF);
    const byId = new Map(report.renewalCalendar.map((p) => [p.propertyId, p]));

    expect(byId.get('p-r5-expired')?.renewalBucket).toBe('expired');
    expect(byId.get('p-r5-expired')?.daysToExpiry).toBe(-10);
    expect(byId.get('p-r1-now45')?.renewalBucket).toBe('now-45');
    expect(byId.get('p-r1-now45')?.daysToExpiry).toBe(10);
    expect(byId.get('p-r2-now45-boundary')?.renewalBucket).toBe('now-45'); // <=45 boundary
    expect(byId.get('p-r2-now45-boundary')?.daysToExpiry).toBe(45);
    expect(byId.get('p-r3-soon90')?.renewalBucket).toBe('soon-90');
    expect(byId.get('p-r3-soon90')?.daysToExpiry).toBe(60);
    expect(byId.get('p-r4-later')?.renewalBucket).toBe('later');
    expect(byId.get('p-r4-later')?.daysToExpiry).toBe(200);
    expect(byId.get('p-r6-unknown')?.renewalBucket).toBe('unknown');
    expect(byId.get('p-r6-unknown')?.daysToExpiry).toBeNull();

    // Soonest-first, with unknown (null) pushed to the end.
    expect(report.renewalCalendar.map((p) => p.propertyId)).toEqual([
      'p-r5-expired', 'p-r1-now45', 'p-r2-now45-boundary', 'p-r3-soon90', 'p-r4-later', 'p-r6-unknown',
    ]);
  });
});

describe('logRebidVerdicts — calibration logging', () => {
  const TIV = 10_000_000;

  function seedCohortWithRebids(db: WarehouseDb): void {
    // Same 6-policy cohort as above — p-d/p-e/p-f are the 3 rebid candidates
    // (excess 1,500 / 3,500 / 13,500 respectively; see the hand-worked comment above).
    for (const [id, premium] of [
      ['p-a', 10_000], ['p-b', 12_000], ['p-c', 15_000],
      ['p-d', 18_000], ['p-e', 20_000], ['p-f', 30_000],
    ] as const) {
      insertPolicy(db, { propertyId: id, policyType: 'Property Package', premiumAnnual: premium, coverageTiv: TIV });
    }
  }

  it('writes one calibration_verdict row per rebid candidate — not just a no-throw', () => {
    const db = freshDb();
    seedCohortWithRebids(db);
    const report = buildInsuranceAnalysis(db, AS_OF);
    expect(report.rebidCandidates).toHaveLength(3);

    const result = logRebidVerdicts(db, report);
    expect(result.error).toBeUndefined();
    expect(result.written).toBe(3);

    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM calibration_verdict WHERE verdict_kind = 'insurance-rebid'").get() as {
        n: number;
      }
    ).n;
    expect(count).toBeGreaterThan(0);
    expect(count).toBe(3);
  });

  it('logs correct subject_kind / verdict_engine / predicted_band across all three excess bands', () => {
    const db = freshDb();
    seedCohortWithRebids(db);
    const report = buildInsuranceAnalysis(db, AS_OF);
    logRebidVerdicts(db, report);

    const rows = db
      .prepare(
        `SELECT subject_kind, subject_id, verdict_engine, predicted_band, predicted_value, verdict_subkind
         FROM calibration_verdict WHERE verdict_kind = 'insurance-rebid' ORDER BY predicted_value DESC`,
      )
      .all() as Array<{
      subject_kind: string;
      subject_id: string;
      verdict_engine: string;
      predicted_band: string;
      predicted_value: number;
      verdict_subkind: string;
    }>;

    expect(rows).toHaveLength(3);
    for (const r of rows) {
      expect(r.subject_kind).toBe('property');
      expect(r.verdict_engine).toBe('insurance-analysis');
    }
    expect(rows[0]?.subject_id).toBe('p-f');
    expect(rows[0]?.predicted_band).toBe('excess-gt-10k'); // 13,500 > 10,000
    expect(rows[0]?.predicted_value).toBeCloseTo(13_500, 2);
    expect(rows[1]?.subject_id).toBe('p-e');
    expect(rows[1]?.predicted_band).toBe('excess-2k-10k'); // 3,500 in [2,000, 10,000]
    expect(rows[1]?.predicted_value).toBeCloseTo(3_500, 2);
    expect(rows[2]?.subject_id).toBe('p-d');
    expect(rows[2]?.predicted_band).toBe('excess-lt-2k'); // 1,500 < 2,000
    expect(rows[2]?.predicted_value).toBeCloseTo(1_500, 2);

    // Distinct verdict_subkind per policy — the policy id inside the dedup_key — proves several
    // rebid verdicts sharing one verdict_kind never collapse to one dedup_key (D3 collision class).
    const subkinds = new Set(rows.map((r) => r.verdict_subkind));
    expect(subkinds.size).toBe(3);
  });

  it('is idempotent on a second call against an unchanged book (no duplicate rows)', () => {
    const db = freshDb();
    seedCohortWithRebids(db);
    const report = buildInsuranceAnalysis(db, AS_OF);

    const first = logRebidVerdicts(db, report);
    expect(first.written).toBe(3);
    const second = logRebidVerdicts(db, report);
    expect(second.written).toBe(0);
    expect(second.skipped).toBe(3);

    const count = (
      db.prepare("SELECT COUNT(*) AS n FROM calibration_verdict WHERE verdict_kind = 'insurance-rebid'").get() as {
        n: number;
      }
    ).n;
    expect(count).toBe(3);
  });

  it('does not throw when the book has no rebid candidates (empty verdict set)', () => {
    const db = freshDb();
    insertPolicy(db, { propertyId: 'p-solo', policyType: 'Property', premiumAnnual: 5_000, coverageTiv: 2_000_000 });
    const report = buildInsuranceAnalysis(db, AS_OF);
    expect(report.rebidCandidates).toEqual([]);

    const result = logRebidVerdicts(db, report);
    expect(result.error).toBeUndefined();
    expect(result.written).toBe(0);
  });
});

describe('buildInsuranceAnalysis — cross-cohort basis discipline (refute F1)', () => {
  // Fixture: 5 property-package policies (a sufficient cohort) + 1 Flood ('other' cohort) with a
  // perfectly valid TIV — the hostile reviewers' exact repro. All TIV = $10,000,000.
  //   package rates: 0.10, 0.12, 0.15, 0.20, 0.30 -> n=5 (odd) -> median = 0.15.
  //   package excess vs 0.15 (per $10M TIV: *100,000): -5,000 / -3,000 / 0 / +5,000 / +15,000.
  //   rebidCandidates (excess > 0, desc): p-5 (+15,000), p-4 (+5,000). p-3 is exactly 0 -> excluded.
  //   Flood: premium 100,000 -> rate 1.0. Unfixed engine scored it (1.0-0.15)*100,000 = +85,000
  //   and ranked it #1; fixed engine gives it excess null (cross-cohort, never scored).
  const TIV = 10_000_000;

  function seedMixedBook(db: WarehouseDb): void {
    for (const [id, premium] of [
      ['p-1', 10_000], ['p-2', 12_000], ['p-3', 15_000], ['p-4', 20_000], ['p-5', 30_000],
    ] as const) {
      insertPolicy(db, { propertyId: id, policyType: 'Property Package', premiumAnnual: premium, coverageTiv: TIV });
    }
    insertPolicy(db, { propertyId: 'p-flood', policyType: 'Flood', premiumAnnual: 100_000, coverageTiv: TIV });
  }

  it("an 'other'-cohort policy with valid TIV gets null excess and never enters rebidCandidates", () => {
    const db = freshDb();
    seedMixedBook(db);

    const report = buildInsuranceAnalysis(db, AS_OF);

    // The flood policy never contaminates the benchmark cohort...
    expect(report.benchmark.cohortN).toBe(5);
    expect(report.benchmark.sufficient).toBe(true);
    expect(report.benchmark.medianRatePer100Tiv).toBeCloseTo(0.15, 6);

    // ...its own rate is still real per-policy data (rate math is per-policy, cohort-agnostic)...
    const flood = report.renewalCalendar.find((p) => p.propertyId === 'p-flood');
    expect(flood?.cohort).toBe('other');
    expect(flood?.ratePer100Tiv).toBeCloseTo(1.0, 6);
    // ...but it is NEVER scored against the property-package median (cross-cohort basis mismatch).
    expect(flood?.excessPremiumVsMedian).toBeNull();

    // Worklist holds only in-cohort outliers — the flood policy would have ranked #1 (+85,000).
    expect(report.rebidCandidates.map((p) => p.propertyId)).toEqual(['p-5', 'p-4']);
    expect(report.rebidCandidates[0]?.excessPremiumVsMedian).toBeCloseTo(15_000, 2);
    expect(report.rebidCandidates[1]?.excessPremiumVsMedian).toBeCloseTo(5_000, 2);

    // Still listed everywhere the register needs it.
    expect(report.policiesN).toBe(6);
    expect(report.renewalCalendar).toHaveLength(6);
  });

  it("never logs an insurance-rebid verdict for an 'other'-cohort policy", () => {
    const db = freshDb();
    seedMixedBook(db);
    const report = buildInsuranceAnalysis(db, AS_OF);

    const result = logRebidVerdicts(db, report);
    expect(result.error).toBeUndefined();
    expect(result.written).toBe(2);

    const subjects = (
      db.prepare("SELECT subject_id FROM calibration_verdict WHERE verdict_kind = 'insurance-rebid'").all() as Array<{
        subject_id: string;
      }>
    ).map((r) => r.subject_id);
    expect(subjects).not.toContain('p-flood');
    expect(new Set(subjects)).toEqual(new Set(['p-5', 'p-4']));
  });
});

describe('buildInsuranceAnalysis — null-keyed policies are never collapsed (refute F2)', () => {
  // Fixture: 4 property-package singles + TWO genuinely distinct policies on ONE property that
  // both have NULL policy_number AND NULL effective_date (no identifying key). All TIV = $10,000,000.
  //   rates: 0.10, 0.12, 0.15 | 0.18 + 0.30 (the two null-keyed on p-dup) | 0.20
  //   sorted: [0.10, 0.12, 0.15, 0.18, 0.20, 0.30] -> n=6 -> median = avg(0.15, 0.18) = 0.165.
  //   premiumAnnualTotal = 10k+12k+15k+18k+20k+30k = 105,000.
  //   rebid excess (desc): 30k -> +13,500; 20k -> +3,500; 18k -> +1,500.
  // The unfixed engine collapsed the two p-dup rows to whichever was inserted LAST, flipping the
  // median/total/worklist with insertion order.
  const TIV = 10_000_000;
  const SINGLES: ReadonlyArray<readonly [string, number]> = [
    ['p-a', 10_000], ['p-b', 12_000], ['p-c', 15_000], ['p-d', 20_000],
  ];

  function buildWithOrder(dupPremiumsInOrder: readonly number[]): ReturnType<typeof buildInsuranceAnalysis> {
    const db = freshDb();
    for (const [id, premium] of SINGLES) {
      insertPolicy(db, { propertyId: id, policyType: 'Property Package', premiumAnnual: premium, coverageTiv: TIV });
    }
    for (const premium of dupPremiumsInOrder) {
      insertPolicy(db, {
        propertyId: 'p-dup',
        policyType: 'Property Package',
        premiumAnnual: premium,
        coverageTiv: TIV,
        policyNumber: null,
        effectiveDate: null,
      });
    }
    return buildInsuranceAnalysis(db, AS_OF);
  }

  it('both distinct null-keyed policies survive and results are identical for both insertion orders', () => {
    for (const order of [[18_000, 30_000], [30_000, 18_000]] as const) {
      const report = buildWithOrder(order);

      // Both rows survive — nothing silently dropped.
      expect(report.policiesN).toBe(6);
      const dupRows = report.renewalCalendar.filter((p) => p.propertyId === 'p-dup');
      expect(dupRows).toHaveLength(2);
      expect(new Set(dupRows.map((p) => p.premium))).toEqual(new Set([18_000, 30_000]));

      // Order-independent book statistics (the unfixed engine flipped median 0.30 vs 0.20-class
      // results with insertion order).
      expect(report.benchmark.cohortN).toBe(6);
      expect(report.benchmark.medianRatePer100Tiv).toBeCloseTo(0.165, 6);
      expect(report.premiumAnnualTotal).toBeCloseTo(105_000, 2);

      // Order-independent worklist (identified by premium — row ids differ across orders).
      expect(report.rebidCandidates.map((p) => p.premium)).toEqual([30_000, 20_000, 18_000]);
      expect(report.rebidCandidates[0]?.excessPremiumVsMedian).toBeCloseTo(13_500, 2);
      expect(report.rebidCandidates[1]?.excessPremiumVsMedian).toBeCloseTo(3_500, 2);
      expect(report.rebidCandidates[2]?.excessPremiumVsMedian).toBeCloseTo(1_500, 2);
    }
  });
});

describe('buildInsuranceAnalysis — deterministic total-order sorts (refute F3)', () => {
  const TIV = 10_000_000;

  it('equal-excess rebid candidates tiebreak on policyId for both insertion orders', () => {
    // 4 fillers (rates 0.10/0.12/0.15/0.20) + two IDENTICAL 30k policies on p-x and p-y.
    //   sorted rates: [0.10, 0.12, 0.15, 0.20, 0.30, 0.30] -> median = avg(0.15, 0.20) = 0.175.
    //   excess: 30k -> (0.30-0.175)*100,000 = +12,500 (BOTH — an exact tie); 20k -> +2,500.
    for (const pair of [['p-x', 'p-y'], ['p-y', 'p-x']] as const) {
      const db = freshDb();
      for (const [id, premium] of [
        ['p-a', 10_000], ['p-b', 12_000], ['p-c', 15_000], ['p-d', 20_000],
      ] as const) {
        insertPolicy(db, { propertyId: id, policyType: 'Property Package', premiumAnnual: premium, coverageTiv: TIV });
      }
      for (const id of pair) {
        insertPolicy(db, { propertyId: id, policyType: 'Property Package', premiumAnnual: 30_000, coverageTiv: TIV });
      }

      const report = buildInsuranceAnalysis(db, AS_OF);

      expect(report.rebidCandidates.map((p) => p.premium)).toEqual([30_000, 30_000, 20_000]);
      const first = report.rebidCandidates[0];
      const second = report.rebidCandidates[1];
      expect(first?.excessPremiumVsMedian).toBeCloseTo(12_500, 2);
      expect(second?.excessPremiumVsMedian).toBeCloseTo(12_500, 2);
      // The tie resolves on policyId (string compare) — never on insert order.
      expect(first?.policyId.localeCompare(second?.policyId ?? '')).toBeLessThan(0);
    }
  });

  it('renewalCalendar orders null-vs-null daysToExpiry by policyId (total order, no NaN comparator)', () => {
    const db = freshDb();
    insertPolicy(db, { propertyId: 'p-u1', policyType: 'Other', expirationDate: null });
    insertPolicy(db, { propertyId: 'p-u2', policyType: 'Other', expirationDate: null });
    insertPolicy(db, { propertyId: 'p-dated', policyType: 'Other', expirationDate: addDays(AS_OF, 30) });
    insertPolicy(db, { propertyId: 'p-u3', policyType: 'Other', expirationDate: null });

    const report = buildInsuranceAnalysis(db, AS_OF);

    // Dated policy first; the three unknowns follow in policyId order.
    expect(report.renewalCalendar[0]?.propertyId).toBe('p-dated');
    const unknownIds = report.renewalCalendar.slice(1).map((p) => p.policyId);
    expect(unknownIds).toEqual([...unknownIds].sort((a, b) => a.localeCompare(b)));
    expect(report.renewalCalendar.slice(1).every((p) => p.renewalBucket === 'unknown')).toBe(true);
  });
});

describe('dedupeLatest — re-ingest dedup for null-keyed policies (refute F2 correction)', () => {
  // Regression for the HIGH regression the F2 fix itself introduced: keying null-keyed rows on
  // physical row id (instead of content) stopped collapsing a policy re-persisted on every
  // workbook refresh (server 'snapshot' event -> captureInsurance's INSERT OR REPLACE does NOT
  // dedupe null policy_number/effective_date — SQLite treats each NULL as distinct), so the SAME
  // logical policy accumulated a new physical row on every refresh. This is the reviewers' exact
  // repro shape: 5 real singles + 1 null-keyed policy "re-ingested" 3 times (same content, as a
  // real re-ingest of unchanged source data would produce) must collapse to ONE row, not three.
  //
  // Fixture: rates 0.10/0.12/0.15/0.18/0.20 (singles) + 0.30 (the re-ingested dup) on TIV=$10M ->
  // sorted [0.10,0.12,0.15,0.18,0.20,0.30] -> median = avg(0.15,0.18) = 0.165 (same numbers as the
  // main 6-policy fixture above, by design, for cross-checking).
  const TIV = 10_000_000;

  it('collapses 3 identical re-ingests of the same null-keyed policy to one row (not a phantom triple)', () => {
    const db = freshDb();
    for (const [id, premium] of [
      ['p-a', 10_000], ['p-b', 12_000], ['p-c', 15_000], ['p-d', 18_000], ['p-e', 20_000],
    ] as const) {
      insertPolicy(db, { propertyId: id, policyType: 'Property Package', premiumAnnual: premium, coverageTiv: TIV });
    }
    // Same logical null-keyed policy, re-ingested 3 times (simulating 3 workbook refreshes) —
    // identical content every time, only source_date advances (as a real re-ingest would produce).
    for (let i = 0; i < 3; i++) {
      insertPolicy(db, {
        propertyId: 'p-dup',
        policyType: 'Property Package',
        premiumAnnual: 30_000,
        coverageTiv: TIV,
        policyNumber: null,
        effectiveDate: null,
        sourceDate: `2026-0${i + 1}-01`,
      });
    }

    const report = buildInsuranceAnalysis(db, AS_OF);

    // 6 logical policies (5 singles + 1 collapsed dup) — NOT 8 (5 + 3 phantom copies).
    expect(report.policiesN).toBe(6);
    // $105,000 — NOT $165,000 (the reviewers' reproduced $60k / 57% phantom overstatement).
    expect(report.premiumAnnualTotal).toBeCloseTo(105_000, 2);
    expect(report.benchmark.cohortN).toBe(6);
    // 0.165 — NOT drifted to ~0.19 by phantom duplicate rates pulling the median up.
    expect(report.benchmark.medianRatePer100Tiv).toBeCloseTo(0.165, 6);

    const dupRows = report.renewalCalendar.filter((p) => p.propertyId === 'p-dup');
    expect(dupRows).toHaveLength(1);
    expect(dupRows[0]?.premium).toBe(30_000);

    // The real $18k rebid candidate must survive — a corrupted median previously pushed it out,
    // while the phantom policy appeared 3x in the worklist instead.
    expect(report.rebidCandidates.map((p) => p.premium)).toEqual([30_000, 20_000, 18_000]);
    expect(report.rebidCandidates.filter((p) => p.propertyId === 'p-dup')).toHaveLength(1);
  });

  it('still keeps two GENUINELY DISTINCT null-keyed policies apart (F2 original fix intact)', () => {
    const db = freshDb();
    // Same content in every field except premium/TIV -> content key differs -> both survive.
    insertPolicy(db, {
      propertyId: 'p-dup2', policyType: 'Property Package', premiumAnnual: 9_000, coverageTiv: TIV,
      policyNumber: null, effectiveDate: null,
    });
    insertPolicy(db, {
      propertyId: 'p-dup2', policyType: 'Property Package', premiumAnnual: 40_000, coverageTiv: TIV,
      policyNumber: null, effectiveDate: null,
    });

    const report = buildInsuranceAnalysis(db, AS_OF);

    const dupRows = report.renewalCalendar.filter((p) => p.propertyId === 'p-dup2');
    expect(dupRows).toHaveLength(2);
    expect(new Set(dupRows.map((p) => p.premium))).toEqual(new Set([9_000, 40_000]));
  });
});

describe('buildInsuranceAnalysis — policy ROLLOVER supersedes the prior term (2026-08-17 bug)', () => {
  // A genuine renewal or correction is a NEW row under the table's
  // UNIQUE(property_id, policy_number, effective_date) key — dedupeLatest's identity key doesn't
  // recognize it as the same logical policy, so the prior term was never superseded and both
  // rows flowed into the "current" view (renewalCalendar/policiesN/premiumAnnualTotal/benchmark).
  // Live repro (2026-08-17): policiesN 34 vs the correct 26; "ins-1900broadway-ufx" showed the
  // OLD 2025-26 term ($11,166, daysToExpiry 10) instead of the 2026-27 rollover ($11,554).
  //
  // REAL-DATA SHAPES (corrected 2026-08-17 after an adversarial refute pass — the original claim
  // "every duplicate is a sequential rollover, old.expiration_date == new.effective_date" was
  // FALSE for 2 of the 8 live groups): (a) sequential rollover — effective_date advances,
  // old.expiration_date == new.effective_date; (b) same-term reissue — effective_date AND
  // expiration_date are IDENTICAL, only policy_number/insurer/premium changed (a carrier
  // renumbering mid-term). Shape (b) can ONLY be resolved by source_date (capture recency) —
  // effective_date is a tie — which is why collapseToCurrentTerm's winner-pick is source_date
  // primary, not max-effective_date.
  it('sequential rollover (shape a): same policy_number, effective_date advances — winner picked by capture recency', () => {
    const db = freshDb();
    // Old 2025-26 term.
    insertPolicy(db, {
      propertyId: 'p-1900broadway',
      policyType: 'Property',
      insurer: 'Unified Fire & Casualty',
      policyNumber: 'Q44-2750780',
      effectiveDate: '2025-08-27',
      expirationDate: '2026-08-27',
      premiumAnnual: 11_166,
      coverageTiv: 4_000_000,
      sourceDate: '2025-09-01',
    });
    // Rolled-over 2026-27 term — new effective_date, same policy_number (a same-number renewal).
    insertPolicy(db, {
      propertyId: 'p-1900broadway',
      policyType: 'Property',
      insurer: 'Unified Fire & Casualty',
      policyNumber: 'Q44-2750780',
      effectiveDate: '2026-08-27',
      expirationDate: '2027-08-27',
      premiumAnnual: 11_554,
      coverageTiv: 4_000_000,
      sourceDate: '2026-08-17',
    });

    const report = buildInsuranceAnalysis(db, AS_OF);

    const rows = report.renewalCalendar.filter((p) => p.propertyId === 'p-1900broadway');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.premium).toBe(11_554);
    expect(report.policiesN).toBe(1);
    expect(report.premiumAnnualTotal).toBeCloseTo(11_554, 2);
  });

  it('sequential rollover (shape a) with a DIFFERENT policy_number: old.expiration_date == new.effective_date still collapses', () => {
    // Unlike the 1900 Broadway fixture above, this pins the "non-overlapping term ranges" branch
    // of sameLineage on its own — no shared policy_number to trigger the identity branch instead.
    const db = freshDb();
    insertPolicy(db, {
      propertyId: 'p-seq', policyType: 'Property', policyNumber: 'SEQ-OLD', premiumAnnual: 4_000,
      coverageTiv: 1_000_000, effectiveDate: '2025-01-01', expirationDate: '2026-01-01', sourceDate: '2025-01-05',
    });
    insertPolicy(db, {
      propertyId: 'p-seq', policyType: 'Property', policyNumber: 'SEQ-NEW', premiumAnnual: 4_200,
      coverageTiv: 1_000_000, effectiveDate: '2026-01-01', expirationDate: '2027-01-01', sourceDate: '2026-01-10',
    });

    const report = buildInsuranceAnalysis(db, AS_OF);

    const rows = report.renewalCalendar.filter((p) => p.propertyId === 'p-seq');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.premium).toBe(4_200);
  });

  it('same-term reissue (shape b, the REAL 9620 State 350 example): identical effective/expiration dates, different policy_number — decided by source_date', () => {
    const db = freshDb();
    insertPolicy(db, {
      propertyId: 'p-9620state350',
      policyType: 'Property',
      insurer: 'XPT Specialty',
      policyNumber: 'MMF17962784',
      effectiveDate: '2025-10-18',
      expirationDate: '2026-10-18',
      premiumAnnual: 28_071,
      coverageTiv: null,
      sourceDate: '2026-08-16',
    });
    // Carrier renumbered/corrected the SAME term — dates unchanged, only policy_number/insurer/
    // premium changed, captured one day later. effective_date is a TIE; only source_date decides.
    insertPolicy(db, {
      propertyId: 'p-9620state350',
      policyType: 'Property',
      insurer: 'Westchester Surplus Lines (Chubb) via XPT Partners',
      policyNumber: 'MMF17962784-002',
      effectiveDate: '2025-10-18',
      expirationDate: '2026-10-18',
      premiumAnnual: 27_609,
      coverageTiv: null,
      sourceDate: '2026-08-17',
    });

    const report = buildInsuranceAnalysis(db, AS_OF);

    const rows = report.renewalCalendar.filter((p) => p.propertyId === 'p-9620state350');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.premium).toBe(27_609);
    expect(rows[0]?.carrier).toBe('Westchester Surplus Lines (Chubb) via XPT Partners');
  });

  it('REGRESSION GUARD: removing the source_date tiebreak would silently restore the stale premium (pins why it is load-bearing)', () => {
    // Same fixture as the shape-(b) test above. If a future edit removed/weakened the source_date
    // ordering (e.g. reverting to max-effective_date-only, which ties here), this assertion would
    // flip to the STALE premium ($28,071) while every other test in this file stayed green —
    // exactly the failure mode an adversarial refute pass found was unpinned.
    const db = freshDb();
    insertPolicy(db, {
      propertyId: 'p-9620-guard', policyType: 'Property', policyNumber: 'MMF-OLD', premiumAnnual: 28_071,
      coverageTiv: null, effectiveDate: '2025-10-18', expirationDate: '2026-10-18', sourceDate: '2026-08-16',
    });
    insertPolicy(db, {
      propertyId: 'p-9620-guard', policyType: 'Property', policyNumber: 'MMF-NEW-002', premiumAnnual: 27_609,
      coverageTiv: null, effectiveDate: '2025-10-18', expirationDate: '2026-10-18', sourceDate: '2026-08-17',
    });

    const report = buildInsuranceAnalysis(db, AS_OF);
    const rows = report.renewalCalendar.filter((p) => p.propertyId === 'p-9620-guard');
    expect(rows[0]?.premium).toBe(27_609);
    expect(rows[0]?.premium).not.toBe(28_071);
  });

  it('a backdated (downward) effective_date CORRECTION is not masked by a stale future-dated capture', () => {
    // Adversarial-refute finding: max-effective_date-first ordering permanently hides a correction
    // that moves effective_date EARLIER (e.g. a typo'd future year fixed) — the stale typo'd row
    // would win forever since no later snapshot can ever re-touch its now-superseded UNIQUE key.
    // source_date-primary ordering (capture recency) resolves this correctly: the correction is
    // captured later, so it wins regardless of which direction effective_date moved.
    const db = freshDb();
    insertPolicy(db, {
      propertyId: 'p-typo', policyType: 'Property', policyNumber: 'TYPO-1', premiumAnnual: 11_166,
      coverageTiv: 4_000_000, effectiveDate: '2027-08-27', expirationDate: '2028-08-27', sourceDate: '2026-08-01',
    });
    // Corrected: the real effective_date, captured later.
    insertPolicy(db, {
      propertyId: 'p-typo', policyType: 'Property', policyNumber: 'TYPO-1', premiumAnnual: 11_554,
      coverageTiv: 4_000_000, effectiveDate: '2026-08-27', expirationDate: '2027-08-27', sourceDate: '2026-08-15',
    });

    const report = buildInsuranceAnalysis(db, AS_OF);

    const rows = report.renewalCalendar.filter((p) => p.propertyId === 'p-typo');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.premium).toBe(11_554);
    expect(rows[0]?.daysToExpiry).toBeLessThan(700); // the corrected 2027-08-27 expiry (~417d out), not the typo'd 2028-08-27 one (~782d out).
  });

  it('does NOT merge two genuinely CONCURRENT policies of the same policy_type with overlapping terms and unrelated policy_number', () => {
    // Adversarial-refute finding: two distinct, simultaneously-in-force policies (e.g. separate
    // buildings on one property) sharing (property_id, policy_type) but with staggered effective
    // dates and no shared policy_number must both survive — sameLineage's overlap check is what
    // protects this from being silently merged into one (which would understate premiumAnnualTotal).
    const db = freshDb();
    insertPolicy(db, {
      propertyId: 'p-concurrent', policyType: 'Property', policyNumber: 'BLDG-A', premiumAnnual: 8_000,
      coverageTiv: 2_000_000, effectiveDate: '2026-01-01', expirationDate: '2027-01-01', sourceDate: '2026-01-05',
    });
    insertPolicy(db, {
      propertyId: 'p-concurrent', policyType: 'Property', policyNumber: 'BLDG-B', premiumAnnual: 6_000,
      coverageTiv: 1_500_000, effectiveDate: '2026-03-01', expirationDate: '2027-03-01', sourceDate: '2026-03-05',
    });

    const report = buildInsuranceAnalysis(db, AS_OF);

    const rows = report.renewalCalendar.filter((p) => p.propertyId === 'p-concurrent');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((p) => p.premium))).toEqual(new Set([8_000, 6_000]));
    expect(report.premiumAnnualTotal).toBeCloseTo(14_000, 2);
  });

  it('FIXED 2026-08-21 (adversarial review finding): does NOT merge two genuinely DISTINCT, unrelated policies of the same type/property whose date ranges do not overlap but are NOT exactly adjacent', () => {
    // Before this fix, sameLineage's non-overlap branch used `<=` (any gap size counted as a
    // rollover), so a cancelled policy years ago and an unrelated later policy — no shared
    // policy_number, no adjacency — silently merged into one cluster and the older row's premium
    // vanished from renewalCalendar/policiesN/premiumAnnualTotal. Tightened to exact adjacency
    // (`===`), matching the only verified real rollover shape (the "old.expiration_date ==
    // new.effective_date" tests above) — a real gap, however small, now correctly falls through
    // to "distinct" and both rows survive.
    const db = freshDb();
    insertPolicy(db, {
      propertyId: 'p-gap', policyType: 'Property', policyNumber: 'GAP-OLD-CANCELLED', premiumAnnual: 5_000,
      coverageTiv: 1_000_000, effectiveDate: '2020-01-01', expirationDate: '2021-01-01', sourceDate: '2020-01-05',
    });
    insertPolicy(db, {
      propertyId: 'p-gap', policyType: 'Property', policyNumber: 'GAP-NEW-UNRELATED', premiumAnnual: 9_000,
      coverageTiv: 1_200_000, effectiveDate: '2026-01-02', expirationDate: '2027-01-02', sourceDate: '2026-01-05',
    });

    const report = buildInsuranceAnalysis(db, AS_OF);

    const rows = report.renewalCalendar.filter((p) => p.propertyId === 'p-gap');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((p) => p.premium))).toEqual(new Set([5_000, 9_000]));
    expect(report.premiumAnnualTotal).toBeCloseTo(14_000, 2);
  });

  it('does not collide two DIFFERENT coverages on the same property (policy_type still partitions)', () => {
    const db = freshDb();
    insertPolicy(db, {
      propertyId: 'p-multi', policyType: 'Property', policyNumber: 'PROP-1', premiumAnnual: 8_000,
      coverageTiv: 3_000_000, effectiveDate: '2026-01-01', sourceDate: '2026-01-05',
    });
    insertPolicy(db, {
      propertyId: 'p-multi', policyType: 'General Liability', policyNumber: 'GL-1', premiumAnnual: 1_500,
      coverageTiv: null, effectiveDate: '2026-01-01', sourceDate: '2026-01-05',
    });

    const report = buildInsuranceAnalysis(db, AS_OF);

    const rows = report.renewalCalendar.filter((p) => p.propertyId === 'p-multi');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((p) => p.premium))).toEqual(new Set([8_000, 1_500]));
  });

  it('KNOWN GAP (pinned, not a target): a rollover into a null-effective-date capture does not supersede', () => {
    // collapseToCurrentTerm deliberately never compares a dated row against an undated one (see
    // its module doc — doing so would risk re-breaking the F2 doctrine above, since the only
    // signal distinguishing "this undated row is the newer capture of the same policy" from "this
    // undated row is a second, genuinely distinct policy" is the very ambiguity F2 exists to
    // protect). A rollover whose NEW capture has a data-entry gap (missing effective_date) is
    // therefore NOT superseded — both the old dated term and the new undated one survive. This is
    // a real but narrower recurrence of the 2026-08-17 bug (requires BOTH a rollover AND a missing
    // effective_date on the new capture, vs. the original bug which fired on every ordinary
    // dated rollover). Pinned here as documented, accepted behavior — not asserting it's correct,
    // only that it's known and won't silently drift.
    const db = freshDb();
    insertPolicy(db, {
      propertyId: 'p-gap', policyType: 'Property', policyNumber: 'GAP-1', premiumAnnual: 9_000,
      coverageTiv: 2_000_000, effectiveDate: '2025-06-01', sourceDate: '2025-06-05',
    });
    insertPolicy(db, {
      propertyId: 'p-gap', policyType: 'Property', policyNumber: 'GAP-1', premiumAnnual: 9_400,
      coverageTiv: 2_000_000, effectiveDate: null, sourceDate: '2026-06-05',
    });

    const report = buildInsuranceAnalysis(db, AS_OF);

    const rows = report.renewalCalendar.filter((p) => p.propertyId === 'p-gap');
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((p) => p.premium))).toEqual(new Set([9_000, 9_400]));
  });
});

describe('buildInsuranceAnalysis — unclassified-cohort visibility (refute F1-MEDIUM)', () => {
  it('an All-Risk policy with valid TIV/rate classifies as other (unchanged) AND is flagged for review', () => {
    const db = freshDb();
    insertPolicy(db, {
      propertyId: 'p-allrisk',
      policyType: 'All-Risk',
      premiumAnnual: 10_000,
      coverageTiv: 5_000_000,
    });

    const report = buildInsuranceAnalysis(db, AS_OF);
    const policy = report.renewalCalendar.find((p) => p.propertyId === 'p-allrisk');
    // Unchanged, correct per F1 doctrine — no keyword guessing without real data.
    expect(policy?.cohort).toBe('other');
    expect(policy?.ratePer100Tiv).toBeCloseTo(0.2, 6); // 10,000 / 5,000,000 * 100
    expect(policy?.excessPremiumVsMedian).toBeNull(); // cross-cohort — never scored (F1)

    const issues = db
      .prepare(
        "SELECT property_id, kind, detail, severity FROM data_quality_issues WHERE kind = 'insurance-cohort-unclassified'",
      )
      .all() as Array<{ property_id: string; kind: string; detail: string; severity: string }>;
    expect(issues).toHaveLength(1);
    expect(issues[0]?.property_id).toBe('p-allrisk');
    expect(issues[0]?.severity).toBe('warn');
    expect(issues[0]?.detail).toContain('All-Risk');
  });

  it('does not flag excluded-null-tiv or property-package policies', () => {
    const db = freshDb();
    insertPolicy(db, { propertyId: 'p-null', policyType: 'All-Risk', coverageTiv: null });
    insertPolicy(db, {
      propertyId: 'p-pkg', policyType: 'Property Package', premiumAnnual: 10_000, coverageTiv: 5_000_000,
    });

    buildInsuranceAnalysis(db, AS_OF);

    const count = (
      db
        .prepare("SELECT COUNT(*) AS n FROM data_quality_issues WHERE kind = 'insurance-cohort-unclassified'")
        .get() as { n: number }
    ).n;
    expect(count).toBe(0);
  });

  it('does not accumulate a duplicate DQ row across repeated report builds (unbounded-growth guard)', () => {
    const db = freshDb();
    insertPolicy(db, {
      propertyId: 'p-repeat', policyType: 'All-Risk', premiumAnnual: 10_000, coverageTiv: 5_000_000,
    });

    // Simulates opening the Insurance UI / hitting the GET route repeatedly — no snapshot-event
    // cadence bounds this write, unlike insurance.ts's captureInsurance.
    buildInsuranceAnalysis(db, AS_OF);
    buildInsuranceAnalysis(db, AS_OF);
    buildInsuranceAnalysis(db, AS_OF);

    const count = (
      db
        .prepare("SELECT COUNT(*) AS n FROM data_quality_issues WHERE kind = 'insurance-cohort-unclassified'")
        .get() as { n: number }
    ).n;
    expect(count).toBe(1);
  });
});

describe('buildInsuranceAnalysis — policy-line keys resolve the DISPLAY name only (2026-09-23 review)', () => {
  // The LEFT JOIN in the SQL query is keyed on property_master.id === property_id, but insurance
  // rows are keyed by policy line ('ins-<stem>-<line>'), which never matches a property_master.id
  // directly. The stem map resolves the display NAME. `propertyId` deliberately stays the raw
  // policy-line key: insurance-loss-analysis.ts attaches loss events on it and calibration keys
  // rebid verdicts on it, and at 9620 Raytown two concurrently in-force property policies share one
  // master id — resolving the id collapses them (order-dependent self-insure primary pick). Loss
  // attachment by resolved id is a separate follow-up. If the name wiring were reverted to the raw
  // r.property_id, the `property` assertions fail; if propertyId were resolved, the `propertyId`
  // assertions fail — both directions are pinned.
  it('resolves a policy-line key to its property_master NAME via the stem map, keeping the raw propertyId', () => {
    const db = freshDb();
    // No property_master row under the raw key 'ins-9620state350-prop-hfd' — only under the
    // resolved id, mirroring how the real STEM_TO_MASTER table maps stems to master ids.
    seedProperty(db, '9620-e-state-route-350-raytown-mo', '9620 E State Route 350, Raytown MO');
    insertPolicy(db, {
      propertyId: 'ins-9620state350-prop-hfd',
      policyType: 'Property',
      premiumAnnual: 5_000,
      coverageTiv: 2_000_000,
    });

    const report = buildInsuranceAnalysis(db, AS_OF);

    expect(report.renewalCalendar).toHaveLength(1);
    const policy = report.renewalCalendar[0]!;
    expect(policy.property).toBe('9620 E State Route 350, Raytown MO');
    expect(policy.propertyId).toBe('ins-9620state350-prop-hfd');
  });

  it('resolves a label-only stem (no property_master row at all) to its address label, keeping the raw propertyId', () => {
    const db = freshDb();
    insertPolicy(db, {
      propertyId: 'ins-etcpoa-bcl',
      policyType: 'Boiler & Machinery',
      premiumAnnual: 1_500,
      coverageTiv: 500_000,
    });

    const report = buildInsuranceAnalysis(db, AS_OF);

    const policy = report.renewalCalendar.find((p) => p.property === 'Airport Road, Easton MD (ETC POA)');
    expect(policy).toBeDefined();
    // A label-only stem has no master row to point at; propertyId is the raw key like every other
    // policy (the raw key is the rule, not a fallback).
    expect(policy?.propertyId).toBe('ins-etcpoa-bcl');
  });

  it('an empty-string property_master name is treated as missing for the display name; propertyId is still the raw key', () => {
    const db = freshDb();
    // Degenerate master row under the raw policy key with a blank name: the LEFT JOIN yields
    // property_name = '' (not null). The display name must fall through to the resolver rather
    // than render blank; propertyId is unaffected either way.
    seedProperty(db, 'ins-9620state350-prop-hfd', '');
    seedProperty(db, '9620-e-state-route-350-raytown-mo', '9620 E State Route 350, Raytown MO');
    insertPolicy(db, {
      propertyId: 'ins-9620state350-prop-hfd',
      policyType: 'Property',
      premiumAnnual: 5_000,
      coverageTiv: 2_000_000,
    });

    const report = buildInsuranceAnalysis(db, AS_OF);

    expect(report.renewalCalendar).toHaveLength(1);
    const policy = report.renewalCalendar[0]!;
    expect(policy.property).toBe('9620 E State Route 350, Raytown MO');
    expect(policy.propertyId).toBe('ins-9620state350-prop-hfd');
  });

  it('propertyId equals the raw property_id for EVERY policy in a mixed book (ins- stems, label-only, plain ids)', () => {
    // Old-vs-new equivalence: the loss engine, calibration and alerts consume `propertyId`. With
    // the raw key on every row, their inputs are identical to the pre-resolution wiring regardless
    // of how the display name resolved.
    const db = freshDb();
    seedProperty(db, '9620-e-state-route-350-raytown-mo', '9620 E State Route 350, Raytown MO');
    seedProperty(db, 'p-plain-master', 'Plain Master Property');
    const rawIds = [
      'ins-9620state350-prop-hfd',
      'ins-9620state350-prop-selective',
      'ins-etcpoa-bcl',
      'p-plain-master',
      'p-no-master',
    ];
    for (const id of rawIds) {
      insertPolicy(db, { propertyId: id, policyType: 'Property', premiumAnnual: 5_000, coverageTiv: 2_000_000 });
    }

    const report = buildInsuranceAnalysis(db, AS_OF);

    expect(report.renewalCalendar).toHaveLength(rawIds.length);
    expect(report.renewalCalendar.map((p) => p.propertyId).sort()).toEqual([...rawIds].sort());
    // Two in-force 9620 policies stay two distinct keys — never collapsed onto one master id.
    expect(report.renewalCalendar.filter((p) => p.property === '9620 E State Route 350, Raytown MO')).toHaveLength(2);
    expect(report.renewalCalendar.find((p) => p.propertyId === 'p-plain-master')?.property).toBe('Plain Master Property');
    expect(report.renewalCalendar.find((p) => p.propertyId === 'p-no-master')?.property).toBe('p-no-master');
  });
});
