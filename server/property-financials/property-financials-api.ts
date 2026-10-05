// server/property-financials/property-financials-api.ts
//
// Property Financials Hono sub-router (plan T4), mounted at /api/warehouse/property-financials via
// server/warehouse/sub-routers.ts. Routes:
//   GET /dataset                — validated dataset + data-health meta (loader.ts); no DB needed
//   GET /mapping                — entity → canonical property id table (mapping.ts)
//   GET /insight-status         — stored per-insight workflow records (status-store.ts)
//   PUT /insight-status/:id     — validate + persist one insight's owner / due / status
//
// The warehouse DB is never used: the factory accepts getDb only to match WarehouseSubRouter.
// Mutations require X-ORA-Client, enforced UPSTREAM by server/host-guard.ts (requestBoundary on
// /api/*, mounted in server/index.ts before every sub-router) — not re-checked here; proven in
// tests/unit/property-financials-api.test.ts by mounting the real middleware.
// Errors: fixed strings / Zod path+code only; anything unexpected propagates to the shared
// warehouseJsonError handler (generic 500) applied by sub-routers.ts withJsonErrors.
//
// NOT baked/mirrored: never add these routes to scripts/bake-warehouse.ts FIXED_ROUTES — the payload
// is firm financials (same stance as /edge). The bake's in-process resolver only serves the paths in
// its plan, so being listed in WAREHOUSE_SUB_ROUTERS alone exposes nothing to the mirror.
//
// Named property-financials-api.ts (not api.ts): scripts/check-write-schema-drift.ts keys its mount
// map by file BASENAME, and `api` is already server/warehouse/api.ts (/api/warehouse).
import { Hono } from 'hono';
import { PF_ENTITY_IDS } from '../../src/contracts/property-financials';
import type { WarehouseDb } from '../warehouse/db';
import { propertyFinancialsDir, propertyFinancialsStatusPath } from './config';
import { loadPropertyFinancials, NODE_PF_FS, type PfFsDeps } from './loader';
import { buildEntityMapping } from './mapping';
import { putInsightStatus, readInsightStatuses, StatusStoreCorruptError } from './status-store';

export interface PropertyFinancialsApiDeps {
  dir?: () => string;
  statusPath?: () => string;
  now?: () => Date;
  fs?: PfFsDeps;
}

const CORRUPT = { error: 'insight status store is unreadable or invalid' } as const;

export function propertyFinancialsApi(_getDb: () => WarehouseDb, deps: PropertyFinancialsApiDeps = {}): Hono {
  const app = new Hono();
  const dirOf = deps.dir ?? propertyFinancialsDir;
  const statusPathOf = deps.statusPath ?? propertyFinancialsStatusPath;
  const now = deps.now ?? (() => new Date());
  const fs = deps.fs ?? NODE_PF_FS;
  const load = () => loadPropertyFinancials(dirOf(), now(), fs);

  app.get('/dataset', async (c) => {
    const r = await load();
    return c.json({
      availability: r.availability,
      readError: r.readError,
      lastGoodLoadedAt: r.lastGoodLoadedAt,
      issues: r.issues,
      meta: r.meta,
      dataset: r.dataset,
    });
  });

  app.get('/mapping', async (c) => {
    const r = await load();
    return c.json({ availability: r.availability, rows: buildEntityMapping(PF_ENTITY_IDS, r.dataset?.sf ?? {}) });
  });

  app.get('/insight-status', async (c) => {
    const r = await load();
    let stored;
    try {
      stored = readInsightStatuses(statusPathOf());
    } catch (e) {
      if (e instanceof StatusStoreCorruptError) return c.json(CORRUPT, 500);
      throw e;
    }
    const known = r.dataset ? new Set(r.dataset.insights.map((i) => i.id)) : null;
    const ids = Object.keys(stored).sort();
    return c.json({
      records: ids.filter((id) => !known || known.has(id)).map((id) => stored[id]!),
      orphanedIds: known ? ids.filter((id) => !known.has(id)) : [],
    });
  });

  app.put('/insight-status/:id', async (c) => {
    if ((c.req.header('content-type') ?? '').split(';')[0]!.trim().toLowerCase() !== 'application/json') {
      return c.json({ error: 'content-type must be application/json' }, 400);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: 'body is not valid JSON' }, 400);
    }
    const r = await load();
    if (!r.dataset) return c.json({ error: 'property financials dataset unavailable' }, 503);
    let result;
    try {
      result = putInsightStatus(statusPathOf(), c.req.param('id'), body, new Set(r.dataset.insights.map((i) => i.id)), now());
    } catch (e) {
      if (e instanceof StatusStoreCorruptError) return c.json(CORRUPT, 500);
      throw e;
    }
    if (result.ok) return c.json(result.record, 200);
    if (result.reason === 'not_found') return c.json({ error: 'unknown insight id' }, 404);
    return c.json({ error: 'invalid insight status', issues: result.issues }, 400);
  });

  return app;
}
