# Design-Parity Execution Plan — 2026-07-06

**Authorization:** Gabriel, in-session 2026-07-06: "Proceed with all recommendations" (all of
IMPLEMENTATION_PLAN.md's D1–D8 as recommended) + explicit sentinel authorization for
architect-owned edits in this cloud session. Declared in `architecture/status.json` →
`design-parity-impl`.
**Branch:** `claude/analyze-plan-prompt-tadmpp` — one PR, per-wave commits (deviation from
one-PR-per-phase is deliberate: single reviewer, expedite requested).
**PR #166 merged 2026-07-06 mid-Wave-2** (squash-merge `2d2c147`, content-identical to this
branch's tip at merge time — verified byte-for-byte via `git diff`): Wave 0 (governance), Wave 1
(primitives/contracts/migrations), and Lane L2c (insights route) landed on `main`. **NO
defective code merged** — L2a/L2b/L2d (insurance-analysis/tax-analysis/brain-report) were still
uncommitted in the working tree at merge time (refute passes had found real defects in two of
them, fixes were in flight). Per the merged-PR protocol, branch was restarted from `main`
(`git checkout -B claude/analyze-plan-prompt-tadmpp origin/main`) with the uncommitted Wave-2
work carried over via stash (clean pop, zero conflicts). **Any fresh session: `main` now has
Wave 0/1/L2c — start Wave-2 remainder from there, do not re-do it.**
**Orchestration:** Fable 5 plans/reviews; Sonnet subagents implement in parallel,
non-colliding by construction (disjoint file sets below). Refute-financial-change (opus) runs
on every financial engine before its commit.

## Data investigation results (2026-07-06)

| Dataset | Finding | v1 treatment |
|---|---|---|
| Insurance policy register | Real; workbook `Insurance Renewals` tab, 13 cols parsed today (`parse.ts:418-449`: id, property, entity, coverage, effective, expires, policyNo, carrier, premium, daysToExpiry, status, cancel-flag, notes) | Bind as-is |
| TIV / deductible / limit | **Not found digitally** — OneDrive holds only ACORD liability COIs (e.g. `7658 Fishel/Insurance COI - Liability Heritage Pool*.pdf`); no SOV, no dec pages | **Framework**: parser reads OPTIONAL cols 14/15/16 (TIV, Deductible, Limit) from the tab — absent cols → null + DQ flag; Gabriel fills the workbook when broker SOV arrives |
| Loss runs | Not found digitally | **Framework**: `insurance_loss_events` table ships empty + importer template `docs/templates/insurance-loss-runs.template.csv`; P4c analysis stays dormant until rows exist |
| Property tax assessments | County-portal PDFs exist for a subset (`Sepich Portfolio/Tax Assessment -- *.pdf`, 2021 vintage; MD data-search PDF 2015; `6300 Sherriff Road/2009-2011 real estate tax appeal results.pdf`) — live values are on county portals (OH/MD/IN/WI/MO/KS/TN) | **Framework + template**: migration + importer + `docs/templates/property-tax-assessments.template.csv` pre-filled with the full property roster from `server/warehouse/property-master.ts` (id, name, market; assessed_value/millage left blank for Gabriel per county portal) |
| Tax actuals (bills paid) | **Already real** in Spine B ledger `Taxes` category | Bind directly |
| Property city/state/county | `Property.city/state` hardcoded null (`parse.ts:175-176`); no county anywhere | Template carries a `jurisdiction` column; engine treats null jurisdiction as indeterminate |

No blocking data questions → proceed per D2/D3 frameworks.

## Waves and lanes (disjoint file sets = non-colliding parallelism)

### Wave 0 — done in-line
- status.json repair (ic-memo interleaved body; chore-post-w2-merge dup key) + `design-parity-impl` declaration → governance check green.

### Wave 1 — foundations (parallel: L1a ∥ L1b ∥ L1c; barrier before Wave 2)
- **L1a Primitives (UX)** — `src/primitives/TierBoard.tsx`, `GaugeRing.tsx`, tests, `src/modules/alerts/AlertsModule.tsx` tier integration. *(launched)*
- **L1b Contracts (Architect-gated)** — `src/contracts/warehouse.ts` (`VerdictKind`/`VerdictEngine` + `insurance-rebid`, `tax-appeal`), `src/contracts/insurance.ts` (+`tiv`/`deductible`/`limit` nullable), NEW `src/contracts/tax.ts`, NEW `src/contracts/insurance-analysis.ts`, NEW `src/contracts/brain-report.ts`, barrel `src/contracts/index.ts`. Contract-only: Zod schemas + types + unit tests, no engine code.
- **L1c Migrations + templates (Architect-gated)** — `server/warehouse/migrations/020_property_tax.sql` (property_tax_assessments + tax_appeals), `021_recommendation_feedback.sql`, `022_insurance_loss_events.sql` (framework, per D3); `scripts/warehouse-verify.ts` assertions; `docs/templates/property-tax-assessments.template.csv` (roster-prefilled) + `docs/templates/insurance-loss-runs.template.csv`; `architecture/database-schema.md` table docs + duplicate-017 note (numeric-sort/readdir-tie mechanism).
- Wave-1 commit gate: tsc + eslint + full vitest + governance green. `Refute-Skip: contracts/migrations/primitives — no financial computation` (schemas and DDL only).

### Wave 2 — engines + routes (parallel: L2a ∥ L2b ∥ L2c ∥ L2d; all NEW server files + delivery-only api.ts appends; barrier before Wave 3)
- **L2a Insurance analysis (Analytics)** — NEW `server/warehouse/insurance-analysis.ts`: ratePer100Tiv, type-cohorted book-median (property/package cohort, n≥5 else insufficient-cohort), re-bid dispersion `excessPremium=(rate−cohortMedian)×tiv` (never "savings"), renewal buckets 0/45/90; calibration verdicts kind `insurance-rebid` (manual-resolve, test asserts written>0); route `GET /api/warehouse/insurance/analysis` (api.ts append). **Refute pass required.**
- **L2b Tax analysis (Analytics)** — NEW `server/warehouse/tax-analysis.ts`: effective rate, assessed-vs-indicated (full-asset basis; `estValue100` comparison), appeal-opportunity flag (threshold + `taxesPerSf` cohort percentile via benchmarks engine), `savingsFullAsset` AND `savingsOxfordShare`; nulls → indeterminate; calibration verdicts kind `tax-appeal`; NEW `scripts/import-assessments.ts` (idempotent, DQ on unknown ids); routes `GET /api/warehouse/tax/analysis`, `POST /api/warehouse/tax/appeals` (api.ts append). **Refute pass required.**
- **L2c Insights wiring (Analytics)** — route `GET /api/warehouse/insights` (api.ts append): CapitalAllocationReport → CF generator → `rankCandidates` → `InsightReportSchema` envelope; ALL non-CF families registered dormant with honest `dataReadiness`; NO new generator math. Delivery-only → Refute-Skip.
- **L2d Brain report + feedback (Analytics)** — NEW `server/warehouse/brain-report.ts`: composes `calibrationReport()`, rolling hit-rate by resolution month (n<5 months → gaps), coverage-based confidence by market/PM, uncertainties (open DQ + dormant generators + floorIndeterminate acq scores), version log (`calibration_log` + `COUNT(DISTINCT config_hash)−1` as recalibrations); routes `GET /api/warehouse/brain/report`, `POST /api/warehouse/brain/feedback` (append-only table from 021). Track record states: hit / miss / not-scoreable only. **Refute pass required (accuracy math).**
- Workbook parser TIV cols (Integration, small): `server/workbook/parse.ts` insurance parser reads optional cols 14/15/16 → contract fields; `server/warehouse/insurance.ts` writes `coverage_tiv` (+ new deductible/limit cols from 022). Folded into L2a's lane (same reviewer) but files are disjoint from other lanes.

### Wave 3 — UI modules (parallel: L3a ∥ L3b ∥ L3c ∥ L3d ∥ L3e; one module dir each; `src/shell/modules.tsx` registry edits SERIALIZED at wave end by orchestrator)
- **L3a InsightsModule** — NEW `src/modules/insights/` (results banner per-spine, category pills, TierBoard Critical/Priority/Monitor; join spec per plan 2b.1: entity→property crosswalk + category↔family table in `insights.logic.ts`; warehouse-candidate-wins dedup; "proposed ranking weights (unratified)" chip).
- **L3b Grader UX** — `src/modules/acquisitions/GraderView.tsx` (+ tab): om-extract drop zone → editable AcquisitionInput → real score → GaugeRing + gates/floors checklists + 4 subScores + reasons + advisoryOnly/cappedAtT2 chips; buy-box reference panel rendering ruleset v1.0 verbatim READ-ONLY; pipeline TierBoard T1/T2/PASS/KILLED from `/acq/intel`; kanban stage view with tier badges. No letter grades (D8).
- **L3c Insurance module rebuild** — `src/modules/insurance/`: 4 KPIs (premium Σ real, rate vs type-cohort median, "premium above book median" Σ, renewals ≤90d), Savings Board (Re-bid / Renewal watch tiers), Policy Register + renewal countdown bars; "insufficient data" states wherever TIV null.
- **L3d TaxesModule** — NEW `src/modules/taxes/`: KPIs (ledger `Taxes` Σ; effective rate where assessed; opportunity Σ Oxford-share; appeals in flight), Strategy Board tier board + honest deferred-scope card (cost-seg/returns: what data would unlock), Assessments & Appeals table + appeal status drawer (POST).
- **L3e command-brain module** — NEW `src/modules/command-brain/`: KPI row, accuracy sparkline, track record, Feedback Loop (accept/dismiss → POST, "dismissed (n)" reveal, no suppression elsewhere), derived memory tiers (Settled/Forming/Hypotheses from per-kind n + CI width), confidence bars, open questions, version log. Empty-state parity with calibration ReportView.
- **L3f Capital orphan fold (small)** — `src/modules/capital/`: implied-cap-rate columns + IC-memo + Notion-sync buttons into CapitalModule; DELETE `CapitalAllocationModule.tsx`; grep-verified.
- Registry: orchestrator adds `insights` (Command), `taxes` (Capital), `command-brain` (Command) entries once, after lanes land.

### Wave 4 — verify + ship
- Full local suite + tsc + eslint + build + governance; screenshots per new surface (playwright, mocked om-extract route); commit per wave with trailers; push; PR with data-gap list (what Gabriel fills: workbook TIV/Ded/Limit cols, assessments CSV, loss-run CSV).

## Failure-proofing
- Sentinel re-touched before each architect-gated wave; every architect edit is in the status.json declaration and lands in ONE reviewable PR.
- Engines are pure functions over stored rows; every $ output carries provenance + advisoryOnly; nothing renders invented values — absent data renders absent (the framework mandate).
- Refute-financial-change (opus, 3 lenses) on L2a/L2b/L2d diffs pre-commit; trailers `Refute-Reviewed: wf_<id>`; L2c + UI lanes carry explicit `Refute-Skip` reasons.
- Rollback: wave commits are independent reverts; migrations are additive-only; UI lanes revert cleanly (registry entries last).
- Collision control: no two lanes share a file; api.ts appends are serialized (L2 lanes hand their route blocks to the orchestrator who applies them in one edit if agents collide, else agents append in sequence).
