# Claude Code prompt — design review & pushback for the ORA Command Center

Copy everything below the line into Claude Code, run from the root of this `design_handoff_ora_command_center/` folder.

---

You are a **senior product designer and front-end architect** reviewing an existing
design prototype. Your job on this pass is **NOT to implement anything**. It is to
**review the design critically and push back with concrete suggestions.**

## Context

`app/` contains a working HTML prototype of the **ORA Command Center** — a real-estate
investment & operations dashboard for a CRE firm ("Oxford RA"). It merges the capability
surface of Yardi Voyager, Tableau, Re-Leased, AppFolio, Buildout and Dealpath into one
product. It is a **design reference**, not production code.

Read these first to understand the system before forming opinions:
- `README.md` — full spec: modules, screens, design tokens, data model, known roadmap.
- `app/ora.css` — the entire design system (tokens, components, 3 themes).
- `app/ora.js` — shared shell: injected nav rail, 3-theme cycle, tabs.
- `app/data.js` — the **single source of truth**. All figures compute from here; detail
  pages bind to `?id=`. Read this to judge whether the IA matches the data.
- `app/studio.js` — the Tableau-style cross-filtering engine.
- Open the pages in a browser (start at `app/Overview.html`). Navigate the rail. Click
  a Portfolio row → Property; a deal card → Deal Room. Toggle the theme button (cycles
  Dark → Light → Warm). Sort/search/filter the tables.
- `screens/` has dark-theme PNGs of every page (plus light & warm Overview variants) if
  you'd rather skim the visuals before opening the HTML.

The 10 screens: Overview, Portfolio, Acquisitions (Dealpath kanban), Financials (Yardi —
the priority module), Studio (Tableau cross-filter), Operations (AppFolio), Comps
(Buildout), Leases, Inbox, Insights — plus Property / Deal Room / Investor detail pages.

## What the team already knows is weak (don't just re-report these — go deeper)

A prior review flagged, and **Tier 1 has since fixed**: numbers now reconcile (one data
layer), detail pages bind to the clicked record, and tables sort/search/filter. Still
open and on the roadmap:
- **Tier 2** — visual hierarchy (every KPI shouts equally), charts outside Studio are
  static SVG with no hover/tooltip/working time-range, no target/benchmark lines.
- **Tier 3** — no global filter bar (date / region / asset-type) that propagates across
  modules; Studio cross-filter is capped at 2 dimensions; no compare mode; ⌘K is fake.
- **Tier 4** — contrast/hit-target a11y pass, keyboard nav, real photos, responsive.

## Your task

Push back. Be **brutally honest and specific** — cite the exact screen, component, file
and line where you can. Do not soften, do not pad, do not rewrite code. Deliver:

1. **Verdict** — 2–3 sentences: is this design directionally right for a CRE command
   center, or fundamentally off? Say so plainly.

2. **What's working** — only things genuinely worth keeping (be stingy).

3. **Design failures & risks** — ranked by user impact. For each:
   - the specific problem (screen + element + why it fails for the target user — a
     managing partner / asset manager / controller),
   - the evidence (what in the files/behavior proves it),
   - a **concrete design suggestion** with rationale and, where useful, a named pattern
     or reference product. Push back on *our* proposed roadmap too if you'd sequence it
     differently or think a tier is wrong.

4. **Information architecture & workflow** — does the 10-module split match how this
   user actually works? Propose merges, splits, or a different primary navigation if
   warranted. Where should "unexpected insights" actually surface?

5. **Visual design** — typography hierarchy, density, color semantics, the 3-theme
   strategy (is offering 3 themes even a good idea, or scope creep?), chart design.

6. **Prioritized recommendation** — if the team could do only the next 3 things, what
   and why. Challenge the Tier 1→4 ordering if you disagree.

## Rules of engagement

- **Review only. Write zero code and change zero files this pass.** Output is a written
  critique (markdown).
- Disagree with the existing roadmap where you have a stronger opinion — that's the point.
- Distinguish *fact* (provable from the files) from *opinion* (your design judgment) and
  label which is which.
- Prefer fewer, sharper, higher-leverage points over an exhaustive list.
- Assume a sophisticated audience; skip generic UX 101.

End with one paragraph: if this were your product, what is the single most important
change you'd make before anyone writes another line of code?
