# Mission-Control Consumers (PR-B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire the components that consume the Mission-Control token layer (merged as PR-A, `oxford-command-center#186`): severity glow, category color-coding, KpiStat drill-down, filter-bar affordances, Sidebar active-state, Badge shape, and a proposed fix for a known WCAG contrast gap.

**Architecture:** All work lands on 8 files across `src/primitives/`, `src/shell/`, `src/modules/overview/`, `src/modules/insights/`, and `src/tokens/theme.css`. No architect-owned files are touched (verified against `.claude/hooks/architect-owned.json`'s globs — none of `src/modules/**`, `src/shell/**`, `src/primitives/**`, `src/charts/**` match). Every task is independently reviewable; there is no PR-A-style "big bang" — each task's effect is additive polish on the already-live token layer.

**Tech Stack:** React 19, Tailwind v4 CSS-first tokens, `react-aria-components`, `framer-motion`, vitest + @testing-library/react.

## Global Constraints

- Token *names* stay fixed (established in PR-A) — this plan only wires new component behavior, never adds/renames tokens except the one flagged proposal in Task 10.
- Honesty doctrine (Spine A/B split, "Premium Above Median" labeling, unratified-weights badges) is out of scope — do not touch.
- Every new hover/glow/transform must be inert under `prefers-reduced-motion` — this repo already has a global reduced-motion kill-switch in `theme.css`'s `@media (prefers-reduced-motion: reduce)` block (covers `animation`/`transition` broadly); component-level `framer-motion` `animate` props need their own explicit guard since the CSS block doesn't reach inline JS-driven animation.
- **Ground-truth corrections found while planning, before any task started:**
  1. `src/charts/theme.ts`'s `SERIES` array is **already** in the DS-priority order (`accent, info, pos, accent2, warn, text-tertiary`) — PR-A's Task 9 fixed the one hardcoded fallback value in place, and the position already matched. **No reorder task exists in this plan — it's already done.**
  2. `Badge.tsx`'s `'gold'` `BadgeTone` is used in **18 files** (`grep -rl 'tone="gold"' src/` — TenantsModule, PortfolioModule, widgets.tsx, LeasesModule, lease-run-view.ts, PropertyIntelView, MappingsView, ImportsView, BenchmarksView, InsuranceModule, DocumentsModule, CashModule, CloseModule, GraderView, AcquisitionsModule, an archived module, EntityDrawer, AiPanel) — not "unreferenced" as the design spec assumed. Its `TONES.gold` definition already resolves through `var(--accent)` (confirmed in `Badge.tsx`), so it already renders the correct teal color today with zero code change. Renaming the `'gold'` literal across 18 call sites for a string that already produces the right color and has no visual bug is pure churn — **out of scope, not a task in this plan.**
  3. `InsightsModule.tsx` has the FilterPill pattern (line ~89); `OverviewModule.tsx` does **not** — the spec named both, only one actually has it.
  4. `KpiStripWidget()` (not "PortfolioKpis") in `src/modules/overview/widgets.tsx` renders the 8-KPI strip. Navigation uses `useUi().setActiveModule(id: string)` from `@/brain/ui-context` (confirmed real API, confirmed pattern in `src/shell/AlertBell.tsx:12`).

---

### Task 1: `categoryTone()` in `insights.logic.ts` (TDD)

**Files:**
- Modify: `src/modules/insights/insights.logic.ts`
- Test: `tests/unit/insights-category-tone.test.ts` (new)

**Interfaces:**
- Produces: `export function categoryTone(category: Insight['category']): BadgeTone` — consumed by Task 2 (`TierBoard`/`TierItem.categoryTone`) and by every place tiers are built (Insights, Overview, Alerts already share `mergeInsightSources`/`buildTiers`, so this one function threads everywhere automatically once Task 2 wires it in).

**Context:** `Insight['category']` is the real 10-value union confirmed in `CATEGORY_TO_FAMILY` (lines 84-95 of this file): `debt, deal, concentration, lease, occupancy, collections, insurance, cash, anomaly, data`. `BadgeTone` (from `src/primitives/Badge.tsx`) is `'neutral' | 'gold' | 'green' | 'amber' | 'red' | 'blue' | 'purple'`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/insights-category-tone.test.ts`:
```typescript
import { describe, it, expect } from 'vitest';
import { categoryTone } from '../../src/modules/insights/insights.logic';

describe('categoryTone', () => {
  it('maps every real Insight category to a real BadgeTone', () => {
    const expected: Record<string, string> = {
      debt: 'red',
      deal: 'blue',
      concentration: 'amber',
      lease: 'green',
      occupancy: 'green',
      collections: 'amber',
      insurance: 'blue',
      cash: 'green',
      anomaly: 'red',
      data: 'neutral',
    };
    for (const [category, tone] of Object.entries(expected)) {
      expect(categoryTone(category as never)).toBe(tone);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/insights-category-tone.test.ts`
Expected: FAIL — `categoryTone is not a function` (doesn't exist yet).

- [ ] **Step 3: Implement**

In `src/modules/insights/insights.logic.ts`, add near `CATEGORY_TO_FAMILY` (after its closing `};`, before the "Join spec" section comment):
```typescript
import type { BadgeTone } from '@/primitives/Badge';

// ── Category -> badge tone (severity/status color-coding, threaded through TierBoard) ───────
const CATEGORY_TONE: Record<Insight['category'], BadgeTone> = {
  debt: 'red',
  deal: 'blue',
  concentration: 'amber',
  lease: 'green',
  occupancy: 'green',
  collections: 'amber',
  insurance: 'blue',
  cash: 'green',
  anomaly: 'red',
  data: 'neutral',
};

export function categoryTone(category: Insight['category']): BadgeTone {
  return CATEGORY_TONE[category];
}
```
(Add the `import type { BadgeTone }` line to the top of the file's existing import block, not as a mid-file import — place it alphabetically among the existing imports.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/insights-category-tone.test.ts`
Expected: PASS, 1/1.

- [ ] **Step 5: Commit**

```bash
git add src/modules/insights/insights.logic.ts tests/unit/insights-category-tone.test.ts
git commit -m "feat(insights): add categoryTone() mapping the real 10-category taxonomy to BadgeTone"
```

---

### Task 2: `TierBoard.tsx` — `categoryTone` field, severity glow, category-colored badge

**Files:**
- Modify: `src/primitives/TierBoard.tsx`

**Interfaces:**
- Consumes: nothing new (this task adds the field; wiring real `categoryTone()` values into tier-building call sites is Task 2's own scope too, via the one shared `buildTiers()`/tier-construction path — see Step 3).
- Produces: `TierItem.categoryTone?: BadgeTone` — a new optional field every tier-building call site can populate.

**Current code** (relevant excerpts, full file already read in full during planning):
```typescript
export interface TierItem {
  id: string;
  rank?: number;
  category?: string;
  impactUsd?: number | null;
  impactKind?: 'gain' | 'risk' | 'info';
  title: string;
  detail?: string;
  action?: TierItemAction;
  actions?: TierItemAction[];
  chips?: string[];
  muted?: boolean;
}
```
Tier-header dot (line 102): `<span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />` — no glow.
Category badge (line 168): `{item.category && <Badge tone="neutral">{item.category}</Badge>}` — always neutral.

- [ ] **Step 1: Add the `categoryTone` field to `TierItem`**

```typescript
export interface TierItem {
  id: string;
  rank?: number;
  category?: string;
  categoryTone?: import('./Badge').BadgeTone;
  impactUsd?: number | null;
  impactKind?: 'gain' | 'risk' | 'info';
  title: string;
  detail?: string;
  action?: TierItemAction;
  /** Additional actions beyond the single primary `action` (e.g. a read toggle plus two snooze durations). */
  actions?: TierItemAction[];
  chips?: string[];
  /** De-emphasizes the card (e.g. an already-read alert) without removing it from the rank order. */
  muted?: boolean;
}
```
(Use the existing top-of-file `import { Badge } from './Badge';` — change the field to `categoryTone?: BadgeTone;` and add `type BadgeTone` to that same import line instead of an inline `import()` type — i.e. `import { Badge, type BadgeTone } from './Badge';`.)

- [ ] **Step 2: Render the real tone on the category badge**

Old (in `TierCard`):
```typescript
        {item.category && <Badge tone="neutral">{item.category}</Badge>}
```
New:
```typescript
        {item.category && <Badge tone={item.categoryTone ?? 'neutral'}>{item.category}</Badge>}
```

- [ ] **Step 3: Add severity glow to the tier-header dot**

A glow map keyed on `Tier['tone']`, matching the plan's spec: hot tones (`neg`/`pos`/`accent`) glow, cool/flat tones (`warn`/`info`/`accent2`) stay flat. Add near the existing `TONE_COLOR` map:

```typescript
const TONE_GLOW: Partial<Record<Tier['tone'], string>> = {
  neg: '0 0 8px var(--color-neg)',
  pos: '0 0 8px var(--color-pos)',
  accent: '0 0 8px var(--accent)',
};
```

In `TierColumn`, change the dot:

Old:
```typescript
        <span aria-hidden className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: color }} />
```
New:
```typescript
        <span
          aria-hidden
          className="h-2.5 w-2.5 shrink-0 rounded-full motion-reduce:shadow-none"
          style={{ background: color, boxShadow: TONE_GLOW[tier.tone] }}
        />
```
(`TONE_GLOW[tier.tone]` is `undefined` for warn/info/accent2 — `boxShadow: undefined` renders no shadow, so no conditional needed. `motion-reduce:shadow-none` is a Tailwind utility that a glow/shadow effect should respect — confirm during Step 5 verification that this actually suppresses the shadow under `prefers-reduced-motion`, since `box-shadow` isn't literally an "animation," so this repo's existing CSS-level reduced-motion block may not catch it; the explicit Tailwind variant is the correct belt-and-suspenders fix here.)

- [ ] **Step 4: Add hover lift + accent border to `TierCard`**

Old:
```typescript
    <li
      className="rounded-[var(--radius-md)] p-3"
      style={{
        background: 'var(--surface-overlay)',
        border: '1px solid var(--border-subtle)',
        opacity: item.muted ? 0.55 : 1,
      }}
    >
```
New:
```typescript
    <li
      className="group rounded-[var(--radius-md)] p-3 transition-[border-color,transform] duration-[120ms] motion-reduce:transition-none hover:-translate-y-px motion-reduce:hover:translate-y-0"
      style={{
        background: 'var(--surface-overlay)',
        border: '1px solid var(--border-subtle)',
        opacity: item.muted ? 0.55 : 1,
      }}
      onMouseEnter={(e) => { e.currentTarget.style.borderColor = 'color-mix(in oklab, var(--accent) 45%, transparent)'; }}
      onMouseLeave={(e) => { e.currentTarget.style.borderColor = 'var(--border-subtle)'; }}
    >
```
(Border-color hover is done via inline JS handlers, not a Tailwind/CSS `:hover` pseudo-class, because the border color is already set inline via `style` for the muted/base state — mixing an inline base value with a CSS-class hover override risks specificity fights. This matches how `Button.tsx` already handles hover state — via JS-driven style, not CSS pseudo-classes — so it's consistent with the codebase's existing pattern for this exact situation, not a new one.)

- [ ] **Step 5: Verify no unit test broke, and manually confirm reduced-motion suppression**

Run: `npx vitest run tests/unit/tier-board.test.tsx` (this file already exists per PR-A's status.json history — `fix-design-parity-p2-p3` entry — confirm it still passes with the new field/rendering).
Expected: PASS, no regressions (the new `categoryTone` field is optional, so existing test fixtures that don't set it still work — `?? 'neutral'` preserves old behavior when absent).

Then start `npm run dev`, open a screen using `TierBoard` (Overview or Insights), toggle `prefers-reduced-motion: reduce` via browser devtools rendering emulation, confirm the tier-dot glow and card hover lift both disappear. **Stop the dev server when done.**

- [ ] **Step 6: Commit**

```bash
git add src/primitives/TierBoard.tsx
git commit -m "feat(tierboard): categoryTone field, severity glow, hover lift (reduced-motion safe)"
```

---

### Task 3: `StatusPill.tsx` — glow for live/refreshing

**Files:**
- Modify: `src/primitives/StatusPill.tsx`

**Interfaces:** No signature change — purely visual.

**Current code** (full file, 47 lines, already read):
```typescript
      <span className="relative flex h-1.5 w-1.5">
        {animate && (
          <motion.span
            className="absolute inline-flex h-1.5 w-1.5 rounded-full"
            style={{ background: color }}
            animate={{ scale: [1, 2.6], opacity: [0.55, 0] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut' }}
          />
        )}
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      </span>
```
Note: this component already respects `isStill()` for the pulse ping animation (`const animate = (f.kind === 'live' || f.kind === 'refreshing') && !isStill();`) — the plan's "Respect `isStill()`" requirement is already satisfied by existing code; this task only adds the glow, gated the same way.

- [ ] **Step 1: Add glow to the static dot when live/refreshing**

Old:
```typescript
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: color }} />
```
New:
```typescript
        <span
          className="relative inline-flex h-1.5 w-1.5 rounded-full motion-reduce:shadow-none"
          style={{ background: color, boxShadow: animate ? `0 0 8px ${color}` : undefined }}
        />
```
(Reuses the existing `animate` boolean — already gated on `(live || refreshing) && !isStill()`, so the glow is static/offline-flat and reduced-motion-safe with zero new logic.)

- [ ] **Step 2: Verify no existing test broke**

Run: `grep -rln "StatusPill" tests/unit/` to find any test importing this component; run it if found. If none exists, run `npx tsc --noEmit` and confirm no type errors, and visually confirm via `npm run dev` (any screen showing the live-data status pill in the TopBar). **Stop the dev server when done.**

- [ ] **Step 3: Commit**

```bash
git add src/primitives/StatusPill.tsx
git commit -m "feat(statuspill): glow on live/refreshing dot, flat on static/offline"
```

---

### Task 4: `KpiStat.tsx` — remove 3px bar, add `onPress`/`href`, hover-lift + arrow

**Files:**
- Modify: `src/primitives/KpiStat.tsx`

**Interfaces:**
- Produces: `KpiStat` gains optional `onPress?: () => void` and `href?: string` props. When either is present, the whole card becomes interactive. `accentColor` keeps its existing meaning (sparkline color) — per the spec, the 3px bar is removed, not repurposed.
- Consumed by: Task 5 (`widgets.tsx`'s `KpiStripWidget`).

**Current code** (full file, 81 lines, already read). Key lines:
```typescript
interface Props {
  label: string;
  value: number | null;
  format: (n: number | null) => string;
  prov?: ProvenanceData;
  sublabel?: ReactNode;
  delta?: number | null;
  deltaLabel?: string;
  spark?: number[];
  sparkColor?: string;
  accentColor?: string;
}

export function KpiStat({
  label, value, format, prov, sublabel, delta, deltaLabel, spark, sparkColor,
  accentColor = 'var(--accent)',
}: Props) {
  const animated = useCountUp(value);
  const display = value === null ? '—' : format(animated);
  const deltaUp = (delta ?? 0) >= 0;

  return (
    <Card className="overflow-hidden">
      <span aria-hidden className="absolute left-0 top-0 h-full w-[3px]" style={{ background: accentColor, opacity: 0.85 }} />
      <div className="flex items-start justify-between gap-2 px-4 pt-3.5 pb-3.5 pl-5">
```

- [ ] **Step 1: Extend `Props` and remove the accent bar**

```typescript
interface Props {
  label: string;
  value: number | null;
  format: (n: number | null) => string;
  prov?: ProvenanceData;
  sublabel?: ReactNode;
  delta?: number | null;
  deltaLabel?: string;
  spark?: number[];
  sparkColor?: string;
  accentColor?: string;
  onPress?: () => void;
  href?: string;
}
```

Remove the accent-bar line entirely:
```typescript
      <span aria-hidden className="absolute left-0 top-0 h-full w-[3px]" style={{ background: accentColor, opacity: 0.85 }} />
```
(`accentColor` prop stays — it still feeds `sparkColor ?? accentColor` for the sparkline, per the interface's existing use at line 74 (`<Sparkline data={spark} color={sparkColor ?? accentColor} />`), which is unaffected by this removal.)

- [ ] **Step 2: Make the card interactive when `onPress`/`href` is present**

Import `ArrowUpRight` from `lucide-react` (already a dependency) and wrap the interactive affordance in. Full new function body:

```typescript
import type { ReactNode } from 'react';
import { TrendingUp, TrendingDown, ArrowUpRight } from 'lucide-react';
import type { Provenance as ProvenanceData } from '@contracts/index';
import { useCountUp } from '@/lib/useCountUp';
import { cn } from '@/lib/cn';
import { Card } from './Card';
import { Provenance } from './Provenance';
import { Sparkline } from '@/charts/Sparkline';

interface Props {
  label: string;
  value: number | null;
  format: (n: number | null) => string;
  prov?: ProvenanceData;
  sublabel?: ReactNode;
  delta?: number | null;
  deltaLabel?: string;
  spark?: number[];
  sparkColor?: string;
  accentColor?: string;
  onPress?: () => void;
  href?: string;
}

export function KpiStat({
  label,
  value,
  format,
  prov,
  sublabel,
  delta,
  deltaLabel,
  spark,
  sparkColor,
  accentColor = 'var(--accent)',
  onPress,
  href,
}: Props) {
  const animated = useCountUp(value);
  const display = value === null ? '—' : format(animated);
  const deltaUp = (delta ?? 0) >= 0;
  const interactive = Boolean(onPress || href);

  const content = (
    <>
      <div className="flex items-start justify-between gap-2 px-4 pt-3.5 pb-3.5">
        <div className="min-w-0">
          <div
            className="num text-2xs font-semibold uppercase"
            style={{ letterSpacing: '0.12em', color: 'var(--text-tertiary)' }}
          >
            {label}
          </div>
          <div
            className="num mt-2 text-2xl font-semibold leading-none"
            style={{ color: 'var(--text-primary)' }}
          >
            {prov ? <Provenance prov={prov}>{display}</Provenance> : display}
          </div>
          {(sublabel || delta != null) && (
            <div className="mt-2 flex items-center gap-2 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
              {delta != null && (
                <span
                  className="num inline-flex items-center gap-0.5 font-semibold"
                  style={{ color: deltaUp ? 'var(--color-pos)' : 'var(--color-neg)' }}
                >
                  {deltaUp ? <TrendingUp size={11} /> : <TrendingDown size={11} />}
                  {Math.abs(delta * 100).toFixed(1)}%
                </span>
              )}
              {deltaLabel && <span>{deltaLabel}</span>}
              {sublabel && <span className="truncate">{sublabel}</span>}
            </div>
          )}
        </div>
        {spark && spark.length > 1 && (
          <div className={cn('shrink-0 pt-1')}>
            <Sparkline data={spark} color={sparkColor ?? accentColor} />
          </div>
        )}
      </div>
      {interactive && (
        <ArrowUpRight
          size={13}
          aria-hidden
          className="absolute right-2.5 top-2.5 opacity-0 transition-opacity duration-[140ms] motion-reduce:transition-none group-hover:opacity-100"
          style={{ color: 'var(--accent)' }}
        />
      )}
    </>
  );

  if (!interactive) {
    return <Card className="overflow-hidden">{content}</Card>;
  }

  const interactiveProps = {
    className:
      'group relative block w-full overflow-hidden text-left transition-[transform,border-color] duration-[140ms] motion-reduce:transition-none hover:-translate-y-0.5 motion-reduce:hover:translate-y-0 cursor-pointer',
    style: { border: '1px solid transparent' } as const,
    onMouseEnter: (e: React.MouseEvent<HTMLElement>) => {
      e.currentTarget.style.borderColor = 'color-mix(in oklab, var(--accent) 45%, transparent)';
    },
    onMouseLeave: (e: React.MouseEvent<HTMLElement>) => {
      e.currentTarget.style.borderColor = 'transparent';
    },
  };

  return href ? (
    <Card as="a" href={href} {...interactiveProps}>
      {content}
    </Card>
  ) : (
    <Card as="button" onClick={onPress} {...interactiveProps}>
      {content}
    </Card>
  );
}
```

**Before implementing Step 2, read `src/primitives/Card.tsx` in full** to confirm it actually accepts an `as` prop (polymorphic component) and forwards arbitrary props (`href`, `onClick`, event handlers) to the rendered element — the `TierColumn` code in `TierBoard.tsx` already does `<Card as="section" ...>`, confirming `as` exists, but confirm the exact prop-forwarding behavior before trusting the `Card as="a"` / `Card as="button"` calls above compile and behave correctly. If `Card`'s `as` prop doesn't forward `href`/`onClick`/mouse-event props the way assumed here, adapt Step 2's code to match `Card`'s actual API — do not guess further, read the file.

- [ ] **Step 3: Write a test for the new interactive behavior**

Create `tests/unit/kpi-stat-interactive.test.tsx`:
```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { KpiStat } from '../../src/primitives/KpiStat';

afterEach(() => cleanup());

describe('KpiStat interactive mode', () => {
  it('is not interactive (no button/link role) when onPress/href are absent', () => {
    render(<KpiStat label="Static" value={100} format={(n) => String(n)} />);
    expect(screen.queryByRole('button')).toBeNull();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('calls onPress when clicked, and renders as a button', () => {
    const onPress = vi.fn();
    render(<KpiStat label="Clickable" value={100} format={(n) => String(n)} onPress={onPress} />);
    fireEvent.click(screen.getByRole('button'));
    expect(onPress).toHaveBeenCalledTimes(1);
  });

  it('renders as a link when href is provided', () => {
    render(<KpiStat label="Linked" value={100} format={(n) => String(n)} href="/portfolio" />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/portfolio');
  });
});
```

Run: `npx vitest run tests/unit/kpi-stat-interactive.test.tsx`
Expected: PASS, 3/3 (this is written after the implementation, so this is a verification run, not RED→GREEN TDD — the interactive-mode logic is simple prop-branching better verified as a whole than test-driven line by line; still real behavior assertions, not tautologies).

- [ ] **Step 4: Run the full existing KpiStat-adjacent test suite**

Run: `grep -rln "KpiStat" tests/unit/` and run every matching file to confirm no regression in existing consumers (Overview KPI strip tests, etc.).

- [ ] **Step 5: Commit**

```bash
git add src/primitives/KpiStat.tsx tests/unit/kpi-stat-interactive.test.tsx
git commit -m "feat(kpistat): remove 3px accent bar, add onPress/href interactive mode"
```

---

### Task 5: Wire `KpiStripWidget` drill-down navigation

**Files:**
- Modify: `src/modules/overview/widgets.tsx`

**Interfaces:**
- Consumes: `KpiStat`'s new `onPress` prop (Task 4), `useUi().setActiveModule(id: string)` from `@/brain/ui-context`.

**Current code** (`KpiStripWidget`, already read in full):
```typescript
function KpiStripWidget() {
  const { data } = useSnapshot();
  const { analytics } = useAnalytics();
  if (!data || !analytics) return null;
  const k = analytics.kpis;
  const cashSpark = data.snapshot.cash.history.map((h) => h.total);
  const last = cashSpark.at(-1) ?? 0;
  const prev = cashSpark.at(-2) ?? last;
  const cashDelta = prev ? (last - prev) / prev : null;
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <KpiStat label="Portfolio Value" value={k.value.value} format={fmtUsdCompact} prov={k.value.prov} sublabel={`${fmtNum(k.propertyCount.value)} properties`} />
      <KpiStat label="Net Operating Income" value={k.noi.value} format={fmtUsdCompact} prov={k.noi.prov} sublabel={`${fmtPct(k.weightedCapRate.value)} wtd cap`} accentColor="var(--color-pos)" />
      <KpiStat label="Portfolio SF" value={k.totalSf.value} format={fmtSf} prov={k.totalSf.prov} sublabel={`${fmtNum(k.tenantCount.value)} tenants`} accentColor="var(--color-info)" />
      <KpiStat label="Occupancy" value={k.occupancy.value === null ? null : k.occupancy.value * 100} format={(n) => (n === null ? '—' : `${n.toFixed(1)}%`)} prov={k.occupancy.prov} sublabel="weighted by SF" accentColor="var(--color-pos)" />
      <KpiStat label="WALT" value={k.walt.value} format={fmtYears} prov={k.walt.prov} sublabel="rent-weighted" accentColor="var(--color-accent2)" />
      <KpiStat label="Total Debt" value={k.totalDebt.value} format={fmtUsdCompact} prov={k.totalDebt.prov} sublabel={`${fmtPct(k.ltv.value)} LTV`} accentColor="var(--color-warn)" />
      <KpiStat label="Equity Invested" value={k.equityInvested.value} format={fmtUsdCompact} prov={k.equityInvested.prov} accentColor="var(--accent)" />
      <KpiStat label="Total Cash" value={k.totalCash.value} format={fmtUsdCompact} prov={k.totalCash.prov} spark={cashSpark} delta={cashDelta} deltaLabel="MoM" sparkColor="var(--color-pos)" accentColor="var(--color-pos)" />
    </div>
  );
}
```

Drill-down mapping (from the design spec, module ids confirmed real against `src/shell/modules.tsx`): Portfolio Value + Portfolio SF → `portfolio`; Net Operating Income → `intel`; Total Debt → `debt`; Total Cash → `cash`; WALT + Occupancy → `leases`. Equity Invested has no specified mapping — leave non-interactive.

- [ ] **Step 1: Add the `useUi` import and wire `onPress` on the 6 mapped KPIs**

```typescript
/* eslint-disable react-refresh/only-export-components -- colocated widget registry + components */
import type { ComponentType } from 'react';
import { useSnapshot, useAnalytics } from '@/data/queries';
import { useUi } from '@/brain/ui-context';
import { fmtUsdCompact, fmtSf, fmtPct, fmtYears, fmtNum } from '@analytics/index';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { Badge } from '@/primitives/Badge';
import { BarChart } from '@/charts/BarChart';
import { BarList } from '@/charts/BarList';
import { AreaChart } from '@/charts/AreaChart';
import { TierBoard, type Tier, type TierItem, type TierTotal } from '@/primitives/TierBoard';
import { useWarehouseInsights } from '../insights/hooks';
import { mergeInsightSources, buildSummary, buildTiers, totalsBySpine, type MergedInsight } from '../insights/insights.logic';

export interface WidgetDef {
  id: string;
  title: string;
  span: 'full' | 'half';
  Component: ComponentType;
}

function KpiStripWidget() {
  const { data } = useSnapshot();
  const { analytics } = useAnalytics();
  const ui = useUi();
  if (!data || !analytics) return null;
  const k = analytics.kpis;
  const cashSpark = data.snapshot.cash.history.map((h) => h.total);
  const last = cashSpark.at(-1) ?? 0;
  const prev = cashSpark.at(-2) ?? last;
  const cashDelta = prev ? (last - prev) / prev : null;
  const goTo = (id: string) => () => ui.setActiveModule(id);
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
      <KpiStat label="Portfolio Value" value={k.value.value} format={fmtUsdCompact} prov={k.value.prov} sublabel={`${fmtNum(k.propertyCount.value)} properties`} onPress={goTo('portfolio')} />
      <KpiStat label="Net Operating Income" value={k.noi.value} format={fmtUsdCompact} prov={k.noi.prov} sublabel={`${fmtPct(k.weightedCapRate.value)} wtd cap`} accentColor="var(--color-pos)" onPress={goTo('intel')} />
      <KpiStat label="Portfolio SF" value={k.totalSf.value} format={fmtSf} prov={k.totalSf.prov} sublabel={`${fmtNum(k.tenantCount.value)} tenants`} accentColor="var(--color-info)" onPress={goTo('portfolio')} />
      <KpiStat label="Occupancy" value={k.occupancy.value === null ? null : k.occupancy.value * 100} format={(n) => (n === null ? '—' : `${n.toFixed(1)}%`)} prov={k.occupancy.prov} sublabel="weighted by SF" accentColor="var(--color-pos)" onPress={goTo('leases')} />
      <KpiStat label="WALT" value={k.walt.value} format={fmtYears} prov={k.walt.prov} sublabel="rent-weighted" accentColor="var(--color-accent2)" onPress={goTo('leases')} />
      <KpiStat label="Total Debt" value={k.totalDebt.value} format={fmtUsdCompact} prov={k.totalDebt.prov} sublabel={`${fmtPct(k.ltv.value)} LTV`} accentColor="var(--color-warn)" onPress={goTo('debt')} />
      <KpiStat label="Equity Invested" value={k.equityInvested.value} format={fmtUsdCompact} prov={k.equityInvested.prov} accentColor="var(--accent)" />
      <KpiStat label="Total Cash" value={k.totalCash.value} format={fmtUsdCompact} prov={k.totalCash.prov} spark={cashSpark} delta={cashDelta} deltaLabel="MoM" sparkColor="var(--color-pos)" accentColor="var(--color-pos)" onPress={goTo('cash')} />
    </div>
  );
}
```
(`goTo` is a tiny curried helper so each `onPress` is a stable-enough inline closure without repeating `() => ui.setActiveModule('x')` eight times; this matches the file's existing terse-inline-JSX style, not a new pattern.)

- [ ] **Step 2: Write a test verifying the wiring**

Find the existing test file covering `KpiStripWidget` or the Overview module's widget registry (`grep -rln "KpiStripWidget\|KpiStat" tests/unit/overview*.test.tsx tests/unit/*widget*.test.tsx` — locate it; if `KpiStripWidget` isn't individually exported/tested today, add a focused test). Create/extend `tests/unit/overview-kpi-drilldown.test.tsx`:
```typescript
import { describe, it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
// Adjust these mock/provider imports to match the actual test setup used by
// existing overview widget tests (check tests/unit/overview-banner.test.tsx
// or similar for the real snapshot/analytics mocking pattern in this repo
// before writing this file — do not invent a different mocking approach).

afterEach(() => cleanup());

describe('KpiStripWidget drill-down', () => {
  it('clicking the Portfolio Value KPI navigates to the portfolio module', () => {
    // Render with a mocked useSnapshot/useAnalytics/useUi matching this
    // repo's real testing pattern, then:
    // fireEvent.click(screen.getByRole('button', { name: /portfolio value/i }));
    // expect(setActiveModule).toHaveBeenCalledWith('portfolio');
  });
});
```

**This step's exact mocking code cannot be written without first reading an existing overview-widget test file for the real `useSnapshot`/`useAnalytics` mock pattern this repo uses** (the plan author did not have one open during planning) — the task executor must read `tests/unit/overview-banner.test.tsx` (or equivalent, found via the grep above) FIRST, then write this test using that file's actual mocking approach, not the placeholder shown here. This is the one step in this plan that isn't fully pre-written — everything else is exact.

- [ ] **Step 3: Run the test and the full existing overview test suite**

Run: `npx vitest run tests/unit/overview-kpi-drilldown.test.tsx` (or wherever Step 2 lands it) and every existing `tests/unit/overview*.test.tsx` file, confirm all pass.

- [ ] **Step 4: Commit**

```bash
git add src/modules/overview/widgets.tsx tests/unit/overview-kpi-drilldown.test.tsx
git commit -m "feat(overview): wire KPI strip drill-down navigation to portfolio/intel/debt/cash/leases"
```

---

### Task 6: `Sidebar.tsx` — replace active pill with 3px left-edge bar

**Files:**
- Modify: `src/shell/Sidebar.tsx`

**Interfaces:** No signature change.

**Current code** (`NavItem`, already read in full):
```typescript
function NavItem({ module, active, collapsed, onSelect }: { module: ModuleDef; active: boolean; collapsed: boolean; onSelect: () => void }) {
  const Icon = module.icon;
  return (
    <li className="relative">
      {active && (
        <motion.span
          layoutId="nav-active"
          className="absolute inset-0 rounded-[var(--radius-sm)]"
          style={{ background: 'var(--accent-quiet)', border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)' }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        />
      )}
      <button
        onClick={onSelect}
        title={collapsed ? module.label : undefined}
        className={cn('relative z-10 flex w-full items-center gap-2.5 rounded-[var(--radius-sm)] px-2.5 py-2 text-sm transition-colors')}
        style={{ color: active ? 'var(--text-primary)' : 'var(--text-secondary)' }}
      >
        <Icon size={17} style={{ color: active ? 'var(--accent)' : 'currentColor', flexShrink: 0 }} />
        {!collapsed && <span className="truncate font-medium">{module.label}</span>}
      </button>
    </li>
  );
}
```

Per the design spec (§4, §5): replace the filled pill with a 3px left-edge bar (`boxShadow: 0 0 10px var(--accent)`, glow hidden under reduced motion but the bar itself stays). This is the spec's explicit recommendation, already presented to and not objected to by Gabriel in the original design review — proceeding per that recommendation (the alternative, keeping both pill and bar, was offered as a fallback only if Gabriel wanted it, and no such request has been made).

- [ ] **Step 1: Replace the active-indicator element**

Old:
```typescript
      {active && (
        <motion.span
          layoutId="nav-active"
          className="absolute inset-0 rounded-[var(--radius-sm)]"
          style={{ background: 'var(--accent-quiet)', border: '1px solid color-mix(in oklab, var(--accent) 30%, transparent)' }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        />
      )}
```
New:
```typescript
      {active && (
        <motion.span
          layoutId="nav-active"
          className="absolute inset-y-0.5 left-0 w-[3px] rounded-full motion-reduce:shadow-none"
          style={{ background: 'var(--accent)', boxShadow: '0 0 10px var(--accent)' }}
          transition={{ duration: 0.25, ease: [0.16, 1, 0.3, 1] }}
        />
      )}
```
(Keeps `layoutId="nav-active"` so `framer-motion` still animates the indicator sliding between nav items on selection change — only the visual shape/style changes, not the animation mechanism. `inset-y-0.5` insets the bar slightly from the item's top/bottom edge so it doesn't touch the row's full height edge-to-edge; adjust only if it looks visually wrong during Step 3's manual check, not preemptively.)

- [ ] **Step 2: Confirm the background/text color changes still read correctly without the old quiet-accent fill**

The `NavItem` button's own `style={{ color: active ? 'var(--text-primary)' : 'var(--text-secondary)' }}` and the icon's `color: active ? 'var(--accent)' : 'currentColor'` are UNCHANGED by this task — the active item still gets primary text color and an accent-colored icon, now paired with the left-bar instead of a background fill. This is intentional (matches the DS's bar-only active language) — do not add a background fill back in.

- [ ] **Step 3: Verify — existing test + manual check**

Run: `npx vitest run tests/unit/sidebar.test.tsx` (confirm the existing drawer/nav-selection tests still pass — they test `onSelect`/`onMobileClose` behavior, not the visual indicator, so should be unaffected).

Then `npm run dev`, navigate between a few sidebar items, confirm the left-bar slides between items smoothly, confirm it disappears (but the bar geometry, not the glow — check `boxShadow` specifically) under reduced-motion via devtools emulation. **Stop the dev server when done.**

- [ ] **Step 4: Commit**

```bash
git add src/shell/Sidebar.tsx
git commit -m "feat(sidebar): replace filled-pill active indicator with 3px accent left-edge bar"
```

---

### Task 7: `Badge.tsx` — square-ish radius

**Files:**
- Modify: `src/primitives/Badge.tsx`

**Interfaces:** No signature change — purely visual.

**Current code** (full file, 37 lines, already read). The one relevant line:
```typescript
      className={cn('num inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs font-semibold whitespace-nowrap', className)}
```

**Scope note (found during planning, see Global Constraints #2): the `'gold'` tone is NOT retired or renamed in this task** — it's used in 18 files and already resolves to the correct accent color via its existing `var(--accent)` reference; renaming or retiring it is out of scope (zero visual benefit, 18-file blast radius).

- [ ] **Step 1: Change the radius class**

Old:
```typescript
      className={cn('num inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-2xs font-semibold whitespace-nowrap', className)}
```
New:
```typescript
      className={cn('num inline-flex items-center gap-1.5 rounded-[var(--radius-xs)] px-2 py-0.5 text-2xs font-semibold whitespace-nowrap', className)}
```

- [ ] **Step 2: Grep for any call site that relies on `Badge` being visually pill-shaped for a specific reason (e.g. a "count bubble" use case)**

Run: `grep -rn "Badge" src/ --include="*.tsx" -l | xargs grep -ln "dot={true}\|dot\b"` to find any `dot` prop usage (the one Badge feature that's inherently circular-adjacent). Read a couple of hits to confirm changing the badge's own corner radius doesn't conflict with the `dot` indicator (a separate small circular span inside the badge, unaffected by the badge's own border-radius). Note: TierBoard's tier-header count bubble (`<span className="...rounded-full...">{tier.items.length}</span>`) is a **separate, bespoke `<span>`**, not the `Badge` component — confirmed during planning — so it is NOT affected by this change and stays pill-shaped as-is, correctly, with zero code change needed here.

- [ ] **Step 3: Verify — existing tests + visual check**

Run: `grep -rln "Badge" tests/unit/ | head -5` and run a sample of matching test files to confirm no snapshot/assertion depends on the exact class string. Then `npm run dev`, check a screen with several badges (e.g. Acquisitions tier badges, Leases status badges), confirm they read as squarish, not pill-shaped, in all three themes. **Stop the dev server when done.**

- [ ] **Step 4: Commit**

```bash
git add src/primitives/Badge.tsx
git commit -m "feat(badge): squarish radius per DS (radius-xs), matching signature Mission-Control shape"
```

---

### Task 8: `PortfolioFilterBar.tsx` + `AppShell.tsx` — filtered-state styling + slice readout

**Files:**
- Modify: `src/shell/PortfolioFilterBar.tsx`
- Modify: `src/shell/AppShell.tsx`

**Interfaces:**
- Produces: `PortfolioFilterBarProps` gains `slice?: { shown: number; total: number; noiUsd?: number }`.
- Consumes: `AppShell` already has `data` (from `useSnapshot()`) and can read the filter context — must compute `slice` from already-fetched data, no new fetching, per the spec's explicit constraint.

**Current code** (both files, already read in full).

**Before implementing, read `src/shell/PortfolioFilterContext.tsx` in full** to find the exact shape of `filter` state and how "how many properties does the current filter match" would actually be computed (does the context expose a filtered-properties list/count already, or does `AppShell` need to filter `data.snapshot.properties` itself using `filter.market`/`filter.propertyType`/`filter.manager`?). The plan author did not have this file open during planning — do not guess at the filtering logic; read the context file first, then implement Step 2 against its real API.

- [ ] **Step 1: Add filtered-state styling + `slice` prop to `PortfolioFilterBar`**

```typescript
import type { CSSProperties } from 'react';
import { Market, PropertyType } from '@contracts/index';
import { Button } from '@/primitives/Button';
import { usePortfolioFilter } from './PortfolioFilterContext';

const fieldCls = 'num h-8 rounded-[var(--radius-sm)] px-2.5 text-2xs outline-none';
const fieldStyle: CSSProperties = {
  background: 'color-mix(in oklab, var(--surface-overlay) 60%, transparent)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border-subtle)',
};
const fieldStyleSet: CSSProperties = {
  ...fieldStyle,
  border: '1px solid var(--accent)',
  color: 'var(--accent)',
};

export interface PortfolioFilterBarProps {
  /** Distinct property-manager names, computed by the mounting component from its
   *  already-fetched data (see PortfolioFilterContext.tsx for why this may be empty). */
  managers: string[];
  /** Display-only slice readout ("12 of 31 assets · $4.2M NOI"), computed by the
   *  mounting component from already-fetched data — no new fetching here. */
  slice?: { shown: number; total: number; noiUsd?: number };
}

export function PortfolioFilterBar({ managers, slice }: PortfolioFilterBarProps) {
  const { filter, setMarket, setType, setManager, clear } = usePortfolioFilter();
  const isFiltered = filter.market !== 'all' || filter.propertyType !== 'all' || filter.manager !== 'all';

  return (
    <div
      className="flex flex-wrap items-center gap-2 px-3 py-2 sm:px-4 lg:px-5"
      style={{
        borderBottom: `1px solid ${isFiltered ? 'color-mix(in oklab, var(--accent) 35%, transparent)' : 'var(--border-subtle)'}`,
        background: isFiltered ? 'var(--accent-quiet)' : 'var(--surface-base)',
      }}
    >
      <span className="num text-2xs uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>
        Portfolio filter
      </span>

      <select
        aria-label="Filter by market"
        value={filter.market}
        onChange={(e) => setMarket(e.target.value as Market | 'all')}
        className={fieldCls}
        style={filter.market !== 'all' ? fieldStyleSet : fieldStyle}
      >
        <option value="all">All markets</option>
        {Market.options.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>

      <select
        aria-label="Filter by property type"
        value={filter.propertyType}
        onChange={(e) => setType(e.target.value as PropertyType | 'all')}
        className={fieldCls}
        style={filter.propertyType !== 'all' ? fieldStyleSet : fieldStyle}
      >
        <option value="all">All types</option>
        {PropertyType.options.map((t) => (
          <option key={t} value={t}>
            {t}
          </option>
        ))}
      </select>

      <select
        aria-label="Filter by property manager"
        value={filter.manager}
        onChange={(e) => setManager(e.target.value)}
        className={fieldCls}
        style={filter.manager !== 'all' ? fieldStyleSet : fieldStyle}
      >
        <option value="all">All managers</option>
        {managers.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>

      {isFiltered && slice && (
        <span className="num ml-auto text-2xs" style={{ color: 'var(--text-secondary)' }}>
          {slice.shown} of {slice.total} assets
          {slice.noiUsd != null && ` · ${(slice.noiUsd / 1_000_000).toFixed(1)}M NOI`}
        </span>
      )}

      {isFiltered && (
        <Button size="sm" variant="ghost" onPress={clear} aria-label="Clear portfolio filter">
          Clear
        </Button>
      )}
    </div>
  );
}
```
(`ml-auto` on the slice readout only applies real right-alignment if the `Clear` button doesn't also claim `ml-auto` — verify visually in Step 3 that the readout and Clear button both land at the right edge as intended, adjust flex layout if they fight for the same auto-margin slot.)

- [ ] **Step 2: Compute `slice` in `AppShell` and pass it down**

Read `src/shell/PortfolioFilterContext.tsx` first (see note above), then implement the actual filtering logic in `AppShell.tsx` using that context's real filter-application method (it may already export a `filteredProperties` selector, or `AppShell` may need to filter `data.snapshot.properties` inline using `filter.market`/`filter.propertyType`/`filter.manager` — use whichever the context actually provides, do not duplicate filtering logic that already exists elsewhere).

Update the `<PortfolioFilterBar managers={NO_MANAGERS} />` call site to also pass `slice={...}`, computed from `data.snapshot.properties` (total count) vs. the filtered subset (shown count), and sum of NOI across the filtered subset if that figure is readily available from already-fetched `data`/`analytics` (do not add a new fetch or a new analytics computation just for this readout — if NOI-per-property isn't already available in the already-fetched snapshot, omit `noiUsd` from the `slice` object rather than computing it fresh).

- [ ] **Step 3: Verify**

Run: `npx vitest run` on any existing test file covering `PortfolioFilterBar` or `AppShell` (`grep -rln "PortfolioFilterBar\|AppShell" tests/unit/`). Then `npm run dev`, apply a market/type/manager filter, confirm the bar's background/border change to the accent-quiet treatment, the selected dropdown gets an accent border/text, and the slice readout appears with a plausible count. **Stop the dev server when done.**

- [ ] **Step 4: Commit**

```bash
git add src/shell/PortfolioFilterBar.tsx src/shell/AppShell.tsx
git commit -m "feat(filterbar): filtered-state accent styling, slice readout, active-select accent border"
```

---

### Task 9: `InsightsModule.tsx` — FilterPill radius + active-fill text color

**Files:**
- Modify: `src/modules/insights/InsightsModule.tsx`

**Interfaces:** No signature change.

**Current code** (relevant lines, already read):
```typescript
      className="num rounded-full px-3 py-1 text-2xs font-medium transition-colors"
      style={{
        background: active ? 'var(--accent)' : 'var(--surface-overlay)',
        color: active ? 'var(--surface-base)' : 'var(--text-secondary)',
```

**Note (found during planning):** the design spec named both `InsightsModule.tsx` and `OverviewModule.tsx` for this fix; `OverviewModule.tsx` has no matching `rounded-full` filter-pill pattern (confirmed via grep) — this task only touches `InsightsModule.tsx`.

- [ ] **Step 1: Fix the radius and the active-fill text color bug**

Old:
```typescript
      className="num rounded-full px-3 py-1 text-2xs font-medium transition-colors"
      style={{
        background: active ? 'var(--accent)' : 'var(--surface-overlay)',
        color: active ? 'var(--surface-base)' : 'var(--text-secondary)',
```
New:
```typescript
      className="num rounded-[var(--radius-sm)] px-3 py-1 text-2xs font-medium transition-colors"
      style={{
        background: active ? 'var(--accent)' : 'var(--surface-overlay)',
        color: active ? 'var(--text-on-accent)' : 'var(--text-secondary)',
```
(The `color: active ? 'var(--surface-base)' : ...` was a real, pre-existing bug independent of this retokenization — using a *background* token as active-state *text* color on top of an *accent* background happened to look plausible under Oxford Terminal's specific gold/navy values by coincidence, but is semantically wrong regardless of theme; `--text-on-accent` is the token designed for exactly this pairing.)

- [ ] **Step 2: Verify**

Run: `grep -rln "InsightsModule" tests/unit/` and run matching tests. Then `npm run dev`, open Insights, toggle a filter pill active/inactive, confirm the shape is squarish-rounded (not full pill) and the active-state text is legible against the accent fill in all 3 themes. **Stop the dev server when done.**

- [ ] **Step 3: Commit**

```bash
git add src/modules/insights/InsightsModule.tsx
git commit -m "fix(insights): filter pill radius + active-fill text color (was using --surface-base, a pre-existing bug)"
```

---

### Task 10: PROPOSAL — `--text-on-accent` WCAG AA fix for parchment/warm (flagged for review)

**Files:**
- Modify: `src/tokens/theme.css` (`[data-theme='parchment']` and `[data-theme='warm']` blocks only)

**⚠️ This task changes a value Gabriel has not seen or approved — it is the one item in this plan carrying a real, visible aesthetic change (white/cream text on teal-ish buttons becomes near-black text). Implement it, verify it rigorously, commit it on its own, but flag it prominently in the PR body as "needs your explicit look before merge" — do not bury it among the other 9 tasks' commits.**

**Context:** PR-A's final review found `--text-on-accent` fails WCAG AA (4.5:1) against saturated `--accent`/`--color-info`/`--color-neg` fills in the `parchment` and `warm` themes — reaching `Button.tsx`'s `primary` variant (the app's main CTA pattern), `theme.css`'s global `::selection` rule, `Sidebar.tsx`'s brand box, and now (this PR) `KpiStat`'s interactive hover arrow color context and `TierBoard`'s glow-adjacent badges. Current values: parchment `--text-on-accent: #ffffff`; warm `--text-on-accent: #fffdf8`. Both are near-white, failing against the medium-luminance saturated fills in those themes (command's `#06120f` near-black already passes broadly — this is the working reference pattern).

**Proposed fix (computed during planning, MUST be independently re-verified by the implementer with exact arithmetic before committing — treat the numbers below as a starting hypothesis, not a given):** flip `--text-on-accent` to a near-black value in both themes, matching command's successful pattern, rather than keeping it near-white.

- [ ] **Step 1: Compute exact WCAG contrast ratios for every real pairing, in both themes, for two candidate values**

For **parchment**, the real backgrounds `--text-on-accent` pairs against are: `--accent` (`#0e9e8e`), `--color-info` (`#2f7fd6`), `--color-neg` (`#d35338`), `--color-warn` (`#bd8311`) — all four are real consumer pairings (Button primary uses accent; TierBoard tier dots/badges use accent/info/neg/warn via `TONE_COLOR`; the Task 2 severity glow and Task 9 fixes in *this* plan use several of these too).

For **warm**, the same four: `--accent` (`#c2603c`), `--color-info` (`#2f6f6a`), `--color-neg` (`#c2603c`, identical to accent), `--color-warn` (`#b8881f`).

Using the standard WCAG relative-luminance formula (`L = 0.2126*R + 0.7152*G + 0.0722*B` on linearized sRGB channels; contrast `= (L1+0.05)/(L2+0.05)`), compute the contrast of a **near-black candidate** (start with `#0a0806` for parchment and `#1a1108` for warm — dark, near-neutral, NOT pure `#000000` so it doesn't feel harsh against a warm cream/off-white theme — or write a small script/use a browser devtools contrast checker to iterate if the starting candidate doesn't clear 4.5:1 on every pairing) against all four backgrounds in each theme. **Do not hand-wave this — write a short throwaway Node script using the formula above, or use a real contrast-checking tool, and get exact numbers for all 8 pairings (4 backgrounds × 2 themes).**

If the near-black candidate doesn't clear 4.5:1 on every single pairing, darken it further and recompute — iterate until all 8 pass, or until you conclude no single value can satisfy all 8 (in which case STOP and report back with the numbers; do not ship a partial fix silently, and do not invent per-consumer overrides without flagging that as a bigger architectural question).

- [ ] **Step 2: Apply the verified values**

Update `--text-on-accent` in `[data-theme='parchment']` and `[data-theme='warm']` in `src/tokens/theme.css` to the values verified in Step 1. Leave `[data-theme='command']`'s `--text-on-accent: #06120f` untouched (already verified passing).

- [ ] **Step 3: Full-repo verification this doesn't break anything visually degenerate**

Run `npm run build` (confirm no errors). Then `npm run dev`, switch to parchment theme, check: a primary `Button`, the `Sidebar` brand "O" box, a text selection (`::selection`), the new interactive `KpiStat` hover state (Task 4), a `TierBoard` tier badge in each of the four `TONE_COLOR` colors. Repeat for warm theme. Confirm text is legible (near-black on each saturated fill) and doesn't look jarring/low-contrast-in-the-other-direction (i.e., don't overshoot into a value so dark it looks like a rendering bug rather than an intentional design choice — this is a judgment call the implementer should apply reasonable taste to, and note in the report if genuinely unsure). **Stop the dev server when done.**

- [ ] **Step 4: Commit separately from every other task, with an explicit flag in the message**

```bash
git add src/tokens/theme.css
git commit -m "$(cat <<'EOF'
fix(theme): [NEEDS GABRIEL REVIEW] --text-on-accent AA fix, parchment+warm

Flips --text-on-accent from near-white to near-black in the parchment and
warm themes, matching the command theme's already-working pattern. Fixes a
real WCAG AA failure (~3.3-4.15:1, confirmed in PR-A's final review) that
reaches Button.tsx's primary variant, the global ::selection rule, Sidebar's
brand box, and every saturated-fill badge/dot introduced in this PR.

This is a real, visible aesthetic change (white text on teal buttons becomes
near-black) that Gabriel has not seen or approved -- flagged explicitly in
the PR body as needing his review before merge, not bundled silently among
this PR's other 9 tasks.

Exact contrast ratios computed and verified for all 8 real pairings
(4 saturated backgrounds x 2 themes) -- see commit body / PR description
for the numbers.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
EOF
)"
```
(Include the actual computed ratio table in the real commit body when this step executes — the placeholder above must be filled with real numbers, not left as a description of what to do.)

---

### Task 11: Full verification and PR

**Files:** none (verification only)

**Reminder from PR-A's own post-merge lesson:** if this task's brand/dependency check needs to grep for anything repo-wide, grep the WHOLE repo, not just `src/` — PR-A shipped a CI failure specifically because a sweep was scoped too narrowly.

- [ ] **Step 1: Full local test suite**

Run: `npm run test`
Expected: all tests pass, including every new test file from Tasks 1, 4, 5.

- [ ] **Step 2: Full gate**

Run: `npm run gate`
Expected: all 7 steps exit 0. If `npm run test`/`gate` crashes with an unexplained segfault (exit 139) partway through with zero `FAIL` markers in the output, that's the documented flaky teardown issue (memory: `feedback_npm_test_intermittent_access_violation.md`) — rerun once, don't debug the codebase for it.

- [ ] **Step 3: Bundle budget**

Run: `npm run check:bundle`
Expected: exits 0, entry bundle still under 250 kB gzip (this PR adds one icon import and some inline logic, not new dependencies — should not meaningfully move the needle from PR-A's 90.5 kB).

- [ ] **Step 4: Contrast/axe pass (this PR's actual scope for it, per spec §6)**

Run: `npm run test:e2e` if it includes an axe/contrast check reachable without a live server; if it requires `npm run dev` running, start it, run the check, then **stop the dev server**. Confirm the Task 10 fix (if the numbers from Task 10 Step 1 were verified correctly) means this pass is genuinely clean on the pairings this PR touches — this is the first point in either PR where the spec's own contrast requirement (§6) is actually exercised end-to-end.

- [ ] **Step 5: Update `architecture/status.json`**

Add a new top-level entry `mission-control-consumers` (sibling to `mission-control-retokenization`, which stays as its own historical "merged" record — do not edit that entry). Set `status: "review_needed"`, `review_needed: true`, and a `review_detail` that explicitly calls out Task 10 as needing Gabriel's visual sign-off separately from the rest. Validate JSON (`node -e "JSON.parse(require('fs').readFileSync('architecture/status.json','utf8'))"`) before committing.

- [ ] **Step 6: Push and open the PR**

```bash
git push -u origin design/mission-control-consumers
gh pr create --base main --title "feat(theme): Mission-Control consumers — PR-B (severity glow, categoryTone, KpiStat drill-down, filter bar, Sidebar bar, Badge shape)" --body "$(cat <<'EOF'
## Summary
- Wires the components that consume PR-A's Mission-Control token layer (#186, merged): severity glow (TierBoard/StatusPill), real categoryTone() color-coding (10-category taxonomy), KpiStat interactive drill-down (5 KPIs -> portfolio/intel/debt/cash/leases), PortfolioFilterBar filtered-state + slice readout, Sidebar 3px active bar (replacing the filled pill), Badge square-ish radius, InsightsModule filter-pill fixes.
- **One item needs your explicit look before merging:** a `--text-on-accent` WCAG contrast fix in `theme.css` (parchment/warm themes) — see the dedicated commit and PR comment below. Everything else is complete, tested, and gate-green.

## Corrections made during planning (verified against the live repo, not assumed)
- Chart series reorder: already done by PR-A's Task 9 fallback fix — no task needed.
- Badge's 'gold' tone: used in 18 files, not unreferenced as originally assumed — already resolves to the correct accent color via existing var() indirection, left alone (renaming would be 18-file churn for zero visual change).
- FilterPill fix only applies to InsightsModule.tsx — OverviewModule.tsx has no matching pattern.

## Test plan
- [ ] npm run gate green (all 7 steps)
- [ ] npm run check:bundle green
- [ ] npm run test:e2e contrast/axe pass green
- [ ] Manual: verify Task 10's text-on-accent change in parchment + warm themes specifically -- this is the item needing your sign-off

## Deferred
- Any further contrast auditing beyond the specific pairings this PR touches
EOF
)"
```

---

## Self-Review Notes (completed during plan authoring)

**Spec coverage:** severity glow (Task 2, 3) · categoryTone (Task 1, 2) · KpiStat anatomy + drill-down (Task 4, 5) · PortfolioFilterBar (Task 8) · Sidebar (Task 6) · Badge (Task 7) · FilterPill (Task 9) · chart series reorder (already done, documented in Global Constraints, no task) · contrast pass (Task 10, 11 Step 4). Every spec item is either a task or explicitly documented as already-satisfied.

**Placeholder scan:** one intentional exception, clearly labeled: Task 5 Step 2's test code is explicitly marked as needing the executor to read an existing test file first rather than guess a mocking pattern — this is not a placeholder left by oversight, it's a deliberate instruction because the plan author did not have that file's content available during planning. Task 8 similarly requires reading `PortfolioFilterContext.tsx` first. Both are flagged inline, not silently assumed.

**Type consistency:** `BadgeTone` imported consistently (`Badge.tsx` is the source, `TierBoard.tsx` and `insights.logic.ts` both import the type from there, not redefining it). `categoryTone()`'s return type and `TierItem.categoryTone`'s type are the same `BadgeTone`. Module ids used in Task 5 (`portfolio`, `intel`, `debt`, `cash`, `leases`) match `src/shell/modules.tsx` exactly (verified in PR-A's planning, re-confirmed unchanged by this PR).
