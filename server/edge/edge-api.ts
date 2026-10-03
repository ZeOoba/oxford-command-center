// server/edge/edge-api.ts
//
// Oxford Edge Hono sub-router (spec §5.2), mounted at /api/warehouse/edge via
// server/warehouse/sub-routers.ts. Routes:
//   GET  /markets               — loader result; NO withDb guard (works when the warehouse is down)
//   GET  /pull-queue            — queue state per item × scope; 503 through the standard guard
//   POST /pull-queue            — RecordPullRequest → append one log row → updated item
//   POST /pull-queue/:id/void   — set voided_at on one row (undo); no delete
// Mutations require X-ORA-Client, enforced upstream by server/host-guard.ts on every non-safe
// /api method. The routes accept and return NO deal data (spec §5.4, F9); deal→market resolution
// is client-side. Not added to scripts/bake-warehouse.ts FIXED_ROUTES: the data is CoStar-licensed.
import { Hono } from 'hono';
import type { WarehouseDb } from '../warehouse/db';
import { EdgeMarketsResponse, EdgePullItem, EdgePullQueueResponse, RecordPullRequest } from '../../src/contracts/edge';
import { edgeDir } from './config';
import { loadEdgeDataset, NODE_EDGE_FS, type EdgeFsDeps } from './loader';
import {
  buildEdgePullItem, buildEdgePullQueue, computeOutsidePullScope, localIsoDate, PullValidationError, pullScopeKeys,
  readEdgePullLatest, readEdgePullLoggedKeys, recordEdgePull, voidEdgePull,
} from './pull-queue';

/** better-sqlite3 surfaces CHECK failures as SqliteError with code SQLITE_CONSTRAINT_CHECK. */
function isSqliteCheckViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: unknown }).code === 'SQLITE_CONSTRAINT_CHECK';
}

/** Write-lock contention: SQLITE_BUSY and its extended codes (SQLITE_BUSY_SNAPSHOT, _RECOVERY, _TIMEOUT). */
function isSqliteBusy(e: unknown): boolean {
  const code = typeof e === 'object' && e !== null ? (e as { code?: unknown }).code : undefined;
  return typeof code === 'string' && /^SQLITE_BUSY(_[A-Z]+)?$/.test(code);
}

const BUSY_MESSAGE = 'pull log is busy; retry';

export interface EdgeApiDeps {
  edgeDir?: () => string;
  now?: () => Date;
  fs?: EdgeFsDeps;
}

/**
 * Creates the Edge Hono sub-router.
 *
 * @param getDb - Lazy singleton getter; throws when the warehouse is unavailable.
 */
export function edgeApi(getDb: () => WarehouseDb, deps: EdgeApiDeps = {}): Hono {
  const app = new Hono();
  const dirOf = deps.edgeDir ?? edgeDir;
  const now = deps.now ?? (() => new Date());
  const fs = deps.fs ?? NODE_EDGE_FS;
  const load = () => loadEdgeDataset(dirOf(), now(), fs);

  /** Resolve the warehouse per-request behind a 503 guard (mirrors insights-api.ts / debt-api.ts). */
  const withDb = (handler: (db: WarehouseDb) => Response | Promise<Response>): Promise<Response> => {
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
    return Promise.resolve(handler(db));
  };

  app.get('/markets', async (c) => {
    const result = await load();
    return c.json(EdgeMarketsResponse.parse({ ...result, outsidePullScope: computeOutsidePullScope(result.markets) }));
  });

  app.get('/pull-queue', (c) =>
    withDb(async (db) => {
      const { markets } = await load();
      return c.json(EdgePullQueueResponse.parse(buildEdgePullQueue(db, markets, localIsoDate(now()))));
    }),
  );

  app.post('/pull-queue', (c) =>
    withDb(async (db) => {
      if ((c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/json') {
        return c.json({ error: 'content-type must be application/json' }, 400);
      }
      const parsed = RecordPullRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.json({ error: 'invalid pull record', issues: parsed.error.issues }, 400);
      const input = parsed.data;
      const { markets } = await load();
      // Same scope set as GET /pull-queue (loaded buy-box ∪ frozen ∪ logged; truck minus automated).
      if (!pullScopeKeys(input.kind, markets, readEdgePullLoggedKeys(db, input.kind)).includes(input.scopeKey)) {
        return c.json({ error: `unknown scope '${input.scopeKey}' for ${input.kind}` }, 400);
      }
      // `today` is server-derived (injected clock), never request-derived.
      const today = localIsoDate(now());
      try {
        recordEdgePull(db, input, today);
      } catch (e) {
        // Contention is transient, not a server fault: fixed text only (no SQL, path or driver message).
        if (isSqliteBusy(e)) return c.json({ error: BUSY_MESSAGE }, 503);
        // Only the store's date validation maps to 400; any other fault propagates → 500.
        if (e instanceof PullValidationError) return c.json({ error: e.message }, 400);
        // Defense in depth: a pull-log CHECK violation is a rejected input, not a server fault.
        if (isSqliteCheckViolation(e)) return c.json({ error: 'pull record violates a storage constraint' }, 400);
        throw e;
      }
      const logged = readEdgePullLoggedKeys(db, input.kind);
      return c.json(EdgePullItem.parse(buildEdgePullItem(input.kind, markets, readEdgePullLatest(db), today, logged)), 200);
    }),
  );

  app.post('/pull-queue/:id/void', (c) =>
    withDb(async (db) => {
      const rawId = c.req.param('id');
      const id = /^\d+$/.test(rawId) ? Number(rawId) : NaN;
      if (!Number.isSafeInteger(id) || id <= 0) return c.json({ error: 'id must be a positive integer' }, 400);
      // Load BEFORE the void commit so a dataset-read fault can never turn a committed void into a 500.
      const { markets } = await load();
      let result: ReturnType<typeof voidEdgePull>;
      try {
        // Only rows whose (kind, scope) is still queueable are voidable; log-history scopes are in scope via `logged`.
        result = voidEdgePull(db, id, (kind, scopeKey) =>
          pullScopeKeys(kind, markets, readEdgePullLoggedKeys(db, kind)).includes(scopeKey));
      } catch (e) {
        // Contention is transient, not a server fault: fixed text only (no SQL, path or driver message).
        if (isSqliteBusy(e)) return c.json({ error: BUSY_MESSAGE }, 503);
        throw e;
      }
      if (result.status === 'not_found') return c.json({ error: `pull log row ${id} not found` }, 404);
      if (result.status === 'already_voided') return c.json({ error: `pull log row ${id} is already voided` }, 409);
      if (result.status === 'out_of_scope') {
        return c.json({ error: 'that scope is no longer in the pull queue; its history is kept' }, 409);
      }
      if (result.status === 'superseded') {
        return c.json({ error: 'that pull was superseded by a newer record; refresh and retry' }, 409);
      }
      return c.json(
        EdgePullItem.parse(
          buildEdgePullItem(result.kind, markets, readEdgePullLatest(db), localIsoDate(now()), readEdgePullLoggedKeys(db, result.kind)),
        ),
        200,
      );
    }),
  );

  return app;
}
