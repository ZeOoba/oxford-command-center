# Handoff: ORA Command Center

## Overview
The **ORA Command Center** is a desktop dashboard for a commercial-real-estate (CRE)
investment & operations firm ("Oxford RA" / Oxford Realty Advisors). It consolidates, in
one product, the capability surface of several industry platforms — **Dealpath**
(acquisition pipeline), **Yardi Voyager / AppFolio** (accounting + property operations),
**Tableau** (analytics), **Re-Leased** (lease management), and **Buildout** (market comps)
— and adds an **AI reasoning layer** on top: a tax-strategy engine, a continuously-scanning
insurance program, an OM grader that scores deals against the firm's buy box, and a
self-improving "Command Brain." The goal is a single command center a managing partner /
asset manager / controller can run the business from.

The modeled portfolio: shallow-bay industrial & flex, Class B/C, across 5 core markets.

## About the design files
The files in `app/` are a **design reference created in HTML** — a working prototype that
shows the intended look, behavior, and data model. They are **not production code to ship
directly.** The task is to **recreate these HTML designs in the target codebase's
environment** (React, Vue, etc.) using its established patterns and libraries — or, if no
environment exists yet, to pick the most appropriate framework and implement there. The
prototype itself is vanilla HTML/CSS/JS with **no build step** (open any `.html` directly).

Four prompts ship with this bundle:
- **`ANALYZE_AND_PLAN_PROMPT.md`** — **start here.** Run from inside the
  `oxford-command-center` repo. Pre-loaded with verified facts about that repo (stack,
  two-spine architecture, governance protocol, the ratified acquisition ruleset, existing
  modules) so Claude Code verifies rather than rediscovers — then produces a phased,
  verifiable `IMPLEMENTATION_PLAN.md` and stops for approval before any code.
- **`KICKOFF_PROMPT.md`** — build-oriented kickoff (orient → four AI capabilities → the
  rest). Use after the plan is approved, or instead of it if you want to skip straight to
  building.
- **`IMPLEMENTATION_PROMPT.md`** — the full build directive: the three spine systems and the
  12 ownership goals.
- **`CLAUDE_CODE_PROMPT.md`** — a design-review pass (critique & push back, no code).

## Fidelity
**High-fidelity.** Final colors, typography, spacing, component styling, and interactions
are all present and intentional. Treat the token values below as the source of truth.

## How to run / explore
Open `app/Overview.html` in a browser. No server needed.
- **Navigation:** left icon rail (injected by `ora.js`), 15 destinations.
- **Theme:** the header theme button cycles **Dark → Light → Warm** (persists via
  `localStorage`, key `ora-theme`). Density toggle persists under `ora-density`.
- **Drill-down:** Portfolio rows, Studio rows, Operations units, Acquisition cards, and
  every ranked card navigate to detail pages via `?id=` (e.g.
  `Property.html?id=…`, `DealRoom.html?id=…`, `Investor.html?id=…`).
- **Tables:** any `table.tbl[data-enhance]` has click-to-sort headers, a live search box,
  and auto filter-chips (from the column named in `data-chips`).
- **Analytics:** `Studio.html` cross-filters every chart on click.
- **OM Grader:** `Grader.html` — drop a file, click a sample chip, or enter figures
  manually → simulated extraction → buy-box scorecard.
- **Command Brain:** `Brain.html` — accept/dismiss signals in the Feedback Loop; the
  accuracy KPI recalibrates and persists (`localStorage` key `ora-brain-v1`).

## Architecture — data & reasoning layers
The defining property of this system: **every figure derives from one canonical data layer,
so numbers reconcile across all screens.** The new AI pages are pure functions of that data
plus a set of reasoning engines — nothing is hand-asserted.

**Data**
- `app/data.js` — **single source of truth** (`window.ORA`). Portfolio, deals, investors,
  property managers; **computes** all totals (AUM, NOI, occupancy, cap, LTV). Also models a
  **monthly history since acquisition** per asset (`p.S` series, `GLOBAL_MONTHS`) and a
  trailing-12 `hist`, so trends and anomalies are real, not random.

**Reasoning engines (vanilla JS modules on `window`)**
- `app/trends.js` (`ORA_TRENDS`) — trend math (YoY, slopes), anomaly detection over the
  monthly series, and a shared chart renderer.
- `app/engine.js` (`ORA_ENGINE`) — ranked, **$-quantified** signals across the portfolio
  (incl. anomalies); `SIGNALS`, `forLens()`, `rowHtml()`, severity `sev` high/med/low.
- `app/filter.js` (`ORA_FILTER`) — global portfolio slice (market / subtype / manager) +
  as-of period, persisted across modules.
- `app/news.js` (`ORA_NEWS`) — macro/markets (rates real-anchored to mid-2026) + a
  portfolio-tied briefing.
- `app/tax.js` (`ORA_TAX`) — per-asset tax profile (reconciles to the modeled property-tax
  line), ranked strategy engine (appeals · cost-seg/bonus depreciation · entity structuring
  · pipeline structuring), and a filed-return archive with AI review notes.
- `app/ins.js` (`ORA_INS`) — per-asset policy register (premium reconciles to the modeled
  insurance line), continuous savings scanner (re-bid · deductible/limit optimization),
  self-insurance / risk-retention analysis (premium vs. modeled expected loss), and a
  re-bid pipeline. Benchmark rate is computed from the book's own median.
- `app/grader.js` (`ORA_GRADER`) — the **buy box** (weighted criteria + thresholds +
  deal-breakers), a 0–100 + letter-grade scorer, pre-baked sample OMs, and auto-grading of
  the live pipeline.
- `app/brain.js` (`ORA_BRAIN`) — the self-improving meta-layer: prediction track record,
  learned-knowledge memory (confidence-tiered), per-market/manager confidence, open
  uncertainties, a self-improvement log, and a persisted accept/dismiss feedback loop.

**Shell / UI**
- `app/ora.css` — the **entire design system**: CSS-variable tokens, all components,
  the shared **ranked tier-board** pattern, and three themes via `[data-theme]`.
- `app/ora.js` — builds the nav rail on every page, 3-theme cycle, density toggle, sub-tabs,
  command-palette list.
- `app/table.js` — generic table enhancer. `app/studio.js` — cross-filter engine.

## Design principle — no long single-column lists
A persistent rule across the product (see any "RANKED …" board): **never render a long
single-column list.** Group items into ranked tiers (by severity, lever, grade, or
confidence), render each tier as its own boxed column with a header (name, count, total),
rank items vertically within the column, and place tier columns adjacent. The shared CSS is
`.tiers` / `.tier` / `.tcard` in `ora.css`; reference implementations are the boards on
`Insights.html`, `Taxes.html`, `Insurance.html`, `Grader.html`, and `Brain.html`.

## Screens / Views

**Core (existing) modules**
- **Overview** — home: KPI strip, portfolio-growth chart, pipeline / lease / inbox / insight panels.
- **Portfolio** — AUM growth, by-region table, composition, risk flags, full asset table → Property.
- **Acquisitions** — Dealpath-style 5-column kanban from `ORA.DEALS`; each card now also
  shows its **buy-box letter grade** (from `grader.js`). Cards → Deal Room; header links to OM Grader.
- **Financials** — Yardi-style: Statements, GL, Receivables, Payables, Rent Roll, Budget vs. Actual.
- **Studio** — Tableau-style cross-filtering analytics.
- **Operations** — AppFolio-style work orders, unit status, tenant ledger.
- **Comps / Leases / Inbox / Insights / News** — market comps, expiry timeline, action threads,
  ranked insight feed, macro briefing.
- **Property / Deal Room / Investor** — detail pages, data-bound by `?id=`.

**New AI capabilities**
- **Taxes** (`Taxes.html`) — 4 KPIs (annual property tax, effective rate, identified
  opportunity, appeals to file). Three tabs: **Strategy Board** (tiered: Appeals ·
  Depreciation & Cost-Seg · Structure & Pipeline, ranked by $ impact); **Assessments &
  Appeals** (assessed vs. market table + appeal opportunity); **Filed Returns** (year-by-year
  archive with per-year AI review notes).
- **Insurance** (`Insurance.html`) — 4 KPIs (annual premium, rate per $100 TIV vs. benchmark,
  identified savings, renewals ≤90d). Three tabs: **Savings Board** (tiered: Re-bid ·
  Optimize Coverage · Retain Risk); **Policy Register** (full register + renewal calendar);
  **Self-Insure & Bids** (premium-vs-expected-loss split bar + recommendation, and a
  competitive re-bid pipeline).
- **OM Grader** (`Grader.html`) — drop an OM / pick a sample / enter figures → simulated
  field-by-field extraction → **buy-box scorecard**: animated grade gauge, verdict, weighted
  per-criterion pass/watch/fail bars. The buy box is shown alongside (editable intent). The
  full live pipeline is auto-graded into Fits / Tradeable / Below-Mandate tiers.
- **Command Brain** (`Brain.html`) — 4 KPIs (flag accuracy, signals watched, data points
  learned from, recalibrations). Accuracy-over-time sparkline; prediction track record
  (hit/partial/miss with $ at stake); **feedback loop** (accept/dismiss live signals →
  recalibrates, persisted); learned-knowledge memory in confidence tiers; confidence by
  market & manager; open uncertainties with the data that would close each gap; and a
  self-improvement version log.

## Design tokens (dark theme — the default; see `ora.css` for light & warm)
**Type:** `--font-sans` IBM Plex Sans · `--font-mono` IBM Plex Mono · `--font-disp` (warm
theme swaps display to Bricolage Grotesque + Public Sans).
**Surfaces:** `--bg #0c0f14` · `--bg-2 #0f141b` · `--panel #141a22` · `--panel-2 #171f29`
· `--inset #0b1016` · `--line #222c38` · `--line-2 #1b2531`.
**Text:** `--ink #e8edf3` · `--ink-2 #aab6c4` · `--muted #6b7888`.
**Accents:** `--accent #39d3c0` (teal) · `--amber #f4b740` · `--green #54d49a` ·
`--red #f06a4d` · `--blue #5aa7f0` · `--violet #a98cf0` (each with `-soft` / `-bd` variants).
**Severity / grade color mapping:** A → green, B → teal accent, C → amber, D/F → red;
high → red, med → amber, low → blue, good → green.
**Shape:** radii `--r-sm 7px` / `--r 11px` / `--r-lg 12px` (warm enlarges these); panel/KPI
shadows none in dark, soft in light/warm.
**Scale:** body 14px; KPI values ~21–28px mono; grade gauge numeral 46px display; panel
headers 12px; table text 12.5px; mono labels 9–11px uppercase, letter-spacing .05em.

## Key components (in `ora.css`)
- **Ranked tier board** — `.tiers` (`.t2`/`.t4` for column count) › `.tier` (`.t-high`
  `.t-med` `.t-low` `.t-good` `.t-acc` `.t-vio`) › `.tier-hd` / `.tier-meta` / `.tier-body`
  › `.tcard` (`.tc-top` / `.tc-rank` / `.tc-imp` gain|risk|info / `.tc-title` / `.tc-detail`
  / `.tc-action`).
- **OM Grader** — `.drop` (drag states), `.samplechip`, `.extract`/`.exline` (staggered
  reveal), `.gradebox` + `.gauge` (SVG ring, animated stroke-dashoffset), `.critrow`
  (label · weighted bar · pass/warn/fail stat).
- **Insurance** — `.polrow`, `.renewbar` (`.soon`/`.now`), split bar for self-insure.
- **Command Brain** — `.brainhd`, `.memcard` (confidence-tiered), `.confrow`, `.feedrow`
  + `.facts .ab` (accept/dismiss, `.done` states), `.vlog` (version timeline), `.uncert`.

## Buy box (the grading mandate — confirm & tune with the client)
Shallow-bay industrial & flex · Class B/C · 5 core markets · $3–20M · going-in cap ≥ 7.0% ·
levered IRR ≥ 14% · equity multiple ≥ 1.7x · ≤ 55% LTV · 80–96% occupancy (value-add room) ·
1985+ vintage · mark-to-market upside. Weights and thresholds live in `grader.js`
(`BUYBOX.criteria`), with hard deal-breakers (off-mandate asset type; size far outside band).
**This is an inferred default — replace with the firm's real criteria.**

## What is real vs. modeled (important for implementation)
- **Real, structural:** the data model, the reconciliation guarantee, the reasoning logic
  (ranking, scoring, anomaly detection, the buy-box rubric, the self-insure math), the IA,
  and the full design system.
- **Modeled / simulated (replace with real sources):** the underlying figures (seeded
  pseudo-data), OM "extraction" (no PDF parsing backend — it animates plausible fields),
  the brain's accuracy/track-record numbers, and the learned-memory entries. These are
  placeholders that show intended behavior.

> **Data source for implementation:** the existing Claude Code–built **Oxford Command
> Center** codebase already holds Oxford's real portfolio data — that is the canonical
> source of truth. Bind every screen and engine to it; do **not** ship the prototype's
> seeded figures. See `IMPLEMENTATION_PROMPT.md` → "Ground truth."

## Files
All under `app/`. **Pages:** `Overview`, `Portfolio`, `Acquisitions`, `Grader`, `Leases`,
`Financials`, `Taxes`, `Insurance`, `Studio`, `Operations`, `Comps`, `Inbox`, `Insights`,
`News`, `Brain`, `Property`, `DealRoom`, `Investor` (`.html`). **Engines/shell:** `data.js`,
`trends.js`, `engine.js`, `filter.js`, `news.js`, `tax.js`, `ins.js`, `grader.js`,
`brain.js`, `ora.js`, `ora.css`, `table.js`, `studio.js`.

## Screens (rendered)
`screens/` holds dark-theme PNG captures of the **original** core modules (Overview,
Portfolio, Acquisitions, Financials, Studio, Operations, Comps, Leases, Inbox, Insights,
the three detail pages, plus light & warm theme variants). **These predate the four new AI
pages** (Taxes, Insurance, Grader, Brain) — open those HTML files directly, or ask for fresh
captures.

## Assets
No external image assets — all iconography is inline SVG; placeholder "photo" blocks use a
styled fallback. Fonts load from Google Fonts (IBM Plex Sans/Mono, Bricolage Grotesque,
Public Sans). If implementing in a brand codebase, swap to that system's fonts/brand.
