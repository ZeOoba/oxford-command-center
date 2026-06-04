# Mobile-Responsive Command Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the shell and all 13 modules render and function cleanly from 375px (phone) through tablet to the existing desktop layout, layout-only — no data/analytics changes.

**Architecture:** One shared `DataTable` primitive gets horizontal-scroll behavior (covers every table at once). The shell gains a state-driven mobile drawer (`AppShell` owns `mobileNavOpen`; `Sidebar` renders the same markup in an off-canvas overlay below `lg`; `TopBar` gets a hamburger + a "More" popover for secondary controls). Module grids are mostly already responsive — Phase 3 is targeted touch-ups plus per-breakpoint verification.

**Tech Stack:** Vite 6, React 19, TypeScript, Tailwind 4 (CSS-first, default breakpoints: `sm`640 `md`768 `lg`1024 `xl`1280), framer-motion, lucide-react, Vitest + Testing Library (jsdom), chrome-devtools MCP for viewport verification.

**Conventions:**
- jsdom does not compute layout, so unit tests assert **classes / inline styles / behavior**, not rendered pixel widths. True responsive verification is done with the chrome-devtools skill at 375 / 390 / 768 px.
- Tables live inside `Card`, whose background is `var(--surface-raised)` — the scroll-fade gradient fades to that color.
- Commit after every task. Run `npm run gate` before the final task.
- Each component edit must keep the desktop (`lg+`) rendering byte-for-byte equivalent to today.

---

## Phase 1 — DataTable foundation

### Task 1: Horizontal-scroll behavior in `DataTable`

**Files:**
- Modify: `src/primitives/DataTable.tsx`
- Test: `tests/unit/data-table.test.tsx` (create)

**Background:** `DataTable` returns a single `overflow-auto` div wrapping a `w-full` table. With 8–10 columns (e.g. Portfolio) the table compresses unreadably on phones instead of scrolling. Fix: give the table a `minWidth` so it overflows and the wrapper scrolls; stop cells wrapping into ragged rows; add a right-edge fade as a scroll affordance on small screens.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/data-table.test.tsx`:

```tsx
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DataTable, type Column } from '../../src/primitives/DataTable';

interface Row { id: string; name: string; n: number }
const rows: Row[] = [
  { id: 'a', name: 'Alpha Holdings LLC', n: 1 },
  { id: 'b', name: 'Beta Industrial', n: 2 },
];
const cols: Column<Row>[] = [
  { key: 'name', header: 'Name', render: (r) => r.name, sortValue: (r) => r.name },
  { key: 'n', header: 'N', align: 'right', render: (r) => r.n, sortValue: (r) => r.n },
];

describe('DataTable responsive behavior', () => {
  it('applies a default minWidth to the table so it scrolls instead of crushing', () => {
    render(<DataTable columns={cols} rows={rows} getRowId={(r) => r.id} />);
    const table = screen.getByRole('table');
    expect(table.style.minWidth).toBe('640px');
  });

  it('honors an explicit minWidth prop', () => {
    render(<DataTable columns={cols} rows={rows} getRowId={(r) => r.id} minWidth={900} />);
    expect(screen.getByRole('table').style.minWidth).toBe('900px');
  });

  it('renders body cells with whitespace-nowrap so multi-word cells do not wrap', () => {
    render(<DataTable columns={cols} rows={rows} getRowId={(r) => r.id} />);
    const cell = screen.getByText('Alpha Holdings LLC').closest('td')!;
    expect(cell.className).toContain('whitespace-nowrap');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/data-table.test.tsx`
Expected: FAIL — `minWidth` is `''` (no minWidth prop yet) and `td` lacks `whitespace-nowrap`.

- [ ] **Step 3: Add the `minWidth` prop to the Props interface**

In `src/primitives/DataTable.tsx`, update the `Props` interface (currently ends at `maxHeight?: number;`):

```tsx
interface Props<T> {
  columns: Column<T>[];
  rows: T[];
  getRowId: (row: T) => string;
  onRowClick?: (row: T) => void;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  maxHeight?: number;
  /** Min table width (px) so dense tables scroll horizontally instead of crushing on small screens. */
  minWidth?: number;
}
```

And the destructure (currently `export function DataTable<T>({ columns, rows, getRowId, onRowClick, initialSort, maxHeight }: Props<T>) {`):

```tsx
export function DataTable<T>({ columns, rows, getRowId, onRowClick, initialSort, maxHeight, minWidth = 640 }: Props<T>) {
```

- [ ] **Step 4: Add `whitespace-nowrap` to body cells**

In `renderRow`, the `<td>` `className` is currently:

```tsx
className={cn('px-3 py-2 align-middle', c.align === 'right' ? 'num text-right' : 'text-left')}
```

Change to:

```tsx
className={cn('px-3 py-2 align-middle whitespace-nowrap', c.align === 'right' ? 'num text-right' : 'text-left')}
```

- [ ] **Step 5: Apply `minWidth` to the table and add the scroll-fade wrapper**

The component currently returns:

```tsx
  return (
    <div ref={scrollRef} className="overflow-auto" style={{ maxHeight }}>
      <table className="ora-table w-full border-collapse">
```
...and closes with `</table>` + the empty-state block + `</div>`.

Replace the outer wrapper and table-open line so the return is:

```tsx
  return (
    <div className="relative">
      <div ref={scrollRef} className="overflow-auto" style={{ maxHeight }}>
        <table className="ora-table w-full border-collapse" style={{ minWidth }}>
```

Then add the closing wrapper + fade after the existing empty-state block. The existing tail is:

```tsx
      {sorted.length === 0 && (
        <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
          No records.
        </div>
      )}
    </div>
  );
```

Change it to:

```tsx
        {sorted.length === 0 && (
          <div className="px-4 py-10 text-center text-sm" style={{ color: 'var(--text-tertiary)' }}>
            No records.
          </div>
        )}
      </div>
      <div
        aria-hidden
        className="pointer-events-none absolute inset-y-0 right-0 w-6 lg:hidden"
        style={{ background: 'linear-gradient(to right, transparent, var(--surface-raised))' }}
      />
    </div>
  );
```

(Re-indent the `<thead>`/`<tbody>`/`</table>` block by two spaces so it nests under the new inner div. The empty-state block moves inside the inner scroll div, before `</div>`.)

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/unit/data-table.test.tsx`
Expected: PASS (3 tests).

- [ ] **Step 7: Confirm no regressions in the wider suite**

Run: `npx vitest run`
Expected: PASS (all existing tests still green).

- [ ] **Step 8: Commit**

```bash
git add src/primitives/DataTable.tsx tests/unit/data-table.test.tsx
git commit -m "feat(primitives): DataTable horizontal scroll + nowrap cells + mobile scroll-fade"
```

---

## Phase 2 — Shell

### Task 2: Mobile drawer state in `AppShell`

**Files:**
- Modify: `src/shell/AppShell.tsx`

No new unit test (jsdom can't verify the overlay layout; behavior is verified in Task 3's test and via chrome-devtools). This task only wires state + props + padding.

- [ ] **Step 1: Add `mobileNavOpen` state**

In `AppShell`, the existing state line is `const [collapsed, setCollapsed] = useState(false);`. Add below it:

```tsx
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
```

- [ ] **Step 2: Pass drawer props to `Sidebar` and `TopBar`**

Replace the `<Sidebar .../>` element with:

```tsx
      <Sidebar
        activeId={ui.activeModuleId}
        onSelect={ui.setActiveModule}
        collapsed={collapsed}
        onToggle={() => setCollapsed((c) => !c)}
        mobileOpen={mobileNavOpen}
        onMobileClose={() => setMobileNavOpen(false)}
      />
```

Replace the `<TopBar .../>` element with:

```tsx
        <TopBar
          title={TITLES[active.id] ?? active.label}
          asOf={data?.snapshot.meta.asOf ?? ''}
          onOpenSearch={ui.openPalette}
          onOpenNav={() => setMobileNavOpen(true)}
        />
```

- [ ] **Step 3: Make main padding adapt to small screens**

The `<main>` is currently `className="flex-1 overflow-y-auto px-5 py-5"`. Change to:

```tsx
        <main className="flex-1 overflow-y-auto px-3 py-3 sm:px-4 lg:px-5 lg:py-5">
```

- [ ] **Step 4: Typecheck**

Run: `npx tsc --noEmit -p tsconfig.json`
Expected: FAIL — `Sidebar`/`TopBar` don't yet accept the new props. (Resolved in Tasks 3 & 4. This is an expected intermediate state; do not commit until Task 4.)

(No commit — Tasks 2–4 land together; `AppShell` doesn't typecheck until `Sidebar` and `TopBar` accept the new props. Commit at the end of Task 4.)

### Task 3: Drawer mode in `Sidebar`

**Files:**
- Modify: `src/shell/Sidebar.tsx`
- Test: `tests/unit/sidebar.test.tsx` (create)

**Background:** At `lg+` the sidebar stays the persistent rail it is today. Below `lg` it renders as a fixed off-canvas overlay (slides via translateX) with a backdrop scrim; tapping a nav item or the scrim closes it. The desktop collapse button is hidden in drawer mode.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/sidebar.test.tsx`:

```tsx
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { ViewProfileProvider } from '../../src/brain/view-profile';
import { Sidebar } from '../../src/shell/Sidebar';

beforeEach(() => localStorage.clear());

function setup(props: Partial<Parameters<typeof Sidebar>[0]> = {}) {
  const onSelect = vi.fn();
  const onMobileClose = vi.fn();
  render(
    <ViewProfileProvider>
      <Sidebar
        activeId="overview"
        onSelect={onSelect}
        collapsed={false}
        onToggle={vi.fn()}
        mobileOpen
        onMobileClose={onMobileClose}
        {...props}
      />
    </ViewProfileProvider>,
  );
  return { onSelect, onMobileClose };
}

describe('Sidebar drawer mode', () => {
  it('renders a scrim that closes the drawer when open', () => {
    const { onMobileClose } = setup();
    fireEvent.click(screen.getByLabelText(/close navigation/i));
    expect(onMobileClose).toHaveBeenCalled();
  });

  it('selecting a nav item also closes the drawer', () => {
    const { onSelect, onMobileClose } = setup();
    fireEvent.click(screen.getByRole('button', { name: /portfolio/i }));
    expect(onSelect).toHaveBeenCalled();
    expect(onMobileClose).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/sidebar.test.tsx`
Expected: FAIL — `Sidebar` does not accept `mobileOpen`/`onMobileClose` and renders no scrim.

- [ ] **Step 3: Extend the `Props` interface**

In `src/shell/Sidebar.tsx`, replace the `Props` interface:

```tsx
interface Props {
  activeId: string;
  onSelect: (id: string) => void;
  collapsed: boolean;
  onToggle: () => void;
  mobileOpen: boolean;
  onMobileClose: () => void;
}
```

- [ ] **Step 4: Consume the new props and add the scrim**

Replace the function signature line `export function Sidebar({ activeId, onSelect, collapsed, onToggle }: Props) {` with:

```tsx
export function Sidebar({ activeId, onSelect, collapsed, onToggle, mobileOpen, onMobileClose }: Props) {
```

Immediately inside, after `const width = collapsed ? 60 : 212;`, add a handler that closes the drawer when a module is picked:

```tsx
  const handleSelect = (id: string) => {
    onSelect(id);
    onMobileClose();
  };
```

Wrap the returned `<motion.aside>` so a scrim renders in front of content but the aside reflows responsively. Change the top of the return from:

```tsx
  return (
    <motion.aside
      animate={{ width }}
      transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
      className="relative z-20 flex h-dvh flex-col"
      style={{ background: 'var(--surface-rail)', borderRight: '1px solid var(--border-subtle)' }}
    >
```

to:

```tsx
  return (
    <>
      {mobileOpen && (
        <button
          aria-label="Close navigation"
          onClick={onMobileClose}
          className="fixed inset-0 z-30 bg-black/50 lg:hidden"
        />
      )}
      <motion.aside
        animate={{ width }}
        transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
        className={cn(
          'z-40 flex h-dvh flex-col lg:relative lg:z-20 lg:translate-x-0',
          'fixed inset-y-0 left-0 transition-transform duration-200',
          mobileOpen ? 'translate-x-0' : '-translate-x-full lg:translate-x-0',
        )}
        style={{ background: 'var(--surface-rail)', borderRight: '1px solid var(--border-subtle)' }}
      >
```

Close the fragment: the function currently ends with `</motion.aside>\n  );`. Change to:

```tsx
      </motion.aside>
    </>
  );
```

- [ ] **Step 5: Route nav clicks through `handleSelect` and hide collapse toggle in drawer**

In the `NavItem` mapping, change `onSelect={() => onSelect(m.id)}` to `onSelect={() => handleSelect(m.id)}`.

The collapse toggle `<button onClick={onToggle} ...>` at the bottom should not show in the mobile drawer (it controls the desktop rail width). Add `hidden lg:flex` to its className. Its current className is:

```tsx
        className="flex h-11 items-center gap-2.5 px-4 text-xs transition-colors"
```

Change to:

```tsx
        className="hidden h-11 items-center gap-2.5 px-4 text-xs transition-colors lg:flex"
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/unit/sidebar.test.tsx`
Expected: PASS (2 tests).

### Task 4: Hamburger + "More" popover in `TopBar`

**Files:**
- Modify: `src/shell/TopBar.tsx`
- Test: `tests/unit/topbar.test.tsx` (create)

**Background:** Add a hamburger (`lg:hidden`, far left) that calls `onOpenNav`. Move the three secondary controls (`ScenarioSwitch`, `DensityToggle`, `ThemeToggle`) into a "More" popover at `<lg`; keep **Ask**, **Refresh**, **StatusPill**, **ViewToggle** inline at all widths.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/topbar.test.tsx`:

```tsx
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { TopBar } from '../../src/shell/TopBar';

// TopBar pulls from several contexts; stub the hooks it calls directly.
vi.mock('../../src/data/brain-context', () => ({ useBrain: () => ({ refresh: vi.fn(), refreshing: false }) }));
vi.mock('../../src/brain/ui-context', () => ({ useUi: () => ({ toggleAi: vi.fn() }) }));
vi.mock('../../src/shell/ScenarioSwitch', () => ({ ScenarioSwitch: () => <div data-testid="scenario" /> }));
vi.mock('../../src/shell/ViewToggle', () => ({ ViewToggle: () => <div data-testid="view" /> }));
vi.mock('../../src/shell/ThemeToggle', () => ({ ThemeToggle: () => <div data-testid="theme" /> }));
vi.mock('../../src/shell/DensityToggle', () => ({ DensityToggle: () => <div data-testid="density" /> }));
vi.mock('../../src/primitives/StatusPill', () => ({ StatusPill: () => <div data-testid="status" /> }));

describe('TopBar mobile controls', () => {
  it('calls onOpenNav when the hamburger is clicked', () => {
    const onOpenNav = vi.fn();
    render(<TopBar title="Overview" asOf="" onOpenNav={onOpenNav} />);
    fireEvent.click(screen.getByLabelText(/open navigation/i));
    expect(onOpenNav).toHaveBeenCalled();
  });

  it('exposes a More button for secondary controls', () => {
    render(<TopBar title="Overview" asOf="" onOpenNav={vi.fn()} />);
    expect(screen.getByLabelText(/more controls/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/topbar.test.tsx`
Expected: FAIL — no `onOpenNav` prop, no hamburger, no "More" button.

- [ ] **Step 3: Add the `onOpenNav` prop and imports**

In `src/shell/TopBar.tsx`, add `Menu` and `MoreHorizontal` to the lucide import (currently `import { RefreshCw, Search, Sparkles } from 'lucide-react';`):

```tsx
import { RefreshCw, Search, Sparkles, Menu, MoreHorizontal } from 'lucide-react';
import { useState } from 'react';
```

Update the signature (currently `export function TopBar({ title, asOf, onOpenSearch }: { title: string; asOf: string; onOpenSearch?: () => void }) {`):

```tsx
export function TopBar({ title, asOf, onOpenSearch, onOpenNav }: { title: string; asOf: string; onOpenSearch?: () => void; onOpenNav?: () => void }) {
```

Add popover state at the top of the body, after the existing hooks:

```tsx
  const [moreOpen, setMoreOpen] = useState(false);
```

- [ ] **Step 4: Add the hamburger button**

The left cluster currently opens with `<div className="flex min-w-0 items-baseline gap-3">`. Wrap it so the hamburger sits before the title block. Replace that opening `<div ...>` and the `<h1>` start by inserting the hamburger immediately inside the outer `<header>`, before the title `<div>`:

```tsx
      <button
        onClick={onOpenNav}
        aria-label="Open navigation"
        className="grid h-8 w-8 shrink-0 place-items-center rounded-[var(--radius-sm)] lg:hidden"
        style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
      >
        <Menu size={16} />
      </button>
      <div className="flex min-w-0 items-baseline gap-3">
```

(The header is a flex row; the hamburger becomes its first child. Keep the existing `gap-4` on the header so spacing is consistent.)

- [ ] **Step 5: Split controls into always-inline vs. "More" popover**

In the right-hand control cluster (`<div className="flex items-center gap-2.5">`), keep the search button, Ask button, `ViewToggle`, `StatusPill`, and Refresh as they are. Wrap the three secondary controls so they show inline at `lg+` and collapse into a popover below `lg`.

Replace the trailing controls — currently:

```tsx
        <ViewToggle />
        <ScenarioSwitch />
        <StatusPill />

        <button
          onClick={refresh}
          ...
        </button>

        <DensityToggle />
        <ThemeToggle />
```

with:

```tsx
        <ViewToggle />
        <div className="hidden lg:contents"><ScenarioSwitch /></div>
        <StatusPill />

        <button
          onClick={refresh}
          aria-label="Refresh data"
          className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)]"
          style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
        >
          <motion.span
            animate={refreshing ? { rotate: 360 } : { rotate: 0 }}
            transition={refreshing ? { duration: 0.9, repeat: Infinity, ease: 'linear' } : { duration: 0.2 }}
            style={{ display: 'grid', placeItems: 'center' }}
          >
            <RefreshCw size={14} />
          </motion.span>
        </button>

        <div className="hidden lg:contents">
          <DensityToggle />
          <ThemeToggle />
        </div>

        <div className="relative lg:hidden">
          <button
            onClick={() => setMoreOpen((o) => !o)}
            aria-label="More controls"
            aria-expanded={moreOpen}
            className="grid h-8 w-8 place-items-center rounded-[var(--radius-sm)]"
            style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
          >
            <MoreHorizontal size={16} />
          </button>
          {moreOpen && (
            <>
              <button aria-hidden tabIndex={-1} className="fixed inset-0 z-30" onClick={() => setMoreOpen(false)} />
              <div
                className="absolute right-0 top-10 z-40 flex flex-col gap-2 rounded-[var(--radius-md)] p-3"
                style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', boxShadow: 'var(--shadow-card)' }}
              >
                <ScenarioSwitch />
                <div className="flex items-center gap-2.5">
                  <DensityToggle />
                  <ThemeToggle />
                </div>
              </div>
            </>
          )}
        </div>
```

Note: `lg:contents` makes the wrapper transparent to flex layout at `lg+` so spacing is unchanged on desktop; below `lg` the wrapper is `hidden` and the control lives in the popover instead.

- [ ] **Step 6: Run test to verify it passes**

Run: `npx vitest run tests/unit/topbar.test.tsx`
Expected: PASS (2 tests).

- [ ] **Step 7: Full typecheck + gate slice**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: PASS — `AppShell`, `Sidebar`, `TopBar` now agree on props; all tests green.

- [ ] **Step 8: Commit (Tasks 2–4 together)**

```bash
git add src/shell/AppShell.tsx src/shell/Sidebar.tsx src/shell/TopBar.tsx tests/unit/sidebar.test.tsx tests/unit/topbar.test.tsx
git commit -m "feat(shell): mobile drawer + hamburger + condensed TopBar below lg"
```

- [ ] **Step 9: Verify the shell with chrome-devtools**

Start the dev server (`npm run dev`), open the app, and use the chrome-devtools skill:
- Resize to 375px: sidebar is hidden, hamburger visible. Click hamburger → drawer slides in with scrim. Click a module → navigates and drawer closes. Click scrim → closes.
- Confirm TopBar shows Ask/Refresh/StatusPill/ViewToggle + a "More" (⋯) button; open it → ScenarioSwitch/Density/Theme present.
- Resize to 1024px: persistent rail returns, no hamburger, all controls inline, no "More" button.
Capture a 375px screenshot as proof.

---

## Phase 3 — Module touch-ups & verification

Most module grids are already responsive (`grid-cols-2 md:grid-cols-4` KPI rows, `grid-cols-1 xl:...` splits). Phase 3 applies the few real fixes and verifies every module at phone width. **No data/analytics edits.**

### Task 5: Targeted module markup fixes

**Files:**
- Modify: `src/modules/acquisitions/AcquisitionsModule.tsx`
- Modify: `src/modules/leases/LeasesModule.tsx`
- Modify: `src/modules/overview/OverviewModule.tsx`
- Modify: `src/modules/debt/DebtModule.tsx`
- Modify: `src/modules/health/HealthModule.tsx`

These are pure className changes; verification is visual (Task 6). No unit tests.

- [ ] **Step 1: Acquisitions — let the seed-pipeline banner wrap**

In `AcquisitionsModule.tsx` the intro row is `<div className="flex items-center gap-2">` (the Badge + "from firm memory" caption). On narrow screens the badge text + caption overflow. Change to:

```tsx
      <div className="flex flex-wrap items-center gap-2">
```

- [ ] **Step 2: Leases — make filter inputs full-width on phone**

In `LeasesModule.tsx` the filter bar (`<div className="flex flex-wrap items-center gap-2 px-4 py-2.5" ...>`) holds a search input and three selects with fixed widths. Make the search input and property select fill the row on phone, fixed on `sm+`.

Search input — currently `className={`${fieldCls} w-56 pl-7`}`. Change to:

```tsx
              className={`${fieldCls} w-full pl-7 sm:w-56`}
```

Wrap the search `<div className="relative">` to stretch on phone — change it to:

```tsx
          <div className="relative w-full sm:w-auto">
```

Property select — currently `className={`${fieldCls} max-w-44`}`. Change to:

```tsx
            className={`${fieldCls} w-full sm:w-auto sm:max-w-44`}
```

- [ ] **Step 3: Overview — improve tablet density**

In `OverviewModule.tsx` the widget grid is `grid grid-cols-1 gap-4 xl:grid-cols-2`. Add a `lg` step so half-widgets pair up on tablets:

```tsx
          <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
```

Apply the same change to the skeleton grid (`<div className="grid grid-cols-1 gap-4 xl:grid-cols-2">` in `OverviewSkeleton`):

```tsx
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
```

(`SortableWidget` uses `gridColumn: span === 'full' ? '1 / -1' : undefined`, which keeps full-width widgets spanning both columns at `lg` — no further change needed.)

- [ ] **Step 4: Debt — improve tablet density**

In `DebtModule.tsx` the chart split is `grid grid-cols-1 gap-4 xl:grid-cols-2`. Change to:

```tsx
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
```

- [ ] **Step 5: Health — improve tablet density**

In `HealthModule.tsx` the cards grid is `grid grid-cols-1 gap-4 xl:grid-cols-2`. Change to:

```tsx
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
```

- [ ] **Step 6: Typecheck + tests**

Run: `npx tsc --noEmit -p tsconfig.json && npx vitest run`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/modules/acquisitions/AcquisitionsModule.tsx src/modules/leases/LeasesModule.tsx src/modules/overview/OverviewModule.tsx src/modules/debt/DebtModule.tsx src/modules/health/HealthModule.tsx
git commit -m "fix(modules): wrap overflow rows, full-width mobile filters, lg grid density"
```

### Task 6: Per-module viewport verification

**Files:** none (verification only).

- [ ] **Step 1: Verify each module at 375px with chrome-devtools**

With `npm run dev` running, visit each module at 375px width and confirm: KPI rows reflow to 2-up; cards stack to one column; tables scroll horizontally (with the right-edge fade) instead of crushing; charts shrink to fit; no horizontal page overflow (only intended in-card table scroll); filter/toolbar rows wrap. Modules: overview, pipeline (acquisitions), portfolio, leases, debt, cash, insurance, market, relationships, tasks, documents, health, principal.

- [ ] **Step 2: Spot-check 768px**

Confirm tablet layout: 4-up KPIs where defined, `lg:grid-cols-2` pairs render, drawer still active below `lg` (768 < 1024), no overflow.

- [ ] **Step 3: Record any defects as follow-up steps**

If a module overflows or crushes, note the offending element and add a targeted className fix here, then re-verify. Capture a 375px screenshot of Portfolio (the densest table) and Overview as proof.

---

## Phase 4 — Finish

### Task 7: Green gate + bundle budget, then finish the branch

- [ ] **Step 1: Run the full gate**

Run: `npm run gate`
Expected: PASS (typecheck + lint + test + reconcile all green).

- [ ] **Step 2: Confirm the bundle budget holds**

Run: `npm run build && npm run check:bundle`
Expected: within budget (changes are markup/className-only; impact ≈ nil).

- [ ] **Step 3: Finish the development branch**

Invoke the superpowers:finishing-a-development-branch skill to choose merge/PR/cleanup for `feat/mobile-responsive`.

---

## Self-Review

**Spec coverage:**
- Shell drawer/overlay + hamburger → Tasks 2–4. ✓
- TopBar controls wrap/condense → Task 4 (More popover). ✓
- Main content padding adapts → Task 2 Step 3. ✓
- KPI grids reflow → already responsive; tablet density improved in Task 5; verified Task 6. ✓
- Wide tables scroll horizontally without breaking layout → Task 1. ✓
- Charts shrink gracefully → already width-aware (`useMeasure`); verified Task 6. ✓
- Overlay panels mobile-safe → confirmed out of scope in spec (already capped at viewport). ✓
- `npm run gate` green + bundle budget holds → Task 7. ✓
- Layout-only, no data/analytics changes → enforced per task. ✓
- chrome-devtools verification at phone widths → Tasks 4, 6. ✓

**Placeholder scan:** No TBD/TODO; every code step shows exact before/after. ✓

**Type consistency:** New `Sidebar` props `mobileOpen`/`onMobileClose` and `TopBar` prop `onOpenNav` are defined in Tasks 3–4 and consumed by `AppShell` in Task 2; `DataTable` `minWidth` defined and tested in Task 1. The intermediate non-compiling state between Tasks 2 and 4 is called out explicitly with a single combined commit. ✓
