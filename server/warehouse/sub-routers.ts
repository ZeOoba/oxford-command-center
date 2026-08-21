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
import { debtApi } from './debt-api';
import { leaseForecastApi } from './lease-forecast-api';
import { capitalAllocationApi } from './capital-allocation-api';
import { insuranceAnalysisApi } from './insurance-analysis-api';
import { insuranceLossApi } from './insurance-loss-api';
import { taxApi } from './tax-api';
import { brainApi } from './brain-api';
import { insightsApi } from './insights-api';

export interface WarehouseSubRouter {
  /** Path segment AFTER '/api/warehouse' (e.g. '/brain', '/insurance/analysis'). */
  prefix: string;
  factory: (getDb: () => WarehouseDb) => Hono;
}

/** Every warehouse sub-router mounted separately from the base warehouseRoutes() app. Order
 *  matters for prefix matching: the two '/insurance/...' entries must be matched before a
 *  hypothetical bare '/insurance' prefix would be (none exists today, but longest-prefix-first
 *  is what keeps prefix matching safe if one is ever added). */
export const WAREHOUSE_SUB_ROUTERS: WarehouseSubRouter[] = [
  { prefix: '/debt', factory: debtApi },
  { prefix: '/leasing', factory: leaseForecastApi },
  { prefix: '/capital', factory: capitalAllocationApi },
  { prefix: '/insurance/analysis', factory: insuranceAnalysisApi },
  { prefix: '/insurance/loss', factory: insuranceLossApi },
  { prefix: '/tax', factory: taxApi },
  { prefix: '/brain', factory: brainApi },
  { prefix: '/insights', factory: insightsApi },
];
