# PCA / Capex Ledger Integration Plan

**Status:** APPROVED 2026-10-07 (Gabriel, in-turn) — decisions in §6 resolved. Phases 1–2 BUILT on branch `feat/pca-capex-ledger`; Phases 3–5 not started.
**Date:** 2026-10-07
**Sources (read-only, OneDrive\Business\Physical Property Information PCAs Capex, etc):**
`2026-10-06_PCA-Context_Summary_v01_2.md`, `2026-10-06_PCA-Extraction_Register_v01_2.xlsx`
(sheets: PCA_Register 17 rows · Components 50 · Quotes_Actuals 13 · Est_vs_Actual 5 · Consultant_Fees 12 · Asset_Facts 20 · Flags_Open_Items 16 · File_Index 57)

## 1. Verdict

Yes — high value, and it fills a gap the code already admits. `server/warehouse/capital-allocation.ts:346-372` says "a real capex-cost data source does not exist yet" and drives the `improve` verdict off `ASSUMED_CAPEX_PSF = 10` (a proxy). The register is the first real capex dataset: consultant reserves, contractor quotes, install dates/warranties, and four estimate-vs-actual pairs.

Nothing in `src/modules/` models building condition, reserves, asset age, or capex quotes today (capital, intel/CapexIrrCalc, insurance, taxes exist; no condition/asset surface).

## 2. What is in the data, and what it is worth

| Data | Rows | Value to command center | Trust |
|---|---|---|---|
| PCA_Register — immediate / short-term / reserves per report | 17 (8 current 2024–26) | Per-property capex reserve forecast; replaces flat $10/SF proxy | Current rows usable; 9 stale rows = install-date history only |
| Asset_Facts — install year, warranty, EUL | 20 | Replacement-year schedule (install + EUL); warranty-expiry alerts (e.g. Muirkirk roof warranty to 2028) | Some `[OCR-UNVERIFIED]` |
| Est_vs_Actual — PCA estimate vs executed price | 5 | Calibration of PCA reserves (55 New Plant −60%, 3540 E Fifth −69%, Livingston +2%, E Fulton 3.1× budget vs CBRE) | n=4–5, THIN — display, don't auto-apply |
| Quotes_Actuals — contractor proposals/awards | 13 | Contractor price benchmarks ($/SF roofing) | n=1 per scope; Verified = No |
| Components — consultant unit costs 2007–2026 | 50 | Reference price book | **Estimates — must stay a separate Price Basis from contractor quotes** |
| Consultant_Fees — PCA/ESA fee benchmarks | 12 | Acquisition DD budget inputs | Low stakes |
| Flags_Open_Items | 16 | Data-quality worklist (7 items are decisions for Gabriel, not data) | — |
| File_Index | 57 | Document provenance | — |

Source-data issues that must be resolved or carried as flags before ingest (from the summary): E Fulton CBRE reserve likely understated (no roof access, collapse uncosted) — treat its reserve total as a floor; Banwick/Morrison summary docx has errors vs Intertek (fix before it goes to Firm 03); Raytown reserve understated vs its own columns (the `*` row); Northwood PCI "good" vs a later roof inspection "Poor, 2–4 yrs"; Fairground Village DECA is 2013.

## 3. Where it lands (digestible sections)

Principle: **one new surface for the building, three existing surfaces consume it.** Don't scatter PCA data across modules.

### A. New destination: "Property Condition" (home of the data)
Owned by the Capital area. Cleanest fit is a tab group under `src/modules/capital/` (see `tabs.ts`) rather than a new top-level module; alternative is a standalone read-only destination like the Property Financials pattern that just landed (#442).

Four tabs, each answering one question:
1. **Capex Outlook** — "What do I owe the buildings, and when?" Portfolio table: property · SF · latest report · immediate $ · yr 1–2 $ · 12-yr reserve · $/SF/yr · report age · usability badge (CURRENT / STALE). The latest report per property is the current one (no age cutoff); age and usability shown as badges, superseded reports kept as history.
2. **Replacement Schedule** — "What is aging out?" Asset_Facts → system · install yr · EUL · RUL · replacement yr · warranty end. Sorted by replacement year; warranty-expiring-within-24-months chip.
3. **Estimate vs Actual** — "Can I trust PCA numbers?" The four calibration pairs with delta bars; labelled THIN (n≤5). Carries the E Fulton 3.1× and Banwick PCA-vs-quote $/SF warnings.
4. **Quotes & Benchmarks** — "What do contractors actually charge?" Quotes_Actuals by trade; Components price book on a clearly separate "Consultant estimate" basis; fee benchmarks as a small card.

### B. Existing surfaces that consume it
| Surface | Change | Why |
|---|---|---|
| `server/warehouse/capital-allocation.ts` `improve` gate | Replace `ASSUMED_CAPEX_PSF = 10` with per-property PCA-derived capex $/SF **when a CURRENT report exists**; fall back to proxy otherwise; expose `capexBasis: 'pca' \| 'proxy'` | Biggest functional payoff. **Financial-decision code → mandatory `refute-financial-change` workflow, and hurdle-rate/governor constants untouched.** |
| `src/modules/intel/CapexIrrCalc.tsx` / `capex-irr.ts` | Pre-fill capex input from the property's PCA figure | Removes a manual input |
| Acquisitions / IC memo (`server/warehouse/ic-memo.ts`, `src/brain/replacement-cost.ts`) | Post-close: PCA reserve as underwriting-vs-reality check; E Fulton is the live case | Acquisition-intel loop |
| Alerts (`src/analytics/conditions.ts`) | New conditions: roof warranty expiring ≤24 mo; report age >5 yrs on property with immediate $ >0; PCA vs newer inspection contradiction (Northwood) | Pre-flight rule: overlay fields skip Zod — coerce defensively (see memory `overlay-not-reparsed-zod`) |
| Data Quality (`src/modules/intel/DataQualityView.tsx`) | Surface Flags_Open_Items as a worklist | Decisions stay Gabriel's |

### C. Explicitly NOT in the command center
- The 7 "decision needed" flags (E Fulton partner PCA package, Banwick docx correction, address checks 2800/2518, 6300/6410 Sheriff, 2920/2892 E 14th) → Notion/Open Items, not code.
- File_Index → keep as provenance only; reference by path, no document storage.
- Lease-recovery / funding-class classification → leave `Unknown/Unreviewed`; it is a human tag, not an import-time inference.

## 4. Data architecture (decision needed — see §6)

Follow the repo's established pattern (insurance P4c, `docs/placeholder-data.md`): importer script → warehouse tables, idempotent `INSERT OR IGNORE`, source-file hash for provenance, `dataSource` discriminator on contracts.

Proposed migration `035_property_condition.sql` (architect-owned; next number after `034_edge_pull_log.sql`; re-check origin/main — local is 7 commits behind):
- `pca_reports` (report_id, property_id, consultant, report_date, sf, immediate, short_term, reserve_uninfl, reserve_infl, term, status CURRENT|STALE|DRAFT, source_sha256)
- `pca_components` (report_id, system, qty, uom, unit_cost, eul, age, rul, total, basis='estimate')
- `capex_quotes` (property_id, vendor, trade, doc_date, quoted, actual, qty, uom, status, verified, confidence)
- `asset_facts` (property_id, component, install_year, eul, warranty_end, source, flag)
- Calibration pairs computed in the engine from `pca_components` + `capex_quotes`, not stored.
- Property id mapping: register uses names ("Banwick", "55 New Plant Ct"); must map to `property-master.ts` ids via `property-crosswalk.ts`. **Gap found:** property-master has no entries for 2800-2826 Banwick, 384-420 Old Morrison, 3520 E Fulton (these are under `sepich-portfolio-columbus-oh-8-props` or acquisition pipeline) — resolve before import (see risks).

Import: new `scripts/import-pca-register.ts` reading the xlsx directly (xlsx is the interim contract; Notion `Quotes_Actuals`/`Consultant_Fees`/`Asset_Facts` mapping noted in the register is the long-term source of record — confirm).

## 5. Phased plan

| Phase | Scope | Gate |
|---|---|---|
| 0 — Decisions | Answer §6 questions; refresh checkout to origin/main; claim `architecture/status.json` entry | Gabriel approval |
| 1 — Ingest — **BUILT 2026-10-07** | Migration 035 (`pca_reports`, `pca_components`, `capex_quotes`, `asset_facts`, `pca_open_items`), `src/contracts/property-condition.ts`, `scripts/import-pca-register.ts` (`npm run warehouse:import-pca`), 16 tests. Real register loads 17/50/13/20/16 rows with 0 rejects into a seeded scratch DB; 4 reports stay unmapped to `property_master` (E Fulton, St. Michaels, Muirkirk, Sheriff). Latest-per-property selection happens in the Phase 2 read layer, not at import. | typecheck/lint/governance/schema-drift/migration tests green; full `npm run gate` and architect review still to run at PR |
| 2 — Read-only surface — **BUILT 2026-10-07** | `GET /api/warehouse/property-condition/report` (`server/warehouse/property-condition.ts`: latest-report-per-property read model, warranty status, lifecycle due year, calibration deltas, evidence-classed quotes, separate estimate price book); `src/modules/property-condition/` with views Capex outlook · Replacement schedule · Estimate vs actual · Quotes & prices · Open items. `Est_vs_Actual` added to the Phase 1 importer (migration 035 amended pre-merge: `capex_calibration_pairs`, `pca_components.rul_raw`). Verified in the browser against the real register (immediate / short-term / reserve KPIs populated; calibration −60 / −69 / +2 / +213%). Not yet in the static bake mirror → deployed mirror reads as offline. Open items live in their own view; the DataQuality-tab fold-in is deferred. | typecheck/lint/governance/schema-drift + 41 new tests + IA registry tests green |
| 3 — Alerts | New conditions (warranty, stale-with-immediate, contradiction) | Gate; defensive coercion tests |
| 4 — Engine wiring | capital-allocation + CapexIrrCalc consume PCA capex; `capexBasis` flag | **refute-financial-change workflow**; ratify rule that PCA-derived replaces proxy only for CURRENT reports |
| 5 — Backfill | The unread batch: roof proposals/warranties/invoices for 1100 Rarig, 1851 South Club, 5242 Angola, 5600 Sunnyside, 55 New Plant (HVAC, paving, mezzanine, Tenant 155 LLC); Livingston final PCA; 29000 Info Ln final | Data work in Cowork, not code |

Phases 1–3 are low-risk and independently shippable (read-only, additive). Phase 4 is the only one touching financial-decision code.

## 6. Decisions (resolved 2026-10-07)

1. **Placement** — Gabriel chose "tabs under Capital". Capital is already at the 5-tab house cap (`MAX_TABS_PER_DESTINATION`), so it ships as a **standalone `Property Condition` destination in the rail's Capital group** (right after Capital), with a 5-view `?view=` strip — the same pattern Property Financials used. Easy to relocate: the module is self-contained and registered in three shell files.
2. **Source of record** — import the xlsx directly now; Notion as a later sync target.
3. **Engine wiring (Phase 4)** — approved: PCA-derived capex replaces the $10/SF proxy where a report exists (via `refute-financial-change`; E Fulton treated as a floor and flagged).
4. **"Current"** — Gabriel's ruling: *current = the most recent details we have* for that property. There is NO age cutoff. The latest report per `property_key` (by `report_date`) is the current one; its age is shown as a badge and its `usability_class` (current/draft/limited/stale) is shown as a caveat, but an old report is still used when it is the newest we have (e.g. Muirkirk 2014, Sheriff 2007). This supersedes the earlier ≤5-yr rule and the "stale reports greyed, never summed" language in §3A. Older reports for the same property remain as history.

## 7. Risks / pre-flight

- **Wrong target:** property-master lacks several register properties (Banwick, Old Morrison, E Fulton) — check whether they are in the Master Workbook / acquisition pipeline before inventing ids. E Fulton is a declassified deal (roster: `confidential-terms.json` shows none active; repo stays private) — no external surface issue, but keep it out of any public export.
- **Stale input:** register is v01_2 while the summary cites v01; workbook values are as of 2026-10-06 and contain known source errors (flagged above) — import carries flags, does not "fix" them.
- **Basis mixing:** consultant estimates vs contractor quotes must never share a benchmark aggregate (n=1 → show as single data points, no medians).
- **Shared tree:** local checkout is 7 behind origin/main with uncommitted edits to `.claude/workflows/refute-financial-change.js` — not mine; branch from fresh origin/main in a worktree.
- **Spine discipline:** these are neither Spine A NOI nor Spine B ledger values; label as capex reserve basis, never aggregate with NOI.
