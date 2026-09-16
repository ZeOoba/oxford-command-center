### Task 99: Controller-only steps (Opus 5 session — never dispatched to an implementer)

**99.1 — Before Task 01: governance declaration**
- [ ] `architecture/status.json` entry `lease-market-intel`: agent_role "Engineering (Claude Code, Opus 5 controller + Sonnet 5 implementers) — Gabriel-directed in-turn 2026-09-16"; status `in_progress`; `review_needed: true`; review_detail names every architect-owned touch — `server/warehouse/migrations/029_lease_market.sql`, `src/contracts/lease-market.ts` (new), `src/contracts/lease-forecast.ts` (provenance enum), `package.json` (2 scripts), `architecture/database-schema.md`, `architecture/status.json`, `architecture/ownership.json` — and records that Gabriel approved the design, spec rev 3 and the instruction to implement in-turn (same pattern as convert-scripts-mjs-to-ts). Add the worktree to `architecture/ownership.json` in that file's existing shape. `npm run governance` passes; commit these two files alone.

**99.2 — Execution order and reviews**
- [ ] Dispatch order: 01 → 02 → 04 → 03 → 05 → 06 → 07 → 08 → 09 → 10 → 11 → 12 → 13 → 14 → 15 → 16 (04 before 03: normalize imports `medianOf`).
- [ ] After each implementer task: Opus 5 review (spec compliance, then code quality); fix before the next dispatch. Renew the claim (`claim_work.py renew lease-market-intel`) at least every 90 minutes.

**99.3 — Verification + adversarial pass**
- [ ] Full `npm run gate` green in the worktree (`warehouse:verify` uses a tmpdir; `warehouse:drift` reads the live warehouse read-only).
- [ ] Fable 5.1 REFUTE pass (read-only agent, `model: fable`) over `src/analytics/lease-market/*`, `server/warehouse/lease-market/{ingest,compute,positioning,feed}.ts`, the `marketRentGaps` change and the API redaction — attack rent-text parsing (totals, base+expense, bounds), basis conversion and opex resolution, eligibility, cell rollup, similarity scoring and fallback, confidence labels, below-market and stale rules, radar gates/score/indicative gap, event generation, two-strike removal, feed precedence, row-level redaction. Fix confirmed findings with tests; re-run the gate.
- [ ] Final commit carries `Refute-Reviewed: Fable 5.1 adversarial pass <date> — <n> findings, <m> fixed` (required by `scripts/check-refute-required.ts`).
- [ ] Browser check: `preview_start` the command center from this worktree against a TEMP warehouse seeded with test fixtures (never the live `data/warehouse/finance.sqlite`); open Lease Market; confirm KPI row, all five tabs, rent curve, radar decision round-trip, history drawer; no console errors; stop the server.

**99.4 — Land**
- [ ] Push `feat/lease-market-intel`; open the PR (body: files, tests, deferred items, the Refute trailer; ends with the Claude Code attribution line). Flip the status.json entry to `review_needed` with the PR link. Do not merge on bot checks — migrations + contracts need a real review verdict.
- [ ] Release the claim.

**99.5 — Go-live with real data (blocked on Gabriel's CoStar exports; A17 Columbus-first gate)**
- [ ] Read the sample exports in `Claude_Workspace/lease-market-intake/costar/` (read-only). Record the header row verbatim.
- [ ] Fill `config/lease-market.costar-headers.json` from the real headers and the DISTINCT values in the sample (`subtypeMap`, `buildingStatusMap`, `rentBasisMap`, `subleaseValues`, `rentPeriodDefault` only if unambiguous); set `verified`. Fill Columbus `costarMarketNames`. Check `exportRowCap` against an observed export ceiling.
- [ ] Ingest into a TEMP warehouse; report to Gabriel: rows, skipped reasons, quoted share, rejected rents, coordinate coverage, the Columbus rent curve, radar top 10 with score parts, and Rent Position for mapped vacancies. **Gabriel ratifies the ontology maps and the radar output before enabling any other market.**
- [ ] ORA property map: for each rent-roll `propertyKey` with vacant units, fill `oraProperties` (market, submarket from the ORA CoStar row, subtype, typicalUnitSf, leaseBasis from the lease form — ask Gabriel where unknown; `UNKNOWN` blocks the feed by design, addressNorms via `splitAddress`). Never guess a value; unmapped properties show as "not yet mapped".
- [ ] Then ingest into the live warehouse with `npm run lease-market:ingest` + `npm run lease-market:compute`.

**Deferred (own plans):** P2 executed comps with grades A–D and net effective rent (A5), derived monthly series incl. same-listing change (A12), CoStar Analytics history, leased-vs-withdrawn classification, map (D1), pricing elasticity (D2) · P3 alert + broker email intake (A15), weekly three-lane digest + threshold pushes (A16), export reminders, Silver activity, `lease-market-monitor` skill with NL query recipes over `lm_v_*` views · P4 web sweep · P5 hedonic model (D3).
