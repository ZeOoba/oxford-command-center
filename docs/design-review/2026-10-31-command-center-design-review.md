# Command Center Design Review — 2026-10-31

**Built against:** `origin/main` 47013622 (live `main-live` preview, Master Workbook as of 2026-10-30, refreshed 2026-10-31 20:08 UTC).
**Method:** (1) live walk of all 14 rail destinations at 1440×900, both themes; (2) code audit of `src/` (tokens, primitives, formatters, IA, a11y); (3) external practice research; (4) prior rulings and plans (10-28 design handoff, 10-29 Signal Discipline rulings, 10-30 actionable-intelligence roadmap and Wave B rulings); (5) independent adversarial refute pass on the load-bearing claims.
**Scope rule:** items already covered by the 10-30 roadmap or an open PR are listed as *in flight* and not re-proposed. Rulings are respected: no owner model, no urgency×confidence ranking, $5K floor, 7-row cap, no cross-basis NOI sums, no invented dollars.

---

## 1. Verdict

The architecture of attention is right: exception-first Overview, pinned safety items, a materiality floor and basis labelling are ahead of anything the commercial RE platforms document publicly. The roadmap (Waves A–C) and the 12 open UI PRs (#522–#536) already address the largest structural gaps: per-card as-of, a canonical property page, one chart kit and chart accessibility.

What remains is a layer the roadmap does not cover: **signal integrity on the Overview itself** (what gets into the 7 rows and what the header dollars add up to), **one count for "needs attention"**, **IA naming and duplication**, and **design-system hygiene** that is now causing visible defects (invisible progress tracks, a hard-coded theme-blind alert badge, the same NOI rendered as $4.2M and $4.19M).

---

## 2. Findings — net new (not in the roadmap or an open PR)

Ranked by decision impact. Tag: **[V]** verified live and in code; **[R]** survived the independent refute pass (see §5).

### P1 — Signal integrity on Overview

**1. Valuation observations take action slots and inflate the risk total.** [V][R]
The "Premium valuation" insight (family `CF`, `server/insights/generators/cf-hurdle-drag.ts:65-105`) carries `confidence: 0.7 // seed benchmark — not live market data` and has no verb. It still ranks #5 of 7, above the holdover row (#6, $8.5K). Its $52K "NOI gap to market-median yield" is added into "Workbook basis: $557K". `totalsBySpine` (`src/modules/insights/insights.logic.ts:245-256`) sums every spine-A row with a dollar figure: 151,240 + 268,930 + 7,215 + 44,880 = 472,265. That sums annual rent at risk with a valuation spread, which are different measures. It is also computed on a property whose expenses are $0 (gross rent as NOI), so the cap rate it criticises is itself overstated.
Note: filtering on `advisoryOnly` will not work, because every spine-A insight is hard-set `advisoryOnly: true` (`insights.logic.ts:224`).
*Fix:* exclude valuation/CF-family rows in `buildPriorityActionsTier` (`widgets.tsx:234-296`) and in `totalsBySpine`. Route them to Brain › Insights. The header should sum one measure only ("annual rent at risk"). This is the alarm-rationalization rule: no defined action, no alarm slot (AAMI 2017; Joint Commission NPSG.06.01.01). Touching the ranker is engine-adjacent, so run the `refute-financial-change` workflow before merging.

**2. The header total and the "Results" widget repeat the same numbers.** [V]
"Workbook basis $557K / Ledger & combined $317K" appears in the Priority Actions header and again in the Results widget (Risk impact / Monitor impact / 47 open). Two widgets give one fact, and both rest on the mixed sum in #1.
*Fix:* keep the header line and retire the Results widget, or turn it into the "held back" summary (11 items, $X) that explains what the 7-row cap is hiding.

**3. Alert-group labels misstate their band.** [V]
"12 leases expiring within 180d" holds only leases 92–151 days out, because ≤90d no-signal leases route to a different cause (`src/modules/alerts/cause-labels.ts:14`). A reader adds 6 + 12 and believes 18 leases fall inside 180 days, which happens to be true, but the label invites double counting. Expanded group children also show their global rank numbers (#2, #4, #5 … #14) inside a parent ranked #4, which reads as a broken sequence.
*Fix:* label bands exclusively ("91–180d"). Number children 1…n, or don't number them. The `ltv-ceiling` case also has an unreachable second `return` (`cause-labels.ts:31`).

**4. A lease ending today ranks as a routine expiry.** [V]
One tenant shows "expires in 0d" as child #3 of the "≤90d no renewal signal" group. Day 0 is the boundary between expiry and holdover; it is the most time-critical lease row on the page, and it sits inside a collapsed group.
*Fix:* promote leases expiring in ≤7d (including today) into their own row or into the lapsed/holdover group. Rank by days-to-act inside a group.

**5. Four different "needs attention" counts appear at once.** [V]
- TopBar bell: "Alerts (54 unread)", badge 9+.
- Worklist rail: 19.
- Overview: "47 open" / "See all 47 insights" (7 shown, 11 held back).
- Brain rail: 14.

These are different populations: unread notifications, alert tasks, ranked insights and feedback items. Nothing on screen says so. Roadmap 2.3 collapses the six list *builders*, but does not define one user-facing count.
*Fix:* give each badge a noun ("54 unread", "19 alerts", "14 to review") and make Overview's number reconcile visibly to the Worklist count, or explain the difference in the tooltip.

### P2 — Truthfulness of headline figures

**6. The NOI and cap-rate KPI tiles carry no data-quality marker.** [V]
Six of the 13 investment properties have `expenses = 0` in the live snapshot, so the Overview "Net Operating Income $3.87M · 6.9% wtd cap" includes gross rent as NOI for those assets. PR #522 (1.3) adds a `landlordCosts` flag to the Portfolio NOI *cell*, Health and the AI tools, but not to the Overview KPI tile or the cap rate under it.
*Fix:* add a small "6 of 13 props: opex not sourced" caveat chip on the NOI tile and on any cap-rate figure, with the same wording as 1.3. This labels without restating, consistent with the 10-30 ruling.

**7. Two time stamps sit side by side with no label to tell them apart.** [V]
The TopBar shows "AS OF OCT 30, 2026" (workbook `meta.asOf`, `TopBar.tsx:52-55`) next to "LIVE · updated 23m ago" (the brain server's `state.lastUpdated`, `freshness.ts:50-53`). Below 1400px wide the as-of is hidden, and below the 2xl breakpoint the age is screen-reader-only. Practice is to show the data's own timestamp and keep "ran OK" separate from "data advanced" (Basedash; Qualtrics docs).
*Fix:* "Workbook as of Oct 30 · synced 23m ago". This is cheap and complements 1.2/1.4.

**8. The NOI basis label is missing on 6 of 9 NOI surfaces.** [V — code audit]
- Labelled: Overview tile ("workbook") and Ownership ("full-asset P&L ledger").
- Unlabelled:
  - Portfolio Properties KPI and column (`PortfolioModule.tsx:35`).
  - TopBar slice readout (`PortfolioFilterBar.tsx:95`).
  - Ownership "Portfolio NOI" (`OwnershipView.tsx:401-408`).
  - Intel Property tile (`PropertyIntelView.tsx:391`).
  - Tenants "% Portfolio NOI".
  - Close "Actual NOI" (QuickBooks).

Workbook and ledger NOI therefore appear on adjacent screens with nothing telling the user which is which. This is the very defect the two-spine doctrine exists to prevent.
*Fix:* one `<BasisChip basis="workbook|ledger|qb|budget">` primitive, required by the NOI-rendering components (enforce it the way #525 made `ariaLabel` required).

**9. The ratified DSCR governor has no tile.** [V][R, premise corrected]
The KPI strip (`widgets.tsx:52-59`) has no DSCR tile, and Total Cash has no floor comparison. LTV appears only as subtext on Total Debt. Step 5 was deferred because the occupancy and WALT targets are unratified. That reason does not apply to DSCR 1.25× or LTV 40%/65%, which are protected governors already in code, or to the 8% hurdle (`intel-config.ts:44-46`, ratified).
The $1.5M cash floor was ratified 09-18 but is **not in code** (grep of `src/` and `server/`). Wiring it in is a new governor constant and needs your sign-off (invariant 4).
*Fix:* ship a DSCR bullet-graph tile now (portfolio DSCR and the weakest property against 1.25×) and make LTV a bullet against 40%. Add cash-vs-floor once the constant is approved. Bullet graphs are the standard compact form for measure-vs-target (Few, *Bullet Graph Design Specification*, Perceptual Edge, rev. 2013). Keep them neutral until breached and colour only the abnormal (ISA-101 high-performance HMI).

### P3 — Information architecture

**10. "Property Financials" and "Financials" are separate rail items.** [V]
They live at `/property-financials` and `/intel`. Per-property NOI and expenses appear in 5 places: Portfolio › Properties, Portfolio › Expenses, Financials › Property, Financials › Ownership, and Property Financials (6 views, including both a "Scorecard table" and an "Evaluation scorecard"). Market rents appear in 3 places: Leasing, Lease Market and Market › Comps. Pipeline appears in 2: Acquisitions and Capital.
*In flight:* #527 (canonical `/property/:id`) and the Explorer retirement ruling.
*Net new:* rename `/intel` to what it is ("Ownership" or "Performance"), merge the two scorecard tabs, and make Capital › Pipeline a link to Acquisitions rather than a second render.

**11. A rail destination with no data.** [V]
Property Condition renders only "The PCA extraction register has not been imported", and it holds 8 hidden views outside the 5-tab cap. Obligations › Insurance shows a column of PLACEHOLDER rows on its default view.
*Fix:* hide or demote a rail item whose source is empty (a badge-less, greyed rail entry with "no data" on hover). Collapse placeholder rows behind a "Placeholder fixtures (n)" disclosure, so the default view never leads with fake rows.

**12. Default tabs that open on empty panels.** [V]
Leasing › Rollover shows an empty "Leasing Velocity" panel (`lease_events` unpopulated), and Market's default tab is thin. Per the 09-18 IA rule ("no big table on default"), the converse also applies: no empty panel on the default tab.
*Fix:* when a panel's source table is empty, render a single-line "Not yet sourced — <how to populate>" row instead of the full chart frame.

### P4 — Design-system hygiene (visible defects)

**13. Undefined CSS tokens.** [V — verified by grep]
`--border`, `--surface`, `--surface-alt`, `--text`, `--danger` and `--warn` are referenced but defined nowhere.
- Progress-bar tracks in Capital › Allocation (`AllocationCard.tsx:18`) and Market › Scorecards (`MarketScorecard.tsx:14,34`) render transparent.
- The alert badge falls back to hard-coded `#e05c5c` on `#fff` in every theme (`AlertBell.tsx:21`).

*Fix:* map the six names to existing tokens, or replace them. Add a `check:css-tokens` step that fails on any `var(--x)` with no definition. It costs about 30 lines and belongs beside `check:dev-css`.

**14. Seven or more currency and percent formatters.** [V — code audit]
- Six separate `fmtPct` implementations exist.
- `principal-kpis.ts:15` expects 0–100, not a fraction, which is a latent unit bug.
- The same NOI reads "$4.2M" in the TopBar slice and "$4.19M" in the KPI tile.
- Minus signs mix ASCII and U+2212.

*Fix:* one `src/lib/format.ts` (compact-USD, PSF, pct, bps, date, month). Add a lint rule banning `toFixed` and `toLocaleString` in `src/modules/**`. Show the exact value on hover for compact figures.

**15. Four table implementations.** [V — code audit]
`DataTable` (about 36 files), `.pf-tbl`, inline-styled raw `<table>` (29 in 14 files) and div-row lists. Only `DataTable` has `aria-sort`, and tabular numerals are opt-in via `.num`.
*Fix:* after the chart kit lands (#531–#536), run the same "promote one, migrate the rest" pass for tables. Put `font-variant-numeric: tabular-nums` and right-alignment on numeric columns by default. Tie the density toggle that already exists in the TopBar to row height across all tables (Carbon data-table sizes: 24/32/40/48px).

**16. Raw errors and a hard-coded port reach the user.** [V — code audit]
`ModuleFallback.tsx` says "Can't reach the Brain Server (:8911)" on every failure, including the static mirror Eric uses. `error.message` is rendered raw in about 25 places.
*Fix:* one `<ErrorState>` / `<EmptyState>` primitive pair (none exists; there are about 31 ad-hoc "No … yet" strings). Plain-language message, a Retry button, and technical detail behind a disclosure.

---

## 3. In flight — keep going, no new work proposed

| Theme | Covered by |
|---|---|
| Per-card as-of chips; warehouse and overlay freshness | Roadmap 1.1/1.2, #520 merged, #523 open |
| Residence excluded; NNN landlord-cost flag | #522 |
| Chart accessible names, Sparkline text summary | #525 |
| One chart kit, PF kit promoted, `--pf-c*` retired | #531–#536 |
| Canonical property page; Explorer retires | #527, Wave B ruling 2 |
| Property-table sparkline and occupancy Δ | #529 |
| Expense $/SF matrix | #528 |
| Recorded vs reconstructed legends | #530 |
| Compact action rows with a verb plus "Open property" | Design step 4 (action-rows WIP), roadmap 2.1 |
| Six attention lists onto one builder | Roadmap 2.3 |
| Overlay write-back integrity | #526 |

---

## 4. Explicitly not recommended (conflicts with a ruling, or low ROI)

- **urgency × confidence ranking** and a **$4K floor** (10-28 prototype): ruled out on 10-29 (#506/#509).
- **Owner column, acknowledge/snooze lifecycle, Realized scoreboard:** deferred until an owner model is ratified. I also found no primary source for a snooze-lifecycle standard; ISA-18.2 "shelving" is the nearest analogue and is worth reading when this is revisited.
- **Occupancy and WALT target tiles:** targets unratified.
- **More AI narrative surfaces:** low marginal value until Wave A data lands (roadmap, "Explicitly deferred").
- **A 5–7 tab "rule":** folklore with no primary source (09-18 research). The existing `MAX_TABS_PER_DESTINATION = 5` is a house choice, not a standard.

---

## 5. Verification

- **Live:** every Overview figure quoted above was read from the running app (`/overview`, expanded groups) and `/api/snapshot`.
- **Code:** file:line citations were checked on 47013622. The undefined-token claim was re-verified by grep across all CSS, TS and HTML (0 definitions).
- **Refute pass:** an independent adversarial reviewer (Opus, read-only, no knowledge of this report's reasoning) was given claims C1–C10. Results are in §5a.

### 5a. Refute results

Of 10 claims, 9 survived and 1 was partly refuted. The reviewer re-ran the real ranking code (`buildAnalytics`, `mergeInsightSources`, `buildPriorityActionsTier`) against the live `/api/snapshot` and `/api/warehouse/insights` and reproduced $556,917 and the 47 count.

Corrections applied above:
- Finding 1: the `advisoryOnly` filter would be a no-op (every spine-A insight is advisory). Filter by family instead.
- Finding 7: "updated ago" is the server's `lastUpdated`, not the browser's fetch time.
- Finding 9: the hurdle and LTV governors are also ratified, and the $1.5M floor is not yet in code.

Not checked by the reviewer: the live badge values 54/19/14, which depend on browser read-state. They were observed live in this session.

This review does **not** satisfy `check:refute` for any later ranker change. That still needs a `refute-financial-change` run.

---

## 6. Sources (external)

- W3C, *Understanding SC 1.4.11 Non-text Contrast*, WCAG 2.2: https://www.w3.org/WAI/WCAG22/Understanding/non-text-contrast.html
- S. Few, *Bullet Graph Design Specification*, Perceptual Edge, rev. Oct 2013: https://www.perceptualedge.com/articles/misc/Bullet_Graph_Design_Spec.pdf
- B. Hollifield, "The High Performance HMI", ISA Interchange: https://blog.isa.org/the-high-performance-hmi (seen only via secondary summaries; the page returned 403)
- AAMI, alarm-management lessons, 2017: https://www.aami.org/docs/default-source/foundation/alarms/bit/2017horizons_alarm_mgt_lessons.pdf
- The Joint Commission, NPSG.06.01.01 (clinical alarm safety; published 2013, effective 2014; current status not confirmed)
- IBM Carbon, Data table guidelines and specifications: https://carbondesignsystem.com/components/data-table/guidelines/
- IBM Carbon, Data-visualization color palettes: https://carbondesignsystem.com/data-visualization/color-palettes/
- Linear docs: Custom views (https://linear.app/docs/custom-views); keyboard-shortcut help (changelog 2021-03-25)
- Addepar portal quick-start (as-of date control): https://info.addepar.com/rs/232-KUI-215/images/addepar-portal-quick-start-guide.pdf
- Yardi Investment Manager / Performance Manager product pages (marketing, undated)
- Basedash, "Data freshness"; Qualtrics dashboard data-freshness docs (practitioner sources)

**Evidence gap:** I found no public documentation of dashboard, exception or as-of patterns for MRI, Juniper Square, Dealpath, Cherre, VTS, ARGUS Intelligence, Agora or Northspyre, so no claims are made about them.
