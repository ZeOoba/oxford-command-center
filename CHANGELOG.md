# Changelog

## Live AI enabled + agent stream fix (2026-06-03)

- **fix(agent):** the Messages request was missing `stream: true`, so the API returned a single JSON
  body and the SSE parser emitted an empty answer — only visible with a live key (the mocked test
  returned SSE regardless). Added Anthropic `error`-frame handling and raised `max_tokens` to 16000
  (adaptive thinking counts toward the budget). Regression test asserts the body sets `stream: true`.
- **Live AI ON.** `ANTHROPIC_API_KEY` set as a Cloudflare Pages secret; the mirror was redeployed so
  the agent endpoint + the full Phase 1–6 build are now live behind Access. Verified locally end-to-end:
  the agent calls spine tools, returns `claude-opus-4-8` answers, and emits clickable `[[type:id|label]]`
  citations. Post-deploy Access gate re-verified — apex, hash URL, `/api/ai`, and the confidential
  `/snapshot.json` all 302 → cloudflareaccess.com (E. Fulton bake not exposed). `main` merged + pushed.

## Phase 6 (slice 1) — CI, bundle budget, runtime reconciliation, System Health (2026-06-03)

- **CI gate** — `.github/workflows/ci.yml` runs `npm run gate:ci` (typecheck · lint · test · build ·
  bundle budget) on every push/PR. `reconcile` stays local-only (needs the canonical workbook).
- **Bundle budget** — `scripts/check-bundle.ts` enforces entry < 250 kB gzip + lazy routes < 60 kB
  gzip and fails CI on breach. `vite.config.ts` `manualChunks` splits vendors (react/router/visx/
  motion/aria) — the **entry chunk dropped from 188 kB → ~64 kB gzip**; all routes well under budget.
- **Runtime reconciliation** — `server/reconcile-runtime.ts` `checkSnapshot()` runs on every
  `brain.refresh()` and flags internal inconsistencies (cash total ≠ Σ entities, annual ≠ Σ monthly×12,
  empty core sets, dangling relationship edges) as DataQualityFlags on the snapshot — degraded state
  is visible, never silently served. Test: `tests/unit/reconcile-runtime.test.ts`.
- **System Health** module (`/health`) — per-source status with no silent fallbacks: data freshness,
  reconciliation result, data-quality flags, and AI availability (`/api/health` now reports
  `ai.configured` + model without exposing the key). Verified in-browser.
- Gate: **68 tests**; `gate:ci` green (entry 64 kB gzip).
- **Deferred to a later Phase 6 slice / Phase 7** (need credentials or a vector store): multi-source
  ingestion adapters (Notion/M365/QB), document RAG (`search_documents` remains a stub), dated
  snapshot history.

## Phase 5 (slice 2) — Write-back actions via local overlay (2026-06-03)

- **Local JSON overlay** (`server/overlay.ts`, gitignored `data/overlay.json`) — the master workbook
  stays canonical and READ-ONLY; user mutations (deal-stage advances, created tasks) persist to the
  overlay and merge onto each parsed snapshot (`applyOverlay`, pure). Brain caches the parsed `base`
  and re-derives without re-parsing on each action; emits SSE so clients refetch. (Decision: local
  overlay over Notion/workbook-write.)
- **Endpoints** `POST /api/actions/deal-stage` (validated against the `DealStage` enum) and
  `POST /api/actions/task`. Available only on the live server — the deployed mirror is read-only.
- **UI (live-only, confirm-before-write):** deal drawer "Advance to {next} →" (with a confirm noting
  the workbook is unchanged) and a "+ Add task" form in the Tasks module. Controls are hidden unless
  freshness is `live`.
- **LOI/refi doc:** deal drawer "Draft LOI handoff" produces a pre-filled brief to paste into the
  firm's loi-generation skill (decision: agent draft + handoff brief); the agent can refine via Ask.
- Tests `tests/unit/overlay.test.ts` (stage advance path, overlay merge, base-not-mutated). Verified
  live (stage change + task add persisted and reflected; overlay confirmed gitignored). Gate: 63 tests.

## Phase 5 (slice 1) — Closed-loop draft-only email CTAs (2026-06-03)

- `src/brain/draft.ts`: pure `buildDraft(snapshot, request)` — renewal / refi / insurance / general
  drafts in firm voice, **always cc ggoldberg@ + egoldberg@**, recipient auto-filled from the
  relationship graph where known. `mailtoHref` opens an Outlook draft. **Never sends.**
- `DraftPanel` modal: editable To/Subject/Body, Copy + Open-in-Outlook, and a standing
  "Draft only — auto-send is disabled" banner. Draft state is ephemeral in `UiProvider` (not the URL).
- `EntityDrawer` CTAs: lease → Draft renewal, loan → Draft refinance note, insurance → carrier note,
  counterparty → Draft email.
- `tests/unit/draft.test.ts` (cc principals, content grounding, carrier auto-fill from graph, mailto
  encoding). Gate: **59 tests**. Verified in-browser.
- **Deferred (need a persistence-layer decision):** create-task, advance-deal-stage, LOI/refi doc
  generation, and write-back to the spine / Notion / QB / HubSpot.

## Phase 4 — Data-integrity polish (2026-06-03)

- **#6 balloon precision (verified, then fixed).** Confirmed via the live Loan Index that it has **no
  balloon-payment column** — the `$973,606` payoff lives only in a Monthly-Checklist task note, so a
  typed `balloonPayment` field would be fabricated and was NOT added. Instead standardized the
  current-balance figure to full precision ($980,773) in the balloon insight and the Debt "Balloon
  watch" so it matches the loan drawer and never reads as two different numbers ($981K vs $980,773).
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
  email/notes onto a same-named derived firm (the lender "Symetra" no longer carries the title
  coordinator's address). Regression test: `tests/unit/counterparties.test.ts`.
- **Task banner ingestion (Defect 9, upgraded from Low).** `parseTasks` now rejects Monthly-Checklist
  banner/summary rows (`isTaskBannerRow`) that were ingested as junk task cards. Verified end-to-end:
  banner smears gone, the legit `$973,606` balloon-payoff task preserved. Regression test in
  `tests/unit/parse.test.ts`.
- **Scheduled freshness (local).** Added `scripts/deploy-mirror.ps1` (bake confidential → deploy →
  re-verify Access 302) and `scripts/register-mirror-task.ps1` (daily Windows scheduled task). Chosen
  over GitHub Actions because the canonical workbook is a local OneDrive file. Not auto-run — Gabriel
  registers/triggers the first deploy.

## Phase 0 — Verify & audit (2026-06-03)

- Added `AUDIT.md`: architecture map, data-flow diagram, static-vs-derived list, and a verified defect
  table (each item reproduced against code / unauthenticated curl). No code changes.
