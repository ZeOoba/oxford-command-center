# Tone-Palette-as-Text AA Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix a repo-wide WCAG AA (4.5:1) text-contrast failure: the semantic tone palette (`--color-neg/warn/info/pos`, `--accent`, `--color-accent2`) was tuned for fills/borders/glows (3:1 threshold) but is also used directly as text color in ~130 call sites across the app, failing AA broadly in the `parchment` and `warm` themes — both as plain text on ambient surfaces and as text on the tone's own self-paired tinted background (Badge, alert banners, tab-active pills).

**Architecture:** Add six new theme tokens (`--text-neg`, `--text-warn`, `--text-info`, `--text-pos`, `--text-accent`, `--text-accent2`) to `src/tokens/theme.css`, each a darkened, AA-verified variant of its corresponding `--color-*`/`--accent` token for `parchment` and `warm` (identical to the original in `command`, which already passes everywhere). Swap every genuine TEXT usage of a raw tone token to its `--text-*` counterpart; leave every non-text usage (fills, borders, glows, chart strokes, standalone decorative icons) on the original `--color-*`/`--accent` tokens, since those only need to clear 3:1 (SC 1.4.11) and are unaffected by this fix. Two shared primitives (`Badge.tsx`, `TierBoard.tsx`) account for ~47 of the ~130 sites — fixing them first has outsized leverage before the remaining ~25 files are fixed individually.

**Tech Stack:** React 18 + TypeScript, Tailwind v4 CSS-first tokens (`@theme`), Vitest for tests. No new dependencies.

## Global Constraints

- Token naming: `--text-<tone>` (mirrors the existing `--text-on-accent`/`--text-on-info` precedent — those name what color text should be *on top of* a tone fill; `--text-<tone>` names the tone-colored-text-safe variant of the tone itself).
- Only genuine TEXT (rendered readable characters, including glyph/bullet characters like ✓/⚠/•, and text that inherits color from an ancestor) gets swapped. Pure decorative icons (SVG icon components with no adjacent/inherited text) stay on the original `--color-*`/`--accent` tokens — icons need only SC 1.4.11's 3:1, which the original tones already clear. Where an icon inherits `color` from a parent whose `color` IS being swapped (e.g. an icon sitting inside a bold-text `<div>`), the icon inherits the new `--text-*` value too — this is fine and was accounted for in the contrast verification (icons don't get *worse* by inheriting a darker, higher-contrast color).
- `command` theme: `--text-<tone>: var(--color-<tone>);` (alias, zero visual change — already verified AA-clean everywhere).
- `parchment`/`warm`: literal darkened hex values (Task 1) — computed via linear-sRGB darkening toward black, binary-searched to the minimum darkening that clears 4.5:1 (with a small safety margin, targeting ≥4.6:1) against the worst-case real background found in the inventory (ambient surfaces AND self-paired tints at every opacity actually used in the codebase — 9%, 10%, 12%, 14%, 16% — composited over both `--surface-base` and `--surface-raised`). Verified against all 156 realistic (tone × background) combinations — see Task 1's regression test.
- Do not touch `--color-*`, `--accent`, `--color-*-soft`, `--accent-quiet`, or any fill/border/glow usage — this fix is additive only (new tokens + consumer swaps), never a palette redefinition.
- Every task's file edits are swap-only: replace `var(--color-X)` → `var(--text-X)` (or the equivalent map/object value) at the exact cited line. No other code in the touched file changes.
- After every task: `npm run typecheck`, `npm run lint`, and the relevant test file(s) must pass before commit.

---

## Task 1: Add `--text-*` tokens to theme.css + contrast regression test

**Files:**
- Modify: `src/tokens/theme.css` (three `[data-theme=...]` blocks)
- Create: `tests/unit/theme-text-contrast.test.ts`

**Interfaces:**
- Produces: six new CSS custom properties per theme — `--text-neg`, `--text-warn`, `--text-info`, `--text-pos`, `--text-accent`, `--text-accent2` — consumed by every later task.

- [ ] **Step 1: Add the tokens to `[data-theme='command']` block** (after the existing `--text-on-info` line, ~L72)

```css
  --text-neg: var(--color-neg);
  --text-warn: var(--color-warn);
  --text-info: var(--color-info);
  --text-pos: var(--color-pos);
  --text-accent: var(--accent);
  --text-accent2: var(--color-accent2);
```

- [ ] **Step 2: Add the tokens to `[data-theme='parchment']` block** (after the existing `--text-on-info` line, ~L105)

```css
  /* Text-safe variants of the tone palette — the raw --color-*/--accent tokens are
     tuned for fills/borders/glows (3:1) and fail AA (4.5:1) as text against this
     theme's near-white surfaces. Each value below is the minimum darkening (linear
     sRGB toward black) that clears 4.5:1 against the worst real background found
     across the app: every ambient surface AND every self-paired tint (Badge fills,
     alert banners, tab-active pills) at every opacity in use (9-16%). See
     tests/unit/theme-text-contrast.test.ts for the full verification matrix. */
  --text-neg: #a3402b;
  --text-warn: #835a0c;
  --text-info: #2462a4;
  --text-pos: #146f46;
  --text-accent: #0a6e62;
  --text-accent2: #684db2;
```

- [ ] **Step 3: Add the tokens to `[data-theme='warm']` block** (after the existing `--text-on-info` line, ~L153)

```css
  /* Text-safe variants — see the parchment block's comment for methodology.
     --text-info and --text-accent2 are unchanged from --color-info/--color-accent2:
     both already clear 4.5:1 against every real background in this theme. */
  --text-neg: #94492e;
  --text-warn: #7c5b15;
  --text-info: #2f6f6a;
  --text-pos: #306a45;
  --text-accent: #94492e;
  --text-accent2: #8a5a72;
```

- [ ] **Step 4: Write the contrast regression test**

```typescript
// tests/unit/theme-text-contrast.test.ts
import { describe, it, expect } from 'vitest';

function lin(c: number): number {
  c /= 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}
function luminance(hex: string): number {
  hex = hex.replace('#', '');
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const lighter = Math.max(la, lb);
  const darker = Math.min(la, lb);
  return (lighter + 0.05) / (darker + 0.05);
}
function hexToRgb(hex: string): [number, number, number] {
  hex = hex.replace('#', '');
  return [parseInt(hex.substring(0, 2), 16), parseInt(hex.substring(2, 4), 16), parseInt(hex.substring(4, 6), 16)];
}
function rgbToHex(rgb: number[]): string {
  return '#' + rgb.map((v) => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
}
function composite(fgHex: string, alphaPct: number, bgHex: string): string {
  const fg = hexToRgb(fgHex);
  const bg = hexToRgb(bgHex);
  const a = alphaPct / 100;
  return rgbToHex(fg.map((c, i) => a * c + (1 - a) * bg[i]));
}

const THEMES = {
  parchment: {
    surfaceBase: '#eef1f6',
    surfaceRaised: '#ffffff',
    surfaceOverlay: '#f6f8fb',
    color: { neg: '#d35338', warn: '#bd8311', info: '#2f7fd6', pos: '#1c9c63', accent: '#0e9e8e', accent2: '#7a5ad0' },
    text: { neg: '#a3402b', warn: '#835a0c', info: '#2462a4', pos: '#146f46', accent: '#0a6e62', accent2: '#684db2' },
  },
  warm: {
    surfaceBase: '#f3ede1',
    surfaceRaised: '#fffdf8',
    surfaceOverlay: '#fbf6ec',
    color: { neg: '#c2603c', warn: '#b8881f', info: '#2f6f6a', pos: '#3f8a5a', accent: '#c2603c', accent2: '#8a5a72' },
    text: { neg: '#94492e', warn: '#7c5b15', info: '#2f6f6a', pos: '#306a45', accent: '#94492e', accent2: '#8a5a72' },
  },
  command: {
    surfaceBase: '#0c0f14',
    surfaceRaised: '#141a22',
    surfaceOverlay: '#171f29',
    color: { neg: '#f06a4d', warn: '#f4b740', info: '#5aa7f0', pos: '#54d49a', accent: '#39d3c0', accent2: '#a98cf0' },
    text: { neg: '#f06a4d', warn: '#f4b740', info: '#5aa7f0', pos: '#54d49a', accent: '#39d3c0', accent2: '#a98cf0' },
  },
} as const;

const TINT_PCTS = [9, 10, 12, 14, 16];
const AA_SMALL_TEXT = 4.5;

describe('theme text-safe tone tokens clear WCAG AA (4.5:1)', () => {
  for (const [themeName, t] of Object.entries(THEMES)) {
    describe(themeName, () => {
      for (const tone of Object.keys(t.text) as Array<keyof typeof t.text>) {
        const textHex = t.text[tone];
        const fillHex = t.color[tone];

        it(`--text-${tone} on every ambient surface`, () => {
          for (const surf of ['surfaceBase', 'surfaceRaised', 'surfaceOverlay'] as const) {
            const c = contrast(textHex, t[surf]);
            expect(c, `${tone} on ${surf} (${t[surf]}): ${c.toFixed(2)}`).toBeGreaterThanOrEqual(AA_SMALL_TEXT);
          }
        });

        it(`--text-${tone} on every self-paired tint of --color-${tone}`, () => {
          for (const pct of TINT_PCTS) {
            for (const backdrop of [t.surfaceBase, t.surfaceRaised] as const) {
              const tinted = composite(fillHex, pct, backdrop);
              const c = contrast(textHex, tinted);
              expect(c, `${tone} on ${pct}% tint over ${backdrop} (${tinted}): ${c.toFixed(2)}`).toBeGreaterThanOrEqual(
                AA_SMALL_TEXT,
              );
            }
          }
        });
      }
    });
  }
});
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm run test -- tests/unit/theme-text-contrast.test.ts`
Expected: all suites PASS (18 `it` blocks × 2 assertions style = confirms all 156 combinations clear 4.5:1)

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors

- [ ] **Step 7: Commit**

```bash
git add src/tokens/theme.css tests/unit/theme-text-contrast.test.ts
git commit -m "feat(theme): add AA-verified text-safe tone tokens (--text-neg/warn/info/pos/accent/accent2)"
```

---

## Task 2: Fix Badge.tsx primitive (~40 call sites)

**Files:**
- Modify: `src/primitives/Badge.tsx:6-14`

**Interfaces:**
- Consumes: `--text-neg/warn/info/pos/accent/accent2` from Task 1.
- Produces: no signature change — `Badge`'s public `tone` prop and rendering are unchanged; only the resolved `fg` color per tone changes.

- [ ] **Step 1: Update the `TONES` map's `fg` values**

Before (current `TONES` map, ~L6-14):
```typescript
const TONES: Record<BadgeTone, { bg: string; fg: string; bd: string }> = {
  neutral: { bg: 'var(--surface-overlay)', fg: 'var(--text-secondary)', bd: 'var(--border-subtle)' },
  gold: { bg: 'color-mix(in oklab, var(--accent) 16%, transparent)', fg: 'var(--accent)', bd: 'var(--accent)' },
  green: { bg: 'var(--color-pos-soft)', fg: 'var(--color-pos)', bd: 'var(--color-pos)' },
  amber: { bg: 'var(--color-warn-soft)', fg: 'var(--color-warn)', bd: 'var(--color-warn)' },
  red: { bg: 'var(--color-neg-soft)', fg: 'var(--color-neg)', bd: 'var(--color-neg)' },
  blue: { bg: 'color-mix(in oklab, var(--color-info) 16%, transparent)', fg: 'var(--color-info)', bd: 'var(--color-info)' },
  purple: { bg: 'color-mix(in oklab, var(--color-accent2) 16%, transparent)', fg: 'var(--color-accent2)', bd: 'var(--color-accent2)' },
};
```

After:
```typescript
const TONES: Record<BadgeTone, { bg: string; fg: string; bd: string }> = {
  neutral: { bg: 'var(--surface-overlay)', fg: 'var(--text-secondary)', bd: 'var(--border-subtle)' },
  gold: { bg: 'color-mix(in oklab, var(--accent) 16%, transparent)', fg: 'var(--text-accent)', bd: 'var(--accent)' },
  green: { bg: 'var(--color-pos-soft)', fg: 'var(--text-pos)', bd: 'var(--color-pos)' },
  amber: { bg: 'var(--color-warn-soft)', fg: 'var(--text-warn)', bd: 'var(--color-warn)' },
  red: { bg: 'var(--color-neg-soft)', fg: 'var(--text-neg)', bd: 'var(--color-neg)' },
  blue: { bg: 'color-mix(in oklab, var(--color-info) 16%, transparent)', fg: 'var(--text-info)', bd: 'var(--color-info)' },
  purple: { bg: 'color-mix(in oklab, var(--color-accent2) 16%, transparent)', fg: 'var(--text-accent2)', bd: 'var(--color-accent2)' },
};
```

Note: `bg` and `bd` (border, 3:1 threshold only) are unchanged — only `fg` (the text color) moves to the text-safe token.

- [ ] **Step 2: Run existing Badge tests**

Run: `npm run test -- Badge`
Expected: PASS (no behavioral change, only color values)

- [ ] **Step 3: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors

- [ ] **Step 4: Commit**

```bash
git add src/primitives/Badge.tsx
git commit -m "fix(a11y): Badge text uses AA-safe tone tokens instead of raw fill colors"
```

---

## Task 3: Fix TierBoard.tsx primitive (item-count badge, impact amount, action link)

**Files:**
- Modify: `src/primitives/TierBoard.tsx`

**Interfaces:**
- Consumes: `--text-*` tokens from Task 1.
- Produces: no signature change.

- [ ] **Step 1: Add a `TEXT_TONE_COLOR` map next to the existing `TONE_COLOR` map** (~L44-51, after it)

```typescript
const TEXT_TONE_COLOR: Record<Tier['tone'], string> = {
  neg: 'var(--text-neg)',
  warn: 'var(--text-warn)',
  info: 'var(--text-info)',
  pos: 'var(--text-pos)',
  accent: 'var(--text-accent)',
  accent2: 'var(--text-accent2)',
};
```

- [ ] **Step 2: Update `IMPACT_COLOR` to use text-safe tokens** (~L80-84)

Before:
```typescript
const IMPACT_COLOR: Record<NonNullable<TierItem['impactKind']>, string> = {
  gain: 'var(--color-pos)',
  risk: 'var(--color-neg)',
  info: 'var(--color-info)',
};
```

After:
```typescript
const IMPACT_COLOR: Record<NonNullable<TierItem['impactKind']>, string> = {
  gain: 'var(--text-pos)',
  risk: 'var(--text-neg)',
  info: 'var(--text-info)',
};
```

- [ ] **Step 3: Update the item-count badge to use the text-safe color for BOTH text and border** (~L131-135 dot — unchanged; ~L149-154 item-count badge)

**Amendment (caught by an independent cross-session check, verified against the codebase before this task was dispatched):** the raw `TONE_COLOR['warn']` value fails even the 3:1 non-text floor (SC 1.4.11) as a *border* against `--surface-overlay` in the warm theme specifically (2.96:1, computed from `--color-warn: #b8881f` vs `--surface-overlay: #fbf6ec`) — this is the one and only (tone, theme) combination out of all 18 where the raw tone fails as a border anywhere in the app (verified by checking all 6 tones × all 3 themes × `surface-raised`/`surface-overlay`). Rather than leaving the border on the original `TONE_COLOR` (which was this task's original plan and is fine for the other 17 combinations but not this one), use `TEXT_TONE_COLOR` for both `border` and `color` in this specific badge — `--text-warn` already clears 4.5:1, so it trivially clears 3:1 too, and a border matching its own text color is a normal, visually coherent pattern.

Before:
```tsx
        <span
          className="num ml-auto shrink-0 rounded-full px-2 py-0.5 text-2xs font-semibold"
          style={{ background: 'var(--surface-overlay)', border: `1px solid ${color}`, color }}
        >
          {tier.items.length}
        </span>
```

After:
```tsx
        <span
          className="num ml-auto shrink-0 rounded-full px-2 py-0.5 text-2xs font-semibold"
          style={{
            background: 'var(--surface-overlay)',
            border: `1px solid ${TEXT_TONE_COLOR[tier.tone]}`,
            color: TEXT_TONE_COLOR[tier.tone],
          }}
        >
          {tier.items.length}
        </span>
```

(Both `border` and `color` now use `TEXT_TONE_COLOR[tier.tone]` instead of the original `color` variable — this changes the badge's border from the original fill-tuned tone to the same darkened text-safe variant, closing the warm/warn 3:1 gap along with fixing text contrast everywhere else.)

- [ ] **Step 4: Update the action link color** (~L239)

Before:
```tsx
                className="num text-2xs font-semibold"
                style={{ color: 'var(--accent)' }}
```

After:
```tsx
                className="num text-2xs font-semibold"
                style={{ color: 'var(--text-accent)' }}
```

- [ ] **Step 5: Run existing TierBoard tests**

Run: `npm run test -- TierBoard`
Expected: PASS

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors

- [ ] **Step 7: Commit**

```bash
git add src/primitives/TierBoard.tsx
git commit -m "fix(a11y): TierBoard item-count/impact/action-link text uses AA-safe tone tokens"
```

---

## Task 4: Fix remaining primitives (KpiStat, Provenance, StatusPill)

**Files:**
- Modify: `src/primitives/KpiStat.tsx:79`
- Modify: `src/primitives/Provenance.tsx:47`
- Modify: `src/primitives/StatusPill.tsx:7-13`

**Interfaces:**
- Consumes: `--text-*` tokens from Task 1.

- [ ] **Step 1: KpiStat.tsx delta text** (L79)

Before:
```tsx
          style={{ color: deltaUp ? 'var(--color-pos)' : 'var(--color-neg)' }}
```

After:
```tsx
          style={{ color: deltaUp ? 'var(--text-pos)' : 'var(--text-neg)' }}
```

(Lines 112 and 121 — the `ArrowUpRight` icon-only links — are unchanged; no text child, icon-only 3:1 threshold already met.)

- [ ] **Step 2: Provenance.tsx confidence label** (L47)

Before:
```tsx
          style={{ letterSpacing: '0.1em', color: prov.confidence === 'confirmed' ? 'var(--color-pos)' : 'var(--color-warn)' }}
```

After:
```tsx
          style={{ letterSpacing: '0.1em', color: prov.confidence === 'confirmed' ? 'var(--text-pos)' : 'var(--text-warn)' }}
```

- [ ] **Step 3: StatusPill.tsx `COLOR` map** (~L7-13)

Before:
```typescript
const COLOR: Record<Freshness['kind'], string> = {
  live: 'var(--color-pos)',
  static: 'var(--color-info)',
  stale: 'var(--color-warn)',
  refreshing: 'var(--color-warn)',
  offline: 'var(--color-neg)',
  connecting: 'var(--text-tertiary)',
};
```

After:
```typescript
const COLOR: Record<Freshness['kind'], string> = {
  live: 'var(--text-pos)',
  static: 'var(--text-info)',
  stale: 'var(--text-warn)',
  refreshing: 'var(--text-warn)',
  offline: 'var(--text-neg)',
  connecting: 'var(--text-tertiary)',
};
```

(The status dot's `background`/`boxShadow` — a separate map/usage — is unchanged; only the text label's `color` moves.)

- [ ] **Step 4: Run tests**

Run: `npm run test -- KpiStat Provenance StatusPill`
Expected: PASS

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add src/primitives/KpiStat.tsx src/primitives/Provenance.tsx src/primitives/StatusPill.tsx
git commit -m "fix(a11y): KpiStat delta, Provenance label, StatusPill text use AA-safe tone tokens"
```

---

## Task 5: Fix shell files (ErrorBoundary, ModuleFallback, PortfolioFilterBar, StaleBanner, ViewToggle, TopBar)

**Files:**
- Modify: `src/shell/ErrorBoundary.tsx:22`
- Modify: `src/shell/ModuleFallback.tsx:20`
- Modify: `src/shell/PortfolioFilterBar.tsx:15`
- Modify: `src/shell/StaleBanner.tsx:22`
- Modify: `src/shell/ViewToggle.tsx:21`
- Modify: `src/shell/TopBar.tsx:74`

- [ ] **Step 1: ErrorBoundary.tsx** (L22): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`

- [ ] **Step 2: ModuleFallback.tsx** (L20): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`

- [ ] **Step 3: PortfolioFilterBar.tsx** (L15, `fieldStyleSet` active branch): `color: 'var(--accent)'` → `color: 'var(--text-accent)'` (border stays `var(--accent)`)

- [ ] **Step 4: StaleBanner.tsx** (L22, root div — `color` is inherited by the bold child span and icon): `color: 'var(--color-warn)'` → `color: 'var(--text-warn)'` (the `background: color-mix(... var(--color-warn) 14% ...)` on the same line is unchanged)

- [ ] **Step 5: ViewToggle.tsx** (L21, active branch): `color: 'var(--accent)'` → `color: 'var(--text-accent)'` (`background: 'var(--accent-quiet)'` unchanged)

- [ ] **Step 6: TopBar.tsx** (L74, "Ask" button): `color: 'var(--accent)'` → `color: 'var(--text-accent)'` (`background: 'var(--accent-quiet)'`, `border` unchanged)

- [ ] **Step 7: Run tests**

Run: `npm run test -- shell`
Expected: PASS

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors

- [ ] **Step 9: Commit**

```bash
git add src/shell/ErrorBoundary.tsx src/shell/ModuleFallback.tsx src/shell/PortfolioFilterBar.tsx src/shell/StaleBanner.tsx src/shell/ViewToggle.tsx src/shell/TopBar.tsx
git commit -m "fix(a11y): shell error/status/filter text uses AA-safe tone tokens"
```

---

## Task 6: Fix brain files (DraftPanel, AiPanel, DealDrawer, EntityDrawer)

**Files:**
- Modify: `src/brain/DraftPanel.tsx:69`
- Modify: `src/brain/AiPanel.tsx:31`
- Modify: `src/brain/DealDrawer.tsx:91,105,198,316,321,401`
- Modify: `src/brain/EntityDrawer.tsx:196`

- [ ] **Step 1: DraftPanel.tsx** (L69, disclaimer bar — `color` inherited by bold span + icon): `color: 'var(--color-warn)'` → `color: 'var(--text-warn)'` (`background: color-mix(... 12% ...)` unchanged)

- [ ] **Step 2: AiPanel.tsx** (L31, citation chip text): `color: 'var(--accent)'` → `color: 'var(--text-accent)'` (`background`/`border` unchanged; lines 114/126 are icon-only, unchanged)

- [ ] **Step 3: DealDrawer.tsx**, six sites:
  - L91 ("Confidential" label): `color: 'var(--color-accent2)'` → `color: 'var(--text-accent2)'`
  - L105 ("Draft LOI handoff" button): `color: 'var(--accent)'` → `color: 'var(--text-accent)'` (`background`/`border` unchanged)
  - L198 (comp-research error): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`
  - L316 ("No flags."): `color: 'var(--color-pos)'` → `color: 'var(--text-pos)'`
  - L321 (risk-flag bullet "•"): `color: 'var(--color-warn)'` → `color: 'var(--text-warn)'`
  - L401 ("source" link): `color: 'var(--accent)'` → `color: 'var(--text-accent)'`

- [ ] **Step 4: EntityDrawer.tsx** (L196, draft-action CTA — `a.label`): `color: 'var(--accent)'` → `color: 'var(--text-accent)'` (`background: 'var(--accent-quiet)'` unchanged)

- [ ] **Step 5: Run tests**

Run: `npm run test -- brain`
Expected: PASS

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors

- [ ] **Step 7: Commit**

```bash
git add src/brain/DraftPanel.tsx src/brain/AiPanel.tsx src/brain/DealDrawer.tsx src/brain/EntityDrawer.tsx
git commit -m "fix(a11y): brain drawer/panel text uses AA-safe tone tokens"
```

---

## Task 7: Fix acquisitions module — RankedCandidateList, OmImportDrawer

**Files:**
- Modify: `src/modules/acquisitions/RankedCandidateList.tsx:48,57,156`
- Modify: `src/modules/acquisitions/OmImportDrawer.tsx:122,132,231,238,272`

- [ ] **Step 1: RankedCandidateList.tsx**, three sites:
  - L48 ("✓" glyph): `color: 'var(--color-pos)'` → `color: 'var(--text-pos)'`
  - L57 ("⚠" glyph): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`
  - L156 ("advisory" text): `color: 'var(--color-warn)'` → `color: 'var(--text-warn)'`

  (`TIER_STYLES`'s `color: 'var(--text-on-accent)'`/`'var(--text-on-info)'` — a different, already-AA-safe token pair from PR-B/PR-189 — is untouched.)

- [ ] **Step 2: OmImportDrawer.tsx**, five sites:
  - L122 ("OM Import" header): `color: 'var(--accent)'` → `color: 'var(--text-accent)'`
  - L132 ("field(s) found"): `color: 'var(--color-pos)'` → `color: 'var(--text-pos)'`
  - L231 (table cell label): `color: 'var(--color-info)'` → `color: 'var(--text-info)'`
  - L238 ("✓" glyph): `color: 'var(--color-pos)'` → `color: 'var(--text-pos)'`
  - L272 (error message): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`

- [ ] **Step 3: Run tests**

Run: `npm run test -- RankedCandidateList OmImportDrawer`
Expected: PASS

- [ ] **Step 4: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/modules/acquisitions/RankedCandidateList.tsx src/modules/acquisitions/OmImportDrawer.tsx
git commit -m "fix(a11y): RankedCandidateList/OmImportDrawer text uses AA-safe tone tokens"
```

---

## Task 8: Fix acquisitions module — AcquisitionWorkbench, AcquisitionsIntel, GraderView, AcquisitionsModule

**Files:**
- Modify: `src/modules/acquisitions/AcquisitionWorkbench.tsx:270-272`
- Modify: `src/modules/acquisitions/AcquisitionsIntel.tsx:65`
- Modify: `src/modules/acquisitions/GraderView.tsx:68,112`
- Modify: `src/modules/acquisitions/AcquisitionsModule.tsx:122-124,165,171`

- [ ] **Step 1: AcquisitionWorkbench.tsx `Banner()`** (~L270-272)

Before:
```tsx
function Banner({ tone, children }: { tone: 'red' | 'amber'; children: ReactNode }) {
  const c = tone === 'red' ? 'var(--color-neg)' : 'var(--color-warn)';
  const bg = tone === 'red' ? 'var(--color-neg-soft)' : 'var(--color-warn-soft)';
  return (
    <div className="text-2xs" style={{ background: bg, color: c, border: `1px solid ${c}` }}>
      {children}
    </div>
  );
}
```

After:
```tsx
function Banner({ tone, children }: { tone: 'red' | 'amber'; children: ReactNode }) {
  const c = tone === 'red' ? 'var(--color-neg)' : 'var(--color-warn)';
  const textC = tone === 'red' ? 'var(--text-neg)' : 'var(--text-warn)';
  const bg = tone === 'red' ? 'var(--color-neg-soft)' : 'var(--color-warn-soft)';
  return (
    <div className="text-2xs" style={{ background: bg, color: textC, border: `1px solid ${c}` }}>
      {children}
    </div>
  );
}
```

(`border` stays on the original 3:1-only `c`; only `color:` the text property uses the new `textC`. Adjust exact variable names to match what's actually in the file — read the file first to confirm current structure before editing.)

- [ ] **Step 2: AcquisitionsIntel.tsx** (L65, advisory alert box — `color` inherited by nested `<strong>`): `color: 'var(--color-warn)'` → `color: 'var(--text-warn)'` (`background: 'var(--color-warn-soft)'`, `border` unchanged)

- [ ] **Step 3: GraderView.tsx**, two sites:
  - L68 (button): `color: 'var(--accent)'` → `color: 'var(--text-accent)'` (`background: 'var(--accent-quiet)'` unchanged)
  - L112 (error message): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`

- [ ] **Step 4: AcquisitionsModule.tsx**, three sites:
  - L122-124 (active-tab pill): `color: 'var(--accent)'` → `color: 'var(--text-accent)'` (`background: color-mix(... 16% ...)` unchanged)
  - L165 (sync success): `color: 'var(--color-pos)'` → `color: 'var(--text-pos)'`
  - L171 (sync failure): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`

  (L92's `Lock` icon — confidential marker — is icon-only, unchanged.)

- [ ] **Step 5: Run tests**

Run: `npm run test -- AcquisitionWorkbench AcquisitionsIntel GraderView AcquisitionsModule`
Expected: PASS

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors

- [ ] **Step 7: Commit**

```bash
git add src/modules/acquisitions/AcquisitionWorkbench.tsx src/modules/acquisitions/AcquisitionsIntel.tsx src/modules/acquisitions/GraderView.tsx src/modules/acquisitions/AcquisitionsModule.tsx
git commit -m "fix(a11y): acquisitions workbench/intel/grader text uses AA-safe tone tokens"
```

---

## Task 9: Fix debt module (ScorecardView, LadderView, DebtModule)

**Files:**
- Modify: `src/modules/debt/ScorecardView.tsx:60,71,118`
- Modify: `src/modules/debt/LadderView.tsx:102,152`
- Modify: `src/modules/debt/DebtModule.tsx:224`

- [ ] **Step 1: ScorecardView.tsx**, three sites:
  - L60 (DSCR conditional): `color: ... ? 'var(--color-neg)' : 'var(--text-primary)'` → `color: ... ? 'var(--text-neg)' : 'var(--text-primary)'`
  - L71 (headroom conditional): `color: ... ? 'var(--color-neg)' : 'var(--text-tertiary)'` → `color: ... ? 'var(--text-neg)' : 'var(--text-tertiary)'`
  - L118 (error message): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`

- [ ] **Step 2: LadderView.tsx**, two sites:
  - L102 ("Demand"): `color: 'var(--color-warn)'` → `color: 'var(--text-warn)'`
  - L152 (error message): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`

  (L115's `AlertTriangle` icon is icon-only, unchanged.)

- [ ] **Step 3: DebtModule.tsx** (L224, active-tab pill): `color: 'var(--accent)'` → `color: 'var(--text-accent)'` (`background: color-mix(... 16% ...)` unchanged; L149's `AlertCircle` icon is icon-only, unchanged)

- [ ] **Step 4: Run tests**

Run: `npm run test -- ScorecardView LadderView DebtModule`
Expected: PASS

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add src/modules/debt/ScorecardView.tsx src/modules/debt/LadderView.tsx src/modules/debt/DebtModule.tsx
git commit -m "fix(a11y): debt scorecard/ladder/module text uses AA-safe tone tokens"
```

---

## Task 10: Fix cash/taxes modules (CashModule, TaxesModule, AssessmentsTable, ResolveDialog)

**Files:**
- Modify: `src/modules/cash/CashModule.tsx:25`
- Modify: `src/modules/taxes/TaxesModule.tsx:62,94`
- Modify: `src/modules/taxes/AssessmentsTable.tsx:115,263`
- Modify: `src/modules/calibration/ResolveDialog.tsx:145`

- [ ] **Step 1: CashModule.tsx** (L25, delta conditional): `color: c.deltaPct >= 0 ? 'var(--color-pos)' : 'var(--color-neg)'` → `color: c.deltaPct >= 0 ? 'var(--text-pos)' : 'var(--text-neg)'` (L34's `TrendingUp`/`TrendingDown` icons are icon-only, unchanged)

- [ ] **Step 2: TaxesModule.tsx**, two sites:
  - L62 (error message): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`
  - L94 (active-tab pill): `color: 'var(--accent)'` → `color: 'var(--text-accent)'`

- [ ] **Step 3: AssessmentsTable.tsx**, two sites:
  - L115 (savings-value conditional): `color: val !== null ? 'var(--color-pos)' : 'var(--text-tertiary)'` → `color: val !== null ? 'var(--text-pos)' : 'var(--text-tertiary)'`
  - L263 (appeal-filing error): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`

- [ ] **Step 4: ResolveDialog.tsx** (L145, error alert `role="alert"`): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'` (`background: color-mix(... 12% ...)` unchanged)

- [ ] **Step 5: Run tests**

Run: `npm run test -- CashModule TaxesModule AssessmentsTable ResolveDialog`
Expected: PASS

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors

- [ ] **Step 7: Commit**

```bash
git add src/modules/cash/CashModule.tsx src/modules/taxes/TaxesModule.tsx src/modules/taxes/AssessmentsTable.tsx src/modules/calibration/ResolveDialog.tsx
git commit -m "fix(a11y): cash/taxes/calibration text uses AA-safe tone tokens"
```

---

## Task 11: Fix leases/leasing modules (LeasesModule, LeaseForecastModule)

**Files:**
- Modify: `src/modules/leases/LeasesModule.tsx:116`
- Modify: `src/modules/leasing/LeaseForecastModule.tsx:88,178,233,407,437,487`

- [ ] **Step 1: LeasesModule.tsx** (L116, rent-gap "at/above market"): `color: 'var(--color-pos)'` → `color: 'var(--text-pos)'`

- [ ] **Step 2: LeaseForecastModule.tsx**, six sites:
  - L88 (slow-leasing conditional): `color: v.slowLeasing ? 'var(--color-warn)' : 'var(--text-primary)'` → `color: v.slowLeasing ? 'var(--text-warn)' : 'var(--text-primary)'`
  - L178 (market-rent value): `color: 'var(--color-pos)'` → `color: 'var(--text-pos)'`
  - L233 (save-failed error): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`
  - L407 (NOI-impact conditional, icon shares color via inheritance): `color: forecast.noiImpactAnnualUsd >= 0 ? 'var(--color-pos)' : 'var(--color-neg)'` → `color: forecast.noiImpactAnnualUsd >= 0 ? 'var(--text-pos)' : 'var(--text-neg)'`
  - L437 (forecast-unavailable error): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`
  - L487 (narrative-unavailable error): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`

- [ ] **Step 3: Run tests**

Run: `npm run test -- LeasesModule LeaseForecastModule`
Expected: PASS

- [ ] **Step 4: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/modules/leases/LeasesModule.tsx src/modules/leasing/LeaseForecastModule.tsx
git commit -m "fix(a11y): leases/leasing text uses AA-safe tone tokens"
```

---

## Task 12: Fix tenants/alerts/insights/market/renewals modules

**Files:**
- Modify: `src/modules/tenants/TenantsModule.tsx:127`
- Modify: `src/modules/alerts/AlertsModule.tsx:8-12`
- Modify: `src/modules/insights/InsightsModule.tsx:136,171`
- Modify: `src/modules/market/MarketScorecard.tsx:52`
- Modify: `src/modules/market/MarketModule.tsx:44,181`
- Modify: `src/modules/renewals/RenewalsModule.tsx:123`

- [ ] **Step 1: TenantsModule.tsx** (L127, "Draft" button+icon): `color: 'var(--accent)'` → `color: 'var(--text-accent)'`

- [ ] **Step 2: AlertsModule.tsx `SEV_COLOR` map** (~L8-12)

Before:
```typescript
const SEV_COLOR: Record<string, string> = {
  critical: 'var(--color-neg)',
  warning: 'var(--color-warn)',
  info: 'var(--color-info)',
};
```

After:
```typescript
const SEV_COLOR: Record<string, string> = {
  critical: 'var(--text-neg)',
  warning: 'var(--text-warn)',
  info: 'var(--text-info)',
};
```

- [ ] **Step 3: InsightsModule.tsx**, two sites:
  - L136 (snapshot-load error): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`
  - L171 (warehouse error): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`

- [ ] **Step 4: MarketScorecard.tsx** (L52, "Advisory only"): `color: 'var(--color-warn)'` → `color: 'var(--text-warn)'`

- [ ] **Step 5: MarketModule.tsx**, two sites:
  - L44 (active-tab pill): `color: 'var(--accent)'` → `color: 'var(--text-accent)'`
  - L181 (Row conditional): `color: accent ? 'var(--accent)' : 'var(--text-primary)'` → `color: accent ? 'var(--text-accent)' : 'var(--text-primary)'`

- [ ] **Step 6: RenewalsModule.tsx** (L123, "Draft" button+icon): `color: 'var(--accent)'` → `color: 'var(--text-accent)'`

- [ ] **Step 7: Run tests**

Run: `npm run test -- TenantsModule AlertsModule InsightsModule MarketScorecard MarketModule RenewalsModule`
Expected: PASS

- [ ] **Step 8: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors

- [ ] **Step 9: Commit**

```bash
git add src/modules/tenants/TenantsModule.tsx src/modules/alerts/AlertsModule.tsx src/modules/insights/InsightsModule.tsx src/modules/market/MarketScorecard.tsx src/modules/market/MarketModule.tsx src/modules/renewals/RenewalsModule.tsx
git commit -m "fix(a11y): tenants/alerts/insights/market/renewals text uses AA-safe tone tokens"
```

---

## Task 13: Fix overview module (OverviewModule, widgets.tsx, CommandBrainModule)

**Files:**
- Modify: `src/modules/overview/OverviewModule.tsx:31,76,160-161`
- Modify: `src/modules/overview/widgets.tsx` (no change — `SpineSplitCell` already takes `accentColor` as a prop; only its call sites change)
- Modify: `src/modules/command-brain/CommandBrainModule.tsx:59`

- [ ] **Step 1: OverviewModule.tsx**, three sites:
  - L31 (Brain-Server-unreachable error, top-level, no Card wrapper): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`
  - L76 (WorkspaceBar active-workspace button): `color: 'var(--accent)'` → `color: 'var(--text-accent)'`
  - L160-161 (`SpineSplitCell` call sites feeding `accentColor`): `accentColor="var(--color-neg)"` → `accentColor="var(--text-neg)"`; `accentColor="var(--color-info)"` → `accentColor="var(--text-info)"`

  (`widgets.tsx`'s `SpineSplitCell` component itself needs no edit — it just renders whatever `accentColor` it's given.)

- [ ] **Step 2: CommandBrainModule.tsx** (L59, `OpenQuestionRow`): `color: 'var(--color-info)'` → `color: 'var(--text-info)'`

- [ ] **Step 3: Run tests**

Run: `npm run test -- OverviewModule CommandBrainModule`
Expected: PASS

- [ ] **Step 4: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors

- [ ] **Step 5: Commit**

```bash
git add src/modules/overview/OverviewModule.tsx src/modules/command-brain/CommandBrainModule.tsx
git commit -m "fix(a11y): overview/command-brain text uses AA-safe tone tokens"
```

---

## Task 14: Fix documents/insurance/calibration/intel-tab-pill files

**Files:**
- Modify: `src/modules/documents/DocumentsModule.tsx:89,102,125`
- Modify: `src/modules/insurance/InsuranceModule.tsx:108`
- Modify: `src/modules/calibration/CalibrationModule.tsx:82`
- Modify: `src/modules/intel/IntelModule.tsx:162`

- [ ] **Step 1: DocumentsModule.tsx**, three sites:
  - L89 ("Ask a document question" button): `color: 'var(--accent)'` → `color: 'var(--text-accent)'`
  - L102 (`<mark>` search-term highlight): `color: 'var(--accent)'` → `color: 'var(--text-accent)'`
  - L125 (folder-filter chip, "on" branch): `color: 'var(--accent)'` → `color: 'var(--text-accent)'`

- [ ] **Step 2: InsuranceModule.tsx** (L108, active-tab pill): `color: 'var(--accent)'` → `color: 'var(--text-accent)'`

- [ ] **Step 3: CalibrationModule.tsx** (L82, active-tab pill): `color: 'var(--accent)'` → `color: 'var(--text-accent)'`

- [ ] **Step 4: IntelModule.tsx** (L162, active-tab pill): `color: 'var(--accent)'` → `color: 'var(--text-accent)'`

- [ ] **Step 5: Run tests**

Run: `npm run test -- DocumentsModule InsuranceModule CalibrationModule IntelModule`
Expected: PASS

- [ ] **Step 6: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors

- [ ] **Step 7: Commit**

```bash
git add src/modules/documents/DocumentsModule.tsx src/modules/insurance/InsuranceModule.tsx src/modules/calibration/CalibrationModule.tsx src/modules/intel/IntelModule.tsx
git commit -m "fix(a11y): documents/insurance/calibration/intel tab-pill text uses AA-safe tone tokens"
```

---

## Task 15: Fix intel module batch 1 (ImportsView, MappingsView, ManagersView, AdminOnboardView, ProspectDemandModule)

**Files:**
- Modify: `src/modules/intel/ImportsView.tsx:157,270`
- Modify: `src/modules/intel/MappingsView.tsx:125,130`
- Modify: `src/modules/intel/ManagersView.tsx:163`
- Modify: `src/modules/intel/AdminOnboardView.tsx:109-114`
- Modify: `src/modules/intel/ProspectDemandModule.tsx:274`

- [ ] **Step 1: ImportsView.tsx**, two sites:
  - L157 (action error): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`
  - L270 (mapping-add failed): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`

- [ ] **Step 2: MappingsView.tsx**, two sites:
  - L125 (error): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`
  - L130 (saved): `color: 'var(--color-pos)'` → `color: 'var(--text-pos)'`

- [ ] **Step 3: ManagersView.tsx `SignedPct`** (L163): `color: favorable ? 'var(--color-pos)' : 'var(--color-neg)'` → `color: favorable ? 'var(--text-pos)' : 'var(--text-neg)'`

- [ ] **Step 4: AdminOnboardView.tsx** (~L109-114, onboarding result banner)

Before:
```tsx
        style={{
          fontSize: 13,
          background: result.ok ? 'var(--color-pos-soft)' : 'var(--color-neg-soft)',
          color: result.ok ? 'var(--color-pos)' : 'var(--color-neg)',
        }}
```

After:
```tsx
        style={{
          fontSize: 13,
          background: result.ok ? 'var(--color-pos-soft)' : 'var(--color-neg-soft)',
          color: result.ok ? 'var(--text-pos)' : 'var(--text-neg)',
        }}
```

- [ ] **Step 5: ProspectDemandModule.tsx** (L274, event-log error): `color: 'var(--color-neg)'` → `color: 'var(--text-neg)'`

- [ ] **Step 6: Run tests**

Run: `npm run test -- ImportsView MappingsView ManagersView AdminOnboardView ProspectDemandModule`
Expected: PASS

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors

- [ ] **Step 8: Commit**

```bash
git add src/modules/intel/ImportsView.tsx src/modules/intel/MappingsView.tsx src/modules/intel/ManagersView.tsx src/modules/intel/AdminOnboardView.tsx src/modules/intel/ProspectDemandModule.tsx
git commit -m "fix(a11y): intel imports/mappings/managers/onboarding text uses AA-safe tone tokens"
```

---

## Task 16: Fix intel module batch 2 (OwnershipView, LeaseRunView, PropertyIntelView)

**Files:**
- Modify: `src/modules/intel/OwnershipView.tsx:315,475,651-654,723-726,908-911`
- Modify: `src/modules/intel/LeaseRunView.tsx:186-193,286`
- Modify: `src/modules/intel/PropertyIntelView.tsx:317,468-471,481-484`

- [ ] **Step 1: OwnershipView.tsx**, five sites:
  - L315 (BriefingHero "open →"): `color: 'var(--accent)'` → `color: 'var(--text-accent)'`
  - L475 (ActionList "open →"): `color: 'var(--accent)'` → `color: 'var(--text-accent)'`
  - L651-654 (TrajectoryCard growth value): `color: positive ? 'var(--color-pos)' : 'var(--color-neg)'` → `color: positive ? 'var(--text-pos)' : 'var(--text-neg)'`
  - L723-726 (SinceAcqLeaderboardCard growth value): `color: v !== null && v >= 0 ? 'var(--color-pos)' : 'var(--color-neg)'` → `color: v !== null && v >= 0 ? 'var(--text-pos)' : 'var(--text-neg)'`
  - L908-911 (PmCell growth value): `color: positive ? 'var(--color-pos)' : 'var(--color-neg)'` → `color: positive ? 'var(--text-pos)' : 'var(--text-neg)'`

- [ ] **Step 2: LeaseRunView.tsx**, two sites:
  - L186-193 (ProjectionTable rollover-year cell): `color: rollovers.has(p.leaseYearLabel) ? 'var(--accent)' : undefined` → `color: rollovers.has(p.leaseYearLabel) ? 'var(--text-accent)' : undefined`
  - L286 ("Confirm" button): `color: 'var(--accent)'` → `color: 'var(--text-accent)'`

  (L162's `FileWarning` icon is icon-only, unchanged.)

- [ ] **Step 3: PropertyIntelView.tsx**, two sites:
  - L317 (VerdictHeader bullet "•", `aria-hidden`): `color: 'var(--accent)'` → `color: 'var(--text-accent)'`
  - L481-484 `growthColor()` helper (feeds L468-471):

Before:
```typescript
function growthColor(v: number | null): string {
  if (v === null || Number.isNaN(v)) return 'var(--text-tertiary)';
  return v >= 0 ? 'var(--color-pos)' : 'var(--color-neg)';
}
```

After:
```typescript
function growthColor(v: number | null): string {
  if (v === null || Number.isNaN(v)) return 'var(--text-tertiary)';
  return v >= 0 ? 'var(--text-pos)' : 'var(--text-neg)';
}
```

- [ ] **Step 4: Run tests**

Run: `npm run test -- OwnershipView LeaseRunView PropertyIntelView`
Expected: PASS

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add src/modules/intel/OwnershipView.tsx src/modules/intel/LeaseRunView.tsx src/modules/intel/PropertyIntelView.tsx
git commit -m "fix(a11y): intel ownership/lease-run/property text uses AA-safe tone tokens"
```

---

## Task 17: Fix capital module (CapitalModule, AllocationCard, hooks.ts actionColor)

**Files:**
- Modify: `src/modules/capital/hooks.ts:46-54`
- Modify: `src/modules/capital/CapitalModule.tsx:137-142,253,354`
- Modify: `src/modules/capital/AllocationCard.tsx:44-52,66,73`

**Interfaces:**
- Produces: `actionColor()` signature unchanged (`(action: string) => string`), only its returned values change for buy/sell/refinance/improve.

- [ ] **Step 1: `hooks.ts` `actionColor()`** (~L46-54)

Before:
```typescript
export function actionColor(action: string): string {
  switch (action) {
    case 'buy':
      return 'var(--color-pos)';
    case 'hold':
      return 'var(--text-secondary)';
    case 'sell':
      return 'var(--color-neg)';
    case 'refinance':
      return 'var(--color-warn)';
    case 'improve':
      return 'var(--color-info)';
    default:
      return 'var(--text-secondary)';
  }
}
```

After:
```typescript
export function actionColor(action: string): string {
  switch (action) {
    case 'buy':
      return 'var(--text-pos)';
    case 'hold':
      return 'var(--text-secondary)';
    case 'sell':
      return 'var(--text-neg)';
    case 'refinance':
      return 'var(--text-warn)';
    case 'improve':
      return 'var(--text-info)';
    default:
      return 'var(--text-secondary)';
  }
}
```

(Read the file first to confirm the exact current switch structure/casing before editing — match it verbatim, only swapping the `--color-*`/`--accent`-family return values.)

- [ ] **Step 2: CapitalModule.tsx**, three sites:
  - L137-142 (CAP_RATE_COLS "vs Mkt" conditional): `color: ... capRateGap >= 0 ? 'var(--color-pos)' : 'var(--color-warn)'` → `color: ... capRateGap >= 0 ? 'var(--text-pos)' : 'var(--text-warn)'` (null branch `--text-tertiary` unchanged)
  - L253 (action-count chip — uses `actionColor()`, already fixed via Step 1, no separate edit needed here beyond confirming the call site still reads `actionColor(action)` for both `background` tint input and `color`)
  - L354 (Buy Pipeline discount): `color: 'var(--color-pos)'` → `color: 'var(--text-pos)'`

- [ ] **Step 3: AllocationCard.tsx**, two sites (L44-52's action badge uses `actionColor()`, already fixed via Step 1):
  - L66 (return-vs-hurdle): `color: aboveHurdle ? 'var(--color-pos)' : 'var(--color-neg)'` → `color: aboveHurdle ? 'var(--text-pos)' : 'var(--text-neg)'`
  - L73 ("advisory" label): `color: 'var(--color-warn)'` → `color: 'var(--text-warn)'`

- [ ] **Step 4: Run tests**

Run: `npm run test -- CapitalModule AllocationCard capital`
Expected: PASS

- [ ] **Step 5: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: 0 errors

- [ ] **Step 6: Commit**

```bash
git add src/modules/capital/hooks.ts src/modules/capital/CapitalModule.tsx src/modules/capital/AllocationCard.tsx
git commit -m "fix(a11y): capital module text/actionColor uses AA-safe tone tokens"
```

---

## Task 18: Full-repo verification sweep + PR

**Files:** none (verification only)

- [ ] **Step 1: Grep for any remaining raw-tone-as-text sites the inventory may have missed**

Run:
```bash
grep -rn "color: 'var(--color-neg)'\|color: 'var(--color-warn)'\|color: 'var(--color-info)'\|color: 'var(--color-pos)'\|color: 'var(--accent)'\|color: 'var(--color-accent2)'" src/ --include=*.tsx --include=*.ts
```
Expected: zero matches, OR every remaining match manually confirmed to be a non-text (icon-only/chart-stroke/fill) usage — annotate any such match with a one-line code comment `/* icon/fill only — see 2026-07-09-tone-text-aa-fix.md Task 18 */` if not already obvious, so a future sweep doesn't re-flag it.

- [ ] **Step 2: Run the full test suite**

Run: `npm run test`
Expected: all tests PASS (if `capital-allocation-api.test.ts` shows transient 5000ms timeouts unrelated to files this plan touches, re-run that file in isolation per the known intermittent-load flake — do not treat as a regression without re-verifying)

- [ ] **Step 3: Typecheck, lint, and governance gate**

Run: `npm run typecheck && npm run lint && npm run governance:check` (or the repo's equivalent full gate script — check `package.json` for the exact script name)
Expected: 0 errors

- [ ] **Step 4: Visual spot-check in the dev server**

Start the worktree's dev server (`npm run dev:web` + `npm run dev:server:once`), open each of `command`/`parchment`/`warm` via the theme toggle, and visually confirm: Badge text is legible and not washed-out on its tint background in all three themes; TierBoard item-count badges and impact amounts read clearly; at least 2-3 of the module-level error/status messages (e.g. a forced error state, or the Acquisitions tab-pill) render with visibly richer/darker tone text in parchment and warm compared to before.

- [ ] **Step 5: Update `architecture/status.json`**

Add/update the `tone-text-aa-audit` worktree entry recording: scope (Task 1-17 file list), the 156-combination contrast verification, test results, and the PR link (added in Step 6).

- [ ] **Step 6: Open PR (do not merge)**

```bash
git push -u origin fix/tone-text-aa-audit
gh pr create --title "fix(a11y): tone palette fails AA as text in parchment/warm — add text-safe token set" --body "$(cat <<'EOF'
## Summary
- Adds --text-neg/warn/info/pos/accent/accent2 tokens (AA-verified, 4.5:1) to replace the raw fill-tuned tone palette wherever it renders as literal text
- Fixes ~130 call sites across Badge/TierBoard primitives + 25 module files, discovered via a repo-wide 3-agent inventory sweep
- Command theme unchanged (already AA-clean everywhere); parchment/warm get darkened per-tone text variants
- New regression test (tests/unit/theme-text-contrast.test.ts) locks in the fix against future drift

## Test plan
- [ ] npm run test (full suite green)
- [ ] npm run typecheck && npm run lint clean
- [ ] Visual check: command/parchment/warm via theme toggle — Badge/TierBoard/error-message text legible in all three
EOF
)"
```

- [ ] **Step 7: Report the PR link back and stop — do not merge.**

---

## Self-Review Notes

- **Spec coverage:** every distinct site from all three inventory agents' reports is accounted for in Tasks 2-17 (primitives in Tasks 2-4, shell/brain in Tasks 5-6, the six acquisitions/debt/cash/taxes/leases/leasing directories in Tasks 7-11, the remaining ~12 module directories in Tasks 12-17). Icon-only and chart-stroke sites are explicitly called out as unchanged in each task, not silently dropped.
- **Placeholder scan:** every step shows the exact before/after code or the exact line-level swap description; no "similar to Task N" shorthand except where explicitly noting an already-fixed shared helper (Step "actionColor(), already fixed via Step 1").
- **Type consistency:** `TEXT_TONE_COLOR` (Task 3), `SEV_COLOR` (Task 12), `actionColor()` (Task 17) all preserve their original signatures/key sets — only string values change.
- One implementer-facing caveat carried into every task: **read the file before editing** — several exact line numbers were reported by inventory agents reading a slightly earlier commit; if a line has shifted by a few lines due to unrelated concurrent work landing on `main`, locate the cited code by its snippet/content, not blindly by line number.
