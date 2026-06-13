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
import { Classification } from '../../src/contracts/warehouse';
import type { WarehouseDb } from './db';
import { addMappingOverride, approveImport, rejectImport, resolveIssue } from './actions';
import { getImportDetail, listImports, listIssues, noiMatrix } from './queries';
import { detectAnomalies } from './anomalies';
import { benchmarkMetric, pmScorecards, rankProperties } from './benchmarks';
import type { NumericMetricKey } from './benchmarks';
import { decomposeNoiChange, noiImpactByCategory } from './drivers';
import { growthSeries, sinceAcquisition } from './growth';
import { propertyPeriodMetrics } from './metrics';
import type { PeriodMetrics } from './metrics';
import { scoreProperties } from './scores';

const ActionInput = z.object({ action: z.enum(['approve', 'reject']) });

const AddMappingInputSchema = z.object({
  account: z.string().min(1),
  normalizedCategory: z.string().min(1),
  classification: Classification,
  propertyId: z.string().min(1).optional(),
});

// Benchmarkable numeric metric keys (kept in lockstep with NumericMetricKey in benchmarks.ts).
const NumericMetric = z.enum([
  'revenue', 'opex', 'noi', 'oxfordNoi',
  'noiMargin', 'expenseRatio',
  'revenuePerSf', 'noiPerSf', 'expensePerSf',
  'taxesPerSf', 'insurancePerSf', 'repairsPerSf',
]);

// A 4-digit year period token (e.g. '2025'); optional on the query string.
const Year = z.string().regex(/^\d{4}$/);

const BenchmarksQuery = z.object({
  period: Year.optional(),
  metric: NumericMetric.optional(),
});

const DriversQuery = z.object({
  from: Year.optional(),
  to: Year.optional(),
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

/** Parse a path id param to a positive integer, or null when it is not a clean integer. */
function parseId(raw: string): number | null {
  if (!/^\d+$/.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
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

  app.get('/analytics/metrics', (c) => withDb((db) => c.json({ metrics: propertyPeriodMetrics(db) })));

  app.get('/analytics/growth', (c) =>
    withDb((db) => {
      const groups = groupByProperty(propertyPeriodMetrics(db));
      const growth = [...groups.values()].flatMap((series) => growthSeries(series));
      const since = [...groups.values()].map((series) => sinceAcquisition(series));
      return c.json({ growth, sinceAcquisition: since });
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
      return c.json({ propertyId, from, to, ...decomposition });
    }),
  );

  app.get('/analytics/anomalies', (c) =>
    withDb((db) => c.json({ anomalies: detectAnomalies(propertyPeriodMetrics(db)) })),
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

      return c.json({
        byMetric: benchmarkMetric(metrics, period, metric),
        rankings: rankProperties(metrics, period, metric),
      });
    }),
  );

  app.get('/analytics/scores', (c) =>
    withDb((db) => c.json({ scores: scoreProperties(db, propertyPeriodMetrics(db)) })),
  );

  app.get('/analytics/pm', (c) =>
    withDb((db) => c.json({ scorecards: pmScorecards(db, propertyPeriodMetrics(db)) })),
  );

  return app;
}
