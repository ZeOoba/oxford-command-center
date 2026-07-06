// server/warehouse/insights-api.ts
//
// Insight Engine API sub-router (Lane L2c — registration/wiring only; no new
// generator math lives here).
//
// GET / — synthesizes a CapitalAllocationReport, runs the CF-1 hurdle-drag generator
// (the one live generator today) over it, ranks the resulting candidates, and returns
// an InsightReport envelope (src/contracts/insights.ts).
//
// Snapshot acquisition mirrors GET /capital-allocation in server/warehouse/api.ts
// (~L915-928) exactly: dynamic `import('../brain')` + `brain.getSnapshot()`. The one
// deliberate divergence: that route 503s when the snapshot is absent; this route is
// FAIL-OPEN — a missing Spine-A snapshot only benches the CF family (dataReadiness
// reports it dormant-no-outcomes, sampleN null, candidates: []) and the route still
// returns 200 with an honest, smaller report. Only a genuinely unavailable warehouse
// (getDb() throws) returns 503, matching every other warehouse sub-router.
//
// dataReadiness always carries exactly one entry per family in InsightFamilySchema
// (CF, DR, TE, TR, CR) — no more, no less. DR/TE/TR/CR have no generators yet, so they
// are always reported dormant-no-outcomes with sampleN null. No invented sample counts.
//
// Registration: the orchestrator mounts this at /api/warehouse/insights
// (server/index.ts — not touched by this file).
import { Hono } from 'hono';
import type { WarehouseDb } from './db';
import { buildCapitalAllocationReport } from './capital-allocation';
import { generateCfHurdleDrag } from '../insights/generators/cf-hurdle-drag';
import { rankCandidates } from '../insights/rank';
import {
  InsightReportSchema,
  InsightFamilySchema,
  type DataReadinessEntry,
} from '../../src/contracts/insights';

/** The one live generator's id — surfaced on the CF family's dataReadiness entry
 *  whether it fired (status:'live') or was benched by a missing snapshot
 *  (status:'dormant-no-outcomes'). */
const CF_GENERATOR_ID = 'cf-hurdle-drag';

// ── Router factory ───────────────────────────────────────────────────────────────────────────

/**
 * Creates the insights Hono sub-router.
 *
 * @param getDb - Lazy singleton getter; throws when warehouse is unavailable (cold/mirror env).
 */
export function insightsApi(getDb: () => WarehouseDb): Hono {
  const app = new Hono();

  /** Resolve the warehouse per-request behind a 503 guard. Mirrors the `withDb`
   *  pattern in server/warehouse/api.ts and server/warehouse/debt-api.ts exactly. */
  const withDb = (handler: (db: WarehouseDb) => Response | Promise<Response>) => {
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
    return handler(db);
  };

  // ── GET / ──────────────────────────────────────────────────────────────────────────────────
  app.get('/', (c) =>
    withDb(async (db) => {
      try {
        // Snapshot acquisition — same pattern as GET /capital-allocation in
        // server/warehouse/api.ts. Missing snapshot is fail-open here (see header).
        const { brain } = await import('../brain');
        const snapshot = await brain.getSnapshot();

        let candidates: ReturnType<typeof generateCfHurdleDrag> = [];
        let cfReadiness: DataReadinessEntry;

        if (snapshot) {
          const report = await buildCapitalAllocationReport(db, snapshot);
          candidates = generateCfHurdleDrag(report);
          cfReadiness = { generatorId: CF_GENERATOR_ID, status: 'live', sampleN: candidates.length };
        } else {
          // Fail-open: no Spine-A snapshot means the generator's required input is
          // entirely absent — not merely a low sample count — so sampleN is null
          // (uncountable per the contract's own definition) rather than 0.
          cfReadiness = { generatorId: CF_GENERATOR_ID, status: 'dormant-no-outcomes', sampleN: null };
        }

        const ranked = rankCandidates(candidates);

        // One dataReadiness entry per family in the contract enum — no more, no less.
        // DR/TE/TR/CR have no generators implemented yet (honest, not invented).
        const dataReadiness: DataReadinessEntry[] = InsightFamilySchema.options.map((family) =>
          family === 'CF'
            ? cfReadiness
            : { generatorId: `${family.toLowerCase()}-none`, status: 'dormant-no-outcomes', sampleN: null },
        );

        const report = InsightReportSchema.parse({
          candidates: ranked,
          dataReadiness,
          generatedAt: new Date().toISOString(),
          advisoryOnly: true,
        });
        return c.json(report);
      } catch (err) {
        console.error('[insights-api] / error:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'insight generation failed' }, 500);
      }
    }),
  );

  return app;
}
