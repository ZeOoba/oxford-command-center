# Claude Code prompt — BUILD the Oxford Realty Advisors Command Center (future-state)

Run from the root of `design_handoff_ora_command_center/`. This is an **implementation**
directive, not a review. A companion review prompt exists in `CLAUDE_CODE_PROMPT.md`; this
one assumes the strategy is settled and tells you to **build the operating system.**

---

You are a **principal engineer + AI systems architect + CRE asset-management product lead**
building the operating system for **Oxford Realty Advisors**, a family-office-style CRE
investment company. You have the design prototype in `app/` and the full spec in
`README.md`. Your job is to turn that prototype into a working decision engine that
satisfies the twelve ownership goals below.

The Command Center exists for ONE purpose: **help ownership make better decisions faster
and scale the portfolio with minimal additional overhead.** Reporting and dashboards are
means, never the end. If something you build doesn't move that needle, cut it.

## What the prototype now includes (build on these, don't reinvent them)
The prototype has moved past front-end-only. It now models a reasoning stack you should
treat as the scaffold to make real:
- **A canonical data layer with modeled monthly history** (`app/data.js`, `window.ORA`) —
  computes all totals **and** carries a per-asset monthly series since acquisition, plus a
  first-class **property-manager (PM) entity**.
- **An attention/detection engine** (`app/engine.js` `ORA_ENGINE`, `app/trends.js`
  `ORA_TRENDS`) — ranked, $-quantified signals incl. anomaly detection over the series.
- **A global filter** (`app/filter.js`) and a **macro/briefing feed** (`app/news.js`).
- **A tax-strategy engine** (`app/tax.js`), **insurance scanner + self-insure analysis**
  (`app/ins.js`), an **OM grader against a buy box** (`app/grader.js`), and a
  **self-improving "Command Brain"** (`app/brain.js`) with a persisted feedback loop.
These are prototypes (seeded data, simulated extraction). Your job is to make them real —
back them with true feeds, document ingestion, and a learning loop — not to start over.

## Ground truth: USE THE EXISTING OXFORD COMMAND CENTER'S REAL DATA
There is **already a Claude Code–built "Oxford Command Center" codebase with Oxford's real
portfolio data.** That existing data layer is the **single source of truth** — use it.
**Do NOT use the prototype's figures** in `app/data.js`: they are seeded placeholder
pseudo-data (a mixed ~$253M / 18-asset / 4-region portfolio) and are **wrong**. Do not
hand-type a new portfolio either.

What to do instead:
- **Read the real data model first.** Before building, inspect the existing Oxford Command
  Center repo — its database / schema / entities / API / seed or fixture data — and treat
  *that* as canonical. If both this handoff and the existing codebase are in your working
  tree, the existing codebase wins on all data; this bundle is the **design + reasoning
  spec** only.
- **Map, don't replace.** The prototype's value is its *reasoning and UI contract*
  (`window.ORA` shape, computed totals, the engines, the buy box, the boards), not its
  numbers. Bind every screen and engine to the existing real entities (assets,
  units/suites, tenants, leases, **PMs**, markets, vendors, capital projects, tax bills,
  insurance policies, filed returns) so every figure ties to live data.
- **Reconcile to the real book.** AUM, NOI, occupancy, cap, LTV, premiums, property tax,
  and every derived signal must compute from the existing data — if a number can't be
  sourced from it, surface the gap rather than inventing a value.
- **Fill genuine gaps against Oxford's actual shape** (only where the existing data lacks a
  field the design needs): primarily **shallow-bay industrial & flex**, mostly **Class
  B/C**, **~600,000 SF**, **~170 tenants**, **multiple markets**, **low leverage**,
  buy-and-hold, **multiple third-party property managers**, ownership optimizing for **NOI
  growth + long-term compounding + operational leverage**. Add such fields as first-class,
  internally-consistent entities in the *existing* model, not in the prototype's.

## What's missing today (build these — they are the spine, not features)
The prototype now sketches the spine in the browser, but it is still **front-end only:
no real integrations, no document ingestion, no persistence beyond `localStorage`, no
scheduled agents.** Harden three cross-cutting systems:
1. **Data/integration layer** — the **existing Oxford Command Center data layer is
   canonical** (see Ground truth above). Bind every screen and engine to it; promote any
   remaining seeded fields to that real schema, populated by a true ETL from
   Yardi/AppFolio/Re-Leased/Buildout/Dealpath. Single source of truth: every screen reads
   from it; nothing is hand-typed. The prototype's `window.ORA` shape (PM entity, monthly
   series, computed totals) is the **contract to honor** — keep the contract, swap in the
   real source.
2. **Attention & detection engine** — `engine.js`/`trends.js` already rank $-quantified
   signals and detect anomalies in-browser. Make them run server-side every period, persist
   state, and emit alerts. This powers Overview, alerts, and briefings.
3. **AI briefing/agent layer** — replace the modeled `news.js` briefing and the `brain.js`
   simulated learning with real agents that generate daily/weekly/monthly/quarterly
   briefings and answer ownership questions from the data layer, with a genuine feedback
   loop (the prototype persists accept/dismiss; wire it to actually retrain ranking).
   **Document ingestion is real work to build:** the OM Grader currently *simulates*
   extraction — implement true PDF/OM parsing feeding `grader.js`'s buy-box rubric. Define
   each agent's purpose, inputs, outputs, triggers, and failure modes.

## Build targets — each goal is "done" only when its acceptance test passes
Implement against the existing design system (`app/ora.css`, themes, components). Reuse
patterns; add screens/modules where a goal has no home.

1. **Ownership attention engine** — Overview answers "what do I focus on today?" Ranked,
   reasoned, $-quantified items across property/tenant/PM/acquisition/ops.
   *Prototype:* `engine.js` + `Insights.html` ranked board. *Done when:* a partner opens the
   app and the top 5 things needing attention are correct, explained, and one click from the
   underlying record.
2. **NOI growth engine** — surfaces rent-gap, expense-reduction, vendor, tax/insurance,
   vacancy, collections, and retention opportunities, each with $ upside.
   *Prototype:* `tax.js`/`Taxes.html` (appeals, cost-seg, structuring) and
   `ins.js`/`Insurance.html` (re-bid, deductible/limit, self-insure) already quantify the
   tax + insurance levers. *Done when:* ownership can list every open NOI opportunity ranked
   by annualized $.
3. **Scale without hiring** — automate the repetitive (rent-roll ingest, variance flags,
   PM-report parsing, briefing generation). *Done when:* adding a property/PM/market needs
   near-zero net new manual work; document each automated step.
4. **Single source of truth** — *Done when:* every figure on every screen derives from the
   data layer and reconciles; list any remaining silo.
5. **Early problem detection** — expense spikes, delinquencies, vacancy, insurance/tax
   jumps, PM lapses, maintenance. *Prototype:* `trends.js` anomaly detection over the
   monthly series. *Done when:* each fires an alert with threshold + record the moment it's
   true in the data.
6. **Property quality ranking** — scoring + benchmarking + trend (improving/deteriorating).
   *Done when:* assets are ranked best→worst with a transparent, defensible score.
7. **Acquisition intelligence** — buy-box compliance + portfolio fit + relative quality vs.
   owned + comps. *Prototype:* `grader.js`/`Grader.html` scores OMs and the live pipeline
   against a weighted buy box with deal-breakers (extraction is simulated — make it real).
   *Done when:* a candidate gets an objective fit/quality verdict, not a bare score.
8. **Capital allocation** — *Done when:* the system answers "if I have $100k today, where
   does it go?" with ROI-ranked options (CapEx, paydown, acquisition, reserve) and rationale.
9. **PM accountability** — PM entity + scorecards: NOI growth, expense growth, collections,
   retention, work-order throughput, efficiency. *Prototype:* PM entity exists in `data.js`
   and `engine.js` flags PM-level signals; scorecards are not yet a screen. *Done when:* PMs
   are objectively ranked and each property maps to its PM.
10. **Market intelligence** — market rent/occupancy/trend + competitive set per submarket.
    *Done when:* each asset shows its rent vs. market and the submarket trend.
11. **Portfolio risk** — lease rollover, tenant/geographic/industry/expense concentration,
    CapEx exposure. *Done when:* a single risk view quantifies each concentration vs. policy.
12. **Executive briefings** — generated daily/weekly/monthly/quarterly/annual summaries.
    *Prototype:* `news.js` produces a portfolio-tied briefing; `brain.js` adds a
    self-improving meta-layer (track record, learned memory, feedback loop). *Done when:*
    ownership receives a correct briefing without searching for anything.

## Constraints & rules
- **Decisions over reporting.** Every view ends in a recommended action, not just a number.
- **Evidence + reconciliation.** No figure without a source row; nothing drifts across pages.
- **Scale test:** design so it holds at **2,000,000 SF / 500 tenants / 10 markets / 10 PMs**
  without redesign — note anything that wouldn't.
- Keep the prototype's vanilla HTML/CSS/JS unless the target codebase dictates otherwise;
  if recreating in React/etc., preserve the IA, tokens, and data-layer contract.
- Cut features that don't serve the prime directive; say what you cut and why.

## Deliver, in order
1. A **data-binding map**: how each screen and engine connects to the **existing Oxford
   Command Center data layer** (assets, tenants, leases, PMs, markets, vendors, CapEx, tax,
   insurance, returns). Reconcile computed totals to that real data; list any field the
   design needs that the existing model lacks, and add it there. **Do not ship the
   prototype's seeded figures.**
2. The three spine systems (data/integration, attention/detection, briefing/agent layer).
3. The 12 goals, each meeting its acceptance test, wired into the existing UI + any new
   screens (PM scorecards, capital allocation, risk, briefings are new).
4. A short build log: what you added, what you changed, what you cut, and any goal you
   could not fully satisfy with the reason.

Build in phases (bind to real data → spine → attention/NOI/PM/risk →
acquisition/capital/market → briefings), shipping a working slice each phase. Before writing
each module, state in one line how it helps ownership **compound NOI, decide faster, or
scale without overhead** — if you can't, don't build it.
