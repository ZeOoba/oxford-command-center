# Portfolio Trends — Wave 3B (Monthly Expense UI + Health Alerts) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show monthly operating expenses for the whole portfolio and for each property — stacked by category, with prior-year comparison, a property × month variance heatmap, small-multiples sorted worst-first, and deterministic "top movers" callouts — and raise health alerts when vacancy, rent or expenses trend badly.

**Architecture:** Built against a **typed contract** (`src/contracts/expenses-monthly.ts`) so it does not wait on the monthly P&L data (Wave 3A produces the real feed; its API conforms to this contract). A pure engine (`src/analytics/expense-trends.ts`) aggregates contract points; two new chart primitives (`StackedBarChart`, `Heatmap`) follow the existing visx chart pattern; a new **Expenses** tab joins Portfolio. Until data exists the tab shows an explicit empty state — never fake numbers. Alerts are added to the single canonical alert engine (`evaluateConditions`) and take the monthly series through `opts` (pure, like `cachedMarketRate`).

**Tech Stack:** TypeScript strict, React, visx, Zod, Vitest/RTL.

## Global Constraints

- **Basis discipline (non-negotiable):** every expense point carries `basis: 'cash' | 'accrual'`. Never sum across bases silently. Today 2 entities are accrual (55 New Plant Ct, 1851 S Club Solar) and the rest cash. The portfolio series must expose `basisMix` and the UI must show a visible `Mixed basis` badge whenever both appear in a sum.
- **Scope:** operating expense only (`classification = 'opex'` from the warehouse mapping). Capex, TI, leasing, debt service, distributions and the `excluded`/`Unmapped` buckets are NEVER part of the expense series. `isInvestmentProperty` only (residence excluded; ruling 2026-09-24).
- **No fabricated data.** No sample/placeholder numbers in shipped UI. Test fixtures are test-only. With no data, render the empty state.
- **Architect-owned files — claim first** in `architecture/status.json` (`review_needed: true`): `src/contracts/` (+ `index.ts`), `server/index.ts`, `package.json`, `scripts/governance-check.ts`. `src/analytics/` is **financial-decision source for `check:refute`** (every commit touching it needs `Refute-Reviewed: wf_<id>` or a justified `Refute-Skip:` in ITS OWN message — plan for it per commit).
- **Alert thresholds** live only in `ALERT_THRESHOLDS` (`src/analytics/conditions.ts`) with alert-specific names; they are NOT governors (DSCR 1.25 / LTV 40 / 65 untouched). Never edit governor constants.
- **UI acceptance requires browser evidence.** In Wave 2, two layout defects and one chart bug passed every jsdom test and were only caught by looking at the running page. Every UI task here ends with a real screenshot at ~800px AND 375px, a console-errors check (`read_console_messages`), and a statement of what was seen. `preview_start` fails in worktrees ("cwd must be a relative path") — start dev servers from Bash with a scratch `WAREHOUSE_DB`, then stop them (`netstat -ano | grep LISTENING | grep :<port>` + `taskkill //PID <pid> //F //T`).
- **Do NOT touch:** `data/overlay.json`, `data/warehouse/finance.sqlite` (live; migrations only, never DDL), `data/snapshots/portfolio.json` (Gabriel's dirty file), `confidential-terms.json`, CORS, the gate (no gate step added or removed without architect + Gabriel approval).
- **Gate:** `npm run gate` green except the known-red `reconcile` step when it recurs (memory `reconcile-cash-history-drift-main`); run later steps by hand. `npm test` can exit `0xC0000005` — rerun. CI hosted runners can be billing-blocked — `CI_RUNNER=self`.
- **Commits:** explicit paths only; trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`; never `--no-verify`.
- House tab cap: ≤ 5 tabs per destination. Portfolio has 2 (`properties`, `trends`); this adds a third.

## Sequencing & contingencies (check at Task 0)

Wave 3A (monthly ledger + API) is blocked on Gabriel's sample P&L files. This plan does not wait for it.

| State at execution | Action |
|---|---|
| 3A not started / unmerged (expected) | Build everything here against the contract + test fixtures. The hook returns "unavailable/empty" → empty state. Nothing is faked. |
| 3A merged and `GET /api/warehouse/analytics/expenses/monthly` exists | Task 1 becomes verify-only (`src/contracts/expenses-monthly.ts` already exists from 3A — conform, do not duplicate); Task 5 can be visually verified against real data. |
| 3A in flight on its own branch | Branch from `origin/main`; if the contract file appears on 3A's branch first, coordinate through `status.json` — one owner of the contract file. |
| Wave 2 recorded history still shallow (1–2 months) | Alerts that need ≥ 3 months of recorded history stay dormant (Task 8 specifies the exact minimum-history guards). |

---

## File structure

- Create `src/contracts/expenses-monthly.ts` (+ one export line in `src/contracts/index.ts`).
- Create `src/analytics/expense-trends.ts` — pure aggregation/variance/movers engine.
- Create `src/charts/StackedBarChart.tsx`, `src/charts/Heatmap.tsx`.
- Create `src/modules/portfolio/expenses-hooks.ts`, `expenses-chart-data.ts`, `ExpensesView.tsx`.
- Modify `src/modules/portfolio/tabs.ts`, `PortfolioDestination.tsx`, `tests/unit/ia-registry.test.ts`.
- Modify `src/analytics/conditions.ts` (+ `src/analytics/types.ts` only if `Insight` needs a new id namespace) for the alert rules.
- Tests: `tests/unit/expenses-contract.test.ts`, `expense-trends.test.ts`, `stacked-bar-chart.test.tsx`, `heatmap.test.tsx`, `expenses-chart-data.test.ts`, `expenses-view.test.tsx`, additions to the conditions test file.

### Task 0: Preflight, branch, claim

- [ ] **Step 1:** `git fetch`; `gh pr list --repo ZeOoba/oxford-command-center --state open`; read `architecture/status.json` for another session's claim on `src/contracts/`, `server/index.ts`, `src/analytics/conditions.ts`. Pick the contingency row above and record it.
- [ ] **Step 2:** `npm run worktree -- add .claude/worktrees/trends-w3b origin/main feat/trends-wave3b` (real `npm install`, no junction).
- [ ] **Step 3:** Add a `trends-wave3b` entry to `architecture/status.json` as a **pure textual append** (a JSON re-serialise rewrote unrelated lines last time — append before the final `}` and verify `git diff` shows 0 removed lines): agent_role, phase, `status: in_progress`, `review_needed: true`, `review_detail` naming `src/contracts/expenses-monthly.ts` (+ index export), and `src/analytics/conditions.ts` (alert rules). Copy this plan into the worktree and commit both separately.
- [ ] **Step 4:** Architect-owned edits need the `.claude/overrides/architect-edit-ok` sentinel in the **worktree** (60-minute TTL). That is Gabriel's sign-off — ask him in-turn before creating it; do not create it unprompted.

### Task 1: Contract `expenses-monthly`

**Files:** Create `src/contracts/expenses-monthly.ts`; Modify `src/contracts/index.ts`; Test `tests/unit/expenses-contract.test.ts`.

**Interfaces — Produces:**
```ts
export const ExpenseBasis = z.enum(['cash', 'accrual']);
export const ExpenseMonthPointSchema = z.object({
  propertyId: z.string().min(1),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  category: z.string().min(1),          // warehouse normalized_category, e.g. 'Repairs & Maintenance'
  amount: z.number().finite(),          // dollars, expense-positive; refunds/credits may be negative
  basis: ExpenseBasis,
  sourceSystem: z.enum(['quickbooks', 'yardi', 'appfolio', 'rent-manager', 'unknown']),
});
export const ExpensesMonthlyResponseSchema = z.object({
  points: z.array(ExpenseMonthPointSchema),
  coverage: z.object({
    propertiesLoaded: z.number().int().nonnegative(),
    propertiesExpected: z.number().int().nonnegative(),
    firstMonth: z.string().nullable(),
    lastMonth: z.string().nullable(),
  }),
});
export type ExpenseMonthPoint = z.infer<typeof ExpenseMonthPointSchema>;
export type ExpensesMonthlyResponse = z.infer<typeof ExpensesMonthlyResponseSchema>;
```
Semantics (pin in the test and in a header comment): opex classification only; amounts are expense-positive; one row per (property, month, category); `coverage` lets the UI say "N of M entities loaded".

- [ ] **Step 1:** Write `tests/unit/expenses-contract.test.ts` — valid point parses; month `2026-13`, empty `propertyId`, non-finite `amount` (`NaN`, `Infinity`) and an unknown `basis` all reject; a response with `points: []` and `coverage` zeros parses; coverage with negative counts rejects.
- [ ] **Step 2:** `npx vitest run tests/unit/expenses-contract.test.ts` → FAIL (module missing).
- [ ] **Step 3:** Implement the file exactly as above; add `export * from './expenses-monthly';` to `src/contracts/index.ts` after confirming no exported-name collision (`Grep` the names across `src/contracts`).
- [ ] **Step 4:** Run the test + `npm run typecheck && npm run lint` → PASS.
- [ ] **Step 5:** Commit `feat(contracts): expenses-monthly contract (Wave 3B)` (explicit paths).

### Task 2: Engine `expense-trends` (pure)

**Files:** Create `src/analytics/expense-trends.ts`; Test `tests/unit/expense-trends.test.ts`. **`src/analytics/` ⇒ the commit needs its own `Refute-` trailer (see Global Constraints).**

**Interfaces — Consumes:** `ExpenseMonthPoint` (Task 1), `MonthKey`/`addMonths`/`monthRange` from `./portfolio-trends`. **Produces:**
```ts
export interface ExpenseMonthTotal { month: MonthKey; total: number; byCategory: Record<string, number> }
export interface PropertyExpenseSeries { propertyId: string; basis: 'cash' | 'accrual'; months: ExpenseMonthTotal[] }
export interface PortfolioExpenseSeries {
  months: ExpenseMonthTotal[];          // sums over supplied properties, per month
  basisMix: { cash: number; accrual: number };   // property counts per basis in the sum
  mixedBasis: boolean;                  // cash > 0 && accrual > 0
}
export interface ExpenseMover { propertyId: string; category: string; month: MonthKey; amount: number; baseline: number; delta: number; deltaPct: number | null }
export function buildPropertySeries(points: ExpenseMonthPoint[], propertyId: string): PropertyExpenseSeries | null;
export function buildPortfolioSeries(points: ExpenseMonthPoint[], propertyIds: readonly string[]): PortfolioExpenseSeries;
export function trailingAverage(series: ExpenseMonthTotal[], endMonth: MonthKey, window: number): number | null;   // mean of the `window` months BEFORE endMonth; null unless all `window` months present
export function varianceVsTrailing(series: ExpenseMonthTotal[], month: MonthKey, window?: number): { amount: number; baseline: number; delta: number; deltaPct: number | null } | null;  // window default 12
export function topMovers(points: ExpenseMonthPoint[], propertyIds: readonly string[], month: MonthKey, limit?: number): ExpenseMover[];   // by |delta| vs the same category's trailing-12 mean; limit default 5
export function sameMonthLastYear(series: ExpenseMonthTotal[], month: MonthKey): ExpenseMonthTotal | null;
```
Rules: points for ids outside `propertyIds` are ignored; a property with mixed bases across its own points → `buildPropertySeries` returns the basis of the majority and the engine records no silent mixing (a property's basis is expected constant — if not, throw `Error('mixed basis within property <id>')` and test it; the caller shows the property as unavailable); `deltaPct` is `null` when baseline is 0; `trailingAverage` requires a full window (never a partial mean); `topMovers` ignores categories with fewer than 12 prior months and ties break on `propertyId` then `category` ascending; negative amounts (credits) are included in totals as-is.

- [ ] **Step 1: Write the failing tests** with hand-computed values. Fixture (reuse in every test): property `A` cash, months `2025-01`…`2026-02` (14 months) where category `Utilities` = 100/month except `2026-02` = 160 and `Insurance` = 50/month; property `B` accrual, `2026-01..2026-02` only, `Utilities` 40. Assertions: (a) `buildPropertySeries(A)` month `2026-02` total 210, `byCategory` `{Utilities:160, Insurance:50}`; (b) `buildPortfolioSeries(['A','B'])` `2026-02` total 250, `basisMix {cash:1, accrual:1}`, `mixedBasis: true`; `['A']` alone → `mixedBasis: false`; (c) `trailingAverage(A.months,'2026-02',12)` = mean of the 12 months `2025-02..2026-01` = 150 (Utilities 100 + Insurance 50 each) and `null` for window 13 with only 13 prior... compute exactly and assert; `null` when a month inside the window is missing (delete one month from a copy); (d) `varianceVsTrailing(A.months,'2026-02')` → `{amount:210, baseline:150, delta:60, deltaPct:0.4}`; baseline 0 → `deltaPct:null`; (e) `topMovers(points,['A','B'],'2026-02')` returns A/Utilities first (delta 60) and excludes B (fewer than 12 prior months); (f) `sameMonthLastYear(A.months,'2026-02')` returns the `2025-02` total (150); `null` when absent; (g) points for property `C` not in `propertyIds` change nothing; (h) mixed-basis property → throws; (i) empty input → empty series, `mixedBasis:false`.
- [ ] **Step 2:** `npx vitest run tests/unit/expense-trends.test.ts` → FAIL.
- [ ] **Step 3:** Implement per the rules (pure; no `Date.now()`; use `monthRange`/`addMonths` for month math).
- [ ] **Step 4:** Test + `npm run typecheck && npm run lint` → PASS.
- [ ] **Step 5:** Commit `feat(analytics): monthly expense trend engine` with a `Refute-Skip:` or `Refute-Reviewed:` trailer in THIS commit's message (read-only reporting; no consumer in any scoring, verdict or capital-allocation path — state it truthfully and, if an adversarial review ran, cite it).

### Task 3: Chart primitives — `StackedBarChart` and `Heatmap`

**Files:** Create `src/charts/StackedBarChart.tsx`, `src/charts/Heatmap.tsx`; Tests `tests/unit/stacked-bar-chart.test.tsx`, `tests/unit/heatmap.test.tsx`.

**Interfaces — Produces:**
```ts
export interface StackedBarDatum { label: string; segments: Array<{ key: string; value: number }> }
interface StackedBarProps { data: StackedBarDatum[]; keys: string[]; height?: number; valueFormat?: (n: number) => string; ariaLabel?: string;
  overlay?: Array<{ label: string; value: number }>;   // optional line (e.g. same month last year) drawn over the bars
}
export interface HeatCell { row: string; col: string; value: number | null }   // null = no data (drawn hatched/empty, never zero)
interface HeatmapProps { cells: HeatCell[]; rows: string[]; cols: string[]; height?: number; valueFormat?: (n: number) => string; domain?: [number, number]; ariaLabel?: string }
```
Template: read `src/charts/BarChart.tsx` (post-#424 diverging support), `Sparkline.tsx`, `theme.ts` and the token names in `src/tokens` — reuse them; do NOT invent colour tokens. Segment colours: a fixed ordered palette from existing tokens, assigned by `keys` order so a category keeps its colour across charts. Heatmap colour: sequential from a neutral to the alert/negative token for values above 0 and the positive token below 0 (variance vs trailing); `null` cells render with a visible "no data" pattern or muted fill distinct from a zero value.

- [ ] **Step 1: Write failing tests** (mock `@/lib/useMeasure` to a fixed width as `bar-chart` tests do — read that test first): StackedBarChart: one `<rect>` per non-zero segment; each stack's total height equals the sum of its segments scaled; **no rect has a negative height**; negative segments (credits) render below the baseline, not as negative rects; empty `data` and a single bar don't throw; `overlay` draws a path with one point per overlay entry; heatmap: one cell element per `rows × cols` combination, `null` cells carry a distinguishable attribute/class (assert it differs from a zero cell), value labels via `valueFormat`, `domain` clamps the colour scale, `ariaLabel` set.
- [ ] **Step 2:** Run both → FAIL.
- [ ] **Step 3:** Implement. Keep each file focused; no shared mutable state.
- [ ] **Step 4:** Tests + `npm run typecheck && npm run lint` pass.
- [ ] **Step 5 (browser acceptance):** render each in a throwaway harness route or the Task 5 view with fixture data and look at it: stacked totals correct, no console errors (`read_console_messages` — the Wave 2 bug was `<rect> attribute height: A negative value is not valid`), legible at 375px. Record what you saw.
- [ ] **Step 6:** Commit `feat(charts): StackedBarChart and Heatmap primitives`.

### Task 4: Data hook and chart-data mappers

**Files:** Create `src/modules/portfolio/expenses-hooks.ts`, `src/modules/portfolio/expenses-chart-data.ts`; Tests `tests/unit/expenses-chart-data.test.ts`.

**Interfaces — Consumes:** Task 1 contract; Task 2 engine; Task 3 datum types; `fetchParsedOrMirror`, `QUERY_OPTS`, `isWarehouseUnavailable` from `src/modules/intel/hooks.ts` (mirror `src/modules/portfolio/trends-history.ts`'s `useTrendsHistory`). **Produces:**
- `useExpensesMonthly()` — TanStack query on `/api/warehouse/analytics/expenses/monthly` parsed with `ExpensesMonthlyResponseSchema`; key rooted at `['warehouse','analytics','expenses','monthly']`; errors surface (no swallowing) — the consumer maps `isWarehouseUnavailable` to the empty state.
- `stackedExpenseData(series: ExpenseMonthTotal[], keys: string[]): StackedBarDatum[]`; `topCategories(points, propertyIds, n): string[]` (by trailing-12 total, rest folded into `Other`, order stable and deterministic); `heatmapCells(points, propertyIds, months, window?): HeatCell[]` (value = `varianceVsTrailing(...).deltaPct`, `null` when baseline unavailable); `moverLines(movers: ExpenseMover[], propertyNames: Record<string,string>): string[]` (human sentences, e.g. `Utilities at 1100 Rarig +$60 (+40%) vs trailing 12 mo`).
- [ ] **Step 1–5:** failing tests with hand-computed values for each mapper (fold-to-`Other`, stable ordering on ties, `null` cells, sentence formatting incl. negative deltas and `null` percent) → implement → pass → commit `feat(trends): expense data hook and chart mappers`.

### Task 5: `ExpensesView` — the Expenses tab

**Files:** Create `src/modules/portfolio/ExpensesView.tsx`; Modify `src/modules/portfolio/tabs.ts` (`'properties' | 'trends' | 'expenses'`), `PortfolioDestination.tsx`, `tests/unit/ia-registry.test.ts` (portfolio tab set); Test `tests/unit/expenses-view.test.tsx`.

Behavior (each needs a test; mock `useExpensesMonthly` and the snapshot like `tests/unit/portfolio-trends-view.test.tsx`):
1. **Empty / unavailable:** hook error with `isWarehouseUnavailable`, or `points: []` → a single explanatory Card ("Monthly P&L data has not been loaded yet") — no charts, no zeros, no error banner. `coverage.propertiesLoaded < propertiesExpected` with data → a visible "N of M entities loaded" badge and the portfolio total labelled partial.
2. **KPI strip:** latest-month portfolio opex, MoM %, YoY same-month %, and trailing-12 average — each `null` → `—` (never `0`). Use `KpiStat`; **long explanatory text goes in captions beneath the card, never in `KpiStat`'s `sublabel`** (it renders one character per line next to the delta — a Wave 2 regression).
3. **Stacked monthly bars** by top-8 categories + `Other`, with a prior-year overlay line (`sameMonthLastYear`). Mixed-basis → a visible `Mixed basis (cash + accrual)` badge on the card (Global Constraints).
4. **Property × month heatmap** of opex variance vs own trailing-12 average (rows = loaded properties sorted by latest variance descending, cols = last 12 months); `null` cells distinct from zero.
5. **Small-multiples:** one card per loaded property with a `Sparkline` of monthly opex, latest value, YoY %, sorted worst-first (largest positive variance first); a property whose own basis is mixed (engine throws) renders as "unavailable — mixed basis" and is excluded from totals.
6. **Top movers** list (≤5 sentences from `moverLines`).
7. **Scope selector** (portfolio or one property) — one property shows its stacked categories + its own mover lines; reuse the effective-scope fallback pattern from `TrendsView` so a vanished property id reverts to portfolio.
8. All hooks above every early return (rules of hooks); numbers formatted through `src/analytics/format.ts` helpers.
- [ ] **Step 1:** failing tests for 1–7.
- [ ] **Step 2:** run → FAIL.
- [ ] **Step 3:** implement; `PORTFOLIO_TABS` gains `{ id: 'expenses', label: 'Expenses' }`; lazy panel in `PortfolioDestination`.
- [ ] **Step 4:** `npx vitest run tests/unit/expenses-view.test.tsx tests/unit/portfolio-trends-view.test.tsx tests/unit/ia-registry.test.ts tests/unit/portfolio-module-other-holdings.test.tsx`, typecheck, lint.
- [ ] **Step 5 (browser acceptance — mandatory):** with no Wave 3A data, verify the empty state at 800px and 375px. To see the populated layout, use a **temporary, uncommitted** local mock of `/api/warehouse/analytics/expenses/monthly` (e.g. a throwaway Hono route or MSW-style stub under `.superpowers/`, never committed) feeding fixture points; screenshot desktop and 375px; confirm all KPI tiles are equal height, no one-character-per-line text, heatmap and stacks legible, `read_console_messages` clean. Describe what you saw. Remove the stub.
- [ ] **Step 6:** commit `feat(trends): Portfolio > Expenses tab`.

### Task 6: Alert rules (architect + refute path)

**Files:** Modify `src/analytics/conditions.ts` (+ `src/analytics/types.ts` if a new insight id prefix is needed); Test: the existing conditions test file (find it with `Grep tests/unit -l evaluateConditions`).

Rules — all `Insight`s from `evaluateConditions`, fed through **new optional fields on `EvaluateOpts`** so the function stays pure and existing callers/tests are unchanged:
- `opts.monthSnapshots?: Array<{ propertyId; month; leasedSf; totalSf; inPlaceRent }>` (the Wave 2 recorded series) and `opts.expenseSeries?: PropertyExpenseSeries[]` (Task 2).
- **Vacancy rising:** a property's recorded vacancy (`1 − leasedSf/totalSf`) increases in two consecutive recorded months AND the latest is ≥ `ALERT_THRESHOLDS.vacancyRiseMinPts` points above two months earlier. **Requires ≥ 3 consecutive recorded months** — with fewer it emits nothing (Wave 2 history starts at one month; the rule is dormant until then and must not guess).
- **Rent down MoM:** recorded in-place rent decreases month over month by ≥ `rentDropWarnPct`, both months recorded and consecutive.
- **Opex spike:** latest month's property opex ≥ `opexSpikeWarnPct` above its own trailing-12 mean (`varianceVsTrailing`); requires a full window; one Insight per property; credits/negative baselines never divide by zero.
Constants added to `ALERT_THRESHOLDS` with alert-specific names: `vacancyRiseMinPts`, `rentDropWarnPct`, `opexSpikeWarnPct` — pick values with Gabriel (ask via `AskUserQuestion`; recommended defaults to propose: 2.0 points, 3%, 25%) — and a one-line comment each. Insight `id`s are stable per (rule, property, month) so dedup works; severity `warning` for all (none is lender-remedy territory); detail strings state the basis and the months compared.
- [ ] **Step 1:** failing tests per rule: fires on the hand-built sequence; silent with 2 recorded months; silent when a month is missing from the sequence (non-consecutive); opex rule silent without a full trailing window; baseline 0 → silent; ids stable across two evaluations; existing alert tests unchanged (run the whole conditions test file).
- [ ] **Step 2–4:** red → implement → green; typecheck/lint.
- [ ] **Step 5:** wiring: **do not** wire the new `opts` into any caller in this task. A follow-up task (Task 7) does that so a rule can be reviewed before it can fire in production.
- [ ] **Step 6:** commit with a `Refute-` trailer in its own message (alerts reach Gabriel's inbox; run the `adversarial-reviewer` agent with an explicit `model` — never below the implementer — before attesting; if an alert could feed a risk-$ total, use the `refute-financial-change` workflow instead).

### Task 7: Wire alerts to real inputs (separate, reviewable)

**Files:** callers of `evaluateConditions` (`Grep -rn "evaluateConditions" src server`) — typically the client `buildAnalytics` and the server brief/alert producers.

- [ ] **Step 1:** list every caller; for each decide whether the monthly inputs are available there (client: recorded history via `useTrendsHistory` and `useExpensesMonthly`; server: `monthSnapshotSeries` and the 3A series). Do NOT add a caller that cannot supply them.
- [ ] **Step 2:** thread `monthSnapshots`/`expenseSeries` through the minimum callers; with the inputs absent behavior is byte-identical (test it).
- [ ] **Step 3:** a dry run on the live workbook (scratch DB; never the live warehouse) — report how many Insights each new rule produces today. With one recorded month, the vacancy and rent rules must produce **0**; if any produces more, stop.
- [ ] **Step 4:** commit; adversarial review as in Task 6.

### Task 8: Final verification and PR

- [ ] Focused tests for every file above; `npm run gate` (known-red `reconcile` aside; run later steps by hand).
- [ ] `adversarial-reviewer` (explicit `model`) on the whole branch: basis mixing anywhere in sums, empty-state truthfulness, partial-coverage labelling, alert false-positive/false-negative on sparse history, tie to the contract.
- [ ] Browser evidence again on the final head (800px + 375px + console).
- [ ] Push and open the PR **only with Gabriel's go-ahead**; add `Refute-` trailers per commit (`check:refute` locally: `npx tsx scripts/check-refute-required.ts --strict --base=origin/main --head=$(git rev-parse HEAD)`); squash message carries the union of trailers.

---

## Self-review

- **Coverage:** monthly expenses portfolio + per property ✔ (T2/T5), stacked categories ✔, YoY overlay ✔, heatmap ✔, small-multiples ✔, movers ✔, health alerts for vacancy/rent/expense ✔ (T6), data-agnostic until 3A ✔, basis discipline ✔ (contract, engine `basisMix`, UI badge).
- **Known dependencies:** real data from Wave 3A; alert thresholds need Gabriel's values; recorded vacancy/rent history needs ≥ 3 months (rules stay dormant meanwhile).
- **Placeholder scan:** chart-primitive SVG bodies are not reproduced (the implementer must read `BarChart.tsx` and follow it); all behavior, interfaces and test cases are specified. Everything else shows its code or its exact expected values.
- **Out of scope:** the monthly ledger, parsers and tie-out (Wave 3A); an Overview widget (deferred).
