// tests/unit/warehouse-trends-history-api.test.ts
//
// Portfolio Trends Wave 2 — GET /analytics/trends/history (monthly snapshot series read API).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Lease } from '@contracts/index';
import { TrendsHistoryResponseSchema } from '@contracts/trends';
import { warehouseRoutes } from '../../server/warehouse/api';
import { openWarehouse } from '../../server/warehouse/db';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { captureMonthSnapshot, type MonthSnapshotView } from '../../server/warehouse/month-snapshot';

const A = '1100-rarig-ave-columbus-oh';
const B = '3540-e-5th-ave-columbus-oh';

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'wh-trends-api-'));
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

function view(generatedAt: string): MonthSnapshotView {
  return {
    properties: [
      { id: A, sf: 20000, occPct: 0.6, type: 'Flex' },
      { id: B, sf: 10000, occPct: 0.6, type: 'Flex' },
    ],
    leases: [
      lease({ id: 'a1', propertyId: A, sf: 5000, monthlyRent: 5000 }),
      lease({ id: 'b1', propertyId: B, sf: 4000, monthlyRent: 3000 }),
    ],
    meta: { generatedAt },
  };
}

function seeded() {
  const db = freshDb();
  captureMonthSnapshot(db, view('2026-09-15T15:00:00.000Z'));
  captureMonthSnapshot(db, view('2026-10-02T15:00:00.000Z'));
  return db;
}

describe('GET /analytics/trends/history', () => {
  it('200, parses with the schema, ordered property-then-month, frozen is boolean', async () => {
    const app = warehouseRoutes(() => seeded());
    const res = await app.request('/analytics/trends/history');
    expect(res.status).toBe(200);
    const body = TrendsHistoryResponseSchema.parse(await res.json());
    expect(body.points).toHaveLength(4);
    const keys = body.points.map((p) => `${p.propertyId}|${p.month}`);
    expect(keys).toEqual([...keys].sort());
    expect(new Set(body.points.map((p) => p.propertyId))).toEqual(new Set([A, B]));
    for (const p of body.points) expect(typeof p.frozen).toBe('boolean');
  });

  it('empty table → { points: [] }', async () => {
    const app = warehouseRoutes(() => freshDb());
    const res = await app.request('/analytics/trends/history');
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ points: [] });
  });

  it('?propertyId= filters to one property', async () => {
    const app = warehouseRoutes(() => seeded());
    const res = await app.request(`/analytics/trends/history?propertyId=${B}`);
    const body = TrendsHistoryResponseSchema.parse(await res.json());
    expect(body.points).toHaveLength(2);
    expect(body.points.every((p) => p.propertyId === B)).toBe(true);
  });

  it('unknown/garbage propertyId → { points: [] }, not 500', async () => {
    const app = warehouseRoutes(() => seeded());
    for (const id of ['no-such-property', "x'; DROP TABLE portfolio_month_snapshot;--", '%00']) {
      const res = await app.request(`/analytics/trends/history?propertyId=${encodeURIComponent(id)}`);
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ points: [] });
    }
  });

  it('warehouse unavailable → 503 {error:"warehouse unavailable"}', async () => {
    const app = warehouseRoutes(() => {
      throw new Error('cannot open warehouse db');
    });
    const res = await app.request('/analytics/trends/history');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'warehouse unavailable' });
  });
});
