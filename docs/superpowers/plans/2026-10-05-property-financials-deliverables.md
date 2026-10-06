# Property Financials — deliverables (2026-10-05)

## 1. Entity → command-center property id (one page)

Source: `server/property-financials/mapping.ts` (read-only join to `CANON_PROPERTIES`; never writes the property master).
Live view: Data → Quality → Property Financials (printable).

| Dataset entity | Canonical id | Method | Flags |
|---|---|---|---|
| 1100 Rarig | 1100-rarig-ave-columbus-oh | exact | — |
| 1900 Broadway | 1900-n-broadway-baltimore-md | exact | — |
| 29000 Info Lane | 29000-information-lane-easton-md | exact | — |
| 3034 Westerville | 3034-westerville-rd-columbus-oh | exact | SF differs: dataset 18,360 vs master 18,000 |
| 3540 E 5th | 3540-e-5th-ave-columbus-oh | exact | — |
| 3883 Livingston | 3875-3883-e-livingston-ave-columbus-oh | exact | — |
| 9050 Red Branch | 9050-red-branch-rd-columbia-md | exact | — |
| 9620 State 350 | 9620-e-state-route-350-raytown-mo | exact | SF differs: dataset 34,300 vs master 34,560 |
| FVC | sepich-portfolio-columbus-oh-8-props | **INFERRED** | **Confirm me** (Sepich mapping rests on SF-sum and rent reconciliation); SF differs: 109,657 vs 110,000 |
| 55 New Plant (EGFLLC) | 55-new-plant-ct-owings-mills-md | exact | — |
| 1851 South Club Solar | 1851-s-club-solar | exact | — |

Unmatched: none today (an unmatched entity gets `canonicalId: null` plus a flag). Excluded: 2203-2207 Northwood (financials pending); 7658 Fishel and 401 Sunburst have leases but no P&L and appear under "Leases with no P&L entity".

## 2. Intentional differences from the reference artifact

| # | Area | Artifact | This build | Why |
|---|---|---|---|---|
| 1 | Placement | Static single page | Standalone "Property Financials" destination (Assets), in-module sticky strip on `?view=` | Gabriel ruling 2026-10-05; 6 views exceed the 5-tab registry cap |
| 2 | Tab 7 | Static "Command center data" | Live data-health panel in Data → Quality → Property Financials, plus summary card on the module | Spec |
| 3 | Theme | Own `prefers-color-scheme` block | Repo `data-theme` tokens; fixed 8-colour chart palette kept (dark under `command`) | Repo design system wins |
| 4 | Overview lede | Hardcoded sentence | Computed from data (2.6% / 6.6%; top themes by dollars) | No hardcoded firm numbers |
| 5 | NOI KPI label | "nine PM-reported assets" | "6 PM-reported assets with full-year history" ($3.04M at the time; $3.05M since the v03.2 prepaid-rent ruling — 3,040,402 → 3,048,689) | The dataset view has 6 members; adding the other 3 would put partial FY2024 into a YoY |
| 6 | Rounded ratios | Reads dataset 2-dp ratios | Computes margin / opex / fee / growth from raw figures everywhere | Scorecard and Evaluation must agree; independent review finding C2 |
| 7 | Evaluation RAG | From rounded ratios | Exact math flips three cells: 3540 E 5th run-rate amber→red (-0.10%); Livingston mgmt fee green→amber (4.47%); 9620 mgmt fee amber→red (5.01%) | Consequence of 6; pinned in tests |
| 8 | Partial periods | YoY computed on Livingston YTD (3 vs 9 months) | n/m with reason (Evaluation growth tests, Explorer "why", drivers) | Spec rule: partial never produces YoY; review findings C1, I1 |
| 9 | Negative base | Percent on 3540 E 5th negative 2023 NOI | n/m | Spec rule |
| 10 | Diverging bars | Fixed zero at 30%, per-side scale | One shared scale | Equal dollars draw equal bars |
| 11 | Run-rate table | YoY from 2-dp dataset values | Exact from monthly; missing quarters n/m with reason | Same as 6 |
| 12 | Insight order | Dataset order | Severity then abs(annual impact) | Spec |
| 13 | Insight workflow | None | Owner / due date / status (open, in progress, resolved, dismissed + reason) persisted to the module's own gitignored store, never the source files | Spec |
| 14 | Lease lookup / start dates / fee cap | Hardcoded tables | Matched and derived from the lease record | No hardcoded firm facts |
| 15 | Per-SF median | Upper-middle value | True median | Correctness |
| 16 | Status encoding | Colour plus icon | Plus visually-hidden status word; focusable n/m with reason | Accessibility |
| 17 | Fonts | Google Fonts CDN | Fontsource (self-hosted) | No external CDN |
| 18 | SF | Static block | Live Spine A snapshot when present, Spine A and fresh (<= 7 days); else static labelled | Spec freshness canon |

## 3. Decisions (1–3 and 6 resolved by Gabriel 2026-10-05; 7 resolved 2026-10-06; 4 and 5 open)

1. **RESOLVED 2026-10-05:** Binary `.xls` reader. Gabriel ruled to keep the Excel-COM conversion step (`convert-xls.ps1`, needs desktop Excel). LibreOffice and a reader dependency are not adopted.
2. **RESOLVED 2026-10-05, promotion DONE:** 9620 State 350 2025-09. The reference mapped a no-section recap's expense lines as revenue. Gabriel ruled to promote the corrected figures. They were rebuilt with the repo pipeline and promoted as dataset v03.1 (see `data/property-financials/data-dictionary.md`). Only 9620 moved; no portfolio or same-store view changed. FY2025 NOI went from 39,439 to 26,364, and FY2025 revenue now ties to the annual file to the cent. The recap's management fee is filed under Management fees by the new mapping rule `A12-EXP-MGMT-ANY-GROUP`.
3. **RESOLVED 2026-10-05:** Live leased-SF basis. Gabriel ruled to keep Active + Expiring Soon, labelled as such (`leasedSfBasis`).
4. **OPEN:** Refresh task: ratify name, cron, routing; register via supervised `create_scheduled_task` (proposal doc in this folder).
5. **OPEN:** A 12th entity needs data only for the builder, but the strict contract's entity constants must admit it before the module renders it.
6. **RESOLVED 2026-10-05:** `PF_STALE_DAYS = 45`. Gabriel ratified the monthly-close window. It stays separate from the firm's 7-day mirror canon, which governs live mirrors.

7. **RESOLVED 2026-10-06, promotion DONE:** Prepaid rent treatment. Gabriel ruled that the normalized NOI treats prepaid rent the same way for every source layout: excluded. AppFolio `Unallocated Prepays` was already excluded; the Yardi cash-flow `Prepaid Rental Income` line (under RENTAL REVENUE) was counted as contra-revenue. Mapping v3 adds `CF-RENTAL-REVENUE-PREPAID` (v2 otherwise byte-identical). Only 1900 Broadway and 9050 Red Branch carry the line (266 CSV rows removed); 29000 Info Lane records prepaid rent only under ADJUSTMENTS, already excluded, and does not move. Promoted as dataset v03.2 (`data/property-financials/data-dictionary.md` has the full before/after). Headline moves: Broadway FY2025 NOI 365,562 → 366,902; Red Branch FY2025 NOI 905,390 → 912,337; same-store NOI Jan–Sep 2026 vs 2025 +5.3% → +4.9%; PM-only FY2025 NOI (Overview KPI) $3,040,402 → $3,048,689. Same-store base rent (+2.6%) and opex excluding RE tax (+6.6%) are unchanged.
