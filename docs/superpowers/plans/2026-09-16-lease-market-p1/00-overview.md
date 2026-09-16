# Lease Market Intelligence — P1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own file in this folder; read THIS overview plus your task file only.

**Goal:** Ship P1 of the spec `docs/superpowers/specs/2026-09-16-lease-market-intelligence-design.md` (rev 2): CoStar lease-listing ingest → NNN-equivalent normalization → n-gated benchmarks → signals (new, stale, rent cut, below market, acquisition candidate) → ORA positioning → market-rent feed into lease-forecast → API → "Lease Market" dashboard module.

**Architecture:** Pure math lives in `src/analytics/lease-market/` (normalize, benchmarks, signals — no I/O). Server-side I/O lives in `server/warehouse/lease-market/` (config, CoStar parser, owner-screen bridge, ingest, compute, positioning, feed). A Hono sub-router `server/warehouse/lease-market-api.ts` serves three GET routes. A CLI `scripts/lease-market.ts` runs ingest and compute. The React module `src/modules/lease-market/` renders the data with a new visx `StripPlot`.

**Tech stack:** TypeScript (strict, `noUncheckedIndexedAccess`), better-sqlite3 warehouse with numbered SQL migrations, Hono 4, Zod 3, ExcelJS 4, React + TanStack Query, visx, Vitest (forks pool, jsdom), Python 3.13 for the owner-screen bridge.

## Global Constraints

- Work ONLY in the worktree `C:\Users\Owner\oxford-command-center\.claude\worktrees\lease-market-intel`, branch `feat/lease-market-intel`. Never `cd` to the main checkout. Never `git stash`.
- Every commit leaves `npm run typecheck`, `npm run lint`, and the task's tests green. Never `--no-verify`.
- Stage explicit paths only (`git add <paths>`), never `git add -A` / `git commit -a`.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`. Write the message to a file and use `git commit -F <file>` (heredocs collapse newlines in this shell).
- Imports: server and scripts import src code by relative path (`../../../src/contracts/lease-market`); src code imports by relative path or the `@contracts` / `@analytics` / `@` aliases. `@typescript-eslint/consistent-type-imports` is an error — use `import type` for type-only imports.
- Never invent CoStar column labels. Test fixtures use the TEST labels defined in Task 06; the production header map stays `"status": "pending-sample"` until the controller fills it from a real export.
- No fabricated market numbers: `opexDefaults` stay `null` in `config/lease-market.json`.
- CoStar data is internal-only. Do not add any code path that automates CoStar Suite or LoopNet web access.
- Thresholds (verbatim from spec §3.3–3.6): benchmark n ≥ 5 · below-market n ≥ 10, ≤ P25 and ≤ 0.85 × median, not market-level rollup, not low coverage · low coverage when quoted share < 0.5 · stale = effective DOM ≥ max(180, 1.5 × completed-DOM baseline), fallback 180 established / 270 entry, baseline needs n ≥ 10 · vacancy share ≥ 30% · candidate building SF ≤ 50,000 · benchmark universe building SF ≤ 80,000 · positioning band ±10% · range midpoint only if spread ≤ 20% · no-period value < 3.00 ⇒ monthly · complete export needs row count ≥ 0.7 × prior complete and < exportRowCap · freshness 35 days · flex office split at 40%.
- Size bands on available SF: `<5K` (<5,000) · `5-15K` (<15,000) · `15-30K` (<30,000) · `30-50K` (<50,000) · `50-80K` (≤80,000) · else no band.
- Rollup order: exact cell ▸ widen size band one step each side ▸ market level (any submarket, widened band) ▸ null.

## Deviations from spec rev 2 (deliberate, P1 scope)

- Opex resolution uses `config.markets[].opexDefaults` only; ORA warehouse actual opex is P2.
- `mirrorRowLevel=false` strips addresses/owner names from API responses everywhere (not only in the bake).
- Signal dismissal and `lm_ora_listing_activity` are deferred to P3; P1 recompute replaces all signals.
- ORA positioning is computed per request in the API (needs the live snapshot); benchmarks are computed per request from observations; signals and the feed are persisted by `compute`.

## File map

| File | Responsibility | Task |
|---|---|---|
| `server/warehouse/migrations/029_lease_market.sql` | lm_* tables | 01 |
| `architecture/database-schema.md` | schema doc section | 01 |
| `src/contracts/lease-market.ts` | Zod contracts: canonical row, config, API responses | 02 |
| `config/lease-market.json` | markets, thresholds, ORA property map | 02 |
| `src/analytics/lease-market/normalize.ts` | address/suite, size band, rent text, pricing, eligibility, dates | 03 |
| `src/analytics/lease-market/benchmarks.ts` | quantiles, cell rollup, percentile | 04 |
| `src/analytics/lease-market/signals.ts` | DOM, stale threshold, per-listing signals | 05 |
| `server/warehouse/lease-market/costar-parse.ts` + `config/lease-market.costar-headers.json` | header-mapped CoStar export parser | 06 |
| `tests/unit/lease-market-fixtures.ts` | shared test config, header map, xlsx writer | 06 |
| `server/warehouse/lease-market/owner-screen.ts` + `scripts/lease-market-owner-screen.py` | institutional / never-call owner screen bridge | 07 |
| `server/warehouse/lease-market/config.ts` | config loaders | 08 |
| `server/warehouse/lease-market/ingest.ts` | landing, identity, observations, completeness, removal | 08 |
| `server/warehouse/lease-market/compute.ts` | market state, signals + feed persistence, freshness | 09 |
| `server/warehouse/lease-market/positioning.ts` | ORA vacant-unit positioning | 10 |
| `scripts/lease-market.ts` + `package.json` + `.gitignore` | CLI | 11 |
| `server/warehouse/lease-market/feed.ts`, `src/analytics/lease-forecast.ts`, `src/contracts/lease-forecast.ts`, `server/warehouse/lease-forecast-api.ts`, leasing UI label | feed merge | 12 |
| `server/warehouse/lease-market-api.ts`, `sub-routers.ts`, `scripts/bake-warehouse.ts`, `scripts/check-refute-required.ts` | API + mirror + refute path list | 13 |
| `src/charts/StripPlot.tsx` | strip plot chart | 14 |
| `src/modules/lease-market/{hooks.ts,LeaseMarketModule.tsx}`, `src/shell/modules.tsx` | dashboard module | 15 |
| controller tasks | status.json, header map from samples, ORA property config, gate, Fable REFUTE, PR | 99 |

## Dispatch

`Dispatch: subagent-driven · sonnet (implementer, per Gabriel) / opus (task reviewer) / fable (REFUTE on Tasks 03–05, 08–10, 12) — code-heavy, 15 independent-ish tasks, financial math.`
Task order is linear 01 → 15; 99 is controller-only.
