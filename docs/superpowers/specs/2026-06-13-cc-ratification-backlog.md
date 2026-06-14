# Command Center — HUMAN-RATIFICATION-REQUIRED Backlog (2026-06-13)

> Items the autonomous audit run **deferred** (RED / governor / confidential / external) — surfaced for Gabriel's decision, never auto-executed. Produced by the unattended audit→improve run on `feat/cc-audit-hardening-20260613`. Confidential specifics redacted per invariant 3.

## RED — confidentiality (act first)

### B1 · Confidential active-deal terms committed to the repo (audit H1)
- **Where:** `src/data/seed-deals.ts` — one `confidential: true` row carries a live LOI/PSA deal's full economics + named counsel/consultant, git-tracked and pushed to `github.com/ZeOoba/oxford-command-center`.
- **Risk calibration:** repo verified **PRIVATE, single-owner** → this is a violation of the "never commit a deal term" rule, **not a public leak**. The `confidential:true` flag only drives *runtime bake redaction*; it does nothing for source/history.
- **Remediation (sequenced, fail-closed):**
  1. **I3(a)** — replace the real terms with neutral placeholders but **retain a committed stub row** `{id:'<id>', name:'[REDACTED]', confidential:true, …nulls}` so the match-by-id merge still inherits `confidential:true` even if the overlay is missing (fail-closed). Add a git-tracked-source confidentiality scan test + a redacted-bake test. **Ship the de-commit only after both tests are green.**
  2. **I3(b)** — a new **untracked, gitignored, env-pointed overlay** (`data/confidential-deals.json`) merged at runtime to inject the real terms. (Note: today there is NO overlay loader — `NOTION_CONFIDENTIAL_NAME_PATTERNS` is a name-match net, not a term injector.)
  3. **I3(c) — DECISION NEEDED:** git-history scrub vs. leave-as-is. Since the remote is private/single-owner, a scrub is **hygiene, not emergency**; the de-commit stops future exposure. History rewrite is destructive → your call.
- **Why deferred:** modifying confidential data + history rewrite are RED/destructive.

### B2 · `/api/actions/deal-comps` sends deal terms to external web search with no confidential guard (audit rank-8)
- **Where:** `server/index.ts:134-148` → `server/ai/comps.ts` (`fetchDealComps`). The route fetches the deal by id and calls `fetchDealComps` **unconditionally**; the prompt embeds `deal.name`/`location`/`estPrice` and hits Anthropic's `web_search` tool. Running comps on the confidential deal egresses its identity to live web queries.
- **Fix (small, but external-egress → ratify):** guard `if (deal.confidential) return 4xx` (or strip identifying fields) before `fetchDealComps`. Add a test asserting a confidential deal is never passed to the comps fetch.
- **Why deferred:** touches an external-egress path (invariant 1/3 surface).

## RED — governor constants (ratification-gated)

### B3 · LTV alert ceiling diverges from the governor (audit rank-9) + governor-constant pins (rank-14)
- `src/analytics/conditions.ts:15-17` — DSCR/LTV alert thresholds are not pinned to the governor (`LTV 0.40` / `DSCR 1.25`); 41–65% LTV triggers no signal. **No unilateral change** — DSCR/LTV are governor constants. Bring the alert ceiling into alignment **only on your ratification**, then add a test pinning the constants so drift is CI-caught.

### B4 · Acquisition ruleset weight ratification (master-plan A6, nine items)
- `config/acquisition-ruleset.v1.proposed.json` is correctly **un-ratified / fail-closed** (engine throws on empty `ratified`). Live acquisition scoring (firm priority #1) stays blocked until you ratify the weights/hurdles. This is a governance event the unattended run cannot resolve — see `hurdle-rate-governor-proposal` spec.

## YELLOW — financial-mechanism fixes (deferred past this run's ≤2 ceiling; each needs a written-first test + adversarial refute pass)

These are real HIGH/MED correctness bugs, scheduled in the hardened plan's phased roadmap (not this PR, to keep it one-review-sized):
- **H2** `/noi` double-counts NOI when a full-year + same-year YTD coexist — derive `noiMatrix` from `propertyPeriodMetrics` (apply `selectCoherentBatch`); mirror into the gate's NOI print. `server/warehouse/queries.ts:117-128`.
- **H3** approve-path re-resolves without the section hint → can flip a dual-side utility expense to income, mis-signing NOI. `server/warehouse/actions.ts:45-57`.
- **H5** month-end variance divides partial actuals by full budgets → phantom shortfall. `src/brain/noi-variance.ts:43-49`.
- **H6** warehouse read boundary bypasses the Zod contract layer (structural blocker for planned engines) — introduce a parsed read boundary. `src/modules/intel/analytics-hooks.ts` + `server/warehouse/api.ts`.
- **H7** `/analytics/benchmarks` rankings inconsistent vs cohorts (missing SF-less exclusion). `server/warehouse/benchmarks.ts:115-121`.

### B5 · `cappedAtT2` boolean misses floor-indeterminate when the same null input also zeroes a scorecard category (surfaced during TA-1 implementation)
- **Where:** `server/warehouse/acquisition.ts` — `cappedAtT2` flips `true` only when a deal banded T1 is then demoted. When a missing floor input (e.g. `stabilizedYoc: null`, or `allInBasis`/`replacementCostTotal: null`) *also* zeroes its scorecard category, the composite falls below the 75 T1 bar on its own, so the deal lands T2 **by band** with `cappedAtT2 = false`; the indeterminacy then surfaces **only** in `reasons` / `floors[].actual === null`.
- **Impact:** a downstream consumer keying off `cappedAtT2` alone (not scanning `reasons`/`floors`) would not see that a hard floor could not be evaluated. Observability gap, not a mis-score. **YELLOW** (financial-mechanism) — fix = set `cappedAtT2` (or a separate `floorIndeterminate` flag) whenever any floor input is null, independent of the band path; add a test. Now characterized in `tests/unit/acquisition.test.ts`.

> **Implemented THIS run (not deferred):** H4 scenario-value basis-mix (TA-2) + additive governor-surface engine/reconcile tests (TA-1). See the PR.

## Data-flywheel (the "learn from my data" goal — DESIGN-ONLY this run)
The calibration loop is **designed, not built** (learn-from-data scored 2.5/10). The closed loop is: append-only verdict log w/ `inputs_version` → outcome resolution → predicted-vs-actual measurement → a **weight re-ratification proposal that STOPS for you, never auto-applies**. Build is sequenced in the hardened plan (`docs/superpowers/plans/2026-06-13-command-center-hardened-plan.md`), gated on the confidentiality clauses (telemetry must never persist live deal terms).
