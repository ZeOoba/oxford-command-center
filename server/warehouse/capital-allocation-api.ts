// server/warehouse/capital-allocation-api.ts
//
// Phase 5 Capital Allocation + Market Intelligence API sub-router.
// Routes:
//   GET /allocate — buildPortfolioAllocation(); wraps as CapitalAllocationResponse
//   GET /market   — buildMarketIntel() per cluster; wraps as MarketIntelResponse
//
// Registration: server/index.ts mounts at /api/warehouse/capital.
// Pattern: mirrors debt-api.ts (Hono factory + withDb 503 guard).
// No financial math lives here; math is in capital-allocation.ts and market-intel.ts.
import { Hono } from 'hono';
import type { WarehouseDb } from './db';
import { buildPortfolioAllocation } from './capital-allocation';
import { buildMarketIntel } from './market-intel';
import { loadCapitalConfig } from './capital-config';
import { getMacro } from '../macro/getMacro';
import {
  CapitalAllocationResponse,
  MarketIntelResponse,
  HurdleRateConfig,
} from '../../src/contracts/capital';
import { verdictsFromAllocations, logVerdicts, computeInputsVersion } from './calibration';
import { todayEastern } from './time-constants';

// ── Cluster enumeration ──────────────────────────────────────────────────────────────────────

interface ClusterRow { cluster: string }

/** All clusters known to the system: property_master markets ∪ market_series clusters. */
function listClusters(db: WarehouseDb): string[] {
  const fromProperties = (db.prepare(
    `SELECT DISTINCT market AS cluster FROM property_master WHERE market IS NOT NULL`,
  ).all() as ClusterRow[]).map((r) => r.cluster);

  const fromSeries = (db.prepare(
    `SELECT DISTINCT cluster FROM market_series`,
  ).all() as ClusterRow[]).map((r) => r.cluster);

  // Deduplicate
  return [...new Set([...fromProperties, ...fromSeries])];
}

// ── Router factory ───────────────────────────────────────────────────────────────────────────

export function capitalAllocationApi(getDb: () => WarehouseDb): Hono {
  const app = new Hono();

  const withDb = (handler: (db: WarehouseDb) => Response | Promise<Response>) => {
    let db: WarehouseDb;
    try { db = getDb(); }
    catch {
      return Promise.resolve(new Response(
        JSON.stringify({ error: 'warehouse unavailable' }),
        { status: 503, headers: { 'content-type': 'application/json' } },
      ));
    }
    return handler(db);
  };

  // GET /allocate
  app.get('/allocate', (c) => withDb(async (db) => {
    try {
      // todayEastern (NOT a UTC slice) — this asOf now anchors real date math inside
      // buildPortfolioAllocation → scoreDebtPositions' fresh maturity recompute; a UTC date would
      // silently diverge from the Eastern convention every other capital-allocation entry point uses.
      const asOf = todayEastern();
      // Spine A snapshot is optional here (fail-open): a missing snapshot just means
      // expectedReturnPct stays null for every verdict, same as pre-v2 behavior.
      const { brain } = await import('../brain');
      const snapshot = await brain.getSnapshot();
      const portfolio = await buildPortfolioAllocation(db, asOf, undefined, snapshot ?? undefined);
      const cfg = loadCapitalConfig(db);
      const hurdleRate = HurdleRateConfig.parse({
        hurdleRatePct: cfg.hurdleRatePct,
        ratification: cfg.hurdleRateRatification,
        ratifiedBy: cfg.hurdleRateRatifiedBy,
        ratifiedDate: cfg.hurdleRateRatifiedDate,
        capitalConfigVersion: cfg.version,
      });
      const response = CapitalAllocationResponse.parse({
        asOf,
        hurdleRate,
        advisoryOnly: portfolio.advisoryOnly,
        portfolio,
      });
      // Log calibration verdicts — fail-open (never blocks the response)
      try {
        const iv = computeInputsVersion(db);
        const calibVerdicts = verdictsFromAllocations(portfolio.verdicts, iv, 'capital-allocation-api');
        logVerdicts(db, calibVerdicts);
      } catch {
        // calibration logging is observational; failure must not 500 the route
      }
      return c.json(response);
    } catch (err) {
      console.error('[capital-api] /allocate error:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'capital allocation failed' }, 500);
    }
  }));

  // GET /market
  app.get('/market', (c) => withDb(async (db) => {
    try {
      const asOf = new Date().toISOString().slice(0, 10);
      const clusters = listClusters(db);
      const macro = await getMacro().catch(() => undefined);
      const settled = await Promise.allSettled(
        clusters.map((cl) => buildMarketIntel(db, cl, asOf, macro)),
      );
      const signals = settled
        .filter((r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof buildMarketIntel>>> => r.status === 'fulfilled')
        .map((r) => r.value);
      return c.json(MarketIntelResponse.parse({ asOf, signals }));
    } catch (err) {
      console.error('[capital-api] /market error:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'market intel failed' }, 500);
    }
  }));

  return app;
}
