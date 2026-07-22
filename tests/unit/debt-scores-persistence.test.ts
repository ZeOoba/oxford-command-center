// tests/unit/debt-scores-persistence.test.ts
//
// Persists scoreDebtPositions() output into the debt_scores table (migration 010) for trend
// tracking. Built only after the 2026-07-21 adversarial REFUTE pass on debt-scoring.ts (3
// confirmed bugs found and fixed — see R1/R2/R3 regressions in debt-scoring.test.ts).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { scoreDebtPositions } from '../../server/warehouse/debt-scoring';
import { persistDebtScores } from '../../server/warehouse/debt-scores-persistence';
import type { PeriodMetrics } from '../../src/contracts/warehouse';

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'debt-scores-persist-test-'));
  const db = openWarehouse(join(dir, 'test.sqlite'));
  db.prepare(`
    INSERT OR IGNORE INTO property_master
      (id, name, market, financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status)
    VALUES (?, ?, 'Test Market', 'pnl', 10000, '2020-01-01', 1, 'active')
  `).run('prop-a', 'Test Property A');
  return db;
}

function insertLoan(db: WarehouseDb, overrides: Record<string, unknown> = {}): void {
  const row = {
    id: 'loan-001', snapshot_date: '2026-06-01', property_id: 'prop-a', loan_name: 'Test Mortgage',
    lender: 'Test Bank', original_principal: 1_000_000, current_balance: 800_000, rate: 0.065,
    loan_type: 'Amortizing', monthly_pmt: 5_500, annual_interest: null, annual_principal: null,
    is_demand: 0, maturity_date: null, months_to_maturity: 42, ltv: 0.30, balloon: 0, status: 'active',
    ...overrides,
  };
  db.prepare(`
    INSERT INTO debt_positions
      (id, snapshot_date, property_id, loan_name, lender, original_principal, current_balance,
       rate, loan_type, monthly_pmt, annual_interest, annual_principal,
       is_demand, maturity_date, months_to_maturity, ltv, balloon, status)
    VALUES
      (@id, @snapshot_date, @property_id, @loan_name, @lender, @original_principal, @current_balance,
       @rate, @loan_type, @monthly_pmt, @annual_interest, @annual_principal,
       @is_demand, @maturity_date, @months_to_maturity, @ltv, @balloon, @status)
  `).run(row);
}

function makeMetrics(overrides: Partial<PeriodMetrics> & { propertyId: string; noi: number }): PeriodMetrics {
  return {
    propertyId: overrides.propertyId, propertyName: null, period: overrides.period ?? '2025',
    grainHint: overrides.grainHint ?? 'year', basis: 'cash', rentableSf: 10_000, ownershipPct: 1,
    revenue: overrides.noi, opex: 0, noi: overrides.noi, noiMargin: null, expenseRatio: null,
    capex: 0, ti: 0, leasing: 0, categories: {}, revenueCategories: {}, revenuePerSf: null,
    noiPerSf: null, expensePerSf: null, taxesPerSf: null, insurancePerSf: null, repairsPerSf: null,
    oxfordNoi: overrides.noi,
  };
}

describe('persistDebtScores', () => {
  it('writes one debt_scores row per score, with correct field mapping', () => {
    const db = freshDb();
    insertLoan(db, { monthly_pmt: 5_000, ltv: 0.30 });
    const metrics = [makeMetrics({ propertyId: 'prop-a', noi: 120_000, period: '2025' })];
    const scores = scoreDebtPositions(db, metrics, 0.045);

    const result = persistDebtScores(db, scores, metrics, '2026-07-21', 150);
    expect(result.written).toBe(1);
    expect(result.skipped).toHaveLength(0);

    const rows = db.prepare('SELECT * FROM debt_scores').all() as Array<Record<string, unknown>>;
    expect(rows).toHaveLength(1);
    const row = rows[0]!;
    expect(row.property_id).toBe('prop-a');
    expect(row.snapshot_date).toBe('2026-07-21');
    expect(row.noi_period).toBe('2025');
    expect(row.dscr).toBeCloseTo(scores[0]!.dscr!, 5);
    expect(row.signal).toBe(scores[0]!.signal);
    expect(row.score).toBe(scores[0]!.score);
    expect(row.score_band).toBe(scores[0]!.scoreBand);
    expect(row.refi_trigger_bps).toBe(150);
    expect(row.capital_config_version).toBe(scores[0]!.capitalConfigVersion);
  });

  it('skips (does not insert) a score whose property has no full-year NOI period, rather than fabricating noi_period', () => {
    const db = freshDb();
    insertLoan(db, { monthly_pmt: 5_000, ltv: 0.30 });
    // Only a YTD period exists — no grainHint:'year' row for prop-a.
    const metrics: PeriodMetrics[] = [
      makeMetrics({ propertyId: 'prop-a', noi: 40_000, period: '2026-Q1', grainHint: 'ytd' }),
    ];
    const scores = scoreDebtPositions(db, metrics, 0.045);

    const result = persistDebtScores(db, scores, metrics, '2026-07-21', 150);
    expect(result.written).toBe(0);
    expect(result.skipped).toHaveLength(1);
    expect(result.skipped[0]!.propertyId).toBe('prop-a');
    expect(result.skipped[0]!.reason).toMatch(/no full-year/i);

    const rows = db.prepare('SELECT * FROM debt_scores').all();
    expect(rows).toHaveLength(0);
  });

  it('writes scored_at as the actual write time, distinct from snapshot_date (the business date)', () => {
    const db = freshDb();
    insertLoan(db, { monthly_pmt: 5_000, ltv: 0.30 });
    const metrics = [makeMetrics({ propertyId: 'prop-a', noi: 120_000, period: '2025' })];
    const scores = scoreDebtPositions(db, metrics, null);

    const before = Date.now();
    persistDebtScores(db, scores, metrics, '2026-01-01', 150); // a deliberately stale business date
    const after = Date.now();

    const row = db.prepare('SELECT scored_at, snapshot_date FROM debt_scores')
      .get() as { scored_at: string; snapshot_date: string };
    expect(row.snapshot_date).toBe('2026-01-01');
    const scoredAtMs = new Date(row.scored_at).getTime();
    expect(scoredAtMs).toBeGreaterThanOrEqual(before);
    expect(scoredAtMs).toBeLessThanOrEqual(after);
  });

  it('resolves noi_period correctly for a property that HAS active debt (own loan present in debt_positions)', () => {
    const db = freshDb();
    // Distinguishing note from an earlier draft of this test: scoreDebtPositions() only ever
    // includes a property in its output when it has >=1 active debt_positions row (a true
    // no-debt property never reaches persistDebtScores at all via this path) — so this test
    // exercises the ordinary resolvable-NOI case, not the separate noDebtScore() helper path.
    insertLoan(db, { property_id: 'prop-a', monthly_pmt: 100, ltv: 0.01, current_balance: 5_000 });
    const metrics = [makeMetrics({ propertyId: 'prop-a', noi: 500_000, period: '2025' })];
    const scores = scoreDebtPositions(db, metrics, null);

    const result = persistDebtScores(db, scores, metrics, '2026-07-21', 150);
    expect(result.written).toBe(1);
  });

  it('writes multiple properties independently, each resolving its own noi_period', () => {
    const db = freshDb();
    db.prepare(`
      INSERT OR IGNORE INTO property_master
        (id, name, market, financial_mode, rentable_sf, acquisition_date, ownership_pct, ownership_status)
      VALUES ('prop-b', 'Test Property B', 'Test Market', 'pnl', 10000, '2020-01-01', 1, 'active')
    `).run();
    insertLoan(db, { id: 'loan-a', property_id: 'prop-a', monthly_pmt: 2_000, ltv: 0.20 });
    insertLoan(db, { id: 'loan-b', property_id: 'prop-b', monthly_pmt: 2_000, ltv: 0.20 });
    const metrics = [
      makeMetrics({ propertyId: 'prop-a', noi: 200_000, period: '2025' }),
      makeMetrics({ propertyId: 'prop-b', noi: 150_000, period: '2024' }),
    ];
    const scores = scoreDebtPositions(db, metrics, null);

    const result = persistDebtScores(db, scores, metrics, '2026-07-21', 150);
    expect(result.written).toBe(2);

    const rows = db.prepare('SELECT property_id, noi_period FROM debt_scores ORDER BY property_id')
      .all() as Array<{ property_id: string; noi_period: string }>;
    expect(rows.find((r) => r.property_id === 'prop-a')!.noi_period).toBe('2025');
    expect(rows.find((r) => r.property_id === 'prop-b')!.noi_period).toBe('2024');
  });

  it('is a pure append — calling it twice writes two rows (trend history, not an upsert)', () => {
    const db = freshDb();
    insertLoan(db, { monthly_pmt: 5_000, ltv: 0.30 });
    const metrics = [makeMetrics({ propertyId: 'prop-a', noi: 120_000, period: '2025' })];
    const scores = scoreDebtPositions(db, metrics, null);

    persistDebtScores(db, scores, metrics, '2026-07-14', 150);
    persistDebtScores(db, scores, metrics, '2026-07-21', 150);

    const rows = db.prepare('SELECT snapshot_date FROM debt_scores ORDER BY snapshot_date').all() as Array<{ snapshot_date: string }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.snapshot_date)).toEqual(['2026-07-14', '2026-07-21']);
  });
});
