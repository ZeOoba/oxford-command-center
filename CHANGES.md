# Changes

## 2026-10-13 — PCA intelligence on the Property Condition destination (`feat/pca-intelligence`)

- Extended the existing `property-condition` module (no new data layer): PCA Register columns incl. CURRENT / DRAFT / STALE status and derived-vs-stated
  $/SF/yr (n/a when no uninflated reserve), near-term rollup with concentration, reserve intensity with data-quality flags, runtime warranty / useful-life
  clock, 8-item decision queue, report-currency alerts, and a 29000 Information Ln drill-down.
- **Calibration is now an append-only observation ledger** (`data/calibration/observations.json`): ratio / variance derived from $/unit, per-component
  n / median / range, confidence tiers (THIN · LIMITED · USABLE), mean only at n ≥ 5, no portfolio-wide factor, no ratio applied to any reserve.
  `npm run calibration:propose` (read-only workbook / Notion loader → `calibration_pending.json`) and `npm run calibration:promote -- <obs_id>` (explicit,
  append-only). Stale (pre-2024) PCA estimates are kept as history but excluded from statistics.
- **Building Specs & Historical Findings** (`data/building-specs/`): all 17 PCRs (R01–R17) plus the 1900 N Broadway PES photo log extracted into 2,174
  vintage-stamped facts and 406 findings (3 scans OCR'd). Current-overrides-stale, `[FORECAST]` roof projections, findings ledger (no totals, stale dollars
  labeled by report year), cross-vintage diff, roof / HVAC / sprinkler rollups by vintage, filters, and an extraction coverage panel.
- **Cost segregation property data (module 10)** (`data/cost-seg/cost-seg.json`): six studies (Rarig, Broadway, Red Branch, Northwood, Livingston, Fishel), 222
  facts on their own price basis (`COST_SEG_MODELED_RSMEANS_M&S` — rejected by the PCA and calibration schemas). Study register with class splits / PIS / fee
  (allocation ties recomputed, read-only basis panel), per-property spec sheet with DERIVED / OCR / UNVERIFIED / property-notes flags, PCA-vs-cost-seg quantity
  cross-check, and the D1–D14 discrepancy queue (also open issue #9). Cost seg quantities can only be offered as a candidate `qty` on a *pending* calibration
  proposal (`qty_source: COST_SEG_MODELED`); never a condition finding, reserve, rollup, intensity or calibration input.
- Corrected 29000 Information Ln to Immediate $1,100 / Short-term $0 (verified against Intertek PCR T1643.01); Year 1 / Year 2 reserve outlays ($REDACTED-AMT /
  $REDACTED-AMT) appear only in the reserve schedule. Raytown reserve corrected to $292,500.
- KPI dollar totals, near-term rollup, reserve-intensity and the lifecycle forecast card now exclude pre-2024 STALE reports (see `docs/capital/PCA_RECONCILIATION.md`).
- Display only — no scoring, governor, DSCR/LTV or capital-allocation changes. Architect-owned edits: `package.json` (two scripts) and the `architecture/status.json` claim.
