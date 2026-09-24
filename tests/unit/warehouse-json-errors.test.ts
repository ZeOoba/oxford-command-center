// @vitest-environment node
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { warehouseRoutes } from '../../server/warehouse/api';
import { WAREHOUSE_SUB_ROUTERS } from '../../server/warehouse/sub-routers';
import type { WarehouseDb } from '../../server/warehouse/db';

describe('warehouse routes — uncaught handler errors', () => {
  it('surface as JSON 500, never text/plain (text/plain is misread client-side as "routes not present")', async () => {
    const throwingDb = { prepare: () => { throw new Error('boom'); } } as unknown as WarehouseDb;
    const res = await warehouseRoutes(() => throwingDb).request('/acq/intel');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    expect(await res.json()).toEqual({ error: 'boom' });
  });

  // Coverage for every WAREHOUSE_SUB_ROUTERS entry (server/warehouse/sub-routers.ts —
  // debt/leasing/lease-market/capital/insurance ×2/tax/brain/insights). Each is its own
  // Hono() instance mounted as a SIBLING of warehouseRoutes() directly on server/index.ts's
  // top-level app, not nested inside warehouseRoutes()'s app — so warehouseRoutes()'s own
  // `.onError()` does not cover it. sub-routers.ts's `withJsonErrors` wraps every factory so
  // each sub-router's own app gets the same handler (json-errors.ts). This mounts each
  // (already-wrapped) factory the same way server/index.ts does and proves the wrapping
  // actually took effect for every entry, not just one.
  describe.each(WAREHOUSE_SUB_ROUTERS)('sub-router $prefix', ({ prefix, factory }) => {
    it('surfaces an uncaught handler error as JSON 500 too', async () => {
      const throwingDb = { prepare: () => { throw new Error('boom'); } } as unknown as WarehouseDb;
      const sub = factory(() => throwingDb);
      sub.get('/__boom', () => {
        throw new Error('boom');
      });

      const topLevelApp = new Hono(); // stand-in for server/index.ts's `app`.
      topLevelApp.route(`/api/warehouse${prefix}`, sub);

      const res = await topLevelApp.request(`/api/warehouse${prefix}/__boom`);
      expect(res.status).toBe(500);
      expect(res.headers.get('content-type') ?? '').toContain('application/json');
      expect(await res.json()).toEqual({ error: 'boom' });
    });
  });
});
