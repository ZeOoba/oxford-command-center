# IA Decongestion — Shared Tabs Primitive + Module Restructure

> **Status:** PLAN ONLY — not started. Author session 2026-09-18. Role when executed: **UX Agent** (owns `src/modules/`, `src/primitives/`, `src/shell/`). Isolated worktree + `architecture/status.json` claim required before any edit (CLAUDE.md §0/§5).
> **For agentic workers:** use superpowers:subagent-driven-development; one PR per phase; `npm run gate` + `npm run check:bundle` green per commit.

## 0. Ground truth (verified 2026-09-18 against local main `412cd24` / origin `d41ff4d`)

1. **The July "Visual Design-System Parity Pass" prompt is ALREADY SHIPPED** — PRs #185 (tier-board Insights, TierBoard 1-col), #186 (tokens/fonts/radii/3 themes), #187 (severity glow, `categoryTone`, KpiStat drill, filter-bar slice, Sidebar bar, Badge), #188 (per-module re-QA), #189/#191 (contrast). Zero `Garamond|DM Sans|color-gold|color-navy|#c9a96e|#0a1322` hits in `src/`. Do **not** re-run that prompt. Residuals only: (a) no CHANGELOG entry for the retokenization; (b) `InsightsModule.tsx:43-70` local `SpineSplitStat` still carries the 3px left accent bar KpiStat dropped; (c) warm-theme `--text-on-accent` AA gap awaits Gabriel's pick among PR-A spec §5's 4 options.
2. **No shared Tabs primitive exists.** 7 modules hand-roll the same non-ARIA pill-button pattern copied from `DebtModule.tsx:212-238` (acquisitions, taxes, market, insurance, intel, calibration, debt); `lease-market` alone has `role="tablist"`. All tab state is local `useState` — not deep-linkable (`DebtModule.tsx:9`), except `/intel/:propertyId`.
3. **The design handoff's tab pattern is an underline strip, not pills** — `design_handoff_ora_command_center/app/ora.css:328` (`.tabs .tab.on{color:var(--ink);border-bottom-color:var(--accent)}`) + `.seg` segmented control (`ora.css:160`) for level-2 view switches. Shipped pills diverge from the bound visual contract.
4. **Overloaded, zero-tab modules:** `command-brain` (8 stacked sections, Open Questions rendered twice), `leasing` (5), `capital` (banner + 3 panels). **Overloaded default tabs:** `pipeline` Pipeline tab (6 sections), `debt` Positions (5), `market` Macro (5).
5. `react-aria-components` locked at **1.18.0** — `Tabs/TabList/Tab/TabPanel` available; `SelectionIndicator`/`TabPanels` reportedly 1.21+ (unverified) → do NOT bump `package.json` (Architect-owned); style the underline via `[data-selected]`.
6. E2E exposure: only Leases (`smoke.spec.ts:29-34`, `a11y.spec.ts:14-19`) assumes Rent Roll visible with no tab click.

## 1. Design rules (binding for this pass; sources in §6)

| # | Rule | Source |
|---|---|---|
| R1 | Never split numbers that are read in the same glance across tabs (DSCR/LTV/maturity; in-place rent vs market vs expiry; NOI vs basis). Run the "same-glance pairs" test before every split. | NN/g Tabs; GOV.UK; Atlassian; Carbon; Few Pitfall #1 |
| R2 | Anything true for all tabs (entity identity, KPI strip, as-of/provenance, spine-split summary, placeholder/hurdle banners) renders ABOVE the tab strip. | Atlassian hierarchy do/don't |
| R3 | Default tab answers the module's primary question; order by frequency. Few's sequence: see big picture → focus on exceptions → drill to act. | NN/g; Few 2006 |
| R4 | Severity must survive tabbing: a critical/warning item inside a non-default tab puts a count badge (≤4 chars, tone-colored, all counters resolved before paint) on that tab label. | Atlassian a11y; M3; Apple HIG; Primer |
| R5 | No nested tabs. Level 2 = `SegmentedControl` (alternate views of the SAME data: $ vs $/SF, monthly vs TTM, market toggle) or master-detail list. Two disclosure levels max (sidebar → tab). | Nielsen 2006; NN/g; Carbon content-switcher |
| R6 | Labels 1–2 words, nouns, parallel, sentence case, never truncated; strip must fit one row at 1280px with no wrap/scroll. (There is NO citeable "5–7 max" rule — the constraint is geometric.) | NN/g; Carbon; M3; GOV.UK |
| R7 | Never hide/disable an empty tab — show it with an explaining empty state. | Apple HIG |
| R8 | Prune before tabbing: delete duplicates and demote low-value content first. | GOV.UK; Carbon dashboards |
| R9 | Two selection indicators (accent underline + ink color/weight). APG Tabs keyboard pattern via RAC — no hand-rolled key handlers. `keyboardActivation="manual"` on panels that fire warehouse queries. | NN/g; W3C APG; React Aria |
| R10 | Tab state in URL (`?tab=`), validated against known keys, `replace` not `push`, preserved alongside `?scenario=`. Panels lazy (RAC default unmount) — hoist any filter state that must survive. | Stripe URL-as-view; engineering judgment (no UX-body mandate exists) |
| R11 | Tier boards stay tier boards inside tab panels (no-long-lists rule, `ora.css:685`). Honesty doctrine, provenance underlines, `?still=1`, reduced-motion all unchanged. | repo binding rules |

## 2. Phases

> **As-executed numbering (2026-09-19) — THIS list governs; it supersedes §2b's "Merged sequence" numbering, which reused the numbers differently and was never what shipped.**
> P0 primitives ✅ #337 · P1 retrofit 8 tab strips ✅ #340 · P2 tab command-brain / leasing / capital — #342 (open, CI running at time of writing) · **P3 split the overloaded default tabs: pipeline, debt, market, leases, documents (the "Phase 3" table below)** · P4 rail consolidation (the handoff's destinations: Intel 8→5 + `data` destination, `worklist`, Capital composition + legacy-route alias table, Leasing/Brain/Market/Obligations; §2b corrections apply) · P5 Overview curation.
> P3 must stay forward-compatible with P4: every split below is designed so a module that later becomes a tab of a bigger destination can turn its tab strip into a `SegmentedControl` (never a second tab strip) without changing its panels.

### Phase 0 — Primitives (1 PR, no module behavior change)
- `src/primitives/Tabs.tsx` — RAC `Tabs/TabList/Tab/TabPanel` wrapper. Props: `tabs: {id,label,badge?:{count:number,tone:BadgeTone},group?:string}[]`, `selectedKey`, `onSelectionChange`, `keyboardActivation`, `aria-label`. Underline style per `ora.css:328` using existing tokens (`--border-subtle`, `--accent`, `--text-primary/tertiary`); optional group divider (port Intel's intelligence/data-ops split); 120ms color/border transition, none under reduced motion / `isStill()`.
- `src/primitives/SegmentedControl.tsx` — RAC `ToggleButtonGroup`/radio semantics, `.seg` look (`ora.css:160`), active fill `--accent` + `--text-on-accent`.
- `src/lib/useTabParam.ts` — `(keys, defaultKey) => [key, setKey]` over `useSearchParams`; unknown → default; `replace:true`; must not drop `?scenario=` (see `UiProvider.tsx:29-33,47-60`).
- `src/primitives/ModuleHeader.tsx` (or documented pattern): title → KPI strip → banners → `<Tabs>`; optional sticky-condense is OUT of scope v1.
- Tests: unit (roving tabindex/arrow wrap, badge cap `99+`, param validation, scenario preservation), axe on a fixture page, 3-theme contrast for selected/unselected labels.

### Phase 1 — Retrofit existing tabbed modules (behavior-neutral, 1 PR)
Swap hand-rolled pills → `<Tabs>` + `useTabParam` in: debt, acquisitions, taxes, market, insurance, calibration, intel (keep `/intel/:propertyId` auto-select), lease-market (replace `Toggle role="tab"`; its market toggle → `SegmentedControl`). Labels unchanged. Delete the 7 duplicated style blocks. Fix residual (b): `SpineSplitStat` → KpiStat anatomy.

### Phase 2 — Tab the zero-tab overloaded modules (1 PR each, or 1 combined)
| Module | Above tabs (R2) | Tabs (default first) | Notes |
|---|---|---|---|
| `command-brain` | Disclaimer + KPI strip | **Track record** · Feedback · Memory · Versions | R8: delete duplicate read-only Open Questions (keep inside Feedback; badge = open count). Accuracy sparklines live in Track record. |
| `leasing` | Expiry bucket cards (4) | **Rollover** · Forecast · Market rents · Narrative | R1: Velocity table stays with Rollover; rent-gap column must remain visible in Rollover rows (gap vs expiry is a same-glance pair). Scenario toggle → `SegmentedControl` inside Forecast. |
| `capital` | HurdleRateBanner + headline verdict counts | **Allocation** · Cap rates · Buy pipeline | IC-memo export + Notion sync buttons move to header actions. Spine-split summaries stay above tabs. |

### Phase 3 — Split overloaded default tabs (1 PR)
| Module | Today | Proposed |
|---|---|---|
| `pipeline` | Pipeline(6 sections) · Grader | **Pipeline** (KPIs above; stage bars + Active Deals) · Workbench · Sourcing (AcquisitionsIntel off-market) · Grader. Sync toolbar → header actions. |
| `debt` | Positions(5) · Scorecard | KPI strip + balloon-watch banner above; **Positions** (loan table) · Maturities (ladder + composition) · Scorecard. R1 check: table rows keep DSCR/LTV/maturity columns together. |
| `market` | Macro(5) · Comps | **Macro** (KPIs + 10Y + Acquisition Lens) · Scorecards · Comps |
| `leases` | single scroll | **Rent roll** (default — keeps both e2e tests green) · Rollover |
| `documents` | single scroll | KPIs above; **Search** · Corpus |
Leave untabbed (already fit / single-purpose): overview, principal, alerts, calendar, renewals, tasks, cash, close, portfolio, tenants, health.

### Phase 4 — Sidebar consolidation (DECISION REQUIRED — Gabriel)
26 sidebar items is itself the top-level version of the same complaint. Proposal: fold `leasing` + `renewals` into `leases` as tabs (Rent roll · Rollover · Renewals · Forecast · Market rents), fold `calibration` under `command-brain`, keep `lease-market` separate (market data ≠ owned leases). Requires route redirects in `src/brain/routing.ts` + `module-order.ts` + palette index; breaks bookmarks → ship redirects. Not started without explicit OK.

### Phase 5 — follow-on plans (separate docs; see ranked list in session output 2026-09-18)
Exception-first Home with explicit priority formula + Opportunity/Risk split · unified Property page (Overview · Financials · Leases · Debt · Risk · Documents · History) · Deal Room tabs + decision log · insight→task.

## 2b. Reconciliation with Claude Design "IA Restructure 2026-09-18" (reviewed same day)

Source: `design_handoff_ora_command_center/IA_RESTRUCTURE_PROMPT.md` + `IA Restructure - Command Center 2026-09-18.html` (handoff zip). Verdict: **adopt its rail consolidation (26 → 11 two-level destinations) — it supersedes Phase 4 above — and keep this plan's in-page rules (R1–R11), which the design lacks.** Status: Phase 0 **MERGED** — PR #337 → `0871d3b` on origin/main. Worktree `agent-a745fb3bfa818402c` removed post-merge. `src/primitives/{Tabs,SegmentedControl}.tsx` + `src/lib/useTabParam.ts` are now on main — Phase 1 starts from a fresh worktree off current origin/main (NOT off the old Phase 0 branch/worktree, which no longer exists).

**Gabriel-ratified 2026-09-18 (same session, decisions "1. Yes 2. Yes"):**
1. Adopt the 11-destination rail from the handoff in place of this plan's narrower Phase 4.
2. Keep `lease-market` as its OWN rail destination (not folded under Market) — rail is therefore **12** items, not 11, per correction #4 below.

Merged sequence: P0 ✅ #337 → P1 retrofit 8 modules (identical in both) → P2 Intel 8→5 + new `data` destination (Imports · Quality · Mappings · Calibration · Documents) + Health → TopBar status dot/drawer → P3 `worklist` (Today · Alerts · Calendar · Renewals) and `capital` (Allocation · Debt · Cash · Close) by pure composition → P4 Leasing / Brain / Market / Obligations + the Acquisitions split + this plan's Phase 2/3 panel surgery → P5 Overview curation.

Corrections to the design (verified against code):
1. **Tab routing: keep `?tab=` (built), not `/:moduleId/:tabId`.** `parseRoute` already uses segment 2 as the entity id (`/debt/<loanId>`, `/intel/<propertyId>`, `MODULE_PRIMARY_TYPE`) — a path tab segment is ambiguous with it. Absorbed modules need a **legacy alias table** in `src/brain/routing.ts` (`/debt/:id` → capital + `tab=debt` + loan drawer; `HOME_MODULE`/`entityPath` updated) — this is the real hidden cost of P3 and is not in the design brief.
2. "Acquisitions — already correct, no change" is **wrong**: shipped tabs are Pipeline · Grader only; Workbench and off-market Intel are sections inside Pipeline. The split is still required (P4).
3. Rule 3 ("default tab: no table > 8 rows") contradicts its own Leasing default `Rent Roll` (a ~140-row table) and the two Leases e2e specs. Resolve: Leasing default = Expiries (bucket cards + exceptions); update `smoke.spec.ts`/`a11y.spec.ts` to click the Rent roll tab.
4. **Three-level nesting risk** where an absorbed module already has tabs: Debt (→ segmented Positions · Maturities · Scorecard ✔), Calibration (3 ✔), Insurance/Taxes (3 each ✔), but **Lease Market has 5 tabs + a market toggle** → tab → 5-way segmented → toggle is too deep. Keep `lease-market` as its own rail destination (12 items, not 11) unless Gabriel prefers otherwise.
5. `principal` folds into Brain · Digest → `PROFILE_HOME.principal` must repoint or Eric's landing route breaks.
6. "Five tabs hard cap" has no primary-source basis (see §1 R6) but is a fine house rule; adopt the dev-warn + unit test. Note Capital reaches exactly 5 once the Capacity tab (`2026-09-18-capital-deployable-capacity.md`) lands.
7. Adopt from the design: `tabs` declared on `ModuleDef` so the ⌘K palette indexes tabs (safety valve for every absorbed rail item); every-legacy-id-resolves unit test; per-destination Playwright reload test; contrast test for tab label + count pills × 3 themes; alarm-tone count pills sourced from existing hooks only.
8. `TabStrip` API (count/tone) vs shipped `Tabs` (badge{count,tone}): same capability; keep `Tabs` (real APG behavior from React Aria rather than hand-rolled roving tabindex).

## 3. Verification (per PR)
`npm run gate` (7 steps; rerun on the known intermittent 0xC0000005) · `npm run check:bundle` (< 250 kB gzip entry) · `npm run test:e2e` (+ add one spec per restructured module: default tab content visible, `?tab=` deep link restores, badge shows when a critical item sits in a non-default tab) · `?still=1` screenshots of every tab × 3 themes attached to PR · 1280px one-row check on every strip.

## 4. Pre-flight failure modes
1. **Stale tree** — repo lands multiple PRs/day; re-fetch and re-grep every line number here before editing.
2. **Shared checkout** — work only in a worktree; junction-`node_modules` footgun on removal (see memory).
3. **R1 violations introduced by the split itself** — each Phase 2/3 PR body must list the same-glance pairs checked.
4. **Hidden alerts** — R4 badge wiring is part of the same PR as the split, never a follow-up.
5. **Search-param clobber** — `?tab=` must coexist with `?scenario=` and `?still=1`.

## 5. Rollback
Each phase is one squash-merge → `git revert <sha>`. Phase 0/1 are behavior-neutral; Phases 2–3 touch only `src/modules/**` + tests. No migrations, no contracts, no server changes, no financial code (no refute pass required).

## 6. Sources (accessed 2026-09-18)
NN/g *Tabs, Used Right* (Sunwall 2024-08-02) nngroup.com/articles/tabs-used-right · NN/g *Progressive Disclosure* (Nielsen 2006-12-03) · NN/g *8 Design Guidelines for Complex Applications* (Kaplan 2020-11-08) · NN/g *Dashboards: Preattentive* (Laubheimer 2017-06-18) · GOV.UK Design System *Tabs* · Atlassian DS *Tabs/Usage* · IBM Carbon *Tabs*, *Content switcher*, *Dashboards* · Material 3 *Tabs* · Apple HIG *Tab bars* · GitHub Primer *UnderlineNav* · W3C WAI-ARIA APG *Tabs pattern* + *Keyboard interface* · React Aria *Tabs* react-aria.adobe.com/Tabs · Few, *Common Pitfalls in Dashboard Design* (Perceptual Edge, 2006) · Shneiderman, *The Eyes Have It* (IEEE VL 1996) · Stripe Dashboard search docs (URL-as-view) · Linear docs (peek, display options) · Ramp Transaction Reviews (counted worklist tabs) · CRE platform survey: Reonomy property tabs (Building & Lot · Ownership · Tenants · Sales · Debt · Tax), RealPage AIM lease tabs, Yardi Voyager 6.0 count-as-link, Crexi Record Tabs, CompStak activity tabs, Agora LP portal. Unverified/folklore explicitly excluded: "5–7 tab max", "Carbon ≤6", any UX-body mandate for URL tab state.
