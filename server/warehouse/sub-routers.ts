// server/warehouse/sub-routers.ts
//
// Single source of truth for the warehouse's sub-router mount prefixes, consumed by BOTH
// server/index.ts (to mount them on the live app) and scripts/bake-warehouse.ts's
// inProcessResolver (to dispatch a bake request to the right in-process router with no live HTTP
// server). FIXED 2026-08-21 (adversarial review finding): inProcessResolver used to hardcode a
// single BRAIN_PREFIX branch to reach brainApi, leaving the identical "in-process resolver
// doesn't know a sub-router's real mount path" 404 bug latent for every OTHER sub-router below,
// with the '/brain' mount path duplicated as a literal in two files with nothing keeping them in
// sync. Adding a sub-router here now updates both index.ts's mounting and bake-warehouse.ts's
// dispatch table in one place.
import type { Hono } from 'hono';
import type { WarehouseDb } from './db';
import { warehouseJsonError } from './json-errors';
import { debtApi } from './debt-api';
import { leaseForecastApi } from './lease-forecast-api';
import { leaseMarketApi } from './lease-market-api';
import { capitalAllocationApi } from './capital-allocation-api';
import { insuranceAnalysisApi } from './insurance-analysis-api';
import { insuranceLossApi } from './insurance-loss-api';
import { taxApi } from './tax-api';
import { propertyConditionApi } from './property-condition-api';
import { brainApi } from './brain-api';
import { insightsApi } from './insights-api';
import { edgeApi } from '../edge/edge-api';
import { propertyFinancialsApi } from '../property-financials/property-financials-api';

export interface WarehouseSubRouter {
  /** Path segment AFTER '/api/warehouse' (e.g. '/brain', '/insurance/analysis'). */
  prefix: string;
  factory: (getDb: () => WarehouseDb) => Hono;
}

/** Wrap a sub-router factory so its app gets the shared uncaught-error → JSON 500 handler. Each
 *  sub-router is a SIBLING Hono() instance of warehouseRoutes()'s app, so it does not inherit
 *  that app's `.onError()` — see json-errors.ts for the full topology note. */
function withJsonErrors(factory: (getDb: () => WarehouseDb) => Hono): (getDb: () => WarehouseDb) => Hono {
  return (getDb) => {
    const app = factory(getDb);
    app.onError(warehouseJsonError);
    return app;
  };
}

/** Every warehouse sub-router mounted separately from the base warehouseRoutes() app. Order
 *  matters for prefix matching: the two '/insurance/...' entries must be matched before a
 *  hypothetical bare '/insurance' prefix would be (none exists today, but longest-prefix-first
 *  is what keeps prefix matching safe if one is ever added).
 *
 *  Keep each entry a literal `{ prefix: '...', factory: <bareImportedName> }`: scripts/
 *  check-write-schema-drift.ts's buildMountPrefixMap() reads this file as TEXT and resolves each
 *  sub-router's mount path from exactly that shape (tests/unit/sub-routers-mount-prefix.test.ts
 *  guards it). Wrapping the factory inline (`factory: withJsonErrors(debtApi)`) blinded that
 *  gate — 0 of 9 prefixes resolved, so the body-shape cross-check for those routers was silently
 *  skipped with only a warning (2026-09-23 PR-1 review). The JSON-error wrapping is applied in
 *  the exported map below instead. */
const RAW_SUB_ROUTERS: WarehouseSubRouter[] = [
  { prefix: '/debt', factory: debtApi },
  { prefix: '/leasing', factory: leaseForecastApi },
  { prefix: '/lease-market', factory: leaseMarketApi },
  { prefix: '/capital', factory: capitalAllocationApi },
  { prefix: '/insurance/analysis', factory: insuranceAnalysisApi },
  { prefix: '/insurance/loss', factory: insuranceLossApi },
  { prefix: '/tax', factory: taxApi },
  { prefix: '/property-condition', factory: propertyConditionApi },
  { prefix: '/brain', factory: brainApi },
  { prefix: '/insights', factory: insightsApi },
  { prefix: '/edge', factory: edgeApi },
  { prefix: '/property-financials', factory: propertyFinancialsApi },
];

export const WAREHOUSE_SUB_ROUTERS: WarehouseSubRouter[] = RAW_SUB_ROUTERS.map((e) => ({
  ...e,
  factory: withJsonErrors(e.factory),
}));
