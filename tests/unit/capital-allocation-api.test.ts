// @vitest-environment node
import { describe, it, expect, vi, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { openWarehouse } from '../../server/warehouse/db';
import { seedPropertyMaster } from '../../server/warehouse/property-master';

vi.mock('../../server/macro/getMacro', () => ({
  getMacro: vi.fn().mockResolvedValue({
    asOf: '2026-06-21',
    source: 'mock' as const,
    indicators: [
      { id: 'DGS5', label: '5Y Treasury', value: 4.2, unit: '%', change: null },
      { id: 'DGS10', label: '10Y Treasury', value: 4.5, unit: '%', change: null },
      { id: 'CPIAUCSL', label: 'CPI', value: 3.2, unit: '%', change: null },
    ],
    tenYearHistory: [],
  }),
}));

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'cap-api-test-'));
  const db = openWarehouse(join(dir, 'test.sqlite'));
  seedPropertyMaster(db);
  return db;
}

describe('capitalAllocationApi', () => {
  afterEach(() => { vi.clearAllMocks(); });

  it('R-1: GET /allocate → 200 with valid CapitalAllocationResponse', async () => {
    const { capitalAllocationApi } = await import('../../server/warehouse/capital-allocation-api');
    const db = freshDb();
    const router = capitalAllocationApi(() => db);
    const req = new Request('http://localhost/allocate');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    expect(body).toBeDefined();
    const obj = body as Record<string, unknown>;
    expect(obj).toHaveProperty('asOf');
    expect(obj).toHaveProperty('hurdleRate');
    expect(obj).toHaveProperty('portfolio');
    const hurdleRate = obj['hurdleRate'] as Record<string, unknown> | undefined;
    expect(hurdleRate).toBeDefined();
    expect(typeof hurdleRate!['hurdleRatePct']).toBe('number');
  });

  it.skip('R-2: GET /market → 200 with valid MarketIntelResponse', async () => {
    const { capitalAllocationApi } = await import('../../server/warehouse/capital-allocation-api');
    const db = freshDb();
    const router = capitalAllocationApi(() => db);
    const req = new Request('http://localhost/market');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json() as Record<string, unknown>;
    expect(body).toHaveProperty('asOf');
    expect(Array.isArray(body['signals'])).toBe(true);
  });

  it('R-3: warehouse unavailable → 503', async () => {
    const { capitalAllocationApi } = await import('../../server/warehouse/capital-allocation-api');
    const router = capitalAllocationApi(() => { throw new Error('no warehouse'); });
    const req = new Request('http://localhost/allocate');
    const res = await router.fetch(req);
    expect(res.status).toBe(503);
  });

  it('R-4: proposed hurdle config → advisoryOnly=true', async () => {
    const { capitalAllocationApi } = await import('../../server/warehouse/capital-allocation-api');
    const db = freshDb();
    // Default compile-time fallback has hurdleRateRatification='proposed'
    const router = capitalAllocationApi(() => db);
    const req = new Request('http://localhost/allocate');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    const obj = body as Record<string, unknown> | undefined;
    expect(obj?.['advisoryOnly']).toBe(true);
  });
});
