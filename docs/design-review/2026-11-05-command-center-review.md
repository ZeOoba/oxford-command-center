# Command Center Review — 2026-11-05 (learning loops, data flows, design)

**Built against:** `origin/main` 55e43c52, the live server on :8911 (workbook as of 2026-11-05) and the committed snapshot history.
**Scope rule:** builds on the 10-30 roadmap (`docs/superpowers/plans/2026-10-30-actionable-intelligence-roadmap.md`) and the 10-31 design review. It does not re-propose shipped work. Most of Waves A and B merged 10-31 → 11-03 (#520, #522–#528, #531, #538–#548).
**New lens:** calibration and self-improvement. Does the system learn from what happens after it makes a call?

---

## 1. Bottom line

1. **The system makes predictions but never grades them.** It has logged 68 verdicts with 0 resolved outcomes. Renewal bands, rent forecasts, insight rankings and alert responses are not persisted or graded at all. No outcome changes any weight or threshold; that is by design, and every step needs a human.
2. **The acquisition engine has never scored a live deal.** There are 23 pipeline deals (11 dead) and 26 synced candidates in `acq_candidates` (13 active, 13 passed), but `acquisitionInputs` is empty and there are 0 acquisition verdicts. The 13 passed candidates carry no outcome, because none was ever scored. Underwriting happens in the Cowork `acquisition-underwriting` skill, and nothing carries its inputs into the command center. Priority #1 (acquisition velocity) therefore gets no ranking or calibration from the engine built for it.
3. **The learning bottleneck is data supply, not code.**
   - **P&L ledger:** no source file is newer than 2026-06-12, so the annual-horizon verdicts cannot resolve until FY2026 is ingested.
   - **PCA register:** the file existed and imported cleanly, but it had never been loaded into the live warehouse. **Imported 2026-11-05** (see §2b item 1).

## 2. Evidence

### 2a. Learning loops: state of each one

| Loop | Prediction stored? | Outcome captured? | Status |
|---|---|---|---|
| Health band, attention, capital action, anomaly (`calibration_verdict`) | yes, 66 | auto, but only once a later full-year ledger period exists | blocked: ledger frozen at FY2025/2026-06 |
| Insurance rebid (2), tax appeal | yes | manual resolve only | 2 open, resolvable now in Data › Calibration |
| Acquisition score | yes, when scored | manual status PATCH only; the HubSpot/Notion syncs bypass `logAcqOutcome` (documented gap, `acq-engine.ts:169`) | **dormant: 0 deals scored** |
| Renewal band (`renewalSignals`) | no, computed per request | no; `lease_events` has a reader and **no writer** | not instrumented |
| Rent forecast scenarios | no | no | not instrumented |
| Insight / alert dispositions | `recommendation_feedback` exists, display-only by design | n/a | deliberately not fed back |
| AI narrative | no; `agent_runs` has **no callers** | no | AI cost and prompt version not logged |
| Brier score | `brier_component` always null | n/a | never computed |

**The fastest loop available is lease outcomes:** about 45 leases expire every 12 months.
- Each one resolves to renewed, vacated or holdover within weeks.
- They would calibrate the ratified **65% default renewal probability** and the **6-month downtime** used in the rollover reserve (`liquidity-policy-inputs`). That reserve feeds deployable acquisition capacity.
- The weekly committed snapshot (`data/snapshots/portfolio.json`, 37 versions since 2026-07-27) is already a durable longitudinal record. Nothing reads it longitudinally.
- A read-only probe of that history found 147 distinct leases, 14 with end-date changes and **6 resolved expiries** in the window (1 renewed, 1 vacated, 1 holdover, 3 removed before end). That is too few to calibrate today. At the current rate it reaches about 20 by Q1 2027.
- The data is not being lost (git keeps it), so this can be built when n justifies it. Diminishing returns before then.

### 2b. Data flows still leaking (verified in code)

1. **The PCA register had never been imported. Resolved 2026-11-05** (on Gabriel's go-ahead).
   - `2026-10-06_PCA-Extraction_Register_v01_2.xlsx` was imported into the live warehouse in one transaction: 17 reports, 50 components, 13 quotes, 20 asset facts, 5 calibration pairs, 16 open items.
   - 13 of the 17 reports mapped to the property master. The 4 unmapped (E. Fulton, St. Michaels, Muirkirk, Sheriff Rd) are not in it.
   - The six target tables were empty beforehand, no other table changed, and `quick_check` passed.
   - The Property Condition page now shows immediate-repair, short-term and capex-reserve (uninflated) totals, with 8 of 16 properties carrying dollar figures and 6 report-currency alerts.
   - Those page totals are the register plus the curated correction overlay (`src/modules/property-condition/pca-overlay.ts`, from the 2026-10-13 PCA Command Center report). The raw register totals from `/api/warehouse/property-condition/report` differ from those page totals. Both exclude stale reports.
   - Ruling 2026-10-30 makes PCA the only allowed source for the landlord structural costs of the 6 NNN-not-absolute properties. Two of them, 55 New Plant and 9050 Red Branch, hold only pre-2024 reports, which are excluded from totals as stale.
2. **The P&L ledger is frozen.** The Property Financials folder holds only 2026-06-12 exports. A scheduled backfill (roadmap 1.8) would be a no-op until Track 0.2 exports exist.
3. **Capital allocation mislabels live macro.** `capital-allocation.ts:1331` maps `source: 'live-fred'` to `'mock'`. The live server returns `live-fred`, so the allocation report's macro context reads "mock" today. In the same function, the comment "FRED down = null DGS5 = refi signal suppressed" (`:978`) is false: `getMacro()` never returns null. It falls back to June-2026 seeded rates, while `debt-api.ts` does suppress. So during a FRED outage the two refi surfaces disagree.
4. **`market-intel.ts:76-84` hard-codes the FRED source as `stale:false` at confidence 1.0, including the seeded fallback.** Census and comps are always stale because `market_series` has no writer, so the market score rests on FRED alone.
5. **`loadOverlay` swallows a corrupt overlay** (`overlay.ts:390`). Readers get an empty overlay, which zeroes tenantArrears, marketRents and stages, with no signal.
6. **Properties-sheet blanks become 0 without a flag** (`parse.ts:411-446`): sf, value, NOI, debt service, equity. A blank `oxfordOwnPct` becomes 100%. This is latent today, since the live cells are populated.
7. **Several readers have no writer:** `lease_events` (Leasing Velocity, always empty) and `market_series`. `lease_facts`, `obligations` and `recommendations` are dead schema.
8. **No freshness feed** for the insurance, PCA, tax, debt and acquisition-sync registers, or for the QuickBooks CSV. The `leaseMarket` feed measures compute time, not CoStar export date.

### 2c. Design (10-31 review): what was still open

- #6: the NOI and cap-rate tiles had no landlord-cost marker. Six of 13 properties, about 41% of workbook NOI, carry $0 expenses.
- #7: two timestamps with no labels.
- #8: NOI basis unlabelled on Ownership, Property, Portfolio and the filter bar.
- #12: the empty Leasing Velocity panel.
- Still open: #10 (rail naming), #11 (empty rail destination; fixed by the PCA import above), #14 (6 `fmtPct` copies), #15 (4 table implementations) and #16 (raw errors, a hard-coded `:8911`).

## 3. Shipped in this branch (`claude/command-center-review-d58820`, UI only, no refute path)

| Change | Files |
|---|---|
| **Landlord-cost caveat on headline figures.** "LL costs not sourced · 6 of 13" appears on the Overview NOI tile, whose caveat covers the weighted cap in its sublabel. Portfolio's separate NOI and cap-rate tiles each get their own. "LL costs not sourced on 2 of 5 levered" appears on the DSCR governor tile in neutral text, since colour there means a governor state; the weakest-DSCR property (3540 E. 5th, 1.48x) is one of the two. Labels only; nothing is restated (ruling 2026-10-30). | `src/modules/overview/landlord-cost-caveat.ts`, `LandlordCostChip.tsx`, `widgets.tsx`, `GovernorTiles.tsx`, `src/primitives/KpiStat.tsx` (`caveat` slot), `src/modules/portfolio/PortfolioModule.tsx` |
| **One `BasisChip` primitive** using the spine vocabulary. Ownership now reads "$1.20M · Ledger · FY2025 · entity 100%" (a YTD period adds "partial"), against the Overview "$1.00M · Oxford share · workbook" and Portfolio "$1.00M · Workbook · Oxford share" (illustrative figures). Before, the two sat 20% apart with no basis shown. Also on Property NOI, the Portfolio NOI KPI, the cap-rate tile and the "NOI · workbook" column, plus "workbook NOI" in the filter readout. | `src/primitives/BasisChip.tsx`, `OwnershipView.tsx`, `PropertyIntelView.tsx`, `PortfolioModule.tsx`, `PortfolioFilterBar.tsx` |
| TopBar "Workbook as of …" (data date), distinct from the pill's "updated … ago" (server read). | `src/shell/TopBar.tsx` |
| Leasing Velocity: a one-line "Not yet sourced" note that says no feed exists, instead of an empty panel. | `LeaseForecastModule.tsx` |

Verified on the live data through a worktree dev server (screens: Overview, Portfolio, Financials › Ownership and Property, Leasing › Rollover).

New tests: `overview-landlord-cost-caveat`, `basis-chip`. Surface coverage was added to `portfolio-module-other-holdings`, `intel-ownership-smoke` and `portfolio-filter`, and `topbar-title` and `lease-forecast-module` were updated.

`npm run gate` was green through `warehouse:verify`: 574 test files and 10,829 tests passed, and `reconcile` passed again. The final step, `warehouse:drift`, fails only against this worktree's stale 10-30 stub `data/warehouse/finance.sqlite`, which is environmental. The diff touches no server or warehouse code.

## 4. Recommended next (ranked by business value ÷ effort)

### Do now (data supply; you or one command)

1. ~~Import the PCA register into the live warehouse.~~ **Done 2026-11-05** (§2b item 1). A corrected register can be re-run the same way: the import is one transactional refresh and idempotent.
2. **Export the 2026 YTD (through Oct) P&L set (Track 0.2), then run `warehouse:backfill`.** This one action unfreezes trends, the ledger feed, roadmap Wave C and the first calibration resolutions.
3. **Resolve the 2 open insurance-rebid verdicts** in Data › Calibration (manual resolve). These are the first graded outcomes the system would hold.

### Build next (needs the `refute-financial-change` workflow; server/ and scripts/ are default-deny)

4. **Macro honesty bundle (S).** Fix the `live-fred` → `mock` label. Make capital allocation's DGS5 suppress on a seeded fallback, as `debt-api` does. Have `market-intel` treat `mock`/`seed` as stale. Stamp seeded macro with its seed date, not `WORKBOOK_AS_OF`.
5. **Acquisition screen-packet import (M, priority #1 business goal).**
   - The `acquisition-underwriting` skill writes its SCREEN inputs as JSON to a watched folder. The command center ingests it into `acq_score_inputs` and scores the deal; `persistAndLogScore` then logs the verdict.
   - Close the documented sync gap at the same time: on a terminal HubSpot/Notion transition, call `logAcqOutcome` (it is idempotent).
   - Result: every screened deal is ranked by verdict on Acquisitions, and Dead/Closed outcomes grade the engine.
   - Backfill opportunity: score the 11 dead deals from their final screens.
6. **Lease-outcome ledger (M, build when n ≥ 12, about Q1 2027).** A script over the snapshot history writes `lease_events` (vacate/commence) and renewal-band verdicts (`verdict_kind 'renewal-band'`, `subject_kind 'tenant'`; no migration needed, since `verdict_kind` has no CHECK). It reports the observed renewal rate (Wilson CI) against the ratified 65%, and median downtime against 6 months. Advisory only, per the calibration stance.
7. **Overlay corruption signal + blank-cell flags (S).** `loadOverlay` returns a degraded marker that System Health shows. Core blank cells in the Properties sheet raise a `warn` flag, using the `isoOrNull` pattern.
8. **Freshness feeds for the registers (S, touches architect-owned `server/index.ts`).** Insurance, PCA, tax, debt, acq-sync and QuickBooks, each from `MAX(imported_at)`.
9. **Compute `brier_component`** wherever a verdict carries a confidence (S). Wire `withAgentRun` around the AI calls (S), so model, prompt version and cost are logged before more AI surface is added.

### Deferred / not recommended

- Auto-tuning weights from outcomes. It conflicts with the standing advisory-only stance, and n is too small for years.
- Alert disposition lifecycle (owner model unratified, ruling 10-29).
- More AI narrative until items 1–2 land.

## 5. Decisions needed

1. ~~Run the PCA import against the live warehouse (item 1)?~~ Approved and done 2026-11-05.
2. Authorize the `refute-financial-change` workflow for the macro honesty bundle (item 4)?
3. Approve a learning-loops track (items 5–6) as a roadmap addition, with item 5 (acquisition screen packets) first?
4. `architecture/status.json` claims are blocked by the file guard without your architect sentinel. Its stale `wave-b-ui` entry still names this worktree. Flip it to merged?
5. **Should Portfolio Value and LTV carry the landlord-cost caveat too?** This came from an independent reviewer pass and predates this branch.
   - In the committed snapshot, workbook value equals NOI ÷ cap for 4 of the 6 $0-expense properties (e.g. NOI 80,000 / cap 0.08 = value 1,000,000, illustrative).
   - So the unsourced landlord costs also overstate Portfolio Value and understate aggregate LTV, and neither tile says so today.
   - This branch labels only the NOI, cap-rate and DSCR figures.
