# Changelog

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
