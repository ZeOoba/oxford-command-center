# Mission-Control Tokens (PR-A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Retokenize `oxford-command-center`'s token layer from "Oxford Terminal" (navy/gold, EB Garamond + DM Sans) to the ORA Mission-Control design system (teal/IBM Plex Sans/Bricolage Grotesque/Public Sans, 3 themes), without changing any token *names* components already consume.

**Architecture:** All work lands on `src/tokens/theme.css`, `package.json`, `src/lib/theme.ts`, `src/shell/ThemeToggle.tsx`, and 4 files with retired-token leftovers. Because token names are fixed, this single PR flips the entire app's look immediately on merge — no follow-up PR is required for the palette itself (PR-B, separate scope, adds new *component behavior* like severity glow and category coloring on top of this).

**Tech Stack:** Tailwind v4 CSS-first tokens (`@theme` + per-`[data-theme]` overrides), Fontsource self-hosted fonts, vitest + @testing-library/react for logic tests.

## Global Constraints

- Token *names* must not change — only values. Grep-verify no consumer references a removed name.
- No CDN font imports — Fontsource packages only, self-hosted (established convention: `src/tokens/theme.css` today, 100% Fontsource; `docs/design-handoff-cut-list-reconciliation.md` C7 rejects CDN loading).
- `package.json` is architect-owned (`.claude/hooks/architect-owned.json`, CLAUDE.md §4) — Gabriel acknowledged this touch in-session 2026-07-08T21:20:16Z (recorded in `architecture/status.json`), but `.claude/hooks/file-guard.mjs` additionally requires a **fresh** `.claude/overrides/architect-edit-ok` sentinel touch (60-minute TTL) immediately before the `package.json` edit in Task 1 — do this right before that edit, not earlier.
- Exact hex/value crosswalk is in `docs/superpowers/specs/2026-07-08-mission-control-retokenization-design.md` §3.4 — this plan copies from it verbatim; do not re-derive values from `ora.css` independently.
- `npm run gate` (governance → typecheck → lint → test → reconcile → warehouse:verify → warehouse:drift) and `npm run check:bundle` must be green before the final commit.
- PR-B (severity glow, categoryTone, KpiStat drill-down, PortfolioFilterBar, Sidebar active-bar, Badge shape, chart series reorder) is explicitly OUT OF SCOPE for this plan.

---

### Task 1: Font dependency swap (`package.json`)

**Files:**
- Modify: `package.json` (dependencies section, alphabetically sorted — insert new entries in place, remove old ones)

**Interfaces:**
- Produces: `@fontsource/ibm-plex-sans`, `@fontsource-variable/bricolage-grotesque`, `@fontsource-variable/public-sans` importable from `src/tokens/theme.css` (Task 4).

**Context:** Current `package.json` has FOUR old-font packages, not two — both the variable AND non-variable EB Garamond/DM Sans packages are present, but only the variable ones (`@fontsource-variable/eb-garamond`, `@fontsource-variable/dm-sans`) are actually imported anywhere (verified via `grep -rn "@fontsource/dm-sans\|@fontsource/eb-garamond" src/` — zero hits). The non-variable `@fontsource/dm-sans` and `@fontsource/eb-garamond` are already-dead dependencies; remove all four as part of this same retirement rather than leaving two of them orphaned.

Verified real npm packages (checked via `npm view <pkg> version` 2026-07-08): `@fontsource/ibm-plex-sans@5.2.8`, `@fontsource-variable/bricolage-grotesque@5.2.10`, `@fontsource-variable/public-sans@5.2.7`.

- [ ] **Step 1: Touch the architect-ack sentinel (fresh, right before editing)**

```bash
mkdir -p .claude/overrides && touch .claude/overrides/architect-edit-ok
```

- [ ] **Step 2: Edit `package.json` dependencies**

Remove these four lines:
```json
    "@fontsource-variable/dm-sans": "^5.2.8",
    "@fontsource-variable/eb-garamond": "^5.2.7",
    "@fontsource/dm-sans": "^5.2.8",
    "@fontsource/eb-garamond": "^5.2.7",
```

Add these three lines in their place (keep alphabetical order relative to surrounding entries):
```json
    "@fontsource-variable/bricolage-grotesque": "^5.2.10",
    "@fontsource-variable/public-sans": "^5.2.7",
    "@fontsource/ibm-plex-sans": "^5.2.8",
```

(`@fontsource/ibm-plex-mono` stays untouched — still needed.)

- [ ] **Step 3: Install and verify the lockfile updates**

Run: `npm install`
Expected: exits 0, `package-lock.json` shows the 4 removed / 3 added packages, no peer-dependency errors.

- [ ] **Step 4: Verify no other file still imports the removed packages**

Run: `grep -rn "eb-garamond\|dm-sans" src/ package.json`
Expected: no matches (theme.css's imports are removed in Task 4, which must land before this check is meaningful for `src/` — for now this step just confirms `package.json` itself and any other stray reference; theme.css will still reference them until Task 4, that's expected and fine at this point in the task order).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore(fonts): swap Garamond/DM Sans for IBM Plex Sans/Bricolage/Public Sans"
```

---

### Task 2: `theme.ts` — add `'warm'` to the `Theme` type (TDD)

**Files:**
- Modify: `src/lib/theme.ts`
- Test: `tests/unit/theme.test.ts` (new)

**Interfaces:**
- Consumes: nothing new.
- Produces: `Theme = 'command' | 'parchment' | 'warm'`, `getInitialTheme(): Theme`, `applyTheme(theme: Theme): void` — both functions keep their existing signatures; `ThemeToggle` (Task 3) consumes these.

**Current code** (`src/lib/theme.ts`, full file, 22 lines):
```typescript
export type Theme = 'command' | 'parchment';

const KEY = 'ora-theme';

export function getInitialTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'command' || t === 'parchment') return t;
  } catch {
    /* storage unavailable */
  }
  return 'command';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable */
  }
}
```

- [ ] **Step 1: Write the failing test**

Create `tests/unit/theme.test.ts`:
```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { getInitialTheme, applyTheme } from '../../src/lib/theme';

beforeEach(() => localStorage.clear());

describe('theme persistence', () => {
  it('getInitialTheme returns "warm" when localStorage has it', () => {
    localStorage.setItem('ora-theme', 'warm');
    expect(getInitialTheme()).toBe('warm');
  });

  it('getInitialTheme falls back to "command" for an unrecognized value', () => {
    localStorage.setItem('ora-theme', 'garbage');
    expect(getInitialTheme()).toBe('command');
  });

  it('applyTheme sets data-theme="warm" and persists it', () => {
    applyTheme('warm');
    expect(document.documentElement.getAttribute('data-theme')).toBe('warm');
    expect(localStorage.getItem('ora-theme')).toBe('warm');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/theme.test.ts`
Expected: FAIL — `getInitialTheme returns "warm"...` fails because `t === 'command' || t === 'parchment'` excludes `'warm'`, so it falls through to `return 'command'`.

- [ ] **Step 3: Implement the fix**

Replace the full contents of `src/lib/theme.ts`:
```typescript
export type Theme = 'command' | 'parchment' | 'warm';

const KEY = 'ora-theme';

export function getInitialTheme(): Theme {
  try {
    const t = localStorage.getItem(KEY);
    if (t === 'command' || t === 'parchment' || t === 'warm') return t;
  } catch {
    /* storage unavailable */
  }
  return 'command';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.setAttribute('data-theme', theme);
  try {
    localStorage.setItem(KEY, theme);
  } catch {
    /* storage unavailable */
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/theme.test.ts`
Expected: PASS, 3/3.

- [ ] **Step 5: Commit**

```bash
git add src/lib/theme.ts tests/unit/theme.test.ts
git commit -m "feat(theme): add warm as a valid persisted theme value"
```

---

### Task 3: `ThemeToggle.tsx` — 3-way cycle (TDD)

**Files:**
- Modify: `src/shell/ThemeToggle.tsx`
- Test: `tests/unit/theme-toggle.test.tsx` (new)

**Interfaces:**
- Consumes: `Theme`, `getInitialTheme`, `applyTheme` from `src/lib/theme.ts` (Task 2).
- Produces: `ThemeToggle` component, unchanged export name/shape (no props), used by `AppShell`/`Sidebar` wherever it's currently rendered — no caller changes needed since the signature doesn't change.

**Current code** (`src/shell/ThemeToggle.tsx`, full file, 18 lines):
```typescript
import { useState } from 'react';
import { Sun, Moon } from 'lucide-react';
import { Button } from '@/primitives/Button';
import { applyTheme, getInitialTheme, type Theme } from '@/lib/theme';

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const toggle = () => {
    const next: Theme = theme === 'command' ? 'parchment' : 'command';
    applyTheme(next);
    setTheme(next);
  };
  return (
    <Button variant="ghost" size="sm" aria-label="Toggle theme" onPress={toggle}>
      {theme === 'command' ? <Moon size={15} /> : <Sun size={15} />}
    </Button>
  );
}
```

Cycle order: `command` → `parchment` → `warm` → `command`. Icons: Moon (command), Sun (parchment), Sunset (warm) — all three exist in `lucide-react` (already a dependency, confirmed via the existing `Sun`/`Moon` imports).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/theme-toggle.test.tsx`:
```typescript
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ThemeToggle } from '../../src/shell/ThemeToggle';

beforeEach(() => localStorage.clear());
afterEach(() => cleanup());

describe('ThemeToggle 3-way cycle', () => {
  it('cycles command -> parchment -> warm -> command on repeated clicks', () => {
    render(<ThemeToggle />);
    const btn = screen.getByLabelText(/toggle theme/i);

    expect(document.documentElement.getAttribute('data-theme')).toBe(null);

    fireEvent.click(btn);
    expect(document.documentElement.getAttribute('data-theme')).toBe('parchment');

    fireEvent.click(btn);
    expect(document.documentElement.getAttribute('data-theme')).toBe('warm');

    fireEvent.click(btn);
    expect(document.documentElement.getAttribute('data-theme')).toBe('command');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/theme-toggle.test.tsx`
Expected: FAIL at the second assertion — current code only toggles command↔parchment, so after the first click it's `parchment` (passes), but the second click returns to `command`, not `warm`.

- [ ] **Step 3: Implement the 3-way cycle**

Replace the full contents of `src/shell/ThemeToggle.tsx`:
```typescript
import { useState } from 'react';
import { Moon, Sun, Sunset } from 'lucide-react';
import { Button } from '@/primitives/Button';
import { applyTheme, getInitialTheme, type Theme } from '@/lib/theme';

const NEXT: Record<Theme, Theme> = {
  command: 'parchment',
  parchment: 'warm',
  warm: 'command',
};

const ICON: Record<Theme, typeof Moon> = {
  command: Moon,
  parchment: Sun,
  warm: Sunset,
};

export function ThemeToggle() {
  const [theme, setTheme] = useState<Theme>(getInitialTheme);
  const toggle = () => {
    const next = NEXT[theme];
    applyTheme(next);
    setTheme(next);
  };
  const Icon = ICON[theme];
  return (
    <Button variant="ghost" size="sm" aria-label="Toggle theme" onPress={toggle}>
      <Icon size={15} />
    </Button>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/theme-toggle.test.tsx`
Expected: PASS, 1/1.

- [ ] **Step 5: Commit**

```bash
git add src/shell/ThemeToggle.tsx tests/unit/theme-toggle.test.tsx
git commit -m "feat(theme): 3-way ThemeToggle cycle (command -> parchment -> warm)"
```

---

### Task 4: `theme.css` — fonts, `@theme` tokens, default radii

**Files:**
- Modify: `src/tokens/theme.css:1-73` (imports + `@theme` block only — theme-specific blocks are Tasks 5-7)

**Interfaces:**
- Consumes: font packages from Task 1.
- Produces: `--font-ui`, `--font-display`, `--font-mono`, `--disp-weight`, `--disp-tracking`, `--radius-xs/sm/md/lg/xl` as defaults consumed by every component and by the `command`/`parchment` theme blocks (Tasks 5-6, which do not override radius or font tokens) and overridden by the `warm` block (Task 7).

Values are copied verbatim from `docs/superpowers/specs/2026-07-08-mission-control-retokenization-design.md` §3.1 (radii) and §3 point 2 (fonts): command/parchment radii = ora.css root values exactly (sm 7px/md 11px/lg 12px) plus derived xs/xl (xs = sm−2 = 5px, xl = lg+6 = 18px, since ora.css defines no xs/xl under any theme).

- [ ] **Step 1: Replace the font imports (lines 1-8)**

Old:
```css
@import 'tailwindcss';

/* Self-hosted variable fonts (Fontsource — no runtime CDN) */
@import '@fontsource-variable/eb-garamond';
@import '@fontsource-variable/dm-sans';
@import '@fontsource/ibm-plex-mono/400.css';
@import '@fontsource/ibm-plex-mono/500.css';
@import '@fontsource/ibm-plex-mono/600.css';
```

New:
```css
@import 'tailwindcss';

/* Self-hosted fonts (Fontsource — no runtime CDN) */
@import '@fontsource/ibm-plex-sans/400.css';
@import '@fontsource/ibm-plex-sans/500.css';
@import '@fontsource/ibm-plex-sans/600.css';
@import '@fontsource/ibm-plex-sans/700.css';
@import '@fontsource-variable/bricolage-grotesque';
@import '@fontsource-variable/public-sans';
@import '@fontsource/ibm-plex-mono/400.css';
@import '@fontsource/ibm-plex-mono/500.css';
@import '@fontsource/ibm-plex-mono/600.css';
```

- [ ] **Step 2: Update the header comment (lines 10-15)**

Old:
```css
/*
  THE OXFORD TERMINAL — design tokens
  Institutional-terminal density with editorial calm.
  Default theme = "command" (OLED-near black). Light = "parchment".
  Tailwind v4 CSS-first: tokens exposed as utilities via @theme.
*/
```

New:
```css
/*
  ORA MISSION CONTROL — design tokens
  Institutional-terminal density with editorial calm.
  Default theme = "command" (dark). Light = "parchment". Editorial = "warm".
  Tailwind v4 CSS-first: tokens exposed as utilities via @theme.
*/
```

- [ ] **Step 3: Remove the retired brand-spine tokens (lines 17-32)**

Delete entirely:
```css
  /* Brand spine */
  --color-navy-950: #05070d;
  --color-navy-900: #0a1322;
  --color-navy-850: #0d1b2a;
  --color-navy-800: #12233a;
  --color-navy-700: #1b2a4a;
  --color-navy-600: #243a5e;

  --color-gold-300: #e6d3a3;
  --color-gold-400: #d8bd7e;
  --color-gold-500: #c9a96e;
  --color-gold-600: #b7944f;

  --color-parchment-50: #faf7f0;
  --color-parchment-100: #f5f0e8;
  --color-parchment-200: #e9e0d0;

  /* Semantic */
  --color-pos: #3fb27f;
  --color-pos-soft: #163a2c;
  --color-warn: #d9a441;
  --color-warn-soft: #3a2e15;
  --color-neg: #e0564f;
  --color-neg-soft: #3a1a18;
  --color-info: #5b8fd6;
  --color-accent2: #9a7fd1;
```

(The `--color-pos/warn/neg` + soft variants move to per-theme blocks in Tasks 5-7, per the spec's own note that these differ per theme now. `--color-info`/`--color-accent2` also move per-theme in Tasks 5-7 for consistency, since ora.css defines distinct blue/violet per theme too.)

- [ ] **Step 4: Replace typography tokens (formerly lines 44-47)**

Old:
```css
  /* Typography */
  --font-display: 'EB Garamond Variable', Georgia, serif;
  --font-ui: 'DM Sans Variable', system-ui, sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, 'SFMono-Regular', monospace;
```

New:
```css
  /* Typography (defaults for command/parchment; warm overrides below) */
  --font-ui: 'IBM Plex Sans', system-ui, sans-serif;
  --font-display: 'IBM Plex Sans', system-ui, sans-serif;
  --font-mono: 'IBM Plex Mono', ui-monospace, 'SFMono-Regular', monospace;
  --disp-weight: 600;
  --disp-tracking: 0.04em;
```

- [ ] **Step 5: Replace radius tokens (formerly lines 60-65)**

Old:
```css
  /* Radius */
  --radius-xs: 4px;
  --radius-sm: 6px;
  --radius-md: 9px;
  --radius-lg: 13px;
  --radius-xl: 18px;
```

New:
```css
  /* Radius (defaults for command/parchment; warm overrides below) */
  --radius-xs: 5px;
  --radius-sm: 7px;
  --radius-md: 11px;
  --radius-lg: 12px;
  --radius-xl: 18px;
```

- [ ] **Step 6: Verify build doesn't break (theme blocks still reference now-removed tokens at this point — expected, fixed in Tasks 5-7)**

Run: `npx tsc --noEmit`
Expected: PASS (this task only touches CSS; TypeScript is unaffected). Do NOT run `npm run build` yet — `[data-theme='command']`/`[data-theme='parchment']` still reference `var(--color-gold-500)` etc. which no longer exist until Tasks 5-6 land; Vite will still build (unresolved CSS custom properties don't fail a build, they just resolve to nothing at runtime), but visually broken until Task 6 completes. This is expected mid-task state.

- [ ] **Step 7: Commit**

```bash
git add src/tokens/theme.css
git commit -m "feat(theme): swap fonts to IBM Plex Sans + radii to Mission-Control scale"
```

---

### Task 5: `theme.css` — `command` theme block

**Files:**
- Modify: `src/tokens/theme.css` (the `[data-theme='command']` block, formerly lines 75-96)

**Interfaces:**
- Consumes: nothing new.
- Produces: every `--surface-*`, `--border-*`, `--text-*`, `--accent*`, `--color-*`, `--grid-line`, `--shadow-card`, `--glow-accent`, `--overlay-wash` token PR-B's consumers will read at runtime.

Values copied verbatim from spec §3.4's "command" column.

- [ ] **Step 1: Replace the `[data-theme='command']` block**

Old:
```css
/* ── COMMAND (dark) — default ── */
[data-theme='command'] {
  --surface-base: #05070d;
  --surface-sunken: #04060b;
  --surface-raised: #0b1424;
  --surface-overlay: #0e1a2e;
  --surface-rail: #070d18;
  --border-subtle: color-mix(in oklab, #3a4a66 26%, transparent);
  --border-strong: color-mix(in oklab, #54678a 40%, transparent);
  --text-primary: #eef2f8;
  --text-secondary: #9fb0c8;
  --text-tertiary: #66788f;
  --text-on-accent: #0a1322;
  --accent: var(--color-gold-500);
  --accent-quiet: color-mix(in oklab, var(--color-gold-500) 16%, transparent);
  --grid-line: color-mix(in oklab, #3a4a66 22%, transparent);
  --shadow-card: 0 1px 0 0 color-mix(in oklab, #ffffff 5%, transparent) inset,
    0 12px 30px -16px rgba(0, 0, 0, 0.7);
  --glow-accent: 0 0 0 1px color-mix(in oklab, var(--color-gold-500) 40%, transparent),
    0 0 22px -6px color-mix(in oklab, var(--color-gold-500) 55%, transparent);
  color-scheme: dark;
}
```

New:
```css
/* ── COMMAND (dark) — default ── */
[data-theme='command'] {
  --surface-base: #0c0f14;
  --surface-sunken: #0b1016;
  --surface-raised: #141a22;
  --surface-overlay: #171f29;
  --surface-rail: #0f141b;
  --border-subtle: #222c38;
  --border-strong: color-mix(in oklab, #222c38 60%, #6b7888 40%);
  --grid-line: #1b2531;
  --text-primary: #e8edf3;
  --text-secondary: #aab6c4;
  --text-tertiary: #6b7888;
  --text-on-accent: #06120f;
  --accent: #39d3c0;
  --accent-quiet: rgba(57, 211, 192, 0.09);
  --color-pos: #54d49a;
  --color-pos-soft: rgba(84, 212, 154, 0.12);
  --color-warn: #f4b740;
  --color-warn-soft: rgba(244, 183, 64, 0.12);
  --color-neg: #f06a4d;
  --color-neg-soft: rgba(240, 106, 77, 0.12);
  --color-info: #5aa7f0;
  --color-accent2: #a98cf0;
  --shadow-card: none;
  --glow-accent: 0 0 0 1px rgba(57, 211, 192, 0.25), 0 0 18px rgba(57, 211, 192, 0.12);
  --overlay-wash: radial-gradient(1100px 600px at 78% -12%, rgba(57, 211, 192, 0.06), transparent 60%);
  color-scheme: dark;
}
```

(`--border-strong` has no ora.css source — derived here as `color-mix(in oklab, var(--border-subtle-hex) 60%, var(--text-tertiary-hex) 40%)`, written with literal hex operands since `color-mix` needs resolvable color values at this point in the cascade and both source hexes are already known constants in this same block — this keeps the formula identical and auditable across all three theme blocks in Tasks 5-7.)

- [ ] **Step 2: Grep-check no lingering `--color-gold`/`--color-navy` reference in this block**

Run: `grep -n "color-gold\|color-navy" src/tokens/theme.css`
Expected: zero matches inside the `[data-theme='command']` block specifically (matches may still exist in `[data-theme='parchment']` until Task 6 — check line numbers to confirm they're outside this block).

- [ ] **Step 3: Commit**

```bash
git add src/tokens/theme.css
git commit -m "feat(theme): command theme -> Mission-Control teal/dark palette"
```

---

### Task 6: `theme.css` — `parchment` theme block

**Files:**
- Modify: `src/tokens/theme.css` (the `[data-theme='parchment']` block, formerly lines 98-118)

**Interfaces:** Same shape as Task 5, parchment values.

Values copied verbatim from spec §3.4's "parchment" column. Note `--surface-rail` for parchment is `#ffffff` (ora.css's light-theme `--bg-2`) — this is a real, deliberate change from the OLD parchment theme, which used a dark navy rail (`#0d1b2a`) even in light mode; the new design has no dark-rail-in-light-mode pattern.

- [ ] **Step 1: Replace the `[data-theme='parchment']` block**

Old:
```css
/* ── PARCHMENT (light) ── */
[data-theme='parchment'] {
  --surface-base: #f5f0e8;
  --surface-sunken: #ece5d8;
  --surface-raised: #ffffff;
  --surface-overlay: #ffffff;
  --surface-rail: #0d1b2a;
  --border-subtle: color-mix(in oklab, #1b2a4a 14%, transparent);
  --border-strong: color-mix(in oklab, #1b2a4a 28%, transparent);
  --text-primary: #14213a;
  --text-secondary: #4a5a76;
  --text-tertiary: #8392a8;
  --text-on-accent: #0a1322;
  --accent: var(--color-gold-600);
  --accent-quiet: color-mix(in oklab, var(--color-gold-600) 16%, transparent);
  --grid-line: color-mix(in oklab, #1b2a4a 10%, transparent);
  --shadow-card: 0 1px 2px rgba(20, 33, 58, 0.08), 0 10px 26px -18px rgba(20, 33, 58, 0.35);
  --glow-accent: 0 0 0 1px color-mix(in oklab, var(--color-gold-600) 45%, transparent),
    0 0 18px -8px color-mix(in oklab, var(--color-gold-600) 50%, transparent);
  color-scheme: light;
}
```

New:
```css
/* ── PARCHMENT (light) ── */
[data-theme='parchment'] {
  --surface-base: #eef1f6;
  --surface-sunken: #eef2f7;
  --surface-raised: #ffffff;
  --surface-overlay: #f6f8fb;
  --surface-rail: #ffffff;
  --border-subtle: #e1e6ee;
  --border-strong: color-mix(in oklab, #e1e6ee 60%, #8593a6 40%);
  --grid-line: #eef1f6;
  --text-primary: #121a26;
  --text-secondary: #475568;
  --text-tertiary: #8593a6;
  --text-on-accent: #ffffff;
  --accent: #0e9e8e;
  --accent-quiet: rgba(14, 158, 142, 0.1);
  --color-pos: #1c9c63;
  --color-pos-soft: rgba(28, 156, 99, 0.12);
  --color-warn: #bd8311;
  --color-warn-soft: rgba(189, 131, 17, 0.12);
  --color-neg: #d35338;
  --color-neg-soft: rgba(211, 83, 56, 0.12);
  --color-info: #2f7fd6;
  --color-accent2: #7a5ad0;
  --shadow-card: 0 1px 2px rgba(35, 50, 75, 0.04), 0 10px 24px rgba(35, 50, 75, 0.05);
  --glow-accent: 0 0 0 1px rgba(14, 158, 142, 0.25), 0 6px 16px rgba(14, 158, 142, 0.12);
  --overlay-wash: radial-gradient(1100px 600px at 78% -12%, rgba(14, 158, 142, 0.05), transparent 60%);
  color-scheme: light;
}
```

- [ ] **Step 2: Confirm the full build resolves (fonts, radii, both themes' colors are now all in place — this is the first point where a full app render is representative)**

Run: `npm run build`
Expected: exits 0, no CSS/TS errors. (The old `--color-gold-*`/`--color-navy-*` tokens are gone from `@theme` as of Task 4 Step 3, and both theme blocks that referenced them are now fixed — but the 4 brand-sweep files (Task 8) and `charts/theme.ts` still reference them directly with hardcoded hex fallbacks, so the build succeeds but those specific UI elements will render their stale hardcoded fallback colors until Task 8. Confirm this is the case by grepping, not by assuming: `grep -rn "color-gold\|color-navy" src/` — expect hits ONLY in the 4 files Task 8 will fix.)

- [ ] **Step 3: Commit**

```bash
git add src/tokens/theme.css
git commit -m "feat(theme): parchment theme -> Mission-Control light palette"
```

---

### Task 7: `theme.css` — new `warm` theme block + font/radius overrides

**Files:**
- Modify: `src/tokens/theme.css` (insert a new block after `[data-theme='parchment']`, before `@layer base`)

**Interfaces:**
- Consumes: `Theme` type already includes `'warm'` (Task 2); `ThemeToggle` already cycles to it (Task 3).
- Produces: full `warm` theme, the first place `'warm'` becomes visually real.

Values copied verbatim from spec §3.4's "warm" column, plus the font/radius overrides from spec §3.1/§1a (Bricolage Grotesque display, Public Sans UI+mono, tighter-then-looser radius scale specific to warm).

- [ ] **Step 1: Insert the new `[data-theme='warm']` block**

Insert immediately after the `[data-theme='parchment']` block's closing `}` (end of Task 6's block), before the `@layer base {` line:

```css

/* ── WARM (editorial) ── */
[data-theme='warm'] {
  --font-ui: 'Public Sans Variable', sans-serif;
  --font-mono: 'Public Sans Variable', sans-serif;
  --font-display: 'Bricolage Grotesque Variable', sans-serif;
  --disp-weight: 700;
  --disp-tracking: -0.01em;
  --radius-xs: 8px;
  --radius-sm: 10px;
  --radius-md: 14px;
  --radius-lg: 18px;
  --radius-xl: 24px;
  --surface-base: #f3ede1;
  --surface-sunken: #f4eee2;
  --surface-raised: #fffdf8;
  --surface-overlay: #fbf6ec;
  --surface-rail: #f7f1e6;
  --border-subtle: #e7ddca;
  --border-strong: color-mix(in oklab, #e7ddca 60%, #9b9081 40%);
  --grid-line: #efe7d6;
  --text-primary: #2a2420;
  --text-secondary: #5c5247;
  --text-tertiary: #9b9081;
  --text-on-accent: #fffdf8;
  --accent: #c2603c;
  --accent-quiet: rgba(194, 96, 60, 0.1);
  --color-pos: #3f8a5a;
  --color-pos-soft: rgba(63, 138, 90, 0.12);
  --color-warn: #b8881f;
  --color-warn-soft: rgba(184, 136, 31, 0.12);
  --color-neg: #c2603c;
  --color-neg-soft: rgba(194, 96, 60, 0.12);
  --color-info: #2f6f6a;
  --color-accent2: #8a5a72;
  --shadow-card: 0 2px 4px rgba(90, 70, 40, 0.05), 0 14px 30px rgba(90, 70, 40, 0.07);
  --glow-accent: 0 6px 14px rgba(194, 96, 60, 0.26);
  --overlay-wash: radial-gradient(1100px 600px at 78% -12%, rgba(194, 96, 60, 0.05), transparent 60%);
  color-scheme: light;
}
```

Note: `--color-neg` and `--accent` are both `#c2603c` in warm — this is ora.css's own deliberate choice (confirmed in `design_handoff_ora_command_center/app/ora.css:66`, `--red:#c2603c` equals `--accent:#c2603c` in that block), not a transcription error. Leave as-is.

- [ ] **Step 2: Verify the theme actually applies in a real render**

Run: `npm run dev` (in this worktree, on a free port), then in a browser or via `npx playwright` open the app and run in the console: `document.documentElement.setAttribute('data-theme', 'warm')`. Confirm surfaces turn warm cream/clay and text goes serif-adjacent (Bricolage). **Stop the dev server when done** (per this repo's RAM discipline — do not leave it running).

- [ ] **Step 3: Commit**

```bash
git add src/tokens/theme.css
git commit -m "feat(theme): add warm editorial theme (Bricolage/Public Sans, clay accent)"
```

---

### Task 8: `theme.css` — base-layer signatures (overlay wash, selection, scrollbar, `.display`)

**Files:**
- Modify: `src/tokens/theme.css` (`@layer base` block, formerly lines 120-156)

**Interfaces:**
- Consumes: `--overlay-wash` (Tasks 5-7), `--disp-weight`/`--disp-tracking` (Task 4/7).
- Produces: `body::before` overlay, updated `::selection`, updated `.display` class, thin scrollbar styling.

Deviation from ora.css, documented here: ora.css scopes its scrollbar styling to a `.content` class that doesn't exist anywhere in this React app (`grep -rn "className=\"content\"" src/` returns nothing — the closest analog is `AppShell.tsx`'s `<main>` region, which has no distinguishing class of its own). Applying scrollbar styling globally via `*::-webkit-scrollbar` instead of scoping it, since adding a new class to `AppShell.tsx` is out of this plan's file list.

- [ ] **Step 1: Add the overlay wash and update `.display`**

In the existing `@layer base { ... }` block, after the `body { ... }` rule (which stays as-is) and before the `.num { ... }` rule, insert:

```css
  body::before {
    content: '';
    position: fixed;
    inset: 0;
    background: var(--overlay-wash);
    pointer-events: none;
    z-index: 0;
  }
```

Replace the existing `.display` rule:

Old:
```css
  .display {
    font-family: var(--font-display);
    letter-spacing: -0.01em;
  }
```

New:
```css
  .display {
    font-family: var(--font-display);
    font-weight: var(--disp-weight);
    letter-spacing: var(--disp-tracking);
  }
```

Replace `::selection`:

Old:
```css
  ::selection {
    background: var(--accent-quiet);
  }
```

New:
```css
  ::selection {
    background: var(--accent);
    color: var(--text-on-accent);
  }
```

- [ ] **Step 2: Add thin scrollbar styling (new, at the end of the file, after the `prefers-reduced-motion` block)**

Append to the end of `src/tokens/theme.css`:
```css

/* ── Thin scrollbars (Mission-Control signature) ── */
::-webkit-scrollbar {
  width: 9px;
}
::-webkit-scrollbar-thumb {
  background: var(--border-subtle);
  border-radius: 6px;
  border: 2px solid var(--surface-base);
}
```

- [ ] **Step 3: Verify `body::before` doesn't intercept clicks**

Run `npm run dev`, open the app, click through a few interactive elements (sidebar nav, a KPI card, a table row). Confirm all clicks register normally. `pointer-events: none` on the pseudo-element should make this a non-issue, but this is exactly the kind of regression that's cheap to check now and expensive to discover in PR-B's screenshot pass. **Stop the dev server when done.**

- [ ] **Step 4: Commit**

```bash
git add src/tokens/theme.css
git commit -m "feat(theme): overlay wash, updated selection/display styles, thin scrollbars"
```

---

### Task 9: Brand-leftover sweep (4 files)

**Files:**
- Modify: `src/charts/theme.ts:7`
- Modify: `src/modules/intel/LeaseRunView.tsx:162,189`
- Modify: `src/modules/intel/PropertyIntelView.tsx:259` (comment only)
- Modify: `src/modules/overview/widgets.tsx:39`

**Interfaces:** No signature changes anywhere in this task — every change is a literal value or comment swap.

**Scope note:** `src/charts/theme.ts`'s full series reorder is PR-B's job per the design spec — but leaving its hardcoded `--color-gold-300` fallback untouched here would be a real, immediately-visible bug: `--color-gold-300` no longer exists after Task 4, so `SERIES[4]` would render its stale literal hex fallback (`#e6d3a3`, old gold) sitting among four already-teal-Mission-Control colors the moment PR-A merges — a visible defect PR-B wouldn't fix for some unknown interval. Fixing the fallback value now (not the ordering) closes that gap without doing PR-B's reorder work.

- [ ] **Step 1: `src/charts/theme.ts` — fix the stale fallback**

Old (line 7):
```typescript
  'var(--color-gold-300, #e6d3a3)',
```

New:
```typescript
  'var(--color-warn)',
```

- [ ] **Step 2: `src/modules/intel/LeaseRunView.tsx` — fix both leftovers**

`--color-gold` was never actually defined as a token in this codebase (only `--color-gold-300/400/500/600` existed) — both of these lines were already silently running on their hardcoded hex fallback, not a real token. Replace both with `var(--accent)`, matching this file's intent (drawing attention to a flagged/highlighted item using the brand accent).

Old (line 162):
```typescript
                <FileWarning size={13} style={{ marginTop: 1, flexShrink: 0, color: 'var(--color-gold, #C9A96E)' }} />
```

New:
```typescript
                <FileWarning size={13} style={{ marginTop: 1, flexShrink: 0, color: 'var(--accent)' }} />
```

Old (line 189):
```typescript
          color: rollovers.has(p.leaseYearLabel) ? 'var(--color-gold, #C9A96E)' : undefined,
```

New:
```typescript
          color: rollovers.has(p.leaseYearLabel) ? 'var(--accent)' : undefined,
```

- [ ] **Step 3: `src/modules/intel/PropertyIntelView.tsx` — update the comment**

Old (line 259):
```typescript
// Verdict header — gold-accent Card leading with the ownership verdict.
```

New:
```typescript
// Verdict header — accent Card leading with the ownership verdict.
```

- [ ] **Step 4: `src/modules/overview/widgets.tsx` — fix the Equity Invested KPI accent**

Old (line 39):
```typescript
      <KpiStat label="Equity Invested" value={k.equityInvested.value} format={fmtUsdCompact} prov={k.equityInvested.prov} accentColor="var(--color-gold-400, #d8bd7e)" />
```

New:
```typescript
      <KpiStat label="Equity Invested" value={k.equityInvested.value} format={fmtUsdCompact} prov={k.equityInvested.prov} accentColor="var(--accent)" />
```

- [ ] **Step 5: Full-repo grep to confirm the sweep is complete**

Run: `grep -rniE "color-gold|color-navy|navy-|gold-" src/`
Expected: zero matches anywhere in `src/`. (This confirms both this task's 4 fixes AND Task 4's removal of the `@theme` definitions leave no dangling references.)

- [ ] **Step 6: Commit**

```bash
git add src/charts/theme.ts src/modules/intel/LeaseRunView.tsx src/modules/intel/PropertyIntelView.tsx src/modules/overview/widgets.tsx
git commit -m "chore(theme): sweep remaining gold/navy token references"
```

---

### Task 10: Full verification and PR

**Files:** none (verification only)

- [ ] **Step 1: Full local suite**

Run: `npm run test`
Expected: all tests pass, including the 4 new tests from Tasks 2-3.

- [ ] **Step 2: Full gate**

Run: `npm run gate`
Expected: all 7 steps (governance, typecheck, lint, test, reconcile, warehouse:verify, warehouse:drift) exit 0. Per `docs/superpowers/plans/2026-07-08-mission-control-tokens-pr-a.md`'s Global Constraints and the known worktree gotcha (memory: `oxford-command-center worktree gotchas`), `warehouse:verify` may hit a Windows EPERM on its own tmp-dir cleanup when run from a worktree with a concurrent second session active — if that happens, re-run from the main checkout at the same commit to confirm it's an environment artifact, not a real failure, before treating it as blocking (precedent: `fix-design-parity-p2-p3` status.json entry hit and diagnosed the exact same false-positive earlier today).

- [ ] **Step 3: Bundle budget**

Run: `npm run check:bundle`
Expected: exits 0, entry bundle stays under the 250 kB gzip budget. Font swap changes bundle composition (new Fontsource packages) but not typically size in a way that threatens the budget — verify with actual output, don't assume.

- [ ] **Step 4: Zero raw hex/old-brand leftovers check (Acceptance criterion from the original design review, still valid)**

Run: `grep -rn "#0a1322\|#c9a96e\|Garamond\|DM Sans" src/`
Expected: zero matches.

- [ ] **Step 5: Update `architecture/status.json`**

Set `mission-control-retokenization`'s `status` to `"review_needed"`, update `review_detail` to summarize PR-A completion (all 10 tasks, gate green, bundle green), and set `last_updated` to the current timestamp (`date -u +%Y-%m-%dT%H:%M:%SZ`).

- [ ] **Step 6: Push and open the PR**

```bash
git push
gh pr create --title "feat(theme): Mission-Control retokenization — PR-A (tokens/fonts/radii/themes)" --body "$(cat <<'EOF'
## Summary
- Retokenizes src/tokens/theme.css from Oxford Terminal (navy/gold, EB Garamond/DM Sans) to ORA Mission-Control (teal/IBM Plex Sans/Bricolage Grotesque/Public Sans), keeping all token *names* unchanged.
- Adds a third theme, `warm` (editorial, clay accent).
- Font dependency swap in package.json (architect-owned; Gabriel acknowledged in-session 2026-07-08, recorded in architecture/status.json).
- Sweeps the last 4 hardcoded gold/navy leftovers outside theme.css.

## Spec + review trail
- Design spec: docs/superpowers/specs/2026-07-08-mission-control-retokenization-design.md (independently formally reviewed, 2 rounds of fixes applied — see spec history).
- This is PR-A of a two-phase delivery; PR-B (severity glow, categoryTone, KpiStat drill-down, PortfolioFilterBar, Sidebar active-bar, Badge shape, chart reorder) is separate, opened after this merges.

## Test plan
- [ ] npm run gate green (all 7 steps)
- [ ] npm run check:bundle green
- [ ] npm run test green, including new theme.test.ts + theme-toggle.test.tsx
- [ ] Manual: cycle all 3 themes in the running app, confirm no click-through regression from the overlay wash
EOF
)"
```

---

## Self-Review Notes (completed during plan authoring)

**Spec coverage:** §3.1 (radii) → Task 4/7. §3.2 (fonts) → Tasks 1, 4, 7. §3.3 (categoryTone) → PR-B, correctly excluded. §3.4 (color crosswalk) → Tasks 5-7. §4 PR-A file list → Tasks 1-9 cover every named file. §6 verification → Task 10. No spec requirement for PR-A scope is missing a task.

**Placeholder scan:** none found — every step has literal, complete code.

**Type consistency:** `Theme` type (Task 2) is `'command' | 'parchment' | 'warm'`; `ThemeToggle`'s `NEXT`/`ICON` records (Task 3) and `theme.css`'s three `[data-theme=...]` selectors (Tasks 5-7) all use the same three literal strings throughout — checked for drift, none found.

**Scope correction made during planning:** the design spec listed `src/charts/theme.ts` under both PR-A's "brand-leftover sweep" and PR-B's "series reorder" — an overlap the spec itself didn't flag. Resolved here (Task 9) by having PR-A fix only the stale hardcoded fallback value (required immediately, or the app ships with one visibly wrong chart color), leaving the actual series *reordering* for PR-B, which is a distinct, separable change to the same line.
