// server/warehouse/property-condition-api.ts
//
// Property Condition API sub-router (Phase 2). Mounted at /api/warehouse/property-condition via
// server/warehouse/sub-routers.ts (the single mount table shared with server/index.ts and the bake).
// Route:
//   GET /report — buildPropertyConditionReport() — read-only; never logs calibration verdicts and never
//                 feeds capital-allocation (that wiring is Phase 4, behind refute-financial-change).
// Error policy: 503 when the warehouse is unavailable; 500 on an unexpected engine/parse error.
// Pattern: mirrors tax-api.ts (Hono factory + local `withDb` 503 guard).
import { Hono } from 'hono';
import type { WarehouseDb } from './db';
import { buildPropertyConditionReport } from './property-condition';
import { routeFailure } from './json-errors';

export function propertyConditionApi(getDb: () => WarehouseDb): Hono {
  const app = new Hono();

  app.get('/report', (c) => {
    let db: WarehouseDb;
    try {
      db = getDb();
    } catch {
      return c.json({ error: 'warehouse unavailable' }, 503);
    }
    try {
      const asOf = new Date().toISOString().slice(0, 10);
      return c.json(buildPropertyConditionReport(db, asOf));
    } catch (err) {
      return routeFailure(c, '[property-condition-api] /report error:', err, 'property condition report failed');
    }
  });

  return app;
}
