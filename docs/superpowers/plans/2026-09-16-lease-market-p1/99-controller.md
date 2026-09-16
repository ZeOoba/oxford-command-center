### Task 99: Controller-only steps (Opus 5 session — never dispatched to an implementer)

These need judgment, Gabriel's inputs, or cross-repo/governance authority.

**99.1 — Before Task 01: architecture declaration (architect-owned files)**
- [ ] Add an `architecture/status.json` entry `lease-market-intel` (schema per the file's `_schema`): `agent_role` "Engineering (Claude Code, Opus 5 controller + Sonnet 5 implementers) — Gabriel-directed in-turn 2026-09-16"; `status` `in_progress`; `review_needed: true`; `review_detail` naming every architect-owned touch: `server/warehouse/migrations/029_lease_market.sql`, `src/contracts/lease-market.ts` (new), `src/contracts/lease-forecast.ts` (provenance enum), `package.json` (2 scripts), `architecture/database-schema.md`, `architecture/status.json`; plus "Gabriel approved the design, spec rev 2, and this plan in-turn — this entry is the committed declaration for concurrent sessions (same pattern as convert-scripts-mjs-to-ts)". Only proceed once Gabriel has approved the plan in-turn.
- [ ] `npm run governance` passes; commit the entry alone.

**99.2 — Between tasks**
- [ ] After each implementer task: Opus 5 task review (spec compliance, then code quality) per superpowers:subagent-driven-development; fix findings before the next dispatch.
- [ ] Run `python ~/.claude/hooks/lib/claim_work.py renew lease-market-intel` at least every 90 minutes.

**99.3 — Header map from real CoStar samples (blocked on Gabriel's exports)**
- [ ] Read the sample files in `OneDrive - Oxford Capital Partners/Claude_Workspace/lease-market-intake/costar/` (read-only). Record the real header row verbatim.
- [ ] Fill `config/lease-market.costar-headers.json`: every `fields.*` label copied exactly; `subtypeMap`, `buildingStatusMap`, `rentBasisMap`, `subleaseValues` from the DISTINCT values present in the sample; `rentPeriodDefault` only if the export's rent column is unambiguously annual; `status: "verified"`.
- [ ] Fill each market's `costarMarketNames` from the sample's market column values.
- [ ] Re-check `thresholds.exportRowCap` against CoStar's actual export row limit as observed (a sample that stops at a round number is the tell); adjust.
- [ ] Ingest the samples into a TEMP warehouse (`WAREHOUSE_DB=<tmp>`), inspect `skipped` reasons and the rent-basis mix (quoted share), and report them to Gabriel before touching `data/warehouse/finance.sqlite`.

**99.4 — ORA property map**
- [ ] From the live snapshot (`/api/snapshot` or the rent roll), list each distinct `Lease.propertyKey` with Vacant units. For each, fill an `oraProperties` entry: `marketId`, `submarket` (from the ORA listing row in the CoStar sample, never guessed), `subtype`, `officePct`, `typicalUnitSf`, `leaseBasis` (from the lease form — confirm with Gabriel where unknown; `UNKNOWN` blocks the feed by design), `addressNorms` via `splitAddress(...)`.
- [ ] Unknown values stay out; the property then appears under "Not yet mapped" rather than with fabricated inputs.

**99.5 — Verification + adversarial pass**
- [ ] Full `npm run gate` green in the worktree.
- [ ] Fable 5.1 REFUTE pass (read-only agent, pinned `model: fable`) over: `src/analytics/lease-market/*`, `server/warehouse/lease-market/{ingest,compute,positioning,feed}.ts`, and the `marketRentGaps` change — attack: rent-basis conversion, eligibility, rollup order, below-market / stale / candidate thresholds, removal state machine, feed precedence, redaction. Fix confirmed findings; re-run gate.
- [ ] Final commit carries a trailer line `Refute-Reviewed: Fable 5.1 adversarial pass <date> — <n> findings, <m> fixed` (required by `scripts/check-refute-required.ts` for `src/analytics/` and `server/warehouse/` changes).
- [ ] Browser check: `preview_start` the command center from the worktree, open the Lease Market module with a temp warehouse seeded from the samples; screenshot freshness, distribution, positioning, signals; confirm no console errors. Stop the server afterwards.

**99.6 — Land**
- [ ] Flip the status.json entry to `review_needed` with the PR link; push `feat/lease-market-intel`; open the PR (body ends with the Claude Code attribution line). A blast-radius-adjacent PR (migrations + contracts) needs a real review verdict before merge — do not merge on bot checks.
- [ ] Release the claim: `python ~/.claude/hooks/lib/claim_work.py release lease-market-intel`.

**Deferred to later plans (not P1):** P2 CoStar Analytics + Lease Comps history into `market_series`, broker points via `market-monitor`, ORA signed rents, history + new-vs-active charts, warehouse-actual opex · P3 alert-email intake, `ora-lease-listings-intake` + `ora-lease-market-digest` tasks via `register-scheduled-task`, export reminders, LoopNet Silver activity, `lease-market-monitor` skill, signal dismissal · P4 web sweep.
