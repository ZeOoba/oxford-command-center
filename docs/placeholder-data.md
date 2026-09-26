# Placeholder Data Doctrine — P4c (Insurance) + C2 (Tax)

Spec: `docs/superpowers/specs/2026-07-09-p4c-c2-placeholder-buildout-design.md`

P4c (insurance self-insure/deductible optimization) and C2 (tax cost-seg/filed-returns
refinements) were built on **clearly-marked placeholder fixtures** rather than deferred further,
per Gabriel's in-turn order ("build these with placeholders for when I get real data"). This
doc is the durable reference for what the placeholders are, how a surface signals it's running
on one, and how each gets swapped for real data.

Placeholder data **never enters a warehouse table**. It lives only in
`server/warehouse/placeholders/*.placeholder.json` and is read by
`server/warehouse/placeholder-data.ts`'s resolvers **only when the corresponding warehouse
source is empty/null**. The moment real data lands in the warehouse (by whatever mechanism —
importer or future migration), the resolver reads the warehouse instead, automatically, with no
code change. This is a fixture-fallback pattern, not a mock-data mode: nothing downstream can
tell the difference between "warehouse happens to be empty" and "placeholder fixture is filling
the gap" except the `dataSource` discriminator described below.

## 1. The four fixtures

| Fixture file | Stands in for | Real-data swap path | Discriminator field(s) → values |
|---|---|---|---|
| `server/warehouse/placeholders/loss-runs.placeholder.json` | Broker loss-run history (8 synthetic events, real property ids, `policyRef: "PLACEHOLDER"`) feeding `insurance_loss_events` | `npm run warehouse:import-loss-runs` (default mode of `scripts/import-insurance-data.ts`) — `INSERT OR IGNORE` into `insurance_loss_events`; once the table has any rows, `resolveLossEvents()` reads the warehouse and ignores the fixture, automatically | `InsuranceLossReport.lossDataSource` (contract: `src/contracts/insurance-loss.ts`) — `'warehouse'` \| `'placeholder'` \| `'absent'`; resolver-level `LossEventsResolved.source` in `server/warehouse/placeholder-data.ts` |
| `server/warehouse/placeholders/dec-pages.placeholder.json` | A blanket deductible/coverage-limit assumption (`blanketDeductible: 25000`, `blanketCoverageLimit: 2000000`) for any policy missing real dec-page terms | `npx tsx scripts/import-insurance-data.ts --dec-pages <policies.json>` — `UPDATE property_insurance_policies SET deductible = ?, coverage_limit = ?`; resolution is **per-policy**: a policy with real (non-null) `deductible`/`coverage_limit` always wins over the blanket fixture, even while other policies still fall back | `InsuranceLossReport.decPageDataSource` — `'placeholder'` if **any** policy in the report fell back to the blanket fixture; resolver-level `DecPagesResolved.anyPlaceholder` (bool) and per-policy `DecPageEntry.source` in `placeholder-data.ts` |
| `server/warehouse/placeholders/depreciable-basis.placeholder.json` | Per-property depreciable basis, land-allocation %, placed-in-service year, and reclassifiable % (5 synthetic rows) plus a synthetic bonus-depreciation phase-down schedule (`bonusPctByYear`) feeding the cost-seg acceleration estimate | **No importer exists yet.** A future migration + importer is needed once accountant-verified basis/land-allocation data is available; the fixture's row shape is the interim contract that importer will target. Do not present this as having a swap mechanism today. | `TaxStrategyReport.basisDataSource` (contract: `src/contracts/tax-strategy.ts`) — currently always `'placeholder'` (fixture-only in v1; resolver `resolveDepreciableBasis()` never reads a warehouse table) |
| `server/warehouse/placeholders/filed-returns.placeholder.json` | Filed-return **catalog metadata only** (id, tax year, entity, preparer, status, `storageNote`) — never return contents | **No importer exists yet**, and never will provide return *contents*. A future migration + importer would replace placeholder metadata with real metadata + a SharePoint link-out — same permanent metadata-only boundary (see §2). | `TaxStrategyReport.filedReturnsDataSource` — currently always `'placeholder'` (resolver `resolveFiledReturns()` is fixture-only, no db argument at all) |

Every fixture file carries a `_note` field stating its placeholder status and (where one exists)
its swap path in-line — this table should stay consistent with those notes; if they drift, the
fixture's `_note` is the more current source since it ships with the code.

### Loss attachment and deductible-review eligibility (2026-09-24)

How `buildInsuranceLossReport` (`server/warehouse/insurance-loss-analysis.ts`) books a loss event —
applies identically to the placeholder fixture and to real imported loss runs:

- **Eligible policies** are first-party property lines (policy_type contains property / package /
  building — `server/warehouse/insurance-policy-lines.ts`), regardless of TIV, excluding tenant
  evidence-of-insurance certificates (ACORD 25/28). Ratified by Gabriel 2026-09-24. TIV is required
  only for the own-book rate benchmark. A tenant certificate still counts as coverage on file for the
  insurance-gap alert.
- **Each event attaches to exactly one eligible policy** at its property: `policy_ref` matching a
  policy's own number, else any number its line has carried (upper-case, whitespace removed) → the
  policy whose term covers `loss_date` → the most recently incepted policy (go-forward review of
  losses that predate every current term). A `policy_ref` naming only non-property lines, or a
  third-party cause leaves the event in EAL only — never booked against a property deductible.
  Bodily/personal injury, slip- or trip-and-fall, EPLI, employment practices, a suit or a claimant
  are always third-party; bare "liability" is third-party unless a property peril (water, wind,
  fire, roof, ...) is also named.
- The self-insure split is the plain sum of the (disjoint) per-policy review rows.
- **Unmatched policy refs (2026-09-24).** `InsuranceLossReport.unmatchedPolicyRefs` lists events
  whose non-blank `policy_ref` names no policy (own number or line alias, any line) at their
  property — a loss-run typo or a register gap. **Warehouse-only:** computed solely when
  `lossDataSource` is `'warehouse'`; this fixture's `policyRef: "PLACEHOLDER"` sentinel is
  synthetic, so a fixture-sourced report always carries `[]`. **Visibility only:** the ref is
  ignored and attachment proceeds exactly as above; nothing in EAL, the reviews or the split
  changes. Flagged **regardless of cause** — a third-party claim citing an unknown number is the
  same data defect.

## 2. Honesty rails (non-negotiable)

These are enforced in code, not just convention — see `src/contracts/insurance-loss.ts` and
`src/contracts/tax-strategy.ts` for the exact schema mechanics.

- **No calibration writes while any input is placeholder.** Both reports are hard-gated
  `advisoryOnly: z.literal(true)` and are read-path only. Nothing derived from a placeholder loss
  run, dec page, or basis row is ever persisted back into the warehouse or used to calibrate a
  benchmark (`calibration_verdict` history stays uncontaminated by synthetic figures).
- **`savingsFullAsset` / `savingsOxfordShare` are HARD-NULL in v1** (`CostSegOpportunity`,
  `src/contracts/tax-strategy.ts`) — typed `z.null()`, so the schema itself rejects any non-null
  value. v1 will not invent a tax-savings dollar figure because doing so requires a marginal-rate
  assumption it explicitly refuses to make. The `firstYearAcceleration*` fields it does compute
  are **deduction-timing** figures (how much depreciation is pulled into year one), not tax
  dollars — a real, computable quantity even before an accountant confirms a rate. **No future
  real-data path removes this null** — swapping the depreciable-basis fixture for real basis data
  changes the *basis*, `landAllocationPct`, and `reclassifiablePct` inputs; it does not license a
  savings-dollar figure. That requires a separate, explicit decision to model a marginal rate.
- **Filed returns are metadata-only, permanently.** This is the C2 confidentiality boundary that
  put filed-returns/cost-seg on PR #168's cut list in the first place, and it survives the
  placeholder buildout unchanged: `FiledReturnMeta` (`src/contracts/tax-strategy.ts`) has no field
  for return contents and never will. Real accountant data replaces the placeholder *metadata*
  rows with real metadata plus a SharePoint link-out — the documents themselves never enter this
  system, placeholder or real.
- **Placeholder rows never enter a warehouse table.** They exist only as fixture JSON, read at
  request time by the resolvers in `server/warehouse/placeholder-data.ts`. This keeps the fixture
  from contaminating any other engine that queries `insurance_loss_events` or
  `property_insurance_policies` directly, and keeps the swap-to-real-data a pure data change with
  zero code change.
- **UI signal.** Any surface rendering a report with a `'placeholder'` discriminator shows
  `src/primitives/PlaceholderBanner.tsx` — an amber advisory banner ("PLACEHOLDER DATA — …")
  stating no figure on that surface is decision-grade. Gated on the report's `dataSource`
  field(s), not a static flag, so the banner disappears automatically the moment real data cuts
  the surface over to `'warehouse'`. The Self-Insure & Bids tab's separate amber
  "UNMATCHED POLICY REFS" notice (`unmatchedPolicyRefsDetail` in `src/modules/insurance/hooks.ts`)
  is **independent** of this banner — it is a warehouse-data signal, so it can appear without the
  placeholder banner and never appears on fixture data.
- **Fail-soft, never fail-loud, on the fixture path.** A missing or corrupt fixture file resolves
  to `source: 'absent'` with empty rows — never a thrown error. A malformed individual row (bad
  type, unknown `propertyId` not present in `property_master`) is skipped and counted in
  `droppedRows` — surfaced in the report (`InsuranceLossReport.droppedFixtureRows`,
  `TaxStrategyReport.droppedFixtureRows`), never silently dropped without a trace.

## 3. Swap procedures

**Loss runs and dec pages (P4c) — swap mechanism exists today, automatic cutover:**

```
npm run warehouse:import-loss-runs -- <events.json>            # default mode: loss events
npx tsx scripts/import-insurance-data.ts --dec-pages <policies.json>   # dec-page mode
```

Both run through `scripts/import-insurance-data.ts` (Task 11). Loss events use
`INSERT OR IGNORE` against `insurance_loss_events`'s `PRIMARY KEY(id)` and
`UNIQUE(property_id, loss_date, cause, gross_incurred)` (migration 022), so re-running the same
file is idempotent — a repeat run reports the rows as `ignored`, not duplicated. (SQLite admits
NULL in that `TEXT PRIMARY KEY` — it has no `NOT NULL` — and NULL ids bypass the key check, but the
importer rejects any non-string or blank `id` before insert, so only a raw SQL write can create one.
More generally the table's column types are affinities, not guarantees — a TEXT column, even
`NOT NULL`, stores a BLOB as-is and the `gross_incurred` CHECK passes a BLOB — so no reader trusts
them: `resolveLossEvents` is the single normalization point and coerces every column to the
`LossEventRow` type, `''`/`null`/`0` for anything malformed.) Dec pages
`UPDATE property_insurance_policies SET deductible = ?, coverage_limit = ?` per policy id, so a
policy id not found in the table is counted `missing`, never thrown. Both accept an optional
`--db <path>` override (defaults to `WAREHOUSE_DB` env or `data/warehouse/finance.sqlite`).

`propertyId` handling on loss events is three-way, not a single accept/reject rule. A **blank or
missing** `propertyId` is valid, documented behavior — per
`docs/templates/insurance-loss-runs.template.csv` ("leave blank for a portfolio-level or
umbrella-policy loss that isn't attributable to a single property") — and is inserted with
`property_id = NULL` (FK-exempt); it is **not** flagged as a data-quality issue. A `propertyId`
that is **present, non-blank, but not found in `property_master`** is the only case that gets
DQ-flagged: the row is never inserted and is instead recorded as a `data_quality_issues` row,
mirroring `scripts/import-assessments.ts`'s unknown-property precedent. A `propertyId` that
resolves to a known property is inserted normally.

Both modes also reject certain rows outright at parse time — before any DB write, and before the
propertyId handling above even applies — reporting them only in the printed summary, never
persisting anything for that row: a loss event's `loss_date` must be strict ISO `YYYY-MM-DD`; a
US `MM/DD/YYYY` date, an Excel serial number, or an ISO-datetime with a time component is
rejected with a reason rather than silently reformatted (a non-ISO date would otherwise corrupt
downstream EAL calculations with no error raised). A dec-pages row whose `deductible` exceeds its
`coverageLimit` is likewise rejected outright, since it would otherwise silently break the loss
engine's retained/transferred/overLimit partition.

Once `insurance_loss_events` has any row, `resolveLossEvents()` stops reading the loss-runs
fixture — no other code change is required. Once a given policy's `deductible`/`coverage_limit`
columns are non-null, `resolveDecPages()` uses the real value for that policy specifically, even
while other policies still fall back to the blanket fixture.

**Depreciable basis and filed returns (C2) — no swap mechanism built yet:**

Neither `depreciable-basis.placeholder.json` nor `filed-returns.placeholder.json` has an import
script. `resolveDepreciableBasis()` and `resolveFiledReturns()` are fixture-only in v1 — there is
no warehouse table backing either input path today. When accountant-verified depreciable-basis /
land-allocation data (and, separately, real filed-return catalog metadata) becomes available, a
**future migration + importer** is needed — this doc, and the fixtures' own `_note` fields, are
the interim contract that importer should target (same row shape as the fixture: `propertyId`,
`depreciableBasis`, `landAllocationPct`, `placedInServiceYear`, `reclassifiablePct` for basis;
`id`, `taxYear`, `entity`, `preparer`, `status`, `storageNote` for filed returns — with the C2
metadata-only boundary in §2 unchanged). Do not claim otherwise until that migration + importer
ship.

## 4. Reference

Full design rationale, rejected alternatives, and component-level detail:
`docs/superpowers/specs/2026-07-09-p4c-c2-placeholder-buildout-design.md`.
