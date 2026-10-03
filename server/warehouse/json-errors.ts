// server/warehouse/json-errors.ts
//
// Shared uncaught-error handler for every warehouse route. An uncaught handler error must
// reach the client as JSON: fetchJson() (src/modules/intel/hooks.ts) treats a non-JSON error
// body as "warehouse routes not present" and the UI then shows a false "Warehouse offline"
// (2026-09-23 review — the acq enum 500 read as offline).
//
// Extracted to one place because warehouseRoutes() and every WAREHOUSE_SUB_ROUTERS entry
// (server/warehouse/sub-routers.ts) each need their own `.onError(...)` call — they are
// mounted as SIBLING Hono() instances directly on server/index.ts's top-level app
// (`app.route('/api/warehouse', warehouseRoutes(...))` then, separately,
// `app.route('/api/warehouse' + prefix, factory(...))` per sub-router), not nested inside
// warehouseRoutes()'s own app via its `.route()`. An `onError` set on one Hono instance does
// not apply to a sibling instance, so DRY here means "one shared handler function", not "one
// `.onError()` call site" — see sub-routers.ts's `withJsonErrors`, which applies this to every
// sub-router factory.
import type { ErrorHandler } from 'hono';

// The 500 body is deliberately generic: a raw err.message can carry SQLite constraint/table
// names or filesystem paths (2026-10 security review of PR #427). The full error is logged
// server-side only. The log line carries method + path (never the query string); the path is
// JSON-quoted because Hono decodes it, so a crafted %0A would otherwise forge log lines. The
// logged `err` itself may still embed input values (e.g. Zod issue text) — it never leaves
// the process.
export const warehouseJsonError: ErrorHandler = (err, c) => {
  console.error(`[warehouse] route error: ${c.req.method} ${JSON.stringify(c.req.path)}`, err);
  return c.json({ error: 'internal error' }, 500);
};
