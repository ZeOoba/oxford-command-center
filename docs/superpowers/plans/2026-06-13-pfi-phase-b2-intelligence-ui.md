# PFI Phase B.2 — Property Financial Intelligence UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development. Steps use `- [ ]`. Every dispatch passes `model: opus`. Each phase: implement (TDD on pure logic) → spec+quality review subagent → `npm run gate` green → browser-verify → only then proceed.

**Goal:** Turn the Phase B analytics engine into the *operating layer* of the Command Center — not another dashboard. The intel module becomes an **Ownership Intelligence Center** (answers the 9 ownership questions, action-first) + **per-property Intelligence pages** (verdict → root cause → recommendation) + **Benchmarks** + **PM Scorecards**, all consuming `/api/warehouse/analytics/*`. Charts serve the narrative; every number resolves to a "so what."

**Architecture:** Extend `src/modules/intel/` (A.2). New: `analytics-hooks.ts` (TanStack Query over `/analytics/*`), `synthesis.ts` (pure decision-synthesis helpers — the "intelligence", fully unit-tested), `OwnershipView.tsx`, `PropertyIntelView.tsx`, `BenchmarksView.tsx`, `ManagersView.tsx`, and a new `src/charts/Waterfall.tsx` (ΔNOI driver waterfall — net-new). IA: tabs reorganized so **Ownership is the default**; data-ops tabs (Imports/Quality/Mappings) grouped after the intelligence tabs. Selection is local `useState` (the established in-module pattern; intel has no routing primary-type — do NOT add one).

**Tech Stack:** existing only — React 19, TanStack Query, visx (charts), Tailwind 4 tokens, react-aria primitives, vitest. **No new dependencies.** Waterfall is plain SVG + theme tokens.

**Conventions:** strict TS (`noUncheckedIndexedAccess`, `verbatimModuleSyntax` → `import type`); ESLint `--max-warnings 0`; numbers via `src/analytics/format.ts` (`fmtUsd`, `fmtPct`) + `.num` mono class; primitives via `src/primitives/` (Button uses **`onPress`** not onClick; Badge tones: neutral|gold|green|amber|red|blue|purple; DataTable needs `getRowId` + `sortValue` for sortable cols); charts via `src/charts/`. Reuse the CloseModule "local selectedId → inline expand, `1fr_320px`" idiom and the intel module's `isWarehouseUnavailable` degradation. Tests in `tests/unit/`; gate `npm run gate`; commit per task with `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

**Engine surface consumed (verified — exact fields):**
- `/analytics/scores` → `{scores: PropertyScore[]}` — `{propertyId, propertyName, period, health, healthBand('excellent'|'good'|'watch'|'concern'), attentionBand('green'|'yellow'|'orange'|'red'), capitalAction('invest'|'hold'|'monitor'|'disposition-candidate'), subScores:Record<string,number>, noiPerSfQuartile:1|2|3|4|null, reasons:string[]}`
- `/analytics/metrics` → `{metrics: PeriodMetrics[]}` — per (propertyId, period): revenue, opex, noi, noiMargin, expenseRatio, capex/ti/leasing, categories, revenueCategories, *PerSf fields, grainHint('year'|'ytd'), rentableSf, ownershipPct, oxfordNoi
- `/analytics/growth` → `{growth: GrowthPoint[], sinceAcquisition: SinceAcquisition[]}` — GrowthPoint `{propertyId, period, comparable, revenueGrowth|expenseGrowth|noiGrowth|noiPerSfGrowth:number|null}`; SinceAcquisition `{propertyId, anchorPeriod, latestPeriod, comparable, revenueGrowth|noiGrowth|noiPerSfGrowth|taxesGrowth|insuranceGrowth|revenuePerSfGrowth|noiCagr:number|null}`
- `/analytics/drivers/:propertyId?from=YYYY&to=YYYY` → `{propertyId, from, to, totalDelta, drivers: {category, delta, contributionPct:number|null}[]}` (404 if property/period missing)
- `/analytics/anomalies` → `{anomalies: {propertyId, period, kind('expense-growth'|'revenue-decline'|'noi-decline'|'noi-per-sf-decline'|'new-category'|'category-spike'), severity('low'|'moderate'|'high'|'critical'), detail, metricValue:number|null}[]}`
- `/analytics/benchmarks?period=YYYY&metric=<key>` → `{byMetric:{period,metric,avg,median,p25,p75,n}, rankings:{propertyId,value,rank,quartile:1|2|3|4|null}[]}`; metric keys: revenue,opex,noi,oxfordNoi,noiMargin,expenseRatio,revenuePerSf,noiPerSf,expensePerSf,taxesPerSf,insurancePerSf,repairsPerSf
- `/analytics/pm` → `{scorecards: {propertyManager, propertyCount, smallSample, avgNoiPerSf|avgNoiGrowth|avgExpenseGrowth:number|null}[]}`
- All routes 503 `{error:'warehouse unavailable'}` on mirror/cold → `isWarehouseUnavailable` true.

---

## PRE-MORTEM — failure modes addressed BEFORE coding (verify each is handled in the named phase)

1. **AreaChart misrenders annual periods.** It parses `date` via `new Date()` and labels months; our periods are `'2025'`/YTD. → Use **BarChart** (label=`'FY2024'`/`'2026 YTD'`, value) for year-series trends and **Sparkline** (numeric array) for KPI tiles. Never feed `'YYYY'` to AreaChart. (P1 chart helpers, P2 trends.)
2. **Sparse/degenerate data.** One-period properties (no growth/drivers), null `$/SF` (1851 Solar has no SF), null quartile (singleton cohort), YTD-only. → Every view guards null/empty with explicit "insufficient history"/"—" states; drivers offered only when ≥2 same-grain periods; the engine already returns nulls — UI must never `.toFixed` a null. Explicit tests: 1851-Solar (null SF) and a single-period property render without crash. (All phases.)
3. **Warehouse unavailable (mirror/cold/headless).** Analytics 503s. → New tabs gate behind the existing `isWarehouseUnavailable` check; module already shows the offline Card. Analytics hooks reuse `fetchJson`/`isWarehouseUnavailable`. No tab may throw on 503. (P1 hooks, every view.)
4. **Stale analytics after a mutation.** A.2's `useWarehouseInvalidate` invalidates imports+noi+issues but NOT analytics → after approve/override, scores/metrics are stale. → Extend invalidation to also drop the analytics keys. (P1.)
5. **Cross-grain misread by the user.** Scores are FY-cohort; 2026 YTD shown only as levels. → Every score/verdict surface LABELS its basis ("Scored on FY2025"); YTD columns are tagged "YTD (partial)"; growth/driver UIs never compare across grains (engine enforces; UI mirrors the label). (P2/P3.)
6. **Bundle bloat.** intel is a lazy chunk; budget = entry <250kB, routes <60kB gzip. → No new deps; Waterfall is lean SVG; verify `npm run build && npm run check:bundle` in P5. (P5.)
7. **Invalid query params.** benchmarks validates `YYYY` + metric enum (400 otherwise). → Selectors offer ONLY the metric enum + periods present in metrics; default latest FY + noiPerSf. (P4.)
8. **AI-slop aesthetic / not Gabriel's intent.** → Strictly reuse primitives + theme tokens; match CloseModule/PortfolioModule idioms; lead with verdict+action (not charts); spec+quality review each phase explicitly checks "operating system, not dashboard"; final design-review pass. (All; P5 review.)
9. **react-aria `onPress` vs onClick; DataTable needs getRowId/sortValue; KpiStat `value` accepts null.** → Noted; reviewers check.
10. **Determinism of synthesis.** The action-list/risk synthesis is pure and unit-tested (golden output on a fixture), so the "intelligence" is verifiable, not vibes. (P1.)

---

## PHASE 1 — Data layer: analytics hooks, synthesis logic, Waterfall chart

### Task 1.1 — Analytics hooks (`src/modules/intel/analytics-hooks.ts`)
**Files:** Create `src/modules/intel/analytics-hooks.ts` · Modify `src/modules/intel/hooks.ts` (extend `useWarehouseInvalidate` only) · Test `tests/unit/intel-analytics-hooks.test.ts` (pure helpers only)

- [ ] Reuse `fetchJson`, `WarehouseUnavailableError`, `isWarehouseUnavailable`, `QUERY_OPTS` from `hooks.ts` (export them from hooks.ts if not already; do NOT duplicate the fetch logic). Add `ANALYTICS_KEYS = { scores:['warehouse','analytics','scores'], metrics:[...,'metrics'], growth:[...], anomalies:[...], pm:[...], benchmarks:(period,metric)=>[...,'benchmarks',period,metric], drivers:(id,from,to)=>[...,'drivers',id,from,to] }`. Hooks: `useScores()`, `useMetrics()`, `useGrowth()`, `useAnomalies()`, `usePmScorecards()`, `useBenchmarks(period, metric)`, `useDrivers(propertyId|null, from|null, to|null)` (enabled when propertyId && from && to). Typed response interfaces mirroring the engine shapes above.
- [ ] Extend `useWarehouseInvalidate` (in hooks.ts) to also `invalidateQueries({queryKey:['warehouse','analytics']})` (prefix match drops every analytics query) so approve/override/resolve refresh scores. Keep existing invalidations.
- [ ] Unit-test ONLY pure helpers you add (e.g. response typing has none to test) — if no pure logic, this test file covers `analytics-hooks` re-exports compile; defer real coverage to synthesis.ts. (Skip the test file if there is genuinely nothing pure here; note it.)
- [ ] Commit `feat(intel): analytics query hooks + analytics cache invalidation`.

### Task 1.2 — Synthesis logic (`src/modules/intel/synthesis.ts`) — THE INTELLIGENCE, fully tested
**Files:** Create `src/modules/intel/synthesis.ts` · Test `tests/unit/intel-synthesis.test.ts`

Pure functions that turn engine outputs into the ownership-decision surface. TDD with golden assertions.

- [ ] **Step 1 — failing test** (feed PropertyScore[]/AnomalyFlag[]/SinceAcquisition[] literals):

```typescript
import { rankByAttention, groupByCapitalAction, topRisks, deterioratingProperties, improvingProperties, buildActionList, ATTENTION_ORDER } from '../../src/modules/intel/synthesis';
const score = (id:string, attentionBand:string, capitalAction:string, health:number, q:number|null) =>
  ({ propertyId:id, propertyName:id, period:'2025', health, healthBand:'good', attentionBand, capitalAction, subScores:{}, noiPerSfQuartile:q, reasons:[`r-${id}`] } as any);
it('ranks red→green', () => {
  const r = rankByAttention([score('a','green','hold',70,2), score('b','red','monitor',40,4), score('c','orange','monitor',55,3)]);
  expect(r.map(s=>s.propertyId)).toEqual(['b','c','a']);
});
it('groups by capital action with stable buckets', () => {
  const g = groupByCapitalAction([score('a','green','invest',80,1), score('b','red','disposition-candidate',30,4)]);
  expect(g.invest.map(s=>s.propertyId)).toEqual(['a']);
  expect(g['disposition-candidate'].map(s=>s.propertyId)).toEqual(['b']);
  expect(g.hold).toEqual([]); expect(g.monitor).toEqual([]);
});
it('topRisks ranks critical>high and dedupes per property+kind', () => {
  const risks = topRisks([
    {propertyId:'a',period:'2025',kind:'noi-decline',severity:'critical',detail:'d',metricValue:-0.2},
    {propertyId:'b',period:'2025',kind:'expense-growth',severity:'high',detail:'d',metricValue:0.3},
  ] as any, 5);
  expect(risks[0]!.severity).toBe('critical');
});
it('deteriorating = negative since-acq NOI growth; improving = positive', () => {
  const sa = [{propertyId:'a',noiGrowth:-0.1,comparable:true},{propertyId:'b',noiGrowth:0.2,comparable:true},{propertyId:'c',noiGrowth:null,comparable:false}] as any;
  expect(deterioratingProperties(sa).map(x=>x.propertyId)).toEqual(['a']);
  expect(improvingProperties(sa).map(x=>x.propertyId)).toEqual(['b']);   // null/incomparable excluded from both
});
it('buildActionList yields prioritized, deduped, human actions', () => {
  const actions = buildActionList({
    scores:[score('ray','red','disposition-candidate',40,4), score('np','green','invest',75,1)],
    anomalies:[{propertyId:'ray',period:'2025',kind:'noi-decline',severity:'critical',detail:'NOI −20%',metricValue:-0.2}] as any,
    pm:[{propertyManager:'X',propertyCount:1,smallSample:true,avgNoiPerSf:1,avgNoiGrowth:-0.5,avgExpenseGrowth:0.3}] as any,
  });
  expect(actions[0]!.priority).toBe('high');       // disposition candidate + critical anomaly ranks first
  expect(actions.some(a=>/disposition/i.test(a.text))).toBe(true);
  expect(actions.some(a=>/invest/i.test(a.text))).toBe(true);
  expect(new Set(actions.map(a=>a.text)).size).toBe(actions.length); // deduped
});
```

- [ ] **Step 3 — implement.** `ATTENTION_ORDER = ['red','orange','yellow','green']`; `rankByAttention(scores)`: stable sort by ATTENTION_ORDER index, tiebreak health asc (worse first). `groupByCapitalAction(scores)`: `{invest:[],hold:[],monitor:[],'disposition-candidate':[]}` preserving input order within bucket. `SEVERITY_ORDER=['critical','high','moderate','low']`; `topRisks(anomalies, limit)`: dedupe by `propertyId|kind` keeping worst severity, sort by severity then |metricValue| desc, slice(limit). `deterioratingProperties(sinceAcq)`: filter `comparable && noiGrowth!=null && noiGrowth<0`, sort noiGrowth asc. `improvingProperties`: `comparable && noiGrowth>0`, sort desc. `buildActionList({scores,anomalies,pm})`: emit `{priority:'high'|'medium'|'low', text:string, propertyId?:string}` — high for disposition-candidate or any property with a critical/high anomaly; medium for attention orange or monitor with declining PM; low for invest opportunities & watch-list; dedupe by text; sort priority high→low (stable). Human text e.g. `"Review 9620 Raytown — disposition candidate (bottom-quartile NOI/SF, NOI −20%)"`.

- [ ] **Step 5 — commit** `feat(intel): ownership-decision synthesis (attention ranking, capital grouping, risks, action list)`.

### Task 1.3 — Waterfall chart (`src/charts/Waterfall.tsx`)
**Files:** Create `src/charts/Waterfall.tsx` · Test `tests/unit/waterfall-data.test.ts` (pure layout-prep helper)

ΔNOI driver waterfall: start NOI(A) → signed per-driver bars → end NOI(B). The signature root-cause visual.

- [ ] **Step 1 — failing test** for the exported pure helper `waterfallBars(startValue, drivers, endValue)` → cumulative positions:

```typescript
import { waterfallBars } from '../../src/charts/Waterfall';
it('computes cumulative floating-bar positions; last bar lands on endValue', () => {
  const bars = waterfallBars(100, [{category:'Rev',delta:10},{category:'Ins',delta:-4}], 106);
  expect(bars[0]).toMatchObject({ label:'Start', base:0, top:100, kind:'total' });
  const rev = bars.find(b=>b.label==='Rev')!; expect(rev.base).toBeCloseTo(100); expect(rev.top).toBeCloseTo(110); expect(rev.kind).toBe('pos');
  const ins = bars.find(b=>b.label==='Ins')!; expect(ins.base).toBeCloseTo(106); expect(ins.top).toBeCloseTo(110); expect(ins.kind).toBe('neg');
  const end = bars[bars.length-1]!; expect(end.label).toBe('End'); expect(end.top).toBeCloseTo(106); expect(end.kind).toBe('total');
});
```

- [ ] **Step 3 — implement** `waterfallBars()` (cumulative running total; pos bars rise, neg bars drop, start/end are full-height totals from 0) + the `Waterfall` component: SVG, pos→`--color-pos`, neg→`--color-neg`, totals→`--accent`; value labels (`fmtUsd`), category x-labels (mono, rotated if needed); height prop; renders a "needs 2 periods" empty state if `drivers.length===0`. Tooltip on hover optional. Theme-token colors only.

- [ ] **Step 5 — commit** `feat(charts): ΔNOI waterfall chart (cumulative driver bridge)`.

**PHASE 1 GATE:** `npm run gate` green; `npx vitest run` includes synthesis + waterfall-data tests. No browser yet (no view wired). Spec+quality review subagent on 1.1–1.3.

---

## PHASE 2 — Property Intelligence page (`PropertyIntelView.tsx`)

The per-property "verdict → root cause → recommendation" page. Layout: a property selector (pills or dropdown sourced from `useScores`, ordered by attention), then for the selected property:
- **Verdict header** (Card, gold accent): health score (big `.num`), healthBand Badge, attentionBand Badge (tone: green→green, yellow→gold, orange→amber, red→red), capitalAction Badge, "Scored on FY{period}" label, and the `reasons[]` as a bulleted rationale.
- **KPI row** (KpiStat ×5): NOI (latest FY), NOI margin, NOI/SF (with quartile sublabel "Q{n} of portfolio"), Revenue/SF, Expense ratio. Each with a Sparkline of its annual series where ≥2 points. Ownership overlay: if ownershipPct<1, show `oxfordNoi` as a sublabel ("Oxford share: $X @ {pct}%").
- **Since-acquisition strip**: NOI growth, NOI/SF growth, revenue growth, taxes growth, insurance growth since `anchorPeriod` (label "since FY{anchor}"); `fmtPct` with +/- color; "insufficient history" if not comparable.
- **Trends** (`1fr_320px`): left = BarChart of annual NOI by FY (label `FY2024`/`2026 YTD`, YTD bar tagged); right = expense breakdown BarList (categories, `fmtUsd` display) for the latest FY.
- **Root cause** (Card): the ΔNOI **Waterfall** between the two latest comparable FY periods via `useDrivers`, with a one-line synthesized headline ("NOI {+/-}$X FY{a}→FY{b}; largest driver: {category} {contributionPct}"). "Needs 2 full years" empty state otherwise.
- **Anomalies** (if any for this property): small list with severity Badge + detail.

- [ ] Implement `PropertyIntelView({propertyId, onSelectProperty, scores, metrics, growth, sinceAcquisition})` consuming the hooks; selector via local state lifted to IntelModule (so the tab remembers selection). Guard every null. Use `fmtUsd`/`fmtPct`. No AreaChart.
- [ ] Browser-verify (preview): backfill the worktree warehouse first (`npm run warehouse:backfill`, reads OneDrive READ-ONLY), launch dev, select 55 New Plant (strong) and 9620 Raytown (weak) and 1851 Solar (null SF) — confirm verdict/trends/waterfall render, no console errors, the null-SF property degrades gracefully. Screenshot. **STOP the dev server before finishing (sqlite lock).**
- [ ] `npm run gate` green. Spec+quality review (incl. "verdict-first, not chart-first; matches CloseModule idiom; null-safe").
- [ ] Commit `feat(intel): per-property intelligence page (verdict, $/SF, since-acquisition, driver waterfall, anomalies)`.

---

## PHASE 3 — Ownership Intelligence Center (`OwnershipView.tsx`) — the default home

Answers the 9 ownership questions, action-first. Sections (Cards):
- **Portfolio KPI band**: # properties, portfolio NOI (Σ latest FY noi), Oxford-share NOI (Σ oxfordNoi), # needing attention (orange+red), # disposition candidates.
- **Action list** (TOP, the operating-system core): `buildActionList(...)` rendered as a prioritized checklist with priority Badge + property link (click → switch to Property tab for that id). This is what ownership *does next*.
- **Attention matrix**: `rankByAttention(scores)` as a DataTable (property, attentionBand Badge, health, NOI/SF + quartile, capitalAction Badge, top reason) — row click → Property tab. Red→green.
- **Improving / Deteriorating** (two columns): `improvingProperties`/`deterioratingProperties(sinceAcquisition)` with the NOI growth since acquisition.
- **Capital allocation**: `groupByCapitalAction` summarized — invest / hold / monitor / disposition-candidate counts + property chips.
- **Largest risks**: `topRisks(anomalies, 8)` list with severity Badge.
- **PM performance snapshot**: best/worst manager by avgNoiGrowth from `usePmScorecards` (link to Managers tab); small-sample flagged.

- [ ] Implement `OwnershipView` consuming `useScores/useAnomalies/useGrowth/usePmScorecards/useMetrics`; loading Skeleton; unavailable → reuse offline Card; empty (no committed data) → "No financials ingested yet — see Imports." All clicks route via the lifted selection setter + tab switch.
- [ ] Browser-verify: confirm action list is populated and sensible, attention matrix red→green, links jump to Property tab. Screenshot. Stop dev server.
- [ ] `npm run gate` green. Spec+quality review (explicitly: "does this answer the 9 questions and lead with action, not charts?").
- [ ] Commit `feat(intel): Ownership Intelligence Center (action list, attention matrix, capital allocation, risks, PM snapshot)`.

---

## PHASE 4 — Benchmarks + PM Scorecards

### Task 4.1 — BenchmarksView
- [ ] `BenchmarksView`: a period selector (FY periods present in metrics, default latest FY) + metric selector (the 12 enum keys, default noiPerSf). Renders `useBenchmarks(period, metric)`: a summary strip (avg/median/p25/p75/n via KpiStat or a labeled row) + a `rankings` DataTable (rank, property, value `fmtUsd`/`fmtPct` per metric, quartile Badge tone: 1 green/2 blue/3 amber/4 red/null neutral) + a BarList visual of the ranking. Row click → Property tab. Guard null quartile + empty cohort ("insufficient peers for quartiles").
- [ ] Also include the NOI-by-property matrix here (reuse `groupNoiByProperty`/the existing NoiMatrixTable from overview) so all periods are visible in one place; remove the standalone "overview" tab in P5 IA cleanup.
- [ ] Browser-verify; gate; review; commit `feat(intel): benchmarks view (period/metric selectors, rankings, quartiles, NOI matrix)`.

### Task 4.2 — ManagersView (PM Scorecards)
- [ ] `ManagersView`: `usePmScorecards()` → a DataTable (manager, propertyCount, avgNoiPerSf, avgNoiGrowth `fmtPct` ±color, avgExpenseGrowth, smallSample Badge "small sample" when true). Sort by avgNoiGrowth desc. Header note: "Rankings across few managers/properties — directional, not definitive." (the canon small-n caveat). Null-safe.
- [ ] Browser-verify; gate; review; commit `feat(intel): PM scorecards view (manager performance, small-sample caveat)`.

---

## PHASE 5 — IA integration, polish, gate, design review

- [ ] **Tab reorg** in `IntelModule.tsx`: tabs = `['ownership','property','benchmarks','managers','imports','quality','mappings']`; default `'ownership'`. Labels: Ownership / Property / Benchmarks / Managers / Imports / Data Quality / Mappings. Lift `selectedPropertyId` state to IntelModule (shared by Ownership links → Property tab). Remove the old standalone 'overview' tab (NOI matrix moved into Benchmarks). KpiRow: show portfolio KPIs only on ownership/benchmarks; Property tab shows its own KPIs. Keep the unavailable/loading patterns.
- [ ] **Polish pass**: consistent Card/CardHeader usage, Badge tones, `.num` on every figure, responsive (`preview_resize` mobile + the parchment light theme), reduced-motion respected (existing). No raw hex — tokens only.
- [ ] **Full gate + bundle**: `npm run gate` green; `npm run build && npm run check:bundle` (entry <250kB, route chunk reasonable — report intel chunk gz size).
- [ ] **Browser-verify full module** end-to-end on the backfilled warehouse: all 7 tabs, cross-tab navigation (Ownership action → Property), empty/unavailable states, light+dark, mobile width. Screenshots of Ownership + Property + Benchmarks. Stop dev server.
- [ ] **Design review (the finale):** the controller (not a subagent) runs `mcp__visualize__read_me` then `mcp__visualize__show_widget` to present 2–3 concrete LAYOUT-IMPROVEMENT concepts for the Ownership Center and Property page (e.g., a "morning briefing" hero, a portfolio heat-strip, a single-screen verdict card) as visual mockups + a written critique of the built UI vs. the "operating system, not dashboard" intent — ideas for Gabriel to pick from, not auto-applied.
- [ ] CHANGELOG entry "PFI Phase B.2 — Property Financial Intelligence UI". Commit `docs: changelog for PFI Phase B.2`.
- [ ] **superpowers:finishing-a-development-branch** → push, open PR (stacked on the Phase B branch; note the stack). Do NOT merge.

## Out of scope (later)
Executive AI briefings, PDF/PPTX exports, market benchmarking, lease-run pro formas, intel deep-link routing.

## Self-review
- Intent: Ownership Center is action-first and answers all 9 questions (P3); property page is verdict→cause→recommendation (P2). Not a chart gallery.
- Determinism: synthesis.ts golden-tested (P1.2) — the "intelligence" is verifiable.
- Robustness: pre-mortem items 1–10 each have a named mitigation + test; null-SF / single-period / unavailable explicitly browser-verified.
- No engine/Phase-A change: this phase only ADDS client code + one chart + extends `useWarehouseInvalidate`. Server analytics untouched.
- Reviewed continuously: spec+quality subagent every phase; design review at the end.
