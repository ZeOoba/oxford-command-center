# P4c + C2 Placeholder Buildout — Design

**Date:** 2026-07-09 · **Author:** Claude Code (Fable 5), Gabriel-authorized in-turn ("For the command center create these with placeholders for when I get real data")
**Branch:** `feat/cc-p4c-c2-placeholders` · **Worktree:** `.claude/worktrees/p4c-placeholders`

## 0. Premise correction (ground truth, verified 2026-07-09)

The triggering quote ("the only other roadmap items are Phase 7 (parity sweep) and P4c") repeats a stale
CLAUDE.md §3 Pending line. **Phase 7 (7.1–7.6) MERGED 2026-07-06 via PR #169** (status.json
`design-parity-impl`). What is genuinely deferred, and what this build ships, is exactly the two
data-gated cut-list items:

1. **P4c (insurance):** the SavingsBoard "Optimize Coverage" tier + the design's "Self-Insure & Bids"
   tab — EAL, deductible-vs-loss-ratio review, self-insure retained/transferred split, re-bid pipeline
   (v1 derive-only). Gated on broker **loss runs + dec pages**. Schema already exists and is empty by
   design (migration 022: `insurance_loss_events`, nullable `deductible`/`coverage_limit`).
2. **C2 (tax refinements):** StrategyBoard's third category (Depreciation & Cost-Seg / Structure &
   Pipeline, incl. §469-style entity strategies) + the design's "Filed Returns" tab. Gated on
   **accountant depreciable-basis / land-allocation data**.

Gabriel's in-turn order overrides the deferral: build both NOW on clearly-marked placeholder data,
swappable for real data. This spec also updates the stale CLAUDE.md §3 Pending line (doc-drift fix,
declared `review_needed`).

## 1. Core architecture — fixture-fallback with automatic cutover

Placeholder data never enters the warehouse. It lives in versioned fixture files:

```
server/warehouse/placeholders/
  loss-runs.placeholder.json      # ~3 yrs synthetic loss events, real property_ids, source:"PLACEHOLDER"
  dec-pages.placeholder.json      # blanket deductible/limit rule + per-policy-type overrides, marked
  depreciable-basis.placeholder.json  # per-property synthetic basis + land-allocation + in-service year
  filed-returns.placeholder.json  # metadata-only rows (year, entity, preparer, status)
```

A loader module (`server/warehouse/placeholder-data.ts`) resolves each input **warehouse-first**:

- Loss events: `SELECT count(*) FROM insurance_loss_events` > 0 → warehouse rows,
  `lossDataSource:'warehouse'`; else fixture rows, `lossDataSource:'placeholder'`.
- Dec-page values: per policy, real `deductible`/`coverage_limit` columns win when non-null;
  fixture blanket rule fills gaps; per-policy `decSource:'warehouse'|'placeholder'`.
- Depreciable basis + filed-return metadata: fixture-only in v1 (`'placeholder'`); a real-data
  ingest gets its own migration + importer when the accountant data exists (documented, not built).

**Cutover is automatic for insurance:** once `warehouse:import-loss-runs` inserts real rows /
real dec-page values are imported, every figure flips to `'warehouse'` with zero code change.

Rejected alternatives: (a) seeding placeholder rows into the real tables — contaminates a table other
engines may read and violates the provenance doctrine; (b) UI-only mock tabs — no engine, no tests, no
swap path.

## 2. Honesty rails (non-negotiable, carried from the cut list)

- Engine math is pure arithmetic on inputs; the banned prototype constants (1.6× EAL risk load,
  62% transfer share) stay banned. EAL v1 = annualized gross incurred over observed years, with a
  `observationYears` disclosure and `indeterminate` when history < `MIN_LOSS_YEARS` (3).
- Every derived figure carries `prov: Provenance` (`confidence:'estimated'`, `source` naming the
  fixture file when placeholder) and report-level `advisoryOnly: z.literal(true)`.
- Every new report carries explicit `dataSource` discriminators (`lossDataSource`,
  `decPageDataSource`, `basisDataSource` as applicable: `'warehouse'|'placeholder'|'absent'`).
- New UI surfaces render a `PlaceholderBanner` (amber, HurdleRateBanner pattern) whenever any
  discriminator is `'placeholder'`: "PLACEHOLDER DATA — synthetic … pending broker loss runs /
  dec pages [accountant basis data]. No figure on this surface is decision-grade."
- **No calibration writes while any input is placeholder** — placeholder-derived verdicts would
  pollute `calibration_verdict` history. Hard-gated in the engines' API layers.
- Filed Returns is **metadata-only, permanently**: year, entity, preparer, status, storage-pointer
  label. Return *contents* never enter this system (C2 confidentiality boundary stands even after
  real data arrives; the tab documents this in-body). Real-data future = metadata + SharePoint
  link-out only.
- The bonus-depreciation phase-down schedule used by the cost-seg estimator is itself flagged
  `PLACEHOLDER — confirm with accountant` in config (statutory rates shift; never present as ratified).

## 3. Components

### 3.1 Insurance loss analytics (P4c)

- **Contract** `src/contracts/insurance-loss.ts` (ARCHITECT-OWNED — declared in claim):
  `LossEvent`, `PropertyEal { propertyId, property, eventsN, grossIncurredTotal, observationYears,
  ealAnnual|null, indeterminate, prov }`, `DeductibleReview { policyId, property, deductible|null,
  decSource, lossesBelowDeductible, lossesAboveDeductible, retainedUsd, transferredUsd,
  lossRatio|null, prov }`, `SelfInsureSplit { retainedUsd, transferredUsd, premiumAnnualTotal,
  portfolioEal|null }`, `RebidPipelineItem { policyId, stage: 'watch'|'quote'|'rebid', reason }`
  (derive-only from existing excess bands + renewal buckets), envelope `InsuranceLossReport
  { asOf, lossDataSource, decPageDataSource, eal[], deductibleReviews[], selfInsure, rebidPipeline[],
  basisNote, advisoryOnly: literal(true) }`.
- **Engine** `server/warehouse/insurance-loss-analysis.ts`: pure
  `buildInsuranceLossReport(inputs): InsuranceLossReport` where inputs = policies (economics reused
  from the existing P4a engine's query shape), loss events + sources from the loader. Zod-parses its
  own output. Retained/transferred per event: `min(gross, deductible)` retained, remainder
  transferred, capped at `coverage_limit` with an over-limit disclosure count.
- **API** `server/warehouse/insurance-loss-api.ts` (`insuranceLossApi(getDb): Hono`, `withDb` 503
  guard) + one mount line in `server/index.ts` (ARCHITECT-OWNED — declared):
  `app.route('/api/warehouse/insurance/loss', insuranceLossApi(getWarehouse))`.
- **UI** (`src/modules/insurance/`): third tab `'selfinsure'` → "Self-Insure & Bids"
  (`SelfInsureView.tsx`): PlaceholderBanner → retained/transferred split bar (CSS, tokens only) →
  per-property EAL `DataTable` → deductible-review `DataTable` → re-bid pipeline `TierBoard`.
  `SavingsBoard.tsx`: third tier `'optimize'` "Optimize Coverage" (tone `accent`), items from
  deductible reviews (chips include `PLACEHOLDER` when applicable); header comment updated — the
  tier renders only when a data source (placeholder or warehouse) exists.
- **Import script** `scripts/import-insurance-data.ts` + npm script `warehouse:import-loss-runs`:
  validates fixture-shaped JSON (same Zod schema), `INSERT OR IGNORE` into `insurance_loss_events`
  (idempotent via the 022 UNIQUE constraint); `--dec-pages` mode updates per-policy
  deductible/coverage_limit by policy id. This is the one-command real-data swap.

### 3.2 Tax strategy + filed returns (C2)

- **Contract** `src/contracts/tax-strategy.ts` (ARCHITECT-OWNED — declared): `CostSegOpportunity
  { propertyId, propertyName|null, depreciableBasis, landAllocationPct, reclassifiablePct,
  reclassifiableBasis, bonusYearPct, firstYearAccelerationUsd, savingsFullAsset|null,
  savingsOxfordShare|null, indeterminate, basisNote, prov }` (Oxford-share via real `ownershipPct`
  from property_master — the ONE real input), `EntityStrategyItem { id, title, detail, kind:
  'entity-structure'|'sec469'|'pipeline', applicabilityNote }` (qualitative, no $),
  `FiledReturnMeta { id, taxYear, entity, preparer|null, status: 'filed'|'extended'|'amended',
  storageNote }`, envelope `TaxStrategyReport { asOf, basisDataSource, filedReturnsDataSource,
  costSeg[], entityStrategies[], filedReturns[], advisoryOnly: literal(true) }`.
- **Engine** `server/warehouse/tax-strategy.ts`: pure `buildTaxStrategyReport(db, asOf, fixtures)`
  — reads `property_master` for names/ownershipPct (real), joins fixture basis rows;
  `firstYearAccelerationUsd = reclassifiableBasis × bonusYearPct` type arithmetic only; no marginal
  tax-rate assumptions (savings expressed as *deduction acceleration*, not tax dollars — basisNote
  says so; `savingsFullAsset` stays null in v1 rather than inventing a rate).
- **API**: extend `server/warehouse/tax-api.ts` (NOT architect-owned) with `GET /strategy` and
  reuse its `withDb` guard — no new server/index.ts mount needed.
- **UI** (`src/modules/taxes/`): third tab `'returns'` → "Filed Returns" (`FiledReturnsTable.tsx`:
  PlaceholderBanner + metadata DataTable + permanent in-body confidentiality note).
  `StrategyBoard.tsx`: when strategy data present, the static `DeferredStrategiesCard` is replaced
  by a third TierBoard tier "Depreciation & Cost-Seg" (tone `accent`) + an entity/pipeline strategies
  Card; the deferred card remains as the no-data-source fallback.

### 3.3 Shared

- **`src/primitives/PlaceholderBanner.tsx`**: `{ label?: string, detail: string }`, amber warn tint,
  `role="status"`, modeled on HurdleRateBanner/StaleBanner. Two consumers justify a primitive.
- **CLAUDE.md §3**: correct the stale Pending line (Phase 7 merged via #169; P4c/C2 now built on
  placeholder data, pending real-data swap). ARCHITECT-OWNED — declared in claim.
- **Docs**: `docs/placeholder-data.md` — what is placeholder, where fixtures live, how the swap
  works (import script for loss runs/dec pages; migration+importer to be built when accountant
  basis data arrives), and the honesty rails above.

## 4. Error handling

- Warehouse unavailable → existing 503 envelope → modules' existing `WarehouseUnavailableError`
  empty-state path.
- Missing/corrupt fixture file → discriminator `'absent'`, section renders the honest empty state
  (never a throw, never invented rows); engine unit-tests pin this.
- Fixture rows referencing unknown property ids → dropped + counted in a `droppedRows` disclosure
  field (never silently joined).

## 5. Testing

TDD per repo convention (in-memory better-sqlite3 + `runMigrations`, no mocks):

- Engine tests: hand-computed EAL/retained/transferred/acceleration fixtures; `indeterminate` on
  short history; over-limit disclosure; dropped-row disclosure; **cutover test** (empty table →
  `'placeholder'`; insert real row → `'warehouse'`, fixture ignored); no-calibration-write-on-
  placeholder test (asserts zero `calibration_verdict` rows).
- Contract round-trip tests (`contracts-insurance-loss.test.ts`, `contracts-tax-strategy.test.ts`).
- Module tests: third tabs render; PlaceholderBanner present when placeholder, absent when
  warehouse; SavingsBoard third tier appears with data / absent without; existing two-tier and
  two-tab tests updated deliberately (they pin "exactly two" today).
- Import-script test: idempotency (double-run inserts once), rejection of malformed rows.
- Gate: `npm run gate` green (0xC0000005 = rerun once, per memory); `warehouse:verify` EPERM in
  worktree → re-run from main checkout at same commit to confirm environment artifact.

## 6. Governance

- Claim: `architecture/status.json` entry `p4c-c2-placeholder-buildout` (in_progress,
  `review_needed: true`, detail naming the architect-owned touches: `src/contracts/insurance-loss.ts`
  (new), `src/contracts/tax-strategy.ts` (new), `server/index.ts` (one mount line), `CLAUDE.md` §3
  (doc-drift fix)) + `architecture/ownership.json` worktree entry; committed before feature code.
  Gabriel's in-turn order is the standing authorization; the claim makes it auditable.
- Refute doctrine: engines are financial-shaped → run `refute-financial-change` workflow pre-PR,
  `Refute-Reviewed: wf_<runId>` trailer on the engine commits' PR; UI/docs commits carry
  `Refute-Skip: display-only`.
- No migrations. No buy-box/governor/threshold changes. New advisory outputs ship `advisoryOnly`.
- PR opened, never merged by the agent (established pattern).
