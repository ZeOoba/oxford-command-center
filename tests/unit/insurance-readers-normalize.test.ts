// @vitest-environment node
//
// tests/unit/insurance-readers-normalize.test.ts
//
// Sweep follow-up to #400: every reader of property_insurance_policies normalizes through the one
// shared normalizePolicyRow, and the bad-date data-quality flag has a lifecycle.
//
// SQLite affinities are not constraints — a raw-SQL BLOB in a TEXT column made
// collapseToCurrentTerm's .trim() throw in the two readers #400 did not touch:
//   - insurance-conditions.ts fetchCurrentInsuranceRows (feeds runBrief's expiry + drift alerts;
//     the throw lands in runBrief's fail-open catch → "Insurance alerts unavailable", and the expiry
//     CRITICALS, the email path, are skipped for that run), and
//   - GET /api/warehouse/insurance/analysis/history (uncaught → 500).
// In-memory better-sqlite3 + runMigrations — never touches data/warehouse/finance.sqlite.
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { runMigrations } from '../../server/warehouse/migrate';
import type { WarehouseDb } from '../../server/warehouse/db';
import { insuranceAnalysisApi } from '../../server/warehouse/insurance-analysis-api';
import { buildInsuranceAnalysis } from '../../server/warehouse/insurance-analysis';
import {
  fetchCurrentInsuranceRows,
  insuranceConditions,
  insuranceWarehouseDriftConditions,
} from '../../server/warehouse/insurance-conditions';
import { resolveIssue } from '../../server/warehouse/actions';
import { PremiumHistoryReport } from '../../src/contracts/insurance-analysis';
import type { PortfolioSnapshot } from '../../src/contracts/index';

const AS_OF = '2026-06-20';

function freshDb(): WarehouseDb {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  db.prepare('INSERT INTO property_master (id, name) VALUES (?, ?)').run('p1', 'Property One');
  db.prepare('INSERT INTO property_master (id, name) VALUES (?, ?)').run('p2', 'Property Two');
  return db;
}

function addDays(isoDate: string, days: number): string {
  const d = new Date(isoDate);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Minimal snapshot (mirrors insurance-conditions.test.ts). */
function makeSnap(propertyIds: string[]): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: AS_OF, generatedAt: `${AS_OF}T00:00:00Z`, source: 'test', scenario: 'Base' },
    assumptions: {
      activeScenario: 'Base',
      revenueFactor: 1,
      vacancyFactor: 1,
      exitCapFactor: 1,
      thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 },
      asOf: AS_OF,
    },
    properties: propertyIds.map((id) => ({ id, name: `Property ${id}` })),
    leases: [],
    loans: [],
    deals: [],
    insurance: [],
    tasks: [],
    counterparties: [],
    dataQuality: [],
    cash: { asOf: AS_OF, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
  } as unknown as PortfolioSnapshot;
}

function insertPolicy(
  db: WarehouseDb,
  propertyId: string,
  policyNumber: string,
  over: Partial<{ eff: string; exp: string; premium: number; type: string; src: string }> = {},
): number {
  const r = db
    .prepare(
      `INSERT INTO property_insurance_policies
         (property_id, insurer, policy_number, effective_date, expiration_date,
          premium_annual, coverage_tiv, policy_type, source, source_date, ingested_by)
       VALUES (?, 'Test Insurer', ?, ?, ?, ?, 1000000, ?, 'test-fixture', ?, 'test-runner')`,
    )
    .run(
      propertyId,
      policyNumber,
      over.eff ?? addDays(AS_OF, -300),
      over.exp ?? addDays(AS_OF, 45),
      over.premium ?? 8000,
      over.type ?? 'general-liability',
      over.src ?? AS_OF,
    );
  return Number(r.lastInsertRowid);
}

function corrupt(db: WarehouseDb, id: number, column: string, sqlValue: string): void {
  db.exec(`UPDATE property_insurance_policies SET ${column} = ${sqlValue} WHERE id = ${id}`);
}

const BAD_WRITES: Array<[string, string]> = [
  ['policy_type', "X'41'"],
  ['property_id', "X'7031'"],
  ['policy_number', "X'41'"],
  ['effective_date', "X'41'"],
  ['effective_date', '1717200000'],
  ['expiration_date', "X'41'"],
  ['source_date', "X'41'"],
  ['premium_annual', "X'41'"],
];

describe('insurance-conditions.ts — fetchCurrentInsuranceRows / insuranceConditions / drift', () => {
  for (const [column, value] of BAD_WRITES) {
    it(`${column} = ${value}: no throw, and the clean neighbour still emits its expiry critical`, () => {
      const db = freshDb();
      insertPolicy(db, 'p1', 'POL-CLEAN');
      const bad = insertPolicy(db, 'p2', 'POL-BAD');
      corrupt(db, bad, column, value);

      expect(() => fetchCurrentInsuranceRows(db)).not.toThrow();
      const insights = insuranceConditions(db, makeSnap(['p1', 'p2']), undefined, fetchCurrentInsuranceRows(db));
      const expiry = insights.filter((i) => i.id.startsWith('ins-expiry-p1'));
      expect(expiry).toHaveLength(1);
      expect(expiry[0]!.severity).toBe('critical');
      expect(() => insuranceWarehouseDriftConditions(db, makeSnap(['p1', 'p2']), undefined, fetchCurrentInsuranceRows(db))).not.toThrow();
    });
  }

  it('a clean book is unchanged: same rows, in the same shape, as before normalization', () => {
    const db = freshDb();
    const a = insertPolicy(db, 'p1', 'POL-A', { premium: 4200 });
    const rows = fetchCurrentInsuranceRows(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ id: a, property_id: 'p1', policy_number: 'POL-A', premium_annual: 4200, policy_type: 'general-liability' });
  });
});

// Refute wf_6457df0e-d38 (numeric + edges lenses): normalizing a present-but-invalid expiration_date to
// null made the brief SKIP a policy whose raw string V8's Date used to parse ('10/15/2026'), silently
// dropping its expiry critical with no trace (the brief's warehouse handle is read-only, so it cannot
// flag). Ruling stays "flag, don't recover": the term is not ranked or alerted on, but the brief must
// NAME the policy with a warning insight so the drop is visible.
describe('brief path — an unreadable date is named, not silently dropped', () => {
  const badDateInsights = (db: WarehouseDb) =>
    insuranceConditions(db, makeSnap(['p1']), undefined, fetchCurrentInsuranceRows(db)).filter((i) =>
      i.id.startsWith('ins-bad-date-'),
    );

  it.each([["'10/15/2026'"], ["'2026/10/15'"], ["'Oct 15 2026'"], ["'2026-02-30'"], ["X'41'"]])(
    'expiration_date = %s inside the alert window → one warning insight, no expiry critical, no throw',
    (value) => {
      const db = freshDb();
      const id = insertPolicy(db, 'p1', 'POL-1', { premium: 12345 });
      corrupt(db, id, 'expiration_date', value);
      const insights = insuranceConditions(db, makeSnap(['p1']), undefined, fetchCurrentInsuranceRows(db));
      const bad = insights.filter((i) => i.id.startsWith('ins-bad-date-'));
      expect(bad).toHaveLength(1);
      expect(bad[0]).toMatchObject({ id: 'ins-bad-date-p1', severity: 'warning', category: 'insurance', impactAnnualUsd: 12345 });
      expect(bad[0]!.detail).toContain('expiration_date');
      expect(bad[0]!.detail).toContain('POL-1');
      expect(insights.filter((i) => i.id.startsWith('ins-expiry-'))).toHaveLength(0);
    },
  );

  it('a bad effective_date is named too — and only the rollover claim is made, because the expiry critical still fires (refute wf_9c0a7cb2-91b)', () => {
    const db = freshDb();
    const id = insertPolicy(db, 'p1', 'POL-1', { premium: 12345 });
    corrupt(db, id, 'effective_date', "'07/15/2025'");
    const insights = insuranceConditions(db, makeSnap(['p1']), undefined, fetchCurrentInsuranceRows(db));
    const bad = insights.filter((i) => i.id.startsWith('ins-bad-date-'));
    expect(bad).toHaveLength(1);
    expect(bad[0]!.detail).toContain('effective_date');
    expect(bad[0]!.detail).toMatch(/rollover/i);
    expect(bad[0]!.detail).not.toContain('would NOT alert'); // the expiry check still runs
    expect(insights.filter((i) => i.id === 'ins-expiry-p1' && i.severity === 'critical')).toHaveLength(1);
    // The premium is attached once (to the expiry critical), never twice.
    expect(bad[0]!.impactAnnualUsd).toBeNull();
  });

  it.each([["'2026-08-04T00:00:00Z'"], ["'2026-08-04 '"]])(
    'a non-canonical but still-readable expiration_date %s: the expiry critical fires and NO bad-date warning contradicts it',
    (value) => {
      const db = freshDb();
      const id = insertPolicy(db, 'p1', 'POL-1');
      corrupt(db, id, 'expiration_date', value);
      const insights = insuranceConditions(db, makeSnap(['p1']), undefined, fetchCurrentInsuranceRows(db));
      expect(insights.filter((i) => i.id === 'ins-expiry-p1')).toHaveLength(1);
      expect(insights.filter((i) => i.id.startsWith('ins-bad-date-'))).toHaveLength(0);
    },
  );

  it('an unreadable expiration_date names the drift check too (it skips the row as well)', () => {
    const db = freshDb();
    const id = insertPolicy(db, 'p1', 'POL-1');
    corrupt(db, id, 'expiration_date', "'10/15/2026'");
    const [bad] = badDateInsights(db);
    expect(bad!.detail).toContain('would NOT alert');
    expect(bad!.detail).toMatch(/drift/i);
  });

  it('a bad source_date alone is NOT named: no brief check depends on it', () => {
    const db = freshDb();
    const id = insertPolicy(db, 'p1', 'POL-1');
    corrupt(db, id, 'source_date', "X'41'");
    expect(badDateInsights(db)).toHaveLength(0);
  });

  it('a NULL date and a clean book produce no bad-date insight', () => {
    const db = freshDb();
    const id = insertPolicy(db, 'p1', 'POL-1');
    expect(badDateInsights(db)).toHaveLength(0);
    corrupt(db, id, 'expiration_date', 'NULL');
    expect(badDateInsights(db)).toHaveLength(0);
  });

  // Refute wf_5db46698-d07 (4 of 5 lenses): the insight used to keep only the FIRST qualifying row per
  // property, and collapseToCurrentTerm puts undated rows (bad effective_date) first — so a
  // rollover-only bad row hid a same-property row whose expiry check was skipped, and its premium.
  it.each([[['rollover', 'expiry']], [['expiry', 'rollover']]])(
    'aggregates across rows of one property — a rollover-only row never hides an expiry-skipped row (insert order %j)',
    (order) => {
      const db = freshDb();
      const rows: Record<string, () => void> = {
        rollover: () => {
          const id = insertPolicy(db, 'p1', 'POL-A', { premium: 1000, exp: addDays(AS_OF, 400) });
          corrupt(db, id, 'effective_date', "'07/15/2025'"); // expiry still readable → expiry check runs
        },
        expiry: () => {
          const id = insertPolicy(db, 'p1', 'POL-B', { premium: 50_000, type: 'property' });
          corrupt(db, id, 'expiration_date', "'08/01/2026'"); // 42 days out; unreadable → check skipped
        },
      };
      for (const k of order) rows[k]!();
      const insights = insuranceConditions(db, makeSnap(['p1']), undefined, fetchCurrentInsuranceRows(db));
      const bad = insights.filter((i) => i.id.startsWith('ins-bad-date-'));
      expect(bad).toHaveLength(1);
      expect(bad[0]!.detail).toContain('POL-B');
      expect(bad[0]!.detail).toContain('would NOT alert');
      expect(bad[0]!.detail).toContain('POL-A');
      expect(bad[0]!.detail).toMatch(/rollover/i);
      expect(bad[0]!.impactAnnualUsd).toBe(50_000);
      expect(insights.filter((i) => i.id === 'ins-expiry-p1')).toHaveLength(0); // POL-A expires in 400d
    },
  );

  it('the aggregated insight is identical whichever order the rows were inserted', () => {
    const detailFor = (order: Array<'a' | 'b'>) => {
      const db = freshDb();
      for (const k of order) {
        const id = insertPolicy(db, 'p1', k === 'a' ? 'POL-A' : 'POL-B', { premium: k === 'a' ? 1000 : 50_000, type: k === 'a' ? 'general-liability' : 'property' });
        corrupt(db, id, k === 'a' ? 'effective_date' : 'expiration_date', k === 'a' ? "'07/15/2025'" : "'08/01/2026'");
      }
      return insuranceConditions(db, makeSnap(['p1']), undefined, fetchCurrentInsuranceRows(db)).find((i) => i.id === 'ins-bad-date-p1')!;
    };
    const ab = detailFor(['a', 'b']);
    const ba = detailFor(['b', 'a']);
    expect(ab.detail).toBe(ba.detail);
    expect(ab.impactAnnualUsd).toBe(ba.impactAnnualUsd);
  });

  it('when another row of the property already raises the expiry critical, the premium is not attached twice', () => {
    const db = freshDb();
    insertPolicy(db, 'p1', 'POL-OK', { premium: 7000 }); // expires in 45d → ins-expiry-p1 critical
    const bad = insertPolicy(db, 'p1', 'POL-BAD', { premium: 9000, type: 'property' });
    corrupt(db, bad, 'expiration_date', "'10/15/2026'");
    const insights = insuranceConditions(db, makeSnap(['p1']), undefined, fetchCurrentInsuranceRows(db));
    expect(insights.filter((i) => i.id === 'ins-expiry-p1')).toHaveLength(1);
    expect(insights.find((i) => i.id === 'ins-bad-date-p1')!.impactAnnualUsd).toBeNull();
  });

  it('one insight per property even with several bad rows; the brief handle never writes', () => {
    const db = freshDb();
    const a = insertPolicy(db, 'p1', 'POL-A');
    const b = insertPolicy(db, 'p1', 'POL-B', { type: 'property' });
    corrupt(db, a, 'expiration_date', "X'41'");
    corrupt(db, b, 'expiration_date', "'10/15/2026'");
    const before = db.prepare('SELECT count(*) AS c FROM data_quality_issues').get() as { c: number };
    expect(badDateInsights(db)).toHaveLength(1);
    const after = db.prepare('SELECT count(*) AS c FROM data_quality_issues').get() as { c: number };
    expect(after.c).toBe(before.c);
  });
});

// Refute wf_51e97c11-d63 (sweep + edges): termDateOrNull accepts any value whose LEADING 10 chars are a
// real date but returns the RAW string, and the brief's daysBetween does `new Date(raw)` — so
// '2026-10-15x' passed the null test yet produced an emailed critical "expires in NaN days", and
// '…T00:00:00Z' produced a false warehouse-vs-workbook drift warning. The normalizer now canonicalizes
// term dates to the same leading 10 characters the engine's isoDay reads, so every reader agrees.
describe('canonical term dates — the leading YYYY-MM-DD, whatever follows it', () => {
  it.each([
    ['2026-08-04T00:00:00Z', '2026-08-04'],
    ['2026-08-04 ', '2026-08-04'],
    ['2026-08-04x', '2026-08-04'],
    [' 2026-08-04', '2026-08-04'],
  ])('a stored %j reads as %j in the shared reader', (stored, canonical) => {
    const db = freshDb();
    const id = insertPolicy(db, 'p1', 'POL-1');
    db.prepare('UPDATE property_insurance_policies SET expiration_date = ? WHERE id = ?').run(stored, id);
    expect(fetchCurrentInsuranceRows(db)[0]!.expiration_date).toBe(canonical);
  });

  it('a bare-date row and a same-day timestamped row of one policy are one policy (premium counted once)', () => {
    const db = freshDb();
    insertPolicy(db, 'p1', 'POL-1', { eff: '2026-01-01', premium: 5000, src: '2026-04-01' });
    const dup = insertPolicy(db, 'p1', 'POL-1', { eff: '2026-01-02', premium: 5000, src: '2026-05-01' });
    db.prepare('UPDATE property_insurance_policies SET effective_date = ? WHERE id = ?').run('2026-01-01T00:00:00Z', dup);
    const report = buildInsuranceAnalysis(db, AS_OF);
    expect(report.policiesN).toBe(1);
    expect(report.premiumAnnualTotal).toBe(5000);
  });

  it('a suffixed expiry inside the window raises a sane critical (45 days), never "NaN days"', () => {
    const db = freshDb();
    const id = insertPolicy(db, 'p1', 'POL-1');
    db.prepare('UPDATE property_insurance_policies SET expiration_date = ? WHERE id = ?').run(`${addDays(AS_OF, 45)}x`, id);
    const insights = insuranceConditions(db, makeSnap(['p1']), undefined, fetchCurrentInsuranceRows(db));
    const expiry = insights.find((i) => i.id === 'ins-expiry-p1');
    expect(expiry?.detail).toContain('expires in 45 days');
    expect(JSON.stringify(insights)).not.toContain('NaN');
  });

  it('a far-future suffixed expiry raises nothing and never NaN', () => {
    const db = freshDb();
    const id = insertPolicy(db, 'p1', 'POL-1');
    db.prepare('UPDATE property_insurance_policies SET expiration_date = ? WHERE id = ?').run('2028-12-31garbage', id);
    const insights = insuranceConditions(db, makeSnap(['p1']), undefined, fetchCurrentInsuranceRows(db));
    expect(insights.filter((i) => i.id.startsWith('ins-expiry-'))).toHaveLength(0);
    expect(JSON.stringify(insights)).not.toContain('NaN');
  });

  it('a still-readable non-canonical warehouse expiry causes no false drift warning against the same live date', () => {
    const db = freshDb();
    const exp = addDays(AS_OF, 45);
    const id = insertPolicy(db, 'p1', 'POL-1', { exp });
    db.prepare('UPDATE property_insurance_policies SET expiration_date = ? WHERE id = ?').run(`${exp}T00:00:00Z`, id);
    const snap = {
      ...(makeSnap(['p1']) as unknown as Record<string, unknown>),
      insurance: [
        { id: 'p1', property: 'Property One', entity: null, coverage: 'general-liability', effective: null, expires: exp, policyNo: null, carrier: 'T', premium: 1000, daysToExpiry: null, status: 'Current', notes: null, flags: [], tiv: null, deductible: null, coverageLimit: null },
      ],
    } as unknown as PortfolioSnapshot;
    expect(insuranceWarehouseDriftConditions(db, snap, AS_OF, fetchCurrentInsuranceRows(db))).toHaveLength(0);
  });

  it("Condition 1b's title does not depend on which row has the lower id (several bad rows, different policy types)", () => {
    const titleFor = (order: Array<'gl' | 'prop'>) => {
      const db = freshDb();
      for (const k of order) {
        const id = insertPolicy(db, 'p1', k === 'gl' ? 'POL-GL' : 'POL-PR', { type: k === 'gl' ? 'general-liability' : 'property' });
        corrupt(db, id, 'expiration_date', "'10/15/2026'");
      }
      return insuranceConditions(db, makeSnap(['p1']), undefined, fetchCurrentInsuranceRows(db)).find((i) => i.id === 'ins-bad-date-p1')!.title;
    };
    expect(titleFor(['gl', 'prop'])).toBe(titleFor(['prop', 'gl']));
  });
});

describe('GET /history — same raw-SQL values must not 500', () => {
  for (const [column, value] of BAD_WRITES) {
    it(`${column} = ${value} → contract-valid 200`, async () => {
      const db = freshDb();
      insertPolicy(db, 'p1', 'POL-CLEAN');
      const bad = insertPolicy(db, 'p2', 'POL-BAD');
      corrupt(db, bad, column, value);
      const res = await insuranceAnalysisApi(() => db).request('/history');
      expect(res.status).toBe(200);
      PremiumHistoryReport.parse(await res.json());
    });
  }
});

describe('cross-reader parity: one corrupt book, one current-term set', () => {
  it('/insurance and the conditions reader agree on which policies are current', () => {
    const db = freshDb();
    insertPolicy(db, 'p1', 'POL-A');
    const b = insertPolicy(db, 'p2', 'POL-B');
    const c = insertPolicy(db, 'p2', 'POL-C', { type: 'property' });
    corrupt(db, b, 'effective_date', '1717200000'); // numeric-as-text date
    corrupt(db, c, 'policy_type', "X'41'");
    const engine = buildInsuranceAnalysis(db, AS_OF)
      .renewalCalendar.map((p) => p.policyId)
      .sort();
    const conditions = fetchCurrentInsuranceRows(db)
      .map((r) => String(r.id))
      .sort();
    expect(conditions).toEqual(engine);
  });
});

describe("bad-date flag lifecycle ('insurance-policy-bad-date')", () => {
  const flags = (db: WarehouseDb, status: string) =>
    db
      .prepare(`SELECT id, detail, status, resolved_at FROM data_quality_issues WHERE kind = 'insurance-policy-bad-date' AND status = ?`)
      .all(status) as Array<{ id: number; detail: string; status: string; resolved_at: string | null }>;

  it('auto-resolves when the value heals', () => {
    const db = freshDb();
    const id = insertPolicy(db, 'p1', 'POL-1');
    corrupt(db, id, 'source_date', "X'41'");
    buildInsuranceAnalysis(db, AS_OF);
    expect(flags(db, 'open')).toHaveLength(1);

    corrupt(db, id, 'source_date', "'2026-06-01'"); // healed
    buildInsuranceAnalysis(db, AS_OF);
    expect(flags(db, 'open')).toHaveLength(0);
    const resolved = flags(db, 'resolved');
    expect(resolved).toHaveLength(1);
    expect(resolved[0]!.resolved_at).not.toBeNull();
  });

  it("a stale flag whose policy_id no longer exists (captureInsurance advanced the id) is resolved, and the still-bad row is re-flagged under its new id", () => {
    const db = freshDb();
    const id = insertPolicy(db, 'p1', 'POL-1');
    corrupt(db, id, 'expiration_date', "X'41'");
    buildInsuranceAnalysis(db, AS_OF);
    db.exec(`UPDATE property_insurance_policies SET id = 99 WHERE id = ${id}`); // what UPDATE_POLICY does
    buildInsuranceAnalysis(db, AS_OF);
    const open = flags(db, 'open');
    expect(open).toHaveLength(1);
    expect(open[0]!.detail).toContain('policy_id=99 ');
    expect(flags(db, 'resolved')).toHaveLength(1);
  });

  it('a flag a human resolved WITHOUT fixing the value re-opens (the value is still bad): documented, not a bug', () => {
    const db = freshDb();
    const id = insertPolicy(db, 'p1', 'POL-1');
    corrupt(db, id, 'effective_date', "X'41'");
    buildInsuranceAnalysis(db, AS_OF);
    const [first] = flags(db, 'open');
    resolveIssue(db, first!.id);
    expect(flags(db, 'open')).toHaveLength(0);
    buildInsuranceAnalysis(db, AS_OF);
    expect(flags(db, 'open')).toHaveLength(1);
  });

  it('never touches other data_quality_issues kinds', () => {
    const db = freshDb();
    insertPolicy(db, 'p1', 'POL-1');
    db.prepare(`INSERT INTO data_quality_issues (property_id, kind, detail, severity) VALUES ('p1', 'insurance-cohort-unclassified', 'policy_id=1 x', 'warn')`).run();
    buildInsuranceAnalysis(db, AS_OF); // clean book → the sweep runs with an empty bad set
    const other = db
      .prepare(`SELECT status FROM data_quality_issues WHERE kind = 'insurance-cohort-unclassified'`)
      .get() as { status: string };
    expect(other.status).toBe('open');
  });
});
