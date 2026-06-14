# H6 / I2 — Warehouse → client Zod read boundary

**Lane:** L4 refactor / L3 build hybrid. **Behavior-preserving** structural refactor.
**Finding:** `warehouse-read-boundary-bypasses-contracts` (HIGH). **Branch:** `feat/h6-warehouse-zod-boundary` (based on `origin/fix/m4-capitalaction-enum` — inherits single-sourced `CapitalAction`; PR base = `main`).

## Goal
Every warehouse analytics payload crosses a Zod schema in `src/contracts/`. Client stops re-declaring engine types and casting raw JSON via `fetchJson<T>`. Mirror the proven `acquisition.ts` pattern (`Schema.parse(result)` before return).

## Confirmed pre-existing drift (schema mirrors ENGINE, the source of truth)
- Engine `PropertyScore` has `benchmarkCohortSize: number` — client redeclaration OMITS it.
- Engine `PeriodMetrics` has `basis: string` — client redeclaration OMITS it.
These prove the boundary rot. New schemas encode the **engine** shape; client gains the fields (UI ignores them) — behavior-preserving on the wire.

## Exact shapes (engine = source of truth)
Enums (single-source in `contracts/warehouse.ts`, near read types — NOT touching calibration block):
`HealthBand`, `AttentionBand`, `AnomalySeverity`, `AnomalyKind`, `Quartile (1|2|3|4|null)`, `NumericMetricKey (12)`. `CapitalAction` already done (M4).

Payload schemas: `PeriodMetricsSchema`, `PropertyScoreSchema`, `GrowthPointSchema`, `SinceAcquisitionSchema`, `NoiDriverSchema`, `NoiDecompositionSchema` (engine `{totalDelta,drivers}`), `AnomalyFlagSchema`, `MetricBenchmarkSchema`, `PropertyRankSchema`, `PmScorecardSchema`.

Route envelopes: metrics `{metrics}` · growth `{growth,sinceAcquisition}` · drivers `{propertyId,from,to,...decomp}` · anomalies `{anomalies}` · benchmarks `{byMetric,rankings}` · scores `{scores}` · pm `{scorecards}`. (Actual route is `/analytics/pm`, not `/analytics/pm-scorecards` — drift from finding text.)

## Sequence
1. **M4-style enum commit (typecheck-only):** add the 5 remaining shared enums + `NumericMetricKey` to contracts; point engines (`intel-config.ts`, `benchmarks.ts`, `anomalies.ts`) at `z.infer` types. Push.
2. **Payload + envelope schemas** in `contracts/warehouse.ts`; export `z.infer` types. TDD fidelity tests first (tmpdir sqlite, seeded; `Schema.parse(out)` round-trips deep-equal).
3. **Engines = source of truth:** replace hand return types with `z.infer<typeof XSchema>`. No logic/value change.
4. **Server parse:** wrap each analytics `c.json(...)` in `Schema.parse(...)`.
5. **Client parse + delete redeclarations:** `analytics-hooks.ts` imports `z.infer` types + envelope schemas, replaces every `fetchJson<T>` cast with parse, deletes all hand-redeclared enums/interfaces. Keep `WarehouseUnavailable`/503 handling.

## Constraints
- No engine LOGIC/VALUE change. If engine output looks buggy → encode real shape, DEFER the bug (PR + memory). No `.passthrough()`/`any` loosening.
- Don't touch governors (`capital-config.ts`, `acquisition-ruleset`, `intel-config` weights) or the calibration contracts in `warehouse.ts`.
- Synthetic test fixtures only (B1 — no real deal terms).
- Scope: the 7 analytics routes feeding `analytics-hooks.ts`. `/noi`, `/imports`, `/issues` (hooks.ts) are out of this finding's named scope — note as candidate follow-on if they also cast.

## Verify (self-gating, ≤2 rounds)
3-lens adversarial: schema-fidelity (exact match on seeded DB), parse-safety/completeness (every route parses; zero `fetchJson<T>` casts + zero hand-redeclared interfaces remain), regression (existing analytics/e2e green, logic untouched, `CapitalAction` single-sourced). Then governance/typecheck/lint/test green → draft PR → bounded CI poll → squash-merge on green.
