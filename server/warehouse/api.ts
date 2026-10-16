// server/warehouse/api.ts
//
// The /api/warehouse Hono sub-router. Reads come from queries.ts, mutations from
// actions.ts; JSON bodies are Zod-validated here (the route layer is the only place
// untrusted input enters the warehouse). The router is built with an injected
// db-getter (`getDb`) so route tests can drive a temp warehouse and so server/index.ts
// can supply a lazy singleton. If the getter throws (sqlite file/dir absent on a mirror
// or cold environment) every route returns 503 {error:'warehouse unavailable'} — the
// router never throws at mount and never crashes the server.
import { parseLimitParam } from '../lib/query-params';
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
import { AcquisitionInput, AcqCandidateRow, ParcelScreenImportRequest } from '../../src/contracts/acquisition';
import { AcquisitionScore } from '../../src/contracts/acquisition';
import type { AcquisitionRuleset, ReplacementCostTable } from '../../src/contracts/acquisition';
import { persistAndLogScore, logAcqOutcome } from './acq-engine';
import { applyGovernorProxy } from './acq-governor-proxy';
import { GOVERNOR_DEFAULTS } from './governors';
import { ingestParcelScreenBatch } from './acq-ingest';
import { syncNotionPipeline } from './acq-notion-sync';
import { syncHubSpotPipeline } from './acq-hubspot-sync';
import type { WarehouseDb } from './db';
import { warehouseJsonError } from './json-errors';
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
import { monthSnapshotSeries } from './month-snapshot';
import { TrendsHistoryResponseSchema } from '../../src/contracts/trends';
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
import { PropertyBriefingModel, ManagerBriefingModel, NarrativePropertyBriefingModel, NarrativeManagerBriefingModel } from '../../src/contracts/briefing';
import type { NarrativeBlock } from '../../src/contracts/briefing';
import { composePropertyBriefing, composeManagerBriefing } from '../briefing/compose';
import { renderBriefingPdf } from '../briefing/pdf';
import { briefingFilename } from '../briefing/filename';
import { composeNarrative } from '../ai/narrative';
import { buildCapitalAllocationReport, buildPortfolioAllocation } from './capital-allocation';
import { CapitalAllocationReport } from '../../src/contracts/capital-allocation';
import { buildIcMemoHtml, icMemoFilename } from './ic-memo';
import { assertNoEgressRosterMatch } from '../briefing/roster-match';
import { syncCapitalActionsToNotion } from '../notion/capital-writeback';
import { NotionSyncResult } from '../../src/contracts/notion-writeback';
import { getProspectDemandReport, addProspectEvent } from './prospect-demand';
import { referenceDate } from '../config';
import { ProspectDemandReport, ProspectDemandEventInput } from '../../src/contracts/prospect-demand';

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

// Acquisition scoring config (ratified ruleset + RCT) — FAIL-CLOSED. A missing or non-ratified
// config surfaces as 503, never a crash and never a live verdict on un-ratified math. Only a
// SUCCESSFUL load is cached: a cached failure would pin every scoring route at 503 until the server
// restarts after one transient error (e.g. an OneDrive lock on the config file). A failure is
// re-attempted on the next request; the load is two small JSON reads.
let acqConfigCache: { ok: true; ruleset: AcquisitionRuleset; rct: ReplacementCostTable } | null = null;
function acqConfig(): { ok: true; ruleset: AcquisitionRuleset; rct: ReplacementCostTable } | { ok: false; error: string } {
  if (acqConfigCache !== null) return acqConfigCache;
  try {
    acqConfigCache = { ok: true, ruleset: loadRatifiedRuleset(), rct: loadRatifiedRct() };
    return acqConfigCache;
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * Creates a configured Hono router for the warehouse API.
 *
 * @param getDb - Function to obtain the warehouse database instance
 * @returns A Hono app configured with warehouse routes
 */


export function warehouseRoutes(getDb: () => WarehouseDb): Hono {
  const app = new Hono();

  // An uncaught handler error must reach the client as JSON. This `.onError()` only covers
  // routes registered directly on THIS app instance; the WAREHOUSE_SUB_ROUTERS are sibling
  // instances that get the same handler via sub-routers.ts's withJsonErrors — see
  // json-errors.ts for the shared handler and the why.
  app.onError(warehouseJsonError);

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
      // approve: a refusal carrying an unmapped list or a policy `reason` (sign-undecidable gate, a newer
      // version already committed) is a 409 (the client resolves the mappings / verifies the sign, or rejects
      // the stale import); any other failure (not found / not pending) is a 404.
      const r = approveImport(db, id);
      if (r.ok) return c.json(r, 200);
      return c.json(r, r.unmapped.length > 0 || r.reason !== undefined ? 409 : 404);
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

  // Portfolio Trends Wave 2: monthly occupancy/rent snapshot history. Unknown propertyId -> empty list.
  app.get('/analytics/trends/history', (c) =>
    withDb((db) => {
      const propertyId = c.req.query('propertyId') || undefined;
      return c.json(TrendsHistoryResponseSchema.parse({ points: monthSnapshotSeries(db, propertyId) }));
    }),
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

  // ── Briefings + PDF export (PFI Phase C). Read-only; behind the same 503 guard. The composer
  //    maps EXISTING analytics → a BriefingModel (never recompute — the PDF can't disagree with the
  //    screen). Each subject has a JSON sibling (the H6 read boundary, for preview + tests) and a
  //    `.pdf` route streaming application/pdf with an ORA_Briefing_<Subject>_<YYYYMMDD>.pdf filename.
  //    A briefing is ownership-FINANCIAL, never a deal artifact — the composer carries no confidential
  //    deal term (asserted in compose + tested). The generated-date is injected at the route boundary
  //    (wall-clock is allowed here); the renderer itself never calls Date.now() (determinism).
  const generatedDate = (): string => new Date().toISOString().slice(0, 10);

  // One route per subject. A `.pdf` suffix on the slug → stream the PDF; otherwise → the JSON model
  // (the H6 preview sibling). Hono's matcher treats a dotted param name as literal, so we dispatch on
  // the suffix in the handler rather than registering two ambiguous `:id` / `:id.pdf` routes. The slug
  // itself never contains a dot, so stripping a trailing `.pdf` is unambiguous.
  const splitPdf = (raw: string): { id: string; wantsPdf: boolean } =>
    raw.endsWith('.pdf') ? { id: raw.slice(0, -4), wantsPdf: true } : { id: raw, wantsPdf: false };

  const streamPdf = async (
    model: PropertyBriefingModel | ManagerBriefingModel,
    narrative?: NarrativeBlock | null,
  ): Promise<Response> => {
    // A PDF is a file artifact that leaves the machine (download / forward / attachment), so it gets
    // the EGRESS roster match (refute round 5, F4): normalised, and it refuses an unreadable OR
    // placeholder roster. The compose step already ran the normalised local-render match; this
    // re-checks the model AND the AI narrative that lands in the same file. A throw is caught by
    // safeBriefing (structured 500, label-free).
    assertNoEgressRosterMatch({ model, narrative: narrative ?? null });
    const bytes = await renderBriefingPdf(model, narrative);
    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': `attachment; filename="${briefingFilename(model)}"`,
      },
    });
  };

  // The briefing handler body can throw where the analytics routes cannot: the compose layer runs the
  // fail-loud confidential guard (assertNoRosterMatch; the PDF path adds assertNoEgressRosterMatch),
  // and renderBriefingPdf can reject on a render
  // failure. withDb only guards getDb(); so wrap the whole handler and return a STRUCTURED 500 — never
  // a raw stack trace, and never the matched confidential term (the guard's message names only the deal
  // label, which we DON'T echo: a leak would otherwise re-surface the very thing we're protecting).
  const safeBriefing = (
    handler: (db: WarehouseDb) => Promise<Response>,
  ): ((db: WarehouseDb) => Promise<Response>) => {
    return async (db) => {
      try {
        return await handler(db);
      } catch {
        return new Response(JSON.stringify({ error: 'briefing generation failed' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
    };
  };

  // ── Narrative JSON routes (Phase 2 · W2 · Step 9). ADDITIVE — no existing route is altered.
  //    These must be registered BEFORE the `:slug` wildcard routes so Hono's literal-path
  //    matcher resolves `/briefing/property/some-slug/narrative` against the literal `/narrative`
  //    suffix before falling through to the catch-all `:slug` handler. The `narrative` segment
  //    is never a valid slug character sequence that `.pdf` could be appended to, so there is
  //    no collision with the `.pdf` splitPdf dispatch below.
  //
  //    These routes ALWAYS 200 on compose/AI failure (the envelope returns narrative:null,
  //    degraded:true). The only 404 path is when the subject does not exist in the warehouse.
  //    API key is sourced identically to the om-extract route in server/index.ts.

  app.get('/briefing/property/:slug/narrative', (c) =>
    withDb(
      safeBriefing(async (db) => {
        const slug = c.req.param('slug');
        const model = composePropertyBriefing(db, slug, { generatedDate: generatedDate() });
        if (!model) return c.json({ error: 'not found' }, 404);
        const { narrative, degraded } = await composeNarrative(model, {
          apiKey: process.env.ANTHROPIC_API_KEY,
        });
        return c.json(NarrativePropertyBriefingModel.parse({ ...model, narrative, degraded }));
      }),
    ),
  );

  app.get('/briefing/manager/:slug/narrative', (c) =>
    withDb(
      safeBriefing(async (db) => {
        const slug = c.req.param('slug');
        const model = composeManagerBriefing(db, slug, { generatedDate: generatedDate() });
        if (!model) return c.json({ error: 'not found' }, 404);
        const { narrative, degraded } = await composeNarrative(model, {
          apiKey: process.env.ANTHROPIC_API_KEY,
        });
        return c.json(NarrativeManagerBriefingModel.parse({ ...model, narrative, degraded }));
      }),
    ),
  );

  app.get('/briefing/property/:slug', (c) =>
    withDb(
      safeBriefing(async (db) => {
        const { id, wantsPdf } = splitPdf(c.req.param('slug'));
        const model = composePropertyBriefing(db, id, { generatedDate: generatedDate() });
        if (!model) return c.json({ error: 'not found' }, 404);
        if (wantsPdf) {
          // ?narrative=1 → compose narrative (degrades gracefully to null on no key / AI error)
          // and thread it into the PDF. Absent param → byte-identical to the pre-narrative path.
          const wantsNarrative = c.req.query('narrative') === '1';
          const narrative = wantsNarrative
            ? (await composeNarrative(model, { apiKey: process.env.ANTHROPIC_API_KEY })).narrative
            : null;
          return streamPdf(model, narrative);
        }
        return c.json(PropertyBriefingModel.parse(model));
      }),
    ),
  );

  app.get('/briefing/manager/:slug', (c) =>
    withDb(
      safeBriefing(async (db) => {
        const { id, wantsPdf } = splitPdf(c.req.param('slug'));
        const model = composeManagerBriefing(db, id, { generatedDate: generatedDate() });
        if (!model) return c.json({ error: 'not found' }, 404);
        if (wantsPdf) {
          const wantsNarrative = c.req.query('narrative') === '1';
          const narrative = wantsNarrative
            ? (await composeNarrative(model, { apiKey: process.env.ANTHROPIC_API_KEY })).narrative
            : null;
          return streamPdf(model, narrative);
        }
        return c.json(ManagerBriefingModel.parse(model));
      }),
    ),
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
    if (!cfg.ok) {
      console.error(`[acquisition] ratified config unavailable: ${cfg.error}`);
      return c.json({ error: 'acquisition engine unavailable' }, 503);
    }
    const parsed = AcquisitionInput.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) return c.json({ error: 'invalid acquisition input', issues: parsed.error.issues }, 400);
    // Apply the SHARED governor proxy (acq-governor-proxy.ts) so this ad-hoc score matches the ranked
    // path AND the edge Function. Uses the ratified default governors (DB overrides — stricter-only —
    // apply in the persistence path). LTV is indeterminate at screen time; see the module header.
    const score = scoreAcquisition(parsed.data, cfg.ruleset, { rct: cfg.rct });
    const { verdict, governorDscrCleared, governorLtvCleared } =
      applyGovernorProxy(score, parsed.data, GOVERNOR_DEFAULTS);
    return c.json({ score: { ...score, verdict }, governorDscrCleared, governorLtvCleared });
  });

  // ── Acquisition Intelligence Engine (Phase 4) ─────────────────────────────────────────────
  //    These routes extend the existing acquisition scoring path with warehouse persistence,
  //    ranked deal-flow list, parcel-screen import, manual candidate entry, and status lifecycle.
  //
  //    Advisory-only guarantee: scores are labelled advisoryOnly=true when the loaded ruleset
  //    has ratification !== 'ratified'. The engine (scoreAcquisition) is fail-closed on
  //    non-ratified rulesets but acqConfig() surfaces that as a 503 error — all routes below
  //    that require scoring use acqConfig() and propagate that 503 correctly.

  // GET /acq/intel — ranked candidates with latest scores + calibration summary.
  // Query params: ?status=active|archived|acquired|passed &market=<ClusterTier>
  //               &verdict=PURSUE|WATCH|PASS|KILLED &limit=<n>
  app.get('/acq/intel', (c) =>
    withDb((db) => {
      const statusParam = c.req.query('status') ?? 'active';
      const marketParam = c.req.query('market') ?? null;
      const verdictParam = c.req.query('verdict') ?? null;
      const limitParam = parseLimitParam(c.req.query('limit'), 100, 500);

      // Build candidate query with optional filters.
      const where: string[] = ['c.status = ?'];
      const params: Array<string | number> = [statusParam];
      if (marketParam) { where.push('c.market = ?'); params.push(marketParam); }
      // Allowlist verdict values before binding to prevent junk params.
      const VALID_VERDICTS = new Set(['PURSUE', 'WATCH', 'PASS', 'KILLED']);
      if (verdictParam && VALID_VERDICTS.has(verdictParam)) {
        where.push('s.verdict = ?');
        params.push(verdictParam);
      }

      // Fetch candidates + latest score per candidate in one query.
      const rows = db.prepare(`
        SELECT
          c.id, c.source, c.source_batch_id, c.address, c.county, c.state,
          c.market, c.rentable_sf, c.year_built, c.owner_name,
          c.parcel_screen_score, c.status, c.notion_deal_id, c.created_at, c.updated_at,
          s.composite, s.tier, s.verdict, s.advisory_only, s.capped_at_t2,
          s.gates_passed, s.floors_passed, s.floor_indeterminate,
          s.governor_dscr_cleared, s.governor_ltv_cleared,
          s.score_json, COALESCE(c.current_scored_at, s.scored_at) AS scored_at, s.calibration_verdict_id
        FROM acq_candidates c
        LEFT JOIN acq_scores s ON s.id = c.current_score_id
        WHERE ${where.join(' AND ')}
        ORDER BY s.composite DESC NULLS LAST, c.created_at DESC
        LIMIT ?
      `).all(...params, limitParam) as Array<Record<string, unknown>>;

      // Build RankedCandidate list.
      const rankedCandidates = rows.map((row) => {
        const candidate = AcqCandidateRow.parse({
          id: row['id'],
          source: row['source'],
          sourceBatchId: row['source_batch_id'] ?? null,
          address: row['address'] ?? null,
          county: row['county'] ?? null,
          state: row['state'] ?? null,
          market: row['market'] ?? null,
          rentableSf: row['rentable_sf'] ?? null,
          yearBuilt: row['year_built'] ?? null,
          ownerName: row['owner_name'] ?? null,
          parcelScreenScore: row['parcel_screen_score'] ?? null,
          status: row['status'],
          notionDealId: row['notion_deal_id'] ?? null,
          createdAt: row['created_at'],
          updatedAt: row['updated_at'],
        });

        let latestScore: AcquisitionScore | null = null;
        if (row['score_json'] !== null && row['score_json'] !== undefined) {
          try {
            const parsed = AcquisitionScore.safeParse(JSON.parse(row['score_json'] as string));
            latestScore = parsed.success ? parsed.data : null;
          } catch {
            latestScore = null;
          }
        }

        return {
          candidate,
          latestScore,
          governorDscrCleared:
            row['governor_dscr_cleared'] === null || row['governor_dscr_cleared'] === undefined
              ? null
              : row['governor_dscr_cleared'] === 1,
          governorLtvCleared:
            row['governor_ltv_cleared'] === null || row['governor_ltv_cleared'] === undefined
              ? null
              : row['governor_ltv_cleared'] === 1,
          calibrationHitRate: null, // per-candidate hit-rate deferred to Phase 5
          scoredAt: row['scored_at'] ? String(row['scored_at']) : null,
        };
      });

      // Calibration summary for acquisition-score kind.
      const calReport = calibrationReport(db, { kind: 'acquisition-score' });
      const acqKind = calReport.byKind.find((k) => k.verdictKind === 'acquisition-score');

      // Advisory flag: true when no ratified ruleset is available (acqConfig() err means advisory).
      const cfg = acqConfig();
      const advisoryOnly = !cfg.ok || cfg.ruleset.ratification !== 'ratified';

      // Assemble the response without re-validating through the strict Zod schema —
      // latestScore is stored as a complete AcquisitionScore JSON blob and is passed
      // through opaquely (it was Zod-validated at insertion time via persistAndLogScore).
      const response = {
        rankedCandidates,
        calibrationSummary: {
          totalVerdicts: calReport.totalVerdicts,
          resolvedVerdicts: calReport.resolvedVerdicts,
          overallHitRate: acqKind?.hitRate ?? null,
          wilsonLow: acqKind?.wilsonLow ?? null,
          wilsonHigh: acqKind?.wilsonHigh ?? null,
        },
        advisoryOnly,
        rulesetVersion: cfg.ok ? cfg.ruleset.rulesetVersion : 'unavailable',
        asOf: new Date().toISOString(),
      };

      return c.json(response);
    }),
  );

  // GET /acq/candidates — unscored/all candidate list for pipeline view.
  // Query params: ?status=active &market=<tier> &limit=<n>
  app.get('/acq/candidates', (c) =>
    withDb((db) => {
      const statusParam = c.req.query('status') ?? 'active';
      const marketParam = c.req.query('market') ?? null;
      const limitParam = parseLimitParam(c.req.query('limit'), 200, 1000);

      const where: string[] = ['status = ?'];
      const params: Array<string | number> = [statusParam];
      if (marketParam) { where.push('market = ?'); params.push(marketParam); }

      const rows = db.prepare(`
        SELECT id, source, source_batch_id, address, county, state, market,
               rentable_sf, year_built, owner_name, parcel_screen_score,
               status, notion_deal_id, created_at, updated_at
        FROM acq_candidates
        WHERE ${where.join(' AND ')}
        ORDER BY created_at DESC
        LIMIT ?
      `).all(...params, limitParam) as Array<Record<string, unknown>>;

      const candidates = rows.map((row) =>
        AcqCandidateRow.parse({
          id: row['id'],
          source: row['source'],
          sourceBatchId: row['source_batch_id'] ?? null,
          address: row['address'] ?? null,
          county: row['county'] ?? null,
          state: row['state'] ?? null,
          market: row['market'] ?? null,
          rentableSf: row['rentable_sf'] ?? null,
          yearBuilt: row['year_built'] ?? null,
          ownerName: row['owner_name'] ?? null,
          parcelScreenScore: row['parcel_screen_score'] ?? null,
          status: row['status'],
          notionDealId: row['notion_deal_id'] ?? null,
          createdAt: row['created_at'],
          updatedAt: row['updated_at'],
        }),
      );

      return c.json({ candidates });
    }),
  );

  // POST /acq/import/parcel-screen — import a county-parcel-screen workbook batch.
  // Body: ParcelScreenImportRequest. Returns { batchId, inserted, skipped }.
  // Idempotent: same parcels re-imported are skipped (INSERT OR IGNORE on candidate id).
  // SPINE DISCIPLINE: only writes to acq_candidates + acq_source_batches (Spine C).
  app.post('/acq/import/parcel-screen', (c) =>
    withDb(async (db) => {
      const parsed = ParcelScreenImportRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.json({ error: 'invalid import body', issues: parsed.error.issues }, 400);
      const result = ingestParcelScreenBatch(db, parsed.data);
      return c.json(result, 200);
    }),
  );

  // POST /acq/score/:candidateId — run persistAndLogScore on a candidate.
  // Body: AcquisitionInput. Returns AcquisitionScore.
  // FAIL-CLOSED, same as /acquisition/score: 503 when the RATIFIED ruleset + RCT cannot load. There is
  // no fallback to a proposed ruleset — a persisted score feeds the ranked pipeline, the capital BUY
  // verdict and the calibration record, so it must only ever be produced from ratified math
  // (Invariant 4). persistAndLogScore re-asserts this itself. Error bodies are generic; detail is
  // logged server-side only (a raw String(e) can carry filesystem paths).
  app.post('/acq/score/:candidateId', (c) =>
    withDb(async (db) => {
      const candidateId = c.req.param('candidateId');
      if (!candidateId) return c.json({ error: 'candidateId required' }, 400);

      // Verify the candidate exists.
      const exists = db.prepare('SELECT id FROM acq_candidates WHERE id = ?').get(candidateId);
      if (!exists) return c.json({ error: 'candidate not found' }, 404);

      const inputParsed = AcquisitionInput.safeParse(await c.req.json().catch(() => ({})));
      if (!inputParsed.success) return c.json({ error: 'invalid acquisition input', issues: inputParsed.error.issues }, 400);

      const cfg = acqConfig();
      if (!cfg.ok) {
        console.error(`[acq/score] ratified config unavailable: ${cfg.error}`);
        return c.json({ error: 'acquisition engine unavailable' }, 503);
      }

      try {
        const result = await persistAndLogScore(db, candidateId, inputParsed.data, cfg.ruleset, cfg.rct);
        return c.json({ score: result.score, calibrationVerdictId: result.calibrationVerdictId });
      } catch (e) {
        console.error(`[acq/score] scoring failed for ${candidateId}: ${e instanceof Error ? e.message : String(e)}`);
        return c.json({ error: 'scoring failed' }, 500);
      }
    }),
  );

  // POST /acq/candidates — manual candidate entry (non-parcel-screen, non-Notion).
  // Body: subset of AcqCandidateRow (id generated server-side from address + timestamp).
  const ManualCandidateInput = AcqCandidateRow.pick({
    address: true, county: true, state: true, market: true,
    rentableSf: true, yearBuilt: true, ownerName: true,
  }).partial();

  app.post('/acq/candidates', (c) =>
    withDb(async (db) => {
      const parsed = ManualCandidateInput.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.json({ error: 'invalid candidate body', issues: parsed.error.issues }, 400);

      // Generate a stable id from address + ms timestamp (manual entries are less frequent).
      const ts = Date.now();
      const addrSlug = (parsed.data.address ?? 'unknown').toLowerCase().replace(/[^a-z0-9]/g, '-').slice(0, 40);
      const candidateId = `manual:${addrSlug}-${ts}`;

      db.prepare(`
        INSERT OR IGNORE INTO acq_candidates
          (id, source, address, county, state, market, rentable_sf, year_built, owner_name, status)
        VALUES (?, 'manual', ?, ?, ?, ?, ?, ?, ?, 'active')
      `).run(
        candidateId,
        parsed.data.address ?? null,
        parsed.data.county ?? null,
        parsed.data.state ?? null,
        parsed.data.market ?? null,
        parsed.data.rentableSf ?? null,
        parsed.data.yearBuilt ?? null,
        parsed.data.ownerName ?? null,
      );

      return c.json({ candidateId }, 200);
    }),
  );

  // PATCH /acq/candidates/:candidateId/status — status lifecycle transitions.
  // Body: { status: 'active'|'archived'|'acquired'|'passed' }
  // Returns: { ok: boolean }
  const StatusPatchInput = AcqCandidateRow.pick({ status: true });

  app.patch('/acq/candidates/:candidateId/status', (c) =>
    withDb(async (db) => {
      const candidateId = c.req.param('candidateId');
      if (!candidateId) return c.json({ error: 'candidateId required' }, 400);

      const parsed = StatusPatchInput.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.json({ error: 'invalid status body', issues: parsed.error.issues }, 400);

      const r = db.prepare(`
        UPDATE acq_candidates SET status = ?, updated_at = datetime('now') WHERE id = ?
      `).run(parsed.data.status, candidateId);

      if (r.changes === 0) return c.json({ ok: false, error: 'candidate not found' }, 404);

      // Phase-4 Step 8: log a calibration intent-outcome on lifecycle-resolving transitions.
      // Fail-open inside logAcqOutcome — never affects the 200 response.
      if (parsed.data.status === 'acquired' || parsed.data.status === 'passed') {
        logAcqOutcome(db, candidateId, parsed.data.status);
      }

      return c.json({ ok: true });
    }),
  );

  // POST /acq/sync/notion — pull the Notion Acquisition Pipeline and upsert into acq_candidates.
  // Requires NOTION_TOKEN env var (never committed). Returns { inserted, updated, errors[] }.
  // Read-only from Notion; writes only Spine-C acq_candidates. First-page failure → 502.
  app.post('/acq/sync/notion', (c) =>
    withDb(async (db) => {
      const token = process.env['NOTION_TOKEN'];
      if (!token) return c.json({ error: 'NOTION_TOKEN not configured' }, 400);
      try {
        const result = await syncNotionPipeline(db, token);
        return c.json(result, 200);
      } catch (err) {
        console.error('[warehouse-api] /acq/sync/notion error:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'notion sync failed' }, 502);
      }
    }),
  );

  // POST /acq/sync/hubspot — pull the HubSpot "Acquisitions" pipeline (885606973) and upsert
  // into acq_candidates. Requires HUBSPOT_TOKEN env var (never committed). Returns
  // { inserted, updated, errors[] }. Read-only from HubSpot; writes only Spine-C acq_candidates.
  // First-page failure → 502. Second, independent feed alongside /acq/sync/notion — the two
  // never collide (namespaced ids: 'deal:hubspot:<id>' vs 'deal:<notionPageId>').
  app.post('/acq/sync/hubspot', (c) =>
    withDb(async (db) => {
      const token = process.env['HUBSPOT_TOKEN'];
      if (!token) return c.json({ error: 'HUBSPOT_TOKEN not configured' }, 400);
      try {
        const result = await syncHubSpotPipeline(db, token);
        return c.json(result, 200);
      } catch {
        return c.json({ error: 'hubspot sync failed' }, 502);
      }
    }),
  );

  // ── GET /capital-allocation (Phase 5 — Capital Allocation Capstone) ───────────────────────
  //
  // Synthesizes all existing intelligence streams (Spine A NOI/SF, health/attention scores,
  // Phase 2 debt scores, Phase 3 leasing signals, FRED macro) into a ranked Capital Allocation
  // Report. Pure read layer — no writes to DB, overlay, or external services.
  //
  // H6 read boundary: response is parsed through CapitalAllocationReport before emitting.
  // noiBasis:'spine-a' on every entry — this is the ownership capital-allocation layer,
  // NOT the Spine-B warehouse ledger. Never compare these NOI figures with /analytics/scores.
  //
  // Error policy (mirrors lease-forecast-api):
  //   503 when warehouse or snapshot unavailable.
  //   500 on unexpected engine errors.
  app.get('/capital-allocation', (c) =>
    withDb(async (db) => {
      try {
        const { brain } = await import('../brain');
        const snapshot = await brain.getSnapshot();
        if (!snapshot) return c.json({ error: 'snapshot unavailable' }, 503);
        const report = await buildCapitalAllocationReport(db, snapshot);
        return c.json(CapitalAllocationReport.parse(report));
      } catch (err) {
        console.error('[warehouse-api] /capital-allocation error:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'capital allocation failed' }, 500);
      }
    }),
  );

  // ── POST /capital-allocation/sync-notion (Direction 1 — Notion Writeback) ─────────────────
  //
  // Recomputes the Capital Allocation Report, then writes each property's capitalAction +
  // priorityScore back to the Notion 🏢 Property Register (the operational per-property DB).
  // Requires NOTION_TOKEN (never committed). Localhost-only via the existing CORS guard.
  //
  // FAIL-OPEN: the writeback never throws on per-property mismatch or a single page failure —
  //   it returns { synced, skipped, errors[], asOf }. Only a missing token (400) or an
  //   unavailable snapshot (503) short-circuits. The H6 read boundary parses the result.
  app.post('/capital-allocation/sync-notion', (c) =>
    withDb(async (db) => {
      const token = process.env['NOTION_TOKEN'];
      if (!token) return c.json({ error: 'NOTION_TOKEN not configured' }, 400);
      try {
        const { brain } = await import('../brain');
        const snapshot = await brain.getSnapshot();
        if (!snapshot) return c.json({ error: 'snapshot unavailable' }, 503);
        const report = await buildCapitalAllocationReport(db, snapshot);
        const result = await syncCapitalActionsToNotion(
          report.entries.map((e) => ({
            propertyName: e.propertyName,
            capitalAction: e.capitalAction,
            priorityScore: e.priorityScore,
          })),
          token,
          { asOf: report.asOf },
        );
        return c.json(NotionSyncResult.parse(result));
      } catch (err) {
        console.error('[warehouse-api] /capital-allocation/sync-notion error:', err instanceof Error ? err.message : String(err));
        return c.json({ error: 'notion writeback failed' }, 500);
      }
    }),
  );

  // ── GET /capital-allocation/ic-memo (Direction 2 — IC Memo HTML export) ───────────────────
  //
  // Returns the PortfolioAllocation rendered as a self-contained, ORA-styled HTML memo for
  // Investment Committee review. The browser's "Print to PDF" turns it into an extractable-text
  // PDF — per the firm rule that exported PDFs carry a text layer.
  //
  // assertNoEgressRosterMatch is defense-in-depth: the portfolio is an ownership-financial artifact
  // and by construction carries no deal terms, but we PROVE it before emitting. The memo is an
  // attachment that leaves the machine for IC review, so it gets the EGRESS match (refute round 5,
  // F4: normalised, refuses an unreadable or placeholder roster), over everything the HTML renders
  // (the portfolio AND the report entries), not the portfolio alone.
  app.get('/capital-allocation/ic-memo', () =>
    withDb(async (db) => {
      try {
        // referenceDate() (see server/config.ts) — NOT a raw UTC slice; this asOf now anchors
        // real date math inside buildPortfolioAllocation -> scoreDebtPositions' fresh maturity
        // recompute. Captured ONCE and passed explicitly into buildCapitalAllocationReport below
        // so the IC memo's two halves share one as-of date rather than each independently calling
        // referenceDate() and risking a UTC-midnight race between them.
        const asOf = referenceDate();
        const { brain } = await import('../brain');
        const snapshot = await brain.getSnapshot();
        const portfolio = await buildPortfolioAllocation(db, asOf, undefined, snapshot ?? undefined);
        const entries = snapshot ? (await buildCapitalAllocationReport(db, snapshot, asOf)).entries : undefined;
        assertNoEgressRosterMatch({ portfolio, entries: entries ?? null });
        const html = buildIcMemoHtml(portfolio, entries);
        return new Response(html, {
          status: 200,
          headers: {
            'content-type': 'text/html; charset=utf-8',
            'content-disposition': `attachment; filename="${icMemoFilename(portfolio)}"`,
          },
        });
      } catch {
        console.error('[warehouse-api] /capital-allocation/ic-memo generation failed');
        return new Response(JSON.stringify({ error: 'ic memo generation failed' }), {
          status: 500,
          headers: { 'content-type': 'application/json' },
        });
      }
    }),
  );

  // ── Prospect Demand Intelligence (Direction 3) ────────────────────────────────────────────
  //    External demand signals on portfolio properties (broker showings, inquiries, LOI, tours,
  //    follow-ups). Read-only GET returns the per-property aggregate report (H6 read boundary:
  //    .parse()d before c.json). POST manually logs one event (the analyst-entry path today;
  //    the future Outlook ingest pipeline will write the same table with source='outlook').
  //    Behind the same 503 guard; this is portfolio-FINANCIAL/ops data, never a confidential deal term.

  // GET /api/warehouse/prospect-demand → ProspectDemandReport
  app.get('/prospect-demand', (c) =>
    withDb((db) => c.json(ProspectDemandReport.parse(getProspectDemandReport(db)))),
  );

  // POST /api/warehouse/prospect-demand → ProspectDemandEvent (201)
  // Body: ProspectDemandEventInput (a ProspectDemandEvent minus server-generated id + created_at).
  // 400 on a malformed/missing-required-field body (Zod). source defaults to 'manual'.
  app.post('/prospect-demand', (c) =>
    withDb(async (db) => {
      const parsed = ProspectDemandEventInput.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.json({ error: 'invalid prospect demand event', issues: parsed.error.issues }, 400);
      const event = addProspectEvent(db, parsed.data);
      return c.json(event, 201);
    }),
  );


  return app;
}
