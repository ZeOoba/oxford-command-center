// server/warehouse/debt-api.ts
//
// Phase 2 Step 5 + binding — Debt/Refi API sub-router.
//
// Routes:
//   GET  /scores   — scoreDebtPositions() across all active loans; FRED DGS5 is non-fatal when null
//   GET  /maturity — maturity ladder: active loans bucketed into 4 time horizons
//   POST /snapshot — write a debt snapshot from a portfolio snapshot payload
//                    (loans + properties + snapshotDate → debt_positions via crosswalk)
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
import { fetchFredMacro } from '../macro/fred';
import { writeDebtSnapshot } from './debt-snapshot';
import { buildLoanPropertyMap } from './property-crosswalk';
import {
  DebtScoreResponse,
  MaturityLadderResponse,
  MaturityTimelineResponse,
  RefiWindowsResponse,
  type MaturityLadderEntry,
  type DebtSignal,
} from '../../src/contracts/debt';
import { z } from 'zod';
import { Loan as LoanSchema } from '../../src/contracts/loan';
import type { Loan } from '../../src/contracts/loan';
import {
  buildMaturityTimeline,
  buildRefiWindows,
  computePortfolioAggregateLtv,
  REFI_LTV_CEILING,
} from './debt-maturity';
import { loadGovernors } from './governors';
import { referenceDate } from '../config';

// ── POST /snapshot payload type ────────────────────────────────────────────────────────────

/**
 * Payload for POST /snapshot.
 * Caller supplies the borrower loans, the properties list (for crosswalk name resolution),
 * and the snapshot date (must be generatedAt, not the static workbook asOf).
 */
export interface DebtApiSnapshotPayload {
  snapshotDate: string;
  loans: Loan[];
  properties: { id: string; name: string }[];
  /** See DebtApiSnapshotPayloadSchema's doc comment below (H2a reachability fix). */
  allowEmptySupersede?: boolean;
}

/**
 * Runtime schema for the POST /snapshot body.
 *
 * 2026-07-24 integrity sweep — ROOT CAUSE of both HIGH governor findings. This route used to
 * take its body through a bare `as DebtApiSnapshotPayload` cast plus an Array.isArray() shape
 * check, while every GET route in this file Zod-parses its RESPONSE. That asymmetry (unvalidated
 * in, validated out) meant arbitrary JSON reached the warehouse writer: a negative absBalance
 * flowed into debt_positions.current_balance and deflated the portfolio aggregate LTV into a
 * false clearance of the Hard-Invariant-4 40% governor. debt-scoring.ts's effectiveMonthsToMaturity
 * already carried a comment naming this exact route as a live threat model (a malformed
 * is_demand row with a populated maturity_date), which was hardened per-function rather than at
 * the boundary. This closes it at the boundary instead — one parse, every field.
 *
 * The Loan contract ALREADY declares `absBalance: z.number().nonnegative()`; it simply was never
 * enforced here. No new financial rule is introduced — an existing one is now applied.
 *
 * ltv IS bounded here, narrowly, unlike the base Loan schema (round 5 correction — see loan.ts's
 * doc comment for the full reasoning): a sign error or an order-of-magnitude entry error is
 * rejected on THIS supervised, explicit write route without imposing the same bound on
 * server/workbook/parse.ts's whole-portfolio PortfolioSnapshot.parse(), where a single bad cell
 * failing the entire snapshot would break this repo's DataQualityFlag-not-hard-throw convention.
 * The bound still does NOT defend the too-LOW direction — see loan.ts; that risk is open.
 */
const BoundedLoanForSnapshotWrite = LoanSchema.extend({ ltv: z.number().min(0).max(1.5).nullable() });

export const DebtApiSnapshotPayloadSchema = z.object({
  snapshotDate: z.string().min(1),
  loans: z.array(BoundedLoanForSnapshotWrite),
  properties: z.array(z.object({ id: z.string(), name: z.string() })),
  // 2026-07-24 (H2a/shrinkage-guard reachability fix, refute-review): writeDebtSnapshot's
  // REFUSED error names `{ allowEmptySupersede: true }` as the remedy for a CONFIRMED book loss
  // (a total wipe, or — since round 4 — a verified majority net runoff with no replacement), but
  // no caller could ever pass it — this schema had no field for it, and the automated
  // server/index.ts reload path deliberately never gets one (see the route handler below:
  // threading it there would let the exact parser regression this guard defends against wipe
  // the book by itself). POST /snapshot is the one SUPERVISED, explicit write surface, so it is
  // the one place a human/caller can confirm a genuine book-shrinking snapshot is intentional.
  // NOTE: an ordinary refinance or an id rename that keeps the total loan count intact never
  // trips the guard and never needs this flag — see debt-snapshot.ts's netLoss reasoning.
  allowEmptySupersede: z.boolean().optional(),
});

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

        // Attempt live FRED DGS5 fetch. fetchFredMacro() returns null when FRED_API_KEY is
        // absent or the request fails — getMacro() is intentionally NOT used here because it
        // falls back to seeded data, masking genuine FRED unavailability and causing the refi
        // signal to fire based on stale rates. A null rate → scorer emits 'hold', never 'refi'.
        let marketRateFiveYearTreasury: number | null = null;
        const fredSnap = await fetchFredMacro().catch(() => null);
        if (fredSnap !== null) {
          const dgs5 = fredSnap.indicators.find((ind) => ind.id === 'DGS5');
          if (dgs5 !== undefined && dgs5.value !== null) {
            // FRED reports as a percentage (e.g. 4.18 = 4.18%); scoring engine expects decimal.
            marketRateFiveYearTreasury = dgs5.value / 100;
          }
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

  // ── GET /timeline ──────────────────────────────────────────────────────────────────────
  //
  // Debt & Maturity module v1: chronological maturity / rate-reset / demand-callable event
  // stream (see server/warehouse/debt-maturity.DESIGN.md). Confidentiality is TIGHTER than
  // /maturity: no balances, no rate values, no lender names cross this boundary.
  //
  // H6 read boundary: the response is parsed through MaturityTimelineResponse before emitting.
  app.get('/timeline', (c) =>
    withDb((db) => {
      try {
        const asOf = referenceDate();
        const events = buildMaturityTimeline(db, asOf);
        return c.json(MaturityTimelineResponse.parse({ asOf, events }));
      } catch (err) {
        console.error('[debt-api] /timeline error:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'maturity timeline failed' }, 500);
      }
    }),
  );

  // ── GET /refi-windows ──────────────────────────────────────────────────────────────────
  //
  // Debt & Maturity module v1: per-property 12/24-month refi-window flags + governor breach
  // flags + the conservative portfolio-aggregate LTV. DSCR/LTV come from the ratified scoring
  // engine (scoreDebtPositions) — the market rate is deliberately null: the windows consume
  // DSCR/LTV only, a null rate merely suppresses the unused 'refi' signal, and the route
  // stays deterministic and offline-safe (no FRED dependency).
  //
  // H6 read boundary: the response is parsed through RefiWindowsResponse before emitting.
  app.get('/refi-windows', (c) =>
    withDb((db) => {
      try {
        const asOf = referenceDate();
        const governors = loadGovernors(db);
        const metrics = propertyPeriodMetrics(db);
        const scores = scoreDebtPositions(db, metrics, null, asOf);
        const windows = buildRefiWindows(db, scores, asOf);
        const aggregate = computePortfolioAggregateLtv(db, governors);
        return c.json(
          RefiWindowsResponse.parse({
            asOf,
            windows,
            aggregate,
            governors: {
              dscrFloor: governors.dscrFloor,
              ltvCeilingAggregate: governors.ltvCeiling,
              refiLtvCeilingPerProperty: REFI_LTV_CEILING,
            },
          }),
        );
      } catch (err) {
        console.error('[debt-api] /refi-windows error:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'refi windows failed' }, 500);
      }
    }),
  );

  // ── POST /snapshot ─────────────────────────────────────────────────────────────────────
  //
  // Receives a portfolio snapshot payload, resolves each borrower loan's collateralProperty
  // to a property_master id via the crosswalk, and writes the debt_positions snapshot.
  //
  // Returns: { ok, written, unresolved, errors }
  //   unresolved = count of borrower loans whose collateralProperty could not be resolved
  //   errors     = FK-validation failures (property_id not in property_master)
  //
  // This is the same logic as the reload trigger in server/index.ts — both use
  // buildLoanPropertyMap() as the shared canonical path.
  app.post('/snapshot', (c) =>
    withDb(async (db) => {
      let rawBody: unknown;
      try {
        rawBody = await c.req.json();
      } catch {
        return c.json({ ok: false, error: 'Invalid JSON body' }, 400);
      }
      // Full schema parse — see DebtApiSnapshotPayloadSchema. Rejects at the boundary rather
      // than letting a malformed row reach the warehouse and corrupt a governor verdict.
      const parsed = DebtApiSnapshotPayloadSchema.safeParse(rawBody);
      if (!parsed.success) {
        return c.json(
          { ok: false, error: 'invalid snapshot payload', issues: parsed.error.issues },
          400,
        );
      }
      const payload: DebtApiSnapshotPayload = parsed.data;
      try {
        const validPropertyIds = new Set<string>(
          (db.prepare('SELECT id FROM property_master').all() as { id: string }[]).map((r) => r.id),
        );
        const { map, unresolved } = buildLoanPropertyMap(payload.loans, payload.properties, validPropertyIds);
        const result = writeDebtSnapshot(db, payload.loans, payload.snapshotDate, map, {
          allowEmptySupersede: payload.allowEmptySupersede === true,
        });
        if (unresolved.length > 0) {
          console.warn(`[debt-api] POST /snapshot: ${unresolved.length} borrower loan(s) unattributed (collateralProperty null, blank, or typo'd name not in property_master): ${unresolved.join(', ')}`);
        }
        if (result.errors.length > 0) {
          // errors[] carries several classes — FK-validation backstops, unrecognized loan
          // statuses, id collisions, and (2026-07-24) a refused empty-set book wipe — so the
          // label stays generic rather than asserting they are all FK failures.
          console.warn(`[debt-api] POST /snapshot: ${result.errors.length} writeDebtSnapshot warning(s)/error(s): ${result.errors.join('; ')}`);
        }
        // refused (2026-07-24): true iff the H2a empty-set guard declined the whole-book
        // supersede (result.refusedEmptySupersede — a typed field, not prose-parsed). Not an
        // HTTP-level failure (the request was well-formed and the response accurately reports
        // what happened) — 200/ok:true stands — but a caller checking only `ok`/`written`
        // could otherwise mistake "nothing needed writing" for "actively refused".
        return c.json({
          ok: true,
          written: result.written,
          unresolved: unresolved.length,
          errors: result.errors,
          refused: result.refusedEmptySupersede,
        });
      } catch (err) {
        console.error('[debt-api] POST /snapshot error:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'debt snapshot write failed' }, 500);
      }
    }),
  );

  return app;
}
