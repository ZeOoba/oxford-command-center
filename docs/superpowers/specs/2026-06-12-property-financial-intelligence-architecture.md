# Property Financial Intelligence Platform — Architecture Review & Design

**Date:** 2026-06-12 · **Status:** Phase 1 deliverable (pre-implementation) · **Lane:** L3 /build (Large)
**Scope:** New "Property Financial Intelligence" section of the Oxford Command Center — multi-layer financial warehouse, file ingestion, classification, analytics, benchmarking, scoring, AI briefings.

---

## 1. Current architecture assessment

**Stack (verified in repo):** React 19 + Vite 6 + Tailwind 4 + visx charts + TanStack Query/Virtual on the client; Hono 4 Node server on port 8911 (localhost CORS); Zod contracts as the single typed boundary (`src/contracts/`); strict TS (`noUncheckedIndexedAccess`); vitest + Playwright; `npm run gate` = typecheck + lint + test + reconcile; CI `gate:ci` + bundle budget (entry < 250 kB gzip); Cloudflare Pages static mirror via `scripts/deploy-mirror.ps1`.

**Data flow today:** Master Workbook (Excel, OneDrive) → chokidar watch → `server/workbook/parse.ts` → in-memory `PortfolioSnapshot` → SSE → client. `data/overlay.json` is the sole write surface (deal stages, tasks, renewal stages, notes, NOI budgets). `data/snapshots/portfolio.json` is a fallback cache, **not** history.

**Strengths to build on:** pure-function analytics (`src/analytics/engine.ts`), single-source threshold config (`ALERT_THRESHOLDS` in `src/analytics/conditions.ts`), DI-tested brief pipeline (`server/brief/`), streaming tool-using Claude agent (`server/ai/agent.ts`, 10 tools), module registry (`src/shell/modules.tsx`), reusable primitives (KpiStat/DataTable/Card/Badge) and charts (AreaChart/BarChart/BarList/Sparkline), Outlook COM send with outbox fallback.

**Gaps vs. this platform's requirements (all verified):**
- No historical store of any kind — every refresh overwrites; no time dimension beyond the live snapshot.
- No import versioning, no immutable raw layer, no audit trail.
- QuickBooks ingestion is a single `QUICKBOOKS_CSV` env path, one file, no multi-property/multi-period/multi-source handling.
- No per-property P&L view (Close module is portfolio rollup only); property detail is a drawer, not a page.
- No anomaly detection, trend math, health/attention scoring, benchmarking, PM analytics, or root-cause attribution.
- The daily brief is deterministic template assembly — no AI narrative, no weekly/monthly/quarterly/annual cadence.
- CSV export only; no PDF reports.

## 2. Existing database review

There is **no relational database for portfolio data** — JSON flat files + in-memory snapshot. However, **`better-sqlite3` is already a production dependency** (`data/doc-index.sqlite` for document RAG embeddings). Adding a SQLite warehouse introduces **zero new runtime dependencies** and follows an established local-data pattern (gitignored `data/` dir).

The JSON-overlay pattern is correct for low-volume user mutations but cannot support this platform: ~27 properties × 36+ months × ~40 GL accounts ≈ 40k+ ledger rows growing monthly, with versioned imports, joins, quartile math, and audit queries.

## 3. Existing dashboard review

18 modules registered in `src/shell/modules.tsx:55–74` (lazy-loaded, grouped sidebar). Conventions to reuse: `useSnapshot()`/`useAnalytics()` hooks, KpiStat grids, virtualized DataTable with `onRowClick → ui.openEntity`, EntityDrawer for entity detail, Badge tones for severity, visx charts themed from `src/charts/theme.ts`. The Close module (`src/modules/close/CloseModule.tsx`) owns budget-vs-actual; the new section must **reference, not duplicate** it. Missing chart types needed: waterfall, ranking/quartile visual, score gauge.

## 4. Existing AI integration review

`server/ai/agent.ts`: streaming, tool-using Claude agent (raw fetch, prompt caching, adaptive thinking, max 8 turns, deterministic fallback without API key). Tools are pure functions of the snapshot with entity refs (`[[type:id|label]]`) that deep-link in the UI. Doc RAG (sqlite-vec + Transformers.js) is server-only and fail-closed on confidentiality. The brief pipeline has **no LLM involvement** today. This is the right substrate: add warehouse tools to the agent; add an optional narrative pass to briefings; keep all scoring deterministic.

## 5. Existing data ingestion review (incl. ground truth of the corpus)

- Workbook parser: 620 lines, 6 sheets, defensive coercion, DataQualityFlag pattern — good prior art for the P&L parser.
- QB CSV parser (`server/sources/quickbooks.ts`): header-driven, tolerant, single file — to be subsumed.
- **The watch folder exists:** `OneDrive…/Property Financials/` — 32 P&L files covering **2024, 2025, 2026 YTD** for 12 property tokens, named `P&L <year>[ YTD] -- <property>.(xlsx|xlsm)`, plus two AppFolio **"Cash Flow"** PDFs for 2203-2207 Northwood (text layer verified, parseable; **not true P&Ls** — a $61,171 Owner Transfer and $162,474 Interest Expense sit inside "Total Operating Expense", so their "NOI" line is after-debt-service net income; the ingest adapter must reclassify), plus a `Single tenant NNN Leases/` subfolder (skip non-financial files gracefully). Corpus audited 2026-06-12 (workflow `wf_292578db-604`): 32/32 parsed, 339 distinct GL accounts; verified mapping seed at `2026-06-12-pfi-account-mapping-seed.json` (same dir).
- **Verified file shape** (`P&L 2025 -- 1100 Rarig.xlsx`): QB-style report — title rows (`Profit & Loss`, `Property: 1100 Rarig Ave`, `01/01/25 - 12/31/25 (cash basis)`), section labels in col B (INCOME/EXPENSE/TOTAL), indented GL accounts in col C (`5002 RENTAL INCOME` → `5064 Rent`, `6160 REPAIR` → `6285 HVAC Repair`), subtotal rows (`… Total X`), value columns to the right (monthly + total).
- **Known real-world hazards (from memory + files):** operating bases differ by property (Yardi cash-flow, QB cash/accrual, Rent Manager, Form 8825 tax-basis); 9050 Red Branch has conflicting QB-vs-Yardi history; EG Family LLC books beneficiary **distributions as expenses**; two properties (Raytown, Westerville) have partial/seller-provided history; some tax docs are image-only scans. The design below treats `basis` as first-class and classification as mandatory.

---

## 6. Recommended architecture

**Decision 1 — SQLite warehouse, new server domain.** `data/warehouse/finance.sqlite` (better-sqlite3, WAL), owned by `server/warehouse/` (db.ts, ingest/, mapping.ts, ledger.ts, metrics.ts, intel/). Gitignored. The live Master-Workbook snapshot remains the *current-state* spine; the warehouse adds the *time* dimension. They join on property id (slug), with a `property_master` table as the new source of truth for static property facts (the snapshot's parsed properties seed it).

**Decision 2 — staged ETL with immutable raw layer.** Watch `FINANCIALS_DIR` (env; defaults to the OneDrive `Property Financials` folder) → detect (property/period/source/basis + confidence) → **stage** (pending-review if confidence < 0.85 or validation warnings) → **commit** (transaction: raw copy + ledger rows + metric recompute + SSE). Raw bytes copied to `data/warehouse/raw/<sha256>__<filename>`; the hash is the dedup key. Re-import of the same logical (property, period, doc-type) creates **version N+1** and marks prior ledger rows inactive — never deleted (rollback = re-activate).

**Decision 3 — deterministic intelligence, LLM narrative.** Every score, anomaly, benchmark, contribution analysis, and recommendation is computed by pure functions with one threshold config (`INTEL_THRESHOLDS`, mirroring `ALERT_THRESHOLDS`). The LLM (existing agent infra) only *narrates* — briefings, "explain this property" — citing entity refs. This keeps invariant 7 (never fabricate firm data), makes tests deterministic, and works without an API key.

**Decision 4 — UI as one new module + property pages.** New module `intel` ("Property Financial Intelligence", group Assets) with internal views: Ownership Intelligence Center (default), Property Intelligence (per-property page within the module — selector + deep view, richer than the EntityDrawer), PM Scorecards, Data Quality Center, Briefings, Imports/Audit. Lazy-loaded to respect the bundle budget.

**Decision 5 — PDF exports via Playwright print-to-PDF.** Already a dependency; produces extractable-text PDFs (per ORA standard; Microsoft Print to PDF prohibited). Server route renders branded HTML report → chromium → PDF.

## 7. Database schema (DDL summary)

```sql
-- Layer 0 — property master (source of truth for static facts)
property_master(id PK, name, market, address, property_manager, pm_contact,
  pm_platform, financial_mode /* 'pnl' | 'lease-run' — Sunburst + Fishel run off master lease + estimated capex */,
  rentable_sf, building_sf, land_acres, acquisition_date,
  purchase_price, current_basis, ownership_pct /* 0.5 Red Branch/Broadway, 0.25 1851 Solar */,
  ownership_status, asset_class, notes, created_at, updated_at)

-- Layer 1 — immutable raw imports
import_batches(id PK, file_name, file_hash UNIQUE, raw_path, file_source,
  imported_at, imported_by, property_id FK, period_start, period_end,
  period_grain,            -- 'month'|'year'|'ytd'
  basis,                   -- 'cash'|'accrual'|'tax'|'unknown'
  source_system,           -- 'quickbooks'|'yardi'|'rent-manager'|'appfolio'|'unknown'
  version,                 -- per (property_id, period span, doc type)
  status,                  -- 'pending-review'|'committed'|'superseded'|'rejected'
  superseded_by, confidence, detect_notes)

-- Layer 2 — account normalization (seeded + learned + manual overrides)
account_mappings(id PK, raw_account_key, source_system, normalized_category,
  classification, match_kind /* seed|learned|manual */, property_id NULL, created_at)

-- Layer 3 — property ledger
ledger_entries(id PK, import_id FK, property_id, period /* YYYY or YYYY-MM */,
  raw_account, gl_code, amount, normalized_category, classification,
  mapping_id FK NULL, is_active)

-- Layer 4 — materialized metrics (recomputed on commit)
period_metrics(property_id, period, grain, metric, value, inputs_version, computed_at)

-- Layer 5 — intelligence
intel_findings(id PK, property_id NULL, period, kind /* anomaly|insight|recommendation */,
  severity, payload JSON, inputs_version, computed_at, acknowledged_at NULL)
scores(property_id, as_of, health_score, health_band, attention_band, factors JSON)
briefings(id PK, cadence /* weekly|monthly|quarterly|annual */, period, html,
  generated_at, sent_at NULL)
data_quality_issues(id PK, import_id NULL, property_id NULL, kind, detail,
  severity, status /* open|resolved|dismissed */, created_at, resolved_at)
```

Canonical categories (seeded, extensible): Rental Revenue, CAM Recoveries, Insurance Recoveries, Tax Recoveries, Other Income, Taxes, Insurance, Repairs & Maintenance, Landscaping, Snow Removal, Utilities, Janitorial, Management Fees, Contract Services, Legal, Accounting, Administrative, Marketing, Bad Debt, Miscellaneous, Capital Expenditures, Tenant Improvements, Leasing Commissions, Debt Service (excluded from NOI), Depreciation/Amortization (excluded), Distributions (excluded — catches the EG Family LLC defect).

Classifications: `revenue | recovery | other-income | opex | capex | ti | leasing | debt-service | excluded`. **NOI = revenue + recovery + other-income − opex.** CapEx/TI/LC are never mixed into opex. Zod schemas mirror every table in `src/contracts/warehouse.ts`.

> **Canonical NOI-membership extension point.** `NOI_CLASSES` and its derived `NOI_INCOME_CLASSES` (= `NOI_CLASSES` minus `opex`) in `src/contracts/warehouse.ts` are the **single source of truth** for which classifications participate in NOI. To add or remove an income class, edit `NOI_CLASSES` **only** — every NOI codepath derives from it: `queries.noiMatrix`, `metrics.propertyPeriodMetrics` (via `isNoiIncomeClass`/`isOpex`), `mapping.classificationSide`, and the `warehouse-backfill`/`warehouse-verify` CLIs. Never re-list the income classes as SQL or TS string literals — they silently drift. Two guards enforce this: the contract-derivation unit test (`warehouse-contracts.test.ts`) and the cross-codepath NOI agreement test (`warehouse-metrics.test.ts`). The deliberate exception is the independent oracle in `warehouse-ingest.test.ts`, which hardcodes the literal on purpose to cross-check the derivation.

## 8. Data warehouse design (the five layers)

| Layer | Store | Mutability | Refresh |
|---|---|---|---|
| 1 Raw | `data/warehouse/raw/` files + `import_batches` | Immutable, append-only | On file arrival |
| 2 Standardized | `account_mappings` | Seeded; manual overrides append | On mapping edit → re-derive affected ledger rows |
| 3 Ledger | `ledger_entries` | Append; versions via `is_active` | On commit |
| 4 Analytics | `period_metrics` | Recomputed (idempotent; keyed by `inputs_version` = hash of active import set) | On commit / mapping change |
| 5 Intelligence | `intel_findings`, `scores`, `briefings` | Append with provenance | On metric recompute + scheduled |

Versioning semantics: import history view, side-by-side version comparison (ledger diff between import N and N−1), rollback by re-activating a prior version (audited in `import_batches.status`). Nothing is ever deleted.

## 9. ETL architecture

```
FINANCIALS_DIR (chokidar, debounced)
  → sniff: extension router (.xlsx/.xlsm → ExcelJS, .csv → csv parser, .pdf → text extraction; image-only PDFs → data-quality queue)
  → detect: filename grammar ("P&L 2025 -- 1100 Rarig") + content headers ("Property: …", "01/01/25 - 12/31/25 (cash basis)")
            → {property (fuzzy-matched to property_master + alias table), period span, grain, basis, source system, confidence}
  → parse adapters: qb-report (indented GL hierarchy, subtotal-row exclusion, monthly columns), yardi, rent-manager (incl. PDF), appfolio, generic-csv
  → validate: duplicate hash; overlapping committed period; line items sum to report totals (¢ tolerance); negative revenue; SF present for $/SF; unmapped accounts
  → stage: confidence ≥ 0.85 and no errors → auto-commit; else pending-review in the Imports UI (approve/correct/reject)
  → commit (single transaction): copy raw → insert batch → insert ledger (mapping engine: exact key → seeded synonyms → token-fuzzy ≥ threshold → unmapped queue) → recompute Layer 4 for affected property/periods → run intel engines → SSE event
```

No hardcoded years anywhere: periods come from detection; analytics iterate over whatever periods exist. **Partial-period discipline:** YTD compares YTD-to-same-months prior year when both exist; annualization is allowed only with an explicit `annualized: true` flag on the metric — never a silent 5-month vs 12-month comparison. Cross-basis comparisons (cash vs accrual vs tax) are flagged in Data Quality and visually marked.

## 10. AI architecture

- **Root-cause engine (deterministic):** ΔNOI decomposition per period pair — Δ by normalized category, each driver's contribution % of total change, ranked; output structured `Driver` objects consumed by both UI ("Insurance +22%, 41% of total expense growth, largest single driver") and LLM narrative.
- **Anomaly engine (deterministic):** spec thresholds in `INTEL_THRESHOLDS` (expense growth >15%, revenue decline >5%, NOI/NOI-PSF decline >5%, new category appearance, tax/insurance/repair/utility spikes), severity Low/Moderate/High/Critical.
- **Scores (deterministic):** Health 0–100 (weighted: revenue & NOI growth, PSF growth, expense/tax/insurance/repair efficiency vs portfolio, margin stability, benchmark quartile; bands Excellent ≥80 / Good 65–79 / Watch 50–64 / Concern <50) and Attention (Green/Yellow/Orange/Red rule cascade over trends, anomaly counts, PM performance). Capital allocation: Invest / Hold / Monitor / Disposition-Candidate rules with reason strings.
- **Benchmarking (deterministic):** portfolio avg/median/quartiles per metric per period; property rankings; PM scorecards grouped by `property_manager` with explicit small-n caveat (few PMs × few properties — rankings shown with property counts, never bare).
- **LLM (existing agent):** new warehouse tools — `get_property_financials`, `get_period_comparison`, `get_drivers`, `get_benchmarks`, `get_scores`, `get_pm_scorecards`, `get_anomalies`. Briefings (weekly/monthly/quarterly/annual) assembled deterministically, optionally narrated by Claude, persisted to `briefings`, routed **ggoldberg@oxfordra.net only** via the existing Outlook COM path. Scheduling registered later via supervised `create_scheduled_task` (never JSON-splice) — not auto-registered by code.
- Every persisted finding carries `inputs_version` so any insight is reproducible from the exact ledger state that produced it.

Acquisition-to-date metrics anchor at the first full period on/after `acquisition_date` (from property master; workbook seeds it) and report growth + CAGR since then.

**Market benchmarking (future-proofed, not implemented):** `benchmark_sources` adapter interface mirroring the FRED macro pattern; external market rent/vacancy/tax/insurance series land in `period_metrics` under a `market:` namespace when a source exists.

## 11. Testing strategy

- **Unit (vitest):** filename/content detection grammar; each parse adapter against small synthetic fixture workbooks (built with ExcelJS in-test, mimicking the verified QB report shape incl. subtotal rows and indentation); mapping engine precedence (manual > learned > seed > fuzzy); classification (NOI excludes capex/TI/LC/debt-service/distributions); version semantics (V2 supersedes V1, rollback re-activates); duplicate-hash rejection; YTD comparability rules; driver decomposition sums to ΔNOI exactly; threshold boundary cases for anomalies/scores/attention; quartile math.
- **Integration:** end-to-end fixture folder → watch → stage → commit → metrics → findings, asserting warehouse row counts and a golden metrics snapshot; mapping-override re-derivation; import-version comparison.
- **AI insight tests:** deterministic layers golden-tested; LLM outputs schema-validated (Zod) with the no-API-key fallback path tested.
- **E2E (Playwright):** module navigation, property page render, data-quality workflow, import review approve path, PDF export produces a file with extractable text.
- All under `npm run gate`; reconcile extended with a warehouse invariant: Σ active ledger by category = stored report totals per committed import.

## 12. Rollout plan (each phase: worktree branch → TDD → gate green → PR)

- **Phase A — Foundation:** warehouse schema + db module, property master (seeded from snapshot + PM/platform seed table), immutable raw store, import versioning, filename/content detection, QB-Excel parse adapter, mapping engine + seed taxonomy, commit pipeline, Imports/audit UI, backfill the 31 existing files. *Exit: 2024/2025/2026-YTD ledgers queryable, audit trail visible.*
- **Phase B — Analytics & property pages:** Layer 4 metrics, growth/CAGR/since-acquisition, YTD discipline, driver decomposition, the `intel` module with Property Intelligence pages (KPIs, $/SF, trends, expense breakdown/waterfall, monthly views), Data Quality Center.
- **Phase C — Intelligence:** anomaly engine, health + attention scores, portfolio benchmarking + rankings, PM scorecards, capital-allocation recommendations, Ownership Intelligence Center.
- **Phase D — Briefings & exports:** weekly/monthly/quarterly/annual briefings (deterministic + optional AI narrative), Playwright PDF report suite (property, portfolio, benchmarking, exec summary, capital allocation, PM), scheduled-task registration (supervised), remaining parse adapters (Yardi/AppFolio/Rent Manager/PDF) as real exports arrive.

**Deferred deliberately:** market-data integrations (architected only), static-mirror exposure of warehouse intelligence, OCR for image-only PDFs (queued via Data Quality instead).

## RATIFIED — Gabriel's rulings, 2026-06-12 (supersedes the open items below; canonical copy in `memory/pfi-build-canon.md`)

**Roster = 14 units** (Persimmon Tree residence excluded): the 12 P&L tokens in the staging folder + **401 Sunburst and 7658 Fishel as LEASE-RUN units** (master lease + estimated capex, no P&L) + **1851 S Club Solar kept in as a 25% roof-project unit** (no real estate owned). FVC is the official **entity-level** unit (Sepich subsets never additive). PM assignments: Columbus P&L properties (3540 E 5th, 3034 Westerville, 3883 Livingston, FVC, 1100 Rarig) = Paul Trautman/Kohr Royer Griffith · 29000 Info Lane = Civita Peters/Thomas Park · 9620 State 350 = Peak Real Estate Partners (Hank Simpson + Garrett Alejos) · 9050 Red Branch + 1900 N Broadway = Steve She/CRC · 2203-2207 Northwood = Brady Smith/SVN · Sunburst/Fishel/55 New Plant/1851 Solar = none (NNN/owner-run).

**Accounting:** owner transfers NEVER in NOI; general CRE standards throughout · **R&M $5k rule** (single item >$5,000 = capex, else opex; assume opex + flag without detail) · AM fees below NOI · basis tagged, within-basis comparisons only · ownership overlay (100% figures + Oxford share: 50%/50%/25%) · coverage starts 2025 for the three late-2024 acquisitions · **PM-software exports authoritative over internal QuickBooks** · FVC 2025 carries a $500,000 one-time cell-tower easement sale (was Zettler Rd) — excluded from run-rate · Zettler sale dead (still owned) · Northwood 2025 interest = seller-financed 6.99% loan, retired via the 29000 Info Lane refi (debt-service, historical only). All 12 account-level rulings resolved and applied to the mapping seed (`needs_gabriel_ruling` now empty; `_rulings` block records the canon).

**Historical record — open items as they stood before ratification (resolved above):**

*Files only he can export:* 401 Sunburst 2026 YTD post-acq P&L (its Financial Statements folder is empty); 7658 Fishel 2026 YTD post-acq P&L (or ruling: lease-based pro forma until year-end); a true AppFolio income-statement export for Northwood 2025 + 2026 YTD (staged files are Cash Flow reports) or ruling to ingest cash-flow with reclassification; Sepich property-level exports (Zettler has no standalone P&L any year) IF property-level granularity is required below the FVC entity; optional late-2024 stub P&Ls (Westerville Sep–Dec, Raytown Oct–Dec, Northwood Oct–Dec) only if FY2024 history is required for those three.

*Rulings:* scope = the 14-line roster (Persimmon residence in/out; sold Angola/Secor stubs only for FY2024 tie-out?); 1851 South Club Solar = retained solar entity on a sold building — in or out; Sepich granularity (FVC entity vs property-level); accounting-basis normalization (recommend: ingest as-is, tag basis, compare within-basis, flag cross-basis); Asset Management Fees below NOI (recommended, lender convention); 50%-owned assets presented at 100% with Oxford-share overlay (recommended); the 12 account-level rulings in `needs_gabriel_ruling` (NOI-material: escrow-only books, Replacement Units & Parts opex/capex split, Turnover/Rehab 6830, Prepaid Rental Income on cash-basis books, Electricity Income -- PS).

*Facts:* PM firm assignments per property (in no source anywhere — required for PM benchmarking); 9050 Red Branch authoritative source per year (QB vs Yardi conflict); whether 55 New Plant 2024–26 books still carry distributions-as-expenses (the engine excludes them regardless — Rarig 2024 shows a $25,000 'Distribution to Owner' booked as a 7402 expense, confirming the pattern); location of the American Tower easement proceeds in FVC 2025 (one-time, excluded from run-rate); Zettler sale status (Sepich roster carve-out); purchase price / current basis per property if wanted beyond workbook values; auto-commit threshold (0.85) confirmation.
