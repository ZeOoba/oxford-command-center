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

const ActionInput = z.object({ action: z.enum(['approve', 'reject']) });

const AddMappingInputSchema = z.object({
  account: z.string().min(1),
  normalizedCategory: z.string().min(1),
  classification: Classification,
  propertyId: z.string().min(1).optional(),
});

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

  return app;
}
