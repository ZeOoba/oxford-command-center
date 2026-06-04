# Mobile-Responsive Oxford Command Center — Design Spec

**Date:** 2026-06-04
**Branch:** `feat/mobile-responsive`
**Scope:** Layout/responsiveness only. No data, analytics, or business-logic changes.

## Goal

Make the entire Command Center — the shell plus all 13 modules — render and function
cleanly at phone widths (target 375px) through tablet (768px) up to the existing
desktop layout. The Principal home (`grid-cols-1 → sm:grid-cols-2 → lg:grid-cols-4`)
is the reference pattern; bring every other surface up to the same standard.

## Constraints

- `npm run gate` (typecheck + lint + test + reconcile) must stay green.
- `npm run check:bundle` budget must hold (changes are class/markup-only, so impact ≈ nil).
- CI runs on push; features merge to `main` after a green gate.
- Do **not** change data fetching, analytics, or computed values — markup and Tailwind
  classes only.

## Decisions (locked during brainstorming)

1. **Wide tables → horizontal scroll.** All tables route through one shared
   `DataTable` primitive. Keep the table intact and let it scroll sideways within its
   card, with a table `min-width` and non-wrapping cells. One change covers all modules.
2. **Coverage → shell + all 13 modules.** Full audit and fixes this branch.
3. **Drawer breakpoint → `lg` (1024px).** Below `lg` the sidebar is an overlay drawer
   and the TopBar condenses; at `lg+` the persistent rail is unchanged.
4. **Sidebar implementation → state-driven drawer in `AppShell` (Approach A).** Reuse
   the existing `Sidebar` markup and framer-motion animation; one new prop puts it in
   drawer mode. No duplicate nav component.

## Out of scope (already mobile-safe — verified)

- `AiPanel` (`w-[380px] max-w-[92vw]`), `EntityDrawer` (`w-[440px] max-w-[94vw]`),
  `DraftPanel` (`w-[min(620px,94vw)]`), and `CommandPalette` already cap at viewport
  width. No changes needed.
- Charts (`BarChart`, `AreaChart`, `Sparkline`) use `useMeasure`, so they already
  track their container width. No changes needed beyond confirming their containers
  reflow.

## Design

### 1. Shell — `AppShell.tsx`

- Introduce `mobileNavOpen` state, distinct from the existing desktop `collapsed`
  state.
- Pass `mobileNavOpen` + `onMobileClose` to `Sidebar`, and `onOpenNav` to `TopBar`.
- Main content padding: `px-5 py-5` → `px-3 py-3 sm:px-4 lg:px-5`. Keep
  `mx-auto max-w-[1500px]`.

### 2. Shell — `Sidebar.tsx` (two modes, one component)

- **`lg+`:** persistent rail exactly as today — collapse/expand toggle still works.
- **`< lg`:** `position: fixed`, full height, off-canvas, sliding in/out via the
  existing framer-motion `animate` (translateX) with a backdrop scrim behind it.
  - Tapping a nav item → `onMobileClose`.
  - Tapping the scrim → `onMobileClose`.
  - The desktop collapse toggle button is hidden in drawer mode.
- Implemented with a `mobile`/`open` prop pair; desktop rendering path is byte-for-byte
  unchanged when not in drawer mode.

### 3. Shell — `TopBar.tsx`

- Hamburger button, `lg:hidden`, far left → calls `onOpenNav`.
- Control cluster condenses below `lg`:
  - Search box stays `hidden md:flex` (Cmd-K palette still reachable).
  - Secondary controls — `ScenarioSwitch`, `DensityToggle`, `ThemeToggle` — collapse
    into a single "More" (`⋯`) popover at `< lg`.
  - High-value controls stay inline at all widths: **Ask**, **Refresh**,
    **StatusPill**, **ViewToggle**.
- Title truncates as it already does.

### 4. Tables — `DataTable.tsx` (covers all 13 modules)

- Add a `minWidth` prop (default `640`) applied to the `<table>` so columns keep
  readable widths and the already-present `overflow-auto` wrapper scrolls instead of
  crushing.
- Add `whitespace-nowrap` to `<td>` cells (headers already have it) so multi-word
  cells don't wrap into tall ragged rows.
- Add a subtle right-edge fade affordance so horizontal scroll is discoverable.
- `maxHeight` vertical scroll/virtualization behavior is untouched.

### 5. Modules — per-module audit (layout-only)

Three recurring fix buckets:

- **KPI rows:** ones already on `grid-cols-2 md:grid-cols-4` are fine; ones that jump
  straight to multi-col (e.g. Overview `grid-cols-1 xl:grid-cols-2`) get an
  intermediate `sm:`/`lg:` step where it improves the mid-range.
- **Two-column dashboard splits** (e.g. `xl:grid-cols-[1fr_320px]`) already collapse to
  one column below `xl` — confirm each renders correctly.
- **Filter/toolbar rows** (e.g. Leases' `flex-wrap` bar with `w-56` / `max-w-44`
  inputs) get `w-full sm:w-56` so inputs don't overflow the card on phone.

Modules to audit: overview, acquisitions (pipeline), portfolio, leases, debt, cash,
insurance, market, relationships, tasks, documents, health, principal (reference —
spot-check only).

### 6. Verification & gates

- Verify with the **chrome-devtools** skill against `npm run dev` at 375px (iPhone SE),
  390px, and 768px — check the shell drawer, TopBar condense, each module's grids,
  table horizontal scroll, and chart reflow.
- Run `npm run gate` (must be green) and `npm run check:bundle` (budget must hold)
  before merge.

## Implementation order

1. Foundation: `DataTable` `minWidth` + nowrap + fade.
2. Shell: `AppShell` state, `Sidebar` drawer mode, `TopBar` hamburger + More popover.
3. Modules: one pass per module via subagent-driven-development, each verified at phone
   width.
4. Finish: green gate + bundle check, then finishing-a-development-branch.

## Testing

- Existing unit tests (`vitest`) must continue to pass — no logic changes expected to
  affect them.
- Manual/automated viewport verification via chrome-devtools at the three breakpoints
  above is the primary responsiveness check (responsiveness is visual, not unit-testable
  here).
