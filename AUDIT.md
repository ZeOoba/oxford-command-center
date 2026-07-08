# AUDIT.md — Oxford Command Center, Phase 0 (Verify & Audit)

**Date:** 2026-06-03 · **Scope:** read-only verification, no code changes. Every claim below was
reproduced against the actual code at `C:\Users\Owner\oxford-command-center` (commit `3007b13`),
and every claim about the deployed mirror was checked with **unauthenticated `curl`**, not a
logged-in browser.

---

## 1. Architecture map

### 1.1 Stack & versions (from `package.json`, verified installed)
| Layer | Tech |
|---|---|
| UI | React **19.0**, React-DOM 19, framer-motion 11.15, react-aria-components 1.5, lucide-react, cmdk, @dnd-kit |
| Data/client | @tanstack/react-query **5.62**, @tanstack/react-virtual 3.11, Zod **3.24** (contract boundary) |
| Charts | @visx/* **3.12** (axis/scale/shape/group/gradient/curve/tooltip) |
| Build | Vite **6.0**, TypeScript **5.7**, Tailwind **4.0** (`@tailwindcss/vite`), vite-plugin-pwa |
| Server ("Brain Server") | Hono **4.6** + `@hono/node-server`, ExcelJS 4.4, chokidar 4 (file watch), SSE |
| AI | `@anthropic-ai/sdk` **^0.32.1** (server-side only) |
| Tests/CI tooling | vitest 2.1, Playwright 1.49 + axe-core, ESLint 9 (flat config, `--max-warnings 0`), Prettier |

### 1.2 Build / scripts (`package.json`)
- `dev` → concurrently runs `tsx watch server/index.ts` + `vite`.
- `build` → `tsc --noEmit` then `vite build`.
- Mirror: `bake` (`scripts/bake-mirror.ts` → `public/snapshot.json` + `public/macro.json`) →
  `build:mirror` (bake + build) → `deploy:mirror` (`wrangler pages deploy dist … --branch=main`).
- **Quality gate:** `gate` = `typecheck` + `lint` + `test` + `reconcile`. Matches §2 of the brief. ✅
- `reconcile` (`scripts/reconcile.ts`) re-reads the workbook independently and asserts derived totals
  to **$0 tolerance** (rent/NOI/value/cash) plus count integrity and entity-graph integrity.

### 1.3 Layered structure
```
server/                         Local-first Brain Server (Node/Hono, 127.0.0.1:8911, localhost-only CORS)
  config.ts                     workbookPath() (canonical, call-time), SERVER_PORT 8911, WORKBOOK_AS_OF '2026-06-01'
  brain.ts                      ExcelJS read + chokidar watch → in-memory snapshot + EventEmitter
  workbook/parse.ts             Workbook → typed PortfolioSnapshot (the parser; sheet-by-sheet)
  workbook/counterparties.ts    Relationship graph (derived firms + people seed merge)
  macro/{fred,getMacro}.ts      FRED macro (live when FRED_API_KEY, seeded otherwise)
  ai/{respond,claude}.ts        respond.ts = deterministic keyword responder; claude.ts = live Claude
  index.ts                      Routes: /api/health,/api/snapshot,/api/refresh,/api/macro,/api/ai,/sse
src/
  contracts/*.ts                Zod domain schemas; PortfolioSnapshot is THE boundary (parsed twice)
  analytics/{engine,format}.ts  Single metric source of truth (buildAnalytics → AnalyticsBundle)
  data/{client,queries,provider,sse,brain-context}.ts   Fetch + react-query + SSE + freshness state
  brain/{UiProvider,ui-context,EntityDrawer,AiPanel,CommandPalette}.tsx   App-wide UI state + drawer + AI
  shell/{AppShell,Sidebar,TopBar,ScenarioSwitch}.tsx    Layout; module switching via in-memory state
  modules/*/                    One module per view (overview/portfolio/debt/leases/cash/insurance/…)
  primitives/{StatusPill,…}.tsx Presentational atoms
scripts/{bake-mirror,reconcile,extract-workbook}.ts
data/snapshots/portfolio.json   Persisted snapshot artifact (generatedAt 2026-06-03 — current)
public/                         Bake target (snapshot.json/macro.json) consumed by the static mirror
```

### 1.4 Things that do **not** exist (relevant to later phases)
- **No `functions/` directory** → no Cloudflare Pages Function. `/api/ai` has no handler on the mirror.
- **No router dependency** (no react-router / @tanstack/react-router). No URL-driven views.
- **No `wrangler.toml`/`wrangler.json`**, **no `.github/`** (no CI, no scheduled bake), **no `_headers`/`_redirects`**.

---

## 2. Data-flow diagram (text)

```
                      LOCAL (full data)                              MIRROR (static bake, Access-gated)
  Master Workbook .xlsx                                   scripts/bake-mirror.ts  ──redactConfidential()──►
        │ ExcelJS + chokidar watch                              │ (default REDACTS E. Fulton;
        ▼                                                       │  MIRROR_INCLUDE_CONFIDENTIAL=1 includes)
  server/brain.ts  ──parse.ts──►  PortfolioSnapshot       public/snapshot.json + public/macro.json
        │  (in-memory, EventEmitter)                            │  (vite build → dist, wrangler deploy)
        ▼                                                       ▼
  Hono routes  GET /api/snapshot ──┐                     GET /snapshot.json ──┐
               GET /sse (push) ────┤                     (no server; 404 on /api/*) 
                                   ▼                                          ▼
                       src/data/client.ts  fetchSnapshot(): try /api/snapshot → fallback /snapshot.json
                                   │  PortfolioSnapshot.parse()  ◄── Zod boundary (re-validated client-side)
                                   ▼
                       react-query (queries.ts)  ── useSnapshot()
                                   │
                                   ▼
                       analytics/engine.ts  buildAnalytics(snapshot, scenario)  ◄── SINGLE metric source
                                   │  (kpis, debt, insights, marketByNoi/BySf, tenants, rollover, …)
                                   ▼
   UiProvider (activeModuleId / selected / scenario, all in-memory useState)
                                   ▼
   AppShell → active Module → primitives (KpiStat, DataTable, StatusPill, charts)
   EntityDrawer (ui.selected) · AiPanel → adapter.askBrain() → POST /api/ai
```

**SSE / freshness:** `provider.tsx` `BrainBridge` opens `connectBrainSSE` → on `state` events sets
`liveState`; on `snapshot` events invalidates the query. `BrainContext` exposes `state`/`refreshing`/`refresh`.
`StatusPill` reads `state.status` + `state.lastUpdated`.

**How the StatusPill / "as of" / source chips are produced**
- **StatusPill** (`primitives/StatusPill.tsx`): maps `BrainStatus` → label. `BrainStatus` enum is
  **`fresh | refreshing | error | idle`** only — there is no `live/static/stale` concept. `fresh`→"LIVE"
  (green, animated pulse). The pill appends `relativeTime(state.lastUpdated)`.
- **"as of"** (`shell/TopBar` via `AppShell`): `data.snapshot.meta.asOf` (= `WORKBOOK_AS_OF`, `2026-06-01`).
- **Source/provenance chips**: each metric is a `cell(value, source, confidence, {formula})` (see
  `analytics/engine.ts`); `primitives/Provenance.tsx` + `KpiStat` render the `prov`. Confidence is
  `confirmed` for direct workbook figures, `derived` for computed, and downgraded to `derived` under a
  non-Base scenario.

---

## 3. Static vs derived (confirmed)

| Value / behavior | Source | Notes |
|---|---|---|
| Properties / leases / loans / cash / insurance / tasks | **Workbook (live parse)** | `parse.ts`; reconciled to workbook own-totals at $0 tol |
| KPIs, debt summary, insights, market/tenant/rollover series | **Derived** | `analytics/engine.ts` `buildAnalytics()` — single source |
| Macro (Treasuries/SOFR/CPI…) | **Live FRED if `FRED_API_KEY`, else seeded** | `macro/getMacro.ts` |
| `deals` (acquisitions pipeline) | **Static seed** | `src/data/seed-deals.ts` (Notion adapter is Phase 6) |
| People counterparties (counsel/title/principals) | **Static seed** | `src/data/seed-counterparties.ts` ("memory" source) |
| Lender/carrier counterparties | **Derived** | from loans/insurance/deals in `counterparties.ts` |
| `meta.generatedAt` | **Runtime** | `new Date().toISOString()` at parse time |
| **Freshness `status`** | **HARD-CODED `'fresh'`** on static fallback | `data/client.ts:29` — see Defect 5 |
| View / scenario / open-drawer | **In-memory `useState`** (UiProvider) | not persisted, not in URL — see Defect 2 |
| Overview widget layout/order | **localStorage** (`ora-overview-workspaces`) | `useWorkspaces.ts` |

---

## 4. Verified defect table (supersedes §8 of the brief where noted)

Legend: **Confirmed** = reproduced in code/data · **Not reproduced** = claim did not hold · **Needs decision** = real but requires a product/labeling call.

| # | Sev | Area | Verdict | Evidence (file:line) | Finding |
|---|-----|------|---------|----------------------|---------|
| 1 | High | Mirror AI | **Confirmed** | no `functions/` dir; `curl -X POST .../api/ai` → 302 to Access | No Pages Function. On the mirror `/api/ai` only hits Access (302); after login it would 404/405 — no handler. Local server has one (`server/index.ts:38`). |
| 2 | High | Routing | **Confirmed** | `App.tsx` (no router), `AppShell.tsx:29`, `UiProvider.tsx:6,8,10` | No router. `activeModuleId`/`selected`/`scenario` are plain `useState` — not even localStorage. Refresh → resets to overview/Base/closed drawer. No deep links; back/forward do nothing. |
| 3 | High | Portfolio | **Confirmed (own bug)** | `PortfolioModule.tsx:68,71` | Card titled **"Value by Market"** binds `analytics.marketByNoi` (NOI series). Engine *supports* a value metric (`marketAllocation(props,'value')`) but `buildAnalytics` only emits `marketByNoi`/`marketBySf` — no `marketByValue` is wired. Fix = rename, **or** add `marketByValue` to the bundle and bind it. |
| 4 | High | Relationships | **Confirmed (own bug)** | `counterparties.ts:111-118`; `seed-counterparties.ts:27-37` | REDACTED-583 seed: `firm:'REDACTED-672'`, `email:'REDACTED-309'`, `kind:'title'`. When her firm matches the **derived REDACTED-672 lender** firm, line 117 `if (!firm.email) firm.email = person.email` copies the individual's email onto the firm. Drawer then shows the lender "REDACTED-672" carrying a person's email. Fix = separate person vs firm contact identity. |
| 5 | Med | Freshness | **Confirmed** | `data/client.ts:29`; `StatusPill.tsx:7-12,18` | Static-mirror fallback hard-codes `status:'fresh'`; `StatusPill` maps `fresh`→**"LIVE"** + animated pulse. A static bake renders as live. No `live/static/stale` model or bake-age exists. |
| 6 | Med | Debt/Tasks | **Confirmed — values are distinct; precision inconsistent** | `portfolio.json:4517` (`"…BALLOON DUE Feb-27 ($REDACTED-AMT)…"`); `DebtModule.tsx:67` (`fmtUsdCompact(absBalance)`→"$981K"); `EntityDrawer.tsx:275` (`fmtUsd(currentBalance)`→"$REDACTED-AMT") | **$981K and $REDACTED-AMT are the SAME figure** (current balance) at two precisions → standardize. **$REDACTED-AMT is a DISTINCT metric** (balloon-payoff-at-maturity) but lives only inside the loan `notes` string — the `Loan` contract has no `balloonPayment` field. Fix = add typed field, label both precisely, standardize precision. **Do not merge.** |
| 7 | Med | Counts | **Confirmed (labeling)** | `engine.ts:67`; `reconcile.ts:113-117` | `propertyCount = property-row count`. Gate expects **14 properties, 137 leases, 16 cash entities**. "14 assets" includes the Sepich bundle (8 buildings as 1 investment row) and SF is Oxford-share; reconcile excludes a Residence (Persimmon) from the SF subtotal. Numbers are correct — they need an explicit **unit label** and the bundle surfaced. Do **not** "correct" to firm-memory ~27/~600K. |
| 8 | Med | Drawer | **Needs runtime verification** | `EntityDrawer.tsx:99,138-149` | Panel is `w-[440px] max-w-[94vw]`; rows are `flex justify-between` with a right-aligned `.num` `dd` that has no `min-w-0`/wrap. Long values (email/notes) could overflow at narrow widths, but I could not reproduce a hard clip statically. Verify at ~930px in-app (Phase 4) before changing. |
| 9 | Low→**High** | Tasks ingestion / render dup | **Confirmed (real, root cause found)** | `parse.ts:415-437`; `TasksModule.tsx:25,36-41`; `portfolio.json:5094-5100` + 6 more banner rows | **`parseTasks` ingests Monthly-Checklist banner/summary rows as tasks.** A "⚠ BALLOON ALERT: REDACTED-306 — $REDACTED-AMT …" banner has a RowID(col20)+label(col1), so it passes the guard; its text is smeared across `section/role/type/dueDay/notes`. `TasksModule` groups by `section`, so each banner becomes its **own bogus section Card** with the same string repeated as title+label+type+notes. `generatedAt:2026-06-03` confirms this is **current** parser output, not stale. Fix = guard `parseTasks` against banner rows (e.g., reject where `label===section===type`, or where label matches a banner/⚠/ALL-CAPS-summary pattern). This is the true "render duplication / empty fields" item and is higher severity than "Low." |
| 9b | Low | Stale relative dates | **Not reproduced (as a code bug)** | `lib/time.ts:1`; `parse.ts:183,217` | The only `relativeTime` use is `StatusPill` for `lastUpdated` (freshness — correctly wall-clock). Data relatives (`monthsToExpiry`) are already computed against `WORKBOOK_AS_OF` in the parser. "target close early May" is free-text in a deal field, not a computed relative. The as-of principle is already honored; no render bug to fix. |
| 9c | Low | Duplicated alert mapping | **Not reproduced** | `engine.ts:256-281`; `widgets.tsx:104` | Insurance branches share an id but are mutually exclusive (if/else). `InsightList` is rendered once (`slice(0,7)`). No double mapping in components. (The real duplication is #9 ingestion.) |
| — | — | Auth | **NOT a defect** | `curl` apex / `/api/ai` / asset path → **302** to `spring-wood-ade4.cloudflareaccess.com` | Cloudflare Access enforces on all paths, unauthenticated. Site is not publicly exposed. Do not take down. |
| — | — | Backend | **NOT a defect** | `server/index.ts` | Hono Brain Server exists with `/api/snapshot,/refresh,/macro,/ai,/sse`. Do not rebuild; the mirror gap is a Pages Function, not a new backend. |
| — | — | Confidentiality | **Intact** | `bake-mirror.ts:17-35` | `redactConfidential` strips confidential deals (E. Fulton) by default; `MIRROR_INCLUDE_CONFIDENTIAL=1` includes them (for Access-gated targets only). Guard is correct. |

---

## 5. Contracts that later phases must match
- **AI contract (`adapter.askBrain`)** — `POST /api/ai` with `{ question: string }` → `AiAskResponse`
  `{ answer, sources: string[], model: string }` (`src/brain/ai/{adapter,types}.ts`,
  `server/ai/respond.ts` returns `model:'stub'`). The Phase 1 Pages Function must serve this exact shape.
- **Freshness state (`BrainState`/`BrainStatus`)** — Phase 1 must extend the status model
  (`live`/`static`/`stale`) and add bake-age; `client.ts:29` and `StatusPill` are the two edit sites.
- **`PortfolioSnapshot`** (Zod) is the boundary — parsed in `parse.ts` (server) and re-parsed in
  `client.ts` (client). Any new field (e.g., `Loan.balloonPayment` for #6) must be added to the schema.

---

## 6. Recommended execution (unchanged from brief, with Phase 0 adjustments)
1. **Phase 1** (honesty + mirror AI): fix #5 (freshness model) and #1 (`functions/api/ai.ts`); relabel
   InsightList actions to "View details" (`InsightList.tsx:54-57` only calls `openEntity`, ignoring
   `i.action.kind` — overpromising **confirmed**). Add the scheduled-bake GitHub Action (does not exist).
2. **Quick §7 wins**: #3 (value-by-market) and #4 (entity email) — small, high-trust, each with a test.
3. **Promote #9 to Phase 1/early Phase 4** — it is a live data-integrity bug, not "Low": users see
   garbage Task cards today. Fix at the parser + add a regression test.
4. Phase 2 routing → Phase 3 agent → Phase 5 actions → Phase 6 spine/docs/hardening + CI gate + bundle budget.

**No code was changed in Phase 0.**
