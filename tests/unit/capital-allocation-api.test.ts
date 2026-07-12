// @vitest-environment node
import { describe, it, expect, vi, beforeAll, afterEach } from 'vitest';
import { tmpdir } from 'node:os';
import { mkdtempSync } from 'node:fs';
import { join } from 'node:path';
import { openWarehouse } from '../../server/warehouse/db';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import { CapitalAllocationResponse, MarketIntelResponse } from '../../src/contracts/capital';

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

const openedDbs: ReturnType<typeof openWarehouse>[] = [];

function freshDb() {
  const dir = mkdtempSync(join(tmpdir(), 'cap-api-test-'));
  const db = openWarehouse(join(dir, 'test.sqlite'));
  seedPropertyMaster(db);
  openedDbs.push(db);
  return db;
}

describe('capitalAllocationApi', () => {
  // Root cause (2026-07-12, systematic-debugging): the /allocate route dynamically
  // `import('../brain')`s on the hot path (server/warehouse/capital-allocation-api.ts).
  // With per-file isolation (vitest.config.ts `isolate: true`), this file's module
  // registry is fresh, so R-1 pays that dynamic import's full module-resolution/
  // compile/eval cost INSIDE the timed test body on its first call -- measured at
  // 1278ms standalone (plain node, no vitest overhead) and up to 5000ms+ under
  // concurrent suite load, occasionally exceeding the 5s default test timeout.
  // brain.ts pulls in chokidar + workbook parsing + quickbooks + contracts/index --
  // a real module-load cost, not a bug in the route's own logic (confirmed: imports,
  // openWarehouse migrations, and seedPropertyMaster together cost ~126ms; the dynamic
  // import + snapshot lookup is the other ~1.1s+).
  // Fix: pay that cost once here, in beforeAll (untimed setup), not inside a timed
  // `it(...)`. This does not touch the route handler -- the dynamic-import pattern is
  // used identically in 5 other files (api.ts x3, insights-api.ts, lease-forecast-api.ts,
  // tax-api.ts) with no documented reason it must be dynamic rather than static, so
  // changing the import style itself is a separate, wider decision than this test fix.
  beforeAll(async () => {
    await import('../../server/brain');
  });

  afterEach(() => {
    for (const db of openedDbs) db.close();
    openedDbs.length = 0;
    vi.clearAllMocks();
  });

  it('R-1: GET /allocate → 200 with valid CapitalAllocationResponse', async () => {
    const { capitalAllocationApi } = await import('../../server/warehouse/capital-allocation-api');
    const db = freshDb();
    const router = capitalAllocationApi(() => db);
    const req = new Request('http://localhost/allocate');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const body = CapitalAllocationResponse.parse(await res.json());
    expect(typeof body.hurdleRate.hurdleRatePct).toBe('number');
  });

  it('R-2: GET /market → 200 with valid MarketIntelResponse', async () => {
    const { capitalAllocationApi } = await import('../../server/warehouse/capital-allocation-api');
    const db = freshDb();
    const router = capitalAllocationApi(() => db);
    const req = new Request('http://localhost/market');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const body = MarketIntelResponse.parse(await res.json());
    expect(Array.isArray(body.signals)).toBe(true);
  });

  it('R-3: warehouse unavailable → 503', async () => {
    const { capitalAllocationApi } = await import('../../server/warehouse/capital-allocation-api');
    const router = capitalAllocationApi(() => { throw new Error('no warehouse'); });
    const req = new Request('http://localhost/allocate');
    const res = await router.fetch(req);
    expect(res.status).toBe(503);
  });

  it('R-4: ratified hurdle config → advisoryOnly=false', async () => {
    const { capitalAllocationApi } = await import('../../server/warehouse/capital-allocation-api');
    const db = freshDb();
    // Default compile-time fallback has hurdleRateRatification='ratified' (ratified 2026-06-22)
    const router = capitalAllocationApi(() => db);
    const req = new Request('http://localhost/allocate');
    const res = await router.fetch(req);
    expect(res.status).toBe(200);
    const body = await res.json() as unknown;
    const obj = body as Record<string, unknown> | undefined;
    expect(obj?.['advisoryOnly']).toBe(false);
  });
});
