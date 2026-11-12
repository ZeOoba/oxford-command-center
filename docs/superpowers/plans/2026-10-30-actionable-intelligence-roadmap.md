# Actionable Intelligence Roadmap — Command Center (2026-10-30)

> **Status: Wave A IN PROGRESS (approved by Gabriel 2026-10-30).** Built against `origin/main@9edfc015`. Per CLAUDE.md §3, no phase starts without architect (Gabriel) approval. Financial-engine work (Tracks 4–5) goes through the `refute-financial-change` workflow before commit.
>
> **Coordination:** Overview ranking/action rows are already in flight — PRs #505, #509, #516 and worktree `action-rows` (`feat/action-list-rows`, design step 4). This roadmap does **not** re-plan them; Track 2 only adds what they leave out. Ratified constraints carried forward: ranking = pinned safety → dollars → days (no urgency×confidence); $5K global materiality floor; Overview cap 7; no owner model; never sum workbook-basis and ledger-basis NOI; never invent dollars ("not yet sourced" instead).

---

## 1. Bottom line

The command center's **presentation layer is ahead of its data**. The biggest gains don't come from new widgets. They come from three things:

1. **Getting current data into it.** The P&L warehouse is 139 days old, and the trend data is annual only.
2. **Labelling estimates honestly.** Half the portfolio's "NOI" is gross rent.
3. **Then layering forward projections and $-quantified levers per property** on top.

If prediction is built before (1) and (2), it forecasts from June annual totals and placeholder expenses, which is worse than no forecast.

## 2. Evidence (verified 2026-10-30)

### 2a. Live update timeline

| Feed | Refresh trigger | Age today | Signal shown? |
|---|---|---|---|
| Master Workbook → snapshot | file watch + weekly Monday PR | asOf 10-23 (7d); main checkout copy 10-06 (24d) | yes (2d budget — fires on idle-but-correct data too) |
| **P&L warehouse (Spine B)** | manual `warehouse:backfill` only | **all 32 batches imported 2026-06-13 (139d); grain = annual; 2026 YTD stops at June** | **no** — not a `FeedId`; `warehouse:verify`/`drift` use a fresh tmp DB so stay green |
| Monthly P&L | not built (wave 3a is **sample-gated**: needs one monthly export per accounting system) | n/a | n/a |
| Notion deals / M365 tasks | only inside `parseWorkbook` (`parse.ts:2123,2132`) | = last workbook save | degraded flag only |
| HubSpot/Notion acq sync | on request | 23d (`acq_candidates` max 10-07) | no |
| AR aging | manual QB export + `ar-import-headless` | 66–107d vs 35d budget | yes, but stale records silently drop out of collections gating |
| `overlay.json` | in-memory, never re-read | 10-06 | no |
| Macro (FRED) | per request | `source:'mock'` (no key) stamped with workbook date | weak |
| Lease market comps | manual ingest/compute | 27–43d vs 14d | yes |
| Tax assessments | manual import | latest assessment 2025-07-01 | no |

Empty warehouse tables that engines depend on: `lease_terms`, `lease_events`, `lease_facts`, `obligations`, `market_series`, `recommendations`, `lm_market_rent_feed`, `pca_*`, `capex_*`, `insurance_loss_events`, `tax_appeals`.

### 2b. Data quality (decision-impact order)

1. **Spine A NOI = gross rent on 7/14 properties.** `expenses` = 0 for 55 New Plant, 9050 Red Branch, 3540 E 5th, Livingston, 401 Sunburst, 7658 Fishel, 9510 Persimmon. The other 7 carry round placeholder values. QB shows materially higher 2024 expenses for 9050 and a non-zero figure for 3540. Root: `parse.ts:431` `num(row(ws,r,12)) ?? 0` turns a blank cell into a real-looking $0. This flows into portfolio NOI, value, cap rate and DSCR.
2. **A↔B NOI tie-out covers ~85% of NOI.** Northwood, Fishel/Sunburst and FVC are untieable. `reconcile:noi-crosscheck` and `warehouse:drift` exit 0 when the DB is absent.
3. **Lease data:** 10 escalation dates passed without a rent change. Northwood A8/C4 are "Active" with a 2024-09-01 end. 2 expired leases are still on the roll. The `Lease` contract has no recovery/CAM type, options or deposit, so recovery leakage is unmeasurable.
4. **Insurance:** 10/30 rows are past expiry, 24/30 have no TIV, and 30/30 have no deductible or limit. The self-insure view runs on placeholder loss events.
5. **Debt master:** `originalPrincipal`/`annualInterest`/`annualPrincipal` are null on all 12 loans, and maturity is null on 5. Any forward DSCR projection is blocked until these are filled.
6. **Property master:** city/state are hard-null (`parse.ts:419-420`), and SF disagrees between master and snapshot on 3 properties.
7. **Silent failure paths:** a corrupt overlay returns empty (`overlay.ts:354`). Runtime DQ flags are not persisted. Unmapped GL accounts are visible only at gate time.

### 2c. Analytics: what exists vs. what's missing

- **Exists:**
  - Own-history expense variance, but only for the 9 PM-reported entities.
  - Peer $/SF for taxes, insurance and R&M only.
  - Rule-based renewal bands.
  - Tax-appeal $ and insurance excess-premium $.
  - PCA capex $.
  - 11 portfolio-wide "value of a point" levers.
  - An insights ranker with **one** generator.
- **Missing:**
  - Any forward per-property NOI/DSCR projection with a breach date.
  - Missed-escalation $: the alert says "confirm the bump" with `impactAnnualUsd: null`.
  - Mark-to-market $ across the roll: blank wherever no manual market rent is entered, and the CoStar feed is excluded.
  - Recovery leakage beyond 3 properties.
  - Utilities, grounds and management-fee peer $/SF.
  - Vacancy carry cost.
  - Any capex → NOI/DSCR linkage.

### 2d. Design

- **Priority Actions rows have no verb and no link.** `mergedToTierItem` emits no `actions`/entity ref (`insights.logic.ts:267`).
- **No canonical property page.** Trends are split across Portfolio›Trends, Portfolio›Expenses, Financials›Property and PF›Explorer. The EntityDrawer has no chart and no link to any of them.
- **Static numbers.** The property table and 7 of 8 KPI tiles show no trend cue.
- **Six overlapping attention lists** built in parallel code paths.
- **Property Financials ships its own chart kit** (`pf.css` is 1,274 lines).
- **Weak accessibility.** `AreaChart`/`Sparkline` have no aria label or text alternative.
- **Staleness is shown only globally.** Trend cards have no per-card as-of.

## 3. Root causes

| # | Root cause | Symptoms |
|---|---|---|
| R1 | Inputs don't flow automatically. Every Spine B and side feed is a manual script with no freshness signal. | 139d ledger, stale AR, empty engine tables |
| R2 | Blanks coerce to $0 or empty instead of "unknown". | Gross-rent NOI, phantom $0 expenses, silent overlay failure |
| R3 | Analytics are backward-looking and portfolio-wide. Levers are sensitivities, not per-property $. | No prediction, no ranked $ actions per property |
| R4 | UI grew by module, not by question. | No property page, verbless actions, duplicate lists |

## 4. Plan: five tracks in three waves

### Wave A — Truth & freshness (≈1–2 weeks; mostly small, low-risk)

**Track 0: data you supply (no code; unblocks everything downstream)**

- [ ] **0.1** One **monthly** P&L export per accounting system (QB Desktop + each PM system). Unblocks wave 3a/3b monthly trends.
- [ ] **0.2** Fresh **2026 YTD (through Sep)** P&L for the 32-file set. Then `warehouse:backfill`.
- [ ] **0.3** Actual operating expenses (or confirmed absolute-NNN status) for the 7 zero-expense properties. Replace the round placeholders on the other 7 with actuals.
- [ ] **0.4** QB AR aging export → `ar-import-headless`. Resolve the 2203 Marvel C4 review-queue item.
- [ ] **0.5** Debt schedule fields: original principal, rate/annual P&I, maturity for all 12 loans.
- [ ] **0.6** Insurance dec pages for the expired terms (10-07 punch list A–C plus 9620 / 1851 flood).
- [ ] **0.7** Rulings: Northwood A8/C4 (vacated / holdover / renewed), the 2 expired-but-listed leases, and the 10 passed escalations (applied or not).
- [ ] **0.8** `FRED_API_KEY` in `.env` (free).

**Track 1: freshness & honesty (code)**

- [ ] **1.1** Add `warehouse` (latest `period_end` + `imported_at`) and `overlay` to `FeedId` in `server/feed-freshness.ts`, with budgets. Show both in System Health and the TopBar dot.
- [ ] **1.2** Per-card **as-of chip** on every trend, sparkline and lever card, stating basis: "Ledger FY2025 cash" / "Workbook asOf 10-23".
- [x] **1.3** **Unknown ≠ $0 (as ruled 2026-10-30: label, don't restate).** Income properties whose expenses are $0 or blank get an info `landlordCosts` flag ("NNN, not absolute: landlord-paid roof, structure and paving costs not sourced"), shown on the Portfolio NOI cell, Health and the AI tools. Values and rollups are unchanged until PCA schedules supply the costs (Wave C). *Shipped with 1.9; refute-gated.*
- [ ] **1.4** Decouple Notion/M365/HubSpot from workbook parse. Run a scheduled source refresh (proposed every 15 min while the server runs) that patches the snapshot and pushes over the existing `/sse`. Base snapshot staleness on `asOf` and source fetch times, not `generatedAt`.
- [ ] **1.5** Overlay file watcher with a reload-on-change, plus a visible error on a corrupt overlay instead of a silent empty.
- [ ] **1.6** Persist runtime DQ flags (`checkSnapshot`) into the snapshot. Surface the unmapped-GL count with a $ figure in Data health.
- [ ] **1.7** On the primary machine, `reconcile:noi-crosscheck` / `warehouse:drift` **fail** (not exit 0) when the live DB is missing. Add NOI parity to `live-drift.ts`.
- [x] **1.9** Exclude 9510 Persimmon (residence) from every surface (ruling 2). Removed exactly at the parse boundary (property row + leases resolving to it + their flags; totals restated); ambiguous names or loan/insurance rows that resolve to it block the persist instead of being guessed.
- [ ] **1.8** Scheduled weekly `warehouse:backfill` against the P&L folder via `register-scheduled-task`, plus an AR inbox watcher. Both are no-ops when nothing changed (hash dedup).

**Track 5a: quickest real $ lever**

- [ ] **5.1** Missed-escalation $: for each lease past its escalation date with unchanged rent, compute `currentRent × escalationPct` annualized into `impactAnnualUsd`. The 10 known cases rank through the existing Priority Actions pipeline. *Engine change → refute workflow.*

### Wave B — Property-level trends & one property page (≈2–4 weeks)

**Track 2: actionable UI (complements step 4, doesn't duplicate it)**

- [ ] **2.1** After `feat/action-list-rows` lands: carry `entityType`/`entityId` through `MergedInsight`. Every row gets one primary verb plus "Open property".
- [ ] **2.2** **Canonical Property page.** Promote PF›Explorer to `/property/:id`. Layout from top:
  - Header: KPIs with sparklines and basis labels.
  - Outlook strip (Track 4).
  - Trends: NOI, occupancy, rent/SF, opex lines.
  - Lease rollover ladder with the rent-gap column.
  - Levers (Track 5).
  - Open alerts.
  - Documents.

  The drawer, the property table, alerts and the other trend views link into it.
- [ ] **2.3** Collapse the six attention lists onto one `TierItem` builder and one actions factory. Delete or redirect the default-off Overview Insights board.
- [ ] **2.4** Property table: add an NOI-12m sparkline and an occupancy-Δ column. KPI tiles get MoM/YoY deltas where a recorded series exists.
- [ ] **2.5** Accessibility: required `ariaLabel` on `AreaChart`/`BarChart`, and a text summary for `Sparkline`. Route Overview through `useSnapshotGate`.
- [ ] **2.6** Migrate PF charts onto `src/charts` gradually (no new parallel kit).

**Track 3: trends (needs 0.1/0.2)**

- [ ] **3.1** Execute wave 3a (monthly ledger, separate tables; plan already written) and wave 3b (expense UI + alerts).
- [ ] **3.2** **Property × expense-line $/SF matrix**: taxes, insurance, R&M, utilities, grounds, management fee. Cells shade by portfolio quartile, as an interim until the ratified per-column thresholds for design step 7. Add utilities/grounds/mgmt to `NumericMetricKey` peer benchmarks.
- [ ] **3.3** Trend cards show "recorded vs reconstructed" legends everywhere. Forecast regions get a **scenario-spread band** (not labelled as statistical confidence).

### Wave C — Prediction & $ levers (≈3–5 weeks; financial engines, refute-gated, Opus floor)

**Track 4: Property Outlook (early warning)**

- [ ] **4.1** New engine: a per-property 24-month forward projection. Inputs:
  - Contractual rent roll with escalations.
  - Expiries resolved per scenario: renew-at-market / renew-flat / vacate + downtime from `lease-velocity`.
  - Opex trend (ledger, its own basis).
  - Debt service from 0.5.
  - PCA near-term capex.

  Output, per property: projected NOI and DSCR by month, with a **first-breach date** for DSCR < 1.25×. One basis per projection, labelled.
- [ ] **4.2** Early-warning flags feeding Priority Actions (safety items pinned as today):
  - Projected DSCR breach within 12/24 months.
  - Rollover concentration: ≥ X% of property rent expiring in 12 months.
  - Expense line growing > Y% YoY.
  - Insurance renewal ≤ 60 days with the register incomplete.
  - Capex due with no reserve.
- [ ] **4.3** Outlook strip on the Property page, plus a portfolio "properties at risk" list on Overview within the 7-row cap.

**Track 5: profit levers, $-quantified per property (respect the $5K floor)**

- [ ] **5.2** **Expense overage vs peer**: `(property $/SF − portfolio median $/SF) × SF` per line, shown as a "reduction opportunity". Routes are line-specific: utilities → rate/submeter review; R&M → vendor rebid; insurance → existing rebid engine; taxes → existing appeal engine (needs current assessments).
- [ ] **5.3** **Mark-to-market**: per-lease gap at expiry/renewal using manual market rents, with the CoStar feed shown as a separate "indicative" figure (ruling needed). Never mixed into `rentForecast` without a ruling.
- [ ] **5.4** **Vacancy carry cost**: vacant SF × market rent ÷ 12 per month, plus days vacant. Ranks lease-up urgency.
- [ ] **5.5** **Recovery/CAM leakage**: add `recoveryType` (NNN / mod-gross / gross) to the `Lease` contract (architect-owned). Then compute billable vs billed per property. Today only 3 properties are covered.
- [ ] **5.6** Register generators 5.1–5.5 with the insights ranker, which currently has one generator.

### Explicitly deferred / diminishing returns

- Owner column, alert lifecycle, Realized scoreboard (owner model unratified).
- KPI target tiles for occupancy/WALT (targets unratified).
- ML/statistical forecasting. A transparent scenario model beats a black box at 14 properties and 2–3 years of history.
- More AI narrative. Low marginal value until the data under it is current.

## 5. Pre-mortem (assume it fails — why?)

1. **Forecasting from stale/placeholder data.** Mitigation: Wave A gates Wave C. Track 4 refuses to render for a property whose expense basis is "not sourced" or whose ledger is older than its budget.
2. **Cross-basis mixing.** Workbook forward rent and ledger cash actuals in one NOI line. Mitigation: every series carries a basis tag, and the projection picks exactly one.
3. **Collision with in-flight work** (#505/#509/#516, `action-rows`, `command-center-analysis-64c1d3` signal-discipline plan). Mitigation: Track 2.1 starts only after step 4 merges. Claim `architecture/status.json` per track.
4. **Invented dollars.** Mitigation: any lever without a sourced input renders "not yet sourced", consistent with the 10-29 ruling.
5. **Track 0 stalls.** Manual exports are the critical path. Mitigation: 1.8 automates everything after the first export, and 1.1 makes the age impossible to ignore.

## 6. Rulings (Gabriel, 2026-10-30)

1. **$0-expense properties.**
   - 55 New Plant, 9050 Red Branch, 3540 E 5th, Livingston, 401 Sunburst and 7658 Fishel are all **NNN but not absolute**. The landlord is responsible for roof, structure and paving.
   - $0 therefore understates landlord cost. Landlord non-recoverable costs are **PCA-driven**: roof, structure and paving from the Property Condition capex schedule where a PCA exists. Otherwise show "LL structural costs not sourced". **No flat $/SF reserve.**
   - Item 1.3 labels these "NNN — LL structural costs not sourced" (not "gross rent"). Track 4.1 takes their capex from PCA only.
2. **9510 Persimmon Tree Rd is a residence. Exclude it everywhere in the command center.** This means every KPI, table, chart, alert, rollup and the Outlook. It supersedes the 2026-09-24 "residence out of capital verdicts + Notion, equity disclosed" ruling. Add as item **1.9**: a single exclusion at the property-master/snapshot boundary, with a test that it appears on no surface.
3. **Source refresh cadence: weekly** scheduled refresh of Notion/M365/HubSpot. The existing on-save and on-startup triggers are kept, so the weekly run is a floor, not a replacement. Item 1.4 changes from 15-min to weekly, registered via `register-scheduled-task`. Snapshot staleness budgets for these sources become 7 days.
4. **CoStar in mark-to-market: yes, labelled "indicative".** Manual market rents override it. It never feeds `rentForecast` or NOI math (5.3).
5. **Outlook basis: composite, labelled.** Rent comes from the contractual rent roll plus escalations. Opex comes from the ledger trend. LL structural capex comes from PCA. Tagged "composite" and never summed with workbook NOI (4.1).
6. **Early-warning thresholds:** ≥ 35% of a property's rent expiring within 12 months; an expense line growing > 15% YoY **and** by ≥ $5K (4.2).
