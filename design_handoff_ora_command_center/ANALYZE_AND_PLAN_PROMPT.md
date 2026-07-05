# Claude Code prompt — ANALYZE the repo, then PLAN the build to match this design

Run from the **root of `ZeOoba/oxford-command-center`**, with this
`design_handoff_ora_command_center/` folder unzipped inside it.
Copy everything below the line into Claude Code.

---

You are a **principal engineer acting as a technical lead**. Your deliverable in this
session is **a plan, not code**. Analyze this repository and the attached design handoff,
then produce a bulletproof, failure-proof, optimally sequenced plan to make the production
Oxford Command Center **match the design** in `design_handoff_ora_command_center/app/`.
Do not write feature code, do not refactor, do not "fix small things while you're in
there." Plan only.

## Non-negotiable first step
**Read `CLAUDE.md` at the repo root in full, then `architecture/system-overview.md`,
`architecture/database-schema.md`, `architecture/agent-assignments.md`, and
`architecture/coding-standards.md`.** This repo has a strict multi-agent governance
protocol (worktrees, STATUS.json, file ownership, `npm run gate`, adversarial refute for
financial changes). Your plan must operate INSIDE that protocol — it is itself the
"bulletproof" machinery this repo already uses. Any plan that ignores it is wrong.

## Verified repo facts (pre-analyzed — verify, don't rediscover)
- **Stack:** local-first React 18 + TypeScript (strict) + Vite + Tailwind v4 CSS-first
  tokens (`src/tokens/theme.css`) + Hono server on `127.0.0.1:8911` + better-sqlite3
  warehouse + Zod contracts (`src/contracts/` — the ONLY typed boundary) + TanStack Query +
  SSE + visx charts + lucide icons. No URL routing — module registry in
  `src/shell/modules.tsx` (22 modules, groups: Command / Assets / Capital / Market).
- **Two data spines** (central architectural fact): Spine A "current state" (Master
  Workbook → Zod `PortfolioSnapshot` → overlay → `buildAnalytics()` → modules) and Spine B
  "time dimension" (32 P&L files → SQLite warehouse via migrations 001–019 → analytics
  engines → Intel). Two independent NOI computations exist; **never mix bases without
  explicit tie-out** (Phase 1a basis discipline).
- **The data model lives in:** `src/contracts/` (Zod), `architecture/database-schema.md` +
  `server/warehouse/migrations/` (SQLite DDL), `server/warehouse/property-master.ts`
  (property roster). Schema changes = new numbered migration, Architect-owned.
- **Real portfolio:** ~600K SF, ~140 tenants, ~27 properties across OH/MD/IN/WI/MO/KS/TN.
  Insurance: ~24 active policies, ~$166K premium (workbook `Insurance Renewals` →
  `src/contracts/insurance.ts`, module shipped).
- **Already built (the design must bind to these, not duplicate them):**
  - **Acquisition Intelligence Engine** (Phase 4, merged): `server/warehouse/acq-engine.ts`,
    `acquisition.ts`, tables `acq_candidates`/`acq_scores`, Notion sync, IC memos.
  - **A RATIFIED buy box:** `config/acquisition-ruleset.v1.json` (v1.0, ratified
    2026-06-14) — gates ($0.5–10M single asset, ≤50K SF/building, ≥12′ clear, flood kills,
    named clusters), floors (basis discount 25–30%, stabilized YoC ≥8%, levered IRR ≥15%/5yr),
    a 7-category 100-point scorecard, bands T1 ≥75 / T2 ≥60. **This supersedes the
    prototype's inferred buy box in `app/grader.js`. Any ruleset change requires a new
    version + ratification + adversarial refute.**
  - **Real OM extraction:** `server/warehouse/om-extract.ts` + `om-extract-fields.json`
    (15 fields). The prototype's *simulated* extraction maps onto this.
  - **Calibration module** (score-vs-outcome feedback loop, migrations 005, refit scripts) —
    this is the repo's existing "learning brain."
  - Briefings + PDF, capital allocation (5-way verdict, ratified 8% hurdle), debt scoring,
    lease forecast, prospect demand, market series, anomalies/benchmarks/scores engines.
- **Genuinely missing vs. the design:** a **Taxes module** (no tax tables, no assessment /
  filed-return data anywhere), the **insurance reasoning layer** (savings scanner,
  benchmark rate, self-insure analysis, re-bid pipeline — the shipped module is a register
  only), a **Grader-style scorecard UX** over the acq engine, a **Brain-style meta UX**
  over calibration (track record, learned memory, confidence, accept/dismiss feedback), and
  the design's **ranked tier-board pattern** (no long single-column lists) as a reusable
  primitive.
- **Design-system conflict (decision point #1 — surface it, don't assume):** the repo ships
  "The Oxford Terminal" (navy/gold, EB Garamond + DM Sans + IBM Plex Mono, command/parchment
  themes). The handoff ships "Mission Control" (near-black/teal, IBM Plex Sans/Mono, three
  themes). Present both options in the plan — (a) adopt the handoff's visual system
  repo-wide, (b) implement the new capabilities inside Oxford Terminal tokens, (c) hybrid:
  adopt the tier-board/density patterns but keep Terminal tokens — with a recommendation
  and cost delta. **Get my sign-off before any restyling work is planned as committed.**

## The design target
Read `design_handoff_ora_command_center/README.md` first (spec, tokens, screens,
real-vs-modeled), then the four capability pairs (`Taxes.html`+`tax.js`,
`Insurance.html`+`ins.js`, `Grader.html`+`grader.js`, `Brain.html`+`brain.js`), then
`ora.css`/`ora.js` for the design system and tier-board pattern. The prototype's `data.js`
figures are seeded placeholders — **its shape is the contract, its numbers are fake; this
repo's data is canonical.** Where the design needs data the repo lacks (tax bills,
assessments, filed returns, loss runs, TIV/replacement cost), the plan must specify the
source document, the ingestion path (Spine A workbook tab vs. Spine B warehouse migration),
and the migration DDL — never invented values.

## Stage 1 — Verification pass (read-only)
Confirm the facts above against the current tree (they were verified 2026-07-05; Gabriel
commits constantly). Then fill the gaps I couldn't see: `src/modules/intel/` +
`src/modules/calibration/` internals, `server/warehouse/insurance-conditions.ts`,
`acq-engine.ts` scoring flow, `src/primitives/` inventory, and how `buildAnalytics()`
exposes data to modules. Note anything that changes the plan.

## Stage 2 — Gap matrix (design ↔ repo)
For each of the 18 design pages and 8 prototype engines, state: **Exists / Partial /
Missing** (with file refs), which spine feeds it, data readiness (entities/fields present
vs. needing a migration + source), design delta under each option from decision point #1,
and reuse mapping (e.g. Grader → acq-engine + om-extract; Brain → calibration + insights;
Insurance savings board → insurance contract + new conditions; tier-board → new primitive
in `src/primitives/`).

## Stage 3 — The plan
Write `IMPLEMENTATION_PLAN.md` at repo root. Requirements:
- **Phased by dependency, each phase shippable**, sized to this repo's PR conventions
  (worktree per phase, stacked PRs where needed, squash-merge, gate green at every commit).
  Expected shape (adjust from your analysis): ① tier-board + design primitives (+ the
  decision-point-#1 outcome) → ② Insurance reasoning layer on real policies → ③ Grader UX
  over acq-engine/om-extract bound to ruleset v1.0 → ④ Brain UX over calibration →
  ⑤ Taxes module (new data: migrations + ingestion + UI) → ⑥ remaining design parity.
- **Every task:** files to touch (with ownership per `agent-assignments.md` — flag
  Architect-owned files needing `review_needed: true`), design reference (page + section),
  data bindings (real entity → UI element), acceptance test (visual parity + reconciles to
  real data or surfaces the gap), estimate (S/M/L), dependencies.
- **Failure-proofing:** per phase — top risks, mitigation, rollback (this repo's §8
  protocol); which changes trigger the **adversarial refute workflow** (anything touching
  financial computation or the ruleset); which need **ratification** (buy-box or hurdle
  changes); which need new **migrations** (numbered, never edit applied ones).
- **Verification:** how design parity is checked against the prototype pages, token audit,
  the no-long-lists rule, and what vitest/playwright coverage each phase adds (gate stays
  green; 1739+ existing tests must not regress).
- **Cut list:** design elements to defer/drop with reasons (e.g. prototype pages that
  duplicate shipped modules — Financials vs. Intel, News vs. Market — recommend
  reconciliation, not duplication).
- **Decision points for me**, each with options + your recommendation: design direction
  (#1), tax data source documents, insurance benchmark source, whether Brain becomes a new
  module or extends Calibration.

## Hard rules
1. Comply with repo governance end-to-end: worktree, STATUS.json claim, ownership map,
   gate, no `--no-verify`, never touch Gabriel's uncommitted files, migrations for all DDL.
2. This repo's data is canonical; prototype numbers are fake. Bind, don't port.
3. The ratified ruleset v1.0 IS the buy box. The Grader binds to it; the prototype's
   criteria are reference UX only.
4. The plan must be executable by a fresh session with no memory of this analysis.
5. **Stop after writing the plan.** Present Stage 1–2 findings, the phase list, and the
   decision points, then wait for my approval before any implementation.

Begin with Stage 1 now.
