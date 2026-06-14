// server/warehouse/api.ts
//
// The /api/warehouse Hono sub-router. Reads come from queries.ts, mutations from
// actions.ts; JSON bodies are Zod-validated here (the route layer is the only place
// untrusted input enters the warehouse). The router is built with an injected
// db-getter (`getDb`) so route tests can drive a temp warehouse and so server/index.ts
// can supply a lazy singleton. If the getter throws (sqlite file/dir absent on a mirror
// or cold environment) every route returns 503 {error:'warehouse unavailable'} — the
// router never throws at mount and never crashes the server.
import { Hono } from 'hono';
import { z } from 'zod';
import { Classification, NumericMetricKey } from '../../src/contracts/warehouse';
import {
  MetricsResponseSchema, GrowthResponseSchema, DriversResponseSchema, AnomaliesResponseSchema,
  BenchmarksResponseSchema, ScoresResponseSchema, PmScorecardsResponseSchema,
  CalibrationLogResponseSchema, CalibrationPendingResponseSchema, CalibrationReportSchema,
  CalibrationResolveRequestSchema, CalibrationResolveResponseSchema,
  VerdictKind,
} from '../../src/contracts/warehouse';
import { AcquisitionInput } from '../../src/contracts/acquisition';
import type { AcquisitionRuleset, ReplacementCostTable } from '../../src/contracts/acquisition';
import type { WarehouseDb } from './db';
import { addMappingOverride, approveImport, rejectImport, resolveIssue } from './actions';
import { getImportDetail, listImports, listIssues, noiMatrix } from './queries';
import { detectAnomalies } from './anomalies';
import { benchmarkMetric, pmScorecards, rankProperties } from './benchmarks';
import { calibrationLog, calibrationPending, calibrationReport, resolveManualOutcome } from './calibration';
import { decomposeNoiChange, noiImpactByCategory } from './drivers';
import { growthSeries, sinceAcquisition } from './growth';
import { propertyPeriodMetrics } from './metrics';
import type { PeriodMetrics } from './metrics';
import { scoreProperties } from './scores';
import { loadRatifiedRct, loadRatifiedRuleset, scoreAcquisition } from './acquisition';
import { getLeaseTerms, listLeaseTermPropertyIds } from './lease-terms';
import { projectLeaseRun, resolveAssumptions, computeMarkToMarket } from './lease-run';
import type { CohortRentBenchmark } from './lease-run';
import { loadOverlay } from '../overlay';
import {
  LeaseRunProjectionEnvelope,
  LeaseRunRollupResponse,
  type LeaseRunProjection,
  type LeaseRunSummary,
  type MarkToMarket,
} from '../../src/contracts/lease-run';

const ActionInput = z.object({ action: z.enum(['approve', 'reject']) });

const AddMappingInputSchema = z.object({
  account: z.string().min(1),
  normalizedCategory: z.string().min(1),
  classification: Classification,
  propertyId: z.string().min(1).optional(),
});

// A 4-digit year period token (e.g. '2025'); optional on the query string.
const Year = z.string().regex(/^\d{4}$/);

// Benchmarkable numeric metric keys are single-sourced in the contract (NumericMetricKey, H6).
const BenchmarksQuery = z.object({
  period: Year.optional(),
  metric: NumericMetricKey.optional(),
});

const DriversQuery = z.object({
  from: Year.optional(),
  to: Year.optional(),
});

// Calibration read-route query params (all optional; bad values 400 via safeParse).
const CalibrationLogQuery = z.object({
  subject: z.string().min(1).optional(),
  kind: VerdictKind.optional(),
  status: z.enum(['open', 'resolved']).optional(),
});
const CalibrationReportQuery = z.object({
  from: Year.optional(),
  to: Year.optional(),
  kind: VerdictKind.optional(),
});

/** Group a flat metrics list by propertyId, each group sorted ascending by period. */
function groupByProperty(metrics: PeriodMetrics[]): Map<string, PeriodMetrics[]> {
  const groups = new Map<string, PeriodMetrics[]>();
  for (const m of metrics) {
    const arr = groups.get(m.propertyId) ?? [];
    arr.push(m);
    groups.set(m.propertyId, arr);
  }
  for (const arr of groups.values()) arr.sort((a, b) => a.period.localeCompare(b.period));
  return groups;
}

// ── Lease-run helpers (PFI Lease-Run Pro Forma) ───────────────────────────────────────────
// All read-only and additive. Assumptions come from the overlay (leaseRunAssumptions[propertyId]),
// merged onto the spec defaults in the engine (resolveAssumptions). The mark-to-market cohort
// reuses the benchmarks engine's revenue-per-SF distribution for the latest period.

/** A typed EMPTY projection for a property with no lease terms — no crash (Behavior contract #4). */
function emptyLeaseRunProjection(propertyId: string): LeaseRunProjection {
  return {
    propertyId,
    tenant: null,
    rentableSf: null,
    structure: null,
    currentExpiry: null,
    assumptions: resolveAssumptions(undefined),
    assumptionsAreDefault: true,
    periods: [],
    stabilizedNoi: null,
    stabilizedYearLabel: null,
    indicativeValue: null,
    indicativeValuePsf: null,
    diligenceNotes: [],
    isEmpty: true,
  };
}

/** Cohort revenue-per-SF benchmark for the latest available period (the mark-to-market base). */
function cohortRentBenchmark(metrics: PeriodMetrics[]): CohortRentBenchmark {
  const periods = [...new Set(metrics.map((m) => m.period))].sort((a, b) => a.localeCompare(b));
  const latest = periods[periods.length - 1];
  if (!latest) return { median: null, p25: null, n: 0 };
  const b = benchmarkMetric(metrics, latest, 'revenuePerSf');
  return { median: b.median, p25: b.p25, n: b.n };
}

/** Build the single-property projection + mark-to-market envelope. Pure given (db-derived) inputs. */
function buildLeaseRunEnvelope(
  db: WarehouseDb,
  propertyId: string,
  cohort: CohortRentBenchmark,
): { projection: LeaseRunProjection; markToMarket: MarkToMarket | null } {
  const terms = getLeaseTerms(db, propertyId);
  if (terms.length === 0) {
    return { projection: emptyLeaseRunProjection(propertyId), markToMarket: null };
  }
  const overlay = loadOverlay();
  const partial = overlay.leaseRunAssumptions?.[propertyId];
  const assumptions = resolveAssumptions(partial);
  // Single-tenant today: project the first (only) lease. Multi-tenant aggregation is v-next.
  const projection = projectLeaseRun(terms[0]!, assumptions);
  const markToMarket = computeMarkToMarket(projection, cohort);
  return { projection, markToMarket };
}

/** Rollover markers: lease-year labels where the rent STATUS changes (expiry / option boundary). */
function rolloverLabels(projection: LeaseRunProjection): string[] {
  const labels: string[] = [];
  let prevStatus: string | null = null;
  for (const p of projection.periods) {
    if (prevStatus !== null && p.status !== prevStatus) labels.push(p.leaseYearLabel);
    prevStatus = p.status;
  }
  return labels;
}

/** Parse a path id param to a positive integer, or null when it is not a clean integer. */
function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
}

// Acquisition scoring config (ratified ruleset + RCT) — loaded once, FAIL-CLOSED. A missing or
// non-ratified config surfaces as 503, never a crash and never a live verdict on un-ratified math.
let acqConfigCache: { ok: true; ruleset: AcquisitionRuleset; rct: ReplacementCostTable } | { ok: false; error: string } | null = null;
function acqConfig(): { ok: true; ruleset: AcquisitionRuleset; rct: ReplacementCostTable } | { ok: false; error: string } {
  if (acqConfigCache === null) {
    try {
      acqConfigCache = { ok: true, ruleset: loadRatifiedRuleset(), rct: loadRatifiedRct() };
    } catch (e) {
      acqConfigCache = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  }
  return acqConfigCache;
}

export function warehouseRoutes(getDb: () => WarehouseDb): Hono {
  const app = new Hono();

  // Resolve the warehouse per-request behind a guard: a missing sqlite file/dir on the
  // static mirror or a cold environment surfaces as 503, not a 500 or a crashed process.
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

  app.get('/imports', (c) => withDb((db) => c.json({ imports: listImports(db) })));

  app.get('/imports/:id', (c) =>
    withDb((db) => {
      const id = parseId(c.req.param('id'));
      if (id === null) return c.json({ error: 'not found' }, 404);
      const detail = getImportDetail(db, id);
      if (!detail) return c.json({ error: 'not found' }, 404);
      return c.json(detail);
    }),
  );

  app.get('/noi', (c) => withDb((db) => c.json({ matrix: noiMatrix(db) })));

  app.get('/issues', (c) => withDb((db) => c.json({ issues: listIssues(db) })));

  app.post('/imports/:id/action', (c) =>
    withDb(async (db) => {
      const id = parseId(c.req.param('id'));
      if (id === null) return c.json({ error: 'not found' }, 404);
      const parsed = ActionInput.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.json({ error: 'invalid action' }, 400);

      if (parsed.data.action === 'reject') {
        const r = rejectImport(db, id);
        return c.json(r, r.ok ? 200 : 404);
      }
      // approve: a refusal carrying an unmapped list is a 409 (the client resolves the
      // mappings then retries); any other failure (not found / not pending) is a 404.
      const r = approveImport(db, id);
      if (r.ok) return c.json(r, 200);
      return c.json(r, r.unmapped.length > 0 ? 409 : 404);
    }),
  );

  app.post('/mappings', (c) =>
    withDb(async (db) => {
      const parsed = AddMappingInputSchema.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.json({ error: 'invalid mapping' }, 400);
      return c.json(addMappingOverride(db, parsed.data), 200);
    }),
  );

  app.post('/issues/:id/resolve', (c) =>
    withDb((db) => {
      const id = parseId(c.req.param('id'));
      if (id === null) return c.json({ error: 'not found' }, 404);
      const r = resolveIssue(db, id);
      return c.json(r, r.ok ? 200 : 404);
    }),
  );

  // ── Analytics (read-only, behind the same 503 guard). Each calls a pure engine
  //    function on the injected db; query params are Zod-validated. The deal-state /
  //    confidentiality layer is upstream — these expose only 100%-basis financial metrics.

  // Each analytics route .parse()s its payload through the contract envelope schema before
  // c.json(...) — the server-side half of the H6 read boundary (mirrors acquisition.ts). The
  // parsed value (structurally identical to the engine output) is what crosses to the client.
  app.get('/analytics/metrics', (c) =>
    withDb((db) => c.json(MetricsResponseSchema.parse({ metrics: propertyPeriodMetrics(db) }))),
  );

  app.get('/analytics/growth', (c) =>
    withDb((db) => {
      const groups = groupByProperty(propertyPeriodMetrics(db));
      const growth = [...groups.values()].flatMap((series) => growthSeries(series));
      const since = [...groups.values()].map((series) => sinceAcquisition(series));
      return c.json(GrowthResponseSchema.parse({ growth, sinceAcquisition: since }));
    }),
  );

  app.get('/analytics/drivers/:propertyId', (c) =>
    withDb((db) => {
      const parsed = DriversQuery.safeParse({ from: c.req.query('from'), to: c.req.query('to') });
      if (!parsed.success) return c.json({ error: 'invalid query' }, 400);

      const propertyId = c.req.param('propertyId');
      const series = groupByProperty(propertyPeriodMetrics(db)).get(propertyId);
      if (!series || series.length === 0) return c.json({ error: 'not found' }, 404);

      // Default to the earliest/latest available periods for this property.
      const from = parsed.data.from ?? series[0]!.period;
      const to = parsed.data.to ?? series[series.length - 1]!.period;
      const a = series.find((m) => m.period === from);
      const b = series.find((m) => m.period === to);
      if (!a || !b) return c.json({ error: 'period not found' }, 404);

      const decomposition = decomposeNoiChange(noiImpactByCategory(a), noiImpactByCategory(b));
      return c.json(DriversResponseSchema.parse({ propertyId, from, to, ...decomposition }));
    }),
  );

  app.get('/analytics/anomalies', (c) =>
    withDb((db) => c.json(AnomaliesResponseSchema.parse({ anomalies: detectAnomalies(propertyPeriodMetrics(db)) }))),
  );

  app.get('/analytics/benchmarks', (c) =>
    withDb((db) => {
      const parsed = BenchmarksQuery.safeParse({ period: c.req.query('period'), metric: c.req.query('metric') });
      if (!parsed.success) return c.json({ error: 'invalid query' }, 400);

      const metrics = propertyPeriodMetrics(db);
      // Sensible defaults: latest available period, noiPerSf.
      const periods = [...new Set(metrics.map((m) => m.period))].sort((a, b) => a.localeCompare(b));
      const period = parsed.data.period ?? periods[periods.length - 1] ?? '';
      const metric: NumericMetricKey = parsed.data.metric ?? 'noiPerSf';

      return c.json(BenchmarksResponseSchema.parse({
        byMetric: benchmarkMetric(metrics, period, metric),
        rankings: rankProperties(metrics, period, metric),
      }));
    }),
  );

  app.get('/analytics/scores', (c) =>
    withDb((db) => c.json(ScoresResponseSchema.parse({ scores: scoreProperties(db, propertyPeriodMetrics(db)) }))),
  );

  app.get('/analytics/pm', (c) =>
    withDb((db) => c.json(PmScorecardsResponseSchema.parse({ scorecards: pmScorecards(db, propertyPeriodMetrics(db)) }))),
  );

  // ── Lease-run pro forma (read-only; H6 read boundary). Forward contractual NOI per property
  //    from lease_terms + overlay-overridable assumptions. The ownership rollup aggregates every
  //    property with lease terms; the per-property route adds the mark-to-market chip. A property
  //    with no lease terms → a typed EMPTY projection (200, never a crash). All math is in the pure
  //    engine (lease-run.ts) reconciled to the dollar against the v1.0 Excel models.
  app.get('/analytics/lease-run', (c) =>
    withDb((db) => {
      const cohort = cohortRentBenchmark(propertyPeriodMetrics(db));
      const summaries: LeaseRunSummary[] = listLeaseTermPropertyIds(db).map((propertyId) => {
        const { projection, markToMarket } = buildLeaseRunEnvelope(db, propertyId, cohort);
        return {
          propertyId,
          tenant: projection.tenant,
          rentableSf: projection.rentableSf,
          stabilizedNoi: projection.stabilizedNoi,
          indicativeValue: projection.indicativeValue,
          currentExpiry: projection.currentExpiry,
          belowMarket: markToMarket?.belowMarket ?? false,
          rolloverLabels: rolloverLabels(projection),
        };
      });
      const totalStabilizedNoi = summaries.reduce((s, r) => s + (r.stabilizedNoi ?? 0), 0);
      const totalIndicativeValue = summaries.reduce((s, r) => s + (r.indicativeValue ?? 0), 0);
      return c.json(
        LeaseRunRollupResponse.parse({ summaries, totalStabilizedNoi, totalIndicativeValue }),
      );
    }),
  );

  app.get('/analytics/lease-run/:propertyId', (c) =>
    withDb((db) => {
      const propertyId = c.req.param('propertyId');
      const cohort = cohortRentBenchmark(propertyPeriodMetrics(db));
      const { projection, markToMarket } = buildLeaseRunEnvelope(db, propertyId, cohort);
      return c.json(LeaseRunProjectionEnvelope.parse({ ...projection, markToMarket }));
    }),
  );

  // ── Calibration (read-only, behind the same 503 guard). The 40-year feedback loop's read surface:
  //    the verdict log, the due-but-unresolved pending queue, and the aggregated §4 report. Each
  //    .parse()s its envelope before c.json (the H6 read boundary). Resolution WRITES (/resolve) and
  //    the manual-resolution UI are a later stacked PR — this PR is the read foundation only. On an
  //    empty warehouse (no outcome data yet — the normal Phase-2 state) every route returns an empty/
  //    zeroed payload, never an error.
  app.get('/calibration/log', (c) =>
    withDb((db) => {
      const parsed = CalibrationLogQuery.safeParse({
        subject: c.req.query('subject'), kind: c.req.query('kind'), status: c.req.query('status'),
      });
      if (!parsed.success) return c.json({ error: 'invalid query' }, 400);
      return c.json(CalibrationLogResponseSchema.parse({ log: calibrationLog(db, parsed.data) }));
    }),
  );

  app.get('/calibration/pending', (c) =>
    withDb((db) => c.json(CalibrationPendingResponseSchema.parse({ pending: calibrationPending(db) }))),
  );

  app.get('/calibration/report', (c) =>
    withDb((db) => {
      const parsed = CalibrationReportQuery.safeParse({
        from: c.req.query('from'), to: c.req.query('to'), kind: c.req.query('kind'),
      });
      if (!parsed.success) return c.json({ error: 'invalid query' }, 400);
      return c.json(CalibrationReportSchema.parse(calibrationReport(db, parsed.data)));
    }),
  );

  // POST /calibration/:id/resolve — the MANUAL resolution WRITE (spec §3.2). The only calibration
  // mutation the UI performs: it records an analyst's realized outcome for a pending verdict, or
  // blesses/overrides an auto-resolution. Append-only + idempotent + grain-guarded in
  // resolveManualOutcome; writes calibration_outcome ONLY (never a verdict, never overlay, never a
  // governor). Status mapping: 400 = malformed/no-signal body (Zod) · 404 = bad/nonexistent verdict
  // id · 422 = a well-formed request that violates the grain/horizon domain rule · 200 = written
  // (or an idempotent duplicate no-op). The body is Zod-validated inside resolveManualOutcome, but we
  // also reject a non-integer path id and a non-object body up front for the right status code.
  app.post('/calibration/:id/resolve', (c) =>
    withDb(async (db) => {
      const id = parseId(c.req.param('id'));
      if (id === null) return c.json({ error: 'not found' }, 404);
      const raw = await c.req.json().catch(() => null);
      if (raw === null || typeof raw !== 'object') return c.json({ error: 'invalid resolution body' }, 400);
      // Pre-validate the body shape (400) BEFORE the domain call, so a Zod failure is a 400 and a
      // domain-rule failure (bad id / grain) gets its own status below.
      const parsed = CalibrationResolveRequestSchema.safeParse({ ...(raw as object), calibrationId: id });
      if (!parsed.success) return c.json({ error: 'invalid resolution', issues: parsed.error.issues }, 400);

      const r = resolveManualOutcome(db, parsed.data);
      if (r.ok) return c.json(CalibrationResolveResponseSchema.parse(r), 200);
      // A missing verdict is a 404; every other domain refusal (grain / horizon) is a 422.
      const status = /not found/i.test(r.error) ? 404 : 422;
      return c.json({ error: r.error }, status);
    }),
  );

  // ── Acquisition Intelligence — score a fully-specified deal against the RATIFIED scorecard + RCT.
  //    Pure compute (no warehouse DB). Fail-closed: a missing/non-ratified config ⇒ 503, never a live
  //    verdict on un-ratified math. The Cowork acquisition-underwriting skill POSTs the inputs it already
  //    produces and gets the platform's deterministic Oxford Acquisition Score back — one number, both
  //    surfaces (the shared-contract goal). Confidential-deal handling stays upstream of this route.
  app.post('/acquisition/score', async (c) => {
    const cfg = acqConfig();
    if (!cfg.ok) return c.json({ error: 'acquisition engine unavailable', detail: cfg.error }, 503);
    const parsed = AcquisitionInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid acquisition input', issues: parsed.error.issues }, 400);
    return c.json({ score: scoreAcquisition(parsed.data, cfg.ruleset, { rct: cfg.rct }) });
  });

  return app;
}
