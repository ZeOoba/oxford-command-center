# System Overview — Oxford Command Center

**Status:** Architecture lock file — no implementation agent may silently diverge from this document. If implementation conflicts with this file, update this file first (Lead Architect approval required), then implement.

**Last verified:** 2026-06-13 · Branch: `feat/pfi-phase-1-foundation` (e44dd22)

---

## 1. Purpose

The Oxford Command Center is a **local-first investment intelligence platform** for Oxford Realty Advisors (~600K SF, ~140 tenants, ~27 properties, OH/MD/IN/WI/MO/KS/TN). It is not a general-purpose dashboard. Every feature must answer the question: *did this help ORA make a better capital allocation decision?*

---

## 2. Two-Spine Architecture

The system has two parallel data spines. This is the central architectural fact. Agents must understand which spine they are working on.

```
SPINE A — "Current State" (live, workbook-driven)
─────────────────────────────────────────────────
Master Workbook .xlsx (OneDrive/SharePoint)
  → server/workbook/parse.ts          ExcelJS reader
  → Zod PortfolioSnapshot.parse()     Typed boundary (validation gate)
  → applyOverlay(data/overlay.json)   User mutations (gitignored, write surface)
  → loadQuickbooks(QUICKBOOKS_CSV)    QB sidecar (SharePoint CSV export)
  → reconcile (scripts/reconcile.ts)  $0-tolerance self-totals check
  → /api/snapshot + /sse              Push to client
  → src/analytics/engine.ts           buildAnalytics() → AnalyticsBundle
  → 20 client modules                 UI rendering

Supplemental live sources (appended to Spine A):
  Notion deals → /api/ai (tool: list_pipeline)
  M365 tasks   → /api/ai (tool: list_tasks)
  FRED macro   → server/macro/getMacro.ts (FRED_API_KEY required; seeded fallback)
  Doc RAG      → server/sources/documents.ts (better-sqlite3 vector index)

SPINE B — "Time Dimension" (historical, warehouse-driven)
─────────────────────────────────────────────────────────
Property Financials folder (32 P&L .xlsx/.xlsm files, OneDrive)
  → server/warehouse/detect.ts        Filename grammar + alias matching
  → server/warehouse/parse/qb-excel.ts Multi-format P&L parser (QB/Yardi/AppFolio)
  → RawStatementSchema.parse()        Validated boundary
  → server/warehouse/raw-store.ts     SHA-256 immutable raw copy
  → server/warehouse/mapping.ts       Account → classification (manual>seed>learned)
  → server/warehouse/ingest.ts        Transactional commit pipeline
  → better-sqlite3 (WAL)             5-table SQLite warehouse (see database-schema.md)
  → server/warehouse/metrics.ts       Pure in-memory computation layer
  → server/warehouse/growth.ts        NOI trend / CAGR / since-acquisition
  → server/warehouse/drivers.ts       ΔNOI decomposition
  → server/warehouse/anomalies.ts     Statistical anomaly detection
  → server/warehouse/benchmarks.ts    Cross-property percentile ranking
  → server/warehouse/scores.ts        Health (0-100) / attention / capital scores
  → /api/warehouse/*                  Served to Intel module
  → src/modules/intel/               Intelligence UI
```

**Critical defect (structural — must not regress):** `Property.noi` (Spine A, workbook formula cell) and `warehouse ledger NOI` (Spine B, `Σ revenue+recovery−opex`) are independent computations with no reconciliation check. Two numbers both called "NOI" can silently disagree. No new scoring or capital-allocation engine may consume both without explicit tie-out. See Phase 1a (basis discipline, commit 631963e).

---

## 3. Server Architecture

```
server/index.ts         Hono 4 app, 127.0.0.1:8911, localhost-only CORS
  server/brain.ts       ExcelJS + chokidar file watcher → in-memory snapshot + EventEmitter
  server/workbook/      Workbook parsers + counterparty graph
  server/macro/         FRED API + seeded fallback macro data
  server/ai/            Streaming Claude agent (11 tools) + keyword responder
  server/alerts/        Alert inbox state + condition evaluator (conditions.ts)
  server/sources/       Document RAG (index-docs, vector search)
  server/warehouse/     SQLite financial warehouse (Spine B)
    db.ts               open + migrate (WAREHOUSE_DB env var)
    migrate.ts          Migration runner — numbered SQL files applied in order
    migrations/         001_initial.sql, 002_*.sql, ...
    ingest.ts           Full pipeline: detect→parse→map→foot→commit
    api.ts              /api/warehouse Hono sub-router (injected db getter)
    queries.ts          Read queries (no side effects)
    actions.ts          Mutations (approve/reject import, add mapping, resolve issue)
```

**Server invariants:**
- Warehouse is opened lazily on first `/api/warehouse/*` request (not at boot — cold/mirror envs lack the SQLite file).
- Warehouse path: `process.env.WAREHOUSE_DB ?? 'data/warehouse/finance.sqlite'`.
- All `/api/*` routes enforce localhost-only CORS — never expose to external origin.
- `npm run dev` holds a read-write warehouse connection and writes occupancy on each refresh. `openWarehouse` sets a 15s `busy_timeout` (tunable via `WAREHOUSE_BUSY_TIMEOUT_MS`), so a concurrent `warehouse:backfill` now WAITS out an overlapping write instead of dying on `SQLITE_BUSY` — a live dev server and a backfill coexist. (`gate` was never blocked regardless: `reconcile` reads only the workbook, `warehouse:verify` builds in a temp dir, and `warehouse:drift` opens the live DB read-only.)

---

## 4. Client Architecture

```
src/
  contracts/          Zod domain schemas — the ONLY typed boundary between server + client
  analytics/          buildAnalytics() — single metric source of truth
  data/               TanStack Query hooks + SSE listener + brain context
  brain/              App-wide UI state (drawer, AI panel, command palette)
  shell/              AppShell, Sidebar, TopBar, ScenarioSwitch
  modules/            20 modules (one per view — see §5)
  primitives/         StatusPill + other presentation atoms
  charts/             visx chart components (Waterfall, etc.)
```

**Client invariants:**
- No URL-driven views (no react-router path routing — module switching via in-memory state).
- All data flows through `buildAnalytics()` → typed `AnalyticsBundle` — never reach into raw snapshot.
- `data/overlay.json` is the ONLY write surface — gitignored, user mutations only.

---

## 5. Module Map (20 modules)

Rail modules are registered as entries in the `MODULES` array in `src/shell/modules.tsx`. Each
entry owns a unique `id` string (`ModuleDef.id`) that the shell uses to track the active module
in memory — there is no URL routing. The **ID** column is the `ModuleDef.id` field, which differs
from the display label in a few cases (e.g. **Acquisitions** has `id: 'pipeline'`, **Monthly Close**
has `id: 'close'`, **System Health** has `id: 'health'`). Overlay components (AI Panel, Command
Palette, Entity Drawer) live in `src/brain/` and are not rail modules.

| Module | ID | Path | Spine | Status |
|--------|----|------|-------|--------|
| Overview | `overview` | `src/modules/overview/` | A | Shipped |
| Principal Home | `principal` | `src/modules/principal/` | A | Shipped |
| Acquisitions | `pipeline` | `src/modules/acquisitions/` | A | Seeded kanban only |
| Tasks | `tasks` | `src/modules/tasks/` | A | Shipped |
| Alerts | `alerts` | `src/modules/alerts/` | A | Shipped |
| Calendar | `calendar` | `src/modules/calendar/` | A | Shipped |
| Renewals | `renewals` | `src/modules/renewals/` | A | Shipped |
| Portfolio | `portfolio` | `src/modules/portfolio/` | A | Shipped |
| Property Financials | `intel` | `src/modules/intel/` | B | Phase B2 (PR #14) |
| Calibration | `calibration` | `src/modules/calibration/` | B | Shipped |
| Leases | `leases` | `src/modules/leases/` | A | Shipped |
| Tenants | `tenants` | `src/modules/tenants/` | A | Shipped |
| Debt | `debt` | `src/modules/debt/` | A | Shipped |
| Cash | `cash` | `src/modules/cash/` | A | Shipped |
| Monthly Close | `close` | `src/modules/close/` | A | Shipped |
| Insurance | `insurance` | `src/modules/insurance/` | A | Shipped |
| Market | `market` | `src/modules/market/` | A | Shipped |
| Relationships | `relationships` | `src/modules/relationships/` | A | Shipped |
| Documents | `documents` | `src/modules/documents/` | A | Shipped |
| System Health | `health` | `src/modules/health/` | A | Shipped |

---

## 6. Static Mirror

The Cloudflare Pages static mirror (`deploy:mirror`) is a read-only snapshot. It has no Brain Server, no AI, no warehouse. The mirror bakes `public/snapshot.json` + `public/macro.json` and serves them via Cloudflare Pages Functions (`functions/`). Confidential deal data is redacted by default (`data/overlay.json` stays local).

---

## 7. Current Build State

| Layer | State |
|-------|-------|
| Gate | `npm run gate` = typecheck + lint + test + reconcile + warehouse:verify + **governance** |
| Tests | 450+ vitest unit tests |
| Warehouse | 5-table SQLite, 32 P&L files ingested, 339 GL accounts mapped |
| Intelligence | Phase B2 merged (PR #14 stacked on #13, pending merge) |
| Phase 1a | Basis discipline + NOI integrity gate (commit 631963e, pending PR to main) |

---

## 8. Roadmap Phases

| Phase | Name | Status |
|-------|------|--------|
| 1a | Foundation integrity (basis discipline, NOI integrity gate) | Shipped on branch |
| 1b | FRED macro agent tool | Shipped on branch |
| 2 | Debt/Refi scoring + AI narrative briefings | Not started |
| 3 | Forecast + Leasing intelligence | Not started |
| 4 | Acquisition Intelligence Engine | Not started (firm priority #1) |
| 5 | Capital Allocation capstone + Market intelligence | Not started |

See `docs/superpowers/specs/2026-06-13-ora-intelligence-platform-master-plan.md` for full detail.
