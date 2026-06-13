# Changelog

## PFI Phase 1c — A↔B NOI reconciliation (master plan Revision-1 keystone) (2026-06-13)

Closes the single most-important integrity gap in the master plan: the two un-reconciled NOI
representations — workbook `Property.noi` (Spine A, the current-state spine, Oxford-share at
column 13) vs warehouse `oxfordNoi` (Spine B, the time dimension, `noi × ownershipPct` at the
property's latest full-year period). Without this tie-out every downstream scoring engine,
capital-allocation verdict, and refi recommendation inherits silent drift between the two
spines and can launder ambiguity into false authority.

- New `server/warehouse/reconcile-noi.ts` — a pure classifier (`classifyNoiReconciliation`)
  + assembler (`reconcileNoiAB`) + DB wrapper (`reconcileNoiABFromDb` + `buildNoiReconcileInputs`).
  100% deterministic, db-free at the classifier core.
- **Apples-to-apples by design.** Both sides are Oxford-share: workbook reports Property.noi at
  column 13 (verified via `parse.ts:147` and `reconcile.ts:57`'s "Property NOI (Oxford) total"
  label); warehouse computes `oxfordNoi = noi × ownershipPct`. Comparing 100%-basis warehouse NOI
  to Oxford-share workbook NOI on a 50%-owned property would manufacture a 50% phantom drift —
  the exact bug the keystone exists to surface in the OTHER spine.
- **Slug bridge is direct, no alias table.** `parse.ts:124` produces `id = slug(name)`;
  `property_master.id` IS the same canonical slug (verified for all 14 units incl. the FVC /
  Sepich Portfolio bundle — workbook snapshot reports `sepich-portfolio-columbus-oh-8-props`,
  identical to property_master).
- **Tolerance:** 5% relative OR $10k absolute (in-tolerance, info); 5–20% (drift, warn); ≥20%
  (large-drift, error). The absolute floor protects small-NOI properties (Solar 25% / late
  acquisitions) from spurious large-drift errors. Symmetric on sign.
- **Statuses:** `match` · `in-tolerance` · `drift` · `large-drift` · `missing-from-workbook` ·
  `missing-from-warehouse` · `lease-run-skipped`. Lease-run properties (Fishel / Sunburst —
  ratified 2026-06-12 to run off master-lease estimates) and Residence-typed properties
  (Persimmon) are skipped by design, not flagged as defects.
- **Basis discipline (Phase 1a continuity).** A `match` or `in-tolerance` on basis=`unknown` is
  downgraded to `warn` severity — the comparison isn't proven like-for-like even when the numbers
  agree. The reason string surfaces the caveat.
- 13 unit tests pin every status path + the assembler filter/sort + the boundary math
  (signed delta, deltaPct denom, residence filter, deterministic ordering).

## PFI Phase 1b — `get_macro` agent tool: live rate environment for the AI (2026-06-13)

Closes the audit-flagged AI/macro gap (the agent had ZERO access to FRED — refi-spread,
cap-rate-vs-Treasury, and rate-environment questions could not be answered against live data).
Unblocks the Phase-2 debt/refi narrative.

- New `get_macro` tool in `TOOL_DEFS` (empty parameters; description scoped to refi-spread /
  cap-rate-spread / rate-environment framing — not a general-purpose news query) with a STUB
  executor mirroring `search_documents` ("Live macro is not available on this surface.").
- New `opts.macroProvider: () => Promise<MacroSnapshot | null>` on `AgentOptions`, exact mirror
  of `opts.docSearch`. The dispatch loop routes `get_macro` through it when injected; falls
  back to the stub on null/hard failure. `summarizeMacro()` returns a small, numbers-first
  payload — indicators (id → label/value/unit/change) + a 10Y trend digest (current / low12mo /
  high12mo / n) — not the raw history array.
- `server/index.ts` wires `macroProvider: getMacro` at the `runAgent` call (one-line addition).
  The Cloudflare Pages Function is intentionally NOT wired — the static mirror keeps the stub
  (no FRED secret on the mirror; safe-by-construction).
- `summarizeMacro()` payload hardened from the adversarial pass (3 real defects fixed before
  commit): (1) **no orphan `tenYearTrend.current`** — the canonical current 10Y is
  `indicators.DGS10.value` at `asOf`, never a parallel undated value from the history's tail
  (the prior shape had 4.47 vs 4.48 with no tie-break, and refi-spread math went path-dependent);
  (2) the 10Y trend window is **date-driven** — sorted by date and sliced to the last 12, so a
  live FRED return of 13 points (month-boundary publication) or an out-of-order history can't
  mislabel `low12mo`/`high12mo`; the field is now `tenYearTrend = {windowMonths, n, endDate, low,
  high}` with the window explicit; (3) when `source === 'mock'` the payload emits a top-level
  `dataFreshness: 'SEEDED — …'` instruction, and the tool description tells the model it MUST
  surface that caveat before quoting any number — without it the institutional "numbers-first /
  no-hedging" register would quote a frozen seeded snapshot as the current rate (the exact
  misread-as-live failure that would corrupt Phase-2 refi narrative).
- Tests: a TOOL_DEFS + stub assertion; an end-to-end SSE mock that proves the injected provider
  is called and its live snapshot is fed back to the model as the `tool_result`; and **nine**
  focused unit tests over `summarizeMacro` pinning each fix (orphan-current removed, date-windowed
  trend, off-by-13 prevention, out-of-order safety, SEEDED caveat, 5-indicator regression,
  null-safety, **DGS10-suspicious guard fires on zero**, **doesn't fire on live positive**).
- A SECOND adversarial round on the fix caught a real medium: by removing the orphan `trend.current`
  the model now strictly trusts `indicators.DGS10.value` — but `server/macro/fred.ts:49` silently
  coalesces a missing FRED observation to `0` via `?? 0`. A FRED partial outage on DGS10 alone
  would feed the model `'10Y at 0.00%, refi spread −410 bps'` confidently. Defense-in-depth shipped:
  when `DGS10` is missing or `<= 0` (a 10Y rate cannot realistically be ≤ 0), `summarizeMacro` now
  attaches a `dataQuality` flag and a dated `currentTenYFallback` from the most recent finite
  trend point. **Root-cause fix tracked** (make `MacroIndicator.value` nullable in the contract,
  drop the `?? 0` in fred.ts, handle null in the Market UI) — a follow-up task.

## PFI Phase 1a.2 — surface the cross-basis benchmark warning in the UI (2026-06-13)

Completes the basis guard end-to-end (the consumer-side gap the Phase-1a adversarial review flagged:
`mixedBasis` was computed and serialized by the API but the client type dropped it and no view read
it — a dead guard). The client `MetricBenchmark` now carries `bases`/`mixedBasis`; `BenchmarksView`'s
SummaryStrip renders a red "Mixed accounting basis (…) — not like-for-like" badge (in place of the
"portfolio cohort" badge) whenever the selected cohort mixes cash / accrual / tax / unknown bases.
Decision logic is a pure, unit-tested helper (`mixedBasisNote` in `benchmarks-intel.ts`); the view
wiring follows the existing singleton-cohort badge pattern (browser-verified per the module convention).
No server change — the engine already returned the fields.

## PFI Phase 1a — basis discipline + NOI integrity (2026-06-13)

The integrity gate from the Intelligence Platform master plan (Revision 1: no scoring engine ships
until NOI is basis-disciplined and the two NOI codepaths cannot drift). All changes are
behavior-preserving on the current corpus (NOI matrix byte-identical; gate green) and correct on the
multi-basis / multi-batch edges it does not yet exercise. TDD throughout; **three adversarial review
rounds found and fixed five real defects before commit** (a year+YTD double-count, an arbitrary-row
basis pick, an intransitive batch tie-break, an incomplete scoring guard, and unknown-basis pooling).

- **Accounting basis is first-class.** `PeriodMetrics.basis` is surfaced from the import. Benchmark
  cohorts expose `bases`/`mixedBasis` (`benchmarks.ts`). Scoring partitions every percentile-ranked
  sub-score — the NOI/SF quartile **and** the four efficiency sub-scores — by the property's own
  basis (`scores.ts`), so cash / accrual / tax NOI and cost ratios are never silently compared. A
  basis-isolated property (no same-basis peers) falls to neutral, never a cross-basis rank; the
  majority-basis cohort still ranks among itself. `unknown` basis is treated as **non-comparable**
  (isolated, never pooled) — it means the period header didn't parse, not "a basis."
- **One NOI definition, no drift.** `noiMatrix` (queries.ts) and `propertyPeriodMetrics` (metrics.ts)
  both source the NOI income classes from the contract (`NOI_INCOME_CLASSES` / `isNoiIncomeClass` /
  `isOpex`); `warehouse-verify` and a cross-path agreement test pin them equal.
- **Deterministic, no-double-count grouping.** When a full-year and a same-year YTD coexist active
  (same ledger period, different `period_end`), `selectCoherentBatch` resolves to ONE coherent batch
  by a single **total-order** key `[grainRank, endKey, importId]` (transitive — null end = unknown
  scope sorts as most-recent, never demoted below a dated partial). Eliminates the silent NOI
  double-count, the arbitrary-row basis/grain pick, and the order-dependent (intransitive) winner.
- Tests: `warehouse-coherent-batch` (tie-break incl. 3-batch permutation-invariance),
  `warehouse-basis-guard` (benchmark cohort), `warehouse-scores-basis` (partition + over-suppression
  + unknown-isolation regressions), plus metrics basis & coexistence + a `noiMatrix`↔`propertyPeriodMetrics` agreement test.

**Calibration / governance (pending Gabriel, tracked):** the strict partition default neutralizes
benchmark+efficiency signal for `unknown`-basis and basis-isolated properties — the durable fix is
better period-header basis detection at ingest (data-quality), and the partition-vs-neutralize
semantics are a ratifiable scoring-calibration item (see the hurdle-rate/governance + calibration-log
specs). **Deferred next units:** surface `mixedBasis` in the Benchmarks UI (client type + badge); the
A↔B workbook-vs-warehouse NOI reconciliation keystone; materialized metrics/scores/findings tables;
occupancy time-series; FRED-into-engine; governance config; calibration-log scaffold.

## PFI Phase B.3 — intelligence UI design upgrades (2026-06-13)

Five design/UX upgrades to the intel module — answer-first, time-aware, and deep-linkable —
reusing the existing design system with no new dependencies. All new logic is pure and
golden-tested; the views render it.

- **Morning-briefing hero** (`OwnershipView.tsx`, above the fold): a one-sentence portfolio
  verdict (`ownership-intel.portfolioVerdict` — NOI, health posture, # needing attention, #
  disposition candidates), the top-3 actions, a 12-tile attention heat-strip (click → Property
  tab), and a compact capital-allocation summary. The full attention matrix, improving/
  deteriorating, risks and PM snapshot remain below.
- **Answer-first property verdict card** (`PropertyIntelView.tsx`): verdict → **WHY** (a
  synthesized ΔNOI root-cause line naming the largest same-direction driver and its contribution,
  `property-intel.rootCauseLine`) → **DO** (`recommendedAction`). KPI row, trends, expense
  breakdown and the ΔNOI waterfall move below; the duplicated inline headline is removed.
- **Time as a first-class control** (`IntelModule.tsx` + `period-intel.ts`): one module-level
  FY/YTD period selector governs the intelligence tabs' LEVELS/benchmarks, with a persistent
  "YTD (partial)" banner. Scores, the verdict, trends and the ΔNOI bridge stay on the latest
  full year. Benchmarks' local period selector is folded into the shared control.
- **Since-acquisition leaderboard** (`OwnershipView.tsx`, below the fold): properties ranked by
  NOI/SF growth since acquisition (`synthesis.rankBySinceAcqGrowth`); incomparable assets are
  excluded with an "insufficient history" note.
- **Deep-linkable property pages** (`/intel/:propertyId`): an additive `intelPropertyId` route
  field + `openIntelProperty` make a property reference a shareable link and route every intel
  entry point (action chips, heat tiles, benchmark rows, selector) through one URL model.
  Additive and **distinct** from the `/portfolio/:id` global drawer (intel has no
  `MODULE_PRIMARY_TYPE`, so `selected` stays null for `/intel/:id`).

Build hardening (surfaced during this build):
- **Gate self-heal** (`scripts/ensure-deps.mjs`, run as `pregate`): restores `node_modules` from
  the lockfile if it's wiped/partial before the gate runs (a disk-cleanup task removed the whole
  tree mid-session). No-op when deps are present.
- **Resilient brain-server startup** (`server/index.ts`): a failed startup workbook/snapshot load
  no longer prevents the server from binding — it serves in a degraded mode (snapshot 503s
  gracefully, warehouse opens lazily) so `/api/health`, `/api/warehouse/*` and the SPA shell stay
  up. Happy path unchanged.
- **Ownership render smoke test** (`tests/unit/intel-ownership-smoke.test.tsx`): seeds a local
  QueryClient cache (no module mocking — safe under `isolate: false`) to prove the hero/heat-strip/
  leaderboard mount on real-shaped data, including the null-$/SF property.
- **Pattern doc** (`docs/superpowers/patterns/intel-pure-logic-then-view.md`).

## PFI Phase B.2 — Property Financial Intelligence UI (2026-06-13)

The intel module becomes an operating layer over the analytics engine — not another dashboard.

- **Ownership Intelligence Center** (`src/modules/intel/OwnershipView.tsx`, the default tab): a
  portfolio KPI band (count, NOI, Oxford-share NOI, # needing attention, # disposition candidates),
  then **"What Ownership Should Do Next"** — a prioritized action list (`synthesis.buildActionList`)
  leading with disposition candidates + critical anomalies; an attention matrix (red→green); improving
  vs. deteriorating; capital-allocation buckets; largest risks; a PM snapshot. Answers the nine
  ownership questions, action-first.
- **Per-property Intelligence page** (`PropertyIntelView.tsx`): verdict header (health 0–100, band,
  attention, capital action, rationale) → KPI row with sparklines, quartile sublabels, and the Oxford
  ownership overlay (e.g. "Oxford 50%: $183K") → since-acquisition strip → annual trends + expense
  breakdown → **ΔNOI driver waterfall** with a synthesized root-cause headline → anomalies. Null-safe
  (null-SF and single-period properties degrade gracefully).
- **Benchmarks** (`BenchmarksView.tsx`): FY-period + metric selectors (12 keys), avg/median/p25/p75
  summary, quartile-badged rankings, ranking BarList (rows navigate to the property), and the
  NOI-by-property matrix. **Decision-synthesis layer** (`synthesis.ts`) + period/metric helpers are
  pure and golden-tested.
- **Managers** (`ManagersView.tsx`): PM scorecards with the small-sample caveat.
- **ΔNOI Waterfall chart** (`src/charts/Waterfall.tsx`): cumulative driver bridge; total bars stay
  ordered when NOI crosses below zero.
- **IA**: 7 tabs (Ownership · Property · Benchmarks · Managers │ Imports · Data Quality · Mappings),
  intelligence/data-ops grouping; analytics cache invalidation extended so approve/override refreshes
  scores. Intel module remains a lazy 15.7 kB-gzip chunk. Server engine untouched.

## PFI Phase B — Analytics & Intelligence Engine (2026-06-13)

- **Single-source config** (`server/warehouse/intel-config.ts`): `INTEL_CONFIG` holds every threshold,
  score weight, and band cutoff — anomaly thresholds are ratified (expense growth >15%, revenue/NOI/NOI-PSF
  decline >5%); health/attention weights are PROPOSED defaults flagged tunable (not governors), pending
  Gabriel's calibration. Mirrors `src/analytics/conditions.ts` ALERT_THRESHOLDS.
- **Period metrics** (`server/warehouse/metrics.ts`): `propertyPeriodMetrics(db)` — one row per
  (property, period) over ACTIVE ledger rows joined to `property_master`: revenue/opex/NOI, margin,
  expense ratio, opex + revenue category subtotals, $/SF efficiency metrics (100%-basis, null-safe on
  missing SF), and the ownership overlay (`oxfordNoi` = NOI × ownershipPct).
- **Growth** (`server/warehouse/growth.ts`): `growthSeries`, `cagr`, `sinceAcquisition` — period-over-period
  and since-acquisition growth, CAGR, all null off a zero/negative base (no fabricated % off zero).
- **Driver decomposition** (`server/warehouse/drivers.ts`): `noiImpactByCategory` (NOI-signed: revenue
  positive, opex negative) + `decomposeNoiChange(a, b)` — ΔNOI attributed by normalized category,
  per-category deltas summing EXACTLY to ΔNOI, contribution% (null when ΔNOI ≈ 0), ranked by |delta|.
- **Anomaly engine** (`server/warehouse/anomalies.ts`): `detectAnomalies` — per-property consecutive-period
  flags (expense-growth, revenue/NOI/NOI-PSF decline, new-category, category-spike) with severity scaled by
  multiples past threshold (INTEL_CONFIG `severityMultiples`).
- **Benchmarks + PM scorecards** (`server/warehouse/benchmarks.ts`): `quantile` (linear interpolation),
  `benchmarkMetric` (avg/median/p25/p75/n per period+metric), `rankProperties` (desc, quartile,
  stable tie-break), `pmScorecards(db, metrics)` (group by `property_manager`, latest-period averages,
  `smallSample` flag at n<3). Null-safe over empty/all-null inputs.
- **Scores + capital allocation** (`server/warehouse/scores.ts`): `scoreProperties(db, metrics)` — per-property
  health 0–100 + band, attention band cascade, capital action (invest/hold/monitor/
  disposition-candidate) with human reason strings. Computes growth/benchmarks/anomalies internally and is
  deterministic in (db snapshot, metrics).
- **Grain-aware comparison discipline** (spec §9, enforced across growth/anomalies/benchmarks/scores):
  the engine NEVER compares a YTD period against a full-year period (no silent 5-month-vs-12-month signal).
  Growth/anomaly/attention use the latest same-grain transition; benchmarking, rankings, efficiency
  sub-scores, and PM-scorecard levels all operate within a single full-year cohort (each property scored on
  its latest `grainHint='year'` period, ranked only against same-period peers). A `<2`-property ranking
  cohort returns `quartile: null` (neutral 50 sub-score) rather than self-ranking to quartile 1. Without
  this, every property reads a spurious ≈−50% decline once a partial-year YTD pull lands.
- **Analytics API** (`server/warehouse/api.ts`): GET `/api/warehouse/analytics/*` —
  `metrics`, `growth` (per-property growth series + since-acquisition), `drivers/:propertyId?from&to`
  (default earliest→latest, 404 on unknown property), `anomalies`, `benchmarks?period&metric` (defaults
  latest period / noiPerSf, Zod-validated), `scores`, `pm`. Read-only behind the same 503
  `{error:'warehouse unavailable'}` guard as the Phase A routes; pure-function calls on the injected db.
  UI consumption is Phase B.2 (separate plan).

## PFI Phase A.2 — Imports & Data-Quality UI (2026-06-13)

- **Warehouse read queries** (`server/warehouse/queries.ts`): `listImports` (audit trail, joined to
  property names), `getImportDetail` (ledger rows + DQ issues), `listIssues`, `noiMatrix` (byte-for-byte
  the NOI formula the backfill/verify gate uses — UI NOI == gate NOI).
- **Review-queue actions** (`server/warehouse/actions.ts`, all transactional, nothing deleted):
  `approveImport` (re-resolves against current mappings at approve time, refuses while any row is
  unmapped or the import is empty, supersedes prior committed versions), `rejectImport` (status flip,
  rows preserved inactive), `resolveIssue`, `addMappingOverride` (manual override append + active-row
  re-derivation, optionally property-scoped). Amounts never touched — ingest sign-normalization preserved.
- **`/api/warehouse/*` routes** (`server/warehouse/api.ts`, mounted in `server/index.ts`): imports,
  imports/:id, noi, issues; POST action (approve unmapped → 409 with the list), mappings, issues/:id/resolve.
  Zod-validated bodies; integer :id guard; lazy warehouse singleton; 503 `{error:'warehouse unavailable'}`
  on mirror/cold environments — never crashes the server.
- **Property Financial Intelligence module** (`src/modules/intel/`, lazy-loaded, group Assets): Overview
  (KPI tiles + NOI-by-property matrix), Imports (audit DataTable + inline detail panel with approve/reject
  and an inline add-mapping → retry loop on 409), Data Quality (issue resolution), Mappings (manual override
  surface). Graceful "requires the live brain server" state on the static mirror. Separate 6.2 kB-gzip chunk;
  entry bundle unchanged.

## PFI Phase A — Financial Warehouse Foundation (2026-06-12)

- **Warehouse schema** (`server/warehouse/db.ts`): SQLite (better-sqlite3, WAL, FK-enforced),
  idempotent migration — `property_master`, `import_batches`, `account_mappings`,
  `ledger_entries`, `data_quality_issues`.
- **14-unit ratified property master** (`server/warehouse/property-master.ts`): Gabriel-ratified
  canon (2026-06-12) hardcoded as the seed — entity-level FVC unit, fractional ownership
  (Red Branch/Broadway 50%, 1851 S Club Solar 25%), lease-run mode for Sunburst/Fishel,
  residence excluded. Idempotent upsert.
- **Mapping engine** (`server/warehouse/mapping.ts`): loads the 339-account verified seed
  (`docs/superpowers/specs/2026-06-12-pfi-account-mapping-seed.json`); key normalization strips
  GL codes/case/whitespace; section-aware resolution (income vs expense side); precedence
  manual > seed; unmapped falls back to `Unmapped`/`opex` (NOI-conservative) with a data-quality flag.
- **QB-Excel adapter** (`server/warehouse/parse/qb-excel.ts`): parses the verified QuickBooks
  report shape — `Property:` header, period line with cash/accrual basis, section labels,
  GL-coded leaf accounts (subtotal/summary rows skipped), rightmost-numeric values.
- **Immutable raw store + versioning** (`server/warehouse/raw-store.ts`): sha256-named raw byte
  copies (never overwritten), hash dedup, per-(property, period) version numbering.
- **Transactional ingest** (`server/warehouse/ingest.ts`): detect → parse → map → classify →
  ledger insert in one transaction; auto-commit at confidence ≥ 0.85 with zero unmapped accounts,
  else `pending-review` (rows inactive until approved); corrected re-imports supersede prior
  versions (deactivated, never deleted). NOI is re-derived from classifications — owner
  transfers/distributions, debt service, capex, TI, and leasing never in NOI (ratified canon).
- **Backfill CLI** (`scripts/warehouse-backfill.ts`, `npm run warehouse:backfill`): seeds master +
  mappings, ingests the OneDrive `Property Financials` folder (read-only), prints per-file status
  and a per-property/period NOI table. Live-verified against the real 33-file corpus:
  21 committed, 10 pending-review (unmapped summary/CRC accounts), 2 Northwood PDFs
  `needs-adapter`; second run 31/31 duplicate, ledger row count unchanged (811).
  Warehouse data lives under `data/warehouse/` (gitignored).

## Leases — operational rent roll + critical-dates engine (2026-06-03)

- **Critical Dates engine** (`analytics/engine.ts → criticalDates`): derives the actionable lease
  calendar — renewal/termination **notice deadlines** (assumed 90-day window, flagged estimated),
  **expirations** (including overdue holdovers as negative days), and **escalation** effective dates
  — over a 12-month horizon, sorted by urgency. Added to `AnalyticsBundle`; rendered as a new card on
  `/leases` with per-event tone, overdue count, and click-through to the lease drawer.
- **Operational rent roll** (`modules/leases/LeasesModule.tsx`): fuzzy search (fuse.js over
  tenant/company/property/unit) + status / property / expiry-window filters + one-click **CSV export**
  of the filtered set (`lib/export.downloadCsv`), with a live "_n_ of 137" count and filtered-rent total.
- **Fix — rollover horizon no longer drops long-dated rent.** `rolloverSchedule` bucketed only
  `baseYear … baseYear+4` and silently discarded anything later; beyond-horizon expirations now roll
  into a `YYYY+` catch-all (e.g. the 2033 leases that were invisible now appear as `2030+`, $934K).
- Tests: `criticalDates` (sort/horizon/overdue-holdover/past-escalation-drop) + rollover catch-all
  (90 total). Verified live against the baked 137-lease snapshot (filter, export, drill-through).

## Phase 6 (slice 4) — M365 To-Do → Tasks (2026-06-03)

- `server/sources/m365-tasks.ts`: pulls open Microsoft 365 To-Do tasks via Graph
  (`/me/todo/lists` → `/tasks`), maps them to the Task contract (HTML stripped; due date →
  overdue/pending; completed → done), and prepends them to the workbook checklist so they
  surface in the Tasks module. Bounded (10 lists / 50 tasks each / 100 total).
- Graceful — no `GRAPH_TOKEN` (or any Graph error) → `[]`, workbook tasks untouched. Server-only.
- Activation needs a Graph bearer token; delegated tokens are short-lived, so unattended use
  should set `GRAPH_TOKEN` from an app-registration client-credentials flow (noted in source).
- Tests: mapping, overdue detection, completed→done, empty-title drop, graceful-empty (81 total).

## Phase 6 (slice 3) — Document RAG (2026-06-03)

- `server/sources/documents.ts`: indexes a configured `DOCUMENTS_DIR` (PDF via pdf-parse, plus
  .txt/.md), chunks the text, and runs lexical search (fuse.js) returning **cited passages**.
  Graceful — empty index without `DOCUMENTS_DIR`. Server-only (the mirror has no filesystem; never
  bundled into the Worker).
- The agent's `search_documents` tool is injected with the real searcher on the server (an honest
  "no documents indexed" stub on the mirror). New `/api/documents` status endpoint + a Documents
  module (status + indexed list; search via the Ask panel).
- Verified end-to-end: indexed a sample lease, the agent answered the renewal-option question with
  the cited clause (and honestly flagged what the snippet didn't cover). Tests: chunkText +
  searchChunks (77 total). Activates by pointing `DOCUMENTS_DIR` at the lease/PSA/OM folder.

## Phase 6 (slice 2) — Notion deals adapter + daily auto-deploy (2026-06-03)

- **Daily auto-deploy registered.** `register-mirror-task.ps1` (now PS 5.1-compatible) registered the
  "ORA Command Center - Mirror Deploy" Windows task (06:30 ET, runs under pwsh 7). Verified the payload
  end-to-end: bake(confidential)+build+deploy + Access-gate 302 re-check all pass.
- **Notion deals adapter** (`server/sources/notion-deals.ts`): fetches the verified "Acquisition
  Pipeline Tracker" DB and merges live deals onto the seed. Behind the contract + graceful — no
  `NOTION_TOKEN` (or any error) → seed pipeline unchanged. Confidentiality preserved: seed is the
  flag source of truth (matched deals inherit it); secondary guard is env-configured
  (`NOTION_CONFIDENTIAL_NAME_PATTERNS`) so no confidential identifier lives in source; bake redaction
  remains the final guard. `parse.ts` awaits `loadDeals()`. Mapping + merge tested (73 tests total).
  Activates + gets verified when the token is added; fails safe to seed until then.

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
