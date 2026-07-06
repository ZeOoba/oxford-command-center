# Design Parity Audit — 2026-07-06

**Author:** Validation/Documentation session (task 7.5 of `IMPLEMENTATION_PLAN.md` §4 Phase 7).
**Scope:** Structural walkthrough of all 18 design pages in `design_handoff_ora_command_center/app/*.html` against the currently-shipped app (`src/shell/modules.tsx` registry, as read on 2026-07-06).
**Snapshot caveat:** Phase 7 (final polish) is being executed in parallel by other agents/sessions as this audit is written. `src/modules/overview/`, `src/shell/`, `src/modules/market/`, and `src/brain/DealDrawer.tsx` were **not modified** for this audit (read-only), but they may change again shortly after this document is committed — some findings below (Overview's results banner, the Market-module Comps tab, DealDrawer enrichment) describe work that Phase 7 is actively in flight to close. Re-verify against the live tree before treating a "gap" below as still open.

## What this audit is — and is not

This is a **structural** parity check: does the shipped module contain the design's key structural elements (a tier-board where the design has one, the expected KPI strip, the expected tab count, the expected panels)? It is **not** a visual/pixel parity check — that would require a running browser rendering real portfolio data side-by-side with the prototype HTML, which is not possible in this text-only research environment. Any statement below about layout, spacing, color, or animation fidelity is explicitly a structural inference from source code, not an observed rendering. Where the plan's own acceptance criteria call for a "screenshot" or "visual check," this audit says so and does not claim to have performed one.

Per `design_handoff_ora_command_center/README.md`, the binding design rule across the product is **no long single-column list** — ranked/ordered content must render as a `TierBoard` (tiered columns with per-tier counts and $ totals), never a flat scrollable list. Each page section below has a **No-long-lists compliance** line that specifically checks for violations of this rule; dense reference tables (asset tables, ledgers, rent rolls) are explicitly exempt per the plan's own verification protocol (§"Verification protocol" — "dense reference tables are exempt, the rule targets ranked action feeds").

---

## 1. Overview

- **Status:** Partial (in progress — Phase 7.1 not yet landed as of this reading)
- **Where it lives:** module id `overview`, `src/modules/overview/OverviewModule.tsx` (+ `widgets.tsx`, `InsightList.tsx`)
- **Structural parity check:** The design's KPI strip (5 metrics, each a clickable drill-in) is matched — actually exceeded — by the shipped `KpiStripWidget` (8 metrics: Value, NOI, SF, Occupancy, WALT, Total Debt, Equity Invested, Total Cash). The design's Portfolio Growth chart / Acquisition Pipeline list / Leases Expiring list are reconciled onto other modules (Portfolio, Acquisitions, Leases) rather than duplicated on Overview, which is a deliberate design-delta decision (D1(c)), not a gap. Missing: the design's `#resultsBar` ("NOI Upside Identified / Exposure At Risk / Open Actions") and the `PRIORITY ACTIONS` ranked TierBoard — this is exactly what plan task 7.1 is scoped to add (reusing the Phase 2 Insights feed), and it had not landed as of this reading.
- **No-long-lists compliance — VIOLATION FOUND:** `OverviewModule`'s "Insights & Alerts" widget (`widgets.tsx` → `InsightsWidget` → `InsightList.tsx`) renders ranked, severity-tagged, $-quantified insight content as a **flat single-column `<ul>`** with a "Show N more" pagination button, not a tier-board — even though the exact same underlying content is tier-boarded correctly on the `insights` module (`InsightsModule.tsx` uses `TierBoard`). This is a live instance of the rule the design explicitly calls out. See the v2 backlog — this is the highest-priority open item found in this audit, and per the plan it is precisely what 7.1 exists to fix.

## 2. Portfolio

- **Status:** Partial
- **Where it lives:** module id `portfolio`, `src/modules/portfolio/PortfolioModule.tsx`
- **Structural parity check:** KPI strip present (4: Value, NOI, SF, Weighted Cap Rate vs. design's 5 including Debt/LTV, which lives on the separate Debt module instead). The design's "By Market" table + "Composition" panel are covered by a `BarList` ("Value by Market"). The design's Portfolio Trends chart + Anomalies panel are intentionally reconciled onto the Intel module's Benchmarks/Property views instead of duplicated here (explicit plan decision, not a gap). The Assets table is present and richer than the design's (10 columns including DSCR/LTV/Lender vs. design's 8). Missing: the design's "RECOMMENDED ACTIONS" ranked panel (engine signals filtered to this page's categories) — no such panel exists on Portfolio today.
- **No-long-lists compliance:** No violation — the Assets table is a dense reference DataTable (sortable/filterable), which is exempt. There is no ranked-action list on this page at all (an absence, not a mis-shaped list).

## 3. Acquisitions

- **Status:** Shipped (structurally matches; one optional design element still missing)
- **Where it lives:** module id `pipeline`, `src/modules/acquisitions/AcquisitionsModule.tsx` (Pipeline tab) + `AcquisitionWorkbench.tsx`, `AcquisitionsIntel.tsx`, `RankedCandidateList.tsx`
- **Structural parity check:** KPI strip present (Active Deals / Closing Now / Best Active Cap / Pipeline SF — a different metric set than the design's Pipeline Value/Avg Score/Weighted/Avg Days in Stage, but the same 4-KPI pattern). The design's primary visual — a 5-column drag-card Kanban board grouped by stage — is **not** replicated; the shipped module instead uses a "Pipeline by Stage" `BarList` plus a sortable `DataTable` of all deals. Per the plan (task 3.5), the kanban board is explicitly marked optional, and drag-to-stage was never confirmed shipped.
- **No-long-lists compliance:** No violation found — the ranked-candidate content (`AcquisitionsIntel`, `RankedCandidateList`) is table-based (dense reference, exempt), and the T1/T2/PASS/KILLED grading distribution is tier-boarded correctly on the Grader tab (see below), not duplicated as a flat list here.

## 4. Grader

- **Status:** Shipped (mounted as a tab of Acquisitions, not a standalone page — this is the correct, plan-specified location)
- **Where it lives:** Acquisitions module, tab = "Grader" → `src/modules/acquisitions/GraderView.tsx` + `PipelineTierBoard.tsx`
- **Structural parity check:** Design's drop-zone/sample-chip/manual-entry intake → staggered extraction reveal → scorecard (gauge + verdict + criteria rows) → buy-box reference panel → auto-graded pipeline board is matched section-for-section: `OmImportDrawer` (real PDF extraction, not simulated) + a manual `FIELD_GROUPS` form feed the same `AcquisitionInput`; `ScorecardPanel` renders a `GaugeRing` + tier badge (T1/T2/PASS/KILLED) + verdict + Gates/Floors pass-fail checklists + 4 category subscore bars + reasons; `BuyBoxPanel` renders ruleset v1.0 **read-only** (the design's "EDITABLE" chip is deliberately dropped per D8); `PipelineTierBoard` renders a 4-column tier board (T1 Pursue / T2 Watch / Pass / Killed) sourced from the engine's own persisted `tier` field, never re-derived in the UI. The design's 3-tier board (Buy Box Fits / Tradeable / Below Mandate, using its own inferred 80/66 letter-grade bands) is correctly superseded by the ratified ruleset's own T1/T2/PASS/KILLED bands (D8, C9) rather than reproduced.
- **No-long-lists compliance:** Compliant — `PipelineTierBoard` is a genuine 4-column `TierBoard`.
- **Unverified (visual only):** the design's staggered field-reveal animation on extraction is a cosmetic/motion detail this audit cannot confirm or deny without a running browser.

## 5. Leases

- **Status:** Shipped
- **Where it lives:** module id `leases` → `src/modules/leases/LeasesModule.tsx`; a separate, additive module id `leasing` → `src/modules/leasing/LeaseForecastModule.tsx`
- **Structural parity check:** KPI strip present (WALT / Annualized Rent / Expiring ≤90d / Holding Over vs. design's Expiring≤90d/Below-Market/Rent-at-Risk/Renewal-Rate — different mix, same pattern). Design's expiry timeline bar chart is matched by "Lease Rollover Schedule" (`BarChart`). Design's "Expiring Leases" table is matched and exceeded by "Critical Dates" (adds escalations/notice-deadlines, not just expirations) and a full searchable/filterable "Rent Roll" table with CSV export. The separate `leasing` module (not in the design's page list) adds expiry-bucket cards, a rent-forecast scenario tool, a leasing-velocity table, a market-rent editor, and an AI leasing narrative — all Phase 3 content beyond the design's scope. Missing: the design's "RECOMMENDED ACTIONS" ranked panel (same gap class as Portfolio).
- **No-long-lists compliance:** No violation — all ranked/ordered content is table-based (dense reference, exempt).

## 6. Financials

- **Status:** Reconciled-into-existing-module (cut-list C1 — see the companion cut-list reconciliation doc for full reasoning)
- **Where it lives:** N/A as a single page. Reconciled across Cash module (`cash`), Close module (`close`), Leases module (`leases`, rent roll), and Tenants module (`tenants`, arrears/AR).
- **Structural parity check:** Confirmed absent from the shipped app: a general ledger (journal-entry table with debit/credit balancing) and an accounts-payable bill queue — neither has any data source or module anywhere in `src/modules/`. The remaining panels (Operating Statement/BvA, Cash Position, Debt Summary, Rent Roll, A/R aging) each have a real analog on a different module, confirmed by reading each: `CashModule.tsx` (entity balances + trend), `CloseModule.tsx` (budget-vs-actual NOI + QuickBooks actuals), `DebtModule.tsx` (positions + scorecard), `LeasesModule.tsx` (rent roll), Tenants module (arrears via `tenantArrears`, confirmed present in `src/analytics/conditions.ts` and `src/contracts/quickbooks.ts`).
- **No-long-lists compliance:** N/A (no single page to check).

## 7. Taxes

- **Status:** Shipped (2 of the design's 3 tabs; the 3rd is deliberately out of scope — see cut-list C2)
- **Where it lives:** module id `taxes` → `src/modules/taxes/TaxesModule.tsx` + `StrategyBoard.tsx` + `AssessmentsTable.tsx`
- **Structural parity check:** 4-KPI strip matches the design's set (Annual Property Tax / Effective Rate / Identified Opportunity / Appeals in Flight) — and is stricter, since each KPI's sublabel discloses its ownership basis (full-asset vs. Oxford-share), a distinction the design does not carry. "Strategy Board" tab renders a genuine 2-tier `TierBoard` (Appeals / Assessment Watch) plus a static "Additional Strategies — Deferred" informational card that explicitly tells the user why the design's 3rd category (Depreciation & Cost-Seg / Structure & Pipeline) isn't there, rather than fabricating placeholder cards. "Assessments & Appeals" tab is a `DataTable` with a "File Appeal" writeback action, matching the design's assessed-vs-market table + appeal-opportunity panel. The design's "Filed Returns" tab is absent, correctly, per the confidentiality boundary.
- **No-long-lists compliance:** Compliant — Strategy Board is a genuine `TierBoard`, not a flat list.

## 8. Insurance

- **Status:** Shipped (2 of the design's 3 tabs; the 3rd is data-gated — see cut-list C11)
- **Where it lives:** module id `insurance` → `src/modules/insurance/InsuranceModule.tsx` + `SavingsBoard.tsx`
- **Structural parity check:** 4-KPI strip matches the design's set in spirit, with one deliberate relabeling: the design's "Identified Savings" KPI is shipped as "Premium Above Median" — an intentional honesty correction (the underlying figure is dispersion vs. an own-book median, never a market-verified savings claim; documented in `hooks.ts` and `SavingsBoard.tsx` header comments). "Savings Board" tab is a genuine 2-tier `TierBoard` ("Re-bid — above book median" / "Renewal watch") vs. the design's 3 tiers (Re-bid / Optimize Coverage / Retain Risk) — the "Optimize"/deductible-review tier has no data source yet (gated on broker SOV/dec-page data, P4c) and is correctly omitted rather than faked. "Policy Register" tab is a `DataTable` with a renewal-countdown `Badge` column, thinner than the design's dedicated renewal-calendar side panel (`.renewbar` visual) but functionally equivalent. The design's "Self-Insure & Bids" tab is entirely absent, correctly, pending real loss-run data.
- **No-long-lists compliance:** Compliant — Savings Board is a genuine `TierBoard`.

## 9. Studio

- **Status:** Deferred (cut-list C3)
- **Where it lives:** N/A — see cut-list reconciliation doc. No cross-filter engine or Studio-equivalent module exists anywhere in `src/`.
- **Structural parity check:** N/A.
- **No-long-lists compliance:** N/A.

## 10. Operations

- **Status:** Deferred (cut-list C4)
- **Where it lives:** N/A for work orders/units/turns (confirmed: no such contract or module exists). The Tenants module (`tenants`) covers only the tenant-ledger slice of this design page.
- **Structural parity check:** N/A for the missing pieces.
- **No-long-lists compliance:** N/A.

## 11. Comps

- **Status:** Partial — in progress (Phase 7.3 targets a Market-module tab; not landed as of this reading)
- **Where it lives:** today, comps data exists only as a per-deal AI-sourced overlay inside the deal detail drawer (`src/brain/DealDrawer.tsx`, right-hand "Market Comps" panel, contract `src/contracts/comps.ts`, `snapshot.dealComps[dealId]`). No standalone Comps page and no Market-module tab exists yet (confirmed by reading `src/modules/market/MarketModule.tsx` in full — it has a macro-indicator strip, a 10Y Treasury chart, an "Acquisition Lens" cap-spread card, and a "Market Intelligence" per-cluster scorecard section, but no comps view).
- **Structural parity check:** The design's KPI strip, Subject panel + comp map, Sales/Lease Comparables tables, and Submarket Trends (cap-rate trend chart, rent-growth chart, submarket scorecard table) have no portfolio-wide equivalent yet — only the per-deal drill-down described above.
- **No-long-lists compliance:** The per-deal comps panel renders short (typically single-digit) sale/rent comp lists as simple cards, not a tier board — acceptable at this scale since the content isn't ranked/$-quantified, but worth noting once a portfolio-wide comps surface is built.

## 12. Inbox

- **Status:** Dropped, reconciled into an existing module (cut-list C5)
- **Where it lives:** N/A for a literal inbox. Alerts module (`alerts`, `src/modules/alerts/AlertsModule.tsx`) is the production actionable-queue analog; `src/brain/DraftPanel.tsx` is the draft-only outbound-reply analog.
- **Structural parity check:** N/A for a literal inbox.
- **No-long-lists compliance:** The Alerts module analog is itself fully compliant — a genuine 3-column `TierBoard` (Critical/Warning/Info) with per-card Read/Snooze(7d,30d)/Draft/View actions, confirmed by reading `AlertsModule.tsx` in full.

## 13. Insights

- **Status:** Shipped — the plan's own "flagship no-long-lists surface"
- **Where it lives:** module id `insights` → `src/modules/insights/InsightsModule.tsx` + `insights.logic.ts`
- **Structural parity check:** Matches the design closely: category filter pills (dynamic, driven by live category counts rather than the design's fixed set), a results-summary header (shipped as per-**spine** subtotals — "Risk Impact" and "Monitor Impact" each broken out by Spine A vs. Spine B/cross — which is *stricter* than the design's single blended banner number, per the repo's mixed-basis discipline), and a genuine 3-tier `TierBoard` with tier keys/titles `critical`/"Critical", `priority`/"Priority", `monitor`/"Monitor" (confirmed in `insights.logic.ts`) matching the design's Critical/Priority/Monitor tiers exactly. An "unratified ranking weights" badge is shown, correctly, since `INSIGHT_CONFIG`'s 0.5/0.3/0.2 weights are proposed, not yet ratified by Gabriel.
- **No-long-lists compliance:** Fully compliant.

## 14. News

- **Status:** Partial (cut-list C6, partial drop)
- **Where it lives:** module id `market` → `src/modules/market/MarketModule.tsx`. No dedicated News page.
- **Structural parity check:** The design's rates ticker / target-market-trends slice is covered (FRED macro KPI strip, 10Y Treasury AreaChart, "Acquisition Lens" cap-spread card, and a per-cluster "Market Intelligence" scorecard section covering regional dynamics/state unemployment). Entirely absent, correctly per the cut list: the Daily Briefing feed, National CRE Trend cards, Regulation & Tax Law tracker, and White Papers/Case Study library — none has a real content source in this repo.
- **No-long-lists compliance:** N/A — no ranked-list content in this page's shipped scope.

## 15. Brain

- **Status:** Shipped (as `command-brain`, deliberately named apart from the pre-existing `src/brain/` client-chrome layer)
- **Where it lives:** module id `command-brain` → `src/modules/command-brain/CommandBrainModule.tsx` + `MemoryBoard.tsx` + `TrackRecordList.tsx`
- **Structural parity check:** 4-KPI strip present (Flag Accuracy / Signals Watched / Recalibrations / Resolved Outcomes) — the 4th KPI deliberately substitutes the design's "Learned From... data points" (one of the explicitly fabricated figures, cut-list C10) with a real, calibration-derived "Resolved Outcomes" count. The accuracy-over-time chart is shipped as **segmented** sparklines with genuine gaps for any month with fewer than 5 scoreable verdicts (an honesty gate; the design instead shows one continuous, scripted-upward line). `TrackRecordList` is a `DataTable` with exactly 3 outcome states (hit/miss/not-scoreable) — the design's fabricated 4th state, "partial," does not exist in the contract and is not reproduced. `MemoryBoard` **is** a genuine 3-column `TierBoard`, but its tiers are "Well-covered" / "Building coverage" / "Sparse" — confidence-by-cohort buckets (market + manager combined) — **not** the design's literal "Settled / Forming / Hypotheses" narrative-memory-entry board; `MemoryBoard.tsx`'s own header comment states this is deliberate, since nothing in the `BrainReport` contract stores narrative memory entries the way the design's `brain.js` fabricates them. The "Feedback" card reuses the same Open Questions list as its actionable feed rather than a separate top-5 ranked-insights feed with accept/dismiss (the design's literal Feedback Loop) — the module's own header comment states this is out of scope for v1. A Version Log is present.
- **No-long-lists compliance:** `MemoryBoard` is compliant (genuine `TierBoard`). `TrackRecordList` and the Version Log are dense reference lists/tables (exempt). The "Open Questions" section renders as a plain vertical list of cards — a short, non-$-ranked diagnostic list (data-quality issues + dormant generators), which is a borderline case but not flagged as a hard violation since it isn't ranked $-impact content.

## 16. Property (detail)

- **Status:** Reconciled into an existing module, different shape (per the plan's own gap matrix)
- **Where it lives:** N/A as a single dedicated page. `PropertyIntelView.tsx` inside the Intel module (`intel`, tab = "Property") for the deep verdict-first view; the generic `src/brain/EntityDrawer.tsx` for the lightweight popup reached from row-clicks elsewhere (Portfolio, Leases, etc.).
- **Structural parity check:** The design's 5-tab shape (Snapshot / Leases / Trends / Month-End Report / Maintenance) is not replicated tab-for-tab; `PropertyIntelView.tsx` instead follows a verdict → root-cause → recommendation structure per the plan's own characterization. **This audit did not do a line-by-line read of `PropertyIntelView.tsx`'s internals** (out of scope for the budget of this pass) — flagged here as an incomplete structural check, not a confirmed gap. The plan itself defers the "does a dedicated property page add value over the Intel tab" question to Phase 7 polish.
- **No-long-lists compliance:** Not independently verified this pass.

## 17. DealRoom (detail)

- **Status:** Shipped (different internal composition, same functional surface); enrichment (7.4) may be in flight
- **Where it lives:** `src/brain/DealDrawer.tsx` (opened via `EntityDrawer` for `type: 'deal'`), plus `AcquisitionWorkbench` for underwriting and `ic-memo.ts` for IC memo export.
- **Structural parity check:** Design's hero stat-grid (price/cap/IRR/EM) is matched. Design's Deal Stage timeline is matched by `StageTrack` (a 6-step progress bar). Design's Underwriting panel is matched (`Underwriting Assumptions` + `Returns` cards, bound to real `AcquisitionInput`/score data). The shipped drawer adds a "Replacement Cost" analysis card and a "Risk Flags" card, neither of which the design has. Design's DD Checklist (with a progress meter) is **absent** — confirmed no checklist UI or overlay state exists in `DealDrawer.tsx` (plan task 7.4 marks this optional, "if wanted"). Design's Equity Partners panel is absent, correctly, since no investor entity exists anywhere (see Investor, below). Design's Documents panel is absent — no document-storage backend was found. The design's static "Market Comps" panel is matched and exceeded: a real AI-sourced (web-search) sale-comps/rent-comps/submarket-stats panel with a Refresh action, versus the design's static seeded comp map.
- **No-long-lists compliance:** "Risk Flags" renders as a plain `<ul>` — a short (0–6 item), non-$-ranked diagnostic list, not a violation under the "ranked $-impact action feed" definition the rule targets.

## 18. Investor (detail)

- **Status:** No-data-source (cut-list C8, deferred pending decision D7)
- **Where it lives:** N/A. Confirmed no LP/investor/capital-account entity exists anywhere in `src/contracts/` or the workbook parser; confirmed further by the shipped `DealDrawer.tsx` having no "Equity Partners" card at all (not even a stub), consistent with there being no investor data anywhere to surface.
- **Structural parity check:** N/A.
- **No-long-lists compliance:** N/A.

---

## v2 Backlog (aggregated across all 18 pages, prioritized by judgment of business value)

### High priority

1. **Overview — ship the results banner + PRIORITY ACTIONS TierBoard (plan task 7.1).** This is the one confirmed, live no-long-lists violation found in this audit: the Overview page's "Insights & Alerts" widget is still a flat, paginated `<ul>` even though the identical underlying data is already correctly tier-boarded on the `insights` module. Since Overview is the Command-group landing page, this is the most visible instance of the rule's violation in the shipped app today.
2. **Comps — land the Market-module tab (plan task 7.3).** This is the only one of the 18 design pages with zero portfolio-wide surface at all; today the only comps data anywhere is a per-deal AI-sourced side panel. `CompSet` and `getMacroMarketBenchmarks` already exist and are unused for this purpose.
3. **Command Brain — wire Feedback accept/dismiss to the ranked Insights feed, not just Open Questions.** The design's literal Feedback Loop operates on the top-5 $-ranked signals; the shipped module explicitly scopes this out for v1 (its own code comments say so) and reuses the diagnostic Open Questions list instead. This is a real structural gap vs. the design, not merely a cosmetic one, and the plan itself already earmarks it as a v2 item.

### Medium priority

4. **A repeatable "Recommended Actions" ranked panel for Assets-group modules (Portfolio, Leases, and by the same pattern any future module).** The design repeats a small `modActions` TierBoard-adjacent panel (engine signals filtered to that page's categories) on nearly every page — Portfolio, Leases, Financials-equivalents, Operations, Comps, Studio. Only `insights` (and, once 7.1 lands, `overview`) currently have this. A shared component consuming the same merged insights feed, filterable by category, would close this gap cheaply across several pages at once.
5. **Acquisitions — kanban stage-board view (plan task 3.5, marked optional).** The design's primary visual for this page (drag cards across 5 stage columns) is not replicated; the shipped module uses a stage `BarList` + sortable table instead.
6. **Property detail — resolve whether IntelModule's verdict-first "Property" tab should also carry the design's literal 5-tab shape (Snapshot/Leases/Trends/Month-End/Maintenance), or formally ratify the current shape as the intended replacement.** This audit could not complete a full internal read of `PropertyIntelView.tsx` and flags this as an open question rather than a confirmed gap.
7. **DealRoom — DD checklist persisted state and a Documents panel.** Both are explicitly optional per the plan (task 7.4) but are real, acknowledged gaps vs. the design.
8. **Insurance — a dedicated renewal-calendar visual panel.** Currently a table column (Days badge) rather than the design's `.renewbar` calendar visualization; low effort, cosmetic.

### Low priority / explicitly out of scope (see cut-list reconciliation doc for full reasoning)

9. Studio, Operations, Investor, Inbox, News editorial content, Taxes filed-returns/cost-seg, Insurance self-insure math — all correctly absent per the ratified cut list; no action recommended unless the underlying data-source or scope decision changes (see `docs/design-handoff-cut-list-reconciliation.md`).
10. News — the design's click-a-rate-to-feature interactivity is not replicated (a single fixed 10Y chart instead); cosmetic.
11. Insurance — the "Self-Insure & Bids" tab (P4c) once real loss-run/dec-page data arrives; this is fully data-gated, not a UI decision.
12. Taxes — the Depreciation & Cost-Seg / Structure & Pipeline strategy tier once accountant depreciable-basis data exists; also fully data-gated.
