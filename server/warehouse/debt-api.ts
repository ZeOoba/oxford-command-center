// server/warehouse/debt-api.ts
//
// Phase 2 Step 5 — Debt/Refi API sub-router.
//
// Routes:
//   GET /scores   — scoreDebtPositions() across all active loans; FRED DGS5 is non-fatal when null
//   GET /maturity — maturity ladder: active loans bucketed into 4 time horizons
//
// Registration: server/index.ts mounts this at /api/warehouse/debt (additive; see status.json).
//
// CONFIDENTIALITY: raw loan terms (rate, balance, lender) never cross the route boundary.
//   /scores emits derived signals only (signal, headroom, band) — per migration 009 comment.
//   /maturity emits maturity date + bucket + signal — no rates, no balances.
//
// Error policy:
//   - 503 when warehouse is unavailable (same pattern as warehouseRoutes).
//   - FRED unavailability → scores still return (signals may all be 'hold' due to null market rate).
//   - 500 on unexpected engine errors.
import { Hono } from 'hono';
import type { WarehouseDb } from './db';
import { scoreDebtPositions } from './debt-scoring';
import { propertyPeriodMetrics } from './metrics';
import { getMacro } from '../macro/getMacro';
import {
  DebtScoreResponse,
  MaturityLadderResponse,
  type MaturityLadderEntry,
  type DebtSignal,
} from '../../src/contracts/debt';

// ── Maturity ladder helpers ────────────────────────────────────────────────────────────────

/** Assign a maturity bucket from months_to_maturity. */
function toBucket(monthsToMaturity: number | null): MaturityLadderEntry['bucket'] {
  if (monthsToMaturity !== null && monthsToMaturity <= 12) return '0-12';
  if (monthsToMaturity !== null && monthsToMaturity <= 24) return '13-24';
  if (monthsToMaturity !== null && monthsToMaturity <= 36) return '25-36';
  return '37+'; // null (demand/unknown) OR > 36
}

/**
 * Per-loan signal for the maturity ladder — simplified display hint, NOT governor enforcement.
 * Uses the stored LTV only (same D1 rationale: best snapshot data we have).
 * - 'governor-block' when ltv is known and exceeds the 40% hard ceiling.
 * - 'hold' otherwise (no refi/cash-out evaluation at the per-loan display level).
 */
function toLoanSignal(ltv: number | null): DebtSignal {
  if (ltv !== null && ltv > 0.40) return 'governor-block';
  return 'hold';
}

// ── Row types for raw DB reads ─────────────────────────────────────────────────────────────

interface MaturityRow {
  id: string;
  property_id: string | null;
  property_name: string | null;
  loan_name: string;
  current_balance: number;
  maturity_date: string | null;
  months_to_maturity: number | null;
  balloon: number; // SQLite INTEGER boolean
  is_demand: number; // SQLite INTEGER boolean
  ltv: number | null;
}

// ── Router factory ─────────────────────────────────────────────────────────────────────────

/**
 * Creates the debt Hono sub-router.
 *
 * @param getDb - Lazy singleton getter; throws when warehouse is unavailable (cold/mirror env).
 */
export function debtApi(getDb: () => WarehouseDb): Hono {
  const app = new Hono();

  /**
   * Resolve the warehouse per-request behind a 503 guard.
   * Mirrors the `withDb` pattern in server/warehouse/api.ts exactly.
   */
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

  // ── GET /scores ────────────────────────────────────────────────────────────────────────
  //
  // Calls scoreDebtPositions() with all PeriodMetrics and the live FRED DGS5 rate.
  // FRED unavailability is non-fatal: null market rate is passed through and the scorer
  // handles it (refi signal is suppressed; other signals are unaffected).
  //
  // H6 read boundary: the response is parsed through DebtScoreResponse before emitting.
  app.get('/scores', (c) =>
    withDb(async (db) => {
      try {
        const metrics = propertyPeriodMetrics(db);

        // Attempt FRED DGS5 fetch. Failure → null (non-fatal per spec).
        let marketRateFiveYearTreasury: number | null = null;
        try {
          const macro = await getMacro();
          const dgs5 = macro.indicators.find((ind) => ind.id === 'DGS5');
          if (dgs5 !== undefined && dgs5.value !== null) {
            // FRED reports as a percentage (e.g. 4.18 = 4.18%); scoring engine expects decimal.
            marketRateFiveYearTreasury = dgs5.value / 100;
          }
        } catch {
          // FRED fetch failed — proceed with null market rate; scorer handles gracefully.
        }

        const scores = scoreDebtPositions(db, metrics, marketRateFiveYearTreasury);
        return c.json(DebtScoreResponse.parse({ scores }));
      } catch (err) {
        console.error('[debt-api] /scores error:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'debt scoring failed' }, 500);
      }
    }),
  );

  // ── GET /maturity ──────────────────────────────────────────────────────────────────────
  //
  // Builds a maturity ladder from all active debt_positions rows, joined to property_master
  // for the property name. Each loan is assigned a 4-bucket time horizon and a per-loan
  // display signal (governor-block or hold — simplified; no refi/cash-out at this level).
  //
  // H6 read boundary: the response is parsed through MaturityLadderResponse before emitting.
  app.get('/maturity', (c) =>
    withDb((db) => {
      try {
        const rows = db
          .prepare(
            `SELECT d.id, d.property_id, p.name AS property_name,
                    d.loan_name, d.current_balance, d.maturity_date,
                    d.months_to_maturity, d.balloon, d.is_demand, d.ltv
             FROM debt_positions d
             LEFT JOIN property_master p ON p.id = d.property_id
             WHERE d.status = 'active'
             ORDER BY d.months_to_maturity ASC NULLS LAST, d.id ASC`,
          )
          .all() as MaturityRow[];

        const ladder: MaturityLadderEntry[] = rows.map((row) => ({
          propertyId: row.property_id ?? 'unknown',
          propertyName: row.property_name ?? row.property_id ?? 'Unknown',
          loanId: row.id,
          loanName: row.loan_name,
          currentBalance: row.current_balance,
          maturityDate: row.maturity_date,
          monthsToMaturity: row.months_to_maturity,
          bucket: toBucket(row.months_to_maturity),
          balloon: row.balloon === 1,
          isDemand: row.is_demand === 1,
          signal: toLoanSignal(row.ltv),
        }));

        return c.json(MaturityLadderResponse.parse({ ladder }));
      } catch (err) {
        console.error('[debt-api] /maturity error:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'maturity ladder failed' }, 500);
      }
    }),
  );

  return app;
}
