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
// buildInsuranceAnalysis's `renewalCalendar` IS the complete CURRENT-TERM PolicyEconomics list —
// it is built as `const renewalCalendar = [...policies].sort(...)`, an unfiltered copy of the
// full `policies: PolicyEconomics[]` array, just sorted by expiry. "Complete" means one row per
// (property_id, policy_type): buildInsuranceAnalysis's collapseToCurrentTerm (2026-08-17 fix)
// keeps only the most recently CAPTURED term per coverage (source_date DESC, then effective_date,
// then id — NOT max effective_date; see collapseToCurrentTerm's own doc for why source_date is
// the sound primary signal) — corrected 2026-08-21, this comment previously said "latest-
// effective-date," which collapseToCurrentTerm's doc explicitly calls out and rejects as unsafe.
// Either way, a rolled-over policy's prior term never reaches this route — the engine attaches
// each loss event to exactly one (still-legitimate) current policy by term / policy_ref
// (loadPolicyTerms below), never to a stale duplicate term. No new
// exported helper is needed; `rebidCandidates` would be the WRONG field here (it's filtered to
// excess>0 policies only).
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
import { resolveDecPages, resolveLossEvents, strOrBlank, strOrNull, termDateOrNull } from './placeholder-data';
import { buildInsuranceLossReport, normalizePolicyNumber, type PolicyTerm } from './insurance-loss-analysis';
import { InsuranceLossReport } from '../../src/contracts/insurance-loss';

/** Term identity per policy row, keyed String(id) = PolicyEconomics.policyId. The loss engine uses
 *  it to attach each loss event to the one policy whose term / policy number covers it.
 *  lineNumbers spans the row's whole LINE — every row sharing its raw property_id and policy_type
 *  (trim + lowercase, the key collapseToCurrentTerm groups on) — so a loss run citing a superseded
 *  or reissued number (live: 1310 'MMF17962784' → 1734 'MMF17962784-002') still names the surviving
 *  current-term row. */
function loadPolicyTerms(db: WarehouseDb): Map<string, PolicyTerm> {
  // SQLite affinities are not constraints: raw SQL can leave a BLOB or a number in any TEXT column
  // here, which would crash normalizePolicyNumber / isoDay / .trim(). Every column but the rowid is
  // read as unknown and normalized with the same helpers as resolveLossEvents (non-string → null /
  // '') — a non-string number reads "no number"; a date whose leading YYYY-MM-DD is not a real
  // calendar day (incl. a numeric-as-text '1717200000.0') reads "no term date" (termDateOrNull).
  // This loader normalizes on its own (it needs only these six columns) and relies on isoDay's
  // leading-10-character read for the term dates. The other readers of this table —
  // buildInsuranceAnalysis (run first on the same request), insurance-conditions.ts
  // fetchCurrentInsuranceRows and GET /history — go through insurance-analysis.ts's shared
  // readPolicyBook, which canonicalizes term dates to that same leading YYYY-MM-DD.
  const rows = (
    db
      .prepare('SELECT id, property_id, policy_type, policy_number, effective_date, expiration_date FROM property_insurance_policies')
      .all() as Array<{
        id: number;
        property_id: unknown;
        policy_type: unknown;
        policy_number: unknown;
        effective_date: unknown;
        expiration_date: unknown;
      }>
  ).map((r) => ({
    id: r.id,
    property_id: strOrBlank(r.property_id),
    policy_type: strOrBlank(r.policy_type),
    policy_number: strOrNull(r.policy_number),
    effective_date: termDateOrNull(r.effective_date),
    expiration_date: termDateOrNull(r.expiration_date),
  }));
  const lineKey = (r: { property_id: string; policy_type: string }) => `${r.property_id}|${r.policy_type.trim().toLowerCase()}`;
  const numbersByLine = new Map<string, Set<string>>();
  for (const r of rows) {
    const n = normalizePolicyNumber(r.policy_number);
    if (n === null) continue;
    const set = numbersByLine.get(lineKey(r));
    if (set) set.add(n);
    else numbersByLine.set(lineKey(r), new Set([n]));
  }
  return new Map(
    rows.map((r) => [
      String(r.id),
      {
        policyNumber: normalizePolicyNumber(r.policy_number),
        lineNumbers: [...(numbersByLine.get(lineKey(r)) ?? [])].sort(),
        effectiveDate: r.effective_date,
        expirationDate: r.expiration_date,
      },
    ]),
  );
}

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
            policyTerms: loadPolicyTerms(db),
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
