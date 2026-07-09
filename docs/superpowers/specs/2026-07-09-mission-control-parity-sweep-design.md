# Mission-Control Parity Sweep — Design Spec

**Date:** 2026-07-09
**Status:** Planning-only. Pending (a) PR-B (`design/mission-control-consumers`) merging to main and (b) Gabriel's go-ahead. No code is written by this spec or its companion plan.
**Owner:** UX Agent
**Depends on:** `docs/superpowers/specs/2026-07-08-mission-control-retokenization-design.md` (PR-A, merged as #186) and `docs/superpowers/plans/2026-07-09-mission-control-consumers-pr-b.md` (PR-B, in-progress, unmerged as of authoring).

## 1. Background — the gap this closes

When the retokenization direction was ratified (2026-07-08), the explicit cost callout was **"re-QA of all modules against the new tokens"** as a real, distinct line item. Neither delivered PR does that full sweep:

- **PR-A (#186, merged)** swapped only the token *layer*: `src/tokens/theme.css` (colors/fonts/radii/3 themes), the `Theme` type, `ThemeToggle`, and a 4-file brand-leftover sweep (`src/charts/theme.ts:7`, `src/modules/intel/LeaseRunView.tsx:162,189,286`, `src/modules/intel/PropertyIntelView.tsx:259`, `src/modules/overview/widgets.tsx:39`). Because token *names* never changed, landing PR-A re-colored every semantic-var-driven component for free — but only where components actually consume the semantic vars.
- **PR-B (in-progress)** touches only shared primitives (`TierBoard`, `StatusPill`, `KpiStat`, `Badge`, `Sidebar`, `PortfolioFilterBar`+`AppShell`), one module directly (`insights` via `insights.logic.ts` + `InsightsModule.tsx`), and one `theme.css` contrast token (`--text-on-accent`). Many modules inherit PR-B's polish transitively because they render those primitives — but PR-B changes no other module's own code.

**The residue:** every module NOT in PR-A's/PR-B's file lists was originally built and visually tuned under the OLD Oxford Terminal palette (navy/gold, EB Garamond/DM Sans), and has never been checked against Mission Control (teal/near-black, IBM Plex, 3 themes). Two failure modes exist:
1. **Silent inheritance that is actually correct** — modules driven 100% by semantic vars (`--surface-*`, `--text-*`, `--accent`, `--color-*`) already look right; they need a *visual look*, not a code change.
2. **Token-bypass that survives retokenization** — modules that hardcode Oxford-Terminal hex, or reference undefined custom properties whose hardcoded fallback renders an off-palette color, still show old navy/gold or generic Tailwind colors after PR-A/PR-B. These need real remediation.

This spec's companion plan sorts all 25 registry modules into those two buckets from a live-repo grep (§4) and remediates the second.

## 2. What "full parity" means

A module is at Mission-Control parity when **all** of the following hold, in all three themes (`command`, `parchment`, `warm`):

- **No raw color literals.** No `#rrggbb`/`#rgb`, `rgb()`, `rgba()`, or `hsl()` used as a *color value* in the module's source (`src/modules/<id>/**`). Every color resolves through a semantic custom property (`--surface-*`, `--text-*`, `--accent*`, `--color-*`, `--border-*`, `--grid-line`, `--text-on-accent`). This includes dead fallbacks: `var(--color-pos, #22c55e)` still contains a raw hex and must become `var(--color-pos)` unless the referenced token genuinely does not exist (in which case the *token* is wrong, not the fallback). Non-color hex (e.g., a hex in a data string) is exempt.
- **No reference to an undefined custom property.** `var(--gold, …)`, `var(--navy, …)`, `var(--color-emerald, …)`, `var(--success-bg, …)`, `var(--error-fg, …)` etc. resolve to their hardcoded fallback because the token was never defined in `theme.css` — this is a token bypass, not a token use. Every `var(--x)` must reference a token that exists in all three theme blocks.
- **WCAG AA contrast (≥4.5:1 body text).** Every text-on-fill pairing the module renders clears 4.5:1 in all three themes. Text placed on an `--accent`/`--color-*` fill must use `var(--text-on-accent)` (the token PR-B Task 10 hardens for parchment/warm), never a hardcoded `#fff`/`#000` that cannot benefit from that fix.
- **No visual regression vs. baseline.** A `?still=1` screenshot of the module's page in each of the 3 themes shows no unintended layout/spacing/legibility regression against the post-PR-A+PR-B baseline. The only *intended* deltas are the token swap itself and any remediation this sweep applies.
- **Density doctrine intact.** No module presents a long, ungrouped single-column list where the `TierBoard` multi-column density pattern applies (the "no long single-column lists" rule established by PR #185 / `fix-design-parity-p2-p3` finding #3 and `docs/design-parity-audit-2026-07-06.md`). This is a confirmation check, not expected to trigger new work — Overview/Insights were the known offenders and are already fixed.

## 3. Scope

**In scope:**
- A per-module parity pass over all 25 registry modules in `src/shell/modules.tsx` (command · assets · capital · market groups), EXCEPT `insights` (owned by PR-B).
- Real remediation of every token-bypass found in §4's live grep: Oxford-Terminal navy/gold literals, undefined-token fallbacks that render off-palette, and hardcoded `#fff`-on-accent that bypasses `--text-on-accent`.
- Optional in-file hygiene: stripping dead `var(--realtoken, #hex)` fallbacks in modules already being edited for a real fix (zero visual change; satisfies "no raw color literals").
- A `?still=1` × 3-theme screenshot confirmation pass and an axe/contrast pass over the module set.

**Out of scope (do not touch):**
- **Brand direction.** Re-litigating Oxford Terminal vs. Mission Control. That decision is ratified (PR-A). This is visual/token conformance only.
- **Any functional/behavior change.** No data flow, no props, no routing, no analytics, no copy changes. A color-token migration is not a behavior change; anything beyond that is out of scope.
- **Shared primitives** (`src/primitives/**`), the **shell** (`src/shell/**`), `src/charts/**`, and `src/tokens/theme.css` — all owned by PR-A/PR-B. If a parity defect traces to a primitive, it is a PR-B follow-up, not a PR-C module edit (record it, do not fix it in a module).
- **`insights`** module — PR-B's direct scope.
- **`server/briefing/**`** — the second, server-only ORA Style Guide PDF brand system (EB Garamond/DM Sans/IBM Plex Mono via `@react-pdf/renderer`), governed by Gabriel's global institutional-deliverables style guide, never reachable from the client bundle. Explicitly out of every Mission-Control PR (see PR-A spec §2). Any repo-wide grep in this sweep must still grep the WHOLE repo to *find* leftovers, but must not *edit* `server/briefing/**`.
- **The 4 PR-A-swept locations** (`overview/widgets.tsx:39`, `intel/LeaseRunView.tsx:162,189,286`, `intel/PropertyIntelView.tsx:259`). These are re-verified as clean against merged PR-A, not re-fixed.
- Deferred cut-list items (`docs/design-handoff-cut-list-reconciliation.md` C1–C11), as-of period rewind, any module restructuring.

## 4. Live-repo findings (grep of `src/modules/**`, 2026-07-09)

Method: `#[0-9a-fA-F]{3,8}` (tsx + ts), `rgb(|rgba(|hsl(`, and `var(--<undefined-token>` across `src/modules/**`. `rgb/rgba/hsl`: **zero** hits anywhere. No module defines a local chart color array or hardcoded `fill=`/`stroke=` — chart color is centralized in `src/charts/theme.ts` (PR-A-owned), so there is no module-level chart-color risk. Module→directory map: `pipeline`→`acquisitions/`, `intel`→`intel/` (also hosts `prospect-demand` via `ProspectDemandModule.tsx`), `leasing`→`leasing/`, `close`→`close/`, `health`→`health/`; all others match their registry id.

### Class A — real token-bypass, remediation required

| Module (dir) | File:line | Bypass | Renders after PR-A as | Severity |
|---|---|---|---|---|
| pipeline (`acquisitions/`) | `RankedCandidateList.tsx:13-14` | `TIER_STYLES` T1 `bg:'#C9A96E'`/`color:'#1B2A4A'`; T2 `bg:'#1B2A4A'`/`color:'#F5F3EF'` | **Oxford-Terminal navy/gold literals** — T1/T2 acquisition tier badges stay navy/gold | **HIGH** |
| pipeline (`acquisitions/`) | `GraderView.tsx:107` | `color:'#fff'` on `background:var(--accent)` | hardcoded white on teal; cannot benefit from PR-B's `--text-on-accent` AA fix in parchment/warm | MED |
| pipeline (`acquisitions/`) | `OmImportDrawer.tsx:104` | `btnPrimary color:'#fff'` on `var(--accent)` | same as above | MED |
| pipeline (`acquisitions/`) | `RankedCandidateList.tsx:16` | `KILLED color:'#fff'` on `var(--color-neg)` | hardcoded white on red (usually adequate, but not tokenized) | LOW |
| capital (`capital/`) | `CapitalModule.tsx:183-184` | `var(--gold, #C9A96E)`, `var(--navy, #1B2A4A)` | **undefined tokens → always old navy/gold** | **HIGH** |
| capital (`capital/`) | `hooks.ts:48` | `var(--color-emerald, #10b981)` ('buy' verdict color) | **undefined token → always generic emerald**, off Mission-Control palette | MED |
| intel (`intel/`) | `AdminOnboardView.tsx:111-112` | `var(--success-bg,#d1fae5)`, `var(--error-bg,#fee2e2)`, `var(--success-fg,#065f46)`, `var(--error-fg,#991b1b)` | **four undefined tokens → generic Tailwind mint/pink**, off palette (low-traffic admin view) | MED |

### Class B — dead fallback on a REAL token (hygiene only; renders correct color today)

These reference tokens that DO exist post-PR-A (`--color-pos/warn/neg/info`), so they render correctly; the hardcoded fallback is dead code that still violates "no raw color literals." Strip the fallback in-file when already editing the module; do not open a module edit solely for these.

- market (`market/`): `MarketScorecard.tsx:18,52` — `var(--color-pos, #22c55e)`, `var(--color-warn, #f59e0b)`, `var(--color-neg, #ef4444)`.
- capital (`capital/`): `AllocationCard.tsx:22,66,73`; `HurdleRateBanner.tsx:16,17`; `CapitalModule.tsx:354`; `hooks.ts:50,51,52` (note `hooks.ts:52`'s `--color-info` token is real but its `#6366f1` fallback is a *mismatched* indigo — still dead, still strip).

### Class C — PR-A-swept, re-verify only (do NOT re-fix)

- `overview/widgets.tsx:39` (`--color-gold-400` → PR-A Task 9 → `var(--accent)`).
- `intel/LeaseRunView.tsx:162,189,286` (PR-A Task 9 fixed 162/189 explicitly; line 286 was in PR-A spec §4's file list and PR-A's final `grep -rniE "color-gold|color-navy|navy-|gold-" src/` acceptance gate would have failed if 286 survived — so merged main should be clean at all three lines; re-verify).

### Class D — 100% semantic-var-driven, visual confirmation only (free inheritance)

No raw hex, no undefined-token references. These already inherit PR-A's palette and PR-B's primitive polish for free; they need a `?still=1` × 3-theme look, not a code change.

- **Command group:** principal, tasks, alerts, calendar, renewals, command-brain.
- **Assets group:** portfolio, calibration, leases, leasing, tenants, prospect-demand.
- **Capital group:** debt, cash, close, insurance, taxes.
- **Market group:** documents, health.

The task's named "newest builds most likely to have been eye-tuned under Oxford Terminal" — **Taxes, Insurance, Command Brain, Debt Scorecard** — were each confirmed to reference ONLY semantic tokens (`var(--accent`, `var(--color-pos/neg/warn/info`, `var(--text-*`, `var(--surface-*`, `var(--border-subtle`). They are in Class D. This is the sweep's most important reassurance: the modules most feared to be hand-tuned to navy/gold are in fact fully tokenized and inherit correctly. They still get a visual confirmation (eye-tuning can be correct in code yet still read wrong under teal — e.g., a `--color-warn` amber that popped against navy may recede against near-black), but no code change is anticipated.

**`KpiStripWidget` is NOT a shared cross-module widget.** It lives only in `src/modules/overview/widgets.tsx` and is registered only in the Overview widget registry. PR-B Task 5's drill-down wiring therefore benefits only Overview. Cross-module "free inheritance" comes entirely from the shared *primitives* (`KpiStat`, `Badge`, `TierBoard`, `StatusPill`, `Card`, `Sidebar`), not from `KpiStripWidget`.

## 5. Open judgment calls (flagged, not silently decided)

- **T1/T2 acquisition tier-badge mapping** (`RankedCandidateList.tsx:13-14`). Under Oxford Terminal, T1·PURSUE was gold-on-navy (a highlight) and T2·WATCH was navy-on-cream. There is no 1:1 Mission-Control equivalent. Recommended mapping: T1 → `bg:var(--accent)` + `color:var(--text-on-accent)` (keeps "PURSUE" as the accent highlight); T2 → `bg:var(--surface-overlay)` + `color:var(--text-secondary)` (a quieter neutral, distinct from PASS's tertiary text). This is a real visual choice — flag it for Gabriel; do not treat the recommended mapping as ratified.
- **`AdminOnboardView` success/error styling** (`AdminOnboardView.tsx:111-112`). The four `--success-*/--error-*` tokens don't exist. Rather than introduce four new tokens (a `theme.css` change = PR-A/PR-B territory, out of PR-C scope), remap onto the existing semantic system: success → `var(--color-pos)` fg + `var(--color-pos-soft)` bg; error → `var(--color-neg)` fg + `var(--color-neg-soft)` bg (both `*-soft` tokens exist in all three theme blocks per PR-A §3.4). Flag that this is a remap, not a new token.
- **Dead-fallback hygiene breadth.** Recommended: strip dead fallbacks only in modules already opened for a real fix (capital, market), matching PR-B's discipline of refusing zero-visual-benefit churn (cf. PR-B leaving the 18-file `'gold'` `BadgeTone` alone). A repo-wide "strip every fallback" pass is explicitly NOT recommended.

## 6. Verification

- `npm run gate` (7 steps) + `npm run check:bundle` green (PR-C adds no dependencies and no new components; bundle should not move).
- `npm run test:e2e` (Playwright + axe) over the module set, with an explicit contrast re-check on every text-on-fill pairing this sweep touches, ≥4.5:1 in all three themes. This is the first pass to exercise the module set's contrast end-to-end after PR-B's `--text-on-accent` fix lands.
- `?still=1` screenshot pass across every module page × 3 themes, attached to the PR. Class D modules: confirm no regression. Class A modules: confirm the remediated colors read correctly.
- Repo-wide (NOT `src/`-scoped) grep gate, per PR-A's own post-merge lesson (the `server/briefing` CI break): `grep -rniE "color-gold|color-navy|#c9a96e|#1b2a4a|--gold|--navy|--color-emerald|--success-|--error-" src/modules/` returns zero after remediation.
- Docs: append a "Module parity sweep — 2026-07-09" section to `docs/design-parity-audit-2026-07-06.md`; CHANGELOG entry — on this PR.

## 7. Rollback

Every change is a color-token substitution inside a module; no token names, schema, or data change. Rollback is a plain `git revert` of the PR with no migration. Reverting restores the pre-sweep module colors (old navy/gold literals return) while leaving PR-A/PR-B intact.

## 8. Execution & dependency

PR-C executes only after PR-B has merged to main (so its contrast pass runs against the real, hardened `--text-on-accent` values, not assumptions), and only on Gabriel's go-ahead. Because PR-B changed its own task list once during planning (its plan §Global Constraints documents the FilterPill correction — the fix applied only to `InsightsModule.tsx`, not `OverviewModule.tsx` as its spec had assumed), every file-level assumption in the companion plan must be re-verified against the ACTUAL merged PR-A + PR-B diffs before any edit. See the plan's Preconditions section. Implementation is dispatched to Opus subagents via subagent-driven-development, per the Mission-Control initiative's established pattern; each module remediation gets independent local review before landing.
