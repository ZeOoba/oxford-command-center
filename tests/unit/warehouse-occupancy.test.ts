// tests/unit/warehouse-occupancy.test.ts
//
// PFI Phase 1 — Occupancy time-series: recordOccupancy, recordOccupancyBatch,
// occupancySeries, latestOccupancyByProperty.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import {
  latestOccupancyByProperty,
  occupancySeries,
  recordOccupancy,
  recordOccupancyBatch,
} from '../../server/warehouse/occupancy';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'wh-occ-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  return db;
}

describe('recordOccupancy — single-property upsert', () => {
  it('stores an occupancy snapshot retrievable via occupancySeries', () => {
    const db = freshDb();
    recordOccupancy(db, { propertyId: '1100-rarig-ave-columbus-oh', asOf: '2025-12-31', occPct: 0.95 });
    const series = occupancySeries(db, '1100-rarig-ave-columbus-oh');
    expect(series).toHaveLength(1);
    expect(series[0]!.occPct).toBe(0.95);
    expect(series[0]!.asOf).toBe('2025-12-31');
    expect(series[0]!.source).toBe('workbook');
  });

  it('is idempotent — second upsert on same (property, asOf, source) replaces occPct', () => {
    const db = freshDb();
    recordOccupancy(db, { propertyId: '1100-rarig-ave-columbus-oh', asOf: '2025-12-31', occPct: 0.90 });
    recordOccupancy(db, { propertyId: '1100-rarig-ave-columbus-oh', asOf: '2025-12-31', occPct: 0.95 });
    const series = occupancySeries(db, '1100-rarig-ave-columbus-oh');
    expect(series).toHaveLength(1);   // still just one row
    expect(series[0]!.occPct).toBe(0.95); // replaced, not doubled
  });

  it('throws a RangeError for occPct > 1', () => {
    const db = freshDb();
    expect(() =>
      recordOccupancy(db, { propertyId: '1100-rarig-ave-columbus-oh', asOf: '2025-12-31', occPct: 1.01 }),
    ).toThrow(RangeError);
  });

  it('throws a RangeError for occPct < 0', () => {
    const db = freshDb();
    expect(() =>
      recordOccupancy(db, { propertyId: '1100-rarig-ave-columbus-oh', asOf: '2025-12-31', occPct: -0.01 }),
    ).toThrow(RangeError);
  });
});

describe('occupancySeries — time-ordered history', () => {
  it('returns snapshots oldest-first', () => {
    const db = freshDb();
    recordOccupancy(db, { propertyId: '1100-rarig-ave-columbus-oh', asOf: '2025-12-31', occPct: 0.90 });
    recordOccupancy(db, { propertyId: '1100-rarig-ave-columbus-oh', asOf: '2024-12-31', occPct: 0.85 });
    recordOccupancy(db, { propertyId: '1100-rarig-ave-columbus-oh', asOf: '2026-06-30', occPct: 0.95 });
    const series = occupancySeries(db, '1100-rarig-ave-columbus-oh');
    expect(series.map((p) => p.asOf)).toEqual(['2024-12-31', '2025-12-31', '2026-06-30']);
  });

  it('returns empty array for a property with no snapshots', () => {
    const db = freshDb();
    expect(occupancySeries(db, 'no-such-property')).toEqual([]);
  });

  it('isolates by propertyId — snapshots for one property do not appear in another\'s series', () => {
    const db = freshDb();
    recordOccupancy(db, { propertyId: '1100-rarig-ave-columbus-oh', asOf: '2025-12-31', occPct: 0.95 });
    recordOccupancy(db, { propertyId: '9050-red-branch-rd-columbia-md', asOf: '2025-12-31', occPct: 0.80 });
    expect(occupancySeries(db, '1100-rarig-ave-columbus-oh')).toHaveLength(1);
    expect(occupancySeries(db, '9050-red-branch-rd-columbia-md')).toHaveLength(1);
  });
});

describe('recordOccupancyBatch — bulk workbook ingest', () => {
  it('records all valid properties and skips non-finite occPct values', () => {
    const db = freshDb();
    const result = recordOccupancyBatch(
      db,
      [
        { id: '1100-rarig-ave-columbus-oh', occPct: 0.95 },
        { id: '9050-red-branch-rd-columbia-md', occPct: NaN },   // skipped
        { id: '3540-e-5th-ave-columbus-oh', occPct: 0.80 },
      ],
      '2025-12-31',
    );
    expect(result.recorded).toBe(2);
    expect(result.skipped).toBe(1);
    expect(occupancySeries(db, '1100-rarig-ave-columbus-oh')).toHaveLength(1);
    expect(occupancySeries(db, '9050-red-branch-rd-columbia-md')).toHaveLength(0);
  });

  it('is idempotent — batch re-run on same date replaces prior values', () => {
    const db = freshDb();
    recordOccupancyBatch(db, [{ id: '1100-rarig-ave-columbus-oh', occPct: 0.90 }], '2025-12-31');
    recordOccupancyBatch(db, [{ id: '1100-rarig-ave-columbus-oh', occPct: 0.95 }], '2025-12-31');
    const series = occupancySeries(db, '1100-rarig-ave-columbus-oh');
    expect(series).toHaveLength(1);
    expect(series[0]!.occPct).toBe(0.95);
  });
});

describe('latestOccupancyByProperty — current-state dashboard view', () => {
  it('returns the most recent snapshot per property', () => {
    const db = freshDb();
    recordOccupancy(db, { propertyId: '1100-rarig-ave-columbus-oh', asOf: '2024-12-31', occPct: 0.85 });
    recordOccupancy(db, { propertyId: '1100-rarig-ave-columbus-oh', asOf: '2025-12-31', occPct: 0.95 });
    recordOccupancy(db, { propertyId: '9050-red-branch-rd-columbia-md', asOf: '2025-12-31', occPct: 0.80 });
    const latest = latestOccupancyByProperty(db);
    expect(latest).toHaveLength(2);
    const rarig = latest.find((p) => p.propertyId === '1100-rarig-ave-columbus-oh')!;
    expect(rarig.asOf).toBe('2025-12-31');  // latest, not 2024
    expect(rarig.occPct).toBe(0.95);
  });

  it('returns empty array when no occupancy data exists', () => {
    const db = freshDb();
    expect(latestOccupancyByProperty(db)).toEqual([]);
  });

  it('is sorted by propertyId ascending for deterministic dashboard output', () => {
    const db = freshDb();
    recordOccupancy(db, { propertyId: '9050-red-branch-rd-columbia-md', asOf: '2025-12-31', occPct: 0.80 });
    recordOccupancy(db, { propertyId: '1100-rarig-ave-columbus-oh', asOf: '2025-12-31', occPct: 0.95 });
    const ids = latestOccupancyByProperty(db).map((p) => p.propertyId);
    expect(ids).toEqual([...ids].sort());
  });
});
