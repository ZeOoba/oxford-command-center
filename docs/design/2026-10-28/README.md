# Actionable at a Glance (design review, 2026-10-28)

Claude Design handoff, built against `main@f642175`. Open `actionable-at-a-glance.html` in a browser; it loads `cc-redesign.js` from the same folder.

Extracted from the standalone bundle. The embedded `@font-face` files were left out, so the page falls back to system fonts. Sample figures and per-item urgency/confidence values in the prototype are illustrative, not data.

## Ship order in the design, and where this repo stands

| # | Change | Status |
|---|---|---|
| 1 | Rail badges | Done (PR #514). |
| 2 | Overview reorder | Partly done (#514): 7-row cap, NOI by Market / Top Tenants default-off. KPIs deliberately stay first until step 4. |
| 3 | Status consolidation | Not started. Stale snapshot must stay visible (ruling 2026-10-29). |
| 4 | Action list layout | Next. One ranked list with $ bar, due and primary verb. No owner field until an owner model is ratified. |
| 5 | Target KPI tiles | Deferred. Only DSCR 1.25x and the $1.5M cash floor are ratified; occupancy and WALT targets are not, and "NOI vs plan" needs a basis label. |
| 6 | Destination header | Depends on 4. |
| 7 | Property heatmap | Blocked on per-column thresholds. |
| 8 | Action drawer + lifecycle | Deferred (needs server-side alert state and an owner model). |

## Where the design must not be followed literally

- **Ranking.** The prototype scores `$ x urgency x confidence` with a $4K floor for unquantified items. That would rank a DSCR-floor breach below a $15K item, the bug fixed in #509, and the urgency/confidence values have no data source. The shipped order stays: pinned safety items, then dollars, then days-to-act. Confidence is excluded on purpose (#506).
- **Owner column** (GG / PM / Broker / Ops) and assign / lifecycle: deferred until an owner model is ratified.
- **Materiality floor** is $5K, global (ruling 2026-10-29), not the prototype's $4K.
- **Basis.** "NOI vs plan" must say which basis it uses; never sum workbook-basis and ledger-basis NOI.
- The design has no Profit levers widget, rent-gap row or Realized scoreboard; those were dropped from the plan on 2026-10-29.
