# IMPLEMENTATION_PLAN.md — Design Parity with `design_handoff_ora_command_center/`

**Produced by:** analyze-and-plan session 2026-07-05 (branch `claude/analyze-plan-prompt-tadmpp`, PR #161)
**Status:** AWAITING GABRIEL'S APPROVAL — no implementation may start before the decision points in §3 are answered.
**Scope:** plan only. No feature code was written in the producing session.

---

## 0. How to use this document (fresh-session preamble)

This plan is self-contained and executable by a session with no memory of the analysis that
produced it. Before executing ANY phase:

1. Read `CLAUDE.md` in full, then `architecture/agent-assignments.md`, `architecture/coding-standards.md`,
   `architecture/system-overview.md`, `architecture/database-schema.md`.
2. Re-verify §1 findings against the live tree — Gabriel commits constantly; anything below can go stale.
3. Follow the governance capsule (§5) for every phase: worktree → STATUS.json claim → gate → PR → squash-merge.
4. The design target is `design_handoff_ora_command_center/` (committed at repo root by PR #161).
   Open `design_handoff_ora_command_center/app/Overview.html` in a browser to explore; the four
   new-capability pages are `Taxes.html`, `Insurance.html`, `Grader.html`, `Brain.html`.
5. The prototype's **shape is the contract; its numbers are fake**. This repo's data is canonical.
   Never port a seeded figure; bind to real entities or specify the ingestion path.

---

## 1. Stage 1 — Verification findings (2026-07-05)

### 1.1 Pre-verified facts: confirmed, with corrections

| Claim (from ANALYZE prompt) | Verdict | Correction / detail |
|---|---|---|
| React 18 + TS strict + Vite + Tailwind v4 CSS-first (`src/tokens/theme.css`) + Hono `127.0.0.1:8911` + better-sqlite3 + Zod contracts + TanStack Query + SSE + visx + lucide | CONFIRMED | `theme.css` = "The Oxford Terminal" tokens; 2 themes (`command` dark / `parchment` light) via `data-theme` on `<html>` |
| "No URL routing — module registry in `src/shell/modules.tsx`" | **PARTLY STALE** | Registry confirmed (22 modules, groups Command/Assets/Capital/Market), but live code DOES use react-router with a `moduleId` route param (`src/shell/AppShell.tsx:44-46`) and URL-driven drawer/scenario state (`src/brain/UiProvider.tsx`). CLAUDE.md §"no URL routing" is stale. |
| 22 modules | CONFIRMED | `src/shell/modules.tsx:63-86`. `architecture/system-overview.md` says 20 (stale); CLAUDE.md §1 says 18 (stale). |
| Two data spines; two independent NOI computations; basis discipline | CONFIRMED | Spine A: workbook (7 tabs, `server/workbook/parse.ts:551-559`) → `PortfolioSnapshot` → overlay → client-side `buildAnalytics()`. Spine B: 32 P&L files → SQLite (25 tables, migrations 001–019) → analytics engines. Cross-spine push: `brain.on('snapshot')` writes occupancy/insurance/debt snapshots into the warehouse (`server/index.ts:86-135`). |
| Migrations 001–019 | CONFIRMED, one defect | **Two files are numbered 017** (`017_market_series_constraints.sql`, `017_ratify_hurdle_rate.sql`). Never renumber applied migrations; **next free number is 020**. |
| Ratified buy box `config/acquisition-ruleset.v1.json` v1.0 | CONFIRMED | Gates $0.5–10M single asset / ≤50K SF / ≥12′ clear / flood kills / named clusters; floors basis-discount 25–30%, YoC ≥8%, levered IRR ≥15%/5yr; 7-category 100-pt scorecard; bands T1 ≥75 / T2 ≥60. **Materially different from the prototype's inferred buy box** ($3–20M, cap ≥7%, IRR ≥14%, EM ≥1.7x, LTV ≤55%, A–F letter grades). |
| Acq engine + OM extraction shipped | CONFIRMED | `scoreAcquisition()` (`server/warehouse/acquisition.ts:154-508`), persistence + governor proxy + calibration verdicts (`acq-engine.ts`), real PDF extraction of 15 fields via claude-haiku-4-5 (`om-extract.ts`, `POST /api/actions/om-extract`), Notion sync, ranked intel route `GET /api/warehouse/acq/intel`. |
| Insurance module = register only | CONFIRMED | Contract is 30 lines (`src/contracts/insurance.ts`); UI is a lean table (`src/modules/insurance/InsuranceModule.tsx`, 62 lines); warehouse persistence (migration 008) + exactly two alert conditions (`insurance-conditions.ts`: expiry-soon ≤60d, coverage-gap). Savings scanner / benchmark rate / self-insure / re-bid logic: **ABSENT** in every form. `coverage_tiv` column exists but is **always written NULL** (`server/warehouse/insurance.ts:49`). |
| Taxes module missing | CONFIRMED | No tax entity anywhere. Only expense-side analytics exist: `taxesPerSf` metric, `taxEfficiency` sub-score, `Taxes` spike category, `taxesGrowth`. No assessments, millage, appeals, filed returns. No workbook tax tab. |
| Calibration = the learning brain | CONFIRMED | Migration 005 tables (verdict/outcome/inputs-version, append-only), `calibrationReport()` (hit rates, Wilson CIs, directional accuracy, treatment-adjusted), advisory-only offline refit (`scripts/calibration-refit.ts`, ±0.05 max move, never writes config). UI: Report/Pending/Log tabs + ResolveDialog. |
| 1739+ tests | STALE (low) | **1905 tests / 179 files** pass locally (verified 2026-07-05, Node 22.22.2). |

### 1.2 New facts that reshape the plan (not in the ANALYZE prompt)

1. **An Insights engine already exists and is UNWIRED.** Phase 2/3 "insights" work merged
   post-baseline (PRs #147/#149/#151/#152/#156): `src/contracts/insights.ts`
   (`InsightCandidate` — family CF/DR/TE/TR/CR, spine A/B/cross, confidence, materialityUsd,
   `advisoryOnly: true`), `server/insights/` (stats with honesty gates; `rankScore = 0.5·novelty +
   0.3·confidence + 0.2·materiality`, top-20 cap; one generator: CF-1 premium-valuation).
   **No server route mounts it and no UI consumes it.** The design's Insights page is the natural
   delivery surface. This converts "build an insights feed" into "wire an existing engine."
2. **A `src/brain/` layer exists but is NOT the design's Brain.** It is client chrome (⌘K
   CommandPalette, ⌘J AiPanel chat, EntityDrawer, DraftPanel) + pure derivation libs, plus
   `server/brain.ts` = the Spine-A runtime engine. The design-Brain's ingredients exist
   *scattered*: track record (calibration ReportView, acquisitions CalibrationSummaryPanel),
   confidence displays (capital/market/acq tiers + Provenance chips), accept/dismiss precedents
   (alert read/snooze server-persisted; acq candidate status PATCH; calibration resolve). Missing:
   a unified surface, accuracy-over-time, derived "learned memory", per-market/manager confidence,
   feedback on recommendations qua recommendations.
3. **`src/modules/capital/CapitalAllocationModule.tsx` (579 lines) is ORPHANED** — zero imports
   anywhere; contains the implied-cap-rate columns, IC-memo export button, Notion sync. The
   mounted module is the newer `CapitalModule.tsx`. Needs an explicit keep/fold/delete decision (D6).
4. **CI is red for every PR since ~2026-06-29, unrelated to any diff.** `.github/workflows/ci.yml`
   floats on `node-version: '24'`; Node **24.18.0** breaks `pdf-parse@1.1.4`'s bundled pdf.js
   (briefing PDF tests fail with `Illegal character: 41` / `bad XRef entry` / empty extracted text).
   Bisected in-session: 24.17.0 → 50/50 pass; 24.18.0 → 8 fail. Local Node 22.22.2 → full suite
   1905/1905 green. Fix = pin `node-version: '24.17.0'` (or `'22'`), or replace `pdf-parse`.
   **Until fixed, "gate green in CI" is impossible for any phase** → P0 blocker (D5).
5. **`architecture/status.json` is syntactically invalid JSON** — the `ic-memo` entry has
   duplicate keys and a missing comma (around lines 300–307); `chore-post-w2-merge` has a duplicate
   `review_detail`. Any tooling that parses STATUS.json will fail. Also `ownership.json` carries
   two stale worktree entries (pfi-phase-b, pfi-phase-b2 — both merged) and Windows paths.
6. **Docs drift:** `system-overview.md` (20 modules, no `warehouse:drift` gate step, "450+ tests",
   Phases 2–5 "not started"), CLAUDE.md §1 ("18 client modules"), CLAUDE.md §6 (gate omits
   `warehouse:drift` — actual gate is 7 steps per `package.json:38`).
7. **Gate nuance for CI:** `npm run gate` includes `reconcile` (needs the local OneDrive workbook)
   and `warehouse:drift` (needs the live DB) — CI runs `gate:ci` (typecheck+lint+test+build+bundle).
   Plan acceptance criteria distinguish "local gate green" from "CI green".
8. **Confidentiality guardrails relevant to Taxes:** `server/sources/documents.ts:64-66` explicitly
   blocks "GDG tax return" / 1031 documents from the RAG index, and `confidential-terms.json` is
   hook-blocked (CLAUDE.md §9). A "Filed Returns archive" (design `Taxes.html` tab 3) collides
   with this boundary → scoped out of v1 (D2).

### 1.3 Design-handoff facts that govern the build

- **Tier-board pattern** (`ora.css:685-721`): `.tiers` (2/3/4-col grid) › `.tier` (colored panel:
  `.t-high/.t-med/.t-low/.t-good/.t-acc/.t-vio`) › `.tier-hd` (dot/name/count) › `.tier-meta`
  ($ total) › `.tier-body` › `.tcard` (rank # · category pill · $ impact gain/risk/info · title ·
  detail · action link). Rule: **never render a long single-column list** (README:98-104).
  Reference boards: Insights, Taxes, Insurance, Grader, Brain.
- **The 4 capability pages** consume: Taxes — assessments/millage/appeals/filed returns + strategy
  engine ranked by $; Insurance — TIV, rate/$100 TIV vs benchmark, deductibles, loss ratios, EAL,
  re-bid pipeline; Grader — 10-criterion weighted buy box with letter grades and deal-breakers
  (**superseded by ruleset v1.0**); Brain — accuracy series, track record, accept/dismiss loop
  (localStorage), confidence-tiered memory, per-market/manager confidence, uncertainties, version log.
- **All prototype figures are seeded PRNG** reconciling to modeled opex lines; the only
  functional write in all four pages is Brain's accept/dismiss → localStorage.
- The prototype's `engine.js` ($-quantified ranked signals) ≈ the repo's `evaluateConditions()`
  insights (which already carry `impactAnnualUsd`) + the unwired `server/insights` engine + capital
  `priorityScore`. The prototype's `trends.js` anomaly spec ≈ `server/warehouse/anomalies.ts`
  (production thresholds already ratified via INTEL_CONFIG).
- `Overview.html` pulls React from a CDN (prototype-only hack); `filter.js`'s global
  market/subtype/manager/as-of slice has **no production counterpart** (Intel has period-only).

---

## 2. Stage 2 — Gap matrix

### 2.1 The 18 design pages

Legend: spine A = workbook snapshot, B = SQLite warehouse.

**Design delta under D1, stated once for all 18 pages** (it is uniform): under options (b)/(c)
every page's delta is *structural only* — build the listed sections/patterns in Oxford Terminal
tokens; under option (a) every page additionally inherits the global retokenization cost
(token remap in `theme.css`, chart `SERIES` palette, Sidebar/TopBar/PDF-briefing re-QA across all
22 existing modules) — no page has a delta that diverges from this global statement, which is why
D1 is a single decision rather than 18.

| # | Design page | Status | Repo anchor (file refs) | Spine | Data readiness | Reuse mapping / notes |
|---|---|---|---|---|---|---|
| 1 | Overview | **Exists (partial)** | `src/modules/overview/` (widget workspace, InsightList w/ $ badges) | A | Ready | Missing: results banner (NOI upside / $ at risk / count) + ranked PRIORITY ACTIONS tier board → P2/P7. "Focus lens" = cut (C7). |
| 2 | Portfolio | **Exists (partial)** | `src/modules/portfolio/` (lean table→drawer); trends/anomalies live in Intel | A(+B) | Ready | Design's trend explorer (metric pills, YoY overlay, same-store) maps to Intel's engines → P7 (extend Intel or Portfolio, not duplicate). |
| 3 | Acquisitions | **Exists (partial)** | `src/modules/acquisitions/` (Workbench, RankedCandidateList T1/T2 table, OmImportDrawer, Notion sync) | A+B | Ready | Missing: kanban stage-board view + grade pill on cards → P3. Tier *table* exists; tier *board* does not. |
| 4 | **Grader** | **Partial (engine yes, UX no)** | `acquisition.ts` scorer, `acq-engine.ts`, `om-extract.ts`, routes `/acquisition/score`, `/acq/*` | B | **Ready — no new data** | P3: Grader surface = om-extract drop zone → `AcquisitionInput` → real score → gauge + gates/floors/subScores + auto-graded pipeline tier board (T1/T2/PASS/KILLED from `acq_scores`). Prototype criteria/letter grades are reference UX only (ruleset v1.0 governs). |
| 5 | Leases | **Exists** | `src/modules/leases/` + `leasing/LeaseForecastModule` (expiry buckets, market-rent gaps, velocity) + `renewals/` | A+B | Ready | Design page ≈ already covered; residual polish → P7. |
| 6 | Financials | **Exists (different shape)** | Intel (statements, budget-vs-actual via Close), `cash/`, `close/`; AR via `tenantArrears` | A+B | Partial (no GL/AP) | **Cut/reconcile (C1)** — design duplicates Intel/Cash/Close; GL & AP have no data source. |
| 7 | **Taxes** | **Missing** | Only expense analytics: `taxesPerSf` (`metrics.ts:138`), `taxEfficiency` (`scores.ts:164`), `taxesGrowth` (`growth.ts`) | B(new)+A | **Needs new data**: assessments, millage, bills, appeals (D2) | P6: migration 020 + assessor-data ingest + appeal-opportunity engine (real math on ledger `Taxes` category + assessments) + strategy tier board. Filed-returns tab & cost-seg deferred (C2, confidentiality + no basis source). |
| 8 | **Insurance** | **Partial (register only)** | Contract `insurance.ts`; module (62-line table); warehouse 008; 2 alert conditions | A+B | **Needs TIV + loss runs** (D3): `coverage_tiv` column exists, never populated | P4: TIV ingest → rate/$100 TIV vs type-cohort book median → re-bid dispersion board + renewal calendar. Self-insure + deductible/limit optimization gated on loss runs + dec-page data (P4c). |
| 9 | Studio | **Missing** | Intel has fixed analytics; no cross-filter explorer | — | Ready (data exists) | **Defer (C3)** — high effort, low decision value vs Intel; revisit post-parity. |
| 10 | Operations | **Missing (no data)** | `tenants/` ledger partial (arrears); work orders/units nowhere | — | **No source** (PM-system exports needed) | **Defer (C4)** until AppFolio/Yardi WO export is available. |
| 11 | Comps | **Partial** | `src/contracts/comps.ts` (SaleComp/RentComp/CompSet + `RECORD_COMPS_TOOL`), deal-comps overlay + drawer refresh; `market/` cap-rate benchmarks | A + macro | Partial (comps captured per-deal via AI tool) | P7: surface CompSet + `CapRateBenchmark` in a comps view; no new ingestion in v1. |
| 12 | Inbox | **Missing (email UX)** | `alerts/` = actionable queue (read/snooze persisted); M365 tasks in snapshot | A | No email-thread source | **Cut (C5)** — Alerts is the production analog; email threading is out of scope. |
| 13 | **Insights** | **Partial (engine unwired)** | `server/insights/` + `src/contracts/insights.ts` complete; NO route, NO UI; Spine-A insights render in Overview `InsightList` | A+B | Ready (needs route + 2nd..nth generators over time) | P2: mount route + Insights tier board (Critical/Priority/Monitor by severity with $ totals) merging `evaluateConditions()` insights (have `impactAnnualUsd`) + `InsightReport`. Flagship "no-long-lists" surface. |
| 14 | News | **Partial** | `market/` (FRED macro incl. 10Y history, state unemployment, MarketScorecard) | macro | Rates ready; briefing/regulation/research have no source | **Partial cut (C6)**: keep rates/market trends parity in Market; skip hand-authored news/regulation/research feeds. |
| 15 | **Brain** | **Partial (pieces exist, no surface)** | Calibration module (track record, Wilson CIs), confidence tiers on capital/market/acq, alert snooze persistence, `calibration_log` + `inputs_version` (version history) | B | Ready for v1 (derived-only memory); feedback needs new persistence (migration 021) | P5 (D4): new thin module composing calibration report + accuracy-over-time (from `calibration_outcome` timestamps) + accept/dismiss on ranked insights + derived memory tiers + per-market/manager confidence (sample-size based) + uncertainties (open DQ issues + dormant generators) + version log (`calibration_log`). No invented accuracy numbers. |
| 16 | Property (detail) | **Exists (different shape)** | Intel PropertyIntelView (verdict→root cause→recommendation, 651 lines) + EntityDrawer + briefing PDF | A+B | Ready | P7 polish: month-end table + anomaly-linked trend explorer exist in Intel; assess whether a dedicated property page adds value or Intel tab suffices. |
| 17 | DealRoom (detail) | **Partial** | DealDrawer + Workbench detail + IC memo (`ic-memo.ts`) | A+B | Ready (DD checklist state has no store) | P7: enrich DealDrawer (stage timeline exists via `stageIdx`; underwriting panel binds to `AcquisitionInput`/score). DD checklist → overlay if wanted (small). |
| 18 | Investor (detail) | **Missing (no data)** | No LP/investor entity anywhere (verified vs contracts + workbook tabs) | — | **No source** (capital accounts, NAV/DPI/TVPI, capital calls) | **Defer (C8)** pending D7 (does Gabriel want LP tracking? source: fund admin/Excel?). |

### 2.2 The 8 prototype engines

(Spine + data readiness per engine are stated inline in the two columns; the D1 design delta is
the global statement above.)

| Engine | Status in repo | Binding target |
|---|---|---|
| `data.js` (canonical entities + monthly history) | **Exists** — `PortfolioSnapshot` (Spine A) + warehouse ledger/period metrics (Spine B) | Bind; never port numbers. `INVESTORS` collection has no counterpart (C8/D7). |
| `trends.js` (trend math + anomaly spec + chart) | **Exists (better)** — `growth.ts`, `anomalies.ts` (ratified INTEL_CONFIG thresholds), visx charts | Design's thresholds are reference only; production thresholds already ratified. |
| `engine.js` (ranked $-quantified signals) | **Partial** — `evaluateConditions()` w/ `impactAnnualUsd` + sort (PR #91/#136 lineage), capital `priorityScore`, unwired `server/insights` rank model | P2 unifies the delivery surface. Portfolio-concentration signal exists (`tenantHHI`, concentration thresholds in `scenario.ts`). |
| `filter.js` (global market/type/PM/as-of slice) | **Missing** | P7 candidate (S): global filter context for Assets-group modules; not load-bearing for the four capabilities. |
| `news.js` (rates + briefing) | **Partial** — FRED macro + regional | C6 partial cut. |
| `tax.js` (tax profiles + strategy engine + returns) | **Missing** | P6 rebuild on real data (assessments + ledger `Taxes` actuals); returns archive out of v1 (C2). |
| `ins.js` (policy economics + savings scanner + self-insure + re-bid) | **Missing (register only)** | P4 rebuild on real policies + TIV; self-insure gated on loss runs (P4b). |
| `grader.js` (buy box + scorer + pipeline grading) | **Exists (better, ratified)** — `scoreAcquisition()` vs ruleset v1.0 + RCT + governors + calibration | P3 = UX only. Letter grades A–F are NOT ratified — display tier/composite/verdict instead (or ratify a display mapping, D8-minor). |

---

## 3. Decision points — ANSWER BEFORE PHASES START

| ID | Decision | Options | Recommendation |
|---|---|---|---|
| **D1** | **Design direction** (blocks P1) | **(a)** Adopt Mission Control (near-black/teal, IBM Plex Sans, 3 themes incl. warm) repo-wide: retokenize `src/tokens/theme.css`, remap chart `SERIES`, re-QA 22 modules + PDF briefings + Sidebar/TopBar. Est: **L** (token remap M + visual QA of every module + brand decision on PDFs). **(b)** Build the new capabilities inside Oxford Terminal tokens unchanged. Est: **S** (zero restyle). **(c)** Hybrid: keep Terminal tokens (navy/gold, EB Garamond/DM Sans/Plex Mono, command/parchment), adopt the handoff's *structural* patterns — tier board, severity→color mapping (via existing `--color-pos/warn/neg/info/accent2`), KPI strips, density — as new primitives; optionally add a third "warm" theme later as a separate S task. Est: **S/M**. | **(c) Hybrid.** The two token systems are structurally parallel (semantic surface/text/accent vars, mono numerals, density toggles, data-theme attribute) — the genuinely new assets are patterns, not palette. Terminal is purpose-built brand ("The Oxford Terminal") shared by PDF briefings; a palette swap buys no capability. Cost delta vs (a): saves ~1 phase of pure restyle + regression QA. **No restyling is planned as committed work unless Gabriel picks (a).** Contingency: every phase below and the verification protocol assume (c); if (a) is chosen, a dedicated retokenization phase must be planned and approved BEFORE P1 and all design-parity acceptance criteria re-baselined — this document does not contain that phase. |
| **D2** | **Tax data source + v1 scope** (blocks P6) | Sources for assessed values/millage: (i) county assessor statements/portal exports per property (public data; OH/MD/IN/WI/MO/KS/TN counties), entered via a seed JSON + importer; (ii) tax bills from the PM/AP files (amounts already flow into Spine B ledger `Taxes` category — actuals are ALREADY real); (iii) tax consultant workbook if one exists. v1 scope: property-tax only (assessments, effective rate, appeal opportunities) vs also cost-seg/entity strategy/filed returns. | **(i)+(ii), property-tax-only v1.** Ledger already holds real tax expense; the only new data v1 needs is assessed value + jurisdiction ratio + millage + appeal status per property-year (one seed file, ~27 rows/yr). Cost-seg needs depreciable-basis/land-allocation sources and filed-returns collide with the confidentiality boundary (§1.2.8) — defer both (C2). |
| **D3** | **Insurance benchmark + TIV source** (blocks P4) | Benchmark: (i) own-book median rate/$100 TIV **cohorted by policy type** (self-contained, provenance `derived` — NOTE: the prototype's version is rigged at median×0.9 (`ins.js:53-54`) precisely so half the book flags; an unrigged median still flags ~half by construction, so copy must say "vs own-book median", never "over market"); (ii) broker benchmark report (real market rate; needs a document + parsing); (iii) external index (none identified). TIV + deductible + limit source: broker SOV / policy dec pages → new workbook columns on `Insurance Renewals` tab (Gabriel data entry) or a seed JSON. | **(i) type-cohorted book median for v1** (property/package policies only; minimum cohort n≥5, below which the benchmark renders "insufficient cohort"), upgrade to broker benchmark when a document exists. TIV via **workbook column** (keeps Insurance single-sourced in Spine A; `coverage_tiv` warehouse column already exists to receive it). Request deductibles/limits in the same SOV ask — deductible-optimization analysis is **deferred to P4c** (needs both dec-page data AND loss runs; migration for the new columns comes with P4c). Loss runs = request from broker now. |
| **D4** | **Brain: new module or extend Calibration?** (blocks P5) | (i) New thin `brain` module (Command group) composing calibration + insights + feedback; Calibration stays the audit-grade ledger UI. (ii) Extend CalibrationModule with 4 more tabs. | **(i) New module.** Calibration is an auditable instrument (append-only ledger, resolve dialog) — burying a consumer-grade meta surface inside it muddies both. The Brain module owns no math; it composes `calibrationReport`, insights ranking, and the new feedback store. Name it distinctly from `src/brain/` chrome (register id `command-brain`, dir `src/modules/command-brain/`) to avoid collision. |
| **D5** | **CI unblock** (blocks EVERYTHING) | (i) Pin `node-version: '24.17.0'` in `.github/workflows/ci.yml` (both jobs); (ii) pin `'22'` (matches the dev container: 22.22.2); (iii) replace `pdf-parse@1.1.4` (unmaintained since 2018) with `pdf-parse@2.x` or `pdfjs-dist` (bigger, touches briefing tests). | **(i) now** (one line, restores the exact environment that was green on 2026-06-23), **(iii) as a scheduled P0-follow-up** since any future Node bump re-breaks. Evidence: bisected in-session — 24.17.0 → 50/50 pass, 24.18.0 → 8 fail, errors identical to CI. **RESOLVED: Gabriel authorized 2026-07-06 ("fix PR #161"); pin applied on PR #161 (`ci.yml`, both jobs). Option (iii) pdf-parse replacement remains a P0 follow-up.** |
| **D6** | **Orphaned `CapitalAllocationModule.tsx`** | (i) Fold its unique pieces into `CapitalModule` and delete the orphan; (ii) mount it as a second capital view; (iii) leave as-is. **Verified 2026-07-05: the orphan is the ONLY renderer of `impliedCapRate`/`capRateGap`/`capRatePercentile` repo-wide** (PR #114 shipped those columns *into this file*; `CapitalModule.tsx` has none) — so option (i) must fold the implied-cap-rate columns TOO, not just the IC-memo/Notion-sync buttons, or the product loses its only implied-cap-rate surface. | **(i) fold + delete** during P2: implied-cap-rate columns + IC-memo button + Notion-sync button all move into the mounted `CapitalModule`; acceptance for 2b.2 asserts all three survive the fold. |
| **D7** | **Investor/LP tracking wanted at all?** | (i) Defer indefinitely (not in any ratified roadmap); (ii) new phase: investor entities + capital accounts (needs fund-admin source). | **(i) defer** — no data source identified; nothing else depends on it. |
| **D8** | *(minor)* Letter grades on Grader | (i) Display ratified outputs only (composite 0–100, T1/T2/PASS/KILLED, verdict strings); (ii) ratify a cosmetic letter-grade mapping. | **(i).** A letter scale implies bands nobody ratified; the scorecard's own bands are the truth. |

---

## 4. The phases

Sequencing note vs the ANALYZE prompt's expected shape: Grader (no new data; engine + extraction
shipped) is pulled AHEAD of Insurance (blocked on TIV/loss-run sourcing, D3) — the data request
for insurance goes out at P0 so documents arrive by P4. Dependency graph:

```
P0 (unblockers, needs D5)
 └─ P1 (tier-board primitives, needs D1)
     ├─ P2 (Insights wiring + tier board; D6 fold)
     │    └─ P5 (Command Brain, needs D4; consumes P2 feed)
     ├─ P3 (Grader UX; independent of P2)
     ├─ P4 (Insurance reasoning, needs D3 data)  [P4c self-insure/deductible when loss runs + dec pages arrive]
     └─ P6 (Taxes, needs P1 + D2 data)
P7 (parity sweep) ← P1–P6 complete (7.1 needs P2's feed; 7.3 needs nothing beyond P1)
```
This graph is canonical; the §7 table's "Depends on" column mirrors it exactly.

Each phase = one worktree = one PR (stacked only where noted), squash-merged, local gate green at
every commit (`npm run gate`), CI green (post-D5). Estimates: S ≤ ½ day, M ≈ 1–2 days, L ≈ 3–5 days
of focused agent work.

---

### Phase 0 — Unblockers & housekeeping (est: S, PR: `fix/cc-p0-unblockers`)

Goal: make "gate green at every commit" true again and remove landmines. **No feature code.**

| # | Task | Files (owner) | Acceptance | Est |
|---|---|---|---|---|
| 0.1 | ~~Pin CI Node per D5(i)~~ **DONE on PR #161** (Gabriel-authorized 2026-07-06) — remaining P0 piece: schedule the pdf-parse replacement (D5 option iii) | `.github/workflows/ci.yml` | PR CI `gate` job green on a docs-only commit; briefing PDF tests pass on CI | S |
| 0.2 | Repair `architecture/status.json` (invalid JSON: `ic-memo` duplicate keys + missing comma ~L300; `chore-post-w2-merge` dup `review_detail`; normalize `m6-leasing-risk-ic-memo` status `complete`→`merged`) | `architecture/status.json` (**Architect-owned** → review_needed=true first) | `node -e "JSON.parse(fs.readFileSync('architecture/status.json'))"` exits 0; no semantic history lost (keep the merged-state values) | S |
| 0.3 | Refresh stale governance docs: CLAUDE.md §1 module count ("18 client modules", CLAUDE.md:33) + §2 build state + §6 gate steps (+`warehouse:drift`); system-overview.md module list (20→22)/test count ("450+")/roadmap ("not started" phases)/the "no URL-driven views" invariant (system-overview.md:105 — live code routes `moduleId` via react-router, `src/shell/AppShell.tsx:44-46`). NOTE: the "no URL routing" claim does NOT appear in CLAUDE.md — do not hunt for it there; it lives in system-overview.md and the handoff prompt. | `CLAUDE.md`, `architecture/system-overview.md` (**Architect-owned** → review_needed) | governance gate passes; counts match live tree (22 modules, 1905 tests) | S |
| 0.4 | Remove stale `ownership.json` worktree entries (pfi-phase-b/-b2 merged) | `architecture/ownership.json` (**Architect-owned** → review_needed) | JSON valid; only live worktrees listed | S |
| 0.5 | Send data requests (no code): broker → SOV/TIV per policy + 3-yr loss runs (D3); assessor data collection begun per D2 | — (Gabriel action item) | Documents received before P4/P6 start | — |
| 0.6 | Document migration-numbering defect (two 017s) in `architecture/database-schema.md`; establish **next = 020** | `architecture/database-schema.md` (**Architect-owned** → review_needed) | Schema doc lists both 017s. NOTE (verified 2026-07-05): `migrate.ts:41-45` sorts by parsed number only — the two 017s tie and fall back to `readdirSync` order, which is filesystem-dependent. They touch different tables (`market_series` index vs `capital_config` UPDATE) so relative order is harmless today, but the doc must state this and forbid future duplicate numbers. Also note `017_ratify_hurdle_rate.sql` contains DML (UPDATE), contradicting the "pure DDL" standard — record as an accepted exception, do not retro-edit. Propose (Architect decision) a `migrate.ts` guard that hard-fails on duplicate numeric prefixes so this class can't recur silently. | S |
| 0.7 | Ownership-map extension (folds into the same review_needed claim as 0.2–0.4): assign owners in `agent-assignments.md` + `ownership.json` for files no role currently owns — `server/warehouse/api.ts` (propose: Analytics Agent for route additions; it is already refute-DELIVERY_ONLY), `server/insights/` (propose: Analytics Agent), the planned new engine files (`insurance-analysis.ts`, `tax-analysis.ts`, `brain-report.ts` → Analytics), `server/warehouse/insurance.ts` (Integration, matching its Track-C history); define or replace the undefined "Core" owner of `src/data/` (agent-assignments.md:106 references a role that exists nowhere). Record in the plan-approval note that **Gabriel's approval of this plan constitutes the Lead-Architect authorization for the specific new API routes and new registry modules named in P2–P6** (agent-assignments.md:15 gives the Architect final authority over both) — each phase's STATUS.json claim must still name its routes/modules explicitly. | `architecture/agent-assignments.md`, `architecture/ownership.json` (**Architect-owned** → review_needed) | every file touched by P1–P7 resolves to exactly one owner; no undefined roles remain | S |

Failure-proofing: every file here is Architect-owned or -adjacent — this phase is **executed or
explicitly acknowledged by Gabriel** (single review_needed claim covering 0.2–0.4/0.6). Risk: status.json
repair loses history → mitigation: keep both narratives in one merged entry; rollback: `git revert`.
Refute: not applicable (no financial code) — commit trailer `Refute-Skip: docs/config only`.

---

### Phase 1 — Tier-board + design primitives (est: M, PR: `feat/cc-p1-tierboard`, needs D1)

Goal: the reusable "no long single-column lists" machinery, in Oxford Terminal tokens (per D1(c)).

| # | Task | Files (owner) | Design ref | Data binding | Acceptance | Est |
|---|---|---|---|---|---|---|
| 1.1 | `TierBoard` primitive: `<TierBoard tiers={[{key,title,subtitle,tone,totalUsd,items}]}>` with tones mapped to existing semantic colors (neg/warn/info/pos/accent/accent2); responsive 1-col ≤920px; `.tier-empty` state | `src/primitives/TierBoard.tsx` (+`TierBoard.test.tsx`) (UX Agent) | `ora.css:685-721`, README:98-104; boards on Insights/Taxes/Insurance/Grader/Brain.html | Generic `TierItem {rank, category, impactUsd, impactKind: gain\|risk\|info, title, detail, action{label,onPress\|href}}` | Storybook-less: unit tests for tier grouping/ordering/empty; renders 2/3/4-col; axe-clean; visual check vs `Insights.html` structure | M |
| 1.2 | `RankChip`, `CategoryPill`, `ImpactFigure` micro-primitives (or internal to TierBoard — prefer internal until a second consumer needs them) | same file (UX Agent) | `.tc-rank/.catpill/.tc-imp` | — | covered by 1.1 tests | S |
| 1.3 | `GaugeRing` primitive (SVG ring, animated stroke-dashoffset, reduced-motion aware) for P3 | `src/primitives/GaugeRing.tsx` (UX Agent) | `.gradebox/.gauge` (`ora.css:735-777`) | value 0–100 + tone | unit test: dashoffset math; reduced-motion renders static | S |
| 1.4 | First consumer to prove the pattern: Alerts module severity tiers (critical/warning/info) with $ totals from `impactAnnualUsd` | `src/modules/alerts/AlertsModule.tsx` (UX Agent) | `Insights.html:131-155` | existing `Insight` objects from `@analytics` (`src/data/alerts.ts` merge) | Alerts renders 3 tier columns w/ counts + $ totals; read/snooze still works; existing alert tests pass | S/M |

Failure-proofing: pure UI, no financial math → `Refute-Skip: display-only primitives, no financial
computation`. Risk: pattern doesn't fit DataTable-heavy modules → mitigation: TierBoard is additive;
no module is forced onto it in P1. Rollback: revert the PR; no schema/contract changes. Tests: adds
component tests (`tests/unit/*.test.tsx` — UX-owned); zero regressions in the 1905 suite. No migrations.

---

### Phase 2 — Insights: wire the engine + flagship board (est: M/L, PR: `feat/cc-p2-insights`, stacked: 2a → 2b)

Goal: the design's Insights page on the real engines; fold the capital orphan (D6).

**PR 2a (route)** — mount the existing insight engine:

| # | Task | Files (owner) | Data binding | Acceptance | Est |
|---|---|---|---|---|---|
| 2a.1 | `GET /api/warehouse/insights` route: build `CapitalAllocationReport` → run generators (`generateCfHurdleDrag`) → `rankCandidates` → `InsightReportSchema` envelope + `dataReadiness` | `server/warehouse/api.ts` (Analytics Agent; DELIVERY_ONLY allowlisted file) | `server/insights/{rank,stats,generators/*}`, contract `src/contracts/insights.ts` | route returns Zod-valid `InsightReport`; 503 pattern when warehouse absent; unit tests incl. empty-candidates | M |
| 2a.2 | Register ALL non-CF families (DR/TE/TR/CR) as dormant `dataReadiness` entries with their real status (`dormant-low-n`/`dormant-no-outcomes`) — **no new generator math in P2** (each future generator is its own task with a spec'd formula, data source, and a mandatory refute pass; do not fold that lift into this phase) | `server/insights/` route composition only (Analytics Agent) | — | dataReadiness lists every family in the contract enum with an honest status; zero new generators shipped | S |

**PR 2b (UI, stacked on 2a)**:

| # | Task | Files (owner) | Design ref | Data binding | Acceptance | Est |
|---|---|---|---|---|---|---|
| 2b.1 | `InsightsModule` (register id `insights`, group Command): results banner + category filter pills + **TierBoard** Critical/Priority/Monitor. Merge layer lives in `src/modules/insights/insights.logic.ts` (UX-owned, pure client merge of the two fetched payloads — NOT in `src/data/`). **Join spec** (Spine-A `Insight` has no propertyId/family): map `Insight.entityType/entityId` → propertyId via snapshot lookup (loan→property via `collateralProperty`; lease→property via `propertyId`), and use an explicit `category`↔`family` correspondence table defined in the logic file; dedup key = (resolvedPropertyId ?? entityId, family-or-category); precedence: **warehouse candidate wins** (richer provenance), Spine-A insight is dropped and counted in a "superseded" debug tally | `src/modules/insights/` + `src/shell/modules.tsx` (UX Agent) | `Insights.html:1-170` | tier-meta shows **per-spine subtotals** (Spine-A $ and Spine-B/cross $ never silently summed — mixed-basis rule); unit test asserts per-spine sums and the dedup precedence; advisoryOnly always chipped; ranking weights chipped **"proposed ranking weights (unratified)"** until Gabriel ratifies INSIGHT_CONFIG (see failure-proofing); cards without impact render "—"; parity walkthrough vs `Insights.html` | M |
| 2b.2 | D6 fold: move **implied-cap-rate columns (impliedCapRate/capRateGap/capRatePercentile) + IC-memo export + Notion-sync buttons** onto `CapitalModule`; then delete `CapitalAllocationModule.tsx` (it is the ONLY renderer of those columns — verified) | `src/modules/capital/` (UX Agent) | — | all three capabilities reachable from mounted UI (columns render, `/capital-allocation/ic-memo` + `/sync-notion` fire); orphan gone; grep confirms zero imports and zero lost renderers | S/M |

Failure-proofing: 2a.1/2a.2 are route/registration only (`Refute-Skip` per allowlist; NO new
generator math is permitted in this phase — any generator is a separate task with its own
mandatory refute pass). Risks: (1) double-counting a signal present on both sides → the 2b.1 join
spec + precedence rule, unit-tested; (2) basis mixing — per-spine subtotals only, never a single
unlabeled sum (Phase-1a discipline). Rollback: revert 2b then 2a (stacked order). No migrations.
**Ratification note:** `server/insights/rank.ts:58-62` marks the 0.5/0.3/0.2 weights + top-20 cap
as PROPOSED — "ratification of these values is a RED (human event)". Promoting the engine to a
flagship surface is exactly when that event is due: either Gabriel ratifies the weights at P2
review, or the board ships with the "proposed ranking weights (unratified)" chip until he does.
Changing the weight VALUES remains out of scope for the implementing agent either way.

---

### Phase 3 — Grader UX over the ratified engine (est: L, PR: `feat/cc-p3-grader`, needs P1)

Goal: design `Grader.html` as a surface over `om-extract` + `scoreAcquisition` + `acq_scores`.
**The ratified ruleset v1.0 IS the buy box. Zero engine/ruleset changes in this phase.**

| # | Task | Files (owner) | Design ref | Data binding | Acceptance | Est |
|---|---|---|---|---|---|---|
| 3.1 | Grader view inside Acquisitions module (new tab "Grader"; NOT a new engine): drop zone → `POST /api/actions/om-extract` (real extraction, 15 fields) → editable `AcquisitionInput` form (manual-entry path = same form) → score | `src/modules/acquisitions/GraderView.tsx` (UX Agent) | `Grader.html:37-57` drop/extract/manual | `om-extract-fields.json` 15 fields → `AcquisitionInput` (`src/contracts/acquisition.ts:188`); staggered field-reveal animation is honest (fields arrive from one response; animate presentation only) | extraction failure surfaces 422/5xx states; no simulated values ever rendered | M |
| 3.2 | Scorecard panel: `GaugeRing` (composite 0–100) + verdict/tier + gates checklist + floors checklist (incl. `floorIndeterminate`) + 4 subScores bars (basis/asset/market/risk) + reasons + dataQuality + `advisoryOnly`/`cappedAtT2` chips | same (UX Agent) | `Grader.html:60-72`, `.critrow` | `AcquisitionScore` from `POST /api/warehouse/acquisition/score` (ad-hoc) or `POST /acq/score/:candidateId` (persisting) | fixture test: hand-scored input renders exactly the engine's numbers; KILLED renders kill reason; D8: **no letter grades** | M |
| 3.3 | Buy-box reference panel rendering ruleset v1.0 verbatim (gates/floors/7 categories/bands) + ratification metadata; **read-only** (prototype's "EDITABLE" chip dropped — ruleset changes require new version + ratification + refute, per the file's own header) | same (UX Agent) | `Grader.html:76-83` | `config/acquisition-ruleset.v1.json` (served or bundled read-only) | panel matches JSON; states "v1.0 · ratified 2026-06-14"; no edit affordance | S |
| 3.4 | Pipeline tier board: all `acq_candidates` + latest scores → TierBoard tiers **T1 Pursue / T2 Watch / Pass / Killed** (ratified bands, not the prototype's ≥80/66 bands) | same (UX Agent) | `Grader.html:85-90` | `GET /api/warehouse/acq/intel` (`RankedCandidate[]`) | tier membership matches `acq_scores.tier`; card links open Workbench detail | M |
| 3.5 | Kanban stage view on Acquisitions (Sourced→…→Closing) with tier badge per card (design page 3 parity) | `src/modules/acquisitions/` (UX Agent) | `Acquisitions.html:52-75` | `Deal.stage` (Spine A) + candidate tier where scored | stages match `DealStage` enum; drag-to-stage OPTIONAL (writes exist: `POST /api/actions/deal-stage`) — if included, optimistic update + revert on error | M |

Failure-proofing: no financial math changes → `Refute-Skip: UI over existing acq engine; no
scoring change` (verify by diff: `server/warehouse/**` untouched except none). Risks: (1) UI
re-implements scoring for display → PROHIBITED; always render engine output; (2) tempting "quick
ruleset tweak" → any gate/floor/weight/band change is a NEW ruleset version + Gabriel ratification
+ refute (ruleset JSON header, `config/acquisition-ruleset.v1.json:2`); (3) om-extract cost/latency
→ show progress, allow manual entry fallback. Rollback: revert PR (UI-only). Tests: component tests
for gauge/checklists/tiers + fixture-based parity test; e2e (playwright) happy path: **mock the
extraction — `page.route('/api/actions/om-extract', …)` fulfilled with a fixture response** (the
real route calls a live LLM: nondeterministic, costs money, needs a key CI doesn't have; note
`tests/e2e/` currently has no route-mocking precedent — this introduces it), then fields → score →
scorecard visible; the live-extraction path is verified manually, not in CI. No migrations. No
ratification.

---

### Phase 4 — Insurance reasoning layer (est: L, PR: `feat/cc-p4-insurance` stacked 4a → 4b-UI; P4c later; needs P1 + D3 data)

Goal: design `Insurance.html` on real policies: benchmark, savings scanner, renewal calendar.

**PR 4a (data + engine):**

| # | Task | Files (owner) | Data binding | Acceptance | Est |
|---|---|---|---|---|---|
| 4a.1 | TIV ingestion per D3: Gabriel adds TIV column to workbook `Insurance Renewals` tab → parser reads it → `InsurancePolicy.tiv` (contract change, **Architect-owned `src/contracts/insurance.ts` → review_needed**) → `captureInsurance` writes existing `coverage_tiv` column | `server/workbook/parse.ts` (Integration), `src/contracts/insurance.ts` (**Architect**), `server/warehouse/insurance.ts` (Integration) | workbook col → Zod → warehouse | policies round-trip TIV; missing TIV → null + DQ flag (never invented); reconcile step still $0 | M |
| 4a.2 | Insurance analysis engine (NEW, pure fn): per-policy `ratePer100Tiv = premium/tiv*100`; **type-cohorted book-median benchmark** (property/package cohort only, min cohort n≥5 else "insufficient cohort"; provenance `derived`; copy says "vs own-book median", never "over market" — an own-book median flags ~half the book by construction and the UI must say so); scanner outputs: (a) re-bid candidates where `excessPremium = (policyRate − cohortMedianRate) × tiv > 0`, displayed as **"premium above book median" (dispersion, NOT a savings promise — no haircut factors, no invented capture rates; actual savings claims wait for real quotes in P4c)**, (b) renewal calendar 0/45/90-day buckets. Deductible/limit review is **deferred to P4c** (no deductible/limit data exists in contract or warehouse; D3's SOV ask requests it; new columns need a P4c migration) | `server/warehouse/insurance-analysis.ts` (Analytics Agent, NEW file — owner assigned in 0.7), config constants in-file (documented, advisory) | `property_insurance_policies` rows (real premiums + new TIV) | null-TIV policies excluded from rate math but listed; benchmark = documented type-cohort median; every $ = pure arithmetic on stored values (test: excessPremium reproducible by hand from the rows); unit tests: empty book, single policy, all-null TIV, sub-minimum cohort | M |
| 4a.3 | Route `GET /api/warehouse/insurance/analysis` (Zod envelope — new contract file `src/contracts/insurance-analysis.ts`, **Architect → review_needed**) | `server/warehouse/api.ts` (Analytics, delivery-only) | engine output | Zod-valid; 503 pattern | S |
| 4a.4 | Calibration hook: log advisory verdicts for re-bid recommendations (predicted excess-premium band) so outcomes are resolvable later — reuse `logVerdicts`. **PREREQUISITE (verified): `VerdictKind`/`VerdictEngine` are CLOSED Zod enums (`src/contracts/warehouse.ts:124-134`) and `logVerdicts` re-validates fail-open (`calibration.ts:363-387`) — an unknown kind is silently dropped with `{written:0}`.** So this task REQUIRES extending both enums with `insurance-rebid` (contract = **Architect-owned → review_needed**, planned here explicitly, not discovered mid-phase). The auto-resolution switch (`calibration.ts:496`) gets NO arm for the new kind in v1 — these verdicts are **manually resolved** via the existing ResolveDialog; state that in the module. Touching `calibration.ts` = non-delivery warehouse file → refute trailer required | `src/contracts/warehouse.ts` (**Architect → review_needed**), `insurance-analysis.ts` (Analytics) | `calibration_verdict` (existing table) | verdict rows actually appear (test asserts written>0 against a seeded db, NOT just "no throw" — fail-open would mask a silent no-op); kind `insurance-rebid` parses | S/M |

**PR 4b (UI, stacked):** Insurance module rebuild — 4 KPIs (annual premium real Σ, rate/$100 TIV
vs type-cohort book median, **"premium above book median" Σ** (not "identified savings"), renewals
≤90d), tabs: **Savings Board** (TierBoard: Re-bid candidates / Renewal watch — the Optimize tier
arrives with P4c data), **Policy Register** (DataTable + renewal countdown bars `.renewbar`
pattern), calendar panel. Files: `src/modules/insurance/` (UX). Acceptance: premium KPI ties to
workbook Σ (±$0); each card shows its formula via Provenance; design-parity walkthrough vs
`Insurance.html` tabs 1–2 (tab-3 parity deferred to P4c). Est: M.

**P4c (self-insure + deductible optimization + re-bid pipeline) — SEPARATE, gated on loss runs +
dec-page data (D3):** one migration (**NNN = next free number at execution time — verify with
`ls server/warehouse/migrations/`; do NOT assume 021**) covering `insurance_loss_events`
(property_id FK, policy ref, loss_date, cause, gross_incurred, paid, reserve, source,
UNIQUE per occurrence) + deductible/limit columns for `property_insurance_policies`; contract
extension (**Architect → review_needed**); EAL from real loss runs; deductible-vs-loss-ratio
review; self-insure split-bar analysis (`Insurance.html` tab 3); re-bid workflow state (v1
derive-only, state tracking only if Gabriel asks). DO NOT fake EAL from premium heuristics — the
prototype's `1.6×EAL risk load / 62% transfer share` constants are placeholders and must not ship
without a ratified basis.

Failure-proofing: 4a.2/4a.4 are financial-decision code → **mandatory adversarial refute** +
`Refute-Reviewed:` trailer. Ratification: savings thresholds ship as advisory-only config with the
banner pattern (like hurdle-rate pre-ratification); promoting to firm policy = Gabriel ratification.
Risks: (1) TIV data quality → DQ flags + null-safe math; (2) benchmark misread as market rate →
label "book median (derived)" everywhere; (3) basis: premiums are full-policy while properties are
Oxford-share — decide and document one basis (recommend full-policy, consistent with the register)
and never mix into NOI math. Rollback: 4b revert leaves engine dormant; 4a revert = migration-free
(TIV column pre-exists). Tests: engine unit suite + module tests; e2e: register renders real count
(~24 active).

---

### Phase 5 — Command Brain (est: L, PR: `feat/cc-p5-brain`, needs D4=new module, P2 feed; stacked 5a → 5b)

Goal: design `Brain.html` as an honest meta-surface. **Rule: no invented accuracy, memory, or
confidence — every figure derives from calibration/insights/DQ data or is absent.**

**PR 5a (data):**

| # | Task | Files (owner) | Data binding | Acceptance | Est |
|---|---|---|---|---|---|
| 5a.1 | Migration **`NNN_recommendation_feedback.sql` — NNN = next free number, verified with `ls server/warehouse/migrations/` at execution time (P4c/P5/P6 all take next-free; never assume a number)**: `recommendation_feedback` (id, subject_kind insight/alert/allocation, subject_id, decision accept/dismiss, decided_at, note NULL) append-only | `server/warehouse/migrations/` (**Architect → review_needed**) + `scripts/warehouse-verify.ts` (**Integration Agent** — the assertion edit crosses ownership; claim it) | — | migration applies on `:memory:`; warehouse-verify §assertion added | S |
| 5a.2 | Feedback routes `POST /api/warehouse/brain/feedback`, `GET /api/warehouse/brain/report` — report composes: `calibrationReport()` (existing), accuracy-over-time series (bucket `calibration_outcome` by resolution month → rolling hit-rate), confidence-by-market/PM (sample-size-based from benchmarks/pm scorecards — label "coverage-based confidence", NOT predictive skill), uncertainties (open `data_quality_issues` + `dataReadiness` dormant generators + `floorIndeterminate` acq scores), version log (`calibration_log` + `calibration_inputs_version`) | `server/warehouse/brain-report.ts` (Analytics, NEW), route in `api.ts`; contract `src/contracts/brain-report.ts` (**Architect → review_needed**) | all-existing tables + P2 insights | rolling hit-rate matches hand-computed fixture; months with n<5 render as gaps not zeros (honesty gate, reuse `stats.ts` MIN_PAIRS ethos) | M |

**PR 5b (UI, stacked):** `src/modules/command-brain/` (register `command-brain`, Command group):
KPI row (flag accuracy = calibration overall hit-rate + CI; signals watched = live insight count;
outcomes resolved; recalibrations = **`COUNT(DISTINCT config_hash) − 1` over
`calibration_inputs_version`, or rows in the migration-003 `calibration_log` parameter audit —
NOT the raw inputs_version count, which forks on every P&L import/code version and would be
theatrical inflation**), accuracy sparkline, Track Record list (resolved verdicts w/
**hit / miss / not-scoreable — `calibration_outcome.hit` is 1/0/null; there is NO "partial" state
in the schema (that's the prototype's fabricated vocabulary); if a partial notion is wanted,
define it as a documented derivation from `abs_error` bands, never a free-floating third value**
+ realized values), **Feedback Loop** (top-5 ranked insights
from P2 with Accept/Dismiss → POST, persisted server-side — the design's localStorage becomes real),
**Learned-memory TierBoard** (Settled/Forming/Hypotheses derived from per-kind calibration n + CI
width; each card cites its data), confidence-by-market/manager bars, Open Questions, version log.
Files: UX Agent. Acceptance: with an empty feedback table everything still renders (calibration
empty-state precedent, `ReportView.tsx:14-30`); accept/dismiss round-trips and survives reload;
dismissed insights drop from the default Brain lens but NOT from Insights/Alerts (no silent
suppression of risk — explicit "dismissed (n)" reveal). Est: L.

Failure-proofing: 5a.2 accuracy math = analytics over calibration data → **adversarial refute
required**. The feedback → ranking loop is v2 (any weight adaptation from dismissals = INTEL/INSIGHT
config change = ratification); v1 feedback is display-state only — document this in the module.
Risks: (1) theatrical accuracy (prototype ramps accuracy from click counts — explicitly do NOT
reproduce); (2) survivorship in track record → show all resolved verdicts, not curated wins;
(3) collision with `src/brain/` naming → module dir `command-brain`. Rollback: 5b revert; 5a
migration stays (empty table harmless). Ratification: none for v1.

---

### Phase 6 — Taxes module (est: L, PR: `feat/cc-p6-taxes` stacked 6a → 6b, needs P1 + D2 data)

Goal: design `Taxes.html` v1 = property-tax intelligence on real data. Filed returns + cost-seg
excluded (C2).

**PR 6a (data + engine):**

| # | Task | Files (owner) | Data binding | Acceptance | Est |
|---|---|---|---|---|---|
| 6a.1 | Migration **`NNN_property_tax.sql` — NNN = next free number verified at execution (see 5a.1 note)**: `property_tax_assessments` (property_id FK, tax_year, jurisdiction, assessed_value, assessment_ratio NULL, millage_rate NULL, annual_tax_billed NULL, source, UNIQUE(property_id, tax_year)) + `tax_appeals` (id, property_id, tax_year, status CHECK draft/filed/hearing/won/lost/withdrawn, filed_date NULL, est_savings_annual NULL, realized_savings_annual NULL, notes NULL) | `server/warehouse/migrations/` (**Architect → review_needed**) + `scripts/warehouse-verify.ts` (**Integration Agent** — assertion edit, claim it) | — | applies on `:memory:`; DDL-only; warehouse-verify assertion | S |
| 6a.2 | Assessment seed importer: `scripts/import-assessments.ts` reading a checked-in-per-run JSON/CSV (assessor data per D2; ~27 rows/yr) with per-row provenance; DQ issue on unknown property id | `scripts/` (Integration Agent) | assessor documents → table | idempotent (INSERT OR REPLACE on UNIQUE); rejects negative values; sample fixture test | M |
| 6a.3 | Tax analysis engine (pure): effective rate = billed/assessed; assessed-implied value vs Spine-A `estValue100` (**basis note: assessments are full-asset — compare to full-asset value = `oxfordValue/oxfordOwnPct` or property `estValue100` documented as full-asset; NEVER mix Oxford-share and full-asset in one ratio**); appeal-opportunity flag when assessed value > indicated value by threshold AND `taxesPerSf` sits above cohort percentile (reuse `benchmarks.ts` cohort machinery); est. savings = excess assessment × millage (nulls → indeterminate, never guessed). **Ownership basis (verified): ledger `Taxes`, assessments, and millage are all FULL-ASSET (`metrics.ts:138-142` proves the ledger is 100%-basis) while Spine-A property economics are Oxford-share — so the engine emits BOTH `savingsFullAsset` and `savingsOxfordShare = savingsFullAsset × oxfordOwnPct`; every cross-module ranked surface (strategy board, P7.1 Overview actions) uses the Oxford-share figure; the full-asset figure appears only in the assessments table with an explicit basis label** | `server/warehouse/tax-analysis.ts` (Analytics, NEW — owner per 0.7) + contract `src/contracts/tax.ts` (**Architect → review_needed**) | new tables + ledger `Taxes` category + Spine-A values | fixture: hand-computed appeal savings match on a partially-owned property (both bases asserted); missing millage → "indeterminate" not $0; cohort percentile matches benchmarks engine | L |
| 6a.4 | Route `GET /api/warehouse/tax/analysis` + calibration verdicts for appeal recommendations (kind `tax-appeal`, resolvable when appeal outcome recorded). **Same closed-enum prerequisite as 4a.4: extend `VerdictKind`/`VerdictEngine` in `src/contracts/warehouse.ts` (Architect → review_needed) or the fail-open `logVerdicts` silently writes nothing; new kind is manually resolved (no auto-resolution arm in v1)** | `src/contracts/warehouse.ts` (**Architect → review_needed**), `api.ts` (delivery) + engine (Analytics) | `calibration_verdict` | Zod-valid; test asserts written>0 on seeded db (not just "no throw") | S/M |
| 6a.5 | Appeal status writes: `POST /api/warehouse/tax/appeals` (create/update status) | `api.ts` (delivery) | `tax_appeals` | status transitions validated by CHECK + Zod; append audit note | S |

**PR 6b (UI, stacked):** `src/modules/taxes/` (register `taxes`, Capital group): 4 KPIs (annual
property tax = ledger `Taxes` Σ real; effective rate where assessed exists; identified opportunity Σ;
appeals in flight), tabs: **Strategy Board** (TierBoard: Appeals / Assessment watch / Deferred-scope
placeholder that states what data would unlock cost-seg — honest gap surfacing per the brief),
**Assessments & Appeals** (DataTable assessed-vs-indicated + appeal drawer with status writes).
Acceptance: KPI ties to Spine-B ledger Σ for the year (±$0 vs Intel's taxes figure — same source);
every opportunity card shows formula + provenance; parity walkthrough vs `Taxes.html` tabs 1–2.
Est: M.

Failure-proofing: 6a.3 is financial-decision code → **mandatory adversarial refute** (lenses:
correctness, edges, basis-mixing). Ratification: appeal thresholds ship advisory-only; the
"file an appeal" recommendation never auto-executes. Risks: (1) assessment data entry errors →
importer validation + DQ; (2) jurisdiction heterogeneity (7 states) → per-row jurisdiction +
nullable ratio/millage, indeterminate over guessed; (3) double counting with `taxEfficiency`
score → Taxes module cites the same `taxesPerSf` benchmarks rather than re-deriving. Rollback:
6b revert; 6a migration additive-only. Tests: engine suite + importer fixture + module tests.

---

### Phase 7 — Remaining parity + reconciliation sweep (est: M, PR: `feat/cc-p7-parity`, needs P1–P6)

| # | Task | Files (owner) | Design ref | Data binding | Acceptance | Est |
|---|---|---|---|---|---|---|
| 7.1 | Overview results banner + PRIORITY ACTIONS via TierBoard (reuses P2 feed) | `src/modules/overview/` (UX Agent) | `Overview.html` `#resultsBar`/`#priorityList` | P2 merged feed (per-spine subtotals, Oxford-share $ for tax items per 6a.3) | banner sums match Insights module for the same filter; per-spine labels present; existing widget tests pass | S |
| 7.2 | Global portfolio filter (market/type/PM; as-of only where a module has time-dimensioned data) as a shell-level React context — production analog of `filter.js`. **Ownership caveat: agent-assignments.md:106 marks `src/data/` "read-only — belongs to Core" and no "Core" role exists — 0.7 must resolve this BEFORE 7.2 starts.** v1 filters client-side over already-fetched data (no query-key changes → `src/data/` untouched); if as-of slicing requires refetch plumbing, that sub-slice needs the resolved owner + a refute pass on any figure whose period basis changes | `src/shell/` + consuming modules (UX Agent); `src/data/` only per 0.7 resolution | `filter.js`, `.gfbar` | snapshot entities filtered by market/type/PM | filter state persists per session; each consuming module's KPIs recompute on slice; no module shows a mixed filtered/unfiltered figure (test per module) | M |
| 7.3 | Comps surface: CompSet + `CapRateBenchmark` view (Market module tab) | `src/modules/market/` (UX Agent) | `Comps.html` tab 3 | `dealComps` overlay CompSets + `getMacroMarketBenchmarks` | renders every stored CompSet with source + date; benchmark table matches capital module figures | S/M |
| 7.4 | DealRoom enrichment: underwriting panel bound to `AcquisitionInput`/score; DD checklist (overlay write) if wanted | `src/brain/DealDrawer.tsx` (UX Agent; file is UX-owned per agent-assignments) | `DealRoom.html` | `acquisitionInputs` overlay + latest `acq_scores` | panel figures identical to Workbench for the same deal; checklist round-trips via overlay | M |
| 7.5 | Design-parity audit: walk all shipped pages vs prototype (structure, not palette, per D1(c)); file follow-ups | — (Validation Agent, report only) | README screens + app/*.html | — | written report per page: sections present/absent; becomes the v2 backlog | S |
| 7.6 | Cut-list reconciliation notes into `docs/` (why Financials/News/Inbox/etc. resolve to existing modules) | `docs/` (any agent; not architect-gated) | §6 below | — | one doc, linked from README or CLAUDE.md §3 at Gabriel's discretion | S |

Failure-proofing: display-only (`Refute-Skip`), except 7.2's as-of slicing if it changes any
computed figure's period basis → refute that slice. No migrations.

---

## 5. Governance capsule (applies to every phase)

1. **Worktree**: `git worktree add .claude/worktrees/<phase> -b <branch>`; copy
   `worktree-env.example` → `.env`; set worktree-local `WAREHOUSE_DB`.
2. **Claim**: add/update the worktree's entry in `architecture/status.json` (in_progress, agent
   role, phase text) AND register the worktree in `architecture/ownership.json` (CLAUDE.md §5 —
   ownership.json is "one entry per active worktree"; both files are `architecture/` so one
   review_needed claim covers the pair), and COMMIT the declaration on the branch before coding.
   Phases adding new API routes or new registry modules must NAME them in the claim —
   Gabriel's approval of this plan is the standing Lead-Architect authorization for the specific
   routes/modules listed in P2–P6 (per 0.7), but the claim makes each one auditable. For any
   Architect-owned file
   (`CLAUDE.md`, `architecture/`, `package.json`, `tsconfig*`, `vite.config.ts`, `server/index.ts`,
   **all of `src/contracts/`**, `src/analytics/engine.ts`, `scripts/governance-check.ts`,
   `server/warehouse/{db,migrate}.ts`, `server/warehouse/migrations/`): set `review_needed: true`
   + specific `review_detail`, commit, and WAIT for Gabriel's acknowledgment before editing.
3. **Main checkout discipline**: `git status` first; every uncommitted file you did not create is
   locked; explicit-path commits only; never `git add -A`.
4. **Gate**: `npm run gate` green at every commit (7 steps incl. `warehouse:drift`); never
   `--no-verify`. CI green = `gate:ci` + `refute-required` (post-D5 fix).
5. **Refute doctrine**: financial-decision changes (analytics engines, scoring, NOI math, anything
   feeding capital allocation — here: 2a.2, 4a.2, 4a.4, 5a.2, 6a.3) run
   `Workflow({name:'refute-financial-change', args:{changeSet:…}})` pre-merge and carry
   `Refute-Reviewed: wf_<runId>`; everything else carries an explicit `Refute-Skip: <reason>`
   when it touches checked paths (`src/analytics/**`, `server/warehouse/**` minus delivery files).
6. **Migrations**: new numbered file, DDL-only, never edit applied ones; **verify the next free
   number at execution time** (020 as of 2026-07-05; two files share 017 — leave them).
7. **PRs**: `type(scope):` titles; body = files + tests + deferred; stacked PRs declare base and
   merge order; squash-merge; Validation-Agent review before merge; after merge update
   STATUS.json → merged, REMOVE the worktree's `ownership.json` entry (CLAUDE.md §7 step 3),
   and remove the worktree.
8. **Ratification boundaries**: buy-box (any gate/floor/weight/band/anchor) = new ruleset version +
   Gabriel ratification + refute + archive of the old file; hurdle/governor values only via
   `capital_config` migrations; INSIGHT_CONFIG ranking weights (0.5/0.3/0.2 + top-20 cap) are
   PROPOSED per `rank.ts:58-62` — their ratification is due at P2 review, and the board is chipped
   "unratified" until it happens; new advisory thresholds (insurance re-bid, tax appeal) ship
   `advisoryOnly` until Gabriel promotes them.
9. **Confidentiality**: never surface `confidential-terms.json`; briefing/PDF paths keep
   `assertNoConfidential`; tax "filed returns" data stays out of the product (C2).

## Verification protocol (cross-phase)

- **Design parity**: per shipped page, a structured walkthrough against the prototype HTML
  (sections present, tier-board structure, interaction affordances) — palette exempt under D1(c).
  Screenshots attached to each PR (playwright `page.screenshot`).
- **No-long-lists rule**: any new list >7 items of ranked content must use TierBoard or justify
  a DataTable (dense reference tables are exempt — the rule targets ranked action feeds).
- **Token audit**: new components consume ONLY `--surface-*/--text-*/--accent*/--color-*` semantic
  vars + Tailwind utilities; grep-gate in review: no raw hex in `src/modules/**` new files.
- **Data honesty**: every $ figure traces to a real entity or renders as absent/indeterminate;
  provenance chips on derived figures; `advisoryOnly` chips wherever the contract carries it.
- **Tests**: each phase adds unit tests beside code + module tests; e2e happy-path per new surface
  (P3 grader flow, P4 register, P6 appeals). The 1905-test suite must never regress; new engines
  get fixture-based hand-computed assertions.
- **Reconciliation**: Spine-A-sourced KPIs tie to workbook totals ($0 tolerance, existing
  `reconcile` step); Spine-B sums tie to Intel figures for the same period; cross-spine figures
  are labeled, never silently mixed.

## 6. Cut list (deferred/dropped, with reasons)

| # | Design element | Disposition | Reason |
|---|---|---|---|
| C1 | Financials page (Statements/GL/AR/AP/Rent-roll/BvA) | **Reconcile, don't build** | Duplicates Intel (statements, BvA), Cash, Close, Leases (rent roll); GL/AP have no data source. AR exists via `tenantArrears`. |
| C2 | Taxes: Filed-Returns archive + cost-seg/bonus-depreciation engine + §469/entity strategies | **Defer (out of v1)** | Filed returns collide with the confidentiality boundary (docs RAG blocks tax returns; CLAUDE.md §9); cost-seg needs depreciable-basis/land-allocation sources that don't exist in-repo; prototype's marginal-rate/bonus constants are placeholders. Revisit with Gabriel's accountant data (D2 follow-up). |
| C3 | Studio (cross-filter analytics) | **Defer** | High effort; Intel covers the analytical questions; revisit after parity phases. |
| C4 | Operations (work orders/units/turn costs) | **Defer** | No WO/unit data source; needs PM-system export feed first. |
| C5 | Inbox (email threads + reply/snooze) | **Drop** | Alerts module is the production actionable-queue; email threading/drafting exists only as DraftPanel (draft-only by design). |
| C6 | News (briefing feed, regulation tracker, research library) | **Partial drop** | Rates/market data live in Market (FRED, real). Hand-authored editorial feeds have no source and would rot. |
| C7 | Overview "Focus Lens" React tweaks panel | **Drop** | Prototype-only experiment (CDN React); density/theme toggles already exist. |
| C8 | Investor detail (LP capital accounts, NAV/DPI/TVPI, capital calls) | **Defer pending D7** | No investor entity or fund-admin source anywhere in the repo. |
| C9 | Prototype letter grades (A+–F) + its 10-criterion buy box + 38-point breaker cap | **Drop (superseded)** | Ruleset v1.0 is ratified law (hard rule 3); its bands/verdicts render instead (D8). |
| C10 | Brain: fabricated memory entries, click-driven accuracy ramp, fixed "6 models" count | **Drop (replaced by honest derivations)** | P5 derives everything from calibration/insights/DQ; theatrical numbers violate the repo's provenance doctrine. |
| C11 | Insurance: self-insure math on synthetic EAL/risk-load constants | **Defer to P4c (needs loss runs)** | Prototype constants (1.6× risk load, 62% transfer share) are placeholders; shipping them would be invented financial advice. |

## 7. Sequencing summary

| Order | Phase | Depends on (mirrors the §4 graph) | Headline | PRs | Est |
|---|---|---|---|---|---|
| 0 | P0 unblockers | D5 | CI green again; status.json valid; docs true; ownership map extended (0.7); data requests sent | 1 | S |
| 1 | P1 tier-board primitives | P0, D1 | TierBoard/GaugeRing + Alerts as first consumer | 1 | M |
| 2 | P2 insights | P1, D6 | Wire dormant insight engine; flagship ranked board; fold capital orphan | 2 (2a→2b stacked) | M/L |
| 3 | P3 grader UX | P1 | Design's Grader on ratified engine + real OM extraction | 1 | L |
| 4 | P4 insurance | P1, D3 data | TIV + type-cohort benchmark + savings board | 2 (4a→4b stacked) | L |
| — | P4c self-insure/deductible | P4, loss runs + dec pages | EAL + deductible optimization + tab-3 parity | 1 (gated) | M |
| 5 | P5 command brain | P2, D4 | Honest meta-surface + server-persisted feedback | 2 (5a→5b stacked) | L |
| 6 | P6 taxes | P1, D2 data | Property-tax migration + assessments + appeal engine + strategy board | 2 (6a→6b stacked) | L |
| 7 | P7 parity sweep | P1–P6 | Overview banner, global filter, comps, dealroom, audit, cut-list docs | 1 | M |

**Total: 8 worktree-phases + 1 gated follow-up = 12 PRs (13 with P4c), four stacked pairs.**
Each phase independently shippable and revertible; no phase blocks Gabriel's daily work on `main`.

---

*Stop point per the brief: this plan awaits Gabriel's answers to D1–D8 (D1, D2, D3, D4, D5 are
blocking; D6–D8 can be answered at the affected phase). No implementation has been started.*
