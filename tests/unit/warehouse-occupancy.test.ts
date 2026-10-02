// tests/unit/warehouse-occupancy.test.ts
//
// PFI Phase 1 — Occupancy time-series: recordOccupancy, recordOccupancyBatch,
// occupancySeries, latestOccupancyByProperty.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import {
  captureOccupancy,
  easternCalendarDay,
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

  // Regression for the HIGH adversarial finding: property_occupancy FKs to property_master with
  // foreign_keys=ON, and the loop is ONE transaction — pre-fix, a single orphan id (no master row,
  // e.g. the Potomac residence) threw and rolled back EVERY property's row, so capture silently
  // recorded nothing. The orphan must be skipped, the valid peers still recorded.
  it('skips an orphan property (no master row) instead of aborting, and WARNS roster drift', () => {
    const db = freshDb();
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m?: unknown) => { warns.push(String(m)); });
    try {
      const result = recordOccupancyBatch(db, [
        { id: '1100-rarig-ave-columbus-oh', occPct: 0.95 },        // valid (in CANON_PROPERTIES)
        { id: 'orphan-not-in-property-master-xyz', occPct: 0.50 },  // no master row — FK orphan
      ], '2025-12-31');
      expect(result.recorded).toBe(1);
      expect(result.skipped).toBe(1);
      // The valid property WAS persisted — the orphan did not roll the transaction back.
      expect(occupancySeries(db, '1100-rarig-ave-columbus-oh')).toHaveLength(1);
      // Roster drift is observable, not silent.
      expect(warns.some((w) => /not in property_master|roster.*drift/i.test(w))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  // Regression for the MEDIUM determinism finding: a duplicate id must not inflate the count, and a
  // duplicate carrying a DIFFERENT occPct (likely slug collision between distinct properties) must be
  // surfaced, not silently resolved. First occurrence wins (deterministic for the stable parser order).
  it('dedups a duplicate id (first wins; distinct-key count) and WARNS on a differing-value collision', () => {
    const db = freshDb();
    const warns: string[] = [];
    const spy = vi.spyOn(console, 'warn').mockImplementation((m?: unknown) => { warns.push(String(m)); });
    try {
      const result = recordOccupancyBatch(db, [
        { id: '1100-rarig-ave-columbus-oh', occPct: 0.50 },
        { id: '1100-rarig-ave-columbus-oh', occPct: 0.95 },
      ], '2025-12-31');
      expect(result.recorded).toBe(1); // distinct keys, not loop iterations
      expect(result.skipped).toBe(1);
      const series = occupancySeries(db, '1100-rarig-ave-columbus-oh');
      expect(series).toHaveLength(1);
      expect(series[0]!.occPct).toBe(0.50); // first occurrence wins
      expect(warns.some((w) => /duplicate id.*differing|slug collision/i.test(w))).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('a duplicate id with the SAME value is a benign re-list — deduped with no collision warning', () => {
    const db = freshDb();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = recordOccupancyBatch(db, [
        { id: '1100-rarig-ave-columbus-oh', occPct: 0.95 },
        { id: '1100-rarig-ave-columbus-oh', occPct: 0.95 },
      ], '2025-12-31');
      expect(result.recorded).toBe(1);
      expect(result.skipped).toBe(1);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  // Regression for the MEDIUM edges finding: an empty property_master (server opened the DB via
  // migrations but warehouse:backfill never ran) must FAIL LOUD, not silently record nothing — a
  // silent {recorded:0} would invisibly drop occupancy history over the un-backfilled window.
  it('throws on an unseeded (empty) property_master instead of silently recording nothing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'wh-occ-unseeded-'));
    const db = openWarehouse(join(dir, 'f.sqlite')); // migrations run; NO seedPropertyMaster
    expect(() =>
      recordOccupancyBatch(db, [{ id: '1100-rarig-ave-columbus-oh', occPct: 0.95 }], '2026-06-01'),
    ).toThrow(/property_master is empty|backfill/i);
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

  // Regression for the LOW determinism finding: two sources tied at the same MAX(as_of) previously
  // returned BOTH rows (GROUP BY property_id only), making a "current occupancy" read depend on
  // SQLite row-emission order. Now exactly one row wins by source precedence (manual > workbook).
  it('breaks a same-as_of multi-source tie deterministically — exactly one row per property', () => {
    const db = freshDb();
    recordOccupancy(db, { propertyId: '1100-rarig-ave-columbus-oh', asOf: '2026-06-01', occPct: 0.90, source: 'workbook' });
    recordOccupancy(db, { propertyId: '1100-rarig-ave-columbus-oh', asOf: '2026-06-01', occPct: 0.60, source: 'manual' });
    const latest = latestOccupancyByProperty(db);
    expect(latest).toHaveLength(1);            // not 2
    expect(latest[0]!.source).toBe('manual');  // manual outranks workbook at the same date
    expect(latest[0]!.occPct).toBe(0.60);
  });
});

describe('captureOccupancy — snapshot → warehouse occupancy bridge (brain.refresh call site)', () => {
  // Minimal snapshot shape: captureOccupancy reads properties[].{id,occPct} and meta.generatedAt
  // (the CAPTURE timestamp). It deliberately ignores meta.asOf (a static config constant).
  const snap = (
    properties: Array<{ id: string; occPct: number }>,
    generatedAt = '2026-06-01T09:00:00.000Z',
  ) => ({ properties, meta: { generatedAt } }) as unknown as Parameters<typeof captureOccupancy>[1];

  it('records every property\'s occPct keyed on the capture date (meta.generatedAt → as_of)', () => {
    const db = freshDb();
    const result = captureOccupancy(db, snap([
      { id: '1100-rarig-ave-columbus-oh', occPct: 0.95 },
      { id: '9050-red-branch-rd-columbia-md', occPct: 0.80 },
    ]));
    expect(result.recorded).toBe(2);
    expect(result.skipped).toBe(0);
    const series = occupancySeries(db, '1100-rarig-ave-columbus-oh');
    expect(series).toHaveLength(1);
    expect(series[0]!.asOf).toBe('2026-06-01'); // sliced from generatedAt, not meta.asOf
    expect(series[0]!.occPct).toBe(0.95);
    expect(series[0]!.source).toBe('workbook');
  });

  it('is a safe no-op on a null snapshot (degraded-mode startup)', () => {
    const db = freshDb();
    const result = captureOccupancy(db, null);
    expect(result).toEqual({ recorded: 0, skipped: 0 });
    expect(latestOccupancyByProperty(db)).toEqual([]);
  });

  // Regression for the MEDIUM edges finding: residences carry no commercial occupancy and have no
  // master row by design — they must be excluded BEFORE the orphan check, never counted as drift.
  it('excludes residences (filtered upstream) — not recorded, not a skip, no roster-drift warning', () => {
    const db = freshDb();
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const result = captureOccupancy(db, {
        properties: [
          { id: '1100-rarig-ave-columbus-oh', occPct: 0.95 },
          { id: '9510-persimmon-tree-rd-potomac-md', occPct: 0.0, type: 'Residence' },
        ],
        meta: { generatedAt: '2026-06-01T12:00:00.000Z' },
      } as unknown as Parameters<typeof captureOccupancy>[1]);
      expect(result.recorded).toBe(1); // only the real property
      expect(result.skipped).toBe(0);  // residence filtered before the batch — not a skip
      expect(spy).not.toHaveBeenCalled(); // no roster-drift warning for the by-design residence
    } finally {
      spy.mockRestore();
    }
  });

  it('is idempotent across refreshes on the same capture day (workbook re-save)', () => {
    const db = freshDb();
    captureOccupancy(db, snap([{ id: '1100-rarig-ave-columbus-oh', occPct: 0.90 }], '2026-06-01T08:00:00.000Z'));
    captureOccupancy(db, snap([{ id: '1100-rarig-ave-columbus-oh', occPct: 0.95 }], '2026-06-01T17:00:00.000Z'));
    const series = occupancySeries(db, '1100-rarig-ave-columbus-oh');
    expect(series).toHaveLength(1);       // same day ⇒ one point
    expect(series[0]!.occPct).toBe(0.95); // latest same-day value wins
  });

  // Regression for the HIGH adversarial finding: pre-fix, captureOccupancy keyed on the STATIC
  // meta.asOf (WORKBOOK_AS_OF), so every production refresh overwrote one row and the series never
  // advanced — the new tests masked it by hand-feeding asOf. This drives the PRODUCTION path:
  // capture date advances across refreshes; all points must survive.
  it('advances the series across refreshes as the capture date moves (the asOf-static defect is fixed)', () => {
    const db = freshDb();
    captureOccupancy(db, snap([{ id: '1100-rarig-ave-columbus-oh', occPct: 0.95 }], '2026-03-15T12:00:00.000Z'));
    captureOccupancy(db, snap([{ id: '1100-rarig-ave-columbus-oh', occPct: 0.80 }], '2026-04-15T12:00:00.000Z'));
    captureOccupancy(db, snap([{ id: '1100-rarig-ave-columbus-oh', occPct: 0.92 }], '2026-05-15T12:00:00.000Z'));
    const series = occupancySeries(db, '1100-rarig-ave-columbus-oh');
    expect(series.map((p) => p.asOf)).toEqual(['2026-03-15', '2026-04-15', '2026-05-15']);
    expect(series.map((p) => p.occPct)).toEqual([0.95, 0.80, 0.92]); // all three survive — no collapse
  });

  it('is a no-op on a malformed/empty generatedAt rather than writing a garbage as_of', () => {
    const db = freshDb();
    const result = captureOccupancy(db, snap([{ id: '1100-rarig-ave-columbus-oh', occPct: 0.95 }], ''));
    expect(result).toEqual({ recorded: 0, skipped: 0 });
    expect(occupancySeries(db, '1100-rarig-ave-columbus-oh')).toEqual([]);
  });

  // Regression for the MEDIUM correctness finding: generatedAt is UTC; an evening-ET refresh must be
  // attributed to the EASTERN calendar day, not the UTC day (which would read as tomorrow).
  it('attributes an evening-ET refresh to the Eastern calendar day, not the UTC day', () => {
    const db = freshDb();
    // 2026-06-12 21:30 EDT = 2026-06-13T01:30:00Z. UTC day = the 13th; ET day = the 12th.
    captureOccupancy(db, snap([{ id: '1100-rarig-ave-columbus-oh', occPct: 0.88 }], '2026-06-13T01:30:00.000Z'));
    const series = occupancySeries(db, '1100-rarig-ave-columbus-oh');
    expect(series).toHaveLength(1);
    expect(series[0]!.asOf).toBe('2026-06-12'); // Eastern day, not UTC '2026-06-13'
  });
});

describe('easternCalendarDay export', () => {
  it('books an evening-ET UTC instant onto the ET day', () => {
    expect(easternCalendarDay('2026-11-01T02:00:00.000Z')).toBe('2026-10-31');
    expect(easternCalendarDay('garbage')).toBeNull();
  });
});
