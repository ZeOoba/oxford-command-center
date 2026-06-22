// @vitest-environment node
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'schema-017-018-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

// recommendations.property_id has a FK to property_master; tests insert synthetic
// property ids, so disable FK enforcement on the connection under test.
function insertMarketSeries(
  db: WarehouseDb,
  row: { cluster: string; as_of: string; source: string; metric: string; value?: number },
): void {
  db.prepare(
    `INSERT INTO market_series (cluster, as_of, source, metric, value, confidence)
     VALUES (@cluster, @as_of, @source, @metric, @value, 0.9)`,
  ).run({ value: null, ...row });
}

function insertRecommendation(
  db: WarehouseDb,
  row: {
    property_id?: string;
    action?: string;
    expected_return_pct?: number | null;
    risk_band?: string;
    timeline_months?: number | null;
    confidence?: number;
    inputs_version?: string;
    as_of?: string;
  },
): void {
  db.prepare(
    `INSERT INTO recommendations
       (property_id, action, expected_return_pct, risk_band, timeline_months, confidence, inputs_version, as_of)
     VALUES (@property_id, @action, @expected_return_pct, @risk_band, @timeline_months, @confidence, @inputs_version, @as_of)`,
  ).run({
    property_id: 'prop-1',
    action: 'hold',
    expected_return_pct: 0.1,
    risk_band: 'low',
    timeline_months: 12,
    confidence: 0.8,
    inputs_version: 'v1',
    as_of: '2026-06-01',
    ...row,
  });
}

describe('migration 017 — market_series unique index', () => {
  it('rejects a duplicate (cluster, as_of, source, metric) tuple', () => {
    const db = freshDb();
    const tuple = { cluster: 'OH', as_of: '2026-06-01', source: 'FRED', metric: 'unemp' };
    insertMarketSeries(db, tuple);
    expect(() => insertMarketSeries(db, tuple)).toThrow();
  });

  it('allows rows that differ in the metric component', () => {
    const db = freshDb();
    const base = { cluster: 'OH', as_of: '2026-06-01', source: 'FRED' };
    expect(() => {
      insertMarketSeries(db, { ...base, metric: 'unemp' });
      insertMarketSeries(db, { ...base, metric: 'cap_rate' });
    }).not.toThrow();
  });

  it('exposes the ux_market_series_tuple index in sqlite_master', () => {
    const db = freshDb();
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ux_market_series_tuple'")
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe('ux_market_series_tuple');
  });
});

describe('migration 018 — recommendations constraints', () => {
  it('rejects a duplicate (property_id, as_of, inputs_version) tuple', () => {
    const db = freshDb();
    db.exec('PRAGMA foreign_keys = OFF');
    insertRecommendation(db, { property_id: 'p', as_of: '2026-06-01', inputs_version: 'v1' });
    expect(() =>
      insertRecommendation(db, { property_id: 'p', as_of: '2026-06-01', inputs_version: 'v1' }),
    ).toThrow();
  });

  it('allows two rows for the same property/as_of with different inputs_version', () => {
    const db = freshDb();
    db.exec('PRAGMA foreign_keys = OFF');
    expect(() => {
      insertRecommendation(db, { property_id: 'p', as_of: '2026-06-01', inputs_version: 'v1' });
      insertRecommendation(db, { property_id: 'p', as_of: '2026-06-01', inputs_version: 'v2' });
    }).not.toThrow();
  });

  it('accepts in-range expected_return_pct values (NULL, 0.0, -1.0, 5.0)', () => {
    const db = freshDb();
    db.exec('PRAGMA foreign_keys = OFF');
    const cases: Array<number | null> = [null, 0.0, -1.0, 5.0];
    cases.forEach((v, i) => {
      expect(() =>
        insertRecommendation(db, { expected_return_pct: v, inputs_version: `v${i}` }),
      ).not.toThrow();
    });
  });

  it('rejects out-of-range expected_return_pct values (-1.1 and 5.1)', () => {
    const db = freshDb();
    db.exec('PRAGMA foreign_keys = OFF');
    expect(() => insertRecommendation(db, { expected_return_pct: -1.1, inputs_version: 'a' })).toThrow();
    expect(() => insertRecommendation(db, { expected_return_pct: 5.1, inputs_version: 'b' })).toThrow();
  });

  it('accepts valid timeline_months values (NULL and 1)', () => {
    const db = freshDb();
    db.exec('PRAGMA foreign_keys = OFF');
    expect(() => insertRecommendation(db, { timeline_months: null, inputs_version: 'a' })).not.toThrow();
    expect(() => insertRecommendation(db, { timeline_months: 1, inputs_version: 'b' })).not.toThrow();
  });

  it('rejects non-positive timeline_months values (0 and -1)', () => {
    const db = freshDb();
    db.exec('PRAGMA foreign_keys = OFF');
    expect(() => insertRecommendation(db, { timeline_months: 0, inputs_version: 'a' })).toThrow();
    expect(() => insertRecommendation(db, { timeline_months: -1, inputs_version: 'b' })).toThrow();
  });

  it('exposes the ux_recommendations_versioned index in sqlite_master', () => {
    const db = freshDb();
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ux_recommendations_versioned'")
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe('ux_recommendations_versioned');
  });
});
