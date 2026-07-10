// server/warehouse/insurance-loss-api.ts
//
// Insurance LOSS reasoning layer API sub-router (Phase 4c placeholder buildout, Task 5).
//
// Routes:
//   GET / — buildInsuranceAnalysis(asOf=today) for the deduped policy register, resolveDecPages /
//           resolveLossEvents (Task 2's warehouse-first, placeholder-fallback resolvers), then
//           buildInsuranceLossReport (Task 4's pure engine), InsuranceLossReport.parse'd before
//           returning (H6 read boundary, mirrors insuranceAnalysisApi).
//
// POLICY LIST SOURCE (resolved ambiguity — verified by reading insurance-analysis.ts):
// buildInsuranceAnalysis's `renewalCalendar` IS the complete deduped PolicyEconomics list — it is
// built as `const renewalCalendar = [...policies].sort(...)`, an unfiltered copy of the full
// `policies: PolicyEconomics[]` array, just sorted by expiry. No new exported helper is needed;
// `rebidCandidates` would be the WRONG field here (it's filtered to excess>0 policies only).
//
// Registration: server/index.ts mounts this at /api/warehouse/insurance/loss (not this file's
// concern — see the ARCHITECT-OWNED mount line there).
// Pattern: mirrors insurance-analysis-api.ts (Hono factory + withDb 503 guard). This file holds NO
// financial math — the engine (insurance-loss-analysis.ts) does.
//
// CALIBRATION GUARD (hard requirement): this route imports NOTHING from calibration.ts and never
// writes to calibration_verdict. buildInsuranceAnalysis itself has no calibration side effect (only
// insuranceAnalysisApi's own handler separately calls logRebidVerdicts after it) — this file simply
// never imports that function. No logVerdicts on this route — placeholder-tainted verdicts must
// never enter calibration history. When lossDataSource === 'warehouse' && decPageDataSource ===
// 'warehouse', a future phase may add it.
import { Hono } from 'hono';
import type { WarehouseDb } from './db';
import { buildInsuranceAnalysis } from './insurance-analysis';
import { resolveDecPages, resolveLossEvents } from './placeholder-data';
import { buildInsuranceLossReport } from './insurance-loss-analysis';
import { InsuranceLossReport } from '../../src/contracts/insurance-loss';

/**
 * Creates the insurance-loss Hono sub-router.
 *
 * @param getDb - Lazy singleton getter; throws when warehouse is unavailable (cold/mirror env).
 */
export function insuranceLossApi(getDb: () => WarehouseDb): Hono {
  const app = new Hono();

  /** Resolve the warehouse per-request behind a 503 guard. Mirrors insurance-analysis-api.ts's withDb. */
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

  // ── GET / ──────────────────────────────────────────────────────────────────────────────
  app.get('/', (c) =>
    withDb((db) => {
      try {
        const asOf = new Date().toISOString().slice(0, 10);
        const base = buildInsuranceAnalysis(db, asOf);
        const report = InsuranceLossReport.parse(
          buildInsuranceLossReport({
            asOf,
            policies: base.renewalCalendar,
            decPages: resolveDecPages(db),
            lossEvents: resolveLossEvents(db),
          }),
        );
        // No logVerdicts on this route — placeholder-tainted verdicts must never enter calibration
        // history. When lossDataSource === 'warehouse' && decPageDataSource === 'warehouse', a
        // future phase may add it.
        return c.json(report);
      } catch (err) {
        console.error('[insurance-loss-api] / error:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'insurance loss analysis failed' }, 500);
      }
    }),
  );

  return app;
}
