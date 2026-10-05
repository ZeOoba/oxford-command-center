# Property Financials module — design + plan (2026-10-05)

Lane L3 (large). Branch `feat/property-financials` (from origin/main 0d98bfc). Ruling (Gabriel, in-turn 2026-10-05):
**standalone destination, Assets group, own in-module sticky tab strip; data committed under `data/property-financials/`
(private repo), served by a read-only route, separate from the warehouse.**

## Capability audit (code, not docs) — component → owner

| Need | Existing owner | Decision |
|---|---|---|
| Parse P&L files → warehouse | `server/warehouse/ingest.ts`, `parse/qb-excel.ts`, `scripts/warehouse-backfill.ts` (same OneDrive folder, 32 files) | Do NOT reuse or touch. This module is a parallel, read-only view with its own NOI definition; disclosed in data-health. |
| Per-property intel UI | `src/modules/intel/PropertyIntelView.tsx` (warehouse NOI) | Leave alone; no merge (ruling). |
| SF / property identity | `server/warehouse/property-master.ts` `CANON_PROPERTIES`, `entity-xref.ts` | Read-only join for the mapping table. Dataset SF differs for Westerville (18,360 vs 18,000), 9620 (34,300 vs 34,560), FVC (109,657 vs 110,000) — shown as flags, never overwritten. |
| JSON loader + sub-router template | `server/edge/{loader,edge-api,config}.ts`, mounted via `server/warehouse/sub-routers.ts` | Copy the pattern (stat→memo→read→strict Zod→last-good; fs-import allowlist test). |
| Module registry | `src/shell/modules.tsx`, `module-order.ts`, `tab-types.ts` (max 5 tabs/destination) | New destination `property-financials`; internal strip for 6 views; Data-health lives in Data destination. |
| Tokens / theme | `src/tokens/theme.css` (`data-theme` command/parchment/warm) | Repo design system wins; map Navy/Gold/Parchment intent + fixed chart palette onto tokens. No parallel `prefers-color-scheme` block. |
| Charts | `src/charts/*` (visx + hand SVG) | Hand-built SVG matching the artifact; reuse theme helpers only. |
| Persisted status store | grep `server/` for existing atomic JSON/SQLite stores (overlay.ts, edge pull-queue) | Verified-absent for insight owner/due/status → new table or overlay-style file; decide in T4 after reading `edge/pull-queue.ts`. |
| Governors / models | `server/warehouse/governors.ts` | Untouched. |

Verified-absent (grep `property-financials|propertyFinancials` over src/server/scripts): no module, route or contract exists.

## Load/bottleneck (service component)
Single user, one dataset ≈ 350 KB JSON + 1.1 MB CSV, memoised by (mtime,size). Peak a few req/s from one browser; nothing bottlenecks (first
failure = JSON parse on a 100x larger file, i.e. never at this scale).

## Pre-mortem (3)
1. Dataset silently stale/edited → loader strict-validates + `as_of` + sha shown; reconciliation test fails CI if JSON ≠ CSV.
2. Second NOI definition read as the firm number → persistent "Normalized NOI · cash basis · not reconciled with Spine A/B" label + data-health row.
3. Partial/lease-up periods shown as YoY → rule tests (partial never YoY, ≤0 base never %) + `n/m` with reason tooltip.

## Tasks (TDD: test first, watch fail)
T0 Claims + data files (done: `data/property-financials/*`, `tests/fixtures/property-financials/reference-artifact.html`); status.json entry.
T1 Contract `src/contracts/property-financials.ts` (Zod, strict) + fail-loud loader tests. *Architect-owned dir.*
T2 Pure calc lib `src/analytics/property-financials/` : period rules, YoY/n-m, per-SF, same-store, recovery, run-rate, driver nature, rent-step events, `THRESHOLDS` config + RAG fn, formatters. Tests: golden values, rules, threshold flip.
T3 Reconciliation: CSV parse + aggregate; every `properties[id].periods` figure ties to the cent (annual entities key `YYYY-FY`).
T4 Server `server/property-financials/` (loader, api, status store for insight owner/due/status/dismiss-reason); sub-router mount; not in bake FIXED_ROUTES.
T5 Shell: module registration, tokens, chart primitives (line/crosshair, diverging bars, grouped, stacked, timeline w/ markers, step).
T6 Tabs: Overview, Scorecard, Levers, Watchlist, Evaluation. T7 Explorer (11 properties). T8 Data-health panel (Data destination) + gaps on property pages + FVC confirm flag.
T9 Refresh pipeline: versioned account-mapping config, CSV→dataset builder, source-layout parsers w/ tests, unmapped-account fail report, live SF read from Master Workbook with 7-day staleness label; propose (not register) the monthly scheduled task.
T10 Verification: visual parity 1280/400 vs artifact (11 properties, 0 console errors, 0 h-overflow), gate, adversarial refute, local review, mapping table, intentional-diff list.
