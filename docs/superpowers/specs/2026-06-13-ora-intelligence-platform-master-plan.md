# ORA Intelligence Platform — Strategic Review & Master Plan

**Date:** 2026-06-13 · **Branch reviewed:** `feat/pfi-phase-b3` (10 commits ahead of `main`) · **Status:** Plan only — no code to be written until ratified
**Authoring lens:** Principal Architect / PM / Head of AM / Head of Acquisitions / CIO
**Success metric:** *Did this system help ORA make better investment, acquisition, leasing, capital-allocation, refinancing, and disposition decisions than competitors — and compound capital faster over 40 years?* Not code quality. Not dashboards.

---

## 0. EXECUTIVE REFRAME — read this first

The brief that commissioned this plan describes a greenfield system: "build a Financial Data Warehouse," "current dashboards are snapshots," "the system currently understands financial performance [but not functionality]." **That premise is materially out of date, and building to it would destroy capital by rebuilding what already works.**

Ground truth, verified against the live code (483 tests, all green; warehouse ingesting 32 real P&L files):

| Brief assumption | Reality on `feat/pfi-phase-b3` |
|---|---|
| "Dashboards are snapshots; build a historical warehouse" | A 5-layer SQLite financial warehouse (`server/warehouse/`) is **built, tested, and live** — immutable raw layer, account-mapping engine, versioned ledger, deterministic metrics, intelligence layer. 32 files ingested, 339 GL accounts mapped. |
| "Build NOI/Revenue/Expense/Occupancy trend engines" | NOI / revenue / expense / NOI-PSF trend + CAGR + since-acquisition engines **exist and are tested** (`growth.ts`). Occupancy trend is the one genuine gap (no occupancy column in the warehouse). |
| "Answer: why did NOI change?" | `drivers.ts` ΔNOI decomposition + `rootCauseLine()` already produce a one-sentence root-cause answer in the UI. |
| "Which properties improving/deteriorating? Which PM performs best?" | `synthesis.ts` + `benchmarks.ts` already render improving/deteriorating cards and PM scorecards. |
| "Build a Property Quality / Functional Obsolescence score" | **Genuinely absent.** No building-characteristics data model exists. (Priority 2 — real gap.) |
| "Build the Acquisition Intelligence Engine — the most important growth engine" | **0% coverage.** The Acquisitions module is a seeded kanban (`seed-deals.ts`). No Market/Asset/Basis/Risk scoring. (Priority 3 — the single largest gap vs. firm priorities.) |
| "Leasing intelligence: tenant risk, renewal probability, mark-to-market" | **Roster only.** Tenant health renders `"— (pending QuickBooks)"`. No risk score, no renewal probability, no market-rent comparison. (Priority 4 — real gap.) |
| "Capital allocation: BUY/HOLD/SELL/REFINANCE/IMPROVE" | A 4-way verdict (`invest/hold/monitor/disposition-candidate`) exists. The 5-way vocabulary, expected-return/risk/timeline/confidence, and the Refinance/Improve arms are **absent.** (Priority 5 — partial.) |
| "Market intelligence: vacancy, absorption, rent growth, Enter/Expand/Maintain/Exit" | **Macro only.** The Market module shows FRED rates + a cap-rate spread. No submarket data, no Market Attractiveness Score. (Priority 6 — real gap.) |
| "Debt intelligence: LTV/DSCR/maturity/refi scoring" | Threshold **alerts** exist (`conditions.ts`), but DSCR/LTV are read from static workbook cells, **disconnected from the warehouse**, and there is **no refi scoring**. (Priority 7 — alerts only.) |
| "AI should create insights, not summarize" | The AI agent is an excellent streaming, tool-using substrate (11 tools, fail-closed) but is **Q&A, not proactive insight**. The daily brief is a **deterministic template with zero AI narration** and a single daily cadence. (Priority 8 — substrate ready, intelligence not wired.) |

**Strategic conclusion.** The hardest, least glamorous problem — a trustworthy, auditable, tested financial warehouse with deterministic intelligence — is solved. The 40-year compounding advantage now lies in three places, in priority order:

1. **The forward layer** (forecast → capital allocation) that turns *decision support* into *investment intelligence*.
2. **The absent growth/ops engines** — acquisitions (firm priority #1, 0% built), debt/refi (real cash, alerts only), leasing intelligence (NOI protection, roster only).
3. **Two structural integrity fixes** that every adversarial reviewer will (correctly) attack: the **two un-reconciled NOI representations** (workbook formula cells vs. warehouse ledger) and **cross-accounting-basis comparison** with no flagging.

This document does Phase 0 → Phase 3 honestly against that reality. It does **not** propose a rebuild.

---

# PHASE 0 — CURRENT STATE ASSESSMENT

## 0.1 Architecture & data flow (as-built)

**Stack:** React 19 + Vite 6 + Tailwind 4 + visx + TanStack Query/Virtual (client); Hono 4 Node "Brain Server" on `127.0.0.1:8911` (server); Zod as the single typed boundary (`src/contracts/`); better-sqlite3 (WAL) for both the document RAG index and the finance warehouse; `@anthropic-ai/sdk` server-side; vitest (66 files / 483 tests) + Playwright + axe; strict TS (`noUncheckedIndexedAccess`); `npm run gate` = typecheck + lint + test + reconcile + warehouse:verify. Deployed local-first; static mirror to Cloudflare Pages (Access-gated) via `deploy-mirror.ps1`, confidential deals redacted by default.

**Two parallel data spines (the central architectural fact):**

```
SPINE A — "current state" (live, workbook)
  Master Workbook .xlsx (OneDrive)
    → ExcelJS + chokidar  → server/workbook/parse.ts
    → Zod PortfolioSnapshot.parse()         [validation gate]
    → applyOverlay(overlay.json)            [user mutations]
    → loadQuickbooks(QUICKBOOKS_CSV side-car)
    → reconcile-runtime (workbook self-totals, $0 tol)
    → /api/snapshot + /sse → client → buildAnalytics() → 18 modules
  Supplemental: Notion deals (LIVE), M365 tasks (LIVE), FRED macro (LIVE w/ key), doc RAG (LIVE)

SPINE B — "time dimension" (live, warehouse)
  Property Financials folder (32 P&L .xlsx/.xlsm)
    → detect.ts (filename grammar + alias) → parse/qb-excel.ts → RawStatementSchema.parse()
    → raw-store.ts (sha256 immutable copy) → mapping.ts (manual>seed) → ledger_entries (SQLite)
    → confidence ≥0.85 auto-commit else pending-review
    → metrics.ts → {growth, drivers, anomalies, benchmarks, scores} (pure, in-memory)
    → /api/warehouse/* → Intel module
```

**The defect this creates:** `Property.noi` (Spine A, a workbook formula cell) and warehouse ledger NOI (Spine B, `Σ revenue+recovery+other-income − opex` over classified rows) are **independent computations with no reconciliation check**. Two numbers both called "NOI" can silently disagree (different basis, Oxford-share applied pre-report, excluded items in the workbook expense line). This is the root structural risk of the whole platform (see Phase 2).

## 0.2 Module-by-module assessment

Legend — **ORA Impact**: H/M/L contribution to a real capital decision today.

### Spine B — Warehouse & Intelligence (the crown jewel)

| Module / engine | Purpose | Strengths | Weaknesses / Tech debt | Scalability | Missing value | ORA Impact |
|---|---|---|---|---|---|---|
| `warehouse/db.ts` | 5-table SQLite schema (WAL, FK) | Hash-dedupe, supersede-without-delete audit trail | **No migration system** (`CREATE TABLE IF NOT EXISTS` silently skips column changes); no index on `ledger_entries(import_id)` | Single-file SQLite fine at 14 props; needs a documented Postgres/Turso path at 10× | `period_metrics`/`scores`/`intel_findings`/`briefings` tables (spec layers 4–5) not persisted | H |
| `warehouse/ingest.ts` | detect→parse→map→foot-check→commit | Sign-normalization w/ DQ note; per-section + income-side foot choke points; empty-parse guard | CSV/PDF gated `needs-adapter`; grain inferred from filename not `periodEnd`; period keyed by year-string only | Single-tx per file, fine | — | H |
| `warehouse/parse/qb-excel.ts` | Multi-format P&L parser (QB/Yardi/AppFolio/RM) | Layout-mode detection; derived-summary exclusion; per-section foot scoping; 697-line test | One 300-line function; any non-Yardi/AppFolio file assumed QuickBooks; no multi-property AppFolio split | 2× row scan, fine | True Yardi/AppFolio/RM/PDF adapters | H |
| `warehouse/mapping.ts` | Account→classification (manual>learned>seed) | Side-aware (income line can't map to opex); GL-prefix normalization | `learned` tier never written (reserved); no temporal versioning of mappings (override re-classifies history retroactively) | O(n) re-derive loop in JS | Learned/ML-assist tier | H |
| `warehouse/metrics.ts` | PeriodMetrics (rev/opex/NOI/$SF/margins) | Grain-hint propagation; `oxfordNoi` ownership overlay; null-safe $/SF | Full ledger scan per API call (not materialized); **no `basis` surfaced**; capex/TI/LC not in any ratio | Recompute-from-scratch each call | Materialized metrics; basis discipline | H |
| `warehouse/growth.ts` | PoP growth, CAGR, since-acquisition | `comparable:false` on cross-grain; YTD→FY fallback | Year-string integer math (breaks on sub-annual) | fine | **Forward forecast (absent)** | H |
| `warehouse/drivers.ts` | ΔNOI decomposition by category | Σdeltas≡ΔNOI by construction; null on near-zero | Default `from`=earliest can pick YTD endpoint | fine | Income-side driver detail | H |
| `warehouse/anomalies.ts` | 6 anomaly kinds, severity-scaled | Cross-grain skip; watches Taxes/Ins/Repairs/Utilities | `new-category` always low sev regardless of $; spike categories hardcoded to exact label strings | fine | Income-side spikes; one-time-item suppression (easement/distribution) | H |
| `warehouse/scores.ts` | Health 0–100, attention band, capital action | Grain discipline; human `reasons[]`; deterministic | **Weights UNRATIFIED** ("PROPOSED — calibrate w/ Gabriel"); **zero debt inputs**; **no occupancy**; capitalAction is 4-way not 5-way | 3 extra O(n) passes per run | Debt/occupancy inputs; confidence | H |
| `warehouse/benchmarks.ts` | Portfolio quartiles, ranks, PM scorecards | Singleton-cohort guard; `smallSample` flag; linear-interp quantiles | **Small-N PM benchmarking is statistically thin** (few PMs × few props); PM-less props invisible; intra-portfolio only (no market peer) | fine | External market benchmark | M |
| `warehouse/api.ts` | 14 Hono endpoints, Zod-validated, 503 guard | Clean validation; mirror-safe | 6+ independent full-ledger scans per composed render; no request memoization; no authz on financial endpoints | Memoize before scale | — | H |
| `intel-config.ts` | Single threshold/weight source | Anomaly thresholds ratified | Health/attention weights + `categorySpikePct` + `growthScoreCapPct` **proposed/uncalibrated** | — | Ratification workflow | M |

**Intel module (`src/modules/intel/`, 17 files) — the decision surface.** Seven tabs, all built (not scaffold), 100% live-warehouse (offline card on mirror): Ownership (morning-briefing hero with portfolio verdict sentence + top-3 prioritized actions + attention heat-strip + capital buckets), Property (answer-first verdict header → "Why" root-cause line → "Do" recommended action → KPIs w/ sparklines → ΔNOI waterfall), Benchmarks, Managers, Imports (approve/reject/resolve), Data Quality, Mappings. **Strengths:** genuinely answer-first; deterministic `synthesis.ts` action engine; full data-ops loop (import→classify→resolve→approve→invalidate). **Weaknesses/missing value:** no forward projection/DCF; no confidence intervals (verdict is binary); no mark-to-market; no hold-vs-sell NPV; intra-portfolio benchmarks only. **ORA Impact: H** — this is the single most decision-useful surface in the system.

### Spine A — Workbook-fed modules

| Module | Purpose | Real? | Key weakness | Missing value | ORA Impact |
|---|---|---|---|---|---|
| `overview` | Configurable widget dashboard + alert inbox | Live | Alerts are threshold rules, not analytical verdicts; not connected to Intel scores | Unify with Intel intelligence | M |
| `portfolio` | Current per-asset financial table | Live (workbook) | Pure reporting; no health-band badge linking to Intel | Cross-link Intel scores | M |
| `acquisitions` | Deal pipeline kanban | **Seeded** (`seed-deals.ts`); Notion adapter exists but pipeline view still seed-flagged | **No scoring of any kind** | **Entire Acquisition Intelligence Engine (Priority 3)** | L→(H potential) |
| `tenants` | Tenant roster + renewal stage | Live (workbook) | Health = `"—"`; concentration shown but not actioned | **Risk score, renewal probability, mark-to-market (Priority 4)** | L→(H potential) |
| `market` | FRED macro + cap-rate spread | Live (FRED) | Misnamed — it's a rate widget | **Submarket data + Market Attractiveness Score (Priority 6)** | L→(M potential) |
| `debt` | Debt dashboard, maturity ladder, balloon watch | Live (workbook) | No DSCR column; `loanType` (floating) not rendered; **no refi scoring**; sourced from workbook not warehouse | **Refi Opportunity Score, equity-extraction/floating flags (Priority 7)** | M→(H potential) |
| `cash` | Entity cash + 12-mo trend | Live | No liquidity-runway calc | Runway, capital-call funding view | M |
| `close` | NOI budget-vs-actual | Conditional (QB CSV) | QB CSV is manual one-file, fuzzy-matched, unaudited; parallel to warehouse | Fold actuals into warehouse | M |
| `insurance` | Policy tracker | Live | No replacement-cost adequacy (the `replacement-cost.ts` brain file is unwired) | Coverage adequacy | M |
| `leases`/`renewals` | Rent roll + renewal kanban | Live | 90-day notice hardcoded; stage write-back overlay-only (drifts on re-parse); no renewal economics | Mark-to-market, renewal probability | M |
| `calendar`/`tasks`/`alerts`/`health`/`documents`/`relationships`/`principal` | Critical dates, close checklist, alert inbox, system health, doc RAG, counterparty directory, C-suite digest | Live | Mostly solid utility modules | Minor | M/L |

### AI / comms layer

| Component | State | Gap |
|---|---|---|
| `server/ai/agent.ts` | Streaming tool-using Claude (11 tools, prompt caching, adaptive thinking, fail-closed to deterministic responder) | **Q&A only** — does not proactively generate insight; **no `get_macro`/warehouse tools**; `get_loans` lacks DSCR |
| `server/ai/comps.ts` | AI web-search comp research → Zod `record_comps` | Not cached; `max_uses:6` low; not wired into an acquisition score |
| `server/brief/*` | Daily deterministic HTML brief via Outlook COM, outbox fallback, alert dedupe | **Zero AI narration; single daily cadence; recipients hardcoded** — no weekly/monthly/quarterly/annual asset-management memos |
| `server/macro/*` | FRED 5-series + seeded fallback | `change` always null; history window hardcoded `2025-06-01`; **not exposed to the agent or debt engine** |

## 0.3 Data-quality & integrity risks (verified, ranked)

1. **[HIGH] Two un-reconciled NOI representations** — workbook `Property.noi` vs. warehouse ledger NOI; no tie-out. Every downstream score/verdict inherits the ambiguity.
2. **[HIGH] Cross-basis aggregation** — cash/accrual/tax NOI aggregated across properties with `basis` stored but never surfaced or used to flag comparisons (`metrics.ts`/`benchmarks.ts`).
3. **[HIGH] One-time-item leakage** — FVC 2025 $500k cell-tower easement and 55 New Plant distributions-as-expenses are documented in `property-master.ts` notes but **no automated exclusion exists**; they distort NOI, anomalies, and scores unless the mapping seed catches them.
4. **[MED] Ledger writes bypass Zod** — `LedgerEntrySchema` is documentation-only; rows inserted via raw SQL; `classification` weakly typed at write. NOI classes enforced by SQL string literals, not `NOI_CLASSES`.
5. **[MED] `WORKBOOK_AS_OF` hardcoded** (`2026-06-01`) — drives lease `monthsToExpiry` and task-month column; silent staleness if workbook advances and env doesn't.
6. **[MED] Three independent property-matching implementations** (`detect.ts` aliases, `parse.ts` token-overlap, `quickbooks.ts` substring) can diverge for the same asset.
7. **[MED] Unratified scoring weights** feeding capital-action verdicts.
8. **[LOW-MED] Overlay key fragility** — tenant notes/renewal stages keyed by Excel row number; orphan on row insert.

## 0.4 SYSTEM VALUE MAP

**HIGH VALUE (keep, harden, build on):**
- The 5-layer warehouse + ingestion + audit trail (`server/warehouse/`) — irreplaceable foundation.
- Deterministic intelligence engines (growth, drivers, anomalies, scores, benchmarks) — the "decision support" core.
- The Intel module answer-first UX (verdict → why → do) — the right interaction model.
- The streaming tool-using AI agent substrate (`server/ai/agent.ts`) — correct platform for narrative.
- The quality bar: Zod boundary, `gate`, `reconcile`, `warehouse:verify`, 483 tests, confidentiality redaction.

**MEDIUM VALUE (useful, but reporting-grade — upgrade to decision-grade):**
- Workbook-fed modules (portfolio, debt, cash, leases, renewals, insurance, overview alerts) — solid utilities; need connecting to the intelligence layer and the warehouse.
- FRED macro, doc RAG, calendar, tasks, relationships, health.

**LOW VALUE TODAY (high potential — these are the build targets):**
- Acquisitions (seeded kanban), Tenants (roster), Market (rate widget). Each is a shell awaiting its engine.

**DEAD WEIGHT / drift (remove or wire):**
- Always-null fields: `Loan.annualInterest/annualPrincipal`, `CashSnapshot.cagr`, `MacroIndicator.change`, `Provenance.formula/asOf`. Either populate or delete from the contract.
- The QB CSV side-car (`quickbooks.ts`) as a *parallel* financial path — unaudited, fuzzy-matched. Fold into the warehouse, don't maintain two truths.
- `learned` mapping tier — reserved but unimplemented; keep only if Phase-N ML mapping is committed, else remove from ORDER BY.

---

# PHASE 1 — FUTURE STATE ARCHITECTURE

## 1.1 Vision: the three-stage evolution

```
REPORTING SYSTEM  ──►  DECISION SUPPORT SYSTEM  ──►  INVESTMENT INTELLIGENCE SYSTEM
 (Spine A modules)      (Intel module — TODAY)         (forward layer — THE GOAL)
 "what is true now"    "what changed, why, what to do"  "what WILL happen, what to do
                                                          about capital, with what
                                                          confidence and risk-adjusted
                                                          return — vs. all alternatives"
```

The platform is at the boundary of stage 2. The 40-year compounding edge is stage 3: every asset, tenant, loan, market, and candidate acquisition continuously scored, forecast, and ranked against **the firm's own opportunity cost of capital** — so ORA always deploys the marginal dollar where risk-adjusted return is highest.

## 1.2 Future-state layered architecture

```
SOURCE SYSTEMS   Excel WB · PM exports (QB/Yardi/AppFolio/RM) · QuickBooks · Notion · HubSpot · M365/Outlook · FRED/Census/BLS · lease abstracts · market feeds
      │
INGESTION        chokidar watch · adapter router (xlsx/csv/pdf+OCR) · detect (property/period/basis/source/confidence)
      │
VALIDATION       Zod gates (incl. ledger) · foot checks · duplicate hash · BASIS DISCIPLINE · NOI RECONCILIATION (A↔B) · pending-review queue
      │
HISTORICAL WAREHOUSE   immutable raw · account mappings (versioned) · ledger · property_master · debt_register · property_characteristics · MATERIALIZED period_metrics · scores · intel_findings · briefings · market_series   (SQLite→Postgres/Turso path)
      │
ANALYTICS        metrics · growth/CAGR/since-acq · drivers · FORECAST · occupancy · mark-to-market · DSCR/LTV from ledger
      │
INTELLIGENCE     anomalies · health/attention/quality/functional-obsolescence scores · benchmarks/PM · OXFORD ACQUISITION SCORE · TENANT RISK/RENEWAL · REFI OPPORTUNITY · MARKET ATTRACTIVENESS · CAPITAL ALLOCATION (Buy/Hold/Sell/Refi/Improve)
      │
DECISION         ranked recommendations w/ expected return · risk · timeline · CONFIDENCE · provenance (inputs_version)
      │
AI NARRATIVE     LLM narrates deterministic findings ONLY (never computes) · cadenced memos (wk/mo/qtr/yr) · "explain this" · proactive flags
      │
UI / REPORTING   Intel module + property pages · Acquisition workbench · branded PDF report suite · email via Outlook COM
```

**Inviolable principle (already the house style — keep it):** *every number is computed by a pure, tested, deterministic function; the LLM only narrates.* This satisfies invariant 7 (never fabricate firm data), keeps tests deterministic, works with no API key, and is the only defensible basis for capital decisions.

## 1.3 The eight engines, mapped to priorities (build state)

| Engine | Priority | Today | Target |
|---|---|---|---|
| Property Financial Intelligence (warehouse + trends) | P1 | ~70% (no forecast, no occupancy, not materialized, A/B unreconciled) | Complete + forecast + reconciled + materialized |
| Property Quality / Functional Obsolescence | P2 | 0% (no characteristics model) | Characteristics data model → 0–100 quality + obsolescence flags |
| Acquisition Intelligence (Oxford Acquisition Score) | P3 | 0% (seeded kanban) | Market/Asset/Basis/Risk → composite, ranked, vs-portfolio |
| Leasing Intelligence (risk/renewal/mark-to-market) | P4 | ~10% (roster + stages) | Tenant risk, renewal probability, MTM, lease risk |
| Capital Allocation (Buy/Hold/Sell/Refi/Improve) | P5 | ~25% (4-way action) | 5-way w/ return·risk·timeline·confidence, consumes all engines |
| Market Intelligence (Attractiveness, Enter/Expand/…) | P6 | ~10% (macro only) | Public-data + AI submarket scores, confidence-tagged |
| Debt Intelligence (DSCR/LTV/refi from warehouse) | P7 | ~20% (alerts, workbook-sourced) | Debt register, warehouse DSCR, Refi Opportunity Score |
| AI Decision Engine (narrative + cadenced memos) | P8 | ~30% (Q&A agent + daily template) | Narrative over findings, wk/mo/qtr/yr memos, proactive |

## 1.4 VALUE CREATION MATRIX

Scoring 1–10. **Effort columns are costs (lower is better); value columns are benefits (higher is better).** Priority Score = (Business + Decision + Revenue + NOI + RiskReduction) − (DevEffort + MaintEffort)/2, then ranked. Effort estimates assume the existing substrate (warehouse, agent, contracts) is reused.

| # | Feature / Engine | Dev | Maint | Business | Decision | Revenue | NOI | RiskReduc | **PScore** | Rank |
|---|---|---|---|---|---|---|---|---|---|---|
| F1 | NOI/Workbook **reconciliation + basis discipline + Zod ledger gate** | 4 | 2 | 9 | 9 | 4 | 7 | 10 | **36.0** | 1 |
| F2 | **Debt & Refi Intelligence** (warehouse DSCR, Refi Score, equity-extraction/floating flags) | 5 | 3 | 9 | 9 | 7 | 8 | 9 | **38.0** | — |
| F3 | **AI narrative + cadenced briefings** (wk/mo/qtr/yr memos) | 4 | 4 | 9 | 8 | 5 | 6 | 6 | **30.0** | — |
| F4 | **Acquisition Intelligence Engine** (Oxford Acquisition Score) | 7 | 4 | 10 | 10 | 10 | 7 | 8 | **39.5** | — |
| F5 | **Forecast Engine** (NOI/rev/exp, scenario ranges + confidence) | 6 | 4 | 8 | 9 | 6 | 7 | 7 | **32.0** | — |
| F6 | **Leasing/Tenant Intelligence** (risk, renewal prob, mark-to-market) | 6 | 4 | 8 | 8 | 6 | 9 | 8 | **34.0** | — |
| F7 | **Capital Allocation Engine** (Buy/Hold/Sell/Refi/Improve + confidence) | 6 | 4 | 10 | 10 | 8 | 8 | 8 | **39.0** | — |
| F8 | **Materialized metrics + history tables** (period_metrics/scores/findings/briefings; dated snapshots) | 4 | 2 | 7 | 7 | 3 | 5 | 8 | **27.0** | — |
| F9 | **Property Quality / Functional Obsolescence** (characteristics model) | 6 | 5 | 7 | 7 | 6 | 6 | 7 | **27.5** | — |
| F10 | **Market Intelligence** (public-data submarket scores, confidence-tagged) | 8 | 6 | 9 | 8 | 8 | 5 | 6 | **29.0** | — |
| F11 | Occupancy time-series in warehouse | 3 | 2 | 6 | 6 | 4 | 6 | 5 | **24.5** | — |
| F12 | Branded PDF report suite (Playwright) | 3 | 3 | 7 | 4 | 2 | 3 | 4 | **17.0** | — |
| F13 | Source-adapter expansion (Yardi/AppFolio/RM/PDF-OCR; HubSpot/QB-live) | 6 | 5 | 6 | 5 | 4 | 5 | 6 | **20.5** | — |

**Ranked (descending PScore):** F4 (39.5) · F7 (39.0) · F2 (38.0) · F1 (36.0) · F6 (34.0) · F5 (32.0) · F3 (30.0) · F10 (29.0) · F9 (27.5) · F8 (27.0) · F11 (24.5) · F13 (20.5) · F12 (17.0).

**Caveat — raw rank ≠ build order.** F4/F7 score highest on value but have hard dependencies (F7 consumes F2/F4/F5; F4's Market sub-score wants F10; both feed capital decisions and must not be built on the F1 integrity hole). Sequencing is resolved adversarially in Phase 2 and finalized in the Phase 3 roadmap.

---

# PHASE 2 — CRITICAL SELF-REVIEW (adversarial)

## PLAN FAILURE REPORT (hostile reviewer)

Assume the Phase-1 plan ships as-ranked. Where does it fail?

- **PFR-1 (fatal): Building on sand.** Six new engines and a capital-allocation capstone are layered on top of two un-reconciled NOI sources (Risk #1) and silent cross-basis aggregation (Risk #2). A Buy/Hold/Sell verdict computed from an NOI that disagrees with the workbook by 8% is worse than no verdict — it launders ambiguity into false authority and could justify a real disposition. **The value matrix under-ranked F1.**
- **PFR-2: Market engine assumes data ORA won't buy.** F10 implicitly needs CoStar-grade vacancy/absorption/rent feeds. The ratified procurement stance (`procurement-stance-deepen-not-migrate.md`, Gabriel-approved 2026-06-09) says sub-$150M AUM spend goes to the Claude/agent stack, **not** per-seat PropTech SaaS. A market engine on free/AI-pulled data dressed as precise scores produces *false precision* that misallocates capital across markets — the exact opposite of the mission.
- **PFR-3: Wrong sequencing vs. firm priorities.** Acquisition velocity is the firm's **#1** priority; the Acquisition Engine has **0%** coverage. A plan that defers it behind forecast/leasing leaves the single most important growth lever at zero for multiple phases. Meanwhile the scoring logic *already exists* encoded in the `acquisition-underwriting` skill (Buy Box & Scorecard v1.0, calibrated with Gabriel 2026-06-09) — deferring it ignores reusable, ratified IP.
- **PFR-4: Forecast as autopilot.** A naive linear/trend forecast on 2–3 years of annual data (the warehouse has 2024/2025/2026-YTD) fed into a capital-allocation engine is statistically indefensible and violates the Engineering OS rule that financial-decision code gets a *mandatory adversarial pass*. Point-estimate NOI projections will be over-trusted.
- **PFR-5: Adoption, governance & maintenance at 40-year/10× scale.** Scoring weights are unratified; the property roster and aliases are hardcoded TS (a new acquisition needs a code deploy); the system is single-operator and single-machine; SQLite is single-writer; there's no record of whether past scores *predicted reality*. A system only one person trusts, that needs an engineer to onboard a property, and that never learns whether its verdicts were right, will be abandoned or — worse — trusted when it shouldn't be.
- **PFR-6: Confidentiality blast radius widens.** Acquisition scoring pulls active-deal data (incl. confidential E. Fulton). New engines, new API endpoints, new PDF exports, and AI narrative each create a fresh egress path. The current redaction guard covers the workbook bake; it does **not** automatically cover warehouse intelligence, acquisition scores, or generated memos.
- **PFR-7: Capital-allocation circularity / opportunity-cost vacuum.** A Buy/Hold/Sell/Refi/Improve engine that ranks actions needs a *common yardstick* — the firm's marginal cost of capital / hurdle rate. Without it, "Improve (capex IRR 11%)" vs. "Buy (yield-on-cost 8.5%)" vs. "hold" are not comparable, and the engine emits incomparable recommendations.

## REVISION 1 — fix the foundation before the superstructure

**Change:** F1 (reconciliation + basis discipline + Zod ledger gate) is promoted to a **hard Phase-1 exit gate** ahead of every new engine. Concretely: (a) a `reconcile`-style invariant comparing warehouse ledger NOI to workbook `Property.noi` per property/period, surfacing deltas as DQ issues with a tolerance band; (b) decide authoritative source per property per the canon ("PM-software exports authoritative over internal QuickBooks") and record it on `property_master`; (c) surface `basis` in `PeriodMetrics` and **block cross-basis comparisons** in benchmarks/growth (flag + visual mark, never silent); (d) make `LedgerEntrySchema` a real parse gate and replace SQL NOI string-literals with a `NOI_CLASSES` reference; (e) automate the one-time-item exclusions (FVC easement, distributions) as mapping rules, not prose notes. **No scoring engine ships until ledger NOI is reconciled and basis-disciplined.**

## REVISION 2 — re-scope Market Intelligence to honest, confidence-bounded public data

**Change:** Market Intelligence (F10) is **downgraded and reframed**, never built as a precise governor. It uses only free/owned/AI-pulled sources (FRED, Census ACS — the `census-acs-extract` skill, BLS, county data, AI web-search comps via `comps.ts`) landing in a `market_series` table under a `market:` namespace (the architecture spec already designed this `benchmark_sources` interface). Every market metric carries an explicit **confidence tag** and source date; the Market Attractiveness Score is presented as *directional* with visible confidence, and is a **lower-weighted, confidence-bounded input** to the Acquisition Score — never a standalone capital trigger. Asset Score and Basis Score (computed from *owned, high-confidence* data) become the **backbone** of the acquisition decision; Market Score modulates. This respects the procurement stance and refuses false precision.

## REVISION 3 — front-load an Acquisition Engine v1 by porting existing ratified IP

**Change:** Re-sequence to deliver **Acquisition Intelligence v1 early**, because (a) it's firm priority #1 at 0% coverage and (b) the scoring logic already exists and is Gabriel-calibrated in the `acquisition-underwriting` skill (Buy Box gates → floors → 100-pt scorecard). v1 *ports that scorecard into a deterministic warehouse engine* — Asset/Basis/Risk from owned data + comps (`comps.ts`), with a simplified confidence-bounded Market score (Revision 2), and a "compare to existing portfolio assets" view fed by the warehouse benchmarks already built. This converts months of "new engine" work into "encode known, ratified logic against existing data," collapsing F4's effective Dev effort and pulling the highest-value engine forward without violating Revision 1 (acquisition scoring uses owned/comp data, not the un-reconciled portfolio NOI for the *target* — it reconciles the target's broker numbers independently).

## REVISION 4 — forecast as bounded decision-support, never autopilot

**Change:** The Forecast Engine outputs **scenario ranges with explicit confidence intervals**, not point estimates, and is **driver-based** (escalation schedules from leases, known rollover, contractual rent steps, expense-trend bands) rather than naive extrapolation — anchored to data the warehouse already holds (lease rollover, since-acquisition trends). Forecasts are tagged `[FORECAST]`, carry method + confidence + `inputs_version`, and **never auto-trigger an irreversible recommendation** (Sell/Refi) without a human gate. Any forecast feeding the Capital Allocation Engine gets the **mandatory adversarial review pass** (a reviewer told to refute the projection) per Engineering OS doctrine for financial-decision code. This makes forecasting defensible and prevents false-precision capital misallocation (PFR-4).

## REVISION 5 — engineer for 40-year trust, governance, and scale

**Change:** Add the cross-cutting "compounding infrastructure" that PFR-5/6/7 demand, threaded through every phase:
- **Governance:** a weight-ratification workflow — proposed scoring weights are versioned, presented to Gabriel for sign-off, and recorded; `intel-config.ts` distinguishes *ratified* governors from *proposed* defaults (the pattern already exists for anomaly thresholds — extend it).
- **Calibration / learning loop (the 40-year edge):** persist every score/verdict with `inputs_version` and `as_of`, and log realized outcomes (did the "disposition-candidate" underperform? did the acquisition hit its yield-on-cost?). A periodic **score-vs-outcome calibration report** is how the system *earns* trust and improves over decades. This is the single most important long-horizon feature and was missing entirely.
- **Data-driven property onboarding:** move `property_master` + aliases out of hardcoded TS into a seed/admin path so a new acquisition is onboarded **without a code deploy** (critical at 10× portfolio).
- **Confidentiality by construction:** every new surface (warehouse intelligence API, acquisition scores, PDF memos, AI narrative) runs through the existing confidential-deal guard (`confidential-terms.json`, fail-closed), with the `site-qc-reviewer`/redaction pattern extended to memos and exports. No new egress path ships without a confidentiality test.
- **Opportunity-cost yardstick:** introduce a single firm **hurdle-rate / marginal-cost-of-capital constant** (governor-class, ratified, like DSCR 1.25/LTV 40) that the Capital Allocation Engine uses to make Buy/Hold/Sell/Refi/Improve comparable on one risk-adjusted axis.
- **Scale path:** keep all storage behind the Zod-contract + repository boundary so the documented SQLite → Postgres/Turso migration is a swap, not a rewrite; add the missing `ledger_entries(import_id)` index and request-scoped metric memoization now.

## Convergence

After five passes the residual weaknesses are *acceptable, bounded, and explicitly owned*, not structural: SQLite single-writer (mitigated by single-operator use + documented migration path), small-N PM benchmarking (already flagged `smallSample`, never presented bare), market data directional-by-nature (now confidence-tagged by design), forecast uncertainty (now ranges + adversarial review). No further pass changes the architecture's shape — only its calibration, which is now a governed, ongoing process rather than a one-time decision. **The plan has converged.**

---

# PHASE 3 — ORA INTELLIGENCE PLATFORM MASTER PLAN

## 3.1 Vision

A proprietary industrial/flex real-estate **investment intelligence system** that, for a long-term buy-and-hold family office, answers better than any employee: *what to buy, what to sell, where to expand, which tenants are at risk, which properties underperform, where to deploy the marginal capital dollar, which loans to refinance, and which action creates the highest risk-adjusted return* — every answer deterministic, provenance-stamped, confidence-bounded, and continuously calibrated against realized outcomes so the system compounds in judgment as ORA compounds in capital.

## 3.2 Data Architecture

- **Dual-spine, reconciled.** Spine A (live workbook = current-state) and Spine B (warehouse = time dimension) **join on `property_master.id`** and are tied out by a reconciliation invariant (Revision 1). Authoritative source recorded per property (PM exports > internal QB).
- **Staged ETL with immutable raw layer** (exists): watch → detect (property/period/basis/source/confidence) → adapter parse → Zod gate → foot checks + reconciliation + basis discipline → stage (pending-review <0.85) → commit (raw copy + versioned ledger + recompute + SSE).
- **Basis is first-class.** Surfaced in `PeriodMetrics`; cross-basis comparisons flagged/blocked.
- **Sources:** Excel WB, PM exports (QB/Yardi/AppFolio/RM via adapters), QuickBooks (folded into warehouse, not parallel), Notion (live), HubSpot (to wire), M365/Outlook (live), FRED/Census/BLS (public), lease abstracts (doc RAG), market series (confidence-tagged). No hardcoded years; periods come from detection.

## 3.3 Application Architecture

- **Module registry + React Router** (exists) — additive new surfaces: an **Acquisition Workbench** (scoring + ranking + compare-to-portfolio), upgraded **Tenants** (risk/renewal/MTM), upgraded **Debt** (refi), upgraded **Market** (attractiveness), and a **Capital Allocation** view. Reuse primitives (KpiStat/DataTable/Badge/Card), charts (Area/Bar/BarList/Sparkline/Waterfall) + a missing **score gauge** and **quartile** chart.
- **Local-first server (Hono) + static Access-gated mirror.** Warehouse intelligence stays server-side (503 on mirror by design); decide later whether to expose redacted intelligence to the mirror for mobile (deferred).
- **Answer-first everywhere** — verdict → why → do, the Intel module pattern, extended to acquisitions, leasing, debt, capital allocation.

## 3.4 Intelligence Architecture (deterministic core)

All scores are pure, tested functions over the warehouse, with `reasons[]`, `confidence`, and `inputs_version`:
- **Property:** health 0–100, attention band, **quality 0–100 + functional-obsolescence flags** (clear height, office %, loading, bay depth, truck access, power, deferred maintenance), NOI/rev/exp trends, ΔNOI drivers, anomalies, **forecast (ranges)**, occupancy.
- **Tenant/Lease:** risk score (credit proxy + concentration + expiry + replacement-rent risk), renewal probability, **mark-to-market** (in-place vs. market rent), lease risk.
- **Debt:** warehouse-computed DSCR/LTV, maturity/balloon urgency, **Refinancing Opportunity Score** (book rate vs. FRED-derived market rate, breakeven, post-refi LTV), floating-rate exposure, equity-extraction candidates.
- **Acquisition:** **Oxford Acquisition Score** = f(Market, Asset, Basis, Risk sub-scores), Buy Box gates/floors ported from the underwriting skill, ranked, compared to portfolio.
- **Market:** Market Attractiveness Score (confidence-tagged public data), Enter/Expand/Maintain/Exit.
- **Capital Allocation:** **Buy/Hold/Sell/Refinance/Improve** per asset and portfolio-wide, each with expected return, risk, timeline, and confidence, made comparable by the ratified **hurdle-rate** governor.

## 3.5 AI Architecture

- **LLM narrates, never computes.** Add warehouse/market/debt tools to the existing agent (`get_property_financials`, `get_drivers`, `get_scores`, `get_refi`, `get_acquisition_score`, `get_macro`). Add a proactive flag pass.
- **Cadenced briefings** (weekly/monthly/quarterly/annual asset-management, acquisition, leasing, capital-allocation, market-expansion memos): deterministic assembly + optional Claude narrative, persisted to a `briefings` table, emailed via the **sole** Outlook COM path (`send-via-outlook.ps1`), routed **ggoldberg@ only** (Daily Brief sole cc-Eric exception), retry-once-then-flag.
- **Fail-closed** without API key (deterministic responder remains); confidentiality guard on every generated artifact.

## 3.6 Storage Architecture

- SQLite (WAL) now: existing 5 tables + **new** `period_metrics` (materialized), `scores`, `intel_findings`, `briefings`, `debt_register`, `property_characteristics`, `market_series`. All mirrored as Zod schemas and used as parse gates.
- Add `ledger_entries(import_id)` index; request-scoped metric memoization. Repository boundary preserved for the **SQLite → Postgres/Turso** migration path at scale.

## 3.7 Reporting Architecture

- In-app: Intel + Acquisition Workbench + Capital Allocation views.
- **Branded PDF report suite** via Playwright print-to-PDF (extractable text per ORA standard; MS Print-to-PDF prohibited): property, portfolio, benchmarking, exec summary, capital allocation, PM scorecard, acquisition IC pre-read. ORA Style Guide (EB Garamond/DM Sans/IBM Plex Mono; Navy/Gold/Parchment) + 16-pt QC gate.
- Email distribution via COM, routing canon enforced.

## 3.8 Historical Data Architecture

- **Indefinite retention, append-only.** Immutable raw layer + versioned ledger (exists). New: **dated snapshots** of `period_metrics`/`scores`/`intel_findings` so the system can answer "what did we believe in Q2-2026, and was it right?"
- **Calibration log (the compounding edge):** every verdict stored with `inputs_version`+`as_of`; realized outcomes logged; periodic score-vs-outcome calibration report drives weight re-ratification.

## 3.9 Scalability Architecture

- Designed for ~27 properties → 40-year $700–800M AUM (~10×). No hardcoded years/properties (data-driven onboarding, Revision 5). Materialized metrics + indexes remove per-call full scans. Documented DB migration path behind the contract boundary. Lazy-loaded modules + bundle budget (exists) hold the client cost flat as surfaces grow.

## 3.10 Security Architecture

- Confidential active deals (roster in `confidential-terms.json`, hook-enforced fail-closed) **never** on any external surface until closing — extended to warehouse intelligence, acquisition scores, AI memos, and PDF exports (every new egress path gets a confidentiality test + the `site-qc-reviewer` pattern).
- Local-first; mirror behind Cloudflare Access (default-deny). Secrets in env, never committed. ggoldberg-only routing; COM-only send. Financial endpoints gain authz before any non-local exposure.

## 3.11 IMPLEMENTATION ROADMAP

Each phase: worktree branch → TDD (test first, watched to fail) → `gate` green → independent local code review → **adversarial pass for any financial-decision code** → PR → CHANGELOG. Small, safe commits. Dev/preview servers stopped before returning (warehouse WAL lock). No governor/financial-constant change without explicit permission.

### Phase 1 — Foundation hardening & integrity (Revisions 1, 5 partial)
- **Objectives:** Merge the in-flight `feat/pfi-phase-b3` (close its Phase-7 gate/PR). Implement F1 (NOI A↔B reconciliation invariant; authoritative-source on `property_master`; basis surfaced + cross-basis block; `LedgerEntrySchema` as parse gate; `NOI_CLASSES` reference in SQL; automated one-time-item exclusions). Implement F8 (materialize `period_metrics`; add `scores`/`intel_findings`/`briefings` tables + dated snapshots) and F11 (occupancy time-series). Wire FRED into the engine layer + add `get_macro` agent tool. Add `ledger_entries(import_id)` index + metric memoization. Stand up the governance pattern (ratified vs. proposed) and the calibration-log skeleton.
- **Files:** `server/warehouse/{db,metrics,mapping,ingest,intel-config,reconcile}.ts`, new `server/warehouse/reconcile-noi.ts`, `src/contracts/warehouse.ts`, `scripts/warehouse-verify.ts`, `server/macro/*`, `server/ai/tools.ts`.
- **Data model:** +`period_metrics`,`scores`,`intel_findings`,`briefings`,`metric_snapshots`; +`basis` in PeriodMetrics; +`authoritative_source`,`occupancy` columns.
- **API:** reconciliation status endpoint; basis flag in analytics payloads.
- **UI:** Data Quality Center shows reconciliation deltas + basis warnings; score-provenance surfaced.
- **Testing:** reconciliation invariant (golden tie-out), basis-block unit tests, Zod ledger-gate tests, snapshot-history tests. **Migration:** backfill materialized metrics + occupancy from existing ledger.
- **Exit:** ledger NOI reconciled to workbook within tolerance for all 14 units; no silent cross-basis comparison anywhere.

### Phase 2 — Debt & Refi Intelligence + AI narrative briefings (F2, F3 — highest ROI / lowest risk)
- **Objectives:** `debt_register` table; warehouse-computed DSCR/LTV (from reconciled NOI); **Refinancing Opportunity Score** (book vs. FRED market rate, breakeven, post-refi LTV), floating-rate + equity-extraction flags; debt inputs into the health score. AI **narrative pass** over deterministic findings; **cadenced briefings** (wk/mo/qtr/yr) persisted + emailed (COM, ggoldberg-only). Branded PDF report suite (F12) scaffolded for the briefings.
- **Files:** new `server/warehouse/debt.ts`,`refi.ts`; `server/brief/{render,run,state,narrate}.ts`; `src/modules/debt/*`; new `functions`/Playwright PDF route; `server/ai/agent.ts` (tools + narrative).
- **Data model:** `debt_register`(loan, rate, type, maturity, balloon, amort, covenants, property_id); `briefings`.
- **API:** `/api/warehouse/debt`, `/analytics/refi`; briefing generate/list.
- **UI:** Debt module gains DSCR/refi-score columns, floating-rate + equity-extraction flags, refi workspace.
- **Testing:** refi-score math, DSCR-from-ledger, briefing assembly + no-API-key fallback, PDF extractable-text. **Adversarial pass** on refi/DSCR math (financial-decision code). **Migration:** seed `debt_register` from workbook loans, reconciled.

### Phase 3 — Forecast + Leasing/Tenant Intelligence (F5, F6, F4 v0 prep — Revisions 3, 4)
- **Objectives:** **Forecast Engine** (driver-based NOI/rev/exp, scenario ranges + confidence, `[FORECAST]`-tagged, human gate before feeding irreversible recs). **Leasing Intelligence:** tenant risk score, renewal probability, **mark-to-market** (in-place vs. market rent via `comps.ts`/rent-comp), lease risk. Begin porting the Buy Box scorecard from the `acquisition-underwriting` skill into a deterministic module (prep for Phase 4).
- **Files:** new `server/warehouse/forecast.ts`,`leasing-intel.ts`; `src/modules/tenants/*`,`leases/*`; `server/ai/comps.ts` (cache + wire).
- **Data model:** market-rent series in `market_series`; tenant credit fields.
- **UI:** Tenants module gains risk/renewal/MTM columns + verdict header; lease rows show MTM gap.
- **Testing:** forecast bounds/confidence, MTM math, renewal-probability calibration harness. **Adversarial pass** on forecast (reviewer told to refute projections). **Migration:** backfill tenant scores from snapshot + ledger.

### Phase 4 — Acquisition Intelligence Engine + Property Quality (F4, F9 — firm priority #1)
- **Objectives:** **Oxford Acquisition Score** (Market[confidence-bounded]/Asset/Basis/Risk → composite), Buy Box gates+floors ported from the ratified skill, deal ranking, **compare-to-portfolio** (warehouse benchmarks). Wire Notion/HubSpot **live** (retire seed-as-truth). **Property Characteristics** data model + **Functional Obsolescence** + **Property Quality Score** (Priority 2) feeding the Asset sub-score. Confidentiality guard on all acquisition surfaces.
- **Files:** new `server/warehouse/acquisition.ts`,`property-characteristics.ts`,`quality.ts`; `src/modules/acquisitions/*` (Workbench); `server/sources/{notion-deals,hubspot}.ts`.
- **Data model:** `property_characteristics`(year built, reno, SF, office%, clear height, column spacing, docks, drive-ins, trailer/IOS, parking, power, zoning); acquisition score fields on deals.
- **UI:** Acquisition Workbench — score breakdown, ranking, vs-portfolio, Buy/no-buy verdict w/ reasons + confidence.
- **Testing:** scorecard parity with the underwriting skill (golden cases), gate/floor logic, confidentiality redaction tests. **Adversarial pass** (capital-allocation-feeding code). **Migration:** characteristics seeded from OMs/lease abstracts via doc RAG where available, else pending-review.

### Phase 5 — Capital Allocation capstone + Market Intelligence (F7, F10 — Revisions 2, 5)
- **Objectives:** **Capital Allocation Engine** — Buy/Hold/Sell/Refinance/Improve per asset + portfolio, each with expected return, risk, timeline, confidence, made comparable by the ratified **hurdle-rate** governor; consumes forecast, refi, acquisition, leasing, quality engines. **Market Intelligence** (confidence-tagged public-data submarket scores; Enter/Expand/Maintain/Exit) as a modulating input. Finalize the **calibration loop** (score-vs-outcome report) and **data-driven property onboarding**. Confirm SQLite→Postgres migration readiness.
- **Files:** new `server/warehouse/capital-allocation.ts`,`market-intel.ts`,`calibration.ts`; `src/modules/{capital,market}/*`; admin onboarding path.
- **Data model:** `market_series`, `recommendations`(action, return, risk, timeline, confidence, inputs_version), `calibration_log`.
- **API:** `/analytics/capital-allocation`, `/analytics/market`.
- **UI:** Capital Allocation view (ranked actions across the whole portfolio + pipeline); Market module rebuilt with attractiveness scores + confidence.
- **Testing:** allocation-comparability math vs. hurdle rate, market-confidence propagation, calibration-report correctness. **Adversarial pass** (the capstone — refute every recommendation). **Governance:** present proposed weights + hurdle-rate to Gabriel for ratification.

---

## Cross-cutting (every phase)
- Deterministic-compute / LLM-narrate-only discipline.
- Provenance + confidence + `inputs_version` on every score; `[SPECULATIVE]`/`[FORECAST]` tags.
- Confidentiality guard on every new surface; ggoldberg-only routing; COM-only send.
- `gate` green + independent review + adversarial pass for financial-decision code before "done"; dev servers stopped before returning.
- Weight ratification is a governed event, not a code default.

## What this plan deliberately does NOT do
- Rebuild the warehouse (it exists and is tested).
- Buy CoStar-grade market data (procurement stance).
- Let any LLM compute a number that feeds a capital decision.
- Ship a forecast or capital recommendation as autopilot without a human gate.
- Expose warehouse intelligence to the public mirror (deferred until a redaction story is proven).

---
*End of plan. No code to be written until ratified.*
