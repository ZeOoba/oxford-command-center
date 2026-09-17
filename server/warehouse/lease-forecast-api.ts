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
// Market rents (fix round 1 ruling A; fix round 2 ruling 6): the lease-market feed
// (server/warehouse/lease-market/feed.ts) is READ-ONLY INFORMATIONAL CONTEXT for /forecast's
// marketRentGaps display ONLY — it is NEVER merged into the marketRents passed to rentForecast
// (POST /rent-forecast's renew_at_market projects NOI, and an asking-rent × SF figure must never be
// presented as NOI), and GET /narrative no longer reads it at all (the AI narrative should describe
// only real, human-confirmed market intel, not an automated asking-rent feed); marketRentGaps' own
// provenance !== 'derived-asking' filter on topGaps stays as defense regardless.
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
import { loadMarketRentFeed } from './lease-market/feed';
import { referenceDate } from '../config';
import {
  RentForecastInput,
  LeaseForecastResponse,
  RentForecastResponse,
  LeaseNarrativeResponse,
  type RentScenario,
} from '../../src/contracts/lease-forecast';
import { composeLeaseNarrative } from '../ai/narrative';

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

  /**
   * Lease-market feed read through ONE guarded helper, used by GET /forecast ONLY (fix round 2
   * ruling 6 dropped it from GET /narrative; POST /rent-forecast never used it, see the header
   * note above). {} on ANY failure (warehouse unavailable, or a read error against an available
   * warehouse) — the feed is optional context, never a hard dependency, so a feed-read failure
   * must not 500 a route that would otherwise succeed.
   */
  function feedOrEmpty(): Record<string, number> {
    try {
      return loadMarketRentFeed(getDb());
    } catch (err) {
      console.warn('[lease-forecast-api] lease-market feed unavailable:', err instanceof Error ? err.message : String(err));
      return {};
    }
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

        const asOf = snapshot.meta.asOf; // data-snapshot LABEL (response envelope)
        // Run-date reference for expiry day-count surfaces (portfolio-wide run-date basis).
        const refDate = referenceDate();
        const leases = snapshot.leases;
        const arrears = snapshot.tenantArrears ?? {};
        const marketRents = (snapshot as typeof snapshot & { marketRents?: Record<string, number> }).marketRents ?? {};

        const signals = renewalSignals(leases, refDate, snapshot.renewalStages, arrears);
        const velocity = leasingVelocity(db, snapshot.properties);
        const marketGapsAll = marketRentGaps(leases, marketRents, feedOrEmpty());

        // Expiry bucket totals
        const ALL_BUCKETS = ['0-6m', '6-12m', '12-24m', '24m+', 'expired', 'unknown'] as const;
        const bucketMap = new Map<string, { count: number; expiringRent: number; expiringSf: number }>();
        for (const bucket of ALL_BUCKETS) bucketMap.set(bucket, { count: 0, expiringRent: 0, expiringSf: 0 });
        for (const l of leases) {
          const bucket = bucketExpiry(l.monthsToExpiry, l.leaseEnd, refDate);
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
      const asOf = snapshot.meta.asOf; // data-snapshot LABEL (response envelope)
      // Forecast origin ("N months from here") = the RUN date, not the workbook data date.
      const refDate = referenceDate();
      const leases = snapshot.leases;
      const marketRents = (snapshot as typeof snapshot & { marketRents?: Record<string, number> }).marketRents ?? {};

      // CRITICAL (fix round 1 ruling A): manual overlay marketRents ONLY -- never the lease-market
      // feed. renew_at_market drives an NOI projection, and the global constraint "never present an
      // asking-rent × SF figure as NOI" overrides any convenience of merging the feed in here.
      const results = [];
      for (const scenario of scenarios) {
        const inputResult = RentForecastInput.safeParse({ scenario, horizonMonths, vacancyPct });
        if (!inputResult.success) {
          return c.json({ error: `Invalid input: ${inputResult.error.message}` }, 400);
        }
        results.push(rentForecast(leases, refDate, inputResult.data, marketRents));
      }

      const response = RentForecastResponse.parse({ asOf, results });
      return c.json(response);
    } catch (err) {
      console.error('[lease-forecast-api] /rent-forecast error:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'rent forecast failed' }, 500);
    }
  });

  // ── GET /narrative ─────────────────────────────────────────────────────────
  //
  // Returns an AI-generated leasing intelligence narrative block.
  // Degrades gracefully (null narrative + degraded:true) when AI unavailable.
  // Does NOT require warehouse (Spine A only) — no withDb wrapper needed.
  //
  // H6 read boundary: response parsed through LeaseNarrativeResponse before emitting.
  app.get('/narrative', async (_c) => {
    try {
      const snapshot = await getCurrentSnapshot();
      if (!snapshot) {
        return new Response(JSON.stringify({ error: 'snapshot unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        });
      }

      const asOf = snapshot.meta.asOf; // data-snapshot LABEL (response envelope + AI input)
      const refDate = referenceDate(); // run-date reference for expiry day-count surfaces
      const leases = snapshot.leases;
      const marketRents = (snapshot as typeof snapshot & { marketRents?: Record<string, number> }).marketRents ?? {};
      const arrears = snapshot.tenantArrears ?? {};

      // Fix round 2 ruling 6: /narrative does NOT read the lease-market feed at all (manual overlay
      // marketRents only) -- the AI narrative should describe only real, human-confirmed market
      // intel, never an automated asking-rent feed.
      const signals = renewalSignals(leases, refDate, snapshot.renewalStages, arrears);
      const marketGapsAll = marketRentGaps(leases, marketRents);

      const likelyCt    = signals.filter((s) => s.likelihood === 'likely').length;
      const uncertainCt = signals.filter((s) => s.likelihood === 'uncertain').length;
      const atRiskCt    = signals.filter((s) => s.likelihood === 'at-risk').length;
      const lapsingCt   = signals.filter((s) => s.likelihood === 'lapsing').length;

      const nearTermRent = leases
        .filter((l) => bucketExpiry(l.monthsToExpiry, l.leaseEnd, refDate) === '0-6m')
        .reduce((s, l) => s + l.annualRent, 0);

      // Anonymize propertyKey → ordinal label before sending to AI (invariant 7: no raw
      // owned-asset identifiers egress to the external API; only aggregated/ordinal data).
      // derived-asking (lease-market feed) gaps are excluded (fix round 1 ruling B) as DEFENSE IN
      // DEPTH: marketGapsAll above is built from marketRentGaps(leases, marketRents) with no
      // feedRents argument (ruling 6), so no gap here should ever actually carry 'derived-asking'
      // provenance -- but if that ever changes, the AI narrative must still never describe an
      // asking-rent-derived gap as a market gap.
      const topGaps = marketGapsAll
        .filter((g) => g.gapPsf !== null && g.provenance !== 'derived-asking')
        .sort((a, b) => Math.abs(b.gapPsf ?? 0) - Math.abs(a.gapPsf ?? 0))
        .slice(0, 5)
        .map((g, i) => ({ propertyKey: `gap-${i + 1}`, gapPsf: g.gapPsf!, underMarket: g.underMarket }));

      const input = {
        asOf,
        propertyCount: snapshot.properties.length,
        signalSummary: { likelyCt, uncertainCt, atRiskCt, lapsingCt, nearTermExpiryRent: nearTermRent },
        topGaps,
        // slowLeasingProperties: intentionally empty — wiring from warehouse velocity deferred
        // (requires withDb); omit raw property names from AI egress (invariant 7).
        slowLeasingProperties: [] as string[],
      };

      const { narrative, degraded } = await composeLeaseNarrative(input, {
        apiKey: process.env.ANTHROPIC_API_KEY,
      });

      // Use safeParse so a malformed compose result degrades to { degraded:true } via the
      // catch block rather than throwing and returning HTTP 500 (Defect D4 from refute pass).
      const envelope = LeaseNarrativeResponse.safeParse({ asOf, narrative, degraded });
      if (!envelope.success) {
        return new Response(
          JSON.stringify({ asOf, narrative: null, degraded: true }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }

      return new Response(
        JSON.stringify(envelope.data),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    } catch (err) {
      console.error('[lease-forecast-api] /narrative error:', err instanceof Error ? err.message : String(err));
      return new Response(JSON.stringify({ error: 'narrative generation failed' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      });
    }
  });

  return app;
}
