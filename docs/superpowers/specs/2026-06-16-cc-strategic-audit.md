# Oxford Command Center — Strategic Business Audit
**Date:** 2026-06-16  
**Scope:** Business effectiveness review — does this platform help ownership make better decisions, compound NOI, and scale with minimal overhead?  
**Prepared by:** AI Strategic Audit (cc-audit-army → cc-strategic-audit synthesis)  
**Baseline:** `feat/pfi-phase-1-foundation` branch, 2026-06-16  
**Methodology:** 5 parallel subagents across 12 business goals + architectural synthesis against the prior code-correctness audit (`2026-06-13-cc-audit-report.md`) and master plan (`2026-06-13-ora-intelligence-platform-master-plan.md`)

> **This document does not duplicate the code audit.** Findings from `cc-audit-report.md` (H1–H7, M1–M15, L1–L9) are referenced where they affect business decisions but not restated in full. This report evaluates *business gaps*, not *correctness bugs*.

---

## 1. EXECUTIVE SUMMARY

The Oxford Command Center has achieved something rare and genuinely hard: a tested, deterministic financial warehouse with real data (32 P&L files, 339 GL accounts mapped) backing a scored intelligence layer that tells ownership which properties need attention and what capital action to take. This is not a dashboard — it is the foundation of an operating system. The prior code audit verified correctness on the data path; this audit asks whether the resulting platform is earning its keep as a capital-allocation and decision-support engine.

**The honest answer is: yes on financial intelligence, not yet on operations, acquisitions, or market context.**

Three things are genuinely working well:
1. **The Intel module** — the per-property verdict → root-cause → recommendation workflow is real, tested, and grounded in ingested financials. The ΔNOI decomposition and anomaly detection are the most valuable features in the system.
2. **The daily brief** — 7 days/week, 9 sections, automated delivery. A legitimate time save.
3. **The alert engine** — debt, lease, and insurance conditions are real and well-designed.

Three things are broken in ways that matter more than any code bug:
1. **No collections/AR aging monitoring** — a 140-tenant portfolio has zero delinquency detection. This is the single highest-probability hidden risk in the system.
2. **Manual QB export pipeline** — every financial number flows through a human hand before reaching the warehouse. The system is only as current as the last manual export.
3. **The acquisition module is seed data** — the pipeline badge says it explicitly: "Seed pipeline — HubSpot / Notion sync pending." LOI decisions are being made without live system intelligence.

**The three most important things to fix:**
1. Collections alert (days, not months)
2. Live Notion/HubSpot deal sync (weeks, not months)
3. Monthly AI-narrated portfolio briefing (hours, not weeks)

**The single most important thing to build next:** The Lease-Run Proforma for acquisition underwriting. It is the missing link between the ratified acquisition scorecard and a real T1 PURSUE verdict.

**Effectiveness Score: 57/100.** The platform is a strong foundation for a $60M portfolio. It is not yet strong enough for $200M without significant operational automation additions.

---

## 2. COMMAND CENTER EFFECTIVENESS SCORE

**Composite: 57 / 100**

| Dimension | Score | Weight | Weighted |
|---|---|---|---|
| Ownership attention / daily decision support | 6.5 | 15% | 0.98 |
| NOI growth identification engine | 7.0 | 15% | 1.05 |
| Scale without hiring / automation | 5.0 | 12% | 0.60 |
| Single source of truth / data quality | 4.0 | 10% | 0.40 |
| Early problem detection | 5.5 | 12% | 0.66 |
| Property quality ranking | 7.0 | 10% | 0.70 |
| Acquisition intelligence | 5.0 | 10% | 0.50 |
| Capital allocation intelligence | 6.5 | 8% | 0.52 |
| PM accountability | 3.0 | 4% | 0.12 |
| Market intelligence | 2.0 | 4% | 0.08 |

**Weighted total: 5.61 → 57/100**

**Where it should be to support a $200M portfolio:** ≥75/100. Gaps are concentrated in the operational and market-intelligence dimensions, not the financial analytics dimension (which is already competitive-tier). A $200M portfolio with 70 properties and 400 tenants cannot run without automated collections monitoring, PM accountability metrics, and live deal pipeline data.

---

## 3. GOAL-BY-GOAL GRADES

| Goal | Grade | One-Line Verdict |
|---|---|---|
| 1. Ownership Attention Engine | **B-** | Attention routing exists and is real; missing collections, PM failure, and vacancy event detection |
| 2. NOI Growth Engine | **B-** | ΔNOI decomposition and CAGR are real; rent-gap and vendor benchmarking are invisible |
| 3. Scale Without Hiring | **C+** | Automation fleet is meaningful; manual QB export and single-author workbook cap scale at ~30 properties |
| 4. Single Source of Truth | **C** | Six authoritative silos with no live reconciliation; two NOI representations that can silently disagree |
| 5. Early Problem Detection | **C+** | Debt/lease/insurance conditions are real; delinquency, vacancy events, and PM failure are undetected |
| 6. Property Quality Ranking | **B** | Full 10-weight health score and quartile ranking are live; weights ratified but not yet empirically calibrated |
| 7. Acquisition Intelligence | **C+** | Scorecard engine is built and ratified; pipeline is seed data and scoring is client-state only |
| 8. Capital Allocation Intelligence | **B-** | Four-way verdict with attention bands is live; no refinance arm, no improvement IRR, no appraised values |
| 9. PM Accountability | **D+** | NOI/expense trend by PM exists; no work orders, collections, retention, or vendor data |
| 10. Market Intelligence | **D** | FRED macro + cap-rate spread only; no submarket vacancy, absorption, rent comps, or competitive tracking |
| 11. Portfolio Risk Management | **B-** | DSCR/LTV/lease/insurance alerts are real; geographic and lender concentration are unmonitored |
| 12. Executive AI Briefings | **C+** | Daily brief is real and valuable; deterministic not AI-narrated; no monthly/quarterly cadence |

---

### GOAL 1 — OWNERSHIP ATTENTION ENGINE (B-)

**Strengths:**
- `PrincipalModule.tsx` opens on a "Needs your attention" card driven by `principalDigest()`, pulling conditions from `evaluateConditions()` — a genuine daily attention signal, not a vanity dashboard
- Alert conditions cover the most financially material risks: balloon maturities, DSCR <1.1/1.25, LTV >65%, lease expiring <180d without renewal, expired insurance, escalation dates passed, cash concentration >30%, tenant concentration >15%
- The `Intel/OwnershipView` attention matrix (red/orange/yellow/green bands) provides a ranked property-level view, clickthrough to per-property drilldown
- Deal-stage alerts for LOI/Closing appear in the digest

**Weaknesses:**
- The four headline KPIs (NOI, Value, Occupancy, Cash) carry no delta, trend arrow, or "vs. last week" signal — ownership cannot tell from the home screen whether anything moved overnight
- Anomaly flags from the warehouse (anomalies.ts) are NOT wired into the alert pipeline (conditions.ts operates on the snapshot object only) — a 40% utility spike fires inside the warehouse engine but does not appear in the Principal digest or AlertsModule
- Deal urgency is unranked: all LOI/Closing deals appear at `rank: 2` with no days-to-close sort key

**What would prevent ownership from knowing what to focus on today:**
- A delinquent tenant — there is no collections/AR aging condition anywhere in the system
- A PM quietly underperforming — no PM performance threshold alert exists
- A unit that went dark mid-lease — vacancy events are invisible unless the workbook is manually updated
- An anomalous expense spike that fired in the warehouse but never crossed into the alert UI

**Capabilities Missing Entirely:** Collections/AR aging (60/90 day buckets); unscheduled vacancy event detection; PM performance threshold alerts; budget-vs-actual variance; anomaly-to-alert pipeline bridge

---

### GOAL 2 — NOI GROWTH ENGINE (B-)

**Strengths:**
- `drivers.ts` ΔNOI decomposition (category-level waterfall with `contributionPct`) is a genuine analytical capability — most platforms do not have this
- `growth.ts` CAGR and `sinceAcquisition()` give a compounding-since-acquisition view ranked by NOI/SF growth
- `anomalies.ts` statistical detection with severity scaling (1.5x/2.5x/4.0x multiples above threshold) catches period-over-period shifts before they become structural
- `PropertyIntelView.tsx` renders the root-cause as a one-sentence verdict above the waterfall chart — answer-first design that earns its place

**What NOI opportunities are currently invisible:**
- **In-place vs. market rent gap** — no external rent benchmark. A tenant paying $5.50/SF when market is $7.50/SF is invisible. This is the #1 rent-growth opportunity surface missing from the system.
- **Vendor benchmarking** — anomaly.ts watches "Repairs & Maintenance" as a total but cannot identify whether the spike is one overpriced vendor or a legitimate capital event. No cross-property vendor spend comparison.
- **Monthly sub-period trending** — grain model handles full-year and YTD only. Seasonal utility patterns, intra-year insurance true-ups, and month-over-month maintenance drift are invisible.
- **Collections/delinquency rate** — a tenant paying 45 days late is financially equivalent to on-time in the current system.

**Capabilities Missing Entirely:** In-place vs. market rent gap by tenant; vendor-level spend comparison; monthly sub-period expense categories; collections/AR aging; budget vs. actual variance; capex ROI tracking (capex is explicitly excluded from NOI with no separate return view)

---

### GOAL 3 — SCALE WITHOUT HIRING (C+)

**Strengths:**
- 22-task automation fleet (17 CC + 5 LAMS) covers rate prefetching, deal sourcing, inbox triage, PM ledger, workbook ingest, health monitoring, and weekly briefings — genuine operational leverage
- P&L warehouse ingest auto-commits at ≥85% mapping confidence — new P&L files are largely self-processing once dropped to OneDrive

**Scaling Bottlenecks (ranked):**
1. **QB export is fully manual** — QuickBooks MCP is intentionally not connected. Every financial number requires a human to export an Excel file, drop it to OneDrive, and wait for the Monday ingest window. At 27 properties this is manageable; at 54 it is a weekly multi-hour task for a 2-person team.
2. **Master Workbook is a single-author artifact** — the entire Spine A (NOI, occupancy, debt, cash, insurance for all 27 properties) flows through one Excel file. No concurrent editing, no API writes, no live PM platform feed. When the portfolio doubles, so does the workbook maintenance burden.
3. **Retired lease-expiration-dashboard has no live replacement** — `ora-lease-expiration-dashboard` is in `_archive_2026-06-09_retired/`. The live fleet has no equivalent task. Lease expiry monitoring now depends on Block B §4b of the daily brief, which reads Notion manually and summarizes. This does not provide the automated weekly renewal action list that the retired task provided.
4. **New property onboarding requires architectural work** — adding a property requires: workbook row addition, QB chart-of-accounts mapping (GL account review for new properties), overlay entry, warehouse backfill of historical P&Ls. Not self-service.
5. **Gabriel is a single-point-of-failure** — every scheduled output routes to `ggoldberg@oxfordra.net`. No delegation path. At 54+ properties, the `ora-open-sessions-board` 12-item cap will be the first thing to saturate.

**Human bottlenecks:** QB export, workbook update, deal decisions, counterparty outreach — all principal-only, no delegation path in the automation layer.

---

### GOAL 4 — SINGLE SOURCE OF TRUTH (C)

**Six authoritative silos, no unified query layer:**

| Data Type | System | Automation Level |
|---|---|---|
| GL actuals (revenue/expense) | QuickBooks Desktop | Manual export only |
| Portfolio NOI, current-state | Master Workbook (Spine A) | Monday ingest only |
| Portfolio NOI, historical | SQLite Warehouse (Spine B) | Semi-automated |
| Lease terms, expiration | Notion Tenant DB + Workbook | Manual |
| Renewal activity | HubSpot CRM | Manual / MCP reads |
| Deal pipeline | Notion Acquisition Pipeline | Automated scan, manual decisions |
| Counterparty correspondence | Outlook / M365 | Read-only triage |

**The critical defect:** `Property.noi` (workbook formula cell) and `warehouse ledger NOI` (Σ revenue+recovery−opex) are independent computations. Phase 1a (`reconcile-noi.ts`) is built but not yet merged to main. Two numbers both called "NOI" can silently disagree.

**Questions requiring 2+ systems:** Current NOI on any property (workbook + warehouse + QB = three answers); which tenants are at renewal risk (Notion + HubSpot + workbook); cash net of debt service (workbook + Notion obligations); whether a broker deal is already in the pipeline (Notion Deal Sourcing Log + Acquisition Pipeline — both read in `ora-deal-sourcing-scan` step 4).

---

### GOAL 5 — EARLY PROBLEM DETECTION (C+)

**Strengths:** Debt (DSCR/LTV/balloon), lease expiration (180d), insurance lapse, cash concentration, tenant concentration, data staleness — all are real conditions with defined thresholds, wired to the AlertsModule.

**Detection Latency Table:**

| Risk | Detection | Latency |
|---|---|---|
| Balloon/maturity | Yes (365d / 180d) | Up to 48h workbook refresh |
| DSCR breach | Yes (<1.1 critical, <1.25 watch) | Up to 48h |
| Lease expiry, no renewal | Yes (180d) | Up to 48h |
| Insurance lapse | Yes (post-lapse) | Up to 48h after status change |
| **Delinquency / collections** | **NO** | **Never** |
| **Vacancy event (unscheduled)** | **NO** | **Never** |
| **PM underperformance** | **Passive only** | **Manual navigation** |
| **Expense spike (warehouse)** | **Anomaly layer only, not wired to alerts** | **Not surfaced** |

**Problems That Could Exist Today Without Ownership Knowing:** A tenant who stopped paying in May; a unit that went dark after an early termination; a PM who is chronically delaying maintenance; a 40% utility spike at a property that fired in the anomaly engine but never crossed to the alert UI; a below-market lease renewal executed without escalation tracking.

**Capabilities Missing Entirely:** Receivables/AR aging in any form; unscheduled vacancy detection; PM threshold alerts; budget-vs-actual variance alerts; anomaly-to-alert bridge; lease renewal rate tracking

---

### GOAL 6 — PROPERTY QUALITY RANKING (B)

**Strengths:** The 10-weight health score (0–100), attention bands (green/yellow/orange/red), and four-way capital action are real, tested, and well-designed. The quartile benchmarking within same-basis cohorts is methodologically sound. All 27 properties can be ranked by quality score today via the `OwnershipView` AttentionMatrix and PropertySelector.

**Calibration status:** Weights were ratified by Gabriel 2026-06-14 (Option B, NOI-centric: 0.40 NOI block / 0.25 efficiency / 0.18 revenue / 0.10 benchmark rank / 0.07 margin stability). They are NOT empirically calibrated — no historical score-vs-realized-NOI-change backtest has been run. The `intel-config.ts` note acknowledges `benchmarkPosition` (10% weight) is "the first weight the calibration log validates" and has not yet been validated with the 27-property cohort.

**Missing from scoring model:** Building vintage/physical age; submarket quality tier; functional obsolescence indicators (clear height, dock count); tenant credit quality; NNN vs. gross lease structure; capex intensity (explicitly excluded from NOI with no separate deferred-maintenance sub-score).

---

### GOAL 7 — ACQUISITION INTELLIGENCE (C+)

**Strengths:** The `AcquisitionWorkbench` is live with a real scoring engine (`server/warehouse/acquisition.ts`), ratified ruleset (2026-06-14), and OM field extraction via Claude API. The OM import drawer can extract 15 fields from a PDF and auto-score within seconds. This is a genuine acquisition workflow tool.

**Critical gap:** The pipeline is seed data. `AcquisitionsModule.tsx:62` is explicit:
```
<Badge tone="amber" dot>Seed pipeline — HubSpot / Notion sync pending</Badge>
```
Active deals (LOI pipeline, stage counts, KPI tiles) are derived from `src/data/seed-deals.ts`, not from live Notion/HubSpot. LOI decisions are being made without system intelligence.

**Acquisition decisions currently made without sufficient data:**
- No Oxford Acquisition Score is stored for any real deal — `AcquisitionWorkbench` is client-state only in v1; scores are lost on page reload
- The scorecard cannot reach T1 PURSUE without `rct` (replacement cost table), `clusterTier`, `leveredIrr`, and `stabilizedYoc` — all require manual entry; raw OM submission produces at best a T2 WATCH verdict
- No automated OM intake alert when a broker email contains a new offering memorandum
- The lease-run proforma (Phase C spec exists at `2026-06-14-pfi-lease-run-proforma-feature.md`) is not yet built — acquisition underwriting cannot model a hold-period lease-up scenario within the platform

**Capabilities Missing Entirely:** Live Notion/HubSpot pipeline sync; persistent server-side scored acquisition history; automated OM detection from email; lease-run proforma for hold-period underwriting; seller motivation signal detection; deal comparison across multiple scored acquisitions

---

### GOAL 8 — CAPITAL ALLOCATION INTELLIGENCE (B-)

**Strengths:** The four-way capital verdict (invest/hold/monitor/disposition-candidate) is deterministic, tested, and grounded in the 10-weight health score + anomaly attention + quartile rank. `OwnershipView` renders it with a prioritized action list. Capital governors are ratified in `capital-config.ts`.

**Known impairments:**
- **No appraised values in warehouse** — the cap-rate governors (`dispositionCapRate: 6.5%`, `holdCapRate: 7.5%`) require `NOI / appraised value`; `governors.ts:9-11` explicitly states these "require appraised value, not yet in PeriodMetrics — human applies manually." Disposition-candidate verdicts are based on health/quartile/attention, not an actual cap-rate computation.
- **No refinance arm** — the `capitalAction` enum is `invest | hold | monitor | disposition-candidate`. No `refinance` verdict despite `refiTriggerBps: 150` existing in `capital-config.ts`. The refi trigger is a stored constant with no evaluation engine.
- **No improvement IRR** — `capexIrr: 0.15` hurdle exists but no engine evaluates a proposed improvement against it. The system says "invest" but not in what, for what return, or how much.
- **Scenario engine (H4, now fixed)** — the prior scenario bug (Downside scenario raised portfolio value) appears corrected in `engine.ts:50-57`, but any cached values computed under the broken formula would persist until a full re-derive.
- **Weights not empirically calibrated** — a property scored 78 vs. 62 reflects ratified intent, not validated separability.

---

### GOAL 9 — PM ACCOUNTABILITY (D+)

`ManagersView.tsx` shows avg NOI/SF, avg NOI growth, and avg expense growth per PM. This is the complete PM accountability picture. It is weak by design (4 metrics, small sample, no external benchmark) and the `ManagersView` comment acknowledges "directional, not definitive."

**What real PM accountability requires that is completely absent:** Work order volume and resolution time; AR aging and collections rate by PM; tenant retention and WALT trend by PM cohort; expense ratio vs. a BOMA or industry benchmark; vendor spend by PM; inspection and preventative maintenance compliance. None of these data sources are integrated.

---

### GOAL 10 — MARKET INTELLIGENCE (D)

`MarketModule.tsx` renders five FRED macro indicators, a 12-month 10Y Treasury chart, and a cap-rate spread calculation. This is useful context for acquisition pricing but cannot support a market entry/exit decision.

**Completely absent:** Submarket vacancy rates; net absorption by metro; market rent PSF by submarket; competitive property tracking; cap rate transaction comps; supply pipeline; market attractiveness scoring. ORA operates in 7 states; the system has zero submarket visibility for any of them.

---

### GOAL 11 — PORTFOLIO RISK MANAGEMENT (B-)

Best-graded operational goal. Debt (DSCR/LTV/balloon/maturity ladder), lease rollover (bucket by half-year to 4 years), insurance, cash concentration, and tenant concentration alerts are all real and well-designed. `DebtModule.tsx` balloon watch card is a particularly good implementation — prominent, labeled, actionable.

**Unmonitored:** Geographic concentration (no threshold alert when one metro holds >40% of portfolio value); lender concentration (no alert if one lender holds 80% of debt); covenant compliance beyond DSCR/LTV; cross-default triggers; SOFR/floating-rate exposure breakdown.

---

### GOAL 12 — EXECUTIVE AI BRIEFINGS (C+)

Daily brief (7x/week) and week-ahead briefing (Fridays) exist and run reliably. Block B is a genuine 9-section intelligence product: rate environment, transaction alerts, portfolio watch, inbox triage, ops tips, reading list, law watch, case study, competitive intel.

**Key limitations:**
- The brief is a **deterministic template**, not an AI narration. It does not synthesize across sections or generate an executive judgment call (e.g., "the combination of rising 10Y rates, three balloon maturities, and your largest tenant's Q4 expiration creates a liquidity risk worth addressing before September").
- No monthly briefing (AI-narrated portfolio health narrative with trend commentary)
- No quarterly briefing (capital allocation review, refi pipeline, acquisition conversion rate)
- The AI agent is Q&A reactive — it answers questions but does not proactively surface emerging compound risks

---

## 4. FEATURE INVENTORY

| Feature | Location | Value | Disposition |
|---|---|---|---|
| Principal Home (digest + KPIs) | `src/modules/principal/` | High | Keep — improve by wiring anomaly flags to digest |
| Overview (widget grid) | `src/modules/overview/` | Medium | Keep — low maintenance cost |
| Intel / OwnershipView | `src/modules/intel/OwnershipView.tsx` | **High** | Keep — the system's best feature |
| Intel / PropertyIntelView | `src/modules/intel/PropertyIntelView.tsx` | **High** | Keep |
| Intel / BenchmarksView | `src/modules/intel/BenchmarksView.tsx` | High | Keep |
| Intel / ManagersView | `src/modules/intel/ManagersView.tsx` | Medium | Improve — add collections and retention data |
| Intel / LeaseRunView | `src/modules/intel/LeaseRunView.tsx` | High | Improve — lease-run proforma spec needs implementation |
| Intel / Imports, Quality, Mappings | `src/modules/intel/` | Medium | Keep — data-ops layer, necessary |
| Calibration module | `src/modules/calibration/` | High | Keep — the 40-year learning loop starts here |
| Acquisitions / Workbench | `src/modules/acquisitions/` | **High** | **Improve** — live pipeline sync is the critical gap |
| Alerts module | `src/modules/alerts/` | High | Keep — improve by adding collections and anomaly bridge |
| Close / Monthly close | `src/modules/close/` | High | Keep — H5 phantom variance bug needs fixing |
| Leases | `src/modules/leases/` | High | Keep |
| Renewals | `src/modules/renewals/` | High | Keep |
| Tenants | `src/modules/tenants/` | Medium | Keep |
| Debt | `src/modules/debt/` | High | Keep |
| Cash | `src/modules/cash/` | Medium | Keep |
| Insurance | `src/modules/insurance/` | Medium | Keep |
| Portfolio | `src/modules/portfolio/` | Medium | Keep |
| Market | `src/modules/market/` | Low | **Improve** — FRED only; add submarket feed or consolidate |
| Relationships | `src/modules/relationships/` | Low | Consolidate into CRM or remove |
| Documents (RAG) | `src/modules/documents/` | Medium | Keep |
| System Health | `src/modules/health/` | Medium | Keep |
| Analytics engine (`buildAnalytics()`) | `src/analytics/engine.ts` | **High** | Keep — core Spine A metric layer |
| Warehouse scoring engine | `server/warehouse/scores.ts` | **High** | Keep |
| Anomaly detection | `server/warehouse/anomalies.ts` | **High** | **Improve** — wire to alert pipeline |
| Growth/CAGR engine | `server/warehouse/growth.ts` | **High** | Keep |
| ΔNOI drivers | `server/warehouse/drivers.ts` | **High** | Keep |
| Benchmarks | `server/warehouse/benchmarks.ts` | High | Keep |
| Acquisition scorecard engine | `server/warehouse/acquisition.ts` | **High** | Keep — live pipeline sync is the gap, not the engine |
| FRED macro | `server/macro/getMacro.ts` | Medium | Keep |
| AI agent (streaming, 11 tools) | `server/ai/` | High | Keep — improve to proactive briefing |
| Cloudflare mirror | `deploy:mirror` | Medium | Keep — Eric access design exists |
| Document RAG | `server/sources/` | Low | Keep — low maintenance; useful for deal docs |

---

## 5. SCHEDULED TASK AUDIT

| Task | Fleet | Cadence | Business Value | Verdict |
|---|---|---|---|---|
| ora-am-brief | CC | Daily 6am | **High** — 9-section daily intel + inbox triage | Keep |
| ora-automation-health-monitor | CC | Mon–Fri 11am | High — fleet health signal | Keep |
| ora-dashboard-refresh | CC | Daily 7am | Medium — Notion refresh | Keep |
| ora-deal-sourcing-scan | CC | Tue 10:45am | High — buy-box screen of inbound OMs | Keep |
| ora-financial-code-integrity-sweep | CC | Mon 1:30pm | High — governor drift protection | Keep |
| ora-health-guard | CC | Daily 5:15am | High — pre-session system check | Keep |
| ora-master-workbook-ingest | CC | Mon 5:45am | **High** — sole data refresh path | Keep; **upgrade to detect and alert on staleness mid-week** |
| ora-open-sessions-board | CC | Daily 5pm | Medium — outstanding action tracking | Keep |
| ora-pm-ledger | CC | Daily 6pm | High — AR/payment tracking | Keep |
| ora-task-integrity-guard | CC | Daily 12:45pm | High — fleet integrity | Keep |
| ora-week-ahead-briefing | CC | Fri 4:30pm | High — weekly priority setting | Keep |
| ora-weekly-hygiene | CC | Sun 8pm | Medium — maintenance | Keep |
| ora-weekly-tooling-intel-sweep | CC | Mon 9am | Low | **Remove or reduce cadence** |
| ora-setup-audit | CC | Daily 6:30am | Low — redundant with health-guard | **Consolidate with health-guard** |
| ora-consolidate-memory-monthly | CC | 2nd of month 5am | Medium | Keep |
| ora-dormant-thread-revival | CC | Fri 3pm | Low | **Evaluate removal** |
| ora-skill-text-audit | CC | 15th of month 10am | Low | Keep |
| ora-om-intake-ocr | LAMS | Wed 6:15am | **High** — OM intake automation | Keep; integrate with live deal pipeline |
| ora-owner-outreach-queue-refresh | LAMS | Mon 10am | High — off-market prospecting | Keep |
| ora-replacement-cost-refresh | LAMS | Quarterly 6am | High — acquisition underwriting input | Keep |
| ora-skill-store-drift-check | LAMS | Mon 12:10pm | Medium — skill integrity | Keep |
| ora-cowork-heartbeat | LAMS | 5:50am + 5:50pm | Medium — dead-man signal | Keep |

**Missing tasks that should exist:**
- `ora-collections-sweep` — weekly AR aging pull from QB/Notion, alert if any tenant 30+ days past due
- `ora-lease-expiration-action-list` — replacement for the retired `ora-lease-expiration-dashboard`
- `ora-monthly-portfolio-briefing` — AI-narrated monthly briefing (NOI trajectory, WALT, debt maturity countdown, acquisition conversion)
- `ora-market-rent-comp-refresh` — quarterly CoStar/LoopNet in-place vs. market rent gap update

---

## 6. OWNER EXPERIENCE AUDIT

### 8:00 AM — 5-Minute Morning Check

Ownership opens the Command Center and lands on Principal Home. Four KPI tiles (NOI, Value, Occupancy, Cash) show current-state figures — no trend, no delta, no movement indicator. The "Needs Your Attention" card shows 2–6 items (lease expiring, DSCR watch, deal deadline). Items are ordered by severity rank, not calendar urgency. Ownership must mentally reorder by time-sensitivity.

**Friction:** No first-view answer to "did anything change since yesterday?" The KPIs have no yesterday-vs-today delta. The daily brief (emailed) likely arrived an hour earlier and contains more actionable intelligence than the home screen. The home screen and the email brief are not integrated — reading one requires leaving the other.

**Missing:** "Delta since last session" KPI strip; anomaly-flag-to-digest bridge (warehouse fired anomalies won't appear here); collections alert for any tenant

### 30-Minute Deep Review

Ownership navigates to Intel → Ownership tab. Attention matrix shows all properties color-coded. Bottom-quartile properties with orange/red attention are clickable to the Property tab. Per-property drilldown: verdict → reason → ΔNOI waterfall → growth chart.

**This workflow is genuinely good.** The answer-first design works. The 30-minute review produces a real prioritized action list.

**Friction:** The PM scorecard (Managers tab) shows only 3 metrics per manager with no operational context. Expense anomaly for a specific property requires navigating to the Property tab → selecting the property → reading the anomaly flags section — three clicks minimum to surface a warehouse signal.

### Monthly Close Review

Ownership opens Close module. If QB export was dropped (manual step), actuals appear. Budget vs. actual table with per-property variance.

**Friction:** QB export is a required manual prerequisite. Without it, the actual NOI column is blank and the "Portfolio Variance" headline KPI shows "--". The H5 phantom variance bug (from code audit) means the portfolio variance total can show a misleading negative until all properties have both budget and actual entries.

**Missing:** Month-over-month trending of any line item; automated QB export trigger; budget alert when variance exceeds a threshold

### New Acquisition Evaluation (OM Receipt → IC Memo)

1. Broker sends OM (Outlook) → inbox triage in Block C of morning brief identifies and classifies it → Gabriel opens Command Center → navigates to Acquisitions
2. Uploads PDF via OmImportDrawer → Claude extracts 15 fields → form pre-populated
3. Must manually enter: `clusterTier`, `leveredIrr`, `stabilizedYoc`, `rct`, `sellerMotivationScore` — all non-extractable
4. Without those fields, engine caps at T2 WATCH due to `floorIndeterminate` / `gateIndeterminate` guards
5. T1 PURSUE requires external data (replacement cost table, IRR model in separate Excel, market rent comps)
6. IC memo generated by `document-assembly` skill (separate session, not integrated)
7. Score is lost on page reload — client-state only in v1

**Dead ends:** Cannot run a lease-run proforma within the platform; cannot compare multiple OMs side-by-side; no persistent deal score history; IC memo is a separate workflow that doesn't read the scorecard output

---

## 7. TIME LEVERAGE ANALYSIS

**Estimated current ownership time/week (before Command Center):**
- Acquisitions: 12h
- Leasing/renewals: 6h
- PM oversight: 5h
- Accounting/financial review: 5h
- Asset management: 6h
- Administration/communication: 8h
- **Total: ~42h/week**

**Hours saved by current Command Center:** [ESTIMATE]
- Daily brief replaces ~2h/week of morning intelligence gathering
- Automated deal sourcing scan replaces ~1h/week
- Alerts replace ~1h/week of manual calendar/lease-tracking review
- Intel property ranking replaces ~2h/week of manual benchmarking
- **Total current save: ~6–7h/week** (15–17% efficiency gain)

**Hours that COULD be saved after top-10 improvements:** [ESTIMATE]
- Live QB integration: +3h/week (eliminate manual export)
- Collections monitoring: +1h/week (eliminate manual AR review)
- Live deal pipeline: +2h/week (eliminate manual deal status tracking in Notion)
- Monthly briefing: +1.5h/week (eliminate manual monthly portfolio assembly)
- PM accountability with work orders: +2h/week (eliminate manual PM performance review)
- **Total potential: ~16–18h/week** (38–43% efficiency gain — roughly 1 FTE equivalent)

**Highest-leverage time-saving opportunity not yet built:** Automated QB export + collections monitoring. These two together eliminate the entire manual weekly financial review cycle.

---

## 8. TOP 25 FAILURES

*Business failures — capabilities missing or broken that impair real decisions. Code-correctness findings from `cc-audit-report.md` (H1-H7, M1-M15) are referenced but not restated.*

| # | Failure | Root Cause | Business Impact | Fix | Value |
|---|---|---|---|---|---|
| 1 | No collections/AR aging monitoring for 140 tenants | Conditions engine watches workbook state, not QB AR aging | Silent delinquency; the highest-probability hidden revenue leak in a 140-tenant portfolio | Add AR aging condition (30/60/90 day) reading from QB export or Notion PM ledger | HIGH — directly protects NOI |
| 2 | QB export is manual (zero automation) | QuickBooks MCP non-functional by design | Every financial insight is as stale as the last manual export; monthly close requires a human prerequisite; warehouse NOI is perpetually ≥1 week behind | QuickBooks CSV export scheduled automation via QB Desktop automation macro or AppFolio/PM platform native export | HIGH — eliminates the single largest data latency |
| 3 | Acquisition pipeline is seed data | Notion/HubSpot sync not built | LOI/PSA decisions made without live system data; scorecard has never been run against a real live deal | Live Notion deal sync to `snapshot.deals` | HIGH |
| 4 | Market intelligence = FRED only | No submarket data source integrated | Cannot evaluate market entry/exit; acquisition rent assumptions are unconstrained; cap rate assumptions have no local comp basis | CoStar API or quarterly web-scraped rent comp sweep per submarket | HIGH — every acquisition thesis needs this |
| 5 | Anomaly flags not wired to alert pipeline | Warehouse layer and alert layer are architecturally separate with no bridge | A 40% utility spike or NOI cliff fires in the analytics engine but never surfaces in the Principal Home or AlertsModule | Add `anomaly-to-conditions` bridge: evaluate `detectAnomalies()` output in `evaluateConditions()` | HIGH |
| 6 | No monthly or quarterly AI briefing | Brief cadence is daily + weekly only | Monthly portfolio trend narrative (NOI trajectory, WALT, debt countdown) is assembled manually or not at all | Register `ora-monthly-portfolio-briefing` task | HIGH |
| 7 | Acquisition scores are client-state only | "Server-side persistence is a later increment" (AcquisitionWorkbench.tsx:7) | Every scored deal is lost on page reload; no deal score history; cannot compare across time | Persist `acquisitionInputs` to the overlay/warehouse | HIGH |
| 8 | PM accountability has only 3 metrics, all financial | No work order, collections, or retention data source integrated | Cannot objectively evaluate which PM should receive more properties; cannot identify a failing PM before NOI impact is measurable | Integrate PM platform API (AppFolio/Rent Manager) or add work-order import to warehouse | HIGH |
| 9 | No in-place vs. market rent gap monitoring | No external rent benchmark in system | Cannot identify properties with below-market rents for lease renewal strategy; rent-growth opportunity is invisible | Quarterly rent comp sweep per submarket via `ora-replacement-cost-refresh` extension or CoStar | HIGH |
| 10 | Capital allocation verdict has no refinance arm | `capitalAction` enum has 4 values; refi is a governor constant but not an evaluation path | Refinance triggers (LTV <40% + rate delta ≥150bps) require manual awareness; refi opportunities are not surfaced | Add `refinance` arm to `capitalAction` enum with refi-trigger evaluation in `scores.ts` | MEDIUM-HIGH |
| 11 | Lease expiration task is retired with no replacement | `ora-lease-expiration-dashboard` archived 2026-06-09 | Lease expiration monitoring now depends on Block B §4b which is a daily brief section, not a standalone action list | Register replacement weekly lease-expiry action-list task | MEDIUM-HIGH |
| 12 | No improvement/capex IRR calculation | `capexIrr: 0.15` exists in config but no evaluation engine | "Deploy capital" verdict gives no guidance on how much, in what project, or at what return | Build capex IRR calculator wired to the capital recommendation | MEDIUM |
| 13 | The "Needs Your Attention" card has no temporal urgency sorting | Severity rank (0/1/2) is not a time dimension | A deal closing tomorrow and an expiring lease in 90 days appear in the same flat list | Add `urgencyDays` field to digest items; sort by calendar urgency within severity tier | MEDIUM |
| 14 | Master Workbook is a single-author bottleneck | All Spine A data flows through one Excel file maintained by Gabriel | At 40+ properties, workbook maintenance becomes a multi-hour weekly task; formula errors propagate silently | Begin migrating authoritative fields to Notion DB or an API-writable data layer | MEDIUM (Phase 2 concern) |
| 15 | No budget vs. actual variance tracking | No budget data model exists in the warehouse or workbook | Cannot answer "are we running over budget at this property?" except from QB GL vs. a manual plan | Add budget row to `overlay.json` by property; compute variance in `noiVariance.ts` | MEDIUM |
| 16 | Scoring weights are ratified but not calibrated | Calibration log is new; no historical verdicts exist to validate against | A property scored 78 vs. 62 reflects intent, not data — confidence in capital recommendations is limited | Begin logging scored verdicts with `inputs_version` immediately so the calibration loop has data when it matures | MEDIUM |
| 17 | No automated OM detection from email | OM intake is manual (Block C identifies and summarizes; import is manual) | New OMs sit in email for hours before scoring; broker windows are competitive | Add OM detection rule to Block C that triggers an auto-import request | MEDIUM |
| 18 | Geographic concentration has no threshold alert | Conditions engine does not compute metro-level portfolio concentration | If one metro holds >50% of portfolio value and softens, no early warning | Add geographic concentration condition to `conditions.ts` | MEDIUM |
| 19 | SOFR/floating-rate exposure is invisible | Debt module shows weighted average rate but no fixed/floating split | With SOFR-indexed loans, a rate shock scenario is unquantified | Add floating-rate flag to debt schedule in workbook; surface in DebtModule | MEDIUM |
| 20 | AI agent is reactive Q&A only | No proactive synthesis layer | The most expensive insight (cross-source emerging risk) is never surfaced | Add a compound-threshold synthesis step to the daily brief Block B | MEDIUM |
| 21 | Lease-run proforma not yet built | Spec exists (`2026-06-14-pfi-lease-run-proforma-feature.md`); implementation pending | Cannot model hold-period lease-up within the acquisition scorecard — T1 PURSUE verdict requires this | Implement per the spec | MEDIUM |
| 22 | The static mirror loses all Intel intelligence | Warehouse routes are absent on Cloudflare Pages | Eric's mirror access (per `2026-06-15-eric-live-command-center-access-design.md` spec) has no Intel module | Implement the Eric access design spec | MEDIUM |
| 23 | No cross-default or lender concentration monitoring | Debt module is per-loan, not per-lender aggregate | A single-lender concentration + CRE stress event is the most correlated tail risk | Add lender-level roll-up to DebtModule | LOW-MEDIUM |
| 24 | Monthly expense sub-period trending is invisible | Warehouse grain handles annual/YTD only | Seasonal utility patterns and intra-year insurance true-ups require monthly grain | Extend ingest grain model to monthly where source data supports it | LOW-MEDIUM |
| 25 | No quarterly portfolio review briefing | No scheduled task or skill covers this | Annual capital allocation decisions are made without a structured quarterly business review | Register `ora-quarterly-portfolio-review` task | LOW-MEDIUM |

---

## 9. VALUE CREATION ANALYSIS (Top 10 Improvements)

| # | Improvement | Low Case | Expected | High Case |
|---|---|---|---|---|
| 1 | Collections/AR aging monitoring | Catch 1 delinquency faster / $5K saved | Catch 2–3 delinquencies/yr, faster resolution / $25K–50K NOI protection | Prevent 1 bad-debt write-off / $50K–100K | 
| 2 | Live QB export automation | 3h/wk time save / $15K equiv | 5h/wk + 1-week data latency reduction / $30K equiv | Full close cycle automation + reconciliation / $60K equiv |
| 3 | Live Notion/HubSpot deal sync | Accurate pipeline KPIs only | 1 better acquisition decision/yr (10% better IRR on 1 deal) / $50K–150K NPV | 2 better decisions + faster LOI execution / $200K+ |
| 4 | Market rent gap monitoring | Identify 2–3 below-market leases | Execute 3–5 rent bumps at renewal / $30K–80K NOI uplift/yr | Execute portfolio-wide mark-to-market over 3 years / $200K+ NOI uplift |
| 5 | Anomaly-to-alert pipeline bridge | Earlier detection of 2 expense spikes | Catch $20K–40K in controllable expense creep/yr | Identify a PM-attributed expense trend before it compounds / $75K |
| 6 | Monthly AI-narrated portfolio briefing | 1.5h/wk time save | Better monthly decision context; 1 proactive refi identified/yr / $30K–80K | Compound benefit of consistent monthly review habit / significant |
| 7 | Persist acquisition scores server-side | Audit trail only | Score history enables calibration loop / indirect value | Score comparison across deals → 10% better deal selection / $100K+ |
| 8 | Lease-run proforma in acquisition UI | Faster underwriting only | More accurate hold-period yield estimates → better go/no-go / $50K–100K per deal | Avoid 1 bad acquisition via more accurate proforma / $200K+ |
| 9 | Refi arm in capital action verdict | Surface refi candidates earlier | Identify 1 refi opportunity/yr (rate savings) / $20K–50K | Catch a lender concentration risk / $100K+ |
| 10 | Geographic concentration alert | Awareness only | Inform 1 market entry/exit decision / indirect | Prevent over-concentration in a softening market / $200K+ |

---

## 10. TOP 10 HIGHEST ROI IMPROVEMENTS

**Ranking methodology:** Business value (NOI impact + time savings + decision quality) × Strategic importance (unblocks other improvements) × Ease of implementation (1–3 month window).

**1. Wire anomaly flags to alert pipeline**
`detectAnomalies()` output is not consumed by `evaluateConditions()`. A 5–10 line bridge makes 6 categories of warehouse-detected anomalies visible in the Principal Home and AlertsModule. **Effort: 1 day. Value: HIGH immediately — the system already detects the anomalies; they're just not surfaced.**

**2. Collections/AR aging condition**
Add one new condition to `conditions.ts` reading AR aging from the Notion PM ledger output (already processed by `ora-pm-ledger` daily). No new data source required — the data exists, the alerting logic does not. **Effort: 2–3 days. Value: Highest single-point risk reduction in the system.**

**3. Live Notion/HubSpot deal pipeline sync**
Replace `src/data/seed-deals.ts` with a live adapter reading from Notion Acquisition Pipeline (page `bcfe4a03`) via the Notion MCP. The deal shape is already typed; the sync is the missing piece. **Effort: 3–5 days. Value: The acquisition module becomes real.**

**4. Persist acquisition scores server-side**
Add a `POST /api/acquisitions/:id/inputs` route that writes to `overlay.json`. `AcquisitionWorkbench.tsx` already has a `saveFn` hook. **Effort: 1–2 days. Value: Every subsequent acquisition calibration benefit flows from having a score history.**

**5. Monthly AI-narrated portfolio briefing**
Register `ora-monthly-portfolio-briefing` task. Read: warehouse Intel scores, NOI trend summary, WALT countdown, balloon maturities, acquisition pipeline status. Narrate cross-sectionally (e.g., "three of your orange-band properties are also in your bottom-quartile WALT cohort — potential double-hit if market softens"). **Effort: 1 day (skill authoring). Value: Fills the largest briefing gap.**

**6. Replace seed data market rent with quarterly comp sweep**
Extend `ora-replacement-cost-refresh` or create `ora-market-rent-comp-refresh` — quarterly CoStar/LoopNet scrape of market rent PSF by submarket. Feed into a new `marketRentGapPct` field on each tenant record. Surface in PropertyIntelView and conditions. **Effort: 3–5 days. Value: Unlocks #1 NOI upside signal.**

**7. Lease expiration action-list task (replacement for retired task)**
Register a weekly task that reads Notion Tenant DB, generates a prioritized expiration action list sorted by revenue-at-risk, and emails with HubSpot renewal-activity cross-reference. Mirror the retired `ora-lease-expiration-dashboard` logic. **Effort: 1 day (skill authoring). Value: Closes a known regression from the June 2026 task retirement.**

**8. Capex/improvement IRR calculator**
Add a `CapexIrrCalc` panel to the capital recommendation section of PropertyIntelView. Input: proposed capex amount + projected NOI uplift + hold period. Output: IRR vs. `capexIrr: 0.15` hurdle. No new data required. **Effort: 2–3 days. Value: The "invest" verdict finally has a number attached.**

**9. Geographic concentration condition**
Add a condition to `evaluateConditions()` that computes metro-level portfolio value concentration from the snapshot and fires a watch-level alert when any single metro exceeds a configurable threshold (default: 50%). **Effort: 1 day. Value: Closes a structural blind spot for the tail risk scenario.**

**10. Refinance arm in capital action**
Add `refinance` to the `capitalAction` enum and implement the evaluation path in `scores.ts`: `LTV < 0.40 && refiTriggerBps achieved`. This requires an appraised-value field on PeriodMetrics (a medium-complexity data addition) but could be approximated from `Property.oxfordValue` initially. **Effort: 5–7 days. Value: Surfaces a capital action the system currently has no way to recommend.**

---

## 11. KILL LIST

| Feature | Reason | Maintenance Savings |
|---|---|---|
| `ora-weekly-tooling-intel-sweep` (CC) | Surveys Claude/tooling releases; no direct operational value; duplicates awareness coverage in the daily brief | ~2h/month of scheduled session time |
| `ora-setup-audit` (CC, daily) | Audits session configuration; largely overlaps with `ora-health-guard` pre-session check; daily cadence overkill for setup-drift detection | ~30 min/day of session time |
| `ora-dormant-thread-revival` (CC, Fridays) | Revives old conversation threads; low observable value; no documented outcome | ~1h/week |
| `src/modules/relationships/RelationshipsModule.tsx` | Counterparty graph with no write path; CRM data is authoritative in HubSpot; this is a read-only visualization of data better viewed in HubSpot | 20–30 lines of complexity; module slot freed |

**Total estimated maintenance savings from kill list:** ~6–8h/month of scheduled session time + one module slot

---

## 12. FUTURE OXFORD STRESS TEST

**Assume:** 2M SF · 500 tenants · 10 markets · 10 PMs · 10 acquisitions/year

**What breaks first:**

1. **The Master Workbook** — a 500-tenant, 70-property Excel file is not viable. Formula evaluation time, single-author editing, and manual data entry would make this the #1 operational bottleneck within 18 months of the current growth rate. The Workbook is the load-bearing column of Spine A. At 2M SF it must be replaced with an API-writable data layer (Notion DB or a structured REST endpoint feeding the snapshot).

2. **GB Goldberg as single recipient** — every alert, every briefing, every output routes to `ggoldberg@oxfordra.net`. There is no delegation configuration in any scheduled task SKILL.md. At 500 tenants, the collections sweep and lease expiration action list alone would require staff-level delegation.

3. **SQLite warehouse** — better-sqlite3 is fast and well-designed for 27 properties. At 70+ properties with monthly P&L files, the database file grows ~5–10 MB/year. SQLite WAL remains practical up to ~100GB and millions of rows — this is not a near-term constraint. But the single-file on-disk model with no replication and no cloud query layer becomes a liability if the system needs to support Eric's remote access with live warehouse queries. The Cloudflare Pages mirror currently bakes a static snapshot; Eric cannot query the live warehouse remotely.

4. **GL account mapping review queue** — at 10 acquisitions/year with 50–100 new GL accounts each, the `pending-review` queue would require 1–2 hours/month of manual mapping approval. Not catastrophic, but a human gate that scales linearly.

5. **The 12-item session board cap** — at 10 simultaneous acquisitions, lease expirations, and PM issues, the `ora-open-sessions-board` cap would be hit weekly. The current design assumes a small, manageable outstanding-action count.

**What scales well without change:** The warehouse analytics layer (metrics/growth/drivers/anomalies/benchmarks/scores) scales to hundreds of properties with no architectural change. The scoring engine is a pure function of (db, metrics) — adding 50 more properties adds 50 more rows, not new code. The alert condition engine also scales cleanly.

**Single most important architectural decision to make NOW:** Move the authoritative NOI and occupancy source from the Excel Workbook to an API-writable layer. This decision is structurally irreversible at 50+ properties — once enough formula cross-references and user habit patterns are built into the Workbook, the migration cost multiplies. The `overlay.json` mechanism is already a write surface; the gap is making it the primary source rather than a secondary override.

---

## 13. FUTURE STATE DESIGN

**The ideal Command Center for a 2-person team running a $200M portfolio:**

### 5 Core Dashboards

1. **Daily Attention** (today's Principal Home + anomaly flags + collections alert) — everything actionable in the next 24–72 hours, in one view, with temporal urgency sort
2. **Portfolio Intelligence** (current OwnershipView + monthly trend overlay) — property rankings, ΔNOI drivers, PM scorecards with work-order data
3. **Acquisition Pipeline** (live Notion sync + scored workbench + lease-run proforma) — every live deal with score, verdict, and next-step
4. **Capital Deployment** (5-way capital action + capex IRR calculator + refi trigger + scenario stress-test) — where does the next dollar go
5. **Market Position** (submarket vacancy/absorption/rent trends by market + cap rate comp db + ORA in-place rent vs. market gap)

### 3 Core Automations

1. **Daily financial sweep** — automated QB export + collections AR aging → alert if any tenant 30+ days past due → reconcile Spine A vs. Spine B NOI
2. **Weekly intelligence digest** — deals scored and ranked; lease expirations with revenue-at-risk; PM performance flags; next week's action list
3. **Monthly narrative brief** — AI-synthesized: NOI trajectory, WALT trend, balloon countdown, acquisitions vs. plan, capital allocation review — a board-ready portfolio summary without manual assembly

### AI Agent Evolution

Move from Q&A substrate to **compound-signal detector**. The agent's highest-value role is not answering "what is my DSCR?" — it is synthesizing: "three of your orange-band properties have balloon maturities in the next 18 months at a time when the 10Y is rising and your Kansas City WALT is compressing. This combination deserves a refi conversation before Q4." This requires: (a) the anomaly-to-alert bridge, (b) the briefing cross-section synthesis step, and (c) a scheduled compound-threshold evaluation engine.

---

## 14. IF I WERE COO/CTO OF OXFORD TOMORROW

**Constraint:** One year. Two principals. Existing platform. Prioritize ruthlessly.

| # | Improvement | Why | Impact | Effort | Risk |
|---|---|---|---|---|---|
| 1 | **Wire anomaly flags to alert pipeline** | The system already detects the fires; they're just not sounding the alarm | Immediate: highest-value signals become visible | 1 day | None — additive bridge |
| 2 | **Collections/AR aging condition** | 140 tenants, zero delinquency monitoring — the #1 unmonitored revenue risk | Protects $25–50K NOI/year on expected value | 2–3 days | None |
| 3 | **Live Notion deal pipeline sync** | Every acquisition KPI is seed data; LOI decisions have no system grounding | Real acquisition intelligence for the first time | 3–5 days | Low — Notion MCP is connected |
| 4 | **Monthly AI-narrated portfolio briefing** | The daily brief tells you what happened; the monthly brief tells you where you're going | 1.5h/week time save + better monthly decisions | 1 day (skill authoring) | None |
| 5 | **Persist acquisition scores server-side** | Scoring history is the prerequisite for calibration, deal comparison, and IC memo data | Unlocks calibration loop, deal comparison, audit trail | 1–2 days | None |
| 6 | **Lease expiration action-list task (retirement replacement)** | The retired task left a gap in weekly lease tracking; renewal risk is partially invisible | Closes a known regression | 1 day (skill authoring) | None |
| 7 | **Quarterly rent comp sweep per submarket** | Rent-gap analysis is the #1 NOI upside signal and the #1 acquisition rent-assumption input | $30–80K NOI uplift/year from better lease renewal pricing | 3–5 days | Medium — web data quality |
| 8 | **Capex IRR calculator in capital recommendation** | "Invest" verdict without a project and a return is half an answer | Turns the capital recommendation into an actionable deployment plan | 2–3 days | None |
| 9 | **Geographic concentration alert** | A softening market with 50% concentration is the most correlated tail risk | Surfaces the #1 unmonitored structural risk | 1 day | None |
| 10 | **Merge Phase 1a to main (NOI reconciliation)** | Two NOI numbers that can silently disagree is the root structural integrity issue | Closes H2/H3/H5 class of financial mis-computation risks | Already built, needs PR merge | Low — gate verifies |

**The single most important thing to do in the next 30 days:**
Ship #1 and #2 (anomaly bridge + collections condition). Both are < 1 week of work. Together they move the early problem detection grade from C+ to B and make the most dangerous invisible risk (delinquency) visible. Everything else on this list builds on a foundation that works. These two close holes in a foundation that currently leaks.
