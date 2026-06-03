# Oxford Command Center — "The Brain"

The internal, local-first command dashboard for Oxford Real Assets — a single screen over the
acquisitions pipeline, owned portfolio, debt, cash, leases, tenants, insurance, tasks, and macro.
It reads the firm's **master workbook live**, reconciles every derived number to the source, and
links every entity (deal ↔ property ↔ tenant ↔ loan ↔ person ↔ insurance ↔ cash) into one
traversable web.

> Internal only. Never deployed to oxfordra.net. The confidential E. Fulton portfolio appears
> internally but only on the private, Access-gated mirror — never on any public surface.

---

## Quick start

```bash
npm install
npm run dev          # starts the Brain Server (:8911) + the web app (:5273) together
# open http://localhost:5273
```

`npm run dev` runs both halves concurrently:

- **Brain Server** (`server/`) — reads the workbook, watches it for changes, serves the typed API.
- **Web app** (`src/`) — the React client; Vite proxies `/api` and `/sse` to the Brain Server.

The workbook path defaults to
`~/OneDrive - Oxford Capital Partners (1)/eric spreadsheets/Master Excel Template Company Wide -- Oxford.xlsx`
— override with the `WORKBOOK_PATH` env var.

### Scripts

| Script | What it does |
|---|---|
| `npm run dev` | Brain Server + web app (hot reload on both) |
| `npm run gate` | The CI gate: `typecheck` → `lint` → `test` → `reconcile` |
| `npm run extract` | Parse the workbook → `data/snapshots/portfolio.json` + a reconciliation summary |
| `npm run reconcile` | Re-read the workbook's own totals and assert derived aggregates match (to the dollar) |
| `npm run test` | Vitest (contracts + analytics) |
| `npm run build` | Typecheck + production build to `dist/` |
| `npm run build:mirror` | Bake `public/{snapshot,macro}.json` then build the static read-only mirror |

> Captures/screenshots: append `?still=1` to freeze live pulses and skip the SSE stream so
> automated screenshots are deterministic.

---

## Architecture

```
  Master Workbook (.xlsx)  ──watch──┐
  FRED (live) · Anthropic (live) ───┤  Notion · HubSpot · M365 (adapters, stubbed)
                                    ▼
        ┌──────────── BRAIN SERVER (local, Node + Hono) ────────────┐
        │  adapter → Zod validate → reconcile → analytics           │
        │  holds secrets (Anthropic key, tokens) — never the client │
        └───── typed REST (/api/*) + SSE live-push (/sse) ──────────┘
                                    ▼
              React 19 client (Vite, PWA, installable)
                                    │
                nightly bake ──► Cloudflare Pages mirror (read-only, behind Access)
```

**Layered, no leakage across boundaries:**

```
src/
  tokens/       design tokens + dark ("command") / light ("parchment") themes
  primitives/   Button, Card, Badge, KpiStat, Provenance, DataTable, Skeleton, StatusPill (React Aria + Motion)
  charts/       visx kit — BarChart, AreaChart, Sparkline, BarList (themed, animated)
  contracts/    Zod schemas — the versioned UI↔source boundary (PortfolioSnapshot is the whole shape)
  analytics/    pure derivations + formatters (WALT, HHI, rollover, debt ladder, insights) — unit-tested
  data/         client adapters (TanStack Query), SSE wiring, provider
  brain/        ⌘K palette, search index, entity drawer, AI panel, UI store, workspaces
  modules/      one folder per dashboard module
  shell/        sidebar, top bar, module registry, app shell
server/
  workbook/parse.ts   the live Excel adapter (also used by extract + reconcile)
  brain.ts            in-memory state, file-watch, refresh, SSE broadcast
  workbook/counterparties.ts  derives the relationship layer (lenders, carriers, counsel, title)
  ai/respond.ts       deterministic responder (fallback)
  ai/claude.ts        live Anthropic SDK answer over the snapshot (when ANTHROPIC_API_KEY set)
  macro/getMacro.ts   macro snapshot — live FRED (fred.ts) + real-seeded fallback
  macro/fred.ts       live FRED adapter (activates on FRED_API_KEY)
scripts/        extract, reconcile, bake-mirror
```

---

## The data-adapter contract

Everything the UI renders is one Zod-validated shape: **`PortfolioSnapshot`** (`src/contracts/index.ts`).
Nothing reaches a component un-validated — the server validates on parse, and the client re-validates
on fetch (defense in depth).

The **live Excel adapter** is `server/workbook/parse.ts`. It detects data rows dynamically (robust to
layout shifts), converts/guards garbage values (impossible dates are quarantined into `dataQuality`
flags, never rendered raw), links entities, and returns a validated snapshot.

**Provenance is first-class.** KPIs carry a `Cell { value, prov }` where `prov.confidence` is
`confirmed | estimated | derived`. The UI renders a solid underline for confirmed and a dotted one for
derived/estimated — hover for the source cell and formula.

**Correctness is gated.** `npm run reconcile` independently re-reads the workbook's own totals and
asserts the parsed aggregates (NOI, value, rent, cash) match to the dollar. It runs in `npm run gate`.

### Adding a new data source

1. Add/extend a Zod schema in `src/contracts/` and include it in `PortfolioSnapshot` (or a sibling
   contract like `macro`).
2. Write the adapter behind the same shape. For a server-backed source, add a parser/fetcher under
   `server/` and a route in `server/index.ts`; for the live workbook it's already `parse.ts`.
3. Add a client fetcher in `src/data/` (validate with the Zod schema) and a TanStack Query hook in
   `src/data/queries.ts`. Provide a static-mirror fallback if it should work offline.
4. Live sources already wired (each one self-contained function):
   - **Macro → FRED (live):** `server/macro/fred.ts` fetches DGS10, DGS2, SOFR, FEDFUNDS, CPIAUCSL when
     `FRED_API_KEY` is set; `getMacro.ts` falls back to a snapshot seeded with **real** June-2026 FRED values.
   - **AI → Claude (live):** `server/ai/claude.ts` feeds question + snapshot to the Anthropic SDK
     server-side when `ANTHROPIC_API_KEY` is set; `respond.ts` is the deterministic fallback.
   - **Relationship graph:** `server/workbook/counterparties.ts` derives lenders/carriers from the
     workbook + pipeline and merges the grounded people seed (`src/data/seed-counterparties.ts`).
   Still stubbed: **HubSpot / Notion / M365 / QuickBooks-CSV** — add adapters behind their own contracts;
   the `Deal` seed (`src/data/seed-deals.ts`) is the HubSpot/Notion target shape.

---

## The module registry

A module is a single registry entry — register it and it appears in the rail:

```ts
// src/shell/modules.tsx
{ id: 'debt', label: 'Debt', icon: Landmark, group: 'Capital', Component: DebtModule }
```

Modules read data via `useSnapshot()` / `useAnalytics()`, render `DataTable`s and charts, and open the
entity drawer with `useUi().openEntity({ type, id })` for drill-through.

### The widget registry (customizable Overview)

The Overview is a drag-to-rearrange grid driven by `src/modules/overview/widgets.tsx`. Add a widget:

```ts
{ id: 'my-widget', title: 'My Widget', span: 'half', Component: MyWidget }
```

Layout order, hidden widgets, and named **workspaces** persist to `localStorage`
(`src/brain/useWorkspaces.ts`). "Edit layout" reveals drag handles + hide controls; "New view" forks
the current arrangement.

---

## The intelligence layer

- **⌘K command palette** — fuzzy search across every entity + quick commands (navigate, refresh, theme).
- **Entity drill-through** — any record opens a detail drawer with related-entity cross-links.
- **Insight engine** (`src/analytics/engine.ts → generateInsights`) — rules off the workbook's own
  thresholds (balloon ≤18mo, concentration >25/50%, leases ≤90d, lapsed insurance, low occupancy).
- **AI assistant** (⌘J) — docked panel, grounded in the live snapshot, answers cite their source.
  Today it answers deterministically; wire `server/ai/respond.ts` to Claude to light it up.

---

## Quality gates

`npm run gate` = `typecheck && lint && test && reconcile`. All four must pass:

- **typecheck** — `tsc` strict, three project configs (app + node + `functions/`)
- **lint** — ESLint flat config, `--max-warnings 0`
- **test** — Vitest: contracts, analytics engine, freshness, routing, agent loop, draft, overlay, reconciliation
- **reconcile** — derived totals vs the workbook's own cells, $0 tolerance (local-only — needs the workbook)

**CI** (`.github/workflows/ci.yml`) runs `npm run gate:ci` on every push/PR =
`typecheck && lint && test && build && check:bundle`. It omits `reconcile` (the canonical workbook is
a local file, not available to GitHub runners). **`check:bundle`** (`scripts/check-bundle.ts`) enforces
the size budget: entry chunk < 250 kB gzip, lazy route chunks < 60 kB gzip (vendors split via
`manualChunks`; entry currently ~64 kB gzip). **System Health** (`/health`) shows per-source status —
freshness, runtime reconciliation, data-quality flags, and AI availability — with no silent fallbacks.

---

## Deploy — local-first primary + read-only cloud mirror

The **primary** surface runs locally (live, private, free): `npm run dev`, or install the PWA.

The **mirror** is a static, read-only build for phone/away access, **live at
https://ora-command-center.pages.dev behind Cloudflare Access** (Self-hosted app "ora-command-center.pages.dev",
policy "ORA principals" → Allow ggoldberg@ + egoldberg@oxfordra.net, default-deny). It carries the firm's
full operating portfolio, so it **must** stay behind Access.

```bash
npm run deploy:mirror         # bake (redacted) → build dist/ → wrangler pages deploy (branch=main → production)
#   == npm run build:mirror && npx wrangler pages deploy dist --project-name=ora-command-center --branch=main
```

> ⚠ **Preview/hash URLs need a wildcard.** An Access app on the apex `ora-command-center.pages.dev` does
> **not** cover per-deployment URLs (`<hash>.ora-command-center.pages.dev`) — those are public by default.
> The Access app therefore has **two destinations**: `ora-command-center.pages.dev` **and**
> `*.ora-command-center.pages.dev`. After any deploy, `curl -I https://<hash>.ora-command-center.pages.dev`
> and confirm **302 → cloudflareaccess.com**, not 200.

**Confidentiality guard (safe-by-default).** `bake-mirror.ts` **redacts confidential deals**
(E. Fulton Street) by default — verified by the reconcile/`fulton`-substring check. They are included
**only** with an explicit opt-in, and only for a target you have confirmed is Access-gated:

```bash
# Confidential goes ONLY to the Access-gated mirror (already gated — see above):
MIRROR_INCLUDE_CONFIDENTIAL=1 npm run build:mirror
npx wrangler pages deploy dist --project-name=ora-command-center --branch=main
```

> Access is already configured and verified enforcing (unauthenticated → 302 to
> `spring-wood-ade4.cloudflareaccess.com`). The wrangler OAuth token has `pages:write` but no
> Access/Zero-Trust scope, so Access policies are managed in the **Cloudflare Zero Trust → Access →
> Applications** dashboard, not via CLI.

The client automatically falls back to the baked `snapshot.json` / `macro.json` when no Brain Server
is present, so the mirror works standalone. Baked JSON is git-ignored (never commit confidential data).

**Honest freshness.** The client marks a baked fallback as `static` (not a live feed); `StatusPill`
shows the true mode + bake age ("Static · baked 6h ago") and an amber banner once a bake passes
`STALENESS_HOURS` (24, in `src/lib/freshness.ts`). It never renders "LIVE" over a static bake.

**Mirror AI.** `functions/api/ai.ts` is a Cloudflare Pages Function that answers the Ask panel on the
mirror (the static build has no Brain Server). Configure the key once:

```bash
# Local Brain Server: create .env (gitignored) — dev:server auto-loads it:
#   ANTHROPIC_API_KEY=sk-ant-api...   (optional: ANTHROPIC_MODEL, ANTHROPIC_EFFORT)
# Deployed mirror: set it as a Cloudflare secret:
npx wrangler pages secret put ANTHROPIC_API_KEY --project-name=ora-command-center
```

The Ask panel is a **streaming tool-using agent** (`server/ai/agent.ts`, shared by the server and the
Pages Function) — model defaults to `claude-opus-4-8`. With no key it streams the deterministic
responder and the **System Health** view shows "AI offline" — never a silent fake.

**Scheduled freshness (local).** Because the canonical workbook is a local OneDrive file, the daily
bake+deploy runs as a Windows scheduled task, not GitHub Actions:

```powershell
pwsh -File scripts/register-mirror-task.ps1 -At 06:30   # register once (after `wrangler login`)
pwsh -File scripts/deploy-mirror.ps1                     # bake (confidential) → deploy → verify Access 302
```

`deploy-mirror.ps1` fails loudly if the post-deploy apex does not 302 to Access, so a confidential bake
is never left publicly reachable.

> Notes: the Brain Server default port is **8911** (8787/8788 are taken on this machine), and it
> binds `127.0.0.1` only. Modules are code-split via `React.lazy` (17 chunks); large tables
> (the 137-row rent roll) are virtualized. E2E + axe specs live in `tests/e2e` — run with
> `npx playwright install chromium` then `npm run test:e2e` in a clean environment.
