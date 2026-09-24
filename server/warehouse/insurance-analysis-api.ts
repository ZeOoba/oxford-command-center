// server/warehouse/insurance-analysis-api.ts
//
// Insurance Re-bid Analysis API sub-router (Phase 4a.3).
//
// Routes:
//   GET / — buildInsuranceAnalysis(asOf=today) + logRebidVerdicts (fail-open calibration logging),
//           InsuranceAnalysisReport.parse'd before returning (H6 read boundary).
//   GET /history — buildPremiumHistory over every property_insurance_policies row (per-line premium
//           terms + policy-year totals), PremiumHistoryReport.parse'd. Read-only display data.
//
// Registration: server/warehouse/sub-routers.ts mounts this at /api/warehouse/insurance/analysis
// (wrapped in withJsonErrors, so uncaught errors return the shared JSON 500).
// Pattern: mirrors debt-api.ts / capital-allocation-api.ts (Hono factory + withDb 503 guard).
// This file holds NO financial math — the engine (insurance-analysis.ts) does.
import { Hono } from 'hono';
import type { WarehouseDb } from './db';
import { buildInsuranceAnalysis, logRebidVerdicts } from './insurance-analysis';
import { buildPremiumHistory } from './insurance-history';
import { InsuranceAnalysisReport, PremiumHistoryReport } from '../../src/contracts/insurance-analysis';

/**
 * Creates the insurance-analysis Hono sub-router.
 *
 * @param getDb - Lazy singleton getter; throws when warehouse is unavailable (cold/mirror env).
 */
export function insuranceAnalysisApi(getDb: () => WarehouseDb): Hono {
  const app = new Hono();

  /** Resolve the warehouse per-request behind a 503 guard. Mirrors debt-api.ts's withDb. */
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
        const report = InsuranceAnalysisReport.parse(buildInsuranceAnalysis(db, asOf));
        try {
          logRebidVerdicts(db, report);
        } catch {
          // Calibration logging is observational; a failure here must not fail the response.
        }
        return c.json(report);
      } catch (err) {
        console.error('[insurance-analysis-api] / error:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'insurance analysis failed' }, 500);
      }
    }),
  );

  // ── GET /history ───────────────────────────────────────────────────────────────────────
  app.get('/history', (c) =>
    withDb((db) => {
      const rows = db.prepare(
        `SELECT property_id, policy_type, effective_date, premium_annual FROM property_insurance_policies`,
      ).all() as Array<{ property_id: string; policy_type: string; effective_date: string | null; premium_annual: number | null }>;
      const masterNames = new Map((db.prepare('SELECT id, name FROM property_master').all() as Array<{ id: string; name: string }>).map((r) => [r.id, r.name]));
      return c.json(PremiumHistoryReport.parse(buildPremiumHistory(rows, masterNames)));
    }),
  );

  return app;
}
