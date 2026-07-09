// scripts/bake-warehouse.ts
//
// Fat-Mirror bake (Eric Live Phase 1b). Emits public/warehouse.json holding the COMPUTED route
// payloads for the two server-only read modules — Property Financial Intelligence (PFI) and the
// Calibration Log (READ) — so they work on the Cloudflare Pages mirror, which has no Brain Server.
//
// FIDELITY: payloads are produced by invoking the REAL Hono warehouse router (server/warehouse/api.ts)
// — in-process via `app.request` when reading the local DB, or over HTTP against a running Brain Server
// — so a baked payload is identical-by-construction to what the live route returns. NO engine port, no
// route-logic reimplementation, no scores.ts/metrics.ts/queries.ts change.
//
// WAL CORRECTNESS (spec §2): prefer a running Brain Server (it sees its own uncommitted WAL writes);
// only when it is down do we open finance.sqlite directly, and then force a wal_checkpoint(TRUNCATE)
// first so the read can't bake LESS than the committed state.
//
// CADENCE: this is the HEAVY, infrequent bake (daily / on-backfill) — kept OUT of the light hourly
// snapshot bake. scripts/bake-mirror.ts calls bakeWarehouseJson() only under --warehouse / BAKE_WAREHOUSE=1.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { warehouseRoutes } from '../server/warehouse/api';
import { openWarehouse } from '../server/warehouse/db';
import type { WarehouseDb } from '../server/warehouse/db';
import { serverPort } from '../server/config';
import { NumericMetricKey } from '../src/contracts/warehouse';
import {
  WAREHOUSE_MIRROR_SCHEMA_VERSION,
  type WarehouseMirrorEnvelope,
  type WarehouseSource,
} from '../src/lib/warehouse-mirror';

/** Resolve ONE warehouse route. `routerPath` omits the `/api/warehouse` mount prefix. */
export type RouteResolver = (routerPath: string) => Promise<{ status: number; json: unknown }>;

/** In-process resolver: drives the real Hono router over a db handle (no network). */
export function inProcessResolver(db: WarehouseDb): RouteResolver {
  const app = warehouseRoutes(() => db);
  return async (routerPath) => {
    const res = await app.request(routerPath);
    return { status: res.status, json: res.status === 200 ? await res.json() : null };
  };
}

/** HTTP resolver: drives a running Brain Server's routes (it sees its own WAL writes). */
export function httpResolver(baseUrl: string): RouteResolver {
  return async (routerPath) => {
    const res = await fetch(`${baseUrl}/api/warehouse${routerPath}`);
    const ct = res.headers.get('content-type') ?? '';
    const ok = res.status === 200 && ct.includes('application/json');
    return { status: res.status, json: ok ? await res.json() : null };
  };
}

interface MetricRow { propertyId: string; period: string }

/** Distinct, sorted full-year period tokens (`YYYY`). A superset that always covers the client's
 *  requests; harmless dead keys (e.g. a YTD token) never break a lookup. */
function fullYearTokens(periods: string[]): string[] {
  return [...new Set(periods.filter((p) => /^\d{4}$/.test(p)))].sort((a, b) => a.localeCompare(b));
}

/** All ordered (from < to) full-year pairs — the reachable drivers space for one property. */
function orderedPairs(tokens: string[]): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (let i = 0; i < tokens.length; i++) {
    for (let j = i + 1; j < tokens.length; j++) out.push([tokens[i]!, tokens[j]!]);
  }
  return out;
}

/**
 * The exact set of router paths the bake resolves. Keys are built with the SAME encodeURIComponent
 * the client hooks use, so a baked key matches the client's live request verbatim.
 */
/** The non-parameterized routes every PFI/calibration-read view depends on. A non-200 from any of
 *  these means a broken bake DB — the bake hard-FAILS rather than emit a partial mirror (a view would
 *  otherwise silently read as offline with no signal the bake was incomplete). */
const FIXED_ROUTES = [
  '/noi', '/imports', '/issues',
  '/analytics/metrics', '/analytics/scores', '/analytics/pm',
  '/analytics/growth', '/analytics/anomalies', '/analytics/lease-run',
  '/calibration/log', '/calibration/pending', '/calibration/report',
] as const;

export function warehouseEndpointPlan(metrics: MetricRow[], leaseRunIds: string[]): string[] {
  const fixed = [...FIXED_ROUTES];

  const byProperty = new Map<string, string[]>();
  for (const m of metrics) {
    const arr = byProperty.get(m.propertyId) ?? [];
    arr.push(m.period);
    byProperty.set(m.propertyId, arr);
  }
  const allPeriods = fullYearTokens(metrics.map((m) => m.period));
  const metricKeys = NumericMetricKey.options;

  const benchmarks = allPeriods.flatMap((period) =>
    metricKeys.map(
      (metric) => `/analytics/benchmarks?period=${encodeURIComponent(period)}&metric=${encodeURIComponent(metric)}`,
    ),
  );

  const drivers = [...byProperty.entries()].flatMap(([propertyId, periods]) =>
    orderedPairs(fullYearTokens(periods)).map(
      ([from, to]) =>
        `/analytics/drivers/${encodeURIComponent(propertyId)}?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`,
    ),
  );

  const leaseRun = leaseRunIds.map((id) => `/analytics/lease-run/${encodeURIComponent(id)}`);

  // De-dup while preserving order (fixed first → stable, diff-friendly output).
  return [...new Set([...fixed, ...leaseRun, ...benchmarks, ...drivers])];
}

export interface BuildOpts {
  now: number;
  warehouseSource: WarehouseSource;
}

/**
 * Resolve every planned endpoint and assemble the warehouse.json envelope. Only successful (200)
 * route responses are stored — a 503/4xx is skipped, never baked as data. The envelope key is the
 * exact client request path (`/api/warehouse` + routerPath).
 */
export async function buildWarehouseEnvelope(
  resolver: RouteResolver,
  opts: BuildOpts,
): Promise<WarehouseMirrorEnvelope> {
  // Enumeration inputs come from the routes themselves (one source of truth). Fail LOUD if a read the
  // whole plan depends on did not return 200 JSON — never bake a partial/empty mirror silently.
  const metricsRes = await resolver('/analytics/metrics');
  if (metricsRes.status !== 200 || !Array.isArray((metricsRes.json as { metrics?: unknown } | null)?.metrics)) {
    throw new Error(`warehouse bake failed: /analytics/metrics returned ${metricsRes.status} (not 200 JSON metrics)`);
  }
  const metrics = (metricsRes.json as { metrics: MetricRow[] }).metrics.map((m) => ({
    propertyId: m.propertyId,
    period: m.period,
  }));
  const rollupRes = await resolver('/analytics/lease-run');
  if (rollupRes.status !== 200 || !Array.isArray((rollupRes.json as { summaries?: unknown } | null)?.summaries)) {
    throw new Error(`warehouse bake failed: /analytics/lease-run returned ${rollupRes.status} (not 200 JSON summaries)`);
  }
  const rollupIds = (rollupRes.json as { summaries: Array<{ propertyId: string }> }).summaries.map((s) => s.propertyId);
  // lease-run/:id for every lease-term property AND every metrics property (superset; route returns a
  // typed EMPTY projection for a no-terms property — a 200, so it bakes).
  const leaseRunIds = [...new Set([...rollupIds, ...metrics.map((m) => m.propertyId)])];

  const plan = warehouseEndpointPlan(metrics, leaseRunIds);
  const required = new Set<string>(FIXED_ROUTES);
  const endpoints: Record<string, unknown> = {};
  for (const routerPath of plan) {
    const { status, json } = await resolver(routerPath);
    if (status === 200 && json !== null) {
      endpoints[`/api/warehouse${routerPath}`] = json;
    } else if (required.has(routerPath)) {
      // A parameterized slice may legitimately 404 (skip it); a REQUIRED route must not — fail loud.
      throw new Error(`warehouse bake failed: required endpoint ${routerPath} returned ${status}`);
    }
  }

  return {
    schemaVersion: WAREHOUSE_MIRROR_SCHEMA_VERSION,
    bakedAt: new Date(opts.now).toISOString(),
    warehouseSource: opts.warehouseSource,
    endpoints,
  };
}

/** Probe a running Brain Server: warehouse routes present AND warm (a 200 JSON /noi). */
async function brainServerUp(baseUrl: string): Promise<boolean> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 1500);
  try {
    const res = await fetch(`${baseUrl}/api/warehouse/noi`, { signal: ctl.signal });
    return res.status === 200 && (res.headers.get('content-type') ?? '').includes('application/json');
  } catch {
    return false;
  } finally {
    clearTimeout(t); // clear on every exit path (success, non-200, throw/abort) so no timer dangles
  }
}

export interface BakeResult { path: string; warehouseSource: WarehouseSource; count: number }

/**
 * Orchestrate the bake: prefer a running Brain Server; else checkpoint + read the local DB. Writes
 * public/warehouse.json. The ONLY DB mutation is a WAL checkpoint (no DDL, no data write).
 */
export async function bakeWarehouseJson(opts: { now?: number } = {}): Promise<BakeResult> {
  const now = opts.now ?? Date.now();
  const baseUrl = process.env.BRAIN_BAKE_SOURCE_URL ?? `http://127.0.0.1:${serverPort()}`;

  let resolver: RouteResolver;
  let warehouseSource: WarehouseSource;
  let db: WarehouseDb | null = null;

  if (await brainServerUp(baseUrl)) {
    resolver = httpResolver(baseUrl);
    warehouseSource = 'live-server';
  } else {
    const dbPath = process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
    db = openWarehouse(dbPath);
    db.pragma('wal_checkpoint(TRUNCATE)'); // flush WAL → committed DB so the read can't lag the server
    resolver = inProcessResolver(db);
    warehouseSource = 'checkpoint-read';
  }

  try {
    const env = await buildWarehouseEnvelope(resolver, { now, warehouseSource });
    const pub = join(process.cwd(), 'public');
    mkdirSync(pub, { recursive: true });
    const outPath = join(pub, 'warehouse.json');
    writeFileSync(outPath, JSON.stringify(env));
    return { path: outPath, warehouseSource, count: Object.keys(env.endpoints).length };
  } finally {
    db?.close();
  }
}
