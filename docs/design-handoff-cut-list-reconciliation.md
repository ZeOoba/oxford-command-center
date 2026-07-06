# Design Handoff Cut-List Reconciliation

**Author:** Documentation session (task 7.6 of `IMPLEMENTATION_PLAN.md` §4 Phase 7).
**Purpose:** This document exists so that Gabriel — or a future session with no memory of the analysis that produced `IMPLEMENTATION_PLAN.md` — can answer "why isn't there a Financials page?" (or a Studio, an Inbox, an Investor page, etc.) without re-deriving the reasoning from scratch. It stands on its own; no other document needs to be open to understand it.

## Background, for a reader with no context

In mid-2026 this repo was handed a **design prototype** (`design_handoff_ora_command_center/`) — a set of 18 static HTML pages showing the intended look, information architecture, and interaction model for a rebuilt "Oxford Command Center." The prototype's own README is explicit that it is a *design reference*, not code to ship: **"the prototype's shape is the contract; its numbers are fake."** A planning session (2026-07-05, producing `IMPLEMENTATION_PLAN.md`) compared all 18 prototype pages against this repo's actual, real data and engines, and decided — with reasons recorded in the plan's §6 "Cut list" — that **11 design elements would not be built**, either permanently or until a specific precondition (new data source, Gabriel decision, confidentiality clearance) is met.

Each of the 11 items below follows the same three-part shape:
- **What the design asked for** — the literal prototype page/feature.
- **Why it was cut** — quoted/paraphrased from `IMPLEMENTATION_PLAN.md` §6, with the item's cut-list ID (C1–C11) so you can find the original entry.
- **What serves that need today** — the actual shipped module/surface a user reaches for instead, named specifically (module id + file path + what a user does there).

---

## C1 — Financials page (Statements / GL / A/R / A/P / Rent Roll / Budget vs. Actual)

**What the design asked for:** `Financials.html` — a Yardi-Voyager-style single page with six tabs: a consolidated Operating Statement (actual vs. budget) plus a Cash Position and Debt Summary side panel; a General Ledger of every journal entry for the period (debits/credits, balanced); an Accounts Receivable aging table + collections stats; an Accounts Payable bill queue; a Rent Roll summary and by-property breakdown; and a Budget vs. Actual variance view with a CapEx budget tracker.

**Why it was cut:** Plan §6, item C1: *"Reconcile, don't build — Duplicates Intel (statements, BvA), Cash, Close, Leases (rent roll); GL/AP have no data source. AR exists via `tenantArrears`."* In other words: five of the six tabs already have a real home elsewhere in the product, and the remaining two (GL, AP) have no underlying data at all — there is no general-ledger export or accounts-payable feed anywhere in the two data spines (the workbook, or the P&L warehouse).

**What serves that need today:**
- **Operating Statement / Budget vs. Actual** → the **Monthly Close** module (id `close`, `src/modules/close/CloseModule.tsx`). A user opens Close to see Actual NOI vs. Budget NOI vs. Variance vs. Expense Ratio, a per-property budget-vs-actual table, and (if a QuickBooks export is configured) real QuickBooks actuals; budgets are editable inline even without QuickBooks.
- **Cash Position** → the **Cash** module (id `cash`, `src/modules/cash/CashModule.tsx`). A user sees total cash, per-entity balances, period-over-period deltas, concentration, and a 12-month trend chart.
- **Debt Summary** → the **Debt** module (id `debt`, `src/modules/debt/DebtModule.tsx`). A user sees external debt, weighted average rate, annual debt service, a maturity ladder chart, a balloon-maturity watch card, and the full loan-position table.
- **Rent Roll** → the **Leases** module (id `leases`, `src/modules/leases/LeasesModule.tsx`). Its "Rent Roll" table (with search/filter/CSV export) is the same underlying data as the design's Rent Roll tab.
- **A/R Aging** → the **Tenants** module (id `tenants`, `src/modules/tenants/TenantsModule.tsx`) surfaces tenant balances and standing (via `tenantArrears`, computed in `src/analytics/conditions.ts` from data sourced through `src/contracts/quickbooks.ts`). This is not a dedicated aging-bucket table like the design's, but it is the same underlying receivables signal.
- **General Ledger and Accounts Payable** → **nothing serves this today.** There is no journal-entry ledger and no AP bill queue anywhere in the product. This is a genuine, acknowledged data gap (not a UI decision) — it would need a new ingestion path (e.g., a QuickBooks/property-management-system GL and AP export) before either tab could be built honestly.

---

## C2 — Taxes: Filed-Returns archive + cost-seg/bonus-depreciation engine + entity/pipeline structuring strategies

**What the design asked for:** `Taxes.html`'s third tab, "Filed Returns" — a year-by-year archive of filed tax returns (EGI, depreciation, bonus depreciation / cost-segregation, taxable income, filing status) with AI-generated review notes per year — plus two of the three Strategy Board categories: "Depreciation & Cost-Seg" (first-year deferral via cost segregation and bonus depreciation) and "Structure & Pipeline" (entity structuring, 1031 exchange strategy).

**Why it was cut:** Plan §6, item C2: *"Defer (out of v1) — Filed returns collide with the confidentiality boundary (docs RAG blocks tax returns; CLAUDE.md §9); cost-seg needs depreciable-basis/land-allocation sources that don't exist in-repo; prototype's marginal-rate/bonus constants are placeholders. Revisit with Gabriel's accountant data."* Two independent blockers: (1) `server/sources/documents.ts` explicitly excludes "GDG tax return" / 1031 documents from the RAG document index, and `confidential-terms.json` is hook-blocked from ever being surfaced (CLAUDE.md §9) — filed tax returns are exactly the kind of document this boundary exists to protect; (2) even setting confidentiality aside, computing real cost-segregation/bonus-depreciation savings requires a depreciable-basis and land-allocation breakdown per property that does not exist anywhere in this repo's data.

**What serves that need today:** The **Taxes** module (id `taxes`, `src/modules/taxes/TaxesModule.tsx`) ships only what the ratified data supports: a "Strategy Board" tab with two real tiers — **Appeals** and **Assessment Watch** — computed from the real ledger tax expense and real assessed-value data. Rather than silently omitting the missing categories, `StrategyBoard.tsx` renders a third, static "Additional Strategies — Deferred" card that tells the user directly: *"Cost-seg, depreciation, and entity-structuring strategies require depreciable-basis and land-allocation data not yet in this system — deferred pending that data source."* There is no Filed Returns tab anywhere, and no tax-return document is ever indexed or surfaced. A user who wants filed-return-level detail should ask Gabriel's accountant directly — that data intentionally does not flow through this product.

---

## C3 — Studio (Tableau-style cross-filter analytics)

**What the design asked for:** `Studio.html` — a cross-filtering analytics workspace where clicking any bar, scatter point, or heatmap cell filters every other chart on the page simultaneously: AUM-by-market bars, AUM-by-subtype bars, a cap-rate-vs-occupancy scatter plot, a market×subtype intensity heatmap, and a filtered asset table, all driven by one shared filter state (`studio.js`).

**Why it was cut:** Plan §6, item C3: *"Defer — High effort; Intel covers the analytical questions; revisit after parity phases."* The generalized click-to-cross-filter interaction pattern itself is a significant, novel UI investment, and the plan judged that the *questions* a user would ask Studio (which markets/subtypes are strong or weak, how does cap rate relate to occupancy) are already answerable through existing surfaces — just not through one unified cross-filter interaction.

**What serves that need today:** The **Property Financial Intelligence** module (id `intel`, `src/modules/intel/IntelModule.tsx`) is where this reasoning happens today — specifically its **Benchmarks** tab (`BenchmarksView.tsx`: period/metric cohort rankings, quartiles, a NOI-by-property matrix) and its **Property** tab (`PropertyIntelView.tsx`: verdict → root cause → recommendation per asset). The **Portfolio** module's "Value by Market" `BarList` gives the market-slice view Studio's first chart would give. None of these let a user click one chart to filter all the others — a user instead navigates between Intel's tabs and Portfolio to assemble the same picture manually.

---

## C4 — Operations (work orders / unit turns / turn costs)

**What the design asked for:** `Operations.html` — an AppFolio-style operations page: an open work-order queue triaged by priority (with SLA status and a by-category breakdown), a unit-status/turn tracker (vacant/in-turn/notice, days vacant, market rent per unit), and a tenant ledger tab showing balances and delinquency.

**Why it was cut:** Plan §6, item C4: *"Defer — No WO/unit data source; needs PM-system export feed first."* Unlike most of the other cut items, this one has essentially zero data-model overlap with anything already in the two spines — no property-management system (AppFolio, Yardi, etc.) export for work orders or unit-level turn data has ever been wired into this repo.

**What serves that need today:** The **Tenants** module (id `tenants`, `src/modules/tenants/TenantsModule.tsx`) covers only the third tab's slice — tenant scorecards, balances, and renewal-stage tracking (via `tenantScorecards` in `src/brain/tenants.ts`) — with a note-taking action a user can attach to a tenant. The work-order queue and unit-turn tracker have **no shipped equivalent anywhere**; this is a pure data-source gap. Building this well requires a PM-system export feed to arrive first, which is why the plan defers it rather than scoping a UI-only stopgap.

---

## C5 — Inbox (threaded email + reply/snooze)

**What the design asked for:** `Inbox.html` — a threaded action inbox: incoming messages (from brokers, lenders, counsel, tenants, internal analysts) tied to the deal or lease they touch, filterable by Overdue/Today/Deals/Leases/Capital, with per-thread Reply/Snooze/Done buttons.

**Why it was cut:** Plan §6, item C5: *"Drop — Alerts module is the production actionable-queue; email threading/drafting exists only as DraftPanel (draft-only by design)."* The prototype's Inbox is really "what needs my attention, tied to an entity" — which is the same job the Alerts module already does with real, structured, $-quantified data, rather than simulated email threads. Actually reading and threading live email would require a mail-provider integration this product does not have and was never asked to build.

**What serves that need today:** The **Alerts** module (id `alerts`, `src/modules/alerts/AlertsModule.tsx`) is the direct production analog: a genuine 3-tier `TierBoard` (Critical / Warning / Info) of actionable insights, each card carrying Read/Unread, Snooze 7d, Snooze 30d, Draft, and View actions — this is the "what's waiting on me" surface a user reaches for instead of an inbox. **`src/brain/DraftPanel.tsx`** is the reply-composition analog: given an insight or entity, it composes an outbound email/LOI draft — but by design it only produces a draft the user copies out; it never sends anything, because there is no live email-send integration. A user who wants "what needs my reply today" opens Alerts, not an inbox.

---

## C6 — News (briefing feed, regulation tracker, research library) — partial drop

**What the design asked for:** `News.html` — a two-layout (Briefing/Terminal) macro page: a live rates ticker, a curated "Daily Briefing" tied to the user's own book, National CRE Trend cards, a Target-Market Trends table for the firm's 5 core markets, a "Regulation & Tax Law" tracker of recent policy changes with book-impact notes, and a "White Papers & Case Studies" research library.

**Why it was cut:** Plan §6, item C6: *"Partial drop — Rates/market data live in Market (FRED, real). Hand-authored editorial feeds have no source and would rot."* The rates and target-market-trend content is real (FRED-sourced) and already has a home; the editorial content (briefing narrative, regulation tracker, research papers) would have to be hand-authored with no automated source, and hand-authored content in a product like this goes stale and becomes a maintenance burden nobody owns.

**What serves that need today:** The **Market** module (id `market`, `src/modules/market/MarketModule.tsx`) ships exactly the real slice: a FRED macro-indicator KPI strip (10-Year Treasury and others, each with a MoM-change sublabel), a "10-Year Treasury — 12-Month Path" area chart, an "Acquisition Lens" card computing the cap-rate spread over the risk-free rate, and a "Market Intelligence" section with per-cluster regional-dynamics scorecards (including state unemployment data). The Daily Briefing feed, National CRE Trend cards, Regulation & Tax Law tracker, and White Papers library have **no shipped equivalent anywhere** — deliberately; there is no plan to hand-author this content.

---

## C7 — Overview "Focus Lens" React tweaks panel

**What the design asked for:** `Overview.html` embeds a small CDN-loaded React panel (`tweaks-root`, loaded via `unpkg.com` + in-browser Babel — explicitly a prototype-only hack) offering a "Lens" picker (Balanced / Attention / NOI Growth / Risk) that visually focuses (`box-shadow`) or dims (`opacity`/`filter`) specific Overview panels depending on the selected goal, plus an accent-color picker and a density picker (compact/comfortable/spacious).

**Why it was cut:** Plan §6, item C7: *"Drop — Prototype-only experiment (CDN React); density/theme toggles already exist."* The panel's own implementation is explicitly a prototype convenience (it CDN-loads React and Babel at runtime, which is not a pattern this codebase uses anywhere), and the genuinely useful part of it — a persistent density and theme preference — already exists as real shell chrome.

**What serves that need today:** The application's real theme (command/parchment) and density toggles are part of the shell chrome (not the Overview page itself) and already give the persistent global preference the design's Tweaks panel partially duplicated. There is no per-panel "lens" focus/dim mechanism anywhere, and none is planned. The closest present-day analog for "customize what I see" is `OverviewModule.tsx`'s widget **Edit Layout** mode (`ws.editMode`) — a user can hide, show, and drag-reorder whole widgets — which achieves a similar end (a personalized view of Overview) through genuine widget visibility rather than an opacity-based "lens."

---

## C8 — Investor detail (LP capital accounts, NAV/DPI/TVPI, capital calls)

**What the design asked for:** `Investor.html` — a per-investor detail page: a capital account ledger (contributions, return-of-capital distributions, profit distributions, unrealized gain, NAV), a DPI/TVPI header stat, a quarterly distribution-history bar chart, a holdings-by-fund list, an open-capital-call panel with "Send reminder"/"Mark funded" actions, and a documents panel (K-1s, subscription agreements, investor reports).

**Why it was cut:** Plan §6, item C8: *"Defer pending D7 (does Gabriel want LP tracking? source: fund admin/Excel?) — No investor entity or fund-admin source anywhere in the repo."* This is the most clear-cut of the 11 cuts: it isn't that the data exists elsewhere and got reconciled — no LP/investor/capital-account concept exists **anywhere** in this repo's contracts, workbook tabs, or warehouse schema. Building it would require both a decision (does the firm want LP-level reporting inside this tool at all — decision point D7 in the plan, still open) and a brand-new data source (a fund administrator export or a dedicated capital-accounts workbook).

**What serves that need today:** **Nothing.** This is a genuine, acknowledged absence, not a reconciliation. Confirming this: the shipped Deal Room analog (`src/brain/DealDrawer.tsx`) doesn't even have a stub "Equity Partners" card — the design's DealRoom page links out to Investor.html from its Equity Partners panel, and since the shipped DealDrawer never built that panel in the first place, there is no dangling reference to investor data anywhere in the live app. If Gabriel decides he wants LP tracking (D7), that becomes a new, separate initiative — not a polish item on top of anything already shipped.

---

## C9 — Prototype letter grades (A+–F) + its 10-criterion buy box + 38-point deal-breaker cap

**What the design asked for:** `Grader.html`'s scoring output is a **letter grade** (A+ through F) computed from the prototype's own inferred buy box (`grader.js`'s `BUYBOX`): shallow-bay industrial/flex, Class B/C, 5 core markets, $3–20M, going-in cap ≥7.0%, levered IRR ≥14%, equity multiple ≥1.7x, LTV ≤55%, 80–96% occupancy, 1985+ vintage — a 10-criterion weighted scorecard with a deal-breaker cap, and an "editable" buy-box reference panel.

**Why it was cut:** Plan §6, item C9: *"Drop (superseded) — Ruleset v1.0 is ratified law (hard rule 3); its bands/verdicts render instead (D8)."* The firm's actual, Gabriel-ratified buy box (`config/acquisition-ruleset.v1.json`, ratified 2026-06-14) is a materially different instrument from the prototype's inferred default: a $0.5–10M single-asset gate (not $3–20M), different physical/flood/ground-lease gates, a 25–30% basis-discount floor and an 8% YoC floor (concepts the prototype doesn't have at all), a 7-category 100-point scorecard (not the prototype's 10 criteria), and T1/T2/PASS/KILLED tier bands (not a letter scale). Decision D8 in the plan settles that the product should display the ratified engine's own vocabulary, not a cosmetic letter-grade remap of it — *"a letter scale implies bands nobody ratified; the scorecard's own bands are the truth."*

**What serves that need today:** The **Grader** view (Acquisitions module → Grader tab, `src/modules/acquisitions/GraderView.tsx`) renders the ratified engine's real output directly: a 0–100 composite score in a `GaugeRing`, a tier badge (T1 Pursue / T2 Watch / PASS / KILLED), a verdict string, pass/fail checklists for the ruleset's Gates and Floors, and 4 category subscore bars — with a `BuyBoxPanel` rendering ruleset v1.0 **read-only** (the prototype's "EDITABLE" chip is deliberately dropped; the file's own code comment states any change to a gate/floor/weight/band requires a brand-new ratified version, never an in-place edit). A user who wants to know "what grade did this deal get" reads the tier + composite, not a letter.

---

## C10 — Brain: fabricated memory entries, click-driven accuracy ramp, fixed "6 models" count

**What the design asked for:** `Brain.html`'s `brain.js` seeds a handful of literal "learned memory" cards (e.g., a specific market or manager insight presented with a fabricated confidence percentage), an accuracy KPI that visibly ticks upward every time the user clicks Accept or Dismiss in the Feedback Loop (a scripted `localStorage`-persisted animation, not a real model update), and a fixed "6 models" figure in the "Learned From" KPI's sublabel.

**Why it was cut:** Plan §6, item C10: *"Drop (replaced by honest derivations) — P5 derives everything from calibration/insights/DQ; theatrical numbers violate the repo's provenance doctrine."* This repo has a strict rule (stated repeatedly across `CLAUDE.md` and the plan) that every dollar or confidence figure shown to a user must trace to a real, resolved computation or render as an honest absence — never an invented number designed to look impressive. The prototype's Brain page is the one place in the whole design handoff that most directly violates that rule, since its entire premise is a simulated "self-improving AI" with no real learning behind it.

**What serves that need today:** The **Command Brain** module (id `command-brain`, `src/modules/command-brain/CommandBrainModule.tsx` + `MemoryBoard.tsx`) replaces every fabricated element with a real, derived one: `MemoryBoard` renders confidence-by-market and confidence-by-manager as **coverage-confidence cohort buckets** ("Well-covered" / "Building coverage" / "Sparse"), each card explicitly captioned "coverage-based, not predictive skill" — not narrative memory entries, because nothing in the real calibration data supports narrative memory the way the prototype invents it (the file's own header comment states this explicitly). The accuracy chart renders as **segmented sparklines with real gaps** for any month with fewer than 5 scoreable verdicts, instead of one smooth always-rising line. Accept/Dismiss feedback is recorded server-side (`POST /brain/feedback`) as a genuine, persisted decision, but is explicitly labeled "display-only" — it is documented to never re-weight or re-rank anything, unlike the prototype's implied "it recalibrates." There is no fixed "6 models" (or any other invented headline number) anywhere in the shipped module.

---

## C11 — Insurance: self-insure math on synthetic EAL/risk-load constants

**What the design asked for:** `Insurance.html`'s "Self-Insure & Bids" tab: a split-bar visualization of premium vs. a modeled Expected Annual Loss (EAL), using the prototype's fixed placeholder constants (a 1.6× risk load and a 62% transfer share) to produce a "retain risk" or "hold" recommendation, plus a competitive re-bid pipeline tracking incumbent premium vs. best quote per policy.

**Why it was cut:** Plan §6, item C11: *"Defer to P4c (needs loss runs) — Prototype constants (1.6× risk load, 62% transfer share) are placeholders; shipping them would be invented financial advice."* Unlike the Taxes cost-seg cut (C2), which lacks a data source entirely, this one has a clear, specific data request outstanding: a broker-provided loss-run history (3 years of claims) and policy dec-page detail (deductibles, limits), both of which were flagged in the plan's Phase 0 as an open Gabriel/broker action item. Until that real data arrives, any EAL or self-insurance recommendation would necessarily rest on invented constants — which this codebase's provenance doctrine treats as a serious violation (the same class of problem as C10's fabricated Brain figures), not a cosmetic shortcut.

**What serves that need today:** The **Insurance** module (id `insurance`, `src/modules/insurance/InsuranceModule.tsx` + `SavingsBoard.tsx`) ships only what real premium/TIV data supports: a "Savings Board" tab with two tiers — re-bid candidates ranked by "premium above book median" (a type-cohorted dispersion metric, never framed as a promised savings figure) and a renewal watch list — plus a "Policy Register" tab of the real policy data. **No self-insurance economics, EAL figure, or re-bid-quote pipeline exists anywhere in the shipped product today.** This is a pure data-gating decision: once the broker's loss runs and dec-page data arrive (tracked as Phase "P4c" in the roadmap), this tab becomes buildable on real numbers instead of invented ones.

---

## Summary table

| # | Design element | Disposition | Serves the need today |
|---|---|---|---|
| C1 | Financials (Statements/GL/AR/AP/Rent Roll/BvA) | Reconcile, don't build | Close (`close`) + Cash (`cash`) + Debt (`debt`) + Leases (`leases`) + Tenants (`tenants`, AR); GL & AP have no analog anywhere |
| C2 | Taxes: Filed Returns + cost-seg/entity strategies | Defer (confidentiality + no data) | Taxes (`taxes`) Strategy Board ships Appeals + Assessment Watch only, with an honest "deferred" card for the rest |
| C3 | Studio (cross-filter analytics) | Defer (revisit post-parity) | Intel (`intel`) Benchmarks + Property tabs; Portfolio (`portfolio`) Value-by-Market — no unified cross-filter |
| C4 | Operations (work orders/units/turns) | Defer (no PM-system feed) | Tenants (`tenants`) covers only the ledger slice; work orders/units have no analog |
| C5 | Inbox (email threads) | Drop | Alerts (`alerts`) is the actionable-queue analog; DraftPanel is the draft-only reply analog |
| C6 | News (briefing/regulation/research) | Partial drop | Market (`market`) covers rates + target-market trends only; editorial content has no analog |
| C7 | Overview Focus Lens tweaks panel | Drop | Shell theme/density toggles + Overview's widget Edit Layout mode |
| C8 | Investor (LP capital accounts) | Defer pending D7 | Nothing — no investor entity exists anywhere; genuine absence |
| C9 | Prototype letter grades + inferred buy box | Drop (superseded) | Grader view renders ratified ruleset v1.0's own tier/composite vocabulary instead |
| C10 | Brain: fabricated memory/accuracy ramp/"6 models" | Drop (replaced by honest derivations) | Command Brain (`command-brain`) + MemoryBoard render only calibration-derived figures |
| C11 | Insurance self-insure math (synthetic EAL) | Defer to P4c (needs loss runs) | Insurance (`insurance`) Savings Board + Policy Register only; self-insure has no analog until real loss-run data arrives |
