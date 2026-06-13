# Pattern: pure synthesis → golden test → thin view (intel module)

The repeatable shape behind every PFI intel feature (warehouse → analytics engine → intel UI).
Follow it for new intelligence surfaces so logic stays verifiable and views stay disposable.

## The shape

1. **Put the "so what" in a pure module, not the view.** New decision logic goes in a sibling
   `src/modules/intel/*-intel.ts` (or `synthesis.ts`) — no React, no I/O, no clock. Inputs are the
   engine response types from `analytics-hooks.ts` (`PropertyScore`, `PeriodMetrics`,
   `SinceAcquisition`, `NoiDecomposition`, …); outputs are strings/arrays/objects the view renders
   verbatim. Re-running on the same input must deep-equal the prior result.
   - Examples: `ownership-intel.portfolioVerdict`, `property-intel.rootCauseLine`,
     `synthesis.rankBySinceAcqGrowth`, `period-intel.availablePeriods`.

2. **Golden-test the pure logic first (TDD).** Add cases to `tests/unit/intel-*.test.ts` with typed
   literal fixtures (see the `pm(...)` / `score(...)` factories already there). Pin exact output
   (sentence strings, ordered ids). Cover the data realities: null `$/SF` (1851 Solar), single-period
   properties (no growth/drivers), FY-vs-YTD grain, and empty input. Watch it fail, then implement.

3. **Keep the view thin.** The view calls hooks, memoizes the `?? []` extractions for stable refs,
   threads pure results into primitives/charts, and routes clicks. No business logic in JSX.

## Hard constraints (carried from the engine phases)

- **No AreaChart for annual series.** Its x-axis parses calendar dates; `'YYYY'`/YTD periods break
  it. Use `BarChart`/`Sparkline`/`Waterfall`.
- **Scores stay on the latest full year**; the module time control governs displayed LEVELS only.
  Surface any YTD/partial period with the persistent banner — never imply it's a full year.
- **Design system only:** primitives/charts/tokens; no raw hex; numbers carry the `.num` class and
  format via `src/analytics/format.ts` (null → `'—'`, never `.toFixed(null)`).
- **Strict TS:** `noUncheckedIndexedAccess` (guard `arr[i]` / `reasons[0]`), `verbatimModuleSyntax`
  (`import type`); ESLint `--max-warnings 0`; keep the intel lazy chunk lean (`npm run check:bundle`).

## Testing convention

The heavy intel views are **browser-verified, not jsdom-rendered** — so the *logic* carries the
coverage. When a render-level smoke check is warranted, seed a local TanStack `QueryClient` cache
with the `ANALYTICS_KEYS` and render with a `QueryClientProvider` (do **not** `vi.mock` the hook
module — `vitest.config.ts` sets `isolate: false`, so module mocks can bleed across the suite). See
`tests/unit/intel-ownership-smoke.test.tsx` for the reference.
