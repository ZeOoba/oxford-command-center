# Mission-Control Retokenization — Design Spec

**Date:** 2026-07-08
**Status:** Approved by Gabriel in-session (2026-07-08)
**Owner:** UX Agent
**Supersedes:** the "declined" framing of findings #1/#4–#7 in `architecture/status.json`'s `fix-design-parity-p2-p3` entry. That entry's findings #2/#3 (PR #185, merged) are unaffected and not reopened.

## 1. Background and decision history

The 2026-07-08 Design System Review recommended retokenizing `oxford-command-center` from its current "Oxford Terminal" look (navy/gold, EB Garamond + DM Sans, themes `command`/`parchment`) to the ORA design handoff's "Mission Control" system (teal accent, IBM Plex Sans/Bricolage Grotesque/Public Sans, themes matching `design_handoff_ora_command_center/app/ora.css`, plus a new third `warm` theme).

That review was independently fact-checked against the live repo the same day. The fact-check confirmed the review's structural diagnoses (`InsightsWidget` flat-list, `TierBoard` missing 1-column support — both fixed via PR #185, out of scope here) but found the review's palette/token-value claims contained real transcription errors against its own cited source. Those errors are corrected in this spec (§3).

D1(c) (keep vs. retokenize) flipped twice today, on top of a pre-existing baseline:
0. Baseline — Oxford Terminal originally ratified as the hybrid decision in `IMPLEMENTATION_PLAN.md` §3.
1. Declined (reaffirmed) — Gabriel reaffirmed Oxford Terminal in-session, recorded in `fix-design-parity-p2-p3`.
2. Reversed — Gabriel asked this session to plan the retokenization for real, superseding (1).

This spec proceeds on decision (2) as current. Given same-day volatility, a session picking this back up after any real time gap should confirm with Gabriel that (2) still holds before writing code.

## 2. Scope

**In scope:**
- **[PR-A]** Full token-layer swap: colors, fonts, radii, three themes (`command`, `parchment`, `warm`) — findings #1/#4 of the original review.
- **[PR-B]** Component-level consumers of the new tokens: severity glow language, category color-coding, `KpiStat` anatomy + drill-down navigation, `PortfolioFilterBar` affordances — findings #5/#6.
- **[PR-B]** Signature details: filter pills, sidebar active-state, badge shape, chart series — finding #7.
- **[PR-A + PR-B]** Full verification pass (gate, Playwright + axe, contrast, screenshot diff) and doc/changelog updates — each PR verifies its own scope; see §6.

**Out of scope (already done):** PR #185's structural fixes (`InsightsWidget` tier-board reshape, `TierBoard` 1-column support).

**Out of scope (deferred, per the original review and the repo's own cut-list):** as-of period rewind control on the filter bar, any `docs/design-handoff-cut-list-reconciliation.md` C1–C11 item, any module restructuring beyond the components named in §4.

## 3. Corrected inputs (fact-check findings)

The original review's Phase 1 token-value table was checked line-by-line against `design_handoff_ora_command_center/app/ora.css`. Four corrections apply (the fourth found during formal review of this spec, not the original fact-check):

1. **Radius scale.** ora.css defines only three radius values at its root: `--r-sm:7px; --r:11px; --r-lg:12px` (plus `--r-pill:6px`, a distinct pill-shaped-corner token, not a general scale step). The original review's claimed `--radius-xs:5px` has no source anywhere in ora.css, and its claimed `--radius-xl:18px` is not a root-theme value at all — it's ora.css's *warm-theme* `--r-lg` value, misattributed to the default theme. Resolution: `sm`/`md`/`lg` are copied exactly (7/11/12 default, 10/14/18 warm, confirmed real warm-theme values). `xs` and `xl` have no source value in either theme; they are set proportionally to preserve the existing 5-step scale's relative spacing (`xs = sm − 2`, `xl = lg + 6`) — default theme: xs 5px, xl 18px; warm theme: xs 8px, xl 24px. This is a judgment call, not a copied design-system value — Gabriel can override the specific pixels without changing anything else in this spec.

2. **Fonts.** ora.css loads IBM Plex Mono/Sans, Bricolage Grotesque, and Public Sans via a Google Fonts CDN `@import url(...)`. This repo has no codified no-CDN-fonts rule (no CSP `font-src`, no lint check), but it has an unbroken established convention — `src/tokens/theme.css` currently loads 100% of its fonts via Fontsource with zero CDN imports — plus `docs/design-handoff-cut-list-reconciliation.md` (cut-list C7) explicitly rejecting runtime CDN loading as "not a pattern this codebase uses anywhere." Copying ora.css's import line verbatim would break that precedent. Resolution: adopt the same four type families via the equivalent self-hosted Fontsource packages (`@fontsource/ibm-plex-sans` 400/500/600/700, `@fontsource-variable/bricolage-grotesque`, `@fontsource-variable/public-sans` 400–700; keep the existing `@fontsource/ibm-plex-mono`), never the CDN import.

3. **Category taxonomy.** The original review proposed a `categoryTone()` mapping keyed on categories (NOI/lease-economics, acquisition/pipeline, risk/debt/expiry, ops/expense, capital/tax) that do not exist in this codebase. The real taxonomy, verified in `src/modules/insights/insights.logic.ts`'s `CATEGORY_TO_FAMILY`, is: `debt, deal, concentration, lease, occupancy, collections, insurance, cash, anomaly, data`. Resolution: `categoryTone()` is keyed on these ten real values, using `Badge.tsx`'s confirmed real `BadgeTone` union (`neutral | gold | green | amber | red | blue | purple`):

   | category | tone | rationale |
   |---|---|---|
   | debt | red | leverage/covenant risk |
   | deal | blue | pipeline/opportunity, not a risk signal |
   | concentration | amber | portfolio risk, not usually acute |
   | lease | green | core NOI driver, positive-framed |
   | occupancy | green | same framing as lease |
   | collections | amber | cash-flow risk, timely not existential |
   | insurance | blue | matches the one category the original review got right |
   | cash | green | liquidity, positive-framed |
   | anomaly | red | flagged by definition as needing attention |
   | data | neutral | data-quality/system notes, not a business signal |

   `BadgeTone` also has a `'gold'` literal not used by this mapping — its fate (retire vs. remap) is a §4 sweep item, not a categoryTone concern.

4. **Color/theme crosswalk** (found during formal review — the original review gave no color values at all, and one more value turns out fabricated the same way radius xs/xl were). ora.css's three theme blocks bind to this repo's theme names as: `:root` (unnamed, dark) → `command`; `[data-theme="light"]` → `parchment`; `[data-theme="warm"]` → `warm`. Full crosswalk, ora.css source var → repo token name → hex, verified by direct read of `design_handoff_ora_command_center/app/ora.css`:

   | repo token | command (`:root`) | parchment (`light`) | warm |
   |---|---|---|---|
   | `--surface-base` ← `--bg` | `#0c0f14` | `#eef1f6` | `#f3ede1` |
   | `--surface-sunken` ← `--inset` | `#0b1016` | `#eef2f7` | `#f4eee2` |
   | `--surface-raised` ← `--panel` | `#141a22` | `#ffffff` | `#fffdf8` |
   | `--surface-overlay` ← `--panel-2` | `#171f29` | `#f6f8fb` | `#fbf6ec` |
   | `--surface-rail` ← `--bg-2` | `#0f141b` | `#ffffff` | `#f7f1e6` |
   | `--border-subtle` ← `--line` | `#222c38` | `#e1e6ee` | `#e7ddca` |
   | `--grid-line` ← `--line-2` | `#1b2531` | `#eef1f6` | `#efe7d6` |
   | `--text-primary` ← `--ink` | `#e8edf3` | `#121a26` | `#2a2420` |
   | `--text-secondary` ← `--ink-2` | `#aab6c4` | `#475568` | `#5c5247` |
   | `--text-tertiary` ← `--muted` | `#6b7888` | `#8593a6` | `#9b9081` |
   | `--accent` | `#39d3c0` | `#0e9e8e` | `#c2603c` |
   | `--text-on-accent` ← `--accent-ink` | `#06120f` | `#ffffff` | `#fffdf8` |
   | `--accent-quiet` ← `--accent-soft` | `rgba(57,211,192,.09)` | `rgba(14,158,142,.10)` | `rgba(194,96,60,.10)` |
   | `--color-pos` ← `--green` | `#54d49a` | `#1c9c63` | `#3f8a5a` |
   | `--color-warn` ← `--amber` | `#f4b740` | `#bd8311` | `#b8881f` |
   | `--color-neg` ← `--red` | `#f06a4d` | `#d35338` | `#c2603c` (same as accent — ora.css's own choice, not an error) |
   | `--color-info` ← `--blue` | `#5aa7f0` | `#2f7fd6` | `#2f6f6a` |
   | `--color-accent2` ← `--violet` | `#a98cf0` | `#7a5ad0` | `#8a5a72` |
   | `--shadow-card` ← `--panel-shadow` | `none` | `0 1px 2px rgba(35,50,75,.04), 0 10px 24px rgba(35,50,75,.05)` | `0 2px 4px rgba(90,70,40,.05), 0 14px 30px rgba(90,70,40,.07)` |
   | `--glow-accent` ← `--glow` | `0 0 0 1px rgba(57,211,192,.25), 0 0 18px rgba(57,211,192,.12)` | `0 0 0 1px rgba(14,158,142,.25), 0 6px 16px rgba(14,158,142,.12)` | `0 6px 14px rgba(194,96,60,.26)` |
   | `*-soft` pos/warn/neg (12% alpha) | derived via `color-mix(in oklab, var(--color-x) 12%, transparent)` per Phase 1's own note, matching ora.css's own soft variants at the same 12% alpha | | |

   **`--border-strong` has no ora.css source at all** — confirmed by grepping the full file for the original review's claimed values (`#2e3a49`/`#c9d2df`/`#d6c9b0`): zero hits. ora.css doesn't use a two-tier border-strength system; every emphasized border in it reuses `var(--line)` or switches to `var(--accent-dim)`/`var(--accent)` for interactive states instead. Resolution, same treatment as the radius xs/xl gap in point 1: derive `--border-strong` via `color-mix(in oklab, var(--border-subtle-base-hex) 65%, transparent)` (roughly double `--border-subtle`'s current ~26-40% intensity pattern) rather than inventing a literal hex — flagged as a judgment call, override if you want a different intensity.

## 4. Architecture — two-phase delivery

Because token *names* are unchanged (only their values move), landing the token layer alone re-colors and re-fonts the entire app immediately — every component already consumes `var(--accent)`, `var(--surface-base)`, etc. This means the two phases are not a "half-migrated, inconsistent-looking" sequence; PR-B is pure additive polish on top of an already-fully-retokenized app.

- **PR-A — token layer.** Branch `design/mission-control-tokens` (this worktree). Files: `src/tokens/theme.css` (fonts, colors, radii, three themes, base-layer signatures), `package.json` (Fontsource dependency swap), `src/lib/theme.ts` (`Theme` type gains `'warm'`), `src/shell/ThemeToggle.tsx` (2-way → 3-way cycle), and the brand-leftover sweep: `src/charts/theme.ts:7`, `src/modules/intel/LeaseRunView.tsx:162,189,286`, `src/modules/intel/PropertyIntelView.tsx:259` (comment only), `src/modules/overview/widgets.tsx:39` — all confirmed via grep as the only `color-gold`/`color-navy`/`navy-`/`gold-` hits outside `theme.css` itself.

  **`package.json` is architect-owned** (`.claude/hooks/architect-owned.json`, `CLAUDE.md` §4 Architect-only files) and is hard-enforced by `.claude/hooks/file-guard.mjs`, which blocks any edit to it unless `architecture/status.json` declares `review_needed: true` with a filled `review_detail` AND an architect acknowledgment exists at `.claude/overrides/architect-edit-ok`. `theme.css`, `theme.ts`, `ThemeToggle.tsx`, and every brand-sweep file above are NOT architect-owned — `package.json`'s Fontsource dependency swap is the only architect-owned touch in either phase. This is declared in `architecture/status.json`'s `mission-control-retokenization` entry; the actual `package.json` edit in PR-A execution is blocked until Gabriel's ack lands.
- **PR-B — consumers + signature details.** New worktree, opened after PR-A merges to main (so PR-B's contrast/visual verification runs against real token values, not assumptions). Files: `src/primitives/TierBoard.tsx` (severity glow on tier-header dots and the private `TierCard`), `src/primitives/StatusPill.tsx` (glow on live/refreshing state), `src/modules/insights/insights.logic.ts` (new `categoryTone()` export, threaded through a new `TierItem.categoryTone` field — not present on the interface today, added in this phase), `src/primitives/KpiStat.tsx` (remove 3px left bar, add `onPress`/`href`, wire drill-down per KPI — Value/SF → `portfolio`, NOI → `intel`, Debt → `debt`, Cash → `cash`, WALT/Occupancy → `leases` — all five module ids confirmed real in `src/shell/modules.tsx`), `src/shell/PortfolioFilterBar.tsx` (new `slice` prop, filtered-state styling), `src/shell/Sidebar.tsx` (replace the existing filled-pill active indicator with a 3px left-edge bar — see §5), `src/primitives/Badge.tsx` (radius → square-ish except count bubbles; resolve the `'gold'` tone), `src/charts/theme.ts` (series reorder + replace the hardcoded `--color-gold-300` fallback with `--color-warn`).

Both branches follow the CLAUDE.md worktree protocol: claimed in `architecture/status.json` before work starts (this branch's claim is in this same commit), re-verified against `git status`/`status.json` immediately before creation given how much this checkout has moved today from concurrent sessions.

## 5. Open judgment calls (flagged, not silently decided)

- **Radius xs/xl values** (§3.1) — proportional derivation chosen in the absence of a source value; specific pixels are overridable.
- **`--border-strong` value** (§3.4) — no ora.css source exists at all; derived via `color-mix` at higher intensity than `--border-subtle` rather than a copied hex.
- **Architect ack for `package.json`** (§4) — PR-A cannot land until Gabriel acknowledges the architect-owned dependency touch per the hook-enforced protocol. Not a design judgment call, but a hard process gate this spec cannot resolve on its own.
- **Sidebar active-state indicator** — the design system calls for a 3px left-edge bar; the current implementation already has a different, working active-state affordance (a filled pill via `motion.span`, confirmed in code). This spec recommends *replacing* the pill with the bar rather than running both, to avoid two redundant active-state signals. If Gabriel wants both, PR-B keeps the pill and adds the bar as a secondary accent.
- **`BadgeTone`'s `'gold'` literal** — not part of the categoryTone mapping; PR-B decides whether to retire it (if unreferenced after the sweep) or repoint it to a Mission-Control-coherent value.

## 6. Verification

- `npm run gate` (7 steps) + `npm run check:bundle` green on both PR-A and PR-B independently.
- `npm run test:e2e` (Playwright + axe) on PR-B, with an explicit contrast re-check: teal accent on dark/light surface, and all warm-theme text pairs, at ≥4.5:1 for body text.
- **Specific known gap for this pass, found during PR-A's final review (2026-07-08):** `--text-on-accent` does not clear 4.5:1 against saturated `--accent`/`--color-info`/`--color-neg` fills in the `parchment` and `warm` themes (measured: parchment ~3.3–4.15:1, warm ~4.11:1 across the accent/info/neg pairs checked; `command` clears fine, 6.2–7.5:1). This affects every filled badge/chip using `--text-on-accent` on those backgrounds, not just one component — `src/modules/acquisitions/RankedCandidateList.tsx`'s tier badges are the one instance found so far, but the token pairing itself is the root cause, not that file. PR-B's contrast pass must either pick a different text token for parchment/warm saturated fills, or adjust `--text-on-accent`'s value per-theme in `theme.css` (which would be a Task 5-7-adjacent follow-up, not a one-file patch) — flag to Gabriel as a real design-token decision, not something to silently patch component-by-component.
- `?still=1` screenshot pass across all 18 `design_handoff_ora_command_center/app/*.html`-equivalent module pages × 3 themes, attached to PR-B.
- Docs: append a "Visual parity — 2026-07-08 (reversed)" section to `docs/design-parity-audit-2026-07-06.md` recording this reversal and its rationale; CHANGELOG entry; CLAUDE.md §2 build-state row refresh — on whichever PR lands last.

## 7. Rollback

Token names never change, so either PR is a plain `git revert` with no schema or data migration. PR-A revert restores Oxford Terminal exactly; PR-B revert removes the polish layer while leaving PR-A's palette intact (acceptable as an intermediate state, since PR-B is additive, not corrective).

## 8. Execution

Per Gabriel's request to use the highest-intelligence model available (and consistent with the Engineering OS default of Opus for the build lane), implementation is dispatched to Opus 4.8 subagents via subagent-driven-development, given the file count and cross-file consistency requirements. Each PR gets independent local review before landing.
