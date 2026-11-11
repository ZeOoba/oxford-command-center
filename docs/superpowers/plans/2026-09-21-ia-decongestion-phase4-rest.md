# IA Decongestion — Rest of Phase 4 (rail 21 → 12) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Finish the ratified rail consolidation — 21 sidebar items today → 12 two-level destinations — by composing the remaining modules into Capital, Obligations, Market, Leasing and Brain, with every old URL still resolving.

**Architecture:** Phase 4a built the mechanism (`ModuleDef.tabs`, `LEGACY_ALIASES`, `LEGACY_TAB_ALIASES`, `resolveLegacyRoute`, generic `<Destination>`). Each remaining PR either mounts absorbed modules as tabs (`<Destination>` for a brand-new destination; edit-in-place where a module already owns its tab strip) and demotes each absorbed module's own tab strip to a `SegmentedControl` on `?view=` (R5 — never a second tab strip). One shared-plumbing PR comes first because Capital is the first destination that hosts **two** entity drawers (loan + cash entity) and the current router can only map one entity type per module.

**Tech Stack:** React 18, react-router-dom v6, react-aria-components 1.18.0 (locked), Vitest + Testing Library, Playwright e2e. No contracts, migrations, warehouse or governor code is touched.

## Global Constraints

Copied from `2026-09-18-ia-decongestion-tabs.md` §1/§2b (ratified 2026-09-18) — every task inherits them.

- **`?tab=` is the tab URL mechanism. Never a path segment** — segment 2 of the path is the entity id (`/debt/<loanId>`).
- **Max 5 tabs per destination** (`MAX_TABS_PER_DESTINATION`, enforced by `tabCapViolation` + `ia-registry.test.ts`).
- **R5: no nested tab strips.** An absorbed module's own strip becomes `SegmentedControl` + `useTabParam(keys, default, 'view', …)`.
- **Every legacy module id keeps resolving** (`LEGACY_MODULE_IDS` fixture in `tests/unit/ia-registry.test.ts`, 26 ids). Aliases redirect with `replace`, preserve every other query param, and preserve entity-id path segments.
- **Rule G (new, this plan): a whole-module offline/loading early-return inside an absorbed module must be scoped to that module's own panel — never the destination.** Debt, Cash, Close, Digest, Insights, Tenants read the snapshot and work on the static mirror; Allocation/Brain-report/Forecast read warehouse routes that 503 there.
- **Rule H (new): `?view=` never leaks across tabs** — switching a destination tab clears `view`.
- Default tab = first tab; no default tab renders a table > 8 rows unless it is the module's whole point.
- No Architect-owned file is touched (`src/contracts/`, `server/warehouse/`, `package.json`, `server/index.ts`, `scripts/governance-check.ts`). `src/brain/routing.ts`, `src/shell/*`, `src/modules/*`, `src/lib/*` are UX-owned.
- Gate: `npm run gate` green on every commit (7 steps; rerun on the known intermittent `0xC0000005` — see memory `npm-test-intermittent-access-violation`). `npm run check:bundle` (< 250 kB gzip entry). Never `--no-verify`.
- Attribution on commits: `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`; PR bodies end `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.

---

## Execution record (as built, 2026-09-21) — read this before trusting the task text below

Executed subagent-driven on the stacked branches `feat/ia-p4-a-plumbing` → `-b-capital` → `-c-obligations-market` → `-d-leasing` → `-e-brain` → `-f-finalize` (one worktree, `.claude/worktrees/ia-p4`). Each PR was gated (`npm run gate` green, `check:bundle` entry ≈ 93 kB, `check:refute` clean). **Not pushed / not merged** — merge order A → F, each rebased on the previous. Where the task text below and the code disagree, **the code is right**; the deviations found in review were:

1. **`entityHref` same-module rule (Task 1) was wrong as written.** "Same-module: leave tab/view untouched" broke the loan/cash drawers on non-matching Capital tabs (`/capital?tab=cash` → loan opened as a `cashEntity`, or no drawer at all). As built: same-module keeps the tab **only if the current tab already hosts the entity type** (`TAB_PRIMARY_TYPE[module][tab] === type` or `MODULE_PRIMARY_TYPE[module] === type`); otherwise it switches to `HOME_TAB[type]` and drops `view`. Single-type destinations (Leasing/lease, Obligations/insurance, Acquisitions/deal) therefore never flip tabs. `HOME_TAB` has an exhaustive `toEqual` lock in `tests/unit/entity-routing-tabs.test.ts` — extend it whenever a destination adds an entity home.
2. **Divergent-predicate bug (Capital Task 4, Brain Task 13).** TanStack Query v5 keeps `data` when a refetch fails, so a header/badge gated on `data &&` shows a stale figure above a panel gated on `error || !data`. Both fixed by deriving header/badge and panel from ONE predicate (`usable` in `CapitalModule`; `isWarehouseUnavailable(report.error)` shared by the Brain badge and `ReportGate`). **Rule G corollary: any header/badge/count that summarises a warehouse-backed panel must use the same predicate as that panel's offline gate.** Both have retained-data regression tests.
3. **Leasing lost its R4 badge (Task 10)** — the old red overdue-count on the Leases "Rollover" tab label cannot ride on a `SegmentedControl` option. Restored on the destination's **Rent roll** tab via `useCriticalDatesTabBadge` (Spine-A `criticalDates` with `daysToDate < 0`, same definition as `cdOverdue`), wired through `ModuleTabDef.useBadge`.
4. **Task 11 (repoint Overview KPI links) was skipped on purpose.** `goTo('debt' | 'cash' | 'leases')` resolves through the alias table to a *specific tab* (`/capital?tab=debt`, `?tab=cash`, `/leasing?tab=rent-roll`); repointing to `goTo('capital' | 'leasing')` would land on the default tab and lose that. The alias hop is a single `replace` navigation and is invisible.
5. **`Destination` `header` prop (Task 2) was removed in PR-F** — no consumer (Capital/Leasing/Brain/Market went in-place, not via `<Destination>`). Only Worklist and Obligations use `<Destination>`.
6. **PR-F extras:** `src/shell/titles.ts` extracted from `AppShell` (TopBar page titles) and swept to registered ids, with a guard test; `lease-market` was added to both `MODULE_ORDER` lists (it had been relying on the append-unlisted fallback).
7. **e2e cases (Capital, Obligations, Market, Leasing, Brain, plus the retargeted rent-roll/a11y specs) are written, typechecked and linted but UNVERIFIED in a browser** — Playwright's Chromium build 1223 is not installed here (1194 is). Run `npx playwright install chromium` then `npm run test:e2e` before merging. Also: the first four existing smoke tests `goto('/?still=1')` and expect the Overview, while `PROFILE_HOME.acquisitions` is `pipeline` — likely pre-existing staleness, unconfirmed.
8. Accepted tradeoffs (plan-mandated): inactive `?view=` panels unmount, so `DataTable` sort resets when switching views (Debt Positions/Maturities, Leases Rent roll/Critical dates); arrowing across a `SegmentedControl` mounts each view in turn (RAC radio roving selects), so the old `keyboardActivation="manual"` guard doesn't apply to inner views.
9. Minor, not fixed: relocated Brain cards inside `ReportGate` are still titled "Command Brain" (rail label is now "Brain"); `CapitalModule` relocated JSX keeps its pre-move indentation (kept for a verbatim-audit diff) — a whitespace-only prettier pass would fix it; the `leasing-destination` test stubs `useAnalytics` file-wide.

## 0. Ground truth (verified 2026-09-21 against origin/main `4525609`)

- **Registered today (22 incl. off-rail Health; 21 on the rail):** overview, principal, pipeline, worklist ✅, insights, command-brain, portfolio, intel ✅(Financials), leases, leasing, prospect-demand, tenants, capital, debt, cash, close, insurance, taxes, market, lease-market, data ✅, health (off-rail ✅). (`src/shell/modules.tsx`)
- **Done:** P0 #337 · P1 #340 · P2 #342 · P3 #343 (incl. the Acquisitions split — Pipeline · Workbench · Sourcing · Grader; §2b correction 2 is resolved) · P4a #345 (Worklist, Data, Financials 8→5, Health dot, alias table).
- **The source handoff (`IA_RESTRUCTURE_PROMPT.md`) is not on disk** (searched `Downloads`, `Documents`, OneDrive). The plan text pins only: 12 rail items, Capital = Allocation · Debt · Cash · Close, Brain absorbs Principal (`· Digest`), Lease Market stays its own item, Leasing default = Expiries/Rollover. **Every other placement below is inferred from code and tagged `[INFERRED]` — confirm at PR review.**
- Two modules already document this plan in their headers: `CapitalModule.tsx:20` ("will become Allocation · Capacity · Debt · Cash · Close") and `LeaseForecastModule.tsx:9-10` ("will later absorb Rent Roll / Tenants tabs under a <=5-tab cap").

## 1. Target rail (12) and placement table

| # | Rail item (module id) | Group | Tabs (default first) | Absorbs (legacy id → tab) | Confidence |
|---|---|---|---|---|---|
| 1 | Overview (`overview`) | Command | — | — | pinned |
| 2 | Acquisitions (`pipeline`) | Command | Pipeline · Workbench · Sourcing · Grader | — (done P3) | pinned |
| 3 | Worklist (`worklist`) ✅ | Command | Today · Alerts · Calendar · Renewals | done 4a | pinned |
| 4 | **Brain (`command-brain`)** | Command | **Digest · Insights · Track record · Feedback · Memory** | `principal`→digest, `insights`→insights; `Versions` tab → Memory `?view=versions` | Digest pinned; Insights `[INFERRED]` |
| 5 | Portfolio (`portfolio`) | Assets | — | — | pinned |
| 6 | Financials (`intel`) ✅ | Assets | Ownership · Property · Lease Run · Benchmarks · Managers | done 4a | pinned |
| 7 | **Leasing (`leasing`)** | Assets | **Rollover · Rent roll · Forecast · Market rents · Tenants** | `leases`→rent-roll (its Rent roll/Rollover become `?view=`), `tenants`→tenants | Rollover-default pinned; Tenants `[INFERRED]` |
| 8 | **Capital (`capital`)** | Capital | **Allocation · Pipeline · Debt · Cash · Close** | `debt`→debt, `cash`→cash, `close`→close | pinned (Pipeline is today's 2nd tab; it becomes Capacity when `2026-09-18-capital-deployable-capacity.md` lands) |
| 9 | **Obligations (`obligations`, new)** | Capital | **Insurance · Taxes** | `insurance`→insurance, `taxes`→taxes | name pinned; contents `[INFERRED]` — they're the only Capital-group modules Capital's 4 tabs don't take |
| 10 | **Market (`market`)** | Market | **Macro · Scorecards · Comps · Demand** | `prospect-demand`→demand | `[INFERRED]` ("Demand Signals" is external demand data) |
| 11 | Lease Market (`lease-market`) | Market | Portfolio · Market rents · Radar · Changes · Data quality | — | pinned (Gabriel 2026-09-18) |
| 12 | Data (`data`) ✅ | System | Imports · Quality · Mappings · Calibration · Documents | done 4a | pinned |
| — | System Health (`health`) | (off-rail) | — | TopBar dot ✅ | pinned |

Count check: 4 Command + 3 Assets + 2 Capital + 2 Market + 1 System = **12**.

**Decisions for Gabriel** (all reversible; PRs are ordered so the `[INFERRED]` ones ship last-and-independently):
- **D1** — confirm the four `[INFERRED]` placements (Insights→Brain, Tenants→Leasing, Insurance+Taxes→Obligations, Demand→Market). Alternative for Demand: Leasing (but that makes Leasing 6 tabs — over cap).
- **D2** — Brain hits 6 tabs if Versions stays a tab (Digest, Insights, Track record, Feedback, Memory, Versions). Plan default: **Versions becomes a `?view=` switch inside Memory** (both are "what the brain knows"). Alternative: keep Insights its own rail item (rail becomes 13).
- **D3** — Leases' inner "Rollover" (a critical-dates timeline: notice deadlines / expirations / escalations) collides in name with Leasing's own "Rollover" tab (expiry buckets + velocity). Plan default: keep the `?view=rollover` **key** (old deep links) but relabel the segment **"Critical dates"**.

## 2. Sequencing

```
PR-A plumbing ──► PR-B Capital ──► PR-C Obligations + Market ──► PR-D Leasing ──► PR-E Brain ──► PR-F finalize
```
PR-A must merge first. B–E are logically independent but all edit `routing.ts`, `modules.tsx`, `tests/unit/ia-registry.test.ts` — serialize them and rebase each on the previous. PR-F is the only PR that asserts the final 12.

**Working setup per PR** (CLAUDE.md §0/§5): fresh worktree off current `origin/main` (`git fetch && git worktree add .claude/worktrees/ia-p4-<x> -b feat/ia-p4-<x> origin/main`); declare it in `architecture/status.json` (shared-infra rule); `data/snapshots/portfolio.json` is another writer's dirty file — never stage it; stage explicit paths only. Removing a worktree whose `node_modules` is a junction: `rmdir` the junction FIRST (memory `node-modules-junction-footgun`).

## 3. Pre-flight failure modes (assume each will happen)

1. **Capital's early returns block Debt/Cash/Close** (`CapitalModule.tsx:239-251` returns a skeleton/"warehouse offline" card *before* the tab strip). Left as-is, the static mirror shows a dead Capital page and Debt/Cash/Close are unreachable. → Task 4 moves the gates inside the two warehouse-backed panels; test asserts Debt renders with the capital queries failing. **Same trap in Brain** (`CommandBrainModule.tsx:112-130`) → Task 13; and Leasing forecast → Task 10.
2. **Entity drawer breaks on absorption.** `MODULE_PRIMARY_TYPE` is `moduleId → one EntityType`; Capital hosts `loan` *and* `cashEntity`. `/debt/borrower-restoration` → alias → `/capital/borrower-restoration?tab=debt` must open the loan drawer *on first render* (before the AppShell replace-redirect lands). → Task 1 (tab-aware `parseRoute` that also honors the alias's tab on first render).
3. **`?tab=` / `?view=` collisions.** `openEntity` currently appends the *current* `search`, so a stale `?tab=` from another module rides along (`/leases/x?tab=calendar`); once destinations share tab ids (`pipeline` exists in Capital and Acquisitions) a stale value becomes *valid-but-wrong*. → Task 1 `entityHref` clears `tab`/`view` on a cross-module jump and never yanks the tab on a same-module jump (Tenants → lease drawer must not flip the user to Rent roll behind the drawer).
4. **e2e hard-codes the rail label.** `tests/e2e/smoke.spec.ts:33` and `a11y.spec.ts:14` click `button { name: 'Leases' }` and expect "Rent Roll". After PR-D that button is "Leasing" and the default tab is Rollover. → Task 12.
5. **Deleted tab key = broken deep link.** `command-brain?tab=versions` becomes `memory` + `view=versions`; `LEGACY_TAB_ALIASES` currently can't set `view`. → Task 13.
6. **Profile landing.** `PROFILE_HOME.principal = 'principal'` (Eric's landing) dies with the `principal` module id; `module-order.test.ts:11` pins it. → PR-E/PR-F.
7. **Force-mounted panels vanish.** Debt's Positions/Maturities panels use `FORCE_MOUNT_PANEL` so the loan-table sort survives a round trip; a `SegmentedControl` conditional render drops that. Accepted tradeoff (sort resets on switching view); tests that asserted inert panels are rewritten.
8. **Bundle.** Absorbed modules must stay `lazy()` inside their tab panel (the registry imports only React-free `tabs.ts` files, per the `intel/tabs.ts` pattern) so the entry chunk doesn't grow; `check:bundle` is the proof.

## 4. File structure

| File | Responsibility | PR |
|---|---|---|
| `src/brain/routing.ts` | `TAB_PRIMARY_TYPE`, `HOME_TAB`, `entityHref`, tab-aware `parseRoute`, `LEGACY_TAB_ALIASES.view`, new `LEGACY_ALIASES` rows | A–E |
| `src/brain/UiProvider.tsx` | pass `?tab=` to `parseRoute`; `openEntity` uses `entityHref` | A |
| `src/lib/useTabParam.ts` | `clearOnChange` option + `CLEAR_VIEW` | A |
| `src/shell/Destination.tsx` | optional `header`, clears `?view=` on tab change | A |
| `src/modules/{capital,leasing,market,command-brain,obligations}/tabs.ts` | React-free tab declarations (palette-indexable) | B–E |
| `src/modules/obligations/ObligationsModule.tsx` | new `<Destination>` (Insurance · Taxes) | C |
| `src/modules/command-brain/{ReportGate,BrainPanels}.tsx` | scoped report gate + the four report panels moved verbatim | E |
| `src/shell/modules.tsx`, `src/shell/module-order.ts` | registry rows, rail order, `PROFILE_HOME` | B–F |
| `tests/unit/*` | see each task | A–F |

---

## PR-A — Shared plumbing (no visible change)

### Task 1: Tab-aware entity routing

**Files:**
- Modify: `src/brain/routing.ts` (lines 10-28 maps; 114-129 `parseRoute`; 131-134 `entityPath`)
- Modify: `src/brain/UiProvider.tsx:23-26` and `:51`
- Test: `tests/unit/entity-routing-tabs.test.ts` (create)

**Interfaces:**
- Produces: `TAB_PRIMARY_TYPE: Readonly<Record<string, Readonly<Record<string, EntityType>>>>` (empty until PR-B) · `HOME_TAB: Readonly<Partial<Record<EntityType, string>>>` (empty until PR-B) · `parseRoute(pathname: string, knownModuleIds: readonly string[], tab?: string | null, tabTypes?: typeof TAB_PRIMARY_TYPE): RouteState` · `entityHref(ref: EntityRef, search: string, fromModuleId: string, homes?: { module: Record<EntityType, string>; tab: Partial<Record<EntityType, string>> }): string`.

- [ ] **Step 1: Write the failing test** — `tests/unit/entity-routing-tabs.test.ts`

```ts
import { describe, it, expect } from 'vitest';
import { parseRoute, entityHref } from '../../src/brain/routing';
import type { EntityType } from '../../src/brain/ui-context';

const IDS = ['capital', 'pipeline', 'portfolio', 'worklist', 'overview'];
const TAB_TYPES = { capital: { debt: 'loan', cash: 'cashEntity' } } as const;
const HOMES = {
  module: { property: 'portfolio', lease: 'leasing', loan: 'capital', cashEntity: 'capital', insurance: 'obligations', counterparty: 'overview', deal: 'pipeline' } as Record<EntityType, string>,
  tab: { loan: 'debt', cashEntity: 'cash' } as Partial<Record<EntityType, string>>,
};

describe('parseRoute — tab-aware entity type', () => {
  it('a destination hosting two drawers picks the type from ?tab=', () => {
    expect(parseRoute('/capital/l1', IDS, 'debt', TAB_TYPES).selected).toEqual({ type: 'loan', id: 'l1' });
    expect(parseRoute('/capital/a1', IDS, 'cash', TAB_TYPES).selected).toEqual({ type: 'cashEntity', id: 'a1' });
  });
  it('no drawer on a tab that hosts none', () => {
    expect(parseRoute('/capital/x', IDS, 'allocation', TAB_TYPES).selected).toBeNull();
    expect(parseRoute('/capital/x', IDS, null, TAB_TYPES).selected).toBeNull();
  });
  it('single-type modules ignore ?tab= (Acquisitions keeps its deal drawer on every tab)', () => {
    expect(parseRoute('/pipeline/d1', IDS, 'grader', TAB_TYPES).selected).toEqual({ type: 'deal', id: 'd1' });
  });
  // The "alias supplies its own tab on first render" case needs the real `debt` alias row, which lands
  // in Task 3 — it is asserted there (`parseRoute('/debt/l1', IDS).selected`), not here.
});

describe('entityHref', () => {
  it('cross-module jump: clears stale tab/view, keeps other params, sets the home tab', () => {
    expect(entityHref({ type: 'loan', id: 'l1' }, '?scenario=Downside&tab=calendar&view=x', 'worklist', HOMES))
      .toBe('/capital/l1?scenario=Downside&tab=debt');
  });
  it('cross-module jump to a module with no home tab drops the stale tab', () => {
    expect(entityHref({ type: 'property', id: 'p1' }, '?tab=alerts', 'worklist', HOMES)).toBe('/portfolio/p1');
  });
  it('same-module jump never changes the tab (Tenants → lease drawer must not flip to Rent roll)', () => {
    expect(entityHref({ type: 'deal', id: 'd1' }, '?tab=grader', 'pipeline', HOMES)).toBe('/pipeline/d1?tab=grader');
    expect(entityHref({ type: 'loan', id: 'l1' }, '?tab=debt&view=scorecard', 'capital', HOMES)).toBe('/capital/l1?tab=debt&view=scorecard');
  });
  it('ids are URL-encoded', () => {
    expect(entityHref({ type: 'property', id: 'a/b' }, '', 'overview', HOMES)).toBe('/portfolio/a%2Fb');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run tests/unit/entity-routing-tabs.test.ts`
Expected: FAIL — `entityHref` is not exported / `parseRoute` ignores its 3rd argument.

- [ ] **Step 3: Implement** — in `src/brain/routing.ts`

Add after `HOME_MODULE` (line 28):

```ts
/**
 * Multi-drawer destinations: which entity type `/:moduleId/:id` selects, keyed by `?tab=`
 * (Capital hosts loans on Debt and cash entities on Cash). Single-type modules stay in
 * MODULE_PRIMARY_TYPE and ignore the tab. Populated per destination PR (IA decongestion Phase 4).
 */
export const TAB_PRIMARY_TYPE: Readonly<Record<string, Readonly<Record<string, EntityType>>>> = {};

/** The tab an entity's drawer route lands on when its home module is a multi-tab destination and
 *  the jump comes from ANOTHER module. Same-module jumps keep the user's current tab. */
export const HOME_TAB: Readonly<Partial<Record<EntityType, string>>> = {};
```

Replace `parseRoute` (lines 114-129):

```ts
export function parseRoute(
  pathname: string,
  knownModuleIds: readonly string[],
  tab: string | null = null,
  tabTypes: Readonly<Record<string, Readonly<Record<string, EntityType>>>> = TAB_PRIMARY_TYPE,
): RouteState {
  const segs = pathname.split('/').filter(Boolean);
  const first = segs[0];
  const legacyAlias = first ? LEGACY_ALIASES[first] : undefined;
  const legacyDest = legacyAlias?.destination;
  const direct = !!first && knownModuleIds.includes(first);
  const viaAlias = !direct && !!legacyDest && knownModuleIds.includes(legacyDest);
  const known = direct || viaAlias;
  const moduleId = direct ? first! : viaAlias ? legacyDest! : DEFAULT_MODULE;
  // First render of `/debt/l1` (before AppShell's replace-redirect adds ?tab=debt): the alias row
  // already knows the tab, so the drawer opens without a flash.
  const effectiveTab = tab ?? (viaAlias ? legacyAlias!.tab : null);
  const entityId = segs[1] ? decodeURIComponent(segs[1]) : null;
  const type = (effectiveTab ? tabTypes[moduleId]?.[effectiveTab] : undefined) ?? MODULE_PRIMARY_TYPE[moduleId];
  const selected: EntityRef | null = entityId && type ? { type, id: entityId } : null;
  const intelPropertyId = moduleId === 'intel' && entityId ? entityId : null;
  return { moduleId, known, selected, intelPropertyId };
}
```

Add below `entityPath`:

```ts
/**
 * The full drawer URL for an entity, given the current query string and the module the click came
 * from. Cross-module: drop `tab`/`view` (they belong to the page being left — with shared tab ids a
 * stale one is valid-but-wrong) and land on the entity's home tab. Same-module: leave tab/view
 * untouched — the drawer is an overlay on the page the user is already on.
 */
export function entityHref(
  ref: EntityRef,
  search: string,
  fromModuleId: string,
  homes: { module: Record<EntityType, string>; tab: Partial<Record<EntityType, string>> } = { module: HOME_MODULE, tab: HOME_TAB },
): string {
  const params = new URLSearchParams(search);
  if (homes.module[ref.type] !== fromModuleId) {
    params.delete('tab');
    params.delete('view');
    const homeTab = homes.tab[ref.type];
    if (homeTab) params.set('tab', homeTab);
  }
  const qs = params.toString();
  return `/${homes.module[ref.type]}/${encodeURIComponent(ref.id)}${qs ? `?${qs}` : ''}`;
}
```

In `src/brain/UiProvider.tsx` — import `entityHref` (drop `entityPath` if unused), then:

```ts
  const tabParam = searchParams.get('tab');
  const { moduleId: activeModuleId, selected, intelPropertyId } = useMemo(
    () => parseRoute(location.pathname, MODULE_IDS, tabParam),
    [location.pathname, tabParam],
  );
  ...
  const openEntity = useCallback(
    (ref: EntityRef) => navigate(entityHref(ref, search, activeModuleId)),
    [navigate, search, activeModuleId],
  );
```
(`searchParams` is declared at line 20, above the memo — move the `tabParam` line accordingly.)

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run tests/unit/entity-routing-tabs.test.ts tests/unit/ia-registry.test.ts`
Expected: PASS (the registry suite is unchanged — `TAB_PRIMARY_TYPE`/`HOME_TAB` are empty).

- [ ] **Step 5: Typecheck + commit**

```bash
npm run typecheck
git add src/brain/routing.ts src/brain/UiProvider.tsx tests/unit/entity-routing-tabs.test.ts
git commit -m "feat(ia): tab-aware entity routing + entityHref (IA Phase 4 plumbing)"
```

### Task 2: `?view=` clearing + Destination `header`

**Files:**
- Modify: `src/lib/useTabParam.ts`
- Modify: `src/shell/Destination.tsx`
- Modify: `src/modules/data/DataModule.tsx:58`
- Test: `tests/unit/use-tab-param-clear.test.tsx` (create); extend `tests/unit/worklist-destination.test.tsx`

**Interfaces:**
- Produces: `useTabParam(keys, defaultKey, paramName?, clearOnChange?: readonly string[])` · `export const CLEAR_VIEW: readonly string[]` · `<Destination id label tabs header?: ReactNode />`.

- [ ] **Step 1: Write the failing test** — `tests/unit/use-tab-param-clear.test.tsx`

```tsx
import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useTabParam, CLEAR_VIEW } from '../../src/lib/useTabParam';

const KEYS = ['a', 'b', 'c'] as const;
function Probe({ clear }: { clear?: readonly string[] }) {
  const [tab, setTab] = useTabParam<(typeof KEYS)[number]>(KEYS, 'a', 'tab', clear);
  const loc = useLocation();
  return (
    <>
      <output data-testid="tab">{tab}</output>
      <output data-testid="loc">{loc.search}</output>
      <button onClick={() => setTab('b')}>to-b</button>
      <button onClick={() => setTab('a')}>to-a</button>
    </>
  );
}
const go = (clear?: readonly string[]) =>
  render(<MemoryRouter initialEntries={['/x?tab=c&view=pending&scenario=Upside']}><Probe clear={clear} /></MemoryRouter>);
afterEach(cleanup);

describe('useTabParam clearOnChange', () => {
  it('clears the named params on a tab change, keeping the rest', () => {
    go(CLEAR_VIEW);
    fireEvent.click(screen.getByText('to-b'));
    const q = new URLSearchParams(screen.getByTestId('loc').textContent!);
    expect(q.get('tab')).toBe('b');
    expect(q.has('view')).toBe(false);
    expect(q.get('scenario')).toBe('Upside');
  });
  it('also clears when switching back to the default (tab param removed)', () => {
    go(CLEAR_VIEW);
    fireEvent.click(screen.getByText('to-a'));
    const q = new URLSearchParams(screen.getByTestId('loc').textContent!);
    expect(q.has('tab')).toBe(false);
    expect(q.has('view')).toBe(false);
  });
  it('is a no-op when no clear list is given (existing behaviour)', () => {
    go();
    fireEvent.click(screen.getByText('to-b'));
    expect(new URLSearchParams(screen.getByTestId('loc').textContent!).get('view')).toBe('pending');
  });
});
```

- [ ] **Step 2: Run to verify it fails** — `npx vitest run tests/unit/use-tab-param-clear.test.tsx` → FAIL (`CLEAR_VIEW` not exported).

- [ ] **Step 3: Implement** — `src/lib/useTabParam.ts`

```ts
/** Params owned by an inner SegmentedControl — a destination clears them when its tab changes. */
export const CLEAR_VIEW: readonly string[] = ['view'];
const NONE: readonly string[] = [];

export function useTabParam<K extends string>(
  keys: readonly K[],
  defaultKey: K,
  paramName = 'tab',
  clearOnChange: readonly string[] = NONE,
): [K, (key: K) => void] {
```
and inside `setKey`, before `return next;`: `for (const p of clearOnChange) next.delete(p);` — add `clearOnChange` to the `useCallback` deps. Update the doc comment.

`src/shell/Destination.tsx`: add `header?: ReactNode` to props, call `useTabParam<string>(keys, keys[0]!, 'tab', CLEAR_VIEW)`, and wrap the return in `<div className="flex flex-col gap-4">{header}<Tabs …/></div>` (header omitted when undefined). `src/modules/data/DataModule.tsx:58`: pass `'tab', CLEAR_VIEW` as the 3rd/4th args.

- [ ] **Step 4: Add a Destination assertion** to `tests/unit/worklist-destination.test.tsx`: render at `/worklist?tab=alerts&view=pending`, click the "Today" tab, assert the `loc` output has no `view` param. (Worklist tabs don't own a view, but the clearing is the shared Destination behavior.)

- [ ] **Step 5: Run + commit**

```bash
npx vitest run tests/unit/use-tab-param-clear.test.tsx tests/unit/use-tab-param.test.tsx tests/unit/worklist-destination.test.tsx tests/unit/data-destination.test.tsx
npm run gate
git add src/lib/useTabParam.ts src/shell/Destination.tsx src/modules/data/DataModule.tsx tests/unit/use-tab-param-clear.test.tsx tests/unit/worklist-destination.test.tsx
git commit -m "feat(ia): clear ?view= on destination tab change; Destination header slot"
```
Open PR-A; merge before starting PR-B.

---

## PR-B — Capital destination (Allocation · Pipeline · Debt · Cash · Close)

### Task 3: Capital tab declaration + routing rows

**Files:**
- Create: `src/modules/capital/tabs.ts`
- Modify: `src/shell/modules.tsx` (capital row gets `tabs`; delete the `debt`, `cash`, `close` rows and their lazy imports — Debt/Cash/Close modules are lazy-imported from `CapitalModule` in Task 4; drop now-unused icons `Landmark`, `Wallet`, `Scale`)
- Modify: `src/brain/routing.ts`
- Modify: `tests/unit/ia-registry.test.ts`, `tests/unit/module-order.test.ts` (n/a this PR), `tests/unit/entity-routing-tabs.test.ts` (add real-constants cases)

**Interfaces:** Produces `CAPITAL_TABS`, `CapitalTab`, `CAPITAL_TAB_KEYS`, `CAPITAL_ALLOCATION_TABS`.

- [ ] **Step 1: Failing tests** — in `ia-registry.test.ts` replace the 4a "Phase 4a destinations are registered" expectations with a table-driven block and add:

```ts
  it('PR-B: Capital is a 5-tab destination; debt/cash/close are absorbed', () => {
    expect(byId('capital')!.tabs!.map((t) => t.id)).toEqual(['allocation', 'pipeline', 'debt', 'cash', 'close']);
    for (const id of ['debt', 'cash', 'close']) expect(IDS).not.toContain(id);
    expect(resolveLegacyRoute('/debt', '?tab=scorecard')).toBe('/capital?tab=debt&view=scorecard');
    expect(resolveLegacyRoute('/debt/borrower-restoration', '')).toBe('/capital/borrower-restoration?tab=debt');
    expect(resolveLegacyRoute('/cash/acct-1', '?scenario=Downside')).toBe('/capital/acct-1?scenario=Downside&tab=cash');
    expect(resolveLegacyRoute('/close', '')).toBe('/capital?tab=close');
  });
  it('the loan and cash drawers resolve inside Capital', () => {
    expect(parseRoute('/capital/l1', IDS, 'debt').selected).toEqual({ type: 'loan', id: 'l1' });
    expect(parseRoute('/capital/a1', IDS, 'cash').selected).toEqual({ type: 'cashEntity', id: 'a1' });
    expect(parseRoute('/debt/l1', IDS).selected).toEqual({ type: 'loan', id: 'l1' }); // first-render alias
  });
```
Also update the two existing 4a lines that list module ids (`for (const id of ['worklist','data','intel','health'])` stays; nothing else references debt/cash).
Run: `npx vitest run tests/unit/ia-registry.test.ts` → FAIL.

- [ ] **Step 2: Implement**

`src/modules/capital/tabs.ts`:
```ts
// Capital destination tab declaration (IA decongestion Phase 4b). React-free so the registry and the
// palette can index tabs without importing CapitalModule's chunk. Pipeline is today's second tab; it is
// replaced by a Capacity tab when 2026-09-18-capital-deployable-capacity.md lands (Capital stays at 5).
import type { ModuleTabDef } from '@/shell/tab-types';

export type CapitalTab = 'allocation' | 'pipeline' | 'debt' | 'cash' | 'close';

export const CAPITAL_TABS: readonly ModuleTabDef[] = [
  { id: 'allocation', label: 'Allocation' },
  { id: 'pipeline', label: 'Pipeline', aliases: ['buy pipeline'] },
  { id: 'debt', label: 'Debt', aliases: ['loans', 'maturities', 'balloon'] },
  { id: 'cash', label: 'Cash', aliases: ['treasury', 'liquidity'] },
  { id: 'close', label: 'Close', aliases: ['monthly close', 'month-end'] },
];

export const CAPITAL_TAB_KEYS = CAPITAL_TABS.map((t) => t.id) as readonly CapitalTab[];

/** The two warehouse-backed tabs (Rule G: their gates stay inside their own panels). */
export const CAPITAL_ALLOCATION_TABS: ReadonlySet<CapitalTab> = new Set<CapitalTab>(['allocation', 'pipeline']);
```

`routing.ts`:
- `MODULE_PRIMARY_TYPE`: delete `debt: 'loan'` and `cash: 'cashEntity'`.
- `HOME_MODULE`: `loan: 'capital'`, `cashEntity: 'capital'`.
- `TAB_PRIMARY_TYPE = { capital: { debt: 'loan', cash: 'cashEntity' } }`; `HOME_TAB = { loan: 'debt', cashEntity: 'cash' }`.
- `LEGACY_ALIASES` add:
```ts
  debt: { destination: 'capital', tab: 'debt', innerViews: ['positions', 'maturities', 'scorecard'] },
  cash: { destination: 'capital', tab: 'cash' },
  close: { destination: 'capital', tab: 'close' },
```
`modules.tsx`: `{ id: 'capital', label: 'Capital', icon: Coins, group: 'Capital', Component: CapitalModule, tabs: CAPITAL_TABS }`.

- [ ] **Step 3:** `npx vitest run tests/unit/ia-registry.test.ts tests/unit/entity-routing-tabs.test.ts` → PASS. (Tests in `debt-tabs`/`capital-module` are handled in Tasks 4–5.)

### Task 4: CapitalModule — five tabs, gates moved inside the panels (Rule G)

**Files:**
- Modify: `src/modules/capital/CapitalModule.tsx` (lines 43-48 tab constants; 216-end body)
- Modify: `tests/unit/capital-module.test.tsx` (harness lines 198-222; tab-structure block 347-410)

- [ ] **Step 1: Failing tests** — add to `capital-module.test.tsx` (mock the three absorbed modules so this suite stays about Capital):

```tsx
vi.mock('../../src/modules/debt/DebtModule', () => ({ DebtModule: () => <div>debt-panel</div> }));
vi.mock('../../src/modules/cash/CashModule', () => ({ CashModule: () => <div>cash-panel</div> }));
vi.mock('../../src/modules/close/CloseModule', () => ({ CloseModule: () => <div>close-panel</div> }));

describe('CapitalModule — Phase 4b destination (Allocation · Pipeline · Debt · Cash · Close)', () => {
  it('shows five tabs in order, Allocation default', () => {
    renderModule();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Allocation', 'Pipeline', 'Debt', 'Cash', 'Close']);
    expect(screen.getByRole('tab', { name: 'Allocation' }).getAttribute('aria-selected')).toBe('true');
  });
  it.each([['debt', 'debt-panel'], ['cash', 'cash-panel'], ['close', 'close-panel']])('?tab=%s mounts %s', async (id, text) => {
    renderModule(`/capital?tab=${id}`);
    expect(await screen.findByText(text)).toBeTruthy();
    expect(screen.queryByText('Market Cap-Rate Positioning')).toBeNull();
  });
  it('Rule G: Debt/Cash/Close stay usable when the capital warehouse queries FAIL', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    qc.setQueryData(['warehouse', 'capital', 'allocation'], undefined);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    renderModule('/capital?tab=debt', qc);
    expect(await screen.findByText('debt-panel')).toBeTruthy();
  });
  it('the Allocation tab shows the unavailable card (not a dead page) when capital data is missing', async () => {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    renderModule('/capital', qc);
    expect(await screen.findByText(/Capital allocation data unavailable/)).toBeTruthy();
    expect(screen.getByRole('tab', { name: 'Debt' })).toBeTruthy(); // the strip is still there
  });
  it('R2 (revised): the verdict-count strip sits above the strip on Allocation/Pipeline only', () => {
    renderModule('/capital?tab=pipeline');
    expect(screen.getByText('Hold 1')).toBeTruthy();
  });
  it('the verdict-count strip is absent on Debt (it is about allocation, not loans)', async () => {
    renderModule('/capital?tab=debt');
    await screen.findByText('debt-panel');
    expect(screen.queryByText('Hold 1')).toBeNull();
  });
});
```
Delete/replace the old "Phase 2 tab structure (Allocation · Pipeline)" test `keeps the banner/headline strip above the tabs on every tab (R2)` (its assertion is subsumed by the revised R2 test above). Run → FAIL.

- [ ] **Step 2: Implement.**

(a) Constants: replace lines 43-48 with `import { CAPITAL_TABS, CAPITAL_TAB_KEYS, CAPITAL_ALLOCATION_TABS, type CapitalTab } from './tabs';` and `const TAB_SPECS = CAPITAL_TABS.map(({ id, label }) => ({ id, label }));`. Add `lazy`, `Suspense` imports from `react`, `ModuleLoading` from `@/shell/ModuleFallback`, `CLEAR_VIEW` from `@/lib/useTabParam`, and:

```tsx
const DebtModule = lazy(() => import('../debt/DebtModule').then((m) => ({ default: m.DebtModule })));
const CashModule = lazy(() => import('../cash/CashModule').then((m) => ({ default: m.CashModule })));
const CloseModule = lazy(() => import('../close/CloseModule').then((m) => ({ default: m.CloseModule })));
type CapitalData = NonNullable<ReturnType<typeof useCapitalAllocation>['data']>;
```

(b) In `CapitalModule()`: `const [tab, setTab] = useTabParam<CapitalTab>(CAPITAL_TAB_KEYS, 'allocation', 'tab', CLEAR_VIEW);` **Delete the two early returns (239-251).** Replace with a local render helper:

```tsx
  /** Rule G: the loading / offline gate belongs to the two warehouse-backed panels only. */
  const gated = (render: (d: CapitalData) => React.ReactNode) =>
    isLoading ? (
      <div className="flex flex-col gap-4">{[1, 2, 3].map((i) => <Skeleton key={i} style={{ height: 80, borderRadius: 8 }} />)}</div>
    ) : error || !data ? (
      <Card><div style={{ padding: 20, color: 'var(--text-secondary)', fontSize: 13 }}>Capital allocation data unavailable — warehouse may be offline.</div></Card>
    ) : render(data);
```
Move the derived values (`portfolio`, `hurdleRate`, `actionEntries`, `distrustedCount`) into a small `AllocationHeader({ data })` component (banner + summary `Card`, i.e. current lines 267-292 verbatim) rendered **above the `<Tabs>` only when `data && CAPITAL_ALLOCATION_TABS.has(tab)`**. `capEntries`/`bench` stay in the Allocation panel closure.

(c) Body:
```tsx
  return (
    <div className="flex flex-col gap-4">
      {data && CAPITAL_ALLOCATION_TABS.has(tab) && <AllocationHeader data={data} />}
      <Tabs tabs={TAB_SPECS} selectedKey={tab} onSelectionChange={(k) => setTab(k as CapitalTab)} keyboardActivation="manual" aria-label="Capital views">
        <TabPanel id="allocation">{gated((d) => /* current lines 296-383 verbatim, using d.portfolio / d.hurdleRate */)}</TabPanel>
        <TabPanel id="pipeline">{gated((d) => /* current lines 387-end of pipeline panel verbatim, using d.portfolio.pipeline */)}</TabPanel>
        <TabPanel id="debt"><Suspense fallback={<ModuleLoading />}><DebtModule /></Suspense></TabPanel>
        <TabPanel id="cash"><Suspense fallback={<ModuleLoading />}><CashModule /></Suspense></TabPanel>
        <TabPanel id="close"><Suspense fallback={<ModuleLoading />}><CloseModule /></Suspense></TabPanel>
      </Tabs>
    </div>
  );
```
`keyboardActivation` becomes `"manual"` (Debt/Cash/Close mount queries — plan R9). Update the file header comment (lines 15-22) to describe the five tabs.

- [ ] **Step 3:** `npx vitest run tests/unit/capital-module.test.tsx tests/unit/capital-ui.test.ts` → PASS.

### Task 5: Debt/Cash/Close under Capital — inner strip → SegmentedControl

**Files:**
- Modify: `src/modules/debt/DebtModule.tsx:229-261` (+ imports; header comment lines 1-13)
- Modify: `tests/unit/debt-tabs.test.tsx`
- Check (no change expected): `src/modules/cash/CashModule.tsx`, `src/modules/close/CloseModule.tsx` have no strip.

- [ ] **Step 1: Rewrite `debt-tabs.test.tsx`** to the calibration pattern (`calibration-module-smoke.test.tsx:64`): assert a `radiogroup` named "Debt views" with radios Positions · Maturities · Scorecard; default Positions; `?view=scorecard` renders the scorecard/ladder mocks; selecting a radio writes `?view=` (default removes it); **no `role="tab"` exists inside DebtModule**. Remove the inert-panel/`FORCE_MOUNT_PANEL` assertions. Run → FAIL.

- [ ] **Step 2: Implement** — in `DebtModule`:

```tsx
type View = 'positions' | 'maturities' | 'scorecard';
const VIEW_KEYS: readonly View[] = ['positions', 'maturities', 'scorecard'];
const VIEWS: Array<{ value: View; label: string }> = [
  { value: 'positions', label: 'Positions' },
  { value: 'maturities', label: 'Maturities' },
  { value: 'scorecard', label: 'Scorecard' },
];

export function DebtModule() {
  const [view, setView] = useTabParam<View>(VIEW_KEYS, 'positions', 'view');
  return (
    <div className="flex flex-col gap-4">
      <DebtSummary />
      <SegmentedControl options={VIEWS} value={view} onChange={setView} aria-label="Debt views" />
      {view === 'positions' && <PositionsView />}
      {view === 'maturities' && <MaturitiesView />}
      {view === 'scorecard' && (
        <div className="flex flex-col gap-4">
          <ScorecardView />
          <LadderView />
        </div>
      )}
    </div>
  );
}
```
Drop the redundant `<Card><CardHeader title="Debt" /></Card>` (the rail item / tab already say Debt) and the now-unused `Tabs, TabPanel, FORCE_MOUNT_PANEL` imports; add `SegmentedControl`. `DebtSummary` (KPIs + balloon-watch banner) stays above the switch (R2).

- [ ] **Step 3:** `npx vitest run tests/unit/debt-tabs.test.tsx tests/unit/debt-scorecard-hooks.test.ts`, then `npm run gate`, `npm run check:bundle`.

### Task 6: e2e + PR-B close-out

- [ ] Add a Playwright case to `tests/e2e/smoke.spec.ts`: `page.goto('/debt/?still=1')`-style legacy URL → expect URL to match `/capital\?.*tab=debt/` and text "Positions" visible (radio). Add `?still=1` screenshots of every Capital tab × 3 themes to the PR body.
- [ ] `npm run check:refute`; if it flags the diff, clear it with a `Refute-Skip:` trailer stating "UI-only relocation; no engine/scoring/NOI code changed" (precedent: PR #224).
- [ ] Commit (explicit paths), open PR-B. Body: file list, tests, the Rule-G rationale, "Pipeline becomes Capacity later".

---

## PR-C — Obligations (new) + Market gains Demand

### Task 7: Obligations destination `[INFERRED]`

**Files:**
- Create: `src/modules/obligations/tabs.ts`, `src/modules/obligations/ObligationsModule.tsx`
- Modify: `src/modules/insurance/InsuranceModule.tsx:27-33,75-115`, `src/modules/taxes/TaxesModule.tsx:39-50,127-147` (strip → SegmentedControl on `?view=`; same transform as Task 5)
- Modify: `src/shell/modules.tsx` (add `obligations` row, group `'Capital'`, icon `ShieldCheck`; delete `insurance`, `taxes` rows/lazy imports/`Receipt` icon), `src/brain/routing.ts`
- Test: `tests/unit/obligations-destination.test.tsx` (create; clone `worklist-destination.test.tsx` structure), update `insurance`/`taxes` tab tests, `ia-registry.test.ts`

- [ ] **Step 1: Failing tests.** `ia-registry.test.ts`:
```ts
  it('PR-C: Obligations = Insurance · Taxes; Market gains Demand', () => {
    expect(byId('obligations')!.tabs!.map((t) => t.id)).toEqual(['insurance', 'taxes']);
    expect(byId('market')!.tabs!.map((t) => t.id)).toEqual(['macro', 'scorecards', 'comps', 'demand']);
    for (const id of ['insurance', 'taxes', 'prospect-demand']) expect(IDS).not.toContain(id);
    expect(resolveLegacyRoute('/insurance', '?tab=selfinsure')).toBe('/obligations?tab=insurance&view=selfinsure');
    expect(resolveLegacyRoute('/insurance/pol-1', '')).toBe('/obligations/pol-1?tab=insurance');
    expect(resolveLegacyRoute('/taxes', '?tab=returns')).toBe('/obligations?tab=taxes&view=returns');
    expect(resolveLegacyRoute('/prospect-demand', '')).toBe('/market?tab=demand');
    expect(parseRoute('/obligations/pol-1', IDS, 'insurance').selected).toEqual({ type: 'insurance', id: 'pol-1' });
  });
```
`obligations-destination.test.tsx`: mocks `InsuranceModule`/`TaxesModule`; asserts two tabs, Insurance default, `?tab=taxes` deep link, tab switch clears `?view=`. Run → FAIL.

- [ ] **Step 2: Implement.**

`tabs.ts`:
```ts
import type { ModuleTabDef } from '@/shell/tab-types';
export type ObligationsTab = 'insurance' | 'taxes';
export const OBLIGATIONS_TABS: readonly ModuleTabDef[] = [
  { id: 'insurance', label: 'Insurance', aliases: ['policies', 'coverage', 'renewal', 'premium'] },
  { id: 'taxes', label: 'Taxes', aliases: ['assessments', 'millage', 'appeals', 'cost seg'] },
];
```
`ObligationsModule.tsx` (mirrors `WorklistModule.tsx`):
```tsx
import { lazy, type ComponentType } from 'react';
import { Destination } from '@/shell/Destination';
import type { ModuleTabDef } from '@/shell/tab-types';
import { OBLIGATIONS_TABS, type ObligationsTab } from './tabs';

const PANELS: Record<ObligationsTab, ComponentType> = {
  insurance: lazy(() => import('@/modules/insurance/InsuranceModule').then((m) => ({ default: m.InsuranceModule }))),
  taxes: lazy(() => import('@/modules/taxes/TaxesModule').then((m) => ({ default: m.TaxesModule }))),
};
const TABS: readonly ModuleTabDef[] = OBLIGATIONS_TABS.map((t) => ({ ...t, Component: PANELS[t.id as ObligationsTab] }));

export function ObligationsModule() {
  return <Destination id="obligations" label="Obligations" tabs={TABS} />;
}
```
Insurance: `view` keys `savings|register|selfinsure` (labels unchanged: Savings Board · Register · Self-Insure — read the existing `TABS` labels at `InsuranceModule.tsx:29-33` and carry them over); Taxes: `strategy|assessments|returns`. Both use `useTabParam(keys, default, 'view')`. Keep each module's above-strip KPI block above the `SegmentedControl` and render the selected view conditionally (both had `keyboardActivation="manual"` because panels fire queries — conditional render preserves that: nothing mounts until selected).

`routing.ts`: `MODULE_PRIMARY_TYPE`: delete `insurance`, add `obligations: 'insurance'`; `HOME_MODULE.insurance = 'obligations'`; `HOME_TAB = { …, insurance: 'insurance' }`; `LEGACY_ALIASES` add `insurance: { destination: 'obligations', tab: 'insurance', innerViews: ['savings','register','selfinsure'] }`, `taxes: { destination: 'obligations', tab: 'taxes', innerViews: ['strategy','assessments','returns'] }`, `'prospect-demand': { destination: 'market', tab: 'demand' }`.

### Task 8: Market gains Demand

**Files:** Create `src/modules/market/tabs.ts`; modify `src/modules/market/MarketModule.tsx:12-60`; `modules.tsx` (market row `tabs: MARKET_TABS`; drop `prospect-demand` row + `Radar` icon + lazy import); test `tests/unit/market-tabs.test.tsx` (existing — extend) 

- [ ] Failing test: five→ four tabs `['Macro','Scorecards','Comps','Demand']`; `?tab=demand` mounts a mocked `ProspectDemandModule`; Demand is `keyboardActivation="manual"` (already manual).
- [ ] `tabs.ts`: `MARKET_TABS = [{id:'macro',label:'Macro'},{id:'scorecards',label:'Scorecards'},{id:'comps',label:'Comps'},{id:'demand',label:'Demand',aliases:['demand signals','prospects','showings']}]`. In `MarketModule`: widen `MarketTab`/`MARKET_TAB_KEYS`, use `CLEAR_VIEW`, add `<TabPanel id="demand"><Suspense fallback={<ModuleLoading />}><ProspectDemandModule /></Suspense></TabPanel>` with `const ProspectDemandModule = lazy(() => import('../intel/ProspectDemandModule').then((m) => ({ default: m.ProspectDemandModule })));`.
- [ ] Run `npx vitest run tests/unit/market-tabs.test.tsx tests/unit/ia-registry.test.ts`.

### Task 9: PR-C close-out
- [ ] `npm run gate`, `check:bundle`, e2e legacy-URL case (`/insurance?tab=selfinsure` → `/obligations?tab=insurance&view=selfinsure`), 3-theme `?still=1` screenshots, PR. D1 confirmation requested in the PR body.

---

## PR-D — Leasing destination (Rollover · Rent roll · Forecast · Market rents · Tenants)

### Task 10: Leasing tabs, Rule-G scoping, panels

**Files:**
- Create: `src/modules/leasing/tabs.ts`
- Modify: `src/modules/leasing/LeaseForecastModule.tsx` (tab constants 77-78; body ~276+), `src/modules/leases/LeasesModule.tsx:43-57` + its `<Tabs>` block, `src/modules/tenants/TenantsModule.tsx` (none — mounted as-is)
- Modify: `src/shell/modules.tsx` (leasing row `tabs: LEASING_TABS`; delete `leases`, `tenants` rows/imports/`FileText`/`Contact` icons), `src/brain/routing.ts`
- Test: `tests/unit/leasing-destination.test.tsx` (create), rewrite `tests/unit/leases-tabs.test.tsx` to the SegmentedControl pattern, `ia-registry.test.ts`

- [ ] **Step 1: Failing tests.**
```ts
// ia-registry.test.ts
  it('PR-D: Leasing = Rollover · Rent roll · Forecast · Market rents · Tenants', () => {
    expect(byId('leasing')!.tabs!.map((t) => t.id)).toEqual(['rollover', 'rent-roll', 'forecast', 'market-rents', 'tenants']);
    for (const id of ['leases', 'tenants']) expect(IDS).not.toContain(id);
    expect(resolveLegacyRoute('/leases', '')).toBe('/leasing?tab=rent-roll');
    expect(resolveLegacyRoute('/leases', '?tab=rollover')).toBe('/leasing?tab=rent-roll&view=rollover');
    expect(resolveLegacyRoute('/leases/lease-9', '')).toBe('/leasing/lease-9?tab=rent-roll');
    expect(resolveLegacyRoute('/tenants', '')).toBe('/leasing?tab=tenants');
    expect(parseRoute('/leasing/lease-9', IDS, 'tenants').selected).toEqual({ type: 'lease', id: 'lease-9' });
  });
```
`leasing-destination.test.tsx`: (mock `useLeaseForecast`, `LeasesModule`, `TenantsModule`) — default tab is Rollover (correction 3: default is not a 140-row table); the expiry bucket cards render on Rollover/Forecast/Market rents and **not** on Rent roll/Tenants; Rule G: with `useLeaseForecast` erroring 503, the Rent roll and Tenants tabs still mount. Run → FAIL.

- [ ] **Step 2: Implement.**

`tabs.ts`:
```ts
import type { ModuleTabDef } from '@/shell/tab-types';
export type LeasingTab = 'rollover' | 'rent-roll' | 'forecast' | 'market-rents' | 'tenants';
export const LEASING_TABS: readonly ModuleTabDef[] = [
  { id: 'rollover', label: 'Rollover', aliases: ['expiries', 'expirations', 'velocity'] },
  { id: 'rent-roll', label: 'Rent roll', aliases: ['leases', 'critical dates'] },
  { id: 'forecast', label: 'Forecast', aliases: ['rent forecast'] },
  { id: 'market-rents', label: 'Market rents' },
  { id: 'tenants', label: 'Tenants', aliases: ['tenant risk'] },
];
export const LEASING_TAB_KEYS = LEASING_TABS.map((t) => t.id) as readonly LeasingTab[];
/** Tabs backed by the lease-forecast warehouse route (Rule G: the offline gate is scoped to these). */
export const LEASING_FORECAST_TABS: ReadonlySet<LeasingTab> = new Set<LeasingTab>(['rollover', 'forecast', 'market-rents']);
```
`LeaseForecastModule`: widen `Tab`/`TAB_KEYS` from `tabs.ts`; `useTabParam(TAB_KEYS, 'rollover', 'tab', CLEAR_VIEW)`; render the expiry-bucket cards above the strip only when `LEASING_FORECAST_TABS.has(tab)`; any whole-module early return keyed on the forecast query (read the module body from `:276` — if one exists) moves inside the three forecast panels; add
```tsx
<TabPanel id="rent-roll"><Suspense fallback={<ModuleLoading />}><LeasesModule /></Suspense></TabPanel>
<TabPanel id="tenants"><Suspense fallback={<ModuleLoading />}><TenantsModule /></Suspense></TabPanel>
```
(lazy imports as in Task 4) and switch `keyboardActivation` to `"manual"`.
`LeasesModule`: replace its `Tabs` with a `SegmentedControl` on `?view=` keyed `rent-roll` | `rollover`, labels **"Rent roll"** / **"Critical dates"** (D3); conditional render; the KPI/filter block stays above the switch.
`routing.ts`: `MODULE_PRIMARY_TYPE`: delete `leases`, add `leasing: 'lease'`; `HOME_MODULE.lease = 'leasing'`; `HOME_TAB.lease = 'rent-roll'`; aliases `leases: { destination: 'leasing', tab: 'rent-roll', innerViews: ['rent-roll','rollover'] }`, `tenants: { destination: 'leasing', tab: 'tenants' }`.

### Task 11: Overview KPI links
`src/modules/overview/widgets.tsx:39-40` uses `goTo('leases')` — resolves through the alias today, but repoint to `goTo('leasing')` (and `goTo('debt')`→`goTo('capital')`, `goTo('cash')`→`goTo('capital')` in PR-B's rebase) so a click is one navigation, not navigate + redirect. Test: extend an existing overview test if present; otherwise assert via `resolveLegacyRoute` that no `goTo` target is a legacy id (add a tiny unit that greps `widgets.tsx` for `goTo('<legacy id>')` using the `LEGACY_ALIASES` keys — cheap regression guard).

### Task 12: e2e + close-out
- [ ] `tests/e2e/smoke.spec.ts:31-37`: rename to "leasing shows the rent roll": click `button { name: 'Leasing' }`, click `tab { name: 'Rent roll' }`, then the existing `Rent Roll`/`Tenant 155 LLC` assertions. `tests/e2e/a11y.spec.ts:14-18`: same two clicks before the `th[aria-sort]` assertion.
- [ ] Legacy-URL case: `/leases?tab=rollover&still=1` → URL matches `/leasing\?.*tab=rent-roll.*view=rollover/`.
- [ ] `npm run test:e2e` (needs `npx playwright install chromium` once), gate, bundle, PR.

---

## PR-E — Brain destination (Digest · Insights · Track record · Feedback · Memory)

### Task 13: Brain tabs, scoped report gate, Versions → Memory view

**Files:**
- Create: `src/modules/command-brain/tabs.ts`, `ReportGate.tsx`, `BrainPanels.tsx`
- Modify: `src/modules/command-brain/CommandBrainModule.tsx` (becomes the thin shell), `src/brain/routing.ts` (`LEGACY_TAB_ALIASES.view`), `src/shell/modules.tsx` (command-brain row: label `'Brain'`, `tabs: BRAIN_TABS`; delete `principal`, `insights` rows/imports/`Briefcase`, `Lightbulb` icons), `src/shell/module-order.ts`
- Test: `tests/unit/brain-destination.test.tsx` (create), `tests/unit/module-order.test.ts:8-14`, `ia-registry.test.ts`, existing command-brain tests

- [ ] **Step 1: Failing tests.**
```ts
// ia-registry.test.ts
  it('PR-E: Brain = Digest · Insights · Track record · Feedback · Memory; Versions became a Memory view', () => {
    expect(byId('command-brain')!.tabs!.map((t) => t.id)).toEqual(['digest', 'insights', 'track-record', 'feedback', 'memory']);
    for (const id of ['principal', 'insights']) expect(IDS).not.toContain(id);
    expect(resolveLegacyRoute('/principal', '')).toBe('/command-brain?tab=digest');
    expect(resolveLegacyRoute('/insights', '')).toBe('/command-brain?tab=insights');
    expect(resolveLegacyRoute('/command-brain', '?tab=versions')).toBe('/command-brain?tab=memory&view=versions');
  });
```
`module-order.test.ts:11`: `expect(PROFILE_HOME.principal).toBe('command-brain');`.
`brain-destination.test.tsx` (mock `useBrainReport`, `PrincipalModule`, `InsightsModule`): Digest is the default and renders with `useBrainReport` returning a 503 error (**Rule G**); Track record/Feedback/Memory show the offline card in that state but the strip stays; on a healthy report the disclaimer + four KPI tiles render on the three report tabs and not on Digest/Insights; Feedback tab carries the open-question count badge; Memory has a `radiogroup` "Memory views" (Memory · Versions) and `?view=versions` renders the version log; a tab switch clears `?view=`. Run → FAIL.

- [ ] **Step 2: Implement.**

`tabs.ts`:
```ts
import type { ModuleTabDef } from '@/shell/tab-types';
export type BrainTab = 'digest' | 'insights' | 'track-record' | 'feedback' | 'memory';
export const BRAIN_TABS: readonly ModuleTabDef[] = [
  { id: 'digest', label: 'Digest', aliases: ['principal', 'principal home', 'attention'] },
  { id: 'insights', label: 'Insights', aliases: ['tier board'] },
  { id: 'track-record', label: 'Track record', aliases: ['accuracy', 'calibration report'] },
  { id: 'feedback', label: 'Feedback', aliases: ['open questions'] },
  { id: 'memory', label: 'Memory', aliases: ['versions', 'version log'] },
];
export const BRAIN_TAB_KEYS = BRAIN_TABS.map((t) => t.id) as readonly BrainTab[];
```
`routing.ts`: widen the type — `LEGACY_TAB_ALIASES: Record<string, Record<string, { destination: string; tab: string; view?: string }>>`; in `resolveLegacyRoute`'s moved branch add `if (moved.view) params.set('view', moved.view);` and set `command-brain: { versions: { destination: 'command-brain', tab: 'memory', view: 'versions' } }`; `LEGACY_ALIASES` add `principal: { destination: 'command-brain', tab: 'digest' }`, `insights: { destination: 'command-brain', tab: 'insights' }`. Note the moved-tab branch fires on the *surviving* module id `command-brain`, so it must not require `first` to be a legacy id — it already doesn't.

`ReportGate.tsx` — the offline/loading/disclaimer/KPI block moved verbatim from `CommandBrainModule.tsx:112-172` (offline Card 113-126, skeleton 128-130, disclaimer Card 146-153, KPI grid 155-172), exposed as:
```tsx
export function ReportGate({ children }: { children: (r: BrainReport) => ReactNode }) {
  const report = useBrainReport();
  if (isWarehouseUnavailable(report.error)) return /* offline Card, lines 114-125 verbatim */;
  if (report.isLoading || !report.data) return <Skeleton style={{ height: 320 }} />;
  const r = report.data;
  return (
    <div className="flex flex-col gap-4">
      {/* disclaimer Card + KPI grid, lines 146-172 verbatim, using r */}
      {children(r)}
    </div>
  );
}
```
(`BrainReport` = the type `useBrainReport().data` resolves to: `NonNullable<ReturnType<typeof useBrainReport>['data']>`.)
`BrainPanels.tsx` — `TrackRecordPanel({ r })` (lines 175-199 body), `FeedbackPanel({ r })` (201-239), `MemoryPanel({ r })`: a `SegmentedControl` (`Memory` | `Versions`, `useTabParam(['memory','versions'], 'memory', 'view')`, aria-label "Memory views") over `<MemoryBoard …/>` (line 242) or `<VersionLog r={r} />` (lines 246-270). All JSX moved verbatim; no logic change.
`CommandBrainModule.tsx` shell:
```tsx
export function CommandBrainModule() {
  const [tab, setTab] = useTabParam<BrainTab>(BRAIN_TAB_KEYS, 'digest', 'tab', CLEAR_VIEW);
  const report = useBrainReport(); // shared query — only feeds the R4 badge
  const openCount = report.data?.openQuestions.length ?? 0;
  const specs: TabSpec[] = BRAIN_TABS.map((t) =>
    t.id === 'feedback' && openCount > 0 ? { id: t.id, label: t.label, badge: { count: openCount, tone: 'neutral' } } : { id: t.id, label: t.label },
  );
  return (
    <Tabs tabs={specs} selectedKey={tab} onSelectionChange={(k) => setTab(k as BrainTab)} keyboardActivation="manual" aria-label="Brain views">
      <TabPanel id="digest"><Suspense fallback={<ModuleLoading />}><PrincipalModule /></Suspense></TabPanel>
      <TabPanel id="insights"><Suspense fallback={<ModuleLoading />}><InsightsModule /></Suspense></TabPanel>
      <TabPanel id="track-record"><ReportGate>{(r) => <TrackRecordPanel r={r} />}</ReportGate></TabPanel>
      <TabPanel id="feedback"><ReportGate>{(r) => <FeedbackPanel r={r} />}</ReportGate></TabPanel>
      <TabPanel id="memory"><ReportGate>{(r) => <MemoryPanel r={r} />}</ReportGate></TabPanel>
    </Tabs>
  );
}
```
(`PrincipalModule`/`InsightsModule` via `lazy()` as in Task 4.) R2 note for the PR body: the disclaimer + KPI tiles moved *inside* the three report-backed panels — above the strip they were noise on Digest/Insights, and they cannot render at all when the report is offline.
`module-order.ts`: `PROFILE_HOME.principal = 'command-brain'`; remove `'principal'` from both `MODULE_ORDER` lists and put `'command-brain'` where `'principal'` was (first for the principal profile).

- [ ] **Step 3:** `npx vitest run tests/unit/brain-destination.test.tsx tests/unit/module-order.test.ts tests/unit/ia-registry.test.ts` and the pre-existing command-brain tests (`grep -l command-brain tests/unit`); update only assertions that pinned the four-tab strip / Versions tab.

### Task 14: PR-E close-out — gate, bundle, e2e (Eric's landing: add a Playwright case that sets the principal profile and expects the URL to land on `/command-brain` with "Digest" selected — find how the profile is switched in `src/brain/view-profile.ts` first), screenshots, PR.

---

## PR-F — Finalize the rail

### Task 15: Order lists, groups, and the 12-item guard

**Files:** `src/shell/module-order.ts`, `tests/unit/ia-registry.test.ts`, `tests/unit/module-order.test.ts`

- [ ] **Step 1: Failing test** (`ia-registry.test.ts`):
```ts
describe('final rail (IA decongestion Phase 4 complete)', () => {
  const RAIL = ['overview', 'pipeline', 'worklist', 'command-brain', 'portfolio', 'intel', 'leasing', 'capital', 'obligations', 'market', 'lease-market', 'data'];
  for (const profile of ['acquisitions', 'principal'] as const) {
    it(`${profile}: exactly the 12 ratified destinations, none empty, none over 5 tabs`, () => {
      expect(railModules(profile).map((m) => m.id).sort()).toEqual([...RAIL].sort());
    });
    it(`${profile}: MODULE_ORDER lists every rail id (nothing relies on the append-unlisted fallback)`, () => {
      for (const id of RAIL) expect(MODULE_ORDER[profile], id).toContain(id);
    });
  }
  it('every legacy id (26) still resolves to one of the 12 (or Health)', () => {
    for (const id of LEGACY_MODULE_IDS) {
      const target = byId(id)?.id ?? LEGACY_ALIASES[id]?.destination;
      expect([...RAIL, 'health']).toContain(target);
    }
  });
});
```
Run → FAIL on the order-list assertion.
- [ ] **Step 2: Implement.** Final `MODULE_ORDER`:
```ts
  acquisitions: ['overview', 'pipeline', 'worklist', 'command-brain', 'portfolio', 'intel', 'leasing', 'capital', 'obligations', 'market', 'lease-market', 'data', 'health'],
  principal:    ['command-brain', 'overview', 'worklist', 'capital', 'obligations', 'portfolio', 'intel', 'leasing', 'market', 'lease-market', 'pipeline', 'data', 'health'],
```
Update the existing rail-composition test that lists `['Assets','Capital','Command','Market','System']` (still true — no group emptied) and the 4a block's "every other module still shows" test if it enumerated ids.

### Task 16: Docs, memory, tracker
- [ ] Update `docs/superpowers/plans/2026-09-18-ia-decongestion-tabs.md`: mark P4 complete in the as-executed banner (§2) and add a pointer to this plan; add the Capital plan's note that Pipeline is replaced by Capacity.
- [ ] `architecture/status.json`: set the `ia-p4-*` entries to `merged`; refresh `CLAUDE.md` §2/§3 build-state rows (Architect-owned — `review_needed: true` first) and README architecture diagram if it lists the rail.
- [ ] Update memory `ia-decongestion-tabs-plan.md` (Phase 4 done; only P5 Overview curation + follow-ons remain).
- [ ] Final verification: `npm run gate`, `npm run check:bundle`, `npm run test:e2e`, then manual `?still=1` sweep of all 12 destinations × 3 themes at 1280px (one-row strip check).

---

## Verification (every PR)

`npm run gate` · `npm run check:bundle` · `npm run test:e2e` (a legacy-URL case per absorbed destination) · `?still=1` screenshots of every tab × 3 themes attached to the PR · 1280px one-row tab-strip check · the R4 rule (a critical item on a non-default tab shows a badge) is unchanged — only Worklist > Alerts and Brain > Feedback carry badges.

## Rollback

Each PR is a pure UI/routing squash; `git revert -m 1 <merge>` restores the previous rail. Legacy-alias rows are additive, so reverting PR-N never breaks PR-(N-1)'s URLs. PR-A (plumbing) is inert until PR-B populates `TAB_PRIMARY_TYPE`/`HOME_TAB`, so it can also be reverted alone until then. No migration, contract, or data change anywhere.

## Self-review (run 2026-09-21)

- **Spec coverage:** 12-item rail ✔ (Task 15) · Capital 4-tab + legacy aliases ✔ (3–5) · Leasing/Brain/Market/Obligations ✔ (7–14) · `principal` landing ✔ (13) · every-legacy-id-resolves ✔ (15) · per-destination Playwright reload/legacy-URL test ✔ (6/9/12/14) · palette indexing via `tabs.ts` ✔ · Acquisitions split — already shipped (#343), no task · Overview curation = Phase 5, out of scope · Capacity tab = separate plan, out of scope.
- **Placeholder scan:** the "moved verbatim, lines N–M" steps (Tasks 4, 13) are mechanical relocations of existing JSX with the source lines cited, not unspecified work. Two steps say "read the module body first" (Task 10: whether `LeaseForecastModule` has a whole-module early return; Task 14: how the profile is switched) — both are lookups, flagged rather than guessed.
- **Type consistency:** `TAB_PRIMARY_TYPE`/`HOME_TAB`/`entityHref`/`CLEAR_VIEW`/`CAPITAL_TABS`/`LEASING_TABS`/`BRAIN_TABS`/`OBLIGATIONS_TABS`/`MARKET_TABS` names are used identically across tasks. Alias view-key sets match the modules' actual keys (Debt `positions|maturities|scorecard`, Insurance `savings|register|selfinsure`, Taxes `strategy|assessments|returns`, Leases `rent-roll|rollover`).
- **Known unverified:** the handoff's exact placement of Tenants / Demand / Insights / Insurance+Taxes (D1). Nothing in PR-A/B/D's core (Capital, Leasing minus Tenants) depends on it.
