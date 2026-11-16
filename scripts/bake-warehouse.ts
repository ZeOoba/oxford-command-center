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
import { WAREHOUSE_SUB_ROUTERS } from '../server/warehouse/sub-routers';
import { leaseMarketApi } from '../server/warehouse/lease-market-api';
import Database from 'better-sqlite3';
import type { WarehouseDb } from '../server/warehouse/db';
import { serverPort } from '../server/config';
import { NumericMetricKey } from '../src/contracts/warehouse';
import { egressRosterScanner } from '../server/briefing/roster-match';
import {
  WAREHOUSE_MIRROR_SCHEMA_VERSION,
  type WarehouseMirrorEnvelope,
  type WarehouseSource,
} from '../src/lib/warehouse-mirror';

/** Resolve ONE warehouse route. `routerPath` omits the `/api/warehouse` mount prefix. */
export type RouteResolver = (routerPath: string) => Promise<{ status: number; json: unknown }>;

/** In-process resolver: drives the real Hono routers over a db handle (no network). Every
 *  sub-router in WAREHOUSE_SUB_ROUTERS (warehouse/sub-routers.ts — the SAME list server/index.ts
 *  mounts from) is mounted SEPARATELY from the base warehouseRoutes() app, so a routerPath under
 *  one of those prefixes has to be delegated to that specific sub-router instance or it 404s here
 *  even though the SAME db handle would serve it fine on the live server. httpResolver doesn't
 *  need this split — it calls the real running server, which already has every mount wired.
 *
 *  FIXED 2026-08-21 (adversarial review finding): this used to hardcode a single BRAIN_PREFIX
 *  branch for brainApi alone — the fix for the Command Brain module reading "offline" on every
 *  checkpoint-read bake (the unattended scheduled-deploy case, which runs with no dev server up).
 *  That left the identical 404 gap latent for the other 7 sub-routers, and duplicated the '/brain'
 *  mount-path literal across two files. Now builds the dispatch table from the shared
 *  WAREHOUSE_SUB_ROUTERS list — checked longest-prefix-first so '/insurance/analysis' and
 *  '/insurance/loss' don't collide — with any unmatched path falling through to the base app.
 *
 *  Fix round 1, item 1 (bake-scoped redaction): `/lease-market` is special-cased to build its own
 *  router instance directly (instead of the shared factory) so `leaseMarketRowLevel` can override
 *  `config.mirrorRowLevel` for this ONE bake-time instance — config/lease-market.json ships
 *  mirrorRowLevel:true (ratified for the private, Access-gated mirror) and must stay that way; the
 *  redacted/public-safe bake forces false here instead of touching the shipped config. Kept local to
 *  this one prefix rather than generalizing WAREHOUSE_SUB_ROUTERS's factory signature — every other
 *  sub-router has no bake-time redaction concept to override.
 *
 *  CROSS-REFERENCE (fix round 2, item 3): the `'/lease-market'` string literal below must match the
 *  `prefix` field of the `/lease-market` entry in server/warehouse/sub-routers.ts's
 *  WAREHOUSE_SUB_ROUTERS list verbatim — if that prefix is ever renamed there without updating this
 *  literal, this special case silently stops firing and the shared `factory(() => db)` branch takes
 *  over instead, which builds a leaseMarketApi() instance with NO `rowLevel` override (i.e. a
 *  "redacted" bake would silently stop redacting lease-market data). Regression-guarded by
 *  tests/unit/lease-market-api-bake.test.ts ("WAREHOUSE_SUB_ROUTERS still has a '/lease-market'
 *  prefix entry"). */
export function inProcessResolver(db: WarehouseDb, opts: { leaseMarketRowLevel?: boolean } = {}): RouteResolver {
  const app = warehouseRoutes(() => db);
  const subApps = WAREHOUSE_SUB_ROUTERS
    .map(({ prefix, factory }) =>
      prefix === '/lease-market'
        ? { prefix, app: leaseMarketApi(() => db, { rowLevel: opts.leaseMarketRowLevel }) }
        : { prefix, app: factory(() => db) },
    )
    .sort((a, b) => b.prefix.length - a.prefix.length);
  return async (routerPath) => {
    const sub = subApps.find((s) => routerPath === s.prefix || routerPath.startsWith(`${s.prefix}/`));
    const target = sub
      ? { app: sub.app, path: routerPath.slice(sub.prefix.length) || '/' }
      : { app, path: routerPath };
    const res = await target.app.request(target.path);
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
  '/analytics/trends/history',
  '/calibration/log', '/calibration/pending', '/calibration/report',
  '/brain/report',
  '/lease-market/summary', '/lease-market/positioning', '/lease-market/radar', '/lease-market/signals', '/lease-market/changes',
] as const;

/** Routes whose failure hard-aborts the whole bake (fail LOUD — a broken bake DB, never a
 *  silent partial mirror). A SUBSET of FIXED_ROUTES: FIXED 2026-08-21 (adversarial review
 *  finding) — /brain/report is still always planned (baked normally when it succeeds), but
 *  deliberately excluded from "required" here. Unlike the other FIXED_ROUTES (simple DB reads),
 *  it composes multiple derived cohorts (calibration report, pending queue, coverage confidence,
 *  open questions) and can plausibly throw on an edge-case data state; giving it the same
 *  must-succeed status as NOI/analytics/calibration meant one brain-report failure took the
 *  entire mirror down with it. A brain-report failure now just omits that one endpoint from
 *  warehouse.json (the Brain view reads as offline, same as before this route was wired in)
 *  instead of failing every other view too. */
// Lease-market routes are optional: no CoStar export yet, or no snapshot in the bake process, must not block the mirror.
// /analytics/trends/history is likewise optional: new in Portfolio Trends Wave 2, it reads
// portfolio_month_snapshot (migration 033), so a warehouse without that migration applied (or with no
// snapshot rows yet) may 503/return empty — that must omit one endpoint (the client falls back to
// reconstruction), never take the whole mirror down.
const OPTIONAL_ROUTES = new Set<string>(['/brain/report', '/analytics/trends/history']);
const REQUIRED_ROUTES = new Set<string>(FIXED_ROUTES.filter((r) => !OPTIONAL_ROUTES.has(r) && !r.startsWith('/lease-market/')));

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
  /**
   * Fix round 1, item 1 (bake-scoped redaction); wiring corrected fix round 3 (whole-branch review,
   * Finding 1 — confidentiality asymmetry, 2026-09-17). `false` omits every `/lease-market/*` route
   * from the plan entirely, applied UNIFORMLY on both resolver paths — bakeWarehouseJson derives
   * this from `includeConfidential` via `leaseMarketBakeMode` and passes the SAME value regardless
   * of whether the resolver is the checkpoint-read/in-process path or the httpResolver/live-server
   * path. Previously this field only reached the http path; the in-process path always planned the
   * routes unconditionally (redacting row-level fields via `leaseMarketRowLevel`, but still baking
   * the endpoints themselves) — that asymmetry is the bug this fix closes. Omitted/true ⇒ routes
   * planned as usual (unchanged from Task 14).
   */
  includeLeaseMarket?: boolean;
  /**
   * Audit 2026-10-13 F1 (Hard Invariant 3). `true` = the private, Access-gated bake: every planned
   * route bakes verbatim. `false` OR OMITTED = the redacted/public-safe bake (fail-closed default):
   * the acquisition-adjacent routes in ACQ_REDACTED_ROUTES are post-filtered by
   * redactAcquisitionPayload — deal-kind calibration subjects (`parcel:<…:apn>`,
   * `pipeline:<candidateId>`), floor-indeterminate open questions (their titles embed
   * acq_candidates.address, which the HubSpot sync fills with the raw dealname) and trackRecord
   * entries for anything but a known non-deal subject are removed. Refute round 6, G4: EVERY planned
   * endpoint (not just those four) is then roster-scanned; a hit drops that endpoint and records it,
   * and an unreadable or placeholder roster, or a scanner throw, REFUSES the whole bake.
   */
  includeConfidential?: boolean;
  /** Roster scan used by the redacted bake; injectable for tests. Must THROW when the roster cannot
   *  be verified (a throw refuses the bake). Defaults to a scanner bound once via
   *  egressRosterScanner (unreadable or placeholder roster ⇒ throws ⇒ the bake is refused). */
  confidentialScan?: (value: unknown) => { dealLabel: string } | null;
}

/** Routes that carry acquisition-pipeline identifiers and are post-filtered in redacted mode. */
export const ACQ_REDACTED_ROUTES: ReadonlySet<string> = new Set([
  '/brain/report', '/calibration/log', '/calibration/pending', '/calibration/report',
]);

/** subjectId prefixes minted for acquisition candidates (007_acq_candidates.sql id scheme and the
 *  capital-allocation `pipeline:${candidateId}` buy token). Belt-and-braces beside subjectKind. */
const DEAL_SUBJECT_PREFIXES = ['pipeline:', 'parcel:', 'deal:'];

interface CalLogRowLike { subjectKind?: unknown; subjectId?: unknown }

function isDealSubject(row: CalLogRowLike): boolean {
  const id = typeof row.subjectId === 'string' ? row.subjectId : '';
  return row.subjectKind === 'deal' || DEAL_SUBJECT_PREFIXES.some((p) => id.startsWith(p));
}

export interface AcqRedactionContext {
  /** Subjects known NOT to be acquisition candidates (portfolio property ids + non-deal calibration
   *  subjects). trackRecord carries no subjectKind, so it is filtered by this ALLOWLIST — an unknown
   *  subject is dropped (fail closed). */
  nonDealSubjects: ReadonlySet<string>;
  scan: (value: unknown) => { dealLabel: string } | null;
}

/**
 * Redacted-mode post-filter for one ACQ_REDACTED_ROUTES payload. Returns the filtered payload, or
 * `null` to drop the route entirely (roster hit, or the roster could not be verified). Pure apart
 * from the injected scan.
 */
export function redactAcquisitionPayload(routerPath: string, json: unknown, ctx: AcqRedactionContext): unknown {
  let out: unknown = json;
  const obj = json as Record<string, unknown> | null;
  if (obj && typeof obj === 'object') {
    if (routerPath === '/calibration/log' && Array.isArray(obj.log)) {
      out = { ...obj, log: (obj.log as CalLogRowLike[]).filter((r) => !isDealSubject(r)) };
    } else if (routerPath === '/calibration/pending' && Array.isArray(obj.pending)) {
      out = { ...obj, pending: (obj.pending as CalLogRowLike[]).filter((r) => !isDealSubject(r)) };
    } else if (routerPath === '/brain/report') {
      const oq = Array.isArray(obj.openQuestions) ? (obj.openQuestions as Array<{ kind?: unknown }>) : [];
      const tr = Array.isArray(obj.trackRecord) ? (obj.trackRecord as Array<{ subject?: unknown }>) : [];
      out = {
        ...obj,
        openQuestions: oq.filter((q) => q.kind !== 'floor-indeterminate'),
        trackRecord: tr.filter((t) => typeof t.subject === 'string' && ctx.nonDealSubjects.has(t.subject)),
      };
    }
  }
  try {
    const hit = ctx.scan(out);
    if (hit) {
      console.warn(`[bake-warehouse] redacted bake: ${routeTemplate(routerPath)} matches an active confidential deal — route omitted.`);
      return null;
    }
  } catch {
    // A FIXED string, never the scanner's error message (refute round 8, J4): a scanner error can
    // quote its input or a roster term, and logs are a sink.
    console.warn(
      `[bake-warehouse] redacted bake: confidential roster could not be verified ` +
        `(roster scan error) — ${routeTemplate(routerPath)} omitted (fail closed).`,
    );
    return null;
  }
  return out;
}

const FIXED_ROUTE_SET = new Set<string>(FIXED_ROUTES);

/** A router path as a LOG-SAFE template (refute round 7, H3): a parameterised route embeds a
 *  property id, and an id can itself be a roster term, so every segment past the route family (the
 *  first two) becomes ':id' and any query string '?…'. A FIXED_ROUTES path is static and kept. */
export function routeTemplate(routerPath: string): string {
  const q = routerPath.indexOf('?');
  const path = q === -1 ? routerPath : routerPath.slice(0, q);
  const base = FIXED_ROUTE_SET.has(path)
    ? path
    : path.split('/').map((seg, i) => (i <= 2 ? seg : ':id')).join('/');
  return q === -1 ? base : `${base}?…`;
}

/** The log line for the endpoints a redacted bake omitted: a COUNT plus each route template with
 *  its own count, never a raw path (H3). '' when nothing was omitted. */
export function describeOmittedRoutes(omitted: string[]): string {
  if (omitted.length === 0) return '';
  const byTemplate = new Map<string, number>();
  for (const p of omitted) {
    const t = routeTemplate(p);
    byTemplate.set(t, (byTemplate.get(t) ?? 0) + 1);
  }
  const parts = [...byTemplate].map(([t, n]) => `${t} x${n}`);
  return `${omitted.length} warehouse endpoint(s) omitted by the roster scan: ${parts.join(', ')}`;
}

/** The redacted bake's refusal: the roster could not be verified, so nothing may be published. */
function bakeRefusal(why: string): Error {
  return new Error(
    `warehouse bake failed: refusing to bake a redacted public/warehouse.json — ${why}. ` +
      `No public/warehouse.json is published by this run (bake-mirror.ts removed the previous one before the bake).`,
  );
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
  return (await buildWarehouseBake(resolver, opts)).envelope;
}

/**
 * buildWarehouseEnvelope plus the router paths the redacted bake OMITTED on a roster hit (refute
 * round 6, G4). Redacted mode (the default): the roster scanner is bound ONCE up front, and an
 * unreadable / placeholder roster refuses the bake before anything is resolved; every planned
 * endpoint payload (after the acquisition post-filter for ACQ_REDACTED_ROUTES) is scanned with the
 * normalised egress matcher; a hit omits that endpoint; a scanner throw refuses the bake.
 */
export async function buildWarehouseBake(
  resolver: RouteResolver,
  opts: BuildOpts,
): Promise<{ envelope: WarehouseMirrorEnvelope; omitted: string[] }> {
  const redactedMode = opts.includeConfidential !== true;
  let scan: ((value: unknown) => { dealLabel: string } | null) | null = null;
  if (redactedMode) {
    if (opts.confidentialScan) scan = opts.confidentialScan;
    else {
      try {
        scan = egressRosterScanner();
      } catch {
        throw bakeRefusal('the confidential roster is unreadable, malformed or the placeholder stand-in');
      }
    }
  }
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

  const plan = warehouseEndpointPlan(metrics, leaseRunIds).filter(
    (routerPath) => opts.includeLeaseMarket !== false || !routerPath.startsWith('/lease-market/'),
  );
  const required = REQUIRED_ROUTES;

  // Redacted mode (the fail-closed default): build the trackRecord allowlist from data that is
  // itself non-deal — portfolio property ids from the metrics read above plus every non-deal
  // subject in the calibration log — resolved here so it does not depend on plan order.
  let redaction: AcqRedactionContext | null = null;
  let scanError: unknown = null;
  if (redactedMode) {
    const nonDealSubjects = new Set<string>(metrics.map((m) => m.propertyId));
    const logRes = await resolver('/calibration/log');
    const logRows = (logRes.json as { log?: unknown } | null)?.log;
    if (logRes.status === 200 && Array.isArray(logRows)) {
      for (const r of logRows as CalLogRowLike[]) {
        if (!isDealSubject(r) && typeof r.subjectId === 'string') nonDealSubjects.add(r.subjectId);
      }
    }
    // The acquisition post-filter's own scan: a throw is recorded and refuses the bake below
    // (redactAcquisitionPayload itself only drops the route on a throw).
    redaction = {
      nonDealSubjects,
      scan: (v) => {
        try {
          return scan!(v);
        } catch (e) {
          scanError = e;
          throw e;
        }
      },
    };
  }

  const endpoints: Record<string, unknown> = {};
  const omitted: string[] = [];
  for (const routerPath of plan) {
    const { status, json } = await resolver(routerPath);
    if (status === 200 && json !== null) {
      let payload: unknown = json;
      if (redaction && ACQ_REDACTED_ROUTES.has(routerPath)) {
        payload = redactAcquisitionPayload(routerPath, json, redaction);
        if (scanError !== null) throw bakeRefusal(`the roster scan failed on ${routeTemplate(routerPath)}`);
        // A dropped route is deliberately NOT a required-route failure: in redacted mode
        // confidentiality outranks completeness (the view reads offline on the public mirror).
        if (payload === null) {
          omitted.push(routerPath);
          continue;
        }
      } else if (scan) {
        let hit: { dealLabel: string } | null;
        try {
          hit = scan(payload);
        } catch {
          throw bakeRefusal(`the roster scan failed on ${routeTemplate(routerPath)}`);
        }
        if (hit) {
          // Route TEMPLATE only (refute round 7, H3): never the raw path (a parameterised route
          // embeds an id that can itself be a roster term), the term or the deal label.
          console.warn(`[bake-warehouse] redacted bake: a ${routeTemplate(routerPath)} endpoint matches an active confidential deal — endpoint omitted.`);
          omitted.push(routerPath);
          continue;
        }
      }
      endpoints[`/api/warehouse${routerPath}`] = payload;
    } else if (required.has(routerPath)) {
      // A parameterized slice may legitimately 404 (skip it); a REQUIRED route must not — fail loud.
      throw new Error(`warehouse bake failed: required endpoint ${routerPath} returned ${status}`);
    }
  }

  return {
    envelope: {
      schemaVersion: WAREHOUSE_MIRROR_SCHEMA_VERSION,
      bakedAt: new Date(opts.now).toISOString(),
      warehouseSource: opts.warehouseSource,
      endpoints,
    },
    omitted,
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

export interface BakeResult { path: string; warehouseSource: WarehouseSource; count: number; omitted: string[] }

/**
 * Orchestrate the bake: prefer a running Brain Server; else checkpoint + read the local DB. Writes
 * public/warehouse.json. The ONLY DB mutation is a WAL checkpoint (no DDL, no data write).
 *
 * `includeConfidential` (fix round 1, item 1) mirrors bake-mirror.ts's own
 * `MIRROR_INCLUDE_CONFIDENTIAL` flag (that script is this function's one caller, and now threads its
 * own `includeConfidential` local through here) — `public/warehouse.json` lands in the SAME `public/`
 * directory as `snapshot.json`, so it must respect the SAME redacted-vs-confidential boundary or a
 * "redacted" deploy would still ship full row-level CoStar data. Defaults to `false` (safe/redacted)
 * when omitted, matching this module's own "a public deploy must always run in the default
 * (redacted) mode" policy.
 */
export interface LeaseMarketBakeMode {
  /** Passed as inProcessResolver's `opts.leaseMarketRowLevel` — overrides `config.mirrorRowLevel`
   *  on that ONE bake-time router instance. `undefined` ⇒ no override, falls through to config
   *  (private/ratified mode); `false` ⇒ forced redaction regardless of config (redacted mode). Kept
   *  as DEFENCE IN DEPTH alongside `includeLeaseMarket` below: even if a future change re-plans the
   *  `/lease-market/*` routes on the in-process path in redacted mode, row-level fields still
   *  redact rather than leaking raw CoStar data. */
  leaseMarketRowLevel: boolean | undefined;
  /** Passed as BuildOpts.includeLeaseMarket and applied UNIFORMLY to BOTH resolver paths (fix round
   *  3, whole-branch review Finding 1 — confidentiality asymmetry, 2026-09-17): `false` excludes
   *  every `/lease-market/*` route from the plan entirely in redacted mode, on the
   *  checkpoint-read/in-process path AND the httpResolver/live-server path alike; `true` includes
   *  them on both. Previously this field only reached the http path — the in-process/checkpoint-read
   *  path (the unattended, server-down bake) always planned the routes regardless of this value,
   *  which is the asymmetry this fix closes. */
  includeLeaseMarket: boolean;
}

/**
 * Fix round 2, item 1(a): pure `includeConfidential` → lease-market bake-mode mapping, extracted out
 * of `bakeWarehouseJson` so the redacted-vs-private decision can be unit-tested directly (no
 * warehouse DB, no HTTP server, no filesystem write). This is the ONE place that decides both bake
 * paths' lease-market behavior — `bakeWarehouseJson` just wires the two fields to the resolver it
 * picked. See `LeaseMarketBakeMode` field docs for exactly what each value does on each path.
 */
export function leaseMarketBakeMode(includeConfidential: boolean): LeaseMarketBakeMode {
  return {
    leaseMarketRowLevel: includeConfidential ? undefined : false,
    includeLeaseMarket: includeConfidential,
  };
}

export async function bakeWarehouseJson(opts: { now?: number; includeConfidential?: boolean } = {}): Promise<BakeResult> {
  const now = opts.now ?? Date.now();
  const includeConfidential = opts.includeConfidential ?? false;
  const baseUrl = process.env.BRAIN_BAKE_SOURCE_URL ?? `http://127.0.0.1:${serverPort()}`;
  // FIX round 3 (whole-branch review, Finding 1 — confidentiality asymmetry, 2026-09-17):
  // `includeLeaseMarket` now derives directly from `includeConfidential` via `leaseMarketBakeMode`
  // and is applied to BOTH resolver paths below, unconditionally. Previously it was initialised
  // `true` and only reassigned inside the `brainServerUp()` branch, so the checkpoint-read path
  // (brain server down — the unattended scheduled-bake case) always kept the `true` initializer
  // regardless of `includeConfidential`: a redacted bake still PLANNED every `/lease-market/*` route
  // on that path and baked all five endpoints — merely row-level-redacted via `leaseMarketRowLevel`,
  // not omitted — into public/warehouse.json, a non-Access-gated artifact. Both paths must omit the
  // routes entirely in redacted mode; `leaseMarketRowLevel` stays wired to the in-process resolver
  // as defence in depth for any future regression that re-plans the routes there.
  const { leaseMarketRowLevel, includeLeaseMarket } = leaseMarketBakeMode(includeConfidential);

  let resolver: RouteResolver;
  let warehouseSource: WarehouseSource;
  let db: WarehouseDb | null = null;

  if (await brainServerUp(baseUrl)) {
    resolver = httpResolver(baseUrl);
    warehouseSource = 'live-server';
  } else {
    const dbPath = process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
    // Deliberately NOT openWarehouse(): that runs pending migrations, and this path is unattended
    // (the hourly mirror deploy). Run from a feature branch it would apply that branch's unmerged
    // migration to the LIVE warehouse — and because runMigrations keys off the file name with no
    // checksum, the live DB would then record it as applied and never receive later edits to it.
    // The bake only reads, so it opens the file directly. It still needs a read-WRITE handle
    // because wal_checkpoint(TRUNCATE) cannot run on a read-only connection.
    //
    // M4: `new Database(dbPath)` with no options silently CREATES an empty file when dbPath doesn't
    // exist. The bake would then fail downstream (buildWarehouseEnvelope's required-route checks),
    // but that empty file stays on disk — and the next time ANYTHING opens it through openWarehouse()
    // (a normal server start, a normal bake retry), runMigrations sees a valid-but-empty SQLite file
    // and migrates it into a valid, EMPTY warehouse. Every later bake against that path then silently
    // "succeeds" with a real (empty) mirror and no error at all — the 0-byte-file failure mode
    // disappears into a permanently-empty one instead of ever surfacing. `fileMustExist: true` (as
    // scripts/bake-mirror.ts already does for its own governor read) makes better-sqlite3 throw
    // immediately instead of creating anything, and the catch below turns that into one clear,
    // actionable bake failure.
    try {
      db = new Database(dbPath, { fileMustExist: true });
    } catch (err) {
      throw new Error(
        `warehouse bake failed: no database at ${dbPath} — refusing to create an empty warehouse ` +
          `(${err instanceof Error ? err.message : String(err)})`,
      );
    }
    db.pragma(`busy_timeout = ${Number(process.env.WAREHOUSE_BUSY_TIMEOUT_MS) || 15_000}`);
    db.pragma('wal_checkpoint(TRUNCATE)'); // flush WAL → committed DB so the read can't lag the server
    // Full control on this path: bake the routes either way, but force rowLevel false when redacted.
    resolver = inProcessResolver(db, { leaseMarketRowLevel });
    warehouseSource = 'checkpoint-read';
  }

  try {
    const { envelope: env, omitted } = await buildWarehouseBake(resolver, { now, warehouseSource, includeLeaseMarket, includeConfidential });
    const pub = join(process.cwd(), 'public');
    mkdirSync(pub, { recursive: true });
    const outPath = join(pub, 'warehouse.json');
    writeFileSync(outPath, JSON.stringify(env));
    return { path: outPath, warehouseSource, count: Object.keys(env.endpoints).length, omitted };
  } finally {
    db?.close();
  }
}
