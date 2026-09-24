// @vitest-environment node
//
// tests/unit/insurance-history.test.ts
//
// buildPremiumHistory (server/warehouse/insurance-history.ts) + GET /history on the
// insurance-analysis sub-router. In-memory better-sqlite3 + runMigrations for the route test —
// never touches data/warehouse/finance.sqlite.
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { buildPremiumHistory, type PremiumHistoryRow } from '../../server/warehouse/insurance-history';
import { insuranceAnalysisApi } from '../../server/warehouse/insurance-analysis-api';
import { runMigrations } from '../../server/warehouse/migrate';
import type { WarehouseDb } from '../../server/warehouse/db';
import { PremiumHistoryReport } from '@contracts/insurance-analysis';

const master = new Map([
  ['3034-westerville-rd-columbus-oh', '3034 Westerville Rd, Columbus OH'],
  ['9620-state-route-350-clarksville-oh', '9620 State Route 350, Clarksville OH'],
]);

let nextId = 1;
/** Fixture row: one policy term as SELECTed by GET /history. Defaults give each row a unique id,
 *  a unique policy_number, a null expiration_date and one shared capture date, so tests that do
 *  not care about the same-term rule behave as plain per-line term lists. */
function row(
  property_id: string,
  policy_type: string,
  effective_date: string | null,
  premium_annual: number | null,
  extra: Partial<Pick<PremiumHistoryRow, 'id' | 'policy_number' | 'expiration_date' | 'source_date'>> = {},
): PremiumHistoryRow {
  const id = extra.id ?? nextId++;
  return {
    id,
    property_id,
    policy_type,
    effective_date,
    premium_annual,
    policy_number: extra.policy_number ?? `POL-${id}`,
    expiration_date: extra.expiration_date ?? null,
    source_date: extra.source_date ?? '2026-06-01',
  };
}

describe('buildPremiumHistory', () => {
  it('groups terms per policy line, drops a same-premium duplicate term re-keyed inside one policy year, sums by policy year', () => {
    const r = buildPremiumHistory([
      row('ins-3034westerville-pckg', 'Package (PCKG)', '2024-09-24', 7838),
      row('ins-3034westerville-pckg', 'Package (PCKG)', '2025-09-18', 7838), // DQ duplicate
      row('ins-3034westerville-pckg', 'Package (PCKG)', '2025-07-05', 7831),
      row('ins-3034westerville-pckg', 'Package (PCKG)', '2026-07-05', 7522),
      row('ins-x-gl', 'GL', null, 100),
    ], master);
    expect(() => PremiumHistoryReport.parse(r)).not.toThrow();
    expect(r.lines[0]!.property).toBe('3034 Westerville Rd, Columbus OH');
    expect(r.lines[0]!.terms.map((t) => t.premium)).toEqual([7838, 7831, 7522]);
    expect(r.byYear).toEqual([
      { year: 2024, premium: 7838, lines: 1 },
      { year: 2025, premium: 7831, lines: 1 },
      { year: 2026, premium: 7522, lines: 1 },
    ]);
  });

  it('keeps a flat renewal a full policy year later, counts each line once per year when lines share a property, and orders same-property lines by lineKey', () => {
    const r = buildPremiumHistory([
      row('ins-3034westerville-pckg', 'Package (PCKG)', '2024-09-24', 7838),
      row('ins-3034westerville-pckg', 'Package (PCKG)', '2025-09-24', 7838), // flat renewal, 365d
      row('ins-3034westerville-bcl', 'BCL', '2025-02-01', 1000),
      // Unpriced/invalid row on its OWN term: skipped. (Same eff/exp as the $1,000 row would make it
      // a same-term reissue and — being the later capture — the engine-rule winner, which is then
      // skipped as unpriced; collapse runs before the price filter, exactly as buildInsuranceAnalysis.)
      row('ins-3034westerville-bcl', 'BCL', '2025-08-01', -5),
    ], master);
    expect(r.lines).toHaveLength(2);
    expect(r.lines.map((l) => l.property)).toEqual(['3034 Westerville Rd, Columbus OH', '3034 Westerville Rd, Columbus OH']);
    // Finding 4: deterministic tiebreak on the same property name.
    expect(r.lines.map((l) => l.lineKey)).toEqual(['ins-3034westerville-bcl', 'ins-3034westerville-pckg']);
    expect(r.lines.find((l) => l.lineKey === 'ins-3034westerville-pckg')!.terms.map((t) => t.premium)).toEqual([7838, 7838]);
    expect(r.byYear).toEqual([
      { year: 2024, premium: 7838, lines: 1 },
      { year: 2025, premium: 8838, lines: 2 },
    ]);
  });

  // Finding 1 — the live 9620 State 350 shape: two rows per line with the SAME effective_date and
  // SAME expiration_date, different premium / policy_number / capture date. The analysis engine
  // calls this a same-term reissue and keeps the most recently captured row; history must agree,
  // or the policy-year total double-counts the term.
  it('collapses a same-term reissue (identical eff/exp, different premium) to the latest capture, per line', () => {
    const r = buildPremiumHistory([
      row('ins-9620state350-gl', 'General Liability (GL)', '2025-10-18', 2628,
        { id: 10, policy_number: 'MMF17962784', expiration_date: '2026-10-18', source_date: '2025-11-03' }),
      row('ins-9620state350-gl', 'General Liability (GL)', '2025-10-18', 2576,
        { id: 11, policy_number: 'MMF17962784-002', expiration_date: '2026-10-18', source_date: '2026-02-10' }),
      row('ins-9620state350-prop', 'Property', '2025-10-18', 28071,
        { id: 12, policy_number: 'PRP1001', expiration_date: '2026-10-18', source_date: '2025-11-03' }),
      row('ins-9620state350-prop', 'Property', '2025-10-18', 27609,
        { id: 13, policy_number: 'PRP1001-002', expiration_date: '2026-10-18', source_date: '2026-02-10' }),
      // Prior year on the GL line — a genuine renewal, must survive.
      row('ins-9620state350-gl', 'General Liability (GL)', '2024-10-18', 2500,
        { id: 9, policy_number: 'MMF17962783', expiration_date: '2025-10-18', source_date: '2025-11-03' }),
    ], master);
    const gl = r.lines.find((l) => l.lineKey === 'ins-9620state350-gl')!;
    const prop = r.lines.find((l) => l.lineKey === 'ins-9620state350-prop')!;
    expect(gl.terms).toEqual([
      { effectiveDate: '2024-10-18', premium: 2500 },
      { effectiveDate: '2025-10-18', premium: 2576 },
    ]);
    expect(prop.terms).toEqual([{ effectiveDate: '2025-10-18', premium: 27609 }]);
    expect(r.byYear).toEqual([
      { year: 2024, premium: 2500, lines: 1 },
      { year: 2025, premium: 2576 + 27609, lines: 2 },
    ]);
  });

  it('same-term reissue with an equal capture date falls through to the higher id (engine tiebreak); a stale-captured row never wins on a later effective_date alone', () => {
    const r = buildPremiumHistory([
      row('ins-9620state350-gl', 'GL', '2025-10-18', 2628, { id: 20, expiration_date: '2026-10-18', source_date: '2026-01-01' }),
      row('ins-9620state350-gl', 'GL', '2025-10-18', 2576, { id: 21, expiration_date: '2026-10-18', source_date: '2026-01-01' }),
    ], master);
    expect(r.lines[0]!.terms).toEqual([{ effectiveDate: '2025-10-18', premium: 2576 }]);
    expect(r.byYear).toEqual([{ year: 2025, premium: 2576, lines: 1 }]);
  });

  it('does not treat rows with the same effective_date but different expiration_date as one term', () => {
    const r = buildPremiumHistory([
      row('ins-a-gl', 'GL', '2025-01-01', 100, { expiration_date: '2025-07-01' }), // 6-month policy
      row('ins-a-gl', 'GL', '2025-01-01', 250, { expiration_date: '2026-01-01' }), // separate annual policy
    ], master);
    expect(r.lines[0]!.terms.map((t) => t.premium)).toEqual([100, 250]);
    expect(r.byYear).toEqual([{ year: 2025, premium: 350, lines: 1 }]);
  });

  // Finding 2 — the duplicate window compares against KEPT terms only. C is 425d after A (kept)
  // but 273d after B (a dropped duplicate of A); C must survive.
  it('compares the same-premium duplicate window against kept terms only (A, B dup of A, C)', () => {
    const r = buildPremiumHistory([
      row('ins-a-gl', 'GL', '2024-01-01', 100), // A
      row('ins-a-gl', 'GL', '2024-06-01', 100), // B — re-key of A (152d), dropped
      row('ins-a-gl', 'GL', '2025-03-01', 100), // C — flat renewal 425d after A, kept
    ], master);
    expect(r.lines[0]!.terms).toEqual([
      { effectiveDate: '2024-01-01', premium: 100 },
      { effectiveDate: '2025-03-01', premium: 100 },
    ]);
    expect(r.byYear).toEqual([
      { year: 2024, premium: 100, lines: 1 },
      { year: 2025, premium: 100, lines: 1 },
    ]);
  });

  // Finding 3 — byYear.lines counts distinct policy lines, not terms.
  it('counts distinct lines per policy year when one line has two terms in the same year', () => {
    const r = buildPremiumHistory([
      row('ins-a-gl', 'GL', '2025-01-01', 100, { expiration_date: '2025-07-01' }),
      row('ins-a-gl', 'GL', '2025-07-01', 200, { expiration_date: '2026-01-01' }), // mid-year rollover
      row('ins-b-prop', 'Property', '2025-03-01', 1000),
    ], master);
    expect(r.byYear).toEqual([{ year: 2025, premium: 1300, lines: 2 }]);
  });

  it('returns an empty report for no rows', () => {
    expect(buildPremiumHistory([], master)).toEqual({ byYear: [], lines: [] });
  });
});

// ── GET /history ───────────────────────────────────────────────────────────────────────────

function freshDb(): WarehouseDb {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

function insertPolicy(
  db: WarehouseDb,
  propertyId: string,
  policyType: string,
  effectiveDate: string | null,
  premium: number | null,
  opts: { policyNumber?: string; expirationDate?: string | null; sourceDate?: string } = {},
): void {
  db.prepare(
    `INSERT INTO property_insurance_policies
       (property_id, insurer, policy_number, effective_date, expiration_date, premium_annual, coverage_tiv,
        policy_type, source, source_date, ingested_by)
     VALUES (?, 'Test Insurer', ?, ?, ?, ?, NULL, ?, 'test-fixture', ?, 'test-runner')`,
  ).run(
    propertyId,
    opts.policyNumber ?? `POL-${propertyId}-${effectiveDate ?? 'undated'}`,
    effectiveDate,
    opts.expirationDate ?? null,
    premium,
    policyType,
    opts.sourceDate ?? '2026-06-01',
  );
}

describe('GET /api/warehouse/insurance/analysis/history', () => {
  it('503s when the warehouse is unavailable', async () => {
    const app = insuranceAnalysisApi(() => { throw new Error('warehouse unavailable in test'); });
    const res = await app.request('/history');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'warehouse unavailable' });
  });

  it('200s with a contract-valid history resolved to property master display names', async () => {
    const db = freshDb();
    db.prepare('INSERT INTO property_master (id, name) VALUES (?, ?)').run('3034-westerville-rd-columbus-oh', '3034 Westerville Rd, Columbus OH');
    insertPolicy(db, 'ins-3034westerville-pckg', 'Package (PCKG)', '2024-09-24', 7838);
    insertPolicy(db, 'ins-3034westerville-pckg', 'Package (PCKG)', '2025-07-05', 7831);
    insertPolicy(db, 'ins-etcpoa-pckg', 'Package (PCKG)', null, 999);

    const res = await insuranceAnalysisApi(() => db).request('/history');
    expect(res.status).toBe(200);
    const body = PremiumHistoryReport.parse(await res.json());
    expect(body.lines).toEqual([
      {
        lineKey: 'ins-3034westerville-pckg',
        property: '3034 Westerville Rd, Columbus OH',
        policyType: 'Package (PCKG)',
        terms: [{ effectiveDate: '2024-09-24', premium: 7838 }, { effectiveDate: '2025-07-05', premium: 7831 }],
      },
    ]);
    expect(body.byYear).toEqual([{ year: 2024, premium: 7838, lines: 1 }, { year: 2025, premium: 7831, lines: 1 }]);
  });

  it('route SELECT carries the columns the same-term rule needs: a live-shape reissue collapses to the latest capture', async () => {
    const db = freshDb();
    insertPolicy(db, 'ins-9620state350-gl', 'General Liability (GL)', '2025-10-18', 2628,
      { policyNumber: 'MMF17962784', expirationDate: '2026-10-18', sourceDate: '2025-11-03' });
    insertPolicy(db, 'ins-9620state350-gl', 'General Liability (GL)', '2025-10-18', 2576,
      { policyNumber: 'MMF17962784-002', expirationDate: '2026-10-18', sourceDate: '2026-02-10' });

    const res = await insuranceAnalysisApi(() => db).request('/history');
    expect(res.status).toBe(200);
    const body = PremiumHistoryReport.parse(await res.json());
    expect(body.lines).toHaveLength(1);
    expect(body.lines[0]!.terms).toEqual([{ effectiveDate: '2025-10-18', premium: 2576 }]);
    expect(body.byYear).toEqual([{ year: 2025, premium: 2576, lines: 1 }]);
  });
});
