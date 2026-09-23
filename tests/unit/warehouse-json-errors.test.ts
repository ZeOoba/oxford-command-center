// @vitest-environment node
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import { warehouseRoutes } from '../../server/warehouse/api';
import type { WarehouseDb } from '../../server/warehouse/db';

describe('warehouse routes — uncaught handler errors', () => {
  it('surface as JSON 500, never text/plain (text/plain is misread client-side as "routes not present")', async () => {
    const throwingDb = { prepare: () => { throw new Error('boom'); } } as unknown as WarehouseDb;
    const res = await warehouseRoutes(() => throwingDb).request('/acq/intel');
    expect(res.status).toBe(500);
    expect(res.headers.get('content-type') ?? '').toContain('application/json');
    expect(await res.json()).toEqual({ error: 'boom' });
  });

  // Named-risk check (controller notes, task-2-brief): server/index.ts mounts each
  // WAREHOUSE_SUB_ROUTERS entry (server/warehouse/sub-routers.ts — debt/leasing/capital/
  // insurance/tax/brain/insights) as a SIBLING of warehouseRoutes() on the top-level app:
  //   app.route('/api/warehouse', warehouseRoutes(getWarehouse));
  //   for (...) app.route(`/api/warehouse${prefix}`, factory(getWarehouse));
  // A sub-router is its own Hono() instance, not a route nested inside warehouseRoutes()'s
  // app, so the onError set on THAT app (added above) does not apply to it — only an
  // onError set on the sub-router's own instance would. None of the sub-router factories
  // currently call .onError(). This reproduces that exact topology with a synthetic
  // sub-router (no import of, or change to, the real sub-router files) to prove the gap
  // without relying on any one sub-router's internal try/catch choices.
  it('does NOT cover a sub-router mounted the way server/index.ts mounts WAREHOUSE_SUB_ROUTERS (gap, not fixed by this task)', async () => {
    const throwingDb = { prepare: () => { throw new Error('boom'); } } as unknown as WarehouseDb;
    const getDb = () => throwingDb;

    const topLevelApp = new Hono(); // stand-in for server/index.ts's `app` (no onError set there).
    topLevelApp.route('/api/warehouse', warehouseRoutes(getDb));

    const syntheticSubRouter = new Hono(); // stand-in for one WAREHOUSE_SUB_ROUTERS factory.
    syntheticSubRouter.get('/scores', () => {
      throw new Error('boom');
    });
    topLevelApp.route('/api/warehouse/debt', syntheticSubRouter);

    const res = await topLevelApp.request('/api/warehouse/debt/scores');
    expect(res.status).toBe(500);
    // This is the bug this task fixes for warehouseRoutes' OWN routes, still reproduced here:
    // Hono's default error response is text/plain, not JSON.
    expect(res.headers.get('content-type') ?? '').not.toContain('application/json');
  });
});
