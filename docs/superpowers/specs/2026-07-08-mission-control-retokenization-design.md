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
- Full token-layer swap: colors, fonts, radii, three themes (`command`, `parchment`, `warm`) — findings #1/#4 of the original review.
- Component-level consumers of the new tokens: severity glow language, category color-coding, `KpiStat` anatomy + drill-down navigation, `PortfolioFilterBar` affordances — findings #5/#6.
- Signature details: filter pills, sidebar active-state, badge shape, chart series — finding #7.
- Full verification pass (gate, Playwright + axe, contrast, screenshot diff) and doc/changelog updates.

**Out of scope (already done):** PR #185's structural fixes (`InsightsWidget` tier-board reshape, `TierBoard` 1-column support).

**Out of scope (deferred, per the original review and the repo's own cut-list):** as-of period rewind control on the filter bar, any `docs/design-handoff-cut-list-reconciliation.md` C1–C11 item, any module restructuring beyond the components named in §4.

## 3. Corrected inputs (fact-check findings)

The original review's Phase 1 token-value table was checked line-by-line against `design_handoff_ora_command_center/app/ora.css`. Three corrections apply:

1. **Radius scale.** ora.css defines only three radius values at its root: `--r-sm:7px; --r:11px; --r-lg:12px` (plus `--r-pill:6px`, a distinct pill-shaped-corner token, not a general scale step). The original review's claimed `--radius-xs:5px` has no source anywhere in ora.css, and its claimed `--radius-xl:18px` is not a root-theme value at all — it's ora.css's *warm-theme* `--r-lg` value, misattributed to the default theme. Resolution: `sm`/`md`/`lg` are copied exactly (7/11/12 default, 10/14/18 warm, confirmed real warm-theme values). `xs` and `xl` have no source value in either theme; they are set proportionally to preserve the existing 5-step scale's relative spacing (`xs = sm − 2`, `xl = lg + 6`) — default theme: xs 5px, xl 18px; warm theme: xs 8px, xl 24px. This is a judgment call, not a copied design-system value — Gabriel can override the specific pixels without changing anything else in this spec.

2. **Fonts.** ora.css loads IBM Plex Mono/Sans, Bricolage Grotesque, and Public Sans via a Google Fonts CDN `@import url(...)`. This repo's own guardrail requires self-hosted fonts only (Fontsource, no CDN links) — copying ora.css's import line verbatim would violate that rule. Resolution: adopt the same four type families via the equivalent self-hosted Fontsource packages (`@fontsource/ibm-plex-sans` 400/500/600/700, `@fontsource-variable/bricolage-grotesque`, `@fontsource-variable/public-sans` 400–700; keep the existing `@fontsource/ibm-plex-mono`), never the CDN import.

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

## 4. Architecture — two-phase delivery

Because token *names* are unchanged (only their values move), landing the token layer alone re-colors and re-fonts the entire app immediately — every component already consumes `var(--accent)`, `var(--surface-base)`, etc. This means the two phases are not a "half-migrated, inconsistent-looking" sequence; PR-B is pure additive polish on top of an already-fully-retokenized app.

- **PR-A — token layer.** Branch `design/mission-control-tokens` (this worktree). Files: `src/tokens/theme.css` (fonts, colors, radii, three themes, base-layer signatures), `package.json` (Fontsource dependency swap), `src/lib/theme.ts` (`Theme` type gains `'warm'`), `src/shell/ThemeToggle.tsx` (2-way → 3-way cycle), and the brand-leftover sweep: `src/charts/theme.ts:7`, `src/modules/intel/LeaseRunView.tsx:162,189,286`, `src/modules/intel/PropertyIntelView.tsx:259` (comment only), `src/modules/overview/widgets.tsx:41` — all confirmed via grep as the only `color-gold`/`color-navy`/`navy-`/`gold-` hits outside `theme.css` itself.
- **PR-B — consumers + signature details.** New worktree, opened after PR-A merges to main (so PR-B's contrast/visual verification runs against real token values, not assumptions). Files: `src/primitives/TierBoard.tsx` (severity glow on tier-header dots and the private `TierCard`), `src/primitives/StatusPill.tsx` (glow on live/refreshing state), `src/modules/insights/insights.logic.ts` (new `categoryTone()` export, threaded through `TierBoard`'s `TierItem.categoryTone`), `src/primitives/KpiStat.tsx` (remove 3px left bar, add `onPress`/`href`, wire drill-down per KPI — Value/SF → `portfolio`, NOI → `intel`, Debt → `debt`, Cash → `cash`, WALT/Occupancy → `leases` — all five module ids confirmed real in `src/shell/modules.tsx`), `src/shell/PortfolioFilterBar.tsx` (new `slice` prop, filtered-state styling), `src/shell/Sidebar.tsx` (replace the existing filled-pill active indicator with a 3px left-edge bar — see §5), `src/primitives/Badge.tsx` (radius → square-ish except count bubbles; resolve the `'gold'` tone), `src/charts/theme.ts` (series reorder + replace the hardcoded `--color-gold-300` fallback with `--color-warn`).

Both branches follow the CLAUDE.md worktree protocol: claimed in `architecture/status.json` before work starts (this branch's claim is in this same commit), re-verified against `git status`/`status.json` immediately before creation given how much this checkout has moved today from concurrent sessions.

## 5. Open judgment calls (flagged, not silently decided)

- **Radius xs/xl values** (§3.1) — proportional derivation chosen in the absence of a source value; specific pixels are overridable.
- **Sidebar active-state indicator** — the design system calls for a 3px left-edge bar; the current implementation already has a different, working active-state affordance (a filled pill via `motion.span`, confirmed in code). This spec recommends *replacing* the pill with the bar rather than running both, to avoid two redundant active-state signals. If Gabriel wants both, PR-B keeps the pill and adds the bar as a secondary accent.
- **`BadgeTone`'s `'gold'` literal** — not part of the categoryTone mapping; PR-B decides whether to retire it (if unreferenced after the sweep) or repoint it to a Mission-Control-coherent value.

## 6. Verification

- `npm run gate` (7 steps) + `npm run check:bundle` green on both PR-A and PR-B independently.
- `npm run test:e2e` (Playwright + axe) on PR-B, with an explicit contrast re-check: teal accent on dark/light surface, and all warm-theme text pairs, at ≥4.5:1 for body text.
- `?still=1` screenshot pass across all 18 `design_handoff_ora_command_center/app/*.html`-equivalent module pages × 3 themes, attached to PR-B.
- Docs: append a "Visual parity — 2026-07-08 (reversed)" section to `docs/design-parity-audit-2026-07-06.md` recording this reversal and its rationale; CHANGELOG entry; CLAUDE.md §2 build-state row refresh — on whichever PR lands last.

## 7. Rollback

Token names never change, so either PR is a plain `git revert` with no schema or data migration. PR-A revert restores Oxford Terminal exactly; PR-B revert removes the polish layer while leaving PR-A's palette intact (acceptable as an intermediate state, since PR-B is additive, not corrective).

## 8. Execution

Per Gabriel's request to use the highest-intelligence model available (and consistent with the Engineering OS default of Opus for the build lane), implementation is dispatched to Opus 4.8 subagents via subagent-driven-development, given the file count and cross-file consistency requirements. Each PR gets independent local review before landing.
