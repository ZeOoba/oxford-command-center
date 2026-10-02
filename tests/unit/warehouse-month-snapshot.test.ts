// tests/unit/warehouse-month-snapshot.test.ts
//
// Portfolio Trends Wave 2 — captureMonthSnapshot: ET month attribution, per-month freeze, roster guard.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Lease } from '@contracts/index';
import { easternCalendarDay } from '../../server/warehouse/occupancy';
import { openWarehouse } from '../../server/warehouse/db';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import {
  captureMonthSnapshot,
  describeCaptureOutcome,
  monthSnapshotSeries,
  type MonthSnapshotView,
} from '../../server/warehouse/month-snapshot';

const A = '1100-rarig-ave-columbus-oh';
const B = '3540-e-5th-ave-columbus-oh';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'wh-pms-'));
  const db = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(db);
  return db;
}

const lease = (o: Partial<Lease>): Lease =>
  ({
    id: 'l', propertyKey: 'P', propertyId: A, tenantName: 't', unit: 'A', company: 'c',
    sf: 1000, monthlyRent: 1000, rentPerSf: 12, leaseStart: '2025-01-01', leaseEnd: '2027-12-31',
    escalationDate: null, escalationPct: null, status: 'Active', annualRent: 12000,
    monthsToExpiry: 14, flags: [], ...o,
  }) as Lease;

function view(generatedAt: string, rentA2 = 7000): MonthSnapshotView {
  return {
    properties: [
      { id: A, sf: 20000, occPct: 0.6, type: 'Flex' },
      { id: B, sf: 10000, occPct: 0.6, type: 'Flex' },
    ],
    leases: [
      lease({ id: 'a1', propertyId: A, sf: 5000, monthlyRent: 5000 }),
      lease({ id: 'a2', propertyId: A, sf: 7000, monthlyRent: rentA2 }),
      lease({ id: 'b1', propertyId: B, sf: 4000, monthlyRent: 3000 }),
      lease({ id: 'b2', propertyId: B, sf: 2000, monthlyRent: 1500 }),
    ],
    meta: { generatedAt },
  };
}

afterEach(() => vi.restoreAllMocks());

describe('captureMonthSnapshot', () => {
  it('(a) records one row per investment property with lease-derived values', () => {
    const db = freshDb();
    const r = captureMonthSnapshot(db, view('2026-10-02T15:00:00.000Z'));
    expect(r).toEqual({ recorded: 2, skipped: 0, frozen: 0 });
    expect(monthSnapshotSeries(db, A)).toEqual([
      { propertyId: A, month: '2026-10', capturedThrough: '2026-10-02', totalSf: 20000, leasedSf: 12000, inPlaceRent: 12000, leaseCount: 2, occPct: 0.6, frozen: false },
    ]);
    expect(monthSnapshotSeries(db, B)).toEqual([
      { propertyId: B, month: '2026-10', capturedThrough: '2026-10-02', totalSf: 10000, leasedSf: 6000, inPlaceRent: 4500, leaseCount: 2, occPct: 0.6, frozen: false },
    ]);
    // property-then-month ordering across the unfiltered series
    expect(monthSnapshotSeries(db).map((x) => x.propertyId)).toEqual([A, B].sort());
  });

  it('(b) a second capture on the same ET day overwrites idempotently (one row)', () => {
    const db = freshDb();
    captureMonthSnapshot(db, view('2026-10-02T15:00:00.000Z'));
    captureMonthSnapshot(db, view('2026-10-02T18:00:00.000Z', 9000));
    const rows = monthSnapshotSeries(db, A);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.inPlaceRent).toBe(14000);
  });

  it('(c) a later month freezes the earlier month; an older-month recapture cannot overwrite it', () => {
    const db = freshDb();
    captureMonthSnapshot(db, view('2026-10-02T15:00:00.000Z'));
    const nov = captureMonthSnapshot(db, view('2026-11-02T15:00:00.000Z', 8000));
    expect(nov).toEqual({ recorded: 2, skipped: 0, frozen: 2 });
    const rows = monthSnapshotSeries(db, A);
    expect(rows.map((r) => [r.month, r.frozen])).toEqual([['2026-10', true], ['2026-11', false]]);

    const again = captureMonthSnapshot(db, view('2026-10-20T15:00:00.000Z', 99999));
    expect(again.recorded).toBe(0);
    expect(again.skipped).toBe(2);
    expect(again.frozen).toBe(0);
    const after = monthSnapshotSeries(db, A);
    expect(after[0]).toMatchObject({ month: '2026-10', inPlaceRent: 12000, capturedThrough: '2026-10-02', frozen: true });
    expect(after[1]).toMatchObject({ month: '2026-11', inPlaceRent: 13000 });
  });

  it('(d) an evening-ET instant after UTC midnight books to the ET month', () => {
    const db = freshDb();
    captureMonthSnapshot(db, view('2026-11-01T02:00:00.000Z'));
    const rows = monthSnapshotSeries(db, A);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ month: '2026-10', capturedThrough: '2026-10-31' });
  });

  it('(e) excludes residences', () => {
    const db = freshDb();
    const v = view('2026-10-02T15:00:00.000Z');
    v.properties = [
      { id: A, sf: 20000, occPct: 0.6, type: 'Flex' },
      { id: B, sf: 10000, occPct: 0.6, type: 'Residence' },
    ];
    const r = captureMonthSnapshot(db, v);
    expect(r.recorded).toBe(1);
    expect(monthSnapshotSeries(db).map((x) => x.propertyId)).toEqual([A]);
  });

  it('(f) skips unknown ids with one warn; empty property_master throws', () => {
    const db = freshDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const v = view('2026-10-02T15:00:00.000Z');
    v.properties = [
      ...v.properties,
      { id: 'ghost-1', sf: 1, occPct: 0.5, type: 'Flex' },
      { id: 'ghost-2', sf: 1, occPct: 0.5, type: 'Flex' },
    ];
    const r = captureMonthSnapshot(db, v);
    expect(r).toEqual({ recorded: 2, skipped: 2, frozen: 0 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('ghost-1');
    expect(String(warn.mock.calls[0]![0])).toContain('ghost-2');

    const empty = freshDb();
    empty.prepare('DELETE FROM property_master').run();
    expect(() => captureMonthSnapshot(empty, view('2026-10-02T15:00:00.000Z'))).toThrow(/property_master is empty/);
  });

  it('(g) occPct outside [0,1] stores NULL but keeps lease-derived columns', () => {
    const db = freshDb();
    const v = view('2026-10-02T15:00:00.000Z');
    v.properties = [{ id: A, sf: 20000, occPct: 1.4, type: 'Flex' }];
    captureMonthSnapshot(db, v);
    expect(monthSnapshotSeries(db, A)[0]).toMatchObject({ occPct: null, leasedSf: 12000, inPlaceRent: 12000, leaseCount: 2 });
  });

  it('(h) null snapshot and unparseable generatedAt are no-ops', () => {
    const db = freshDb();
    expect(captureMonthSnapshot(db, null)).toEqual({ recorded: 0, skipped: 0, frozen: 0 });
    expect(captureMonthSnapshot(db, view('not-a-date'))).toEqual({ recorded: 0, skipped: 0, frozen: 0 });
    expect(monthSnapshotSeries(db)).toEqual([]);
  });

  it('duplicate ids in one batch: first wins; non-finite sf skipped, never NaN', () => {
    const db = freshDb();
    const v = view('2026-10-02T15:00:00.000Z');
    v.properties = [
      { id: A, sf: 20000, occPct: 0.6, type: 'Flex' },
      { id: A, sf: 99999, occPct: 0.1, type: 'Flex' },
      { id: B, sf: Number.NaN, occPct: 0.6, type: 'Flex' },
    ];
    const r = captureMonthSnapshot(db, v);
    expect(r).toEqual({ recorded: 1, skipped: 2, frozen: 0 });
    const rows = monthSnapshotSeries(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ propertyId: A, totalSf: 20000, occPct: 0.6 });
  });

  it('non-finite occPct skips that property', () => {
    const db = freshDb();
    const v = view('2026-10-02T15:00:00.000Z');
    v.properties = [{ id: A, sf: 20000, occPct: Number.NaN, type: 'Flex' }];
    expect(captureMonthSnapshot(db, v)).toEqual({ recorded: 0, skipped: 1, frozen: 0 });
  });

  it('(i) never writes a back-dated month: older capture is skipped when a later month exists', () => {
    const db = freshDb();
    captureMonthSnapshot(db, view('2026-11-02T15:00:00.000Z'));
    const r = captureMonthSnapshot(db, view('2026-10-20T15:00:00.000Z', 99999));
    expect(r).toEqual({ recorded: 0, skipped: 2, frozen: 0 });
    const rows = monthSnapshotSeries(db, A);
    expect(rows.map((x) => x.month)).toEqual(['2026-11']);
    expect(rows[0]).toMatchObject({ inPlaceRent: 12000, frozen: false });
  });

  it('(ii) a property with no rows still records while another is skipped as back-dated', () => {
    const db = freshDb();
    const novOnlyA = view('2026-11-02T15:00:00.000Z');
    novOnlyA.properties = [{ id: A, sf: 20000, occPct: 0.6, type: 'Flex' }];
    captureMonthSnapshot(db, novOnlyA);
    const r = captureMonthSnapshot(db, view('2026-10-20T15:00:00.000Z'));
    expect(r).toEqual({ recorded: 1, skipped: 1, frozen: 0 });
    expect(monthSnapshotSeries(db, A).map((x) => x.month)).toEqual(['2026-11']);
    expect(monthSnapshotSeries(db, B).map((x) => x.month)).toEqual(['2026-10']);
  });

  it('guard order: NaN-sf first duplicate still wins the id; NaN-sf orphan is warned', () => {
    const db = freshDb();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const v = view('2026-10-02T15:00:00.000Z');
    v.properties = [
      { id: 'ghost-nan', sf: Number.NaN, occPct: 0.5, type: 'Flex' },
      { id: A, sf: Number.NaN, occPct: 0.6, type: 'Flex' },
      { id: A, sf: 20000, occPct: 0.6, type: 'Flex' },
      { id: B, sf: 10000, occPct: 0.6, type: 'Flex' },
    ];
    const r = captureMonthSnapshot(db, v);
    expect(r).toEqual({ recorded: 1, skipped: 3, frozen: 0 });
    expect(monthSnapshotSeries(db).map((x) => x.propertyId)).toEqual([B]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]![0])).toContain('ghost-nan');
  });

  it('DST/month boundary: instants straddling ET midnight Oct 31 -> Nov 1 book to the helper-derived month', () => {
    for (const [iso, month] of [['2026-11-01T03:59:00.000Z', '2026-10'], ['2026-11-01T04:00:00.000Z', '2026-11']] as const) {
      const db = freshDb();
      captureMonthSnapshot(db, view(iso));
      const rows = monthSnapshotSeries(db, A);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.month).toBe(easternCalendarDay(iso)!.slice(0, 7));
      expect(rows[0]!.month).toBe(month);
    }
  });
});

describe('describeCaptureOutcome', () => {
  it('is null when rows were recorded or nothing was skipped', () => {
    expect(describeCaptureOutcome({ recorded: 2, skipped: 3, frozen: 0 })).toBeNull();
    expect(describeCaptureOutcome({ recorded: 0, skipped: 0, frozen: 0 })).toBeNull();
  });
  it('warns with the skipped count when nothing was recorded but rows were skipped', () => {
    const m = describeCaptureOutcome({ recorded: 0, skipped: 4, frozen: 0 });
    expect(m).toBe('⚠ Month-snapshot capture recorded 0 rows (skipped 4) — a later month may already exist for these properties');
  });
});
