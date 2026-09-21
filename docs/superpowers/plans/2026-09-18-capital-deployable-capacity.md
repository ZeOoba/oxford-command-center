# Capital Deployable Capacity vs. Acquisition Pipeline

> **Status:** PLAN ONLY — sequenced AFTER IA decongestion Phases 0–3 (`2026-09-18-ia-decongestion-tabs.md`). Financial-decision code → `npm run check:refute` / `.claude/workflows/refute-financial-change.js` before merge; implementer model never below Fable. Touches Architect-owned surfaces (`src/contracts/`, `server/warehouse/`) → `review_needed: true` in `architecture/status.json` first.

## Goal
Answer "can we close everything in the pipeline?" on the Capital module: itemized reserve stack → deployable cash → per-deal equity claims → conflict flag. Today: ABSENT (`grep deployable|dry.?powder|committed capital` = 0 hits; Capital "Buy pipeline" lists T1/T2 candidates with no liquidity gate).

## Policy — ratified by Gabriel, in-session 2026-09-18
| Constant | Value |
|---|---|
| Acquisition convention | **All-cash close, refinance later** → equity per deal = 100% × all-in basis (price + closing + day-1 capex + TI/LC). Refi proceeds NEVER net against a closing requirement. |
| Firm cash floor | **$1,500,000** above all property reserves |
| Operating reserve | 3 months opex per property + next unescrowed tax/insurance installment |
| Debt-service reserve | 6 months P&I per levered property |
| Rollover reserve | leases expiring ≤12 mo: (1 − P_renew) × (6 mo downtime rent + TI/LC); P_renew default **65%** until tenant-level scores feed it |
| TI/LC defaults | per-property editable; defaults $3.00/SF TI + 6% first-term rent commission — `[SPECULATIVE]` placeholders, `estimated` provenance, PlaceholderBanner until overwritten |
| Maturity set-aside | loans maturing ≤24 mo: max(0, balloon − refi proceeds), proceeds = lesser of 65% per-property LTV ceiling and 1.25x DSCR sizing — READ governors via `server/warehouse/governors.ts`, never redefine them |
| Committed | PSA/under-contract = 100%; hard deposits 100%; approved-unspent capex 100%; LOI = 100% for the conflict flag, 50% for the probability-weighted figure; Candidate = 0% |
| Sweepable cash | entity cash × `ownershipPct`; exclude lender escrows/lockboxes |

`Deployable = sweepable cash − Σ reserves − committed − $1.5M`. Two figures always shown side by side: **hard** (conflict basis) and **probability-weighted**. Never blended.

## Build
1. `config/liquidity-policy.v1.json` (+ zod schema, `ratifiedOn: "2026-09-18"`, fail-closed `assertLiquidityPolicy`), imported through ONE path (`server/warehouse/liquidity-policy.ts`) — mirrors the governor single-import discipline. Governance check: literal `1500000`/reserve months must not appear outside it.
2. `server/warehouse/deployable-capacity.ts` — pure engine: inputs (cash entities, loans + `buildRefiWindows`, leases, opex from the warehouse on a stated basis, `acq_candidates` by stage, policy) → `{reserveStack[], committed[], deployableHard, deployableWeighted, conflicts[]}`; every line carries `Provenance`. Spine discipline: opex is Spine B, cash/loans/leases Spine A — label each line's spine; do not sum across spines without the basis note.
3. Contract `src/contracts/deployable-capacity.ts`; route `GET /api/warehouse/capital/deployable`.
4. UI: Capital module → new **Capacity** tab (after Allocation): waterfall of the reserve stack, the two deployable KPIs above the tabs, pipeline table with cumulative-claim column and a red "cannot close all" marker at the first deal that breaches; separate `[FORECAST]` **Refi recycle** card (expected proceeds + timing from recent all-cash buys) — displayed, never added to deployable.
5. Conditions: new insight `capital-pipeline-overcommitted` (critical when hard-basis claims > deployableHard) → feeds Alerts/Home.
6. Tests: TDD per reserve line; golden fixture; JV `ownershipPct` case; zero-debt property; loan with refi surplus (set-aside = 0); LOI 100/50 split; floor breach; overlay partial-record coercion (overlay is not re-parsed through Zod).

## Pre-flight failure modes
1. Cash double-count across intercompany/sweep accounts → reconcile to Cash module total.
2. Escrowed taxes/insurance counted twice (reserve + escrow) → use loan escrow flags; if unknown, flag `estimated`.
3. `acq_candidates` lacks all-in basis for early-stage deals → fall back to price, mark `estimated`, exclude from the hard conflict flag only if stage < LOI.

## Rollback
Additive only (new config, engine, route, tab). `git revert` the squash; no migration.
