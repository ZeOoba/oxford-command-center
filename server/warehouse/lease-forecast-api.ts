// server/warehouse/lease-forecast-api.ts
//
// Phase 3 W1 — Lease Forecast API sub-router.
//
// Routes:
//   GET  /forecast      — LeaseForecastResponse (signals + velocity + marketGaps + bucketTotals)
//   GET  /velocity      — { velocity: LeasingVelocity[] }
//   POST /rent-forecast — RentForecastResponse (one result per requested scenario)
//
// Registration: server/index.ts mounts this at /api/warehouse/leasing.
// This file holds NO financial math — it is pure route-plumbing and dispatch.
// Math lives in src/analytics/lease-forecast.ts and server/warehouse/lease-velocity.ts.
// Added to DELIVERY_ONLY_PATHS in scripts/check-refute-required.ts.
//
// Error policy (mirrors debt-api.ts):
//   503 when warehouse unavailable (leasingVelocity needs DB).
//   400 on Zod parse failure of the POST body.
//   500 on unexpected engine errors.
//
// Confidentiality: routes emit derived signals + rent-roll figures for owned assets only.
// No confidential-deal data is in scope for this module.
import { Hono } from 'hono';
import type { WarehouseDb } from './db';
import {
  renewalSignals,
  marketRentGaps,
  rentForecast,
  bucketExpiry,
} from '../../src/analytics/lease-forecast';
import { leasingVelocity } from './lease-velocity';
import {
  RentForecastInput,
  LeaseForecastResponse,
  RentForecastResponse,
  type RentScenario,
} from '../../src/contracts/lease-forecast';

// ── Snapshot access ────────────────────────────────────────────────────────────

/** Returns the current live snapshot from the server brain singleton. */
async function getCurrentSnapshot() {
  // Dynamic import to avoid circular dependency at module load.
  // brain.getSnapshot() returns the latest parsed workbook snapshot (null if unparsed).
  const { brain } = await import('../brain');
  return brain.getSnapshot();
}

// ── Router factory ─────────────────────────────────────────────────────────────

/**
 * Creates the lease-forecast Hono sub-router.
 *
 * @param getDb - Lazy singleton getter; throws when warehouse is unavailable.
 */
export function leaseForecastApi(getDb: () => WarehouseDb): Hono {
  const app = new Hono();

  /** Resolve the warehouse behind a 503 guard. Mirrors debt-api.ts withDb. */
  function withDb(handler: (db: WarehouseDb) => Response | Promise<Response>): Promise<Response> {
    let db: WarehouseDb;
    try {
      db = getDb();
    } catch {
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'warehouse unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(handler(db));
  }

  // ── GET /forecast ──────────────────────────────────────────────────────────
  //
  // Returns renewal signals, leasing velocity, market-rent gaps, and expiry-bucket totals.
  // Velocity requires the warehouse (Spine B). All other fields are Spine A (snapshot).
  //
  // H6 read boundary: response is parsed through LeaseForecastResponse before emitting.
  app.get('/forecast', (c) =>
    withDb(async (db) => {
      try {
        const snapshot = await getCurrentSnapshot();
        if (!snapshot) {
          return new Response(JSON.stringify({ error: 'snapshot unavailable' }), {
            status: 503,
            headers: { 'content-type': 'application/json' },
          });
        }

        const asOf = snapshot.meta.asOf;
        const leases = snapshot.leases;
        const arrears = snapshot.tenantArrears ?? {};
        const marketRents = (snapshot as typeof snapshot & { marketRents?: Record<string, number> }).marketRents ?? {};

        const signals = renewalSignals(leases, asOf, snapshot.renewalStages, arrears);
        const velocity = leasingVelocity(db, snapshot.properties);
        const marketGapsAll = marketRentGaps(leases, marketRents);

        // Expiry bucket totals
        const ALL_BUCKETS = ['0-6m', '6-12m', '12-24m', '24m+', 'expired', 'unknown'] as const;
        const bucketMap = new Map<string, { count: number; expiringRent: number; expiringSf: number }>();
        for (const bucket of ALL_BUCKETS) bucketMap.set(bucket, { count: 0, expiringRent: 0, expiringSf: 0 });
        for (const l of leases) {
          const bucket = bucketExpiry(l.monthsToExpiry, l.leaseEnd, asOf);
          const b = bucketMap.get(bucket)!;
          b.count++;
          b.expiringRent += l.annualRent;
          b.expiringSf += l.sf;
        }
        const bucketTotals = ALL_BUCKETS.map((bucket) => ({
          bucket,
          ...bucketMap.get(bucket)!,
        }));

        const response = LeaseForecastResponse.parse({
          asOf,
          signals,
          velocity,
          marketGaps: marketGapsAll,
          bucketTotals,
        });
        return c.json(response);
      } catch (err) {
        console.error('[lease-forecast-api] /forecast error:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'lease forecast failed' }, 500);
      }
    }),
  );

  // ── GET /velocity ──────────────────────────────────────────────────────────
  //
  // Returns leasing velocity per property from the warehouse.
  // Spine B — returns null medians where insufficient history.
  app.get('/velocity', (c) =>
    withDb(async (db) => {
      try {
        const snapshot = await getCurrentSnapshot();
        const properties = snapshot?.properties ?? [];
        const velocity = leasingVelocity(db, properties);
        return c.json({ velocity });
      } catch (err) {
        console.error('[lease-forecast-api] /velocity error:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'velocity query failed' }, 500);
      }
    }),
  );

  // ── POST /rent-forecast ────────────────────────────────────────────────────
  //
  // Body: { scenarios?: RentScenario[]; horizonMonths?: 12|24; vacancyPct?: number }
  // Defaults to all three scenarios when `scenarios` is absent.
  //
  // H6 read boundary: body is validated via RentForecastInput (Zod); response via RentForecastResponse.
  app.post('/rent-forecast', async (c) => {
    try {
      const snapshot = await getCurrentSnapshot();
      if (!snapshot) {
        return c.json({ error: 'snapshot unavailable' }, 503);
      }

      let body: { scenarios?: RentScenario[]; horizonMonths?: 12 | 24; vacancyPct?: number };
      try {
        body = (await c.req.json()) as typeof body;
      } catch {
        body = {};
      }

      const ALL_SCENARIOS: RentScenario[] = ['renew_at_current', 'renew_at_market', 'vacancy_haircut'];
      const scenarios = Array.isArray(body.scenarios) ? body.scenarios : ALL_SCENARIOS;
      const horizonMonths = body.horizonMonths ?? 12;
      const vacancyPct = body.vacancyPct ?? 0;
      const asOf = snapshot.meta.asOf;
      const leases = snapshot.leases;
      const marketRents = (snapshot as typeof snapshot & { marketRents?: Record<string, number> }).marketRents ?? {};

      const results = [];
      for (const scenario of scenarios) {
        const inputResult = RentForecastInput.safeParse({ scenario, horizonMonths, vacancyPct });
        if (!inputResult.success) {
          return c.json({ error: `Invalid input: ${inputResult.error.message}` }, 400);
        }
        results.push(rentForecast(leases, asOf, inputResult.data, marketRents));
      }

      const response = RentForecastResponse.parse({ asOf, results });
      return c.json(response);
    } catch (err) {
      console.error('[lease-forecast-api] /rent-forecast error:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'rent forecast failed' }, 500);
    }
  });

  return app;
}
