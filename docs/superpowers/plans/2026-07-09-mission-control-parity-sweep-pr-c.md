# Mission-Control Parity Sweep (PR-C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring every remaining `oxford-command-center` module to Mission-Control visual parity — the "re-QA of all modules against the new tokens" line item that PR-A (token layer) and PR-B (shared primitives + Insights) did not cover. Remediate the token-bypasses found by live grep (§Ground-truth findings) and visually confirm the modules that inherit correctly. Visual/token only — no functional or behavioral change.

**Architecture:** Work lands only on `src/modules/**` (four module directories carry real edits: `acquisitions/`, `capital/`, `intel/`, `market/`; the rest are confirmation-only). No architect-owned files are touched — verified against `.claude/hooks/architect-owned.json`, whose globs are `CLAUDE.md`, `architecture/**`, `package.json`, `tsconfig*.json`, `vite.config.ts`, `server/index.ts`, `src/contracts/**`, `src/analytics/engine.ts`, `scripts/governance-check.ts`, `server/warehouse/{db,migrate}.ts`, `server/warehouse/migrations/**`; none match `src/modules/**`. The one `architecture/**` touch is this plan's own `status.json` claim entry, which is the sanctioned worktree-declaration exception every agent uses (PR-A/PR-B both did it).

**Tech Stack:** React 19, Tailwind v4 CSS-first tokens, `react-aria-components`, `framer-motion`, vitest + @testing-library/react, Playwright + axe.

---

## Preconditions — READ BEFORE ANY EXECUTION

This plan was authored while **PR-B was still in-progress and unmerged**, and — a second, sharper caveat found during authoring — **this worktree does not yet contain PR-A either.** Ground truth verified 2026-07-09:

1. **This worktree (`mission-control-parity-sweep`) is branched from a commit that PREDATES PR-A's merge to `origin/main`.** Its `src/tokens/theme.css` still reads `THE OXFORD TERMINAL` and `--color-gold-500: #c9a96e`; its `architecture/status.json` has no `mission-control-retokenization` entry. The merge-base with `origin/main` is `3802074` (a warehouse-verify EPERM fix), whereas PR-A merged at `origin/main` tip `c373c69` ("mission-control-retokenization MERGED via PR #186"). The local `main` checkout is likewise stale (behind `origin/main`, no PR-A).
2. **Therefore, before executing ANY task in this plan, re-create the working branch fresh from a `main` that actually contains BOTH PR-A (#186) AND merged PR-B.** Do not execute against this worktree's current tree — its token layer is pre-Mission-Control, so every "renders after PR-A as…" observation in the findings below would be untestable and every contrast check meaningless.
3. **Re-verify every file-level assumption (paths AND line numbers) against the ACTUAL merged PR-A + PR-B diffs before editing.** Line numbers in this plan were read from the pre-PR-A tree and WILL drift once PR-A's sweep and PR-B's edits are present. PR-B's own plan is precedent for why this matters: its task list changed once during planning (its Global Constraints record that the FilterPill fix applied only to `InsightsModule.tsx`, not `OverviewModule.tsx` as its spec had assumed). Treat every line number here as "approximately here — re-grep to confirm," not "edit this line."
4. **Do not open the PR until PR-B has actually merged to main.** This plan assumes PR-B's changes (shared-primitive polish + the `--text-on-accent` AA fix) as a baseline; PR-C's contrast pass is only valid against the hardened `--text-on-accent`. See Task 9.
5. Confirm with Gabriel that the Mission-Control direction still holds and that PR-B merged as expected before starting (same-day-volatility caution inherited from PR-A spec §1).

## Global Constraints

- **Visual/token only.** No prop, data-flow, routing, analytics, copy, or logic change. A raw-hex → semantic-var substitution is not a behavior change; anything beyond that is out of scope.
- **Semantic-vars-only.** After this PR, no module source contains a raw color literal (`#hex`/`rgb()`/`rgba()`/`hsl()` used as a color) or a `var(--x)` referencing a token undefined in `theme.css`. Non-color hex is exempt.
- **WCAG AA (≥4.5:1).** Text on an `--accent`/`--color-*` fill uses `var(--text-on-accent)`, never a hardcoded `#fff`/`#000`.
- **No `theme.css`, `src/primitives/**`, `src/shell/**`, `src/charts/**` edits.** Those are PR-A/PR-B territory. A parity defect that traces to a primitive is recorded as a PR-B follow-up, not fixed in a module.
- **Do not edit `server/briefing/**`** (the server-only PDF brand system) — but DO grep the whole repo, not just `src/`, in any leftover sweep (PR-A's post-merge CI lesson: an `src/`-scoped grep missed `server/briefing/theme.ts`'s font `require.resolve()`s and broke CI).
- **`insights` module is PR-B's**, not touched here.
- `npm run gate` (7 steps) + `npm run check:bundle` green before the final commit.

## Ground-truth findings (live grep of `src/modules/**`, 2026-07-09; re-verify against merged main per Preconditions)

Full classification and the module→directory map are in the companion spec §4. Summary:

- **`rgb()/rgba()/hsl()`: zero hits** anywhere in `src/modules/**`. No local chart color arrays or hardcoded `fill=`/`stroke=` — chart color is centralized in `src/charts/theme.ts` (PR-A-owned), so no module-level chart risk.
- **Class A (real bypass, remediate):** `acquisitions/RankedCandidateList.tsx:13-14,16`, `acquisitions/GraderView.tsx:107`, `acquisitions/OmImportDrawer.tsx:104`, `capital/CapitalModule.tsx:183-184`, `capital/hooks.ts:48`, `intel/AdminOnboardView.tsx:111-112`.
- **Class B (dead fallback on a real token, hygiene):** `market/MarketScorecard.tsx:18,52`, `capital/AllocationCard.tsx:22,66,73`, `capital/HurdleRateBanner.tsx:16,17`, `capital/CapitalModule.tsx:354`, `capital/hooks.ts:50,51,52`.
- **Class C (PR-A-swept, re-verify only, do NOT re-fix):** `overview/widgets.tsx:39`, `intel/LeaseRunView.tsx:162,189,286`.
- **Class D (100% semantic, visual-confirmation only):** everything else — principal, tasks, alerts, calendar, renewals, command-brain, portfolio, calibration, leases, leasing, tenants, prospect-demand, debt, cash, close, insurance, taxes, documents, health. The feared "newest, eye-tuned-under-Oxford-Terminal" modules (Taxes, Insurance, Command Brain, Debt Scorecard) were each confirmed to use ONLY semantic tokens — they are Class D.

---

### Task 1: `acquisitions/` (pipeline / Acquisitions) — retire navy/gold tier literals + `#fff`-on-accent

**Files:**
- Modify: `src/modules/acquisitions/RankedCandidateList.tsx`
- Modify: `src/modules/acquisitions/GraderView.tsx`
- Modify: `src/modules/acquisitions/OmImportDrawer.tsx`

**Interfaces:** No signature change anywhere — every edit is a color-value substitution.

**Context (pre-PR-A line numbers — re-grep):** `RankedCandidateList.tsx`'s `TIER_STYLES` map (≈line 12) hardcodes Oxford-Terminal literals: `T1 { bg:'#C9A96E', color:'#1B2A4A' }`, `T2 { bg:'#1B2A4A', color:'#F5F3EF' }`, `KILLED { bg:'var(--color-neg)', color:'#fff' }` (PASS already uses `var(--surface-overlay)`/`var(--text-tertiary)`). `GraderView.tsx:≈107` sets `color:'#fff'` on a `background:var(--accent)` button. `OmImportDrawer.tsx:≈104` sets `btnPrimary.color:'#fff'` on `background:var(--accent)`. This is the highest-severity real defect in the sweep: the acquisition tier badges render navy/gold under Mission Control.

- [ ] **Step 1: Re-grep to confirm the exact current lines**

Run: `grep -nE "#C9A96E|#1B2A4A|#F5F3EF|'#fff'|\"#fff\"" src/modules/acquisitions/*.tsx`. Confirm each literal below still exists (line numbers will differ post-PR-A/PR-B). If any is already gone (e.g., PR-A/PR-B pre-fixed it), skip that sub-edit and note it.

- [ ] **Step 2: `RankedCandidateList.tsx` — tokenize `TIER_STYLES`**

Per spec §5's flagged mapping (T1 = accent highlight, T2 = quiet neutral):
```typescript
  T1:     { label: 'T1 · PURSUE', bg: 'var(--accent)',          color: 'var(--text-on-accent)' },
  T2:     { label: 'T2 · WATCH',  bg: 'var(--surface-overlay)', color: 'var(--text-secondary)' },
  PASS:   { label: 'PASS',        bg: 'var(--surface-overlay)', color: 'var(--text-tertiary)' },
  KILLED: { label: 'KILLED',      bg: 'var(--color-neg)',       color: 'var(--text-on-accent)' },
```
(T1/T2 mapping is a flagged judgment call — call it out in the PR body for Gabriel; the mapping above is the recommendation, not a ratified value. `KILLED`'s `#fff` → `var(--text-on-accent)` so it tracks the AA fix on the `--color-neg` fill.)

- [ ] **Step 3: `GraderView.tsx` and `OmImportDrawer.tsx` — `#fff` → `var(--text-on-accent)`**

Both are white text on a `var(--accent)` fill; both must use `var(--text-on-accent)` so PR-B Task 10's parchment/warm AA fix reaches them.

- [ ] **Step 4: Verify**

Run: `grep -rln "RankedCandidateList\|GraderView\|OmImportDrawer" tests/unit/` and run any matching tests (they assert behavior/labels, not colors, so should pass unchanged). Run `npx tsc --noEmit`. Then `npm run dev`, open Acquisitions, view a T1/T2/PASS/KILLED badge and the Grade + OM-import primary buttons in all three themes; confirm T1 reads as an accent highlight, T2/PASS are distinct quiet neutrals, and no navy/gold survives. **Stop the dev server when done.**

- [ ] **Step 5: Commit**

```bash
git add src/modules/acquisitions/RankedCandidateList.tsx src/modules/acquisitions/GraderView.tsx src/modules/acquisitions/OmImportDrawer.tsx
git commit -m "fix(acquisitions): retire navy/gold tier literals + #fff-on-accent → semantic tokens (Mission-Control parity)"
```

**Failure-proofing:** The single largest regression risk here is editing a line by number that PR-A/PR-B moved — Step 1's re-grep is mandatory, not optional. Second risk: the T1/T2 mapping is a *visual* decision, not a mechanical swap — do not treat the recommended tokens as settled; if the badges look wrong or ambiguous in any theme during Step 4, stop and flag rather than iterating colors freehand (that would drift into un-ratified brand design). Third: confirm `--text-on-accent` actually exists and is AA-correct in merged main BEFORE relying on it (it is PR-B Task 10's deliverable) — if PR-B did not merge that fix, this task's `#fff` substitutions inherit the same latent contrast gap and Task 9's axe pass will catch it; do not proceed to open the PR in that state.

---

### Task 2: `capital/` — undefined `--gold`/`--navy`/`--color-emerald` + dead-fallback hygiene

**Files:**
- Modify: `src/modules/capital/CapitalModule.tsx`
- Modify: `src/modules/capital/hooks.ts`
- Modify: `src/modules/capital/AllocationCard.tsx`
- Modify: `src/modules/capital/HurdleRateBanner.tsx`

**Interfaces:** No signature change — color-value substitutions only.

**Context (re-grep for exact lines):** Two real bypasses via undefined tokens: `CapitalModule.tsx:≈183-184` uses `var(--gold, #C9A96E)` and `var(--navy, #1B2A4A)` (neither token exists → always old navy/gold); `hooks.ts:≈48` uses `var(--color-emerald, #10b981)` for the 'buy' verdict color (`--color-emerald` never existed → always generic emerald). The rest are dead fallbacks on REAL tokens (render correctly today; strip the fallback for the semantic-vars-only rule): `AllocationCard.tsx:22,66,73`, `HurdleRateBanner.tsx:16,17`, `CapitalModule.tsx:354`, `hooks.ts:50,51,52`.

- [ ] **Step 1: Re-grep**

Run: `grep -nE "var\(--(gold|navy|color-emerald)|, ?#[0-9a-fA-F]{3,8}\)" src/modules/capital/*.ts src/modules/capital/*.tsx`. Confirm the real bypasses and enumerate every dead fallback still present.

- [ ] **Step 2: `CapitalModule.tsx` — fix the two undefined-token bypasses**

`border: '1px solid var(--gold, #C9A96E)'` → `border: '1px solid var(--accent)'`. `color: disabled ? 'var(--text-tertiary)' : 'var(--navy, #1B2A4A)'` → `color: disabled ? 'var(--text-tertiary)' : 'var(--text-primary)'` (the `--navy` was serving as an emphasized-text color on a light surface; `--text-primary` is the theme-correct equivalent — confirm visually it's the intended emphasis, not an accent; if it was meant as an accent, use `var(--accent)` instead — decide by looking at the rendered control in Step 5).

- [ ] **Step 3: `hooks.ts` — fix `--color-emerald`, strip dead fallbacks**

`case 'buy': return 'var(--color-emerald, #10b981)'` → `return 'var(--color-pos)'` ('buy' is the positive verdict; `--color-pos` is the theme's positive-green in all three themes, replacing the off-palette generic emerald). Strip the dead fallbacks on lines 50/51/52 (`var(--color-neg, #ef4444)` → `var(--color-neg)`, `var(--color-warn, #f59e0b)` → `var(--color-warn)`, `var(--color-info, #6366f1)` → `var(--color-info)`).

- [ ] **Step 4: `AllocationCard.tsx`, `HurdleRateBanner.tsx`, `CapitalModule.tsx:354` — strip dead fallbacks**

Every `var(--color-pos, #22c55e)` / `var(--color-warn, #f59e0b)` / `var(--color-neg, #ef4444)` → drop the `, #hex` fallback. Zero visual change (the real token already wins); this satisfies "no raw color literals."

- [ ] **Step 5: Verify**

Run: `grep -rln "CapitalModule\|AllocationCard\|HurdleRate\|capital/hooks" tests/unit/` and run matching tests. Run `npx tsc --noEmit`. Then `npm run dev`, open Capital, view a buy/sell/refinance/improve verdict color, the hurdle banner, an allocation card's health bar, and the bordered control from Step 2, in all three themes. Confirm the 'buy' verdict is now theme-green (not generic emerald) and the border/emphasis reads correctly with no navy/gold. **Stop the dev server when done.**

- [ ] **Step 6: Commit**

```bash
git add src/modules/capital/CapitalModule.tsx src/modules/capital/hooks.ts src/modules/capital/AllocationCard.tsx src/modules/capital/HurdleRateBanner.tsx
git commit -m "fix(capital): undefined --gold/--navy/--color-emerald tokens → semantic vars; strip dead hex fallbacks"
```

**Failure-proofing:** The `--navy`-as-text substitution in Step 2 is the one ambiguous call — `--navy` could have meant "emphasized dark text" (→ `--text-primary`) or "brand accent" (→ `--accent`); resolve it by observation in Step 5, not by guessing at edit time, and if genuinely unsure, flag it rather than pick. For the dead-fallback strips (Step 4), confirm each referenced token actually exists in all three theme blocks first (`grep -n '<token>' src/tokens/theme.css` on merged main) — a "dead fallback on a real token" is only safe to strip if the token is genuinely real; if a token turns out undefined, it belongs in Step 2/3's real-bypass bucket, not the hygiene bucket. Do not let the hygiene strips balloon into a repo-wide fallback purge (spec §5: hygiene only in files already opened for a real fix).

---

### Task 3: `intel/` (Property Financials) — remap `--success-*/--error-*`; re-verify PR-A sweep; confirm ProspectDemand

**Files:**
- Modify: `src/modules/intel/AdminOnboardView.tsx`
- Verify only (no edit expected): `src/modules/intel/LeaseRunView.tsx`, `src/modules/intel/ProspectDemandModule.tsx`, `src/modules/intel/IntelModule.tsx`

**Interfaces:** No signature change.

**Context:** `AdminOnboardView.tsx:≈111-112` references four undefined tokens (`--success-bg`, `--error-bg`, `--success-fg`, `--error-fg`) that always render generic Tailwind mint/pink (`#d1fae5`/`#fee2e2`/`#065f46`/`#991b1b`). Remap onto the existing semantic system rather than introducing new tokens (a `theme.css` change would be out of PR-C scope). `LeaseRunView.tsx:162,189,286` were PR-A's sweep targets — re-verify clean, do not re-fix. `ProspectDemandModule.tsx` and `IntelModule.tsx` are Class D (semantic-only) — visual confirm.

- [ ] **Step 1: `AdminOnboardView.tsx` — remap success/error to the semantic system**

Per spec §5: success → fg `var(--color-pos)` on bg `var(--color-pos-soft)`; error → fg `var(--color-neg)` on bg `var(--color-neg-soft)`. (Both `*-soft` tokens exist in all three theme blocks per PR-A §3.4 — confirm on merged main first.)
```typescript
            background: result.ok ? 'var(--color-pos-soft)' : 'var(--color-neg-soft)',
            color: result.ok ? 'var(--color-pos)' : 'var(--color-neg)',
```
Confirm the result banner's text clears AA against the `-soft` background in all three themes (soft = ~12% alpha fill; pos/neg fg on it should pass, but verify in Task 9's axe pass).

- [ ] **Step 2: Re-verify LeaseRunView is clean post-PR-A**

Run: `grep -nE "color-gold|#C9A96E|#c9a96e" src/modules/intel/LeaseRunView.tsx`. Expected on merged main: **zero** (PR-A Task 9 fixed 162/189, and PR-A's final `grep -rniE "color-gold..."` acceptance gate would have failed if line 286 survived). If any hit remains, PR-A's gate missed it — treat it as an in-scope remediation here (`var(--color-gold, …)` → `var(--accent)`, matching PR-A's own resolution) and note the PR-A gap in the PR body.

- [ ] **Step 3: Visual-confirm the Class-D intel views (no code expected)**

`npm run dev`, open Property Financials (IntelModule) and Demand Signals (ProspectDemandModule) in all three themes; confirm no old-brand color and no contrast/legibility regression. **Stop the dev server when done.**

- [ ] **Step 4: Verify + commit**

Run: `grep -rln "AdminOnboard\|LeaseRunView\|ProspectDemand\|IntelModule" tests/unit/` and run matching tests. `npx tsc --noEmit`.
```bash
git add src/modules/intel/AdminOnboardView.tsx
git commit -m "fix(intel): remap undefined --success-*/--error-* onto semantic color-pos/neg system"
```

**Failure-proofing:** Step 1's remap changes the admin banner from an opaque mint/pink block to a soft-alpha tinted block — visually different by design, but verify the `-soft` background is opaque enough behind the fg text to clear AA (soft tokens are ~12% alpha; if contrast fails in any theme, fall back to a solid `--surface-overlay` bg with `--color-pos`/`--color-neg` fg, and flag). Step 2 is the critical re-verify: if this task runs against a tree WITHOUT PR-A (the Precondition failure mode), the LeaseRunView grep will show false positives — confirm you are on merged main before trusting the result. Do not add new `--success-*`/`--error-*` tokens to `theme.css` to "fix" this — that is PR-A/PR-B territory and out of scope.

---

### Task 4: `market/` — strip dead fallbacks; visual-confirm the Market module

**Files:**
- Modify: `src/modules/market/MarketScorecard.tsx`
- Verify only: `src/modules/market/MarketModule.tsx` (and siblings)

**Interfaces:** No signature change.

**Context:** `MarketScorecard.tsx:18,52` use `var(--color-pos, #22c55e)` / `var(--color-warn, #f59e0b)` / `var(--color-neg, #ef4444)` — dead fallbacks on real tokens (render correctly today). Strip for the semantic-vars-only rule. The rest of the Market module is Class D.

- [ ] **Step 1: Strip the dead fallbacks**

`grep -nE ", ?#[0-9a-fA-F]{3,8}\)" src/modules/market/MarketScorecard.tsx`; drop each `, #hex` so `var(--color-pos, #22c55e)` → `var(--color-pos)`, etc. Zero visual change.

- [ ] **Step 2: Verify + visual-confirm**

`npx tsc --noEmit`; run any `grep -rln "MarketScorecard\|MarketModule" tests/unit/` matches. `npm run dev`, open Market in all three themes; confirm scorecard gradient cells and italic warn text render on-palette, no regression. **Stop the dev server when done.**

- [ ] **Step 3: Commit**

```bash
git add src/modules/market/MarketScorecard.tsx
git commit -m "chore(market): strip dead hex fallbacks in MarketScorecard (semantic-vars-only)"
```

**Failure-proofing:** Purely mechanical — the one risk is stripping a fallback whose token is actually undefined (which would change the rendered color). Confirm `--color-pos/warn/neg` exist in all three theme blocks on merged main before stripping. If `check:bundle`/lint flags an unexpected diff size, verify no CRLF/EOL flip crept in (repo stores CRLF blobs with `autocrlf=true` and no `.gitattributes`; use the Edit tool, which preserves EOL, not a script-based writeFileSync — per `reference_command_center_crlf_hazard`).

---

### Task 5: `overview/` — re-verify PR-A sweep + PR-B drill-down, visual confirm (no code expected)

**Files:** none expected (verification only). `src/modules/overview/widgets.tsx` is re-verified, not edited.

**Context:** `overview/widgets.tsx:39` was PR-A Task 9's fix (`--color-gold-400` → `var(--accent)`); PR-B Task 5 wired the KPI-strip drill-down and Task 2's `categoryTone` threads through Overview's tiers. Overview is otherwise Class D.

- [ ] **Step 1: Re-verify no brand leftover**

Run: `grep -nE "color-gold|color-navy|#c9a96e|#1b2a4a|#d8bd7e" src/modules/overview/`. Expected: zero on merged main. If any survives, PR-A/PR-B missed it — remediate to `var(--accent)` in-scope and note the gap.

- [ ] **Step 2: Visual confirm**

`npm run dev`, open Overview in all three themes; confirm the KPI strip (`KpiStripWidget`), priority-actions/insights TierBoards, results banner, and every widget read correctly, the severity glow (PR-B) and category tones render, and the drill-down affordance is present. **Stop the dev server when done.**

- [ ] **Step 3: No commit unless a leftover was found**

If Step 1 found and fixed a leftover: `git add src/modules/overview/widgets.tsx && git commit -m "fix(overview): sweep residual brand leftover missed by PR-A"`. Otherwise nothing to commit — record the confirmation in the PR body.

**Failure-proofing:** This task assumes both PR-A's `widgets.tsx:39` fix and PR-B's Overview-facing wiring are present — if run against a pre-PR-A/pre-PR-B tree, Step 1 will show a false leftover and Step 2 will lack the glow/drill-down. Confirm you are on merged main (Preconditions) before interpreting either. Do NOT re-implement PR-B's drill-down or glow here if it appears absent — that means PR-B did not merge, which is a Precondition failure; stop.

---

### Task 6: Command-group Class-D visual-confirmation batch (no code expected)

**Modules:** principal, tasks, alerts, calendar, renewals, command-brain. (`insights` = PR-B; `overview` = Task 5.)

**Files:** none expected — these are 100% semantic-var-driven and inherit PR-A + PR-B for free.

- [ ] **Step 1: Confirm still-clean**

Run: `grep -rnE "#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|var\(--(gold|navy|color-emerald|success-|error-)" src/modules/{principal,tasks,alerts,calendar,renewals,command-brain}/`. Expected: zero color-literal / undefined-token hits. If a hit appears (e.g., introduced since this plan was authored), remediate it in-scope following the Class-A pattern and note it.

- [ ] **Step 2: `?still=1` × 3-theme screenshot pass**

`npm run dev`; for each of the six modules, capture `?still=1` screenshots in `command`, `parchment`, `warm` (via `document.documentElement.setAttribute('data-theme', …)` or the ThemeToggle). Confirm: no old-brand color, AA-legible text, no density-doctrine violation (no long ungrouped single-column list where TierBoard applies), no layout regression. Attach to the PR. **Stop the dev server when done.**

- [ ] **Step 3: No commit unless Step 1 found a leftover.** Record the confirmation in the PR body.

**Failure-proofing:** The whole batch rests on "these are semantic-only" — Step 1's grep is the guard; if it is skipped and a raw hex slipped in since authoring, a module ships un-QA'd. The eye-check in Step 2 is not redundant with the grep: code can be fully tokenized yet still read wrong under teal (an amber that popped against navy may recede against near-black), so a color that is *technically correct* but *visually weak* is a finding to record even though it needs no code change — escalate it as a PR-B primitive/token follow-up if the fix belongs in the token layer, never patch it into a module.

---

### Task 7: Assets-group Class-D visual-confirmation batch (no code expected)

**Modules:** portfolio, calibration, leases, leasing, tenants, prospect-demand. (`intel` = Task 3.) Note `prospect-demand` renders from `src/modules/intel/ProspectDemandModule.tsx` (shares the `intel/` dir); it was visually confirmed in Task 3 Step 3 — re-confirm here only if not already captured.

**Files:** none expected.

- [ ] **Step 1: Confirm still-clean**

Run: `grep -rnE "#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|var\(--(gold|navy|color-emerald|success-|error-)" src/modules/{portfolio,calibration,leases,leasing,tenants}/`. Expected: zero. Remediate + note any surprise hit.

- [ ] **Step 2: `?still=1` × 3-theme screenshot pass** for portfolio, calibration, leases, leasing (LeaseForecastModule), tenants. Same acceptance as Task 6 Step 2. Attach to PR. **Stop the dev server when done.**

- [ ] **Step 3: No commit unless a leftover was found.**

**Failure-proofing:** `leases` and `leasing` are distinct registry modules (LeasesModule vs. LeaseForecastModule) sharing similar names — confirm you screenshot BOTH, not one twice. `leasing` and `renewals` render likelihood badges / market-rent columns added in Phase 3; those consume shared primitives, so a defect there is a PR-B primitive follow-up, not a module edit. Same amber-recedes-against-near-black caution as Task 6.

---

### Task 8: Capital/Market-group Class-D visual-confirmation batch (no code expected)

**Modules:** debt, cash, close (Monthly Close), insurance, taxes, documents, health (System Health). (`capital` = Task 2; `market` = Task 4.)

**Files:** none expected. **These include the four "newest, most feared" builds — Taxes, Insurance, Command Brain (in Task 6), Debt Scorecard — each confirmed semantic-only during authoring.** They get the closest eye in Step 2 precisely because they were most likely hand-tuned against navy/gold, even though their code is clean.

- [ ] **Step 1: Confirm still-clean**

Run: `grep -rnE "#[0-9a-fA-F]{3,8}\b|rgb\(|hsl\(|var\(--(gold|navy|color-emerald|success-|error-)" src/modules/{debt,cash,close,insurance,taxes,documents,health}/`. Expected: zero. Remediate + note any surprise hit.

- [ ] **Step 2: `?still=1` × 3-theme screenshot pass** for all seven modules, with extra scrutiny on Debt Scorecard, Insurance, and Taxes (the newest eye-tuned builds). Same acceptance as Task 6 Step 2. Attach to PR. **Stop the dev server when done.**

- [ ] **Step 3: No commit unless a leftover was found.**

**Failure-proofing:** The Debt Scorecard, Insurance, and Taxes views were the modules most at risk of being visually tuned to Oxford Terminal's specific navy/gold contrast relationships even while using tokens correctly (e.g., a status color chosen because it "looked right" against navy). Step 2 must judge whether the *relationships* still read (severity ordering still legible, warn still distinct from neg, accent still the eye-draw) — a passing grep does NOT close this task. Any relationship that reads wrong is a finding: if it's a token-value issue it's a PR-B/PR-A follow-up (record, don't patch); if it's genuinely a module composition issue within PR-C's visual-only scope, escalate for a scoped decision rather than freehand-adjusting.

---

### Task 9: Full verification, docs, status.json, and PR (BLOCKED until PR-B merges)

**Files:** `docs/design-parity-audit-2026-07-06.md` (append section), `CHANGELOG.md`, `architecture/status.json` (this worktree's own entry only).

> **DO NOT execute this task, and do not open the PR, until PR-B (`design/mission-control-consumers`) has actually merged to main** and this branch has been re-created from a `main` containing both PR-A (#186) and merged PR-B (Preconditions). PR-C's contrast pass is only valid against PR-B's hardened `--text-on-accent`.

- [ ] **Step 1: Full local test suite** — `npm run test`. All green, including any tests touched by Tasks 1–4.

- [ ] **Step 2: Full gate** — `npm run gate` (7 steps). All exit 0. If it crashes with a `0xC0000005`/exit-139 access violation and zero `FAIL` markers, that is the documented flaky teardown (`feedback_npm_test_intermittent_access_violation.md`) — rerun once, don't debug. If `warehouse:verify` hits a Windows EPERM on its own tmp-dir cleanup from this worktree, re-run from the main checkout at the same commit to confirm it's the known environment artifact (`oxford-command-center worktree gotchas`), not a real failure.

- [ ] **Step 3: Bundle budget** — `npm run check:bundle`. Exits 0, entry bundle under budget. PR-C adds no dependencies and no components — the number should not move.

- [ ] **Step 4: Contrast/axe pass** — `npm run test:e2e` (Playwright + axe) over the module set. Confirm every text-on-fill pairing this sweep touched (Task 1's tier badges + Grade/OM buttons, Task 2's capital verdict colors, Task 3's admin banner) clears ≥4.5:1 in all three themes. This is the first end-to-end exercise of the module set's contrast after PR-B's `--text-on-accent` fix.

- [ ] **Step 5: Repo-wide leftover gate** — per PR-A's post-merge CI lesson, grep the WHOLE repo (not `src/`-only) to find any stray leftover, but confirm zero remain in the module scope: `grep -rniE "color-gold|color-navy|#c9a96e|#1b2a4a|--gold\b|--navy\b|--color-emerald|--success-|--error-" src/modules/`. Expected: zero.

- [ ] **Step 6: Docs** — append a "Module parity sweep — 2026-07-09" section to `docs/design-parity-audit-2026-07-06.md` (per-module Class A/B/C/D disposition + what was remediated); add a CHANGELOG entry.

- [ ] **Step 7: Update `architecture/status.json`** — set this plan's `mission-control-parity-sweep` entry to `status: "review_needed"`, `review_needed: true`, `blocked_by: null` (PR-B has merged by now), `review_detail` summarizing the sweep (Class-A remediations landed, Class-D confirmed, flagged T1/T2 mapping needing Gabriel's look), `last_updated` = `date -u +%Y-%m-%dT%H:%M:%SZ`. Validate: `node -e "JSON.parse(require('fs').readFileSync('architecture/status.json','utf8'))"`.

- [ ] **Step 8: Push and open the PR** (base `main`)

```bash
git push -u origin design/mission-control-parity-sweep
gh pr create --base main --title "feat(theme): Mission-Control parity sweep — PR-C (per-module token re-QA)" --body "$(cat <<'EOF'
## Summary
- Completes the "re-QA of all modules against the new tokens" line item that PR-A (token layer) and PR-B (shared primitives + Insights) did not cover.
- Remediates real token-bypasses: acquisitions tier badges (navy/gold literals → semantic), capital undefined --gold/--navy/--color-emerald tokens, intel admin --success-*/--error-* remap, and #fff-on-accent → --text-on-accent across acquisitions. Strips dead hex fallbacks in capital/market for the semantic-vars-only rule.
- Visually confirms the 19 Class-D modules that inherit PR-A + PR-B for free (incl. the newest builds — Taxes, Insurance, Command Brain, Debt Scorecard — all verified semantic-only).

## One item needs your look
- The T1/T2 acquisition tier-badge color mapping is a real visual choice with no 1:1 Mission-Control equivalent (spec §5). Recommended: T1 = accent highlight, T2 = quiet neutral — please confirm before merge.

## Dependency
- Built on PR-A (#186) + PR-B (design/mission-control-consumers). Do not merge before PR-B.

## Test plan
- [ ] npm run gate green (7 steps)
- [ ] npm run check:bundle green
- [ ] npm run test:e2e contrast/axe green (≥4.5:1 all touched pairings × 3 themes)
- [ ] ?still=1 screenshots × 3 themes attached for every module
EOF
)"
```

**Failure-proofing:** The dominating risk is executing this task early — the entire plan is invalid against a tree lacking PR-A/PR-B, and the contrast pass would validate against stale token values. The `blocked` status and `blocked_by` in status.json (set at authoring time) are the guard; do not flip them until PR-B is confirmed merged. Second: the repo-wide grep in Step 5 must include `server/briefing/**` in its *search* but the sweep must never *edit* it — a hit there is expected and correct (the PDF brand system), not a leftover to fix. Third: open the PR, do not merge it — merge is Gabriel's, gated on his review of the flagged T1/T2 mapping and the screenshot set (established PR-A/PR-B pattern: agents open, never merge, the Mission-Control PRs).

---

## Self-Review Notes (completed during plan authoring)

**Coverage:** All 25 registry modules are accounted for — `insights` (PR-B, excluded), 4 remediation modules (acquisitions, capital, intel, market → Tasks 1–4), `overview` (re-verify, Task 5), and the 19 Class-D confirmation modules (Tasks 6–8). Every module is either a remediation task, a re-verify task, or a named entry in a confirmation batch.

**Findings provenance:** Every Class-A/B/C finding is a live grep hit with a file:line, not an assumption. Class D is the complement (grep found zero color literals / undefined tokens). `rgb/rgba/hsl`: zero across all modules. No local chart-color overrides. These were read from the pre-PR-A tree (this worktree); the Preconditions section makes the mandatory re-verify against merged PR-A + PR-B explicit, because (a) PR-A's 4-file sweep and PR-B's edits shift line numbers and (b) PR-B's own plan proves task lists drift during planning.

**Scope discipline:** No `theme.css`/primitive/shell/chart edits (PR-A/PR-B territory) — parity defects tracing to those are recorded as follow-ups, never patched into a module. Dead-fallback hygiene is bounded to files already opened for a real fix (spec §5), mirroring PR-B's refusal of zero-benefit churn. No new tokens introduced (AdminOnboardView remaps onto existing `--color-pos/neg` + `-soft`).

**Judgment calls flagged, not decided:** T1/T2 tier-badge mapping (Task 1 / spec §5) and the `--navy`-as-text disambiguation (Task 2 Step 2) are both flagged for observation/Gabriel rather than silently chosen.

**Governance capsule:** Task 9 mirrors PR-B Task 11 — full suite → gate → bundle → axe/contrast → repo-wide grep gate → status.json declaration → push + `gh pr create --base main` — with the added hard block that it may not run until PR-B merges, stated both here and in the Preconditions section, not buried in the task.
