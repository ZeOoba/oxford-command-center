# Lease Market Intelligence — P1 Implementation Plan (plan rev 2, spec rev 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Each task lives in its own file in this folder; read THIS overview plus your task file only. Where a task says "start from the rev 1 code", read it with `git show a4f075a:docs/superpowers/plans/2026-09-16-lease-market-p1/<old-file>.md` (old numbering) and apply the listed deltas.

**Goal:** Ship P1 of `docs/superpowers/specs/2026-09-16-lease-market-intelligence-design.md` (rev 3): CoStar lease-listing ingest with property/space identity and an event ledger → normalization (totals, base+expense quotes, bounds, NNN-eq) → cell benchmarks + similarity comparable sets with confidence → space signals + a transparent Acquisition Radar score with a decision log → Oxford Rent Position with listing hygiene → market-rent feed into lease-forecast → API → "Lease Market" module (KPI row, 5 tabs, rent curve, history drawer).

**Architecture:** Pure math in `src/analytics/lease-market/` (normalize, benchmarks, similarity, signals, radar — no I/O). Server I/O in `server/warehouse/lease-market/` (config, CoStar parser, owner screen, ingest, compute, positioning, feed). Hono sub-router `server/warehouse/lease-market-api.ts`. CLI `scripts/lease-market.ts`. React module `src/modules/lease-market/` with a new visx `RentCurve`.

**Tech stack:** TypeScript strict (`noUncheckedIndexedAccess`), better-sqlite3 + numbered SQL migrations, Hono 4, Zod 3, ExcelJS 4, React + TanStack Query, visx, Vitest (forks, jsdom), Python 3.13 (owner-screen bridge).

## Global Constraints

- Work ONLY in `C:\Users\Owner\oxford-command-center\.claude\worktrees\lease-market-intel`, branch `feat/lease-market-intel`. Never `cd` to the main checkout. Never `git stash`.
- Every commit leaves `npm run typecheck`, `npm run lint`, and the task's tests green. Never `--no-verify`.
- Stage explicit paths only; never `git add -A` / `git commit -a`. Commit messages end with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`, written to a file and passed with `git commit -F <file>`.
- Server/scripts import src by relative path; src uses relative paths or `@contracts` / `@analytics` / `@` aliases. `@typescript-eslint/consistent-type-imports` is an error.
- Never invent CoStar column labels. Tests use the TEST labels from Task 07; the production header map stays `pending-sample` until the controller fills it from real exports.
- No fabricated market numbers: `opexDefaults` stay `null` in the shipped config.
- No code path may automate CoStar Suite, LoopNet, or call any third-party listing-data API.
- Never present an asking-rent × SF figure as NOI. The only dollar magnitude is `indicativeRentGapUsd`, always labeled "gross, vacant space only — not NOI".
- Thresholds (verbatim spec rev 3): benchmark n ≥ 5 · below-market needs confidence ≥ MEDIUM and asking ≤ comparable P25 and ≤ 0.85 × comparable median · low coverage < 0.5 quoted share · stale = effective DOM ≥ max(180, 1.5 × completed-DOM baseline), fallback 180 established / 270 entry, baseline n ≥ 10 · rent bounds $1.00–$60.00/SF/yr · range midpoint only if spread ≤ 20% · no-period value < 3.00 ⇒ monthly · complete export ⇔ rows ≥ 0.7 × prior complete and < exportRowCap and date after prior and same header set · freshness 35 days · flex office split 40% · similarity: comp score ≥ 60, top 15, sufficient ≥ 8, HIGH ≥ 15 · radar: gates + score ≥ 50 candidate, ≥ 70 push (P3) · withdrawn lookback 90 days · sf_change ≥ 5% · quoted-opex median n ≥ 5.
- Size bands on available SF: `<5K` (<5,000) · `5-15K` (<15,000) · `15-30K` (<30,000) · `30-50K` (<50,000) · `50-80K` (≤80,000) · else none.

## Deliberate P1 scope limits

- Opex estimate = config `opexDefaults` components ▸ market quoted-opex median (total only) ▸ null. ORA warehouse actual opex is P2.
- `mirrorRowLevel=false` strips addresses, owner names, broker names and listing URLs from every API response.
- Signals are fully replaced each compute; `lm_radar_decision` is append-only and never replaced.
- Benchmarks, comparable sets, positioning and radar views are computed per request from persisted observations; signals and the feed are persisted by `compute`.
- Executed lease comps, derived monthly series, map, email intake, digest and skill are P2/P3 (spec §9).

## File map

| File | Responsibility | Task |
|---|---|---|
| `server/warehouse/migrations/029_lease_market.sql`, `architecture/database-schema.md` | lm_* tables + agent views | 01 |
| `src/contracts/lease-market.ts`, `config/lease-market.json` | contracts, config | 02 |
| `src/analytics/lease-market/normalize.ts` | address/suite, bands, rent text (totals, base+expense), pricing, bounds, opex estimate, eligibility, dates | 03 |
| `src/analytics/lease-market/benchmarks.ts` | quantiles, cells, percentile | 04 (unchanged from rev 1 Task 04) |
| `src/analytics/lease-market/similarity.ts` | similarity score, comp selection, comparable resolution, confidence | 05 |
| `src/analytics/lease-market/signals.ts`, `radar.ts` | space signals, radar gates + score | 06 |
| `server/warehouse/lease-market/costar-parse.ts`, `config/lease-market.costar-headers.json`, `tests/unit/lease-market-fixtures.ts` | header-mapped parser + fixtures | 07 |
| `server/warehouse/lease-market/owner-screen.ts`, `scripts/lease-market-owner-screen.py` | owner screen bridge | 08 |
| `server/warehouse/lease-market/config.ts`, `ingest.ts` | loaders; landing, property/space identity, observations, events, completeness, removal | 09 |
| `server/warehouse/lease-market/compute.ts` | market state, signals + radar + feed persistence, KPIs, freshness, data quality, DOM bins, changes | 10 |
| `server/warehouse/lease-market/positioning.ts` | Oxford Rent Position + hygiene | 11 |
| `scripts/lease-market.ts`, `package.json`, `.gitignore` | CLI | 12 |
| `server/warehouse/lease-market/feed.ts`, lease-forecast contract/analytics/api, leasing hooks | feed merge | 13 |
| `server/warehouse/lease-market-api.ts`, `sub-routers.ts`, `bake-warehouse.ts`, `check-refute-required.ts` | API | 14 |
| `src/charts/RentCurve.tsx` | rent curve scatter | 15 |
| `src/modules/lease-market/*`, `src/shell/modules.tsx` | dashboard | 16 |
| controller | status.json, Columbus-first gate, header map, ORA map, gate, Fable REFUTE, PR | 99 |

## Dispatch

`Dispatch: subagent-driven · sonnet (implementers, per Gabriel) / opus (task reviews) / fable (REFUTE: Tasks 03, 05, 06, 09, 10, 11, 13) — code-heavy, 16 sequential tasks, financial math.` Order: 01 → 16 linear; 99 controller-only.

## Post-review changes (adversarial pass + whole-branch review, 2026-09-17)

These supersede the per-task briefs where they disagree. The briefs are left intact as the record of
what was built; this section is the record of what changed after it was built.

**Rent parsing (03).** A partial expense add-on (`+ CAM`, `+ CAM/TAX`, `+ TAX`, `+ INS`) is ambiguous:
only a full-expense form (NNN, TICAM, nets, expenses, opex, or CAM with both TAX and INS) resolves the
basis to NNN. An explicit head NNN keeps its basis alongside a partial add-on, but the add-on's figure
is never taken as total opex. A period-less add-on inherits the head's period. A `/mo` figure with no
`/SF` token below the total-quote threshold is ambiguous, not per-SF. A `0` on either side of a numeric
rent pair is treated as blank before the low/high swap.

**Identity (03/09).** `normalizeSuite` keeps a building designator (`Bldg 2` + `A` ⇒ `B2-A`);
`addressNorm` is unchanged, so `oraProperties.addressNorms` matching is unaffected. Ingest adopts a
same-address property whose stored `city_norm` is blank in both directions, and skips a CoStar id that
already belongs to another market. A landing dated more than a day after `now()` fails closed.

**Completeness (09).** An export is complete only when it also postdates every prior ok landing; a
back-dated file is treated as partial. A space first sighted in a back-dated landing starts
`missing_once`. A row count at the configured cap lands partial; a round CoStar-looking count warns.

**Comparables (05).** Confidence is capped by the SUBJECT's own unknown components — MEDIUM when
location is unknown, LOW at `thresholds.similarityUnknownLowCap` or more. At most
`thresholds.similarityPerPropertyCap` comps come from one property, applied before the n-gates, so a
single dominant building degrades to the cell basis rather than dragging the median.

**ORA exclusion (10/11).** An owner that screens as ORA-self (`owner_type = 'affiliated'`) is excluded
everywhere `ora_property_key` is, including the stale-DOM baseline and the latest-export KPIs, and
surfaces a hygiene flag telling the operator to map the address. `oraProperties` is re-stamped onto
existing rows at the start of every compute, and an empty `oraProperties` warns loudly.

**Radar (01/06).** `cumulative_reduction_pct` is derived from `asking_psf_yr`, the same basis as
`price_cut` events, and is null at zero reductions — opex-median drift can no longer score reduction
points. Withheld markets are reported from the same screen gate the radar uses.

**Mirror (14).** The redacted (public-safe) bake omits every `/lease-market/*` route on BOTH resolver
paths. Row-level CoStar detail remains on the private Access-gated mirror only (Gabriel's ratification).

**Governors (02/14).** `config/lease-market.json` is now refute-gated like the financial source files.

## Known limitations at merge

- `oraProperties` ships empty and the header map ships `pending-sample`: the CLI fails closed with an
  actionable message until both are filled (Task 99.5).
- Correct an applied migration with the NEXT number, never in place — migrations are tracked by
  filename with no checksum, so an edit to 029 will not reach a database that already applied it.
- Do not run `npm run lease-market:ingest` or `:compute` against the live warehouse before this merges:
  both open the warehouse through `openWarehouse`, which applies this branch's unmerged migration.
- The private mirror must be re-baked, not merely redeployed: new required response fields
  (`lastComputedAt`, `unknown`, `hygieneFlags`) fail schema parse against a mirror baked before this PR.
- A rent roll carries no building, so a vacant unit "A" at a property with `B1-A` and `B2-A` listed
  binds to the lowest listing id; the other space still surfaces as listed-but-not-vacant.
- The history drawer is live-only (not baked on either mirror), and `/positioning` is not baked on the
  checkpoint-read path.
- `lm_radar_decision` is append-only by trigger: a future backfill must `DROP TRIGGER` first.
