# Changelog

## Phase 4 — Data-integrity polish (2026-06-03)

- **#6 balloon precision (verified, then fixed).** Confirmed via the live Loan Index that it has **no
  balloon-payment column** — the `$REDACTED-AMT` payoff lives only in a Monthly-Checklist task note, so a
  typed `balloonPayment` field would be fabricated and was NOT added. Instead standardized the
  current-balance figure to full precision ($REDACTED-AMT) in the balloon insight and the Debt "Balloon
  watch" so it matches the loan drawer and never reads as two different numbers ($981K vs $REDACTED-AMT).
  Test asserts the balloon metric is full precision.
- **#7 count unit label.** Added an explicit caption to the Portfolio view: "N investment assets · the
  Sepich Portfolio bundles 8 buildings as one row · SF and value are Oxford-share."
- **#8 drawer responsive.** Defensive fix: drawer detail values now wrap (`overflow-wrap: anywhere`,
  `min-w-0`) and labels don't shrink, so long emails/notes can't clip at narrow widths.

## Phase 3 — Tool-using streaming agent (2026-06-03)

- **Rebuilt `server/ai/` into a tool-using agent** (`agent.ts` + `tools.ts`), runtime-agnostic
  (raw `fetch` + Web Streams) so ONE implementation runs in Node 24 and the Cloudflare Worker.
- **11 spine tools** (no whole-JSON dumps): `get_portfolio_summary`, `get_property`, `get_leases`,
  `get_loans`, `get_cash_position`, `get_deals`, `get_relationships`, `get_alerts`, `search_entities`,
  `run_scenario`, and a `search_documents` Phase-7 stub. Each returns compact data + citation refs.
- **Streaming over SSE** with visible tool steps ("→ querying the rent roll…"), bounded tool loop
  (max 8 turns), conversation memory for follow-ups, and a correct thinking-block round-trip
  (signatures preserved). Prompt caching on the system/tools prefix; adaptive thinking +
  configurable `effort` (`ANTHROPIC_EFFORT`); model from `ANTHROPIC_MODEL` (default `claude-opus-4-8`).
- **Clickable, grounded citations.** The model cites entities inline as `[[type:id|label]]`; the
  Ask panel renders them as chips that open the deep-linked drawer (ties to Phase 2).
- **Both surfaces share the agent.** Server `/api/ai` now streams SSE (Hono `streamSSE`); the Pages
  Function streams the same agent via a `ReadableStream`. `respond.ts` remains the no-key fallback.
  Removed the now-dead `server/ai/claude.ts` (SDK path superseded by the shared raw-fetch core).
- New client: `askBrainStream` adapter + rewritten `AiPanel` (incremental render, tool-step status,
  citation chips). Tests: `tests/unit/ai-agent.test.ts` (tool executors + a mocked-`fetch` two-turn
  loop asserting tool_result round-trip and cited output). Gate: **53 tests**; `functions/` typechecked.
- Verified end-to-end in-browser (no-key fallback streams a grounded answer; live tool-use/citations
  activate once `ANTHROPIC_API_KEY` is set).

## Phase 2 — Real routing & deep links (2026-06-03)

- **Adopted React Router v6.** Every view has a real path (`/overview`, `/portfolio`, `/debt`, …) and
  entities are deep-linkable (`/portfolio/:id`, `/debt/:id`, `/relationships/:id`, …) — Defect 2 fixed.
- **URL is the source of truth** for navigable state: active module, the open entity drawer, and the
  scenario (`?scenario=Upside`). `UiProvider` is now URL-backed but keeps the same `useUi()` API, so no
  module/consumer changed. Personal prefs (theme/density/widget layout) stay in localStorage.
- **Back/forward/refresh preserve view + scenario + open drawer** — verified live: a direct deep link
  to `/debt/:id?scenario=Upside` restores the Debt view, Upside scenario, and the open drawer on
  refresh; back/forward toggle the drawer. `entityType → home module` mapping makes any drawer
  shareable from any view (`src/brain/routing.ts`).
- **SPA fallback** (`public/_redirects`) so deep links/refresh work on the Cloudflare mirror; Functions
  (`/api/*`) and real assets are matched first.
- Regression test `tests/unit/routing.test.ts` (parse/build + type↔module inverse). Gate: 46 tests.

## Phase 1 — Honesty + mirror AI + quick integrity wins (2026-06-03)

- **Honest freshness (Defect 5).** Removed the hard-coded `status:'fresh'` static fallback in
  `src/data/client.ts`; added a real freshness model (`live`/`static`/`stale`, `STALENESS_HOURS=24`)
  in `src/lib/freshness.ts`. `StatusPill` now shows the true mode + bake age ("Static · baked 6h ago")
  and never pulses/reads "LIVE" over a bake; an amber `StaleBanner` appears when a bake ages out.
  Regression test: `tests/unit/freshness.test.ts`.
- **Mirror AI (Defect 1).** Added Cloudflare Pages Function `functions/api/ai.ts` — calls Anthropic
  server-side with the `ANTHROPIC_API_KEY` secret, grounds in the baked snapshot via the ASSETS
  binding, matches the `askBrain()` contract, and says "AI offline — no key" when unconfigured
  (never a silent stub). Added `functions/tsconfig.json` to the typecheck gate.
- **No overpromising buttons.** `InsightList` actions relabeled to "View details" (they only open the
  record until Phase 5 wires real workflows).
- **Value by Market shows value, not NOI (Defect 3).** Added `marketByValue` to the analytics bundle
  and bound it in `PortfolioModule`. Regression test in `tests/unit/analytics.test.ts`.
- **Counterparty contact identity (Defect 4).** `deriveCounterparties` no longer copies a person's
  email/notes onto a same-named derived firm (the lender "REDACTED-672" no longer carries the title
  coordinator's address). Regression test: `tests/unit/counterparties.test.ts`.
- **Task banner ingestion (Defect 9, upgraded from Low).** `parseTasks` now rejects Monthly-Checklist
  banner/summary rows (`isTaskBannerRow`) that were ingested as junk task cards. Verified end-to-end:
  banner smears gone, the legit `$REDACTED-AMT` balloon-payoff task preserved. Regression test in
  `tests/unit/parse.test.ts`.
- **Scheduled freshness (local).** Added `scripts/deploy-mirror.ps1` (bake confidential → deploy →
  re-verify Access 302) and `scripts/register-mirror-task.ps1` (daily Windows scheduled task). Chosen
  over GitHub Actions because the canonical workbook is a local OneDrive file. Not auto-run — Gabriel
  registers/triggers the first deploy.

## Phase 0 — Verify & audit (2026-06-03)

- Added `AUDIT.md`: architecture map, data-flow diagram, static-vs-derived list, and a verified defect
  table (each item reproduced against code / unauthenticated curl). No code changes.
