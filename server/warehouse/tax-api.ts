// server/warehouse/tax-api.ts
//
// Phase 6 — Property Tax Analysis + Appeals API sub-router (6a.4 / 6a.5).
// Extended in P4c / C2 (Task 9) with the placeholder-driven tax STRATEGY route.
// Routes:
//   GET  /analysis — buildTaxAnalysis() against the latest Spine-A snapshot's indicated values.
//   GET  /strategy — buildTaxStrategyReport() (Task 8): cost-seg / entity-strategy / filed-returns
//                     metadata. Separate handler from /analysis — NEVER calls logVerdicts /
//                     computeInputsVersion (placeholder-tainted inputs must never enter
//                     calibration history; see the route's own comment below).
//   POST /appeals  — TaxAppealInput.parse() → INSERT (id absent) or UPDATE (id present) tax_appeals.
//
// Registration: server/index.ts mounts this at /api/warehouse/tax (orchestrator's job — not
// this file's; this router is exported standalone and never self-mounts).
// Pattern: mirrors debt-api.ts (Hono factory + local `withDb` 503 guard).
//
// Error policy:
//   503 when the warehouse is unavailable.
//   500 on unexpected engine errors.
//   400 on a malformed POST /appeals body; 404 when an update targets a nonexistent id.
import { randomUUID } from 'node:crypto';
import { Hono } from 'hono';
import type { WarehouseDb } from './db';
import { buildTaxAnalysis, verdictsFromTaxOpportunities, type IndicatedPropertyValue } from './tax-analysis';
import { logVerdicts, computeInputsVersion } from './calibration';
import { buildTaxStrategyReport } from './tax-strategy';
import { TaxAnalysisReport, TaxAppeal, TaxAppealInput } from '../../src/contracts/tax';
import { TaxStrategyReport } from '../../src/contracts/tax-strategy';

/**
 * Fail-open Spine-A indicated-value map. Mirrors the /capital-allocation route's snapshot fetch
 * (server/warehouse/api.ts, the `brain.getSnapshot()` pattern) but degrades to an EMPTY map
 * instead of a 503 on a missing/unavailable snapshot — the tax module must still answer with
 * every value-dependent figure honestly `indeterminate` (contracts/tax.ts doctrine), the same
 * degraded state as an empty property_tax_assessments table, rather than blocking the response.
 */
async function loadIndicatedValues(): Promise<ReadonlyMap<string, IndicatedPropertyValue>> {
  try {
    const { brain } = await import('../brain');
    const snapshot = await brain.getSnapshot();
    if (!snapshot) return new Map();
    return new Map(
      snapshot.properties.map((p) => [p.id, { fullAssetValue: p.estValue100, oxfordOwnPct: p.oxfordOwnPct }]),
    );
  } catch {
    return new Map();
  }
}

interface AppealDbRow {
  id: string;
  property_id: string;
  tax_year: number;
  status: string;
  filed_date: string | null;
  est_savings_annual: number | null;
  realized_savings_annual: number | null;
  notes: string | null;
}

function toTaxAppeal(r: AppealDbRow): unknown {
  return {
    id: r.id,
    propertyId: r.property_id,
    taxYear: r.tax_year,
    status: r.status,
    filedDate: r.filed_date,
    estSavingsAnnual: r.est_savings_annual,
    realizedSavingsAnnual: r.realized_savings_annual,
    notes: r.notes,
  };
}

export function taxApi(getDb: () => WarehouseDb): Hono {
  const app = new Hono();

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

  // ── GET /analysis ──────────────────────────────────────────────────────────────────────
  app.get('/analysis', (c) =>
    withDb(async (db) => {
      try {
        const asOf = new Date().toISOString().slice(0, 10);
        const indicatedValues = await loadIndicatedValues();
        const report = buildTaxAnalysis(db, asOf, indicatedValues);
        // Log calibration verdicts — fail-open (never blocks the response).
        try {
          const iv = computeInputsVersion(db);
          const verdicts = verdictsFromTaxOpportunities(report, iv, 'tax-api');
          logVerdicts(db, verdicts);
        } catch {
          // calibration logging is observational; failure must not 500 the route
        }
        return c.json(TaxAnalysisReport.parse(report));
      } catch (err) {
        console.error('[tax-api] /analysis error:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'tax analysis failed' }, 500);
      }
    }),
  );

  // ── GET /strategy ───────────────────────────────────────────────────────────────────────
  // Task 9 (P4c / C2) — wires buildTaxStrategyReport(db, asOf) (Task 8) to HTTP. This is a
  // completely separate handler from GET /analysis above: it deliberately calls NEITHER
  // logVerdicts NOR computeInputsVersion, and never touches calibration_verdict. The
  // tax-strategy engine's cost-seg / entity / filed-return figures are placeholder-tainted by
  // design (server/warehouse/tax-strategy.ts module header) — a placeholder-tainted verdict
  // must never enter calibration history, so no calibration wiring is added here, ever. This
  // does not change or remove /analysis's existing (correct) logVerdicts call above.
  app.get('/strategy', (c) =>
    withDb(async (db) => {
      try {
        const asOf = new Date().toISOString().slice(0, 10);
        const report = buildTaxStrategyReport(db, asOf);
        return c.json(TaxStrategyReport.parse(report));
      } catch (err) {
        console.error('[tax-api] /strategy error:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'tax strategy failed' }, 500);
      }
    }),
  );

  // ── POST /appeals ──────────────────────────────────────────────────────────────────────
  app.post('/appeals', (c) =>
    withDb(async (db) => {
      const parsed = TaxAppealInput.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) {
        return c.json({ error: 'invalid tax appeal', issues: parsed.error.issues }, 400);
      }
      const input = parsed.data;
      try {
        if (input.id !== undefined) {
          const existing = db.prepare('SELECT id FROM tax_appeals WHERE id = ?').get(input.id) as
            | { id: string }
            | undefined;
          if (existing === undefined) {
            return c.json({ error: `appeal ${input.id} not found` }, 404);
          }
          db.prepare(`
            UPDATE tax_appeals
            SET property_id = ?, tax_year = ?, status = ?, filed_date = ?, est_savings_annual = ?,
                realized_savings_annual = ?, notes = ?, updated_at = datetime('now')
            WHERE id = ?
          `).run(
            input.propertyId, input.taxYear, input.status, input.filedDate, input.estSavingsAnnual,
            input.realizedSavingsAnnual, input.notes, input.id,
          );
          const row = db
            .prepare(`
              SELECT id, property_id, tax_year, status, filed_date, est_savings_annual,
                     realized_savings_annual, notes
              FROM tax_appeals WHERE id = ?
            `)
            .get(input.id) as AppealDbRow;
          return c.json(TaxAppeal.parse(toTaxAppeal(row)), 200);
        }

        const id = randomUUID();
        db.prepare(`
          INSERT INTO tax_appeals
            (id, property_id, tax_year, status, filed_date, est_savings_annual, realized_savings_annual, notes, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
        `).run(
          id, input.propertyId, input.taxYear, input.status, input.filedDate, input.estSavingsAnnual,
          input.realizedSavingsAnnual, input.notes,
        );
        return c.json(
          TaxAppeal.parse({
            id,
            propertyId: input.propertyId,
            taxYear: input.taxYear,
            status: input.status,
            filedDate: input.filedDate,
            estSavingsAnnual: input.estSavingsAnnual,
            realizedSavingsAnnual: input.realizedSavingsAnnual,
            notes: input.notes,
          }),
          201,
        );
      } catch (err) {
        console.error('[tax-api] POST /appeals error:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'appeal write failed' }, 500);
      }
    }),
  );

  return app;
}
