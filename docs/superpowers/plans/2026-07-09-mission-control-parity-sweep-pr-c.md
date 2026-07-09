# Mission-Control Parity Sweep (PR-C) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring every remaining `oxford-command-center` module to Mission-Control visual parity — the "re-QA of all modules against the new tokens" line item that PR-A (token layer) and PR-B (shared primitives + Insights) did not cover. Remediate the token-bypasses found by live grep (§Ground-truth findings) and visually confirm the modules that inherit correctly. Visual/token only — no functional or behavioral change.

**Architecture:** Work lands only on `src/modules/**` (four module directories carry real edits: `acquisitions/`, `capital/`, `intel/`, `market/`; the rest are confirmation-only). No architect-owned files are touched — verified against `.claude/hooks/architect-owned.json`, whose globs are `CLAUDE.md`, `architecture/**`, `package.json`, `tsconfig*.json`, `vite.config.ts`, `server/index.ts`, `src/contracts/**`, `src/analytics/engine.ts`, `scripts/governance-check.ts`, `server/warehouse/{db,migrate}.ts`, `server/warehouse/migrations/**`; none match `src/modules/**`. The one `architecture/**` touch is this plan's own `status.json` claim entry, which is the sanctioned worktree-declaration exception every agent uses (PR-A/PR-B both did it).

**Tech Stack:** React 19, Tailwind v4 CSS-first tokens, `react-aria-components`, `framer-motion`, vitest + @testing-library/react, Playwright + axe.

---

## Preconditions — READ BEFORE ANY EXECUTION

**Status as of 2026-07-09 adversarial review:** this plan was authored twice — a first pass from a stale pre-PR-A worktree, then corrected after the worktree was rebased onto real `origin/main` (`c373c69`, carries PR-A #186) and an independent Opus review re-verified every finding against the live merged tree. Precondition 1 below is now **satisfied**. Preconditions 2-5 remain **live and unresolved** — PR-B has still not merged as of this writing.

1. ~~This worktree predates PR-A~~ **SATISFIED.** `src/tokens/theme.css` on this branch reads `ORA MISSION CONTROL` (merge-base with `origin/main` is `c373c69`). The re-verification this enabled already found and fixed two stale HIGH-severity findings from the first draft — see the correction notes in spec §4 Class A/C and §5. **This does not mean the plan is execution-ready** — PR-B (precondition 4 below) still hasn't merged, and this worktree still predates it.
2. **Re-verify every file-level assumption (paths AND line numbers) against the ACTUAL merged PR-A + PR-B diffs before editing, EVEN THOUGH precondition 1 is now satisfied.** The 2026-07-09 review already caught line-number and severity drift from PR-A alone; PR-B will shift more (its own plan's task list changed once during its authoring — the FilterPill fix ended up applying only to `InsightsModule.tsx`, not `OverviewModule.tsx` as its spec assumed). Treat every line number in this plan as "approximately here — re-grep to confirm," not "edit this line." Re-run the Class A/B/C/D classification greps (§Ground-truth findings) fresh before trusting the task list below — do not assume the 2026-07-09 correction is the final word.
3. **Before executing ANY task, re-create (or rebase) this worktree from a `main` that contains BOTH PR-A (#186, done) AND merged PR-B** (`design/mission-control-consumers`, not yet merged as of authoring). Executing against a tree with PR-A but not PR-B means the contrast pass runs against the *unhardened* `--text-on-accent` — false-negative risk on exactly the pairings PR-B's Task 10 exists to fix.
4. **Do not open the PR until PR-B has actually merged to main.** This plan assumes PR-B's changes (shared-primitive polish + the `--text-on-accent` AA fix) as a baseline; PR-C's contrast pass is only valid against the hardened `--text-on-accent`. See Task 9.
5. **Shared write surfaces with PR-B, both non-conflicting by sequencing, not by accident:** `architecture/status.json` (PR-B adds its own `mission-control-consumers` entry; PR-C adds a sibling `mission-control-parity-sweep` entry — different keys, no overwrite) and `CHANGELOG.md` (both append a section). Because PR-C only executes after rebasing onto a main that already contains PR-B's merged edits to both files, PR-C's edits land as append-after-PR-B, never a two-writer collision. Do not skip the rebase in precondition 3 and assume this holds anyway.
6. Confirm with Gabriel that the Mission-Control direction still holds and that PR-B merged as expected before starting (same-day-volatility caution inherited from PR-A spec §1).

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
- **Class A (real bypass, remediate):** `acquisitions/GraderView.tsx:107`, `acquisitions/OmImportDrawer.tsx:104`, `capital/hooks.ts:48`, `intel/AdminOnboardView.tsx:111-112`. **(Corrected 2026-07-09: `acquisitions/RankedCandidateList.tsx:13-14,16` and `capital/CapitalModule.tsx:183-184` were removed from this list — adversarial review found both already fully tokenized on merged main; see Class C.)**
- **Class B (dead fallback on a real token, hygiene):** `market/MarketScorecard.tsx:18,52`, `capital/AllocationCard.tsx:22,66,73`, `capital/HurdleRateBanner.tsx:16,17`, `capital/CapitalModule.tsx:354`, `capital/hooks.ts:50,51,52`.
- **Class C (PR-A-swept, re-verify only, do NOT re-fix):** `overview/widgets.tsx:39`, `intel/LeaseRunView.tsx:162,189,286`, `acquisitions/RankedCandidateList.tsx` (entire `TIER_STYLES` map — added 2026-07-09), `capital/CapitalModule.tsx:183-184` (added 2026-07-09).
- **Class D (100% semantic, visual-confirmation only):** everything else — principal, tasks, alerts, calendar, renewals, command-brain, portfolio, calibration, leases, leasing, tenants, prospect-demand, debt, cash, close, insurance, taxes, documents, health. The feared "newest, eye-tuned-under-Oxford-Terminal" modules (Taxes, Insurance, Command Brain, Debt Scorecard) were each confirmed to use ONLY semantic tokens — they are Class D.

---

### Task 1: `acquisitions/` (pipeline / Acquisitions) — retire `#fff`-on-accent; re-verify tier badges (do NOT re-edit)

**Files:**
- Modify: `src/modules/acquisitions/GraderView.tsx`
- Modify: `src/modules/acquisitions/OmImportDrawer.tsx`
- Verify only (no edit expected): `src/modules/acquisitions/RankedCandidateList.tsx`

**Interfaces:** No signature change anywhere — every edit is a color-value substitution.

**CORRECTED 2026-07-09 (adversarial review):** the original version of this task also rewrote `RankedCandidateList.tsx`'s `TIER_STYLES` map, on the premise that T1/T2 were hardcoded `#C9A96E`/`#1B2A4A` navy/gold literals. **That premise is false on merged main** — direct read of `main` at `77b9ec3` (PR-A) shows the map already fully tokenized: `T1 bg:var(--accent)/color:var(--text-on-accent)`, `T2 bg:var(--color-info)/color:var(--text-on-accent)`, `PASS bg:var(--surface-overlay)/color:var(--text-tertiary)`, `KILLED bg:var(--color-neg)/color:var(--text-on-accent)`. **Do not edit this file.** The T1/T2 color mapping this task previously flagged as an open judgment call for Gabriel is already shipped and is not open (spec §5) — re-litigating it here would be a regression (the originally-recommended T2 value would have made T2 visually indistinguishable from PASS).

**Context (re-grep to confirm before editing):** `GraderView.tsx:≈107` sets `color:'#fff'` on a `background:var(--accent)` button. `OmImportDrawer.tsx:≈104` sets `btnPrimary.color:'#fff'` on `background:var(--accent)`. Both are real, live-verified bypasses (MED severity — not the "single largest defect" this task previously claimed; that framing relied on the now-removed RankedCandidateList finding).

- [ ] **Step 1: Re-grep to confirm the exact current lines, and confirm RankedCandidateList is still clean**

Run: `grep -nE "'#fff'|\"#fff\"" src/modules/acquisitions/*.tsx`. Confirm the two literals below still exist in `GraderView.tsx`/`OmImportDrawer.tsx` (line numbers may differ post-PR-B). Also run `grep -nE "#C9A96E|#1B2A4A|#F5F3EF" src/modules/acquisitions/RankedCandidateList.tsx` — expected zero; if this ever shows a hit (e.g., someone reverted the token fix since this plan was written), that's a real regression to fix here after all, and note it explicitly in the PR body as a reopened finding.

- [ ] **Step 2: `GraderView.tsx` and `OmImportDrawer.tsx` — `#fff` → `var(--text-on-accent)`**

Both are white text on a `var(--accent)` fill; both must use `var(--text-on-accent)` so PR-B Task 10's parchment/warm AA fix reaches them.

- [ ] **Step 3: Verify**

Run: `grep -rln "GraderView\|OmImportDrawer" tests/unit/` and run any matching tests (they assert behavior/labels, not colors, so should pass unchanged). Run `npx tsc --noEmit`. Then `npm run dev`, open Acquisitions, view the Grade + OM-import primary buttons in all three themes, AND separately view a T1/T2/PASS/KILLED badge as a **read-only confirmation** (no edit) — confirm T1 reads as the accent highlight, T2 (info-blue) is visually distinct from PASS (neutral), and KILLED is legible on `--color-neg` in parchment/warm specifically (this is the KILLED-badge contrast spot-check from spec §6 — measure it, don't eyeball it, if you have axe/contrast tooling available in this pass; otherwise flag for Task 9's pass). **Stop the dev server when done.**

- [ ] **Step 4: Commit**

```bash
git add src/modules/acquisitions/GraderView.tsx src/modules/acquisitions/OmImportDrawer.tsx
git commit -m "fix(acquisitions): #fff-on-accent → var(--text-on-accent) in GraderView/OmImportDrawer (Mission-Control parity)"
```

**Failure-proofing:** The dominant risk in the ORIGINAL version of this task was executing a fabricated finding (rewriting already-correct code) — Step 1 now explicitly re-verifies RankedCandidateList is clean rather than assuming either "it needs fixing" or "it's fine," so a genuine regression since authoring is still caught. Second: confirm `--text-on-accent` actually exists and is AA-correct in merged main BEFORE relying on it (it is PR-B Task 10's deliverable) — if PR-B did not merge that fix, this task's `#fff` substitutions inherit the same latent contrast gap and Task 9's axe pass will catch it; do not proceed to open the PR in that state. Third: do not use this task as an opportunity to "improve" the T1/T2/KILLED colors — that ship has sailed (spec §5); a genuine measured AA failure on KILLED goes to Task 9 as a PR-A/PR-B token-layer follow-up, not a freehand fix here.

---

### Task 2: `capital/` — undefined `--color-emerald` + dead-fallback hygiene (NOT `--gold`/`--navy` — already fixed)

**Files:**
- Modify: `src/modules/capital/hooks.ts`
- Modify: `src/modules/capital/AllocationCard.tsx`
- Modify: `src/modules/capital/HurdleRateBanner.tsx`
- Modify: `src/modules/capital/CapitalModule.tsx` (line 354 dead-fallback strip ONLY — see correction below)

**Interfaces:** No signature change — color-value substitutions only.

**CORRECTED 2026-07-09 (adversarial review):** the original version of this task's Step 2 rewrote `CapitalModule.tsx:183-184`, on the premise it used `var(--gold, #C9A96E)`/`var(--navy, #1B2A4A)`. **False on merged main** — direct read of `main` at `77b9ec3` (PR-A) shows this control already uses `border:1px solid var(--accent)` and `color: disabled ? 'var(--text-tertiary)' : 'var(--text-primary)'`. **Do not edit lines 183-184.** `CapitalModule.tsx` stays in this task's file list ONLY for the unrelated, still-real `line 354` dead-fallback strip (Class B).

**Context (re-grep for exact lines):** One real bypass via an undefined token remains: `hooks.ts:≈48` uses `var(--color-emerald, #10b981)` for the 'buy' verdict color (`--color-emerald` never existed → always generic emerald). The rest are dead fallbacks on REAL tokens (render correctly today; strip the fallback for the semantic-vars-only rule): `AllocationCard.tsx:22,66,73`, `HurdleRateBanner.tsx:16,17`, `CapitalModule.tsx:354`, `hooks.ts:50,51,52`.

- [ ] **Step 1: Re-grep, and confirm `CapitalModule.tsx:183-184` is still clean**

Run: `grep -nE "var\(--(gold|navy|color-emerald)|, ?#[0-9a-fA-F]{3,8}\)" src/modules/capital/*.ts src/modules/capital/*.tsx`. Confirm `hooks.ts:48`'s real bypass and enumerate every dead fallback still present. Also confirm zero `--gold`/`--navy` hits anywhere in `capital/` — if one appears (regression since authoring), treat it as a reopened Class-A finding and fix it here, noting it explicitly in the PR body.

- [ ] **Step 2: `hooks.ts` — fix `--color-emerald`, strip dead fallbacks**

`case 'buy': return 'var(--color-emerald, #10b981)'` → `return 'var(--color-pos)'` ('buy' is the positive verdict; `--color-pos` is the theme's positive-green in all three themes, replacing the off-palette generic emerald). Strip the dead fallbacks on lines 50/51/52 (`var(--color-neg, #ef4444)` → `var(--color-neg)`, `var(--color-warn, #f59e0b)` → `var(--color-warn)`, `var(--color-info, #6366f1)` → `var(--color-info)`).

- [ ] **Step 3: `AllocationCard.tsx`, `HurdleRateBanner.tsx`, `CapitalModule.tsx:354` — strip dead fallbacks**

Every `var(--color-pos, #22c55e)` / `var(--color-warn, #f59e0b)` / `var(--color-neg, #ef4444)` → drop the `, #hex` fallback. Zero visual change (the real token already wins); this satisfies "no raw color literals." Do not touch `CapitalModule.tsx:183-184`.

- [ ] **Step 4: Verify**

Run: `grep -rln "CapitalModule\|AllocationCard\|HurdleRate\|capital/hooks" tests/unit/` and run matching tests. Run `npx tsc --noEmit`. Then `npm run dev`, open Capital, view a buy/sell/refinance/improve verdict color, the hurdle banner, and an allocation card's health bar, in all three themes. Confirm the 'buy' verdict is now theme-green (not generic emerald). **Stop the dev server when done.**

- [ ] **Step 5: Commit**

```bash
git add src/modules/capital/hooks.ts src/modules/capital/AllocationCard.tsx src/modules/capital/HurdleRateBanner.tsx src/modules/capital/CapitalModule.tsx
git commit -m "fix(capital): undefined --color-emerald token → var(--color-pos); strip dead hex fallbacks"
```

**Failure-proofing:** The dominant risk in the ORIGINAL version of this task was editing already-correct code at `CapitalModule.tsx:183-184` — Step 1 now re-verifies that spot is still clean rather than assuming it needs a fix. For the dead-fallback strips (Step 3), confirm each referenced token actually exists in all three theme blocks first (`grep -n '<token>' src/tokens/theme.css` on merged main) — a "dead fallback on a real token" is only safe to strip if the token is genuinely real; if a token turns out undefined, it belongs in Step 2's real-bypass bucket, not the hygiene bucket. Do not let the hygiene strips balloon into a repo-wide fallback purge (spec §5: hygiene only in files already opened for a real fix).

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

- [ ] **Step 4: Contrast/axe pass — CORRECTED 2026-07-09 (adversarial review found the original claim overstated)**

The original version of this step claimed `npm run test:e2e` already runs axe "over the module set" in all three themes. **False as of authoring:** `tests/e2e/a11y.spec.ts` is 6 tests with exactly one axe assertion, on `/?still=1` in the default `command` theme only — it never visits acquisitions/capital/intel/market and never switches `data-theme` to parchment/warm, so it never reaches any pairing this sweep or PR-B's Task 10 actually touches. Do the following instead:

  4a. **Extend `tests/e2e/a11y.spec.ts`** with a parameterized loop: for each of `{command, parchment, warm}` × the routes touched by Tasks 1-4 (acquisitions/pipeline, capital, intel — the modules with real Class-A edits), set `data-theme` before `page.goto`/before `analyze()`, and assert `color-contrast` has zero `serious`/`critical` violations. This is new test surface, not present before this plan — write it TDD (watch it fail against a deliberately-reverted change first, per the repo's TDD convention, if practical; at minimum confirm it actually exercises the three themes by temporarily breaking one on purpose and watching it fail, then restoring).

  4b. Run the extended suite. Confirm every text-on-fill pairing Task 1/2/3 touched (Grade/OM buttons' `--text-on-accent` on `--accent`; the capital verdict colors; the intel admin banner's `-soft` backgrounds) clears ≥4.5:1 in all three themes.

  4c. **Separately, manually verify the KILLED-badge spot-check flagged in spec §6** (`--text-on-accent` on `--color-neg` in parchment/warm) — include it in the 4a loop if the badge is reachable from a route already in scope, otherwise a manual axe/contrast-checker measurement is acceptable, but record the actual measured ratio in the PR body, not an assumption.

  4d. If 4a is judged too large to land in this PR (a real possibility — it's new test infrastructure, not a color fix), it is acceptable to defer 4a/4b as a named follow-up **only if** Step 4c's manual check and the `?still=1` screenshot passes (Tasks 1-8) are still done and attached — do not open the PR claiming automated contrast coverage that doesn't exist.

- [ ] **Step 5: Repo-wide leftover gate** — per PR-A's post-merge CI lesson, grep the WHOLE repo (not `src/`-only) to find any stray leftover, but confirm zero remain in the module scope: `grep -rniE "color-gold|color-navy|#c9a96e|#1b2a4a|--gold\b|--navy\b|--color-emerald|--success-|--error-" src/modules/`. Expected: zero.

- [ ] **Step 6: Docs** — append a "Module parity sweep — 2026-07-09" section to `docs/design-parity-audit-2026-07-06.md` (per-module Class A/B/C/D disposition + what was remediated); add a CHANGELOG entry.

- [ ] **Step 7: Update `architecture/status.json`** — set this plan's `mission-control-parity-sweep` entry to `status: "review_needed"`, `review_needed: true`, `blocked_by: null` (PR-B has merged by now), `review_detail` summarizing the sweep (Class-A remediations landed, Class-D confirmed, flagged T1/T2 mapping needing Gabriel's look), `last_updated` = `date -u +%Y-%m-%dT%H:%M:%SZ`. Validate: `node -e "JSON.parse(require('fs').readFileSync('architecture/status.json','utf8'))"`.

- [ ] **Step 8: Push and open the PR** (base `main`)

```bash
git push -u origin design/mission-control-parity-sweep
gh pr create --base main --title "feat(theme): Mission-Control parity sweep — PR-C (per-module token re-QA)" --body "$(cat <<'EOF'
## Summary
- Completes the "re-QA of all modules against the new tokens" line item that PR-A (token layer) and PR-B (shared primitives + Insights) did not cover.
- Remediates real token-bypasses: #fff-on-accent → --text-on-accent in acquisitions' Grade/OM-import buttons, capital's undefined --color-emerald token, intel admin --success-*/--error-* remap. Strips dead hex fallbacks in capital/market for the semantic-vars-only rule.
- Visually confirms the 19 Class-D modules that inherit PR-A + PR-B for free (incl. the newest builds — Taxes, Insurance, Command Brain, Debt Scorecard — all verified semantic-only).
- Extends `tests/e2e/a11y.spec.ts` with real multi-theme contrast coverage over the touched routes (previously: one axe check, one theme, one route — see Task 9 Step 4).

## Corrections made during planning (verified against the live repo, not assumed)
- This plan's first draft was authored from a worktree that predated PR-A's merge and credited PR-A with a smaller diff than it actually shipped. Adversarial review (2026-07-09) found two of the original four "remediation" findings — the acquisitions tier-badge map (`RankedCandidateList.tsx`) and capital's `--gold`/`--navy` (`CapitalModule.tsx:183-184`) — were **already fixed by PR-A**. Both were removed from scope; see spec §4 for the corrected findings table. The T1/T2 tier-badge color mapping this PR previously planned to flag as an open decision for you is **already shipped and is not a question** — do not re-litigate it.
- The original claim that `npm run test:e2e` already covers contrast across the touched modules × 3 themes was false (the existing suite covers one route, one theme, one axe check) — this PR adds the real coverage rather than relying on a check that didn't exist.

## Dependency
- Built on PR-A (#186) + PR-B (design/mission-control-consumers). Do not merge before PR-B.

## Test plan
- [ ] npm run gate green (7 steps)
- [ ] npm run check:bundle green
- [ ] npm run test:e2e contrast/axe green, including the new multi-theme coverage added by this PR (≥4.5:1 all touched pairings × 3 themes)
- [ ] ?still=1 screenshots × 3 themes attached for every module
- [ ] KILLED-badge (--color-neg + --text-on-accent) contrast in parchment/warm measured and recorded — flag as a PR-A/PR-B follow-up if under 4.5:1, do not fix here
EOF
)"
```

**Failure-proofing:** The dominating risk is executing this task early — the entire plan is invalid against a tree lacking PR-A/PR-B, and the contrast pass would validate against stale token values. The `blocked` status and `blocked_by` in status.json (set at authoring time) are the guard; do not flip them until PR-B is confirmed merged. Second: the repo-wide grep in Step 5 must include `server/briefing/**` in its *search* but the sweep must never *edit* it — a hit there is expected and correct (the PDF brand system), not a leftover to fix. Third: open the PR, do not merge it — merge is Gabriel's, gated on his review of the flagged T1/T2 mapping and the screenshot set (established PR-A/PR-B pattern: agents open, never merge, the Mission-Control PRs).

---

## Self-Review Notes (completed during plan authoring)

**Coverage:** All 25 registry modules are accounted for — `insights` (PR-B, excluded), 4 remediation modules (acquisitions, capital, intel, market → Tasks 1–4), `overview` (re-verify, Task 5), and the 19 Class-D confirmation modules (Tasks 6–8). Every module is either a remediation task, a re-verify task, or a named entry in a confirmation batch.

**Findings provenance:** Every Class-A/B/C finding is a live grep hit with a file:line, not an assumption — **twice-verified**: once from the pre-PR-A worktree (first draft), once by an independent adversarial review after the worktree was rebased onto real `origin/main` (PR-A present). The second pass is what caught the two stale HIGH-severity findings (§Ground-truth findings, corrected). Class D is the complement (grep found zero color literals / undefined tokens across the FULL module tree in both passes, not a sample). `rgb/rgba/hsl`: zero across all modules. No local chart-color overrides. The Preconditions section still makes a THIRD re-verify (against merged PR-B, not yet available at either authoring pass) mandatory before execution — two rounds of correction is evidence this class of drift is real and recurring, not a one-time fluke.

**Scope discipline:** No `theme.css`/primitive/shell/chart edits (PR-A/PR-B territory) — parity defects tracing to those are recorded as follow-ups, never patched into a module. Dead-fallback hygiene is bounded to files already opened for a real fix (spec §5), mirroring PR-B's refusal of zero-benefit churn. No new tokens introduced (AdminOnboardView remaps onto existing `--color-pos/neg` + `-soft`).

**Judgment calls — one resolved-not-open correction, one still genuinely open:** the T1/T2 tier-badge mapping (Task 1 / spec §5) was flagged as an open Gabriel decision in the first draft; adversarial review found it is **already shipped** (merged main uses `--color-info` for T2) and is not open — do not re-present it as a decision. The `--navy`-as-text disambiguation this task also flagged is now moot (Task 2 no longer touches that line at all — see Task 2's correction note). **No open judgment calls remain in this plan as of the 2026-07-09 correction**, other than the standard "flag if it looks wrong during the visual pass" instruction repeated in every Class-D task.

**Governance capsule:** Task 9 mirrors PR-B Task 11 — full suite → gate → bundle → axe/contrast (now including new multi-theme test coverage, not just an existing check — see Task 9 Step 4's correction) → repo-wide grep gate → status.json declaration → push + `gh pr create --base main` — with the added hard block that it may not run until PR-B merges, stated both here and in the Preconditions section, not buried in the task.

**Adversarial review record (2026-07-09):** a fresh Opus agent, independent of the author, re-verified every file/line/token claim against the live repo, checked all 25 modules for governance/collision/completeness gaps, and found: 2 blocking fabrications (corrected above — both Class-A→Class-C reclassifications), 1 should-fix overstated test-coverage claim (corrected — Task 9 Step 4), 1 should-fix stale-precondition-text issue (corrected — Preconditions §1), 1 nice-to-have (KILLED-badge spot-check, added to Task 1/spec §6), 1 nice-to-have (shared-write-surface note, added to Preconditions §5). Zero issues found in: governance-gate correctness, module-registry completeness (25/25), Class-D classification (independently re-verified via fresh full-tree grep, not sampled), and PR-B collision risk. This record exists so a future reader can see the plan was adversarially checked, not just self-reviewed by its own author.
