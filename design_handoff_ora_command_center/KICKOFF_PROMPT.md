# Claude Code prompt — KICKOFF: wire the ORA Command Center design into the real Oxford repo

Run this from the **root of your existing Oxford Command Center repository**, with this
`design_handoff_ora_command_center/` folder unzipped inside it (e.g. `./design_handoff_ora_command_center/`).
Copy everything below the line into Claude Code.

---

You are a **principal engineer + AI systems architect** extending an existing production
codebase: the **Oxford Command Center** (a CRE investment & operations app for Oxford Realty
Advisors). This repo already holds Oxford's **real portfolio data and data model** — that is
the single source of truth for everything you build.

Inside this repo is a design handoff at `design_handoff_ora_command_center/`. It contains an
HTML **design + reasoning prototype** (in `app/`) and full specs:
- `design_handoff_ora_command_center/README.md` — architecture, screens, design tokens, the
  data/reasoning-layer contract, and a real-vs-modeled breakdown. **Read this first.**
- `design_handoff_ora_command_center/IMPLEMENTATION_PROMPT.md` — the full build directive and
  the 12 ownership goals. This kickoff sequences that work; read it before phase 2.

## Hard rules (read before writing any code)
1. **The existing repo's data is canonical. The prototype's numbers are fake.** The HTML in
   `app/` is seeded with placeholder pseudo-data (a mixed ~$253M / 18-asset portfolio) — do
   **not** ship those figures, and do **not** hand-type a new portfolio. Bind every screen
   and engine to this repo's real data layer (database / schema / API / entities).
2. **Honor the prototype's *contract*, not its data.** Its value is the reasoning logic and
   UI structure: the `window.ORA` shape, computed totals, the ranked tier-board pattern, the
   buy-box rubric, the engines. Map those onto our real entities.
3. **Build in our stack.** Recreate the designs using this repo's existing framework,
   component library, and conventions — not vanilla HTML. Preserve the IA, the design tokens
   (see README), and the data-layer contract.
4. **Reconcile or surface.** Every figure must compute from real data; if something can't be
   sourced, show the gap rather than inventing a number.
5. **Decisions over reporting.** Every view ends in a recommended, $-quantified action.

## Step 0 — orient (do this and report back before building)
- **My data model lives here:** `____________________` (e.g. `prisma/schema.prisma`,
  `db/schema.sql`, `src/models/`, or the API spec). Start there. If I left this blank,
  locate it yourself and tell me what you found before continuing.
- Map this repo: where the data model lives, what entities exist (assets, units/suites,
  tenants, leases, **property managers**, markets, vendors, CapEx, **tax bills, insurance
  policies, filed returns**), how the UI is built, and how data reaches components.
- Cross-reference against what the four new capabilities need (below). Produce a **gap list**:
  which fields/entities already exist, which are missing, and where you'd add the missing ones
  *in our model* (never in the prototype's).
- Output a short **data-binding map** + the gap list. **Pause here for my review before Phase 1.**

## Phase 1 — the four new AI capabilities, on real data (do this first)
Recreate these four prototype pages in our stack, bound to our real data. Read each
prototype page and its engine in `design_handoff_ora_command_center/app/` for intended
behavior, layout, and logic:

1. **Taxes** (`Taxes.html` + `tax.js`) — per-asset assessments vs. market, a ranked strategy
   board (appeals · cost-seg/bonus depreciation · entity & pipeline structuring), and a filed-
   return archive with AI review. Source from our real tax bills, assessments, and returns.
2. **Insurance** (`Insurance.html` + `ins.js`) — policy register + renewal calendar, a
   continuous savings scanner (re-bid · deductible/limit optimization), self-insurance /
   retention analysis (premium vs. modeled expected loss), and a re-bid pipeline. Source from
   our real policies and loss history; compute the benchmark from our own book.
3. **OM Grader** (`Grader.html` + `grader.js`) — score an offering memorandum against the
   firm's **buy box** (weighted criteria + thresholds + deal-breakers) into a 0–100 + letter
   grade, and auto-grade the live pipeline. **Implement real OM ingestion** (PDF/doc parsing →
   the buy-box rubric); the prototype only *simulates* extraction. Confirm the buy-box criteria
   in `grader.js` with me before relying on them — they're an inferred default.
4. **Command Brain** (`Brain.html` + `brain.js`) — the self-improving layer: prediction track
   record, learned-knowledge memory (confidence-tiered), confidence by market/manager, open
   data gaps, and an **accept/dismiss feedback loop that actually recalibrates ranking** and
   persists server-side (the prototype only persists to `localStorage`).

Use the shared **ranked tier-board** pattern (README → "no long single-column lists") for every
list in these pages. Ship Phase 1 as a working, reviewable slice before moving on.

## Phase 2 — the broader operating system (after Phase 1 ships)
Then execute `design_handoff_ora_command_center/IMPLEMENTATION_PROMPT.md` in full: the three
spine systems (data/integration, attention/detection, briefing/agent layer) and the 12
ownership goals, each to its acceptance test. Several already have prototype starting points
noted in that file (attention engine, NOI levers, early detection, acquisition intelligence,
PM accountability, briefings) — extend them, don't rebuild.

## Working method
- Branch: do this on `design/ai-capabilities` (or similar); keep the handoff folder out of `main`.
- Phase the work; ship a working slice at each step.
- Before writing each module, state in one line how it helps ownership **compound NOI, decide
  faster, or scale without overhead** — if you can't, don't build it.
- Keep a running **build log**: what you added, changed, cut, and any goal you couldn't fully
  satisfy, with the reason.

Start with **Step 0** and report the data-binding map + gap list. Do not write feature code
until I've reviewed it.
