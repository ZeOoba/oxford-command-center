// @vitest-environment node
//
// tests/unit/insurance-history.test.ts
//
// buildPremiumHistory (server/warehouse/insurance-history.ts) + GET /history on the
// insurance-analysis sub-router. In-memory better-sqlite3 + runMigrations for the route test —
// never touches data/warehouse/finance.sqlite.
import Database from 'better-sqlite3';
import { describe, expect, it } from 'vitest';
import { buildPremiumHistory } from '../../server/warehouse/insurance-history';
import { insuranceAnalysisApi } from '../../server/warehouse/insurance-analysis-api';
import { runMigrations } from '../../server/warehouse/migrate';
import type { WarehouseDb } from '../../server/warehouse/db';
import { PremiumHistoryReport } from '@contracts/insurance-analysis';

const master = new Map([['3034-westerville-rd-columbus-oh', '3034 Westerville Rd, Columbus OH']]);

describe('buildPremiumHistory', () => {
  it('groups terms per policy line, drops a same-premium duplicate term re-keyed inside one policy year, sums by policy year', () => {
    const r = buildPremiumHistory([
      { property_id: 'ins-3034westerville-pckg', policy_type: 'Package (PCKG)', effective_date: '2024-09-24', premium_annual: 7838 },
      { property_id: 'ins-3034westerville-pckg', policy_type: 'Package (PCKG)', effective_date: '2025-09-18', premium_annual: 7838 }, // DQ duplicate
      { property_id: 'ins-3034westerville-pckg', policy_type: 'Package (PCKG)', effective_date: '2025-07-05', premium_annual: 7831 },
      { property_id: 'ins-3034westerville-pckg', policy_type: 'Package (PCKG)', effective_date: '2026-07-05', premium_annual: 7522 },
      { property_id: 'ins-x-gl', policy_type: 'GL', effective_date: null, premium_annual: 100 },
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

  it('keeps a flat renewal a full policy year later and counts each line once per year when lines share a property', () => {
    const r = buildPremiumHistory([
      { property_id: 'ins-3034westerville-pckg', policy_type: 'Package (PCKG)', effective_date: '2024-09-24', premium_annual: 7838 },
      { property_id: 'ins-3034westerville-pckg', policy_type: 'Package (PCKG)', effective_date: '2025-09-24', premium_annual: 7838 }, // flat renewal, 365d
      { property_id: 'ins-3034westerville-bcl', policy_type: 'BCL', effective_date: '2025-02-01', premium_annual: 1000 },
      { property_id: 'ins-3034westerville-bcl', policy_type: 'BCL', effective_date: '2025-02-01', premium_annual: -5 }, // unpriced/invalid
    ], master);
    expect(r.lines).toHaveLength(2);
    expect(r.lines.map((l) => l.property)).toEqual(['3034 Westerville Rd, Columbus OH', '3034 Westerville Rd, Columbus OH']);
    expect(r.lines.find((l) => l.lineKey === 'ins-3034westerville-pckg')!.terms.map((t) => t.premium)).toEqual([7838, 7838]);
    expect(r.byYear).toEqual([
      { year: 2024, premium: 7838, lines: 1 },
      { year: 2025, premium: 8838, lines: 2 },
    ]);
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

function insertPolicy(db: WarehouseDb, propertyId: string, policyType: string, effectiveDate: string | null, premium: number | null): void {
  db.prepare(
    `INSERT INTO property_insurance_policies
       (property_id, insurer, policy_number, effective_date, expiration_date, premium_annual, coverage_tiv,
        policy_type, source, source_date, ingested_by)
     VALUES (?, 'Test Insurer', ?, ?, NULL, ?, NULL, ?, 'test-fixture', '2026-06-01', 'test-runner')`,
  ).run(propertyId, `POL-${propertyId}-${effectiveDate ?? 'undated'}`, effectiveDate, premium, policyType);
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
});
