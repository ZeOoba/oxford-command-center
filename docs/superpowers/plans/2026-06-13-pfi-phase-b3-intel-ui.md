# PFI Phase B.3 — Intelligence UI Design Upgrades Implementation Plan

> **For agentic workers:** Implement task-by-task under superpowers:test-driven-development. Steps use checkbox (`- [ ]`) syntax. All pure logic is TDD'd (test first, watched to fail); the heavy intel views are browser-verified by convention (NOT jsdom-rendered) — see "Testing convention" below.

**Goal:** Five design/UX upgrades to the existing PFI intelligence UI — a morning-briefing hero, an answer-first property verdict card, a module-level time control, a since-acquisition leaderboard, and deep-linkable property URLs — reusing the existing design system with zero new dependencies.

**Architecture:** New *pure* synthesis lives in the existing `*-intel.ts` / `synthesis.ts` sibling modules (or a new `period-intel.ts`) and is golden-tested; the views only render it and route clicks. Deep-linking is wired through the existing URL router via a **new, separate** `intelPropertyId` field that is *not* a drawer `EntityRef`, so it is additive and distinct from the `/portfolio/:id` global drawer.

**Tech Stack:** React 19 + Vite, TanStack Query, react-router-dom v6, Vitest (jsdom, globals), strict TS (`noUncheckedIndexedAccess`, `verbatimModuleSyntax`), ESLint `--max-warnings 0`. Charts: `src/charts/*`. Primitives: `src/primitives/*`. Tokens: `src/tokens/theme.css`. Formatters: `src/analytics/format.ts`.

---

## Pre-mortem (failure modes & mitigations)

1. **Routing regression — intel deep-link opens the global EntityDrawer.** The drawer renders off `ui.selected` (an `EntityRef`), derived only when `MODULE_PRIMARY_TYPE[moduleId]` exists. *Mitigation:* do NOT add `intel` to `MODULE_PRIMARY_TYPE`. Add a separate `intelPropertyId` field on `RouteState`/`UiState`; `selected` stays `null` for `/intel/:id`. A routing test asserts `parseRoute('/intel/x').selected === null` AND `.intelPropertyId === 'x'`. Leave `entityPath`/`HOME_MODULE`/`/portfolio/:id` untouched.
2. **AreaChart date-parse trap.** AreaChart parses x as calendar dates; annual 'YYYY'/YTD periods break it. *Mitigation:* introduce no AreaChart; reuse BarChart/Sparkline/Waterfall (already used). No new charts.
3. **Null-SF / single-period properties crash.** `1851 S Club Solar` has null rentable_sf → null $/SF; some properties have one period (no growth/drivers). *Mitigation:* every new pure helper is null-safe; heat tiles & KPI render '—'; `rootCauseLine` returns `null` when <2 FY periods; since-acq ranking excludes `comparable:false`/null.
4. **YTD vs FY grain confusion in the time control.** Scores are FY2025; 2026 is YTD/partial. *Mitigation:* scores/attention/capital/actions/verdict stay on the latest FULL YEAR regardless; the control governs only displayed LEVELS/benchmarks; a persistent "YTD (partial)" banner shows whenever a YTD period's levels are displayed. Benchmark route filters by exact period string (grain-agnostic) and FY/YTD period strings never collide, so a YTD selection does not 400.
5. **Bundle bloat / lazy-chunk regression.** The intel module is a lazy chunk. *Mitigation:* no new deps; pure helpers are tiny; run `npm run build && npm run check:bundle`.
6. **Strict-TS index access.** `noUncheckedIndexedAccess` makes `arr[i]` `T | undefined`. *Mitigation:* guard with `?.`/`!` exactly as surrounding code does; golden tests catch logic slips.
7. **Sandbox API 500s block live verification.** The preview brain server 500s on every `/api` route. *Mitigation:* rely on the unit suite + typecheck + lint + build for functional verification; flag visual verification to Gabriel via `npm run dev`.

## Testing convention (match existing)

`tests/unit/intel-*-view.test.ts` test the **pure helpers** backing each view — the views themselves are browser-verified, not jsdom-rendered (see the header comment in `tests/unit/intel-property-view.test.ts`). New view wiring therefore adds NO jsdom render tests; instead every new piece of logic is extracted to a pure helper and golden-tested. Routing logic (`parseRoute`) IS pure and unit-tested.

## File inventory

**Pure logic (create/modify) — all golden-tested:**
- `src/modules/intel/ownership-intel.ts` — ADD `portfolioVerdict()`, `portfolioTotalsForPeriod()`.
- `src/modules/intel/synthesis.ts` — ADD `rankBySinceAcqGrowth()`.
- `src/modules/intel/property-intel.ts` — ADD `rootCauseLine()`, `recommendedAction()`, `pickPeriodMetrics()`.
- `src/modules/intel/period-intel.ts` — CREATE: `availablePeriods()`, `defaultPeriod()`, `isYtdPeriod()`, `PeriodOption`.
- `src/brain/routing.ts` — ADD `intelPropertyId` to `RouteState` + parse it; ADD `intelPropertyPath()`.

**Wiring (modify) — browser-verified:**
- `src/brain/ui-context.ts` — ADD `intelPropertyId`, `openIntelProperty` to `UiState` + default ctx.
- `src/brain/UiProvider.tsx` — derive `intelPropertyId`; add `openIntelProperty`.
- `src/modules/intel/IntelModule.tsx` — period control + YTD banner (item 3); selection via URL (item 5).
- `src/modules/intel/OwnershipView.tsx` — morning-briefing hero (item 1); since-acq leaderboard (item 4); period-aware band (item 3).
- `src/modules/intel/PropertyIntelView.tsx` — answer-first verdict card (item 2); period-aware KPI (item 3).
- `src/modules/intel/BenchmarksView.tsx` — period driven by module control (item 3).

**Tests (modify/create):**
- `tests/unit/intel-ownership-view.test.ts` — `portfolioVerdict`, `portfolioTotalsForPeriod`.
- `tests/unit/intel-synthesis.test.ts` — `rankBySinceAcqGrowth`.
- `tests/unit/intel-property-view.test.ts` — `rootCauseLine`, `recommendedAction`, `pickPeriodMetrics`.
- `tests/unit/intel-period.test.ts` — CREATE.
- `tests/unit/routing.test.ts` — intel deep-link cases + `intelPropertyPath`.

**Docs:** this plan; `CHANGELOG.md` entry; event-log entry.

---

## Phase 1 — Pure logic + golden tests (TDD)

### Task 1.1: Portfolio verdict sentence (item 1)

**Files:** Modify `src/modules/intel/ownership-intel.ts`; Test `tests/unit/intel-ownership-view.test.ts`.

- [ ] **Write failing test** — verdict names NOI, property count, # needing attention (orange+red), # disposition candidates, and a health posture; empty-safe.
- [ ] **Run** `npx vitest run tests/unit/intel-ownership-view.test.ts` → FAIL (portfolioVerdict undefined).
- [ ] **Implement** `portfolioVerdict(scores, totals)` returning a single deterministic sentence built from health-band counts (excellent+good = healthy, watch, concern), attention orange+red, disposition candidates, and `fmtUsdCompact(totals.portfolioNoi)`. Empty → "No scored properties yet." Uses the latest-FY `totals` (verdict basis = scoring basis, NOT the period control).
- [ ] **Run** → PASS.
- [ ] **Commit.**

### Task 1.2: Period-scoped portfolio totals (item 3)

**Files:** Modify `src/modules/intel/ownership-intel.ts`; Test `tests/unit/intel-ownership-view.test.ts`.

- [ ] **Write failing test** — `portfolioTotalsForPeriod(metrics, '2024')` sums only rows whose `period==='2024'`, counts those properties; empty/absent period → zeros.
- [ ] **Run** → FAIL.
- [ ] **Implement** `portfolioTotalsForPeriod(metrics, period)`: iterate rows, match `m.period===period`, sum `noi`/`oxfordNoi`, count distinct properties. Returns same `PortfolioTotals` shape.
- [ ] **Run** → PASS. **Commit.**

### Task 1.3: Since-acquisition NOI/SF leaderboard ranking (item 4)

**Files:** Modify `src/modules/intel/synthesis.ts`; Test `tests/unit/intel-synthesis.test.ts`.

- [ ] **Write failing test** — `rankBySinceAcqGrowth(rows)` returns `{ranked, insufficient}`: `ranked` = rows with `comparable && noiPerSfGrowth!=null`, sorted DESC by `noiPerSfGrowth`; `insufficient` = count of excluded (incomparable or null). Empty-safe.
- [ ] **Run** → FAIL.
- [ ] **Implement** in `synthesis.ts` (sits beside `improving/deterioratingProperties`).
- [ ] **Run** → PASS. **Commit.**

### Task 1.4: Root-cause line + recommended action + period picker (item 2 + item 3)

**Files:** Modify `src/modules/intel/property-intel.ts`; Test `tests/unit/intel-property-view.test.ts`.

- [ ] **Write failing tests**:
  - `rootCauseLine(decomp)` — given `{from,to,totalDelta,drivers:NoiDriver[]}`, returns `"Largest driver: {category}, {fmtPct(contributionPct)} of the {sign}{fmtUsd(|Δ|)} change (FY{from}→FY{to})."`; `null` when decomp is null; handles empty drivers and null `contributionPct` (ΔNOI≈0).
  - `recommendedAction(score)` — maps `capitalAction`→verb (`invest`→"Deploy capital", `hold`→"Hold", `monitor`→"Monitor closely", `disposition-candidate`→"Evaluate for disposition") and appends the first reason if present.
  - `pickPeriodMetrics(propMetrics, period)` — returns the row matching `period`, else latest full year, else null (null-safe).
- [ ] **Run** → FAIL.
- [ ] **Implement** all three in `property-intel.ts` (import `NoiDriver`, `NoiDecomposition` types from `./analytics-hooks`; `fmtUsd`/`fmtPct` from `@analytics/index`).
- [ ] **Run** → PASS. **Commit.**

### Task 1.5: Period model (item 3)

**Files:** Create `src/modules/intel/period-intel.ts`; Create `tests/unit/intel-period.test.ts`.

- [ ] **Write failing test** — `availablePeriods(metrics)` returns distinct periods as `PeriodOption{period,grainHint,isYtd,label}`, full-years DESC first then YTD DESC, labels `FY{p}` / `{p} YTD`; `defaultPeriod(opts)` = latest FY (first non-YTD), else first, else null; `isYtdPeriod(opts, p)` looks up grain. Empty-safe.
- [ ] **Run** → FAIL.
- [ ] **Implement** `period-intel.ts`.
- [ ] **Run** → PASS. **Commit.**

### Task 1.6: Routing — intel deep-link parse (item 5, pure part)

**Files:** Modify `src/brain/routing.ts`; Test `tests/unit/routing.test.ts`.

- [ ] **Write failing test** — `parseRoute('/intel/9050-red-branch', MODS+['intel'])` → `{moduleId:'intel', known:true, selected:null, intelPropertyId:'9050-red-branch'}`; `/intel` → `intelPropertyId:null`; non-intel module → `intelPropertyId:null`; id encoding round-trips; `intelPropertyPath('p 1')` → `/intel/p%201`.
- [ ] **Run** → FAIL.
- [ ] **Implement**: add `intelPropertyId: string | null` to `RouteState`; in `parseRoute` set `intelPropertyId = moduleId==='intel' && entityId ? entityId : null`; add `export function intelPropertyPath(propertyId)`. Do NOT touch `MODULE_PRIMARY_TYPE`/`HOME_MODULE`/`entityPath`.
- [ ] **Run** → PASS (existing routing tests stay green). **Commit.**

## Phase 2 — Item 1: Morning-briefing hero (OwnershipView)

**Files:** Modify `src/modules/intel/OwnershipView.tsx`.

- [ ] Add a `BriefingHero` block ABOVE the existing sections: (1) `portfolioVerdict(...)` sentence; (2) top-3 `actions.slice(0,3)` (reuse `buildActionList`, existing `ActionList` row idiom, clickable `open →`); (3) a 12-tile attention heat-strip — one tile per ranked score, tile bg = `color-mix` of the `attentionBand` semantic color, label = name + NOI/SF (from `latestFyByProperty`, '—' when null), click → `onOpenProperty`; (4) compact capital-allocation counts (invest/hold/monitor/disposition) reusing `CAPITAL_TONE`/`CAPITAL_LABEL`.
- [ ] Keep all existing sections below the fold (ActionList full, AttentionMatrix, Improving/Deteriorating, CapitalAllocation, Risks, PmSnapshot).
- [ ] `npx vitest run tests/unit/intel-ownership-view.test.ts` green; `npm run typecheck && npm run lint`. **Commit.**

## Phase 3 — Item 2: Answer-first property verdict card (PropertyIntelView)

**Files:** Modify `src/modules/intel/PropertyIntelView.tsx`.

- [ ] Reorder hero to verdict → WHY → DO: keep `VerdictHeader` (health/band/attention/capital, "Scored on FY{period}"), then add the `rootCauseLine(drivers.data ?? null)` sentence (WHY; "Needs two full years…" note when null), then `recommendedAction(score)` (DO).
- [ ] Move KPI row, trends, expense breakdown, and the ΔNOI waterfall BELOW the hero (waterfall stays; replace inline `driverHeadline` with the shared `rootCauseLine`).
- [ ] `npx vitest run tests/unit/intel-property-view.test.ts` green; typecheck + lint. **Commit.**

## Phase 4 — Item 3: Time control + YTD banner (IntelModule + views)

**Files:** Modify `IntelModule.tsx`, `OwnershipView.tsx`, `PropertyIntelView.tsx`, `BenchmarksView.tsx`.

- [ ] IntelModule: call `useMetrics()` (deduped), build `options=availablePeriods(...)`, hold `selectedPeriod` state, resolve `effectivePeriod = (selectedPeriod∈options) ? selectedPeriod : defaultPeriod(options)`. Render a period `<select>` (Benchmarks `Selectors` idiom) in the header on intelligence tabs only; render a persistent "YTD (partial) — scores remain on the latest full year" banner when `isYtdPeriod(options, effectivePeriod)`.
- [ ] Pass `period={effectivePeriod}` to OwnershipView/PropertyIntelView/BenchmarksView.
- [ ] OwnershipView: PortfolioBand NOI/Oxford NOI/Properties via `portfolioTotalsForPeriod(metricData, effectivePeriod)` (fallback to latest-FY `portfolioTotals` when null); attention/disposition tiles stay score-based; verdict stays FY. Sublabels show the period label.
- [ ] PropertyIntelView: KPI tiles use `pickPeriodMetrics(propMetrics, period)`; labels reflect the chosen period; verdict basis stays FY; trends/since-acq/waterfall stay FY.
- [ ] BenchmarksView: drop the local period `<select>` (keep metric `<select>`); use the `period` prop for `useBenchmarks`.
- [ ] Tests green; typecheck + lint. **Commit.**

## Phase 5 — Item 4: Since-acquisition leaderboard (OwnershipView, below fold)

**Files:** Modify `src/modules/intel/OwnershipView.tsx`.

- [ ] Add a `SinceAcqLeaderboard` card (below the fold) rendering `rankBySinceAcqGrowth(sinceAcq)`: ranked rows by NOI/SF growth since acquisition (best→worst), each row name + signed % + `since FY{anchor}`, click → `onOpenProperty`; footer note "{insufficient} excluded — insufficient history" when `insufficient>0`. Reuse `fmtSignedPct`/`growthColor` idioms.
- [ ] Tests green; typecheck + lint. **Commit.**

## Phase 6 — Item 5: Deep-linkable property pages (`/intel/:propertyId`)

**Files:** Modify `ui-context.ts`, `UiProvider.tsx`, `IntelModule.tsx`. (Routing pure part done in Task 1.6.)

- [ ] `ui-context.ts`: add `intelPropertyId: string | null` and `openIntelProperty: (id:string)=>void` to `UiState` + default ctx (no-op).
- [ ] `UiProvider.tsx`: destructure `intelPropertyId` from `parseRoute`; `openIntelProperty = useCallback(id => navigate(`/intel/${encodeURIComponent(id)}${search}`), [navigate, search])`; add both to the memoized value + deps.
- [ ] `IntelModule.tsx`: read `{intelPropertyId, openIntelProperty}` from `useUi()`; `openProperty(id) = () => { openIntelProperty(id); setTab('property'); }`; pass `propertyId={intelPropertyId}` + `onSelectProperty={openIntelProperty}` to PropertyIntelView; add `useEffect(() => { if (intelPropertyId) setTab('property'); }, [intelPropertyId])` so a deep link / chip click lands on the Property tab. Remove the now-unused local `selectedPropertyId` state.
- [ ] Confirm `/portfolio/:id` drawer untouched: `parseRoute('/intel/x').selected===null` (Task 1.6 test). Tests green; typecheck + lint. **Commit.**

## Phase 7 — Verify, gate, review, PR

- [ ] `npm run gate` (typecheck + lint + test + reconcile + warehouse:verify) → green.
- [ ] `npm run build && npm run check:bundle` → green (lazy chunk sane).
- [ ] Independent LOCAL code review (superpowers:requesting-code-review, opus reviewer ≥ implementer); address Critical/Important.
- [ ] `CHANGELOG.md`: prepend "## PFI Phase B.3 — intelligence UI design upgrades".
- [ ] Open PR (base `main`), do NOT merge. Event-log entry via `python ~/.claude/maintenance/append-event-log.py`.
