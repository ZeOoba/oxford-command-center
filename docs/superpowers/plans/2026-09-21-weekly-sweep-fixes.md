# Weekly financial-code sweep fixes — 2026-09-21

**Objective:** close every HIGH/MEDIUM finding from the 2026-09-21 `ora-financial-code-integrity-sweep`
(workflow run `wf_32e5a654-845`, window 2026-09-14..09-21, HEAD `4525609`) with regression tests, and land it
as ONE PR carrying a `Refute-Reviewed:` trailer.

**Constraints:** never edit migration 029 (recorded by filename, no checksum — a live DB never re-applies
an edited file); never touch `data/warehouse/finance.sqlite` or `data/overlay.json`; no push to `main`; PR is
opened, not merged (repo CLAUDE.md §2: leave main integration to Gabriel); `npm run gate` green.

## Tasks

| # | Finding | Size | Change | Test that must fail first |
|---|---|---|---|---|
| 1 | HIGH `warehouse-backup.ts:66` bare `new Database` | S | open via `openWarehouseReadOnly`, clear failure on open error; `verifySnapshot` fails closed on an empty expected-table set | `tests/unit/warehouse-backup.test.ts`: empty-baseline verify is `ok:false`; script run against a missing path exits non-zero and creates no file |
| 2 | MED refute gate config files | XS | `config/**/*.json` becomes a fail-closed prefix; explicit `NON_FINANCIAL_CONFIG_PATHS` (empty) | `check-refute-required.test.ts` (costar-headers, replacement-cost.v3, acquisition-ruleset.v1) |
| 3 | MED off-fleet classifier task `-WindowStyle Hidden` | S | `register-mirror-classify-offfleet-task.ps1` builds its action via `Get-MirrorTaskArguments`; smoke test asserts EVERY `register-*-task.ps1` uses it; re-register the live task | smoke test (fails on current script) |
| 4 | MED live-warehouse migrations from readers/CLIs | M | `openWarehouseReadOnly` for `reconcile-noi-crosscheck.ts`, `server/brief/run.ts`; new `openWarehouseNoMigrate` (RW, fileMustExist, refuses pending migrations) for `seed-entity-xref.ts` and `scripts/lease-market.ts`; CI guard test: every `openWarehouse(` call site in `scripts/`+`server/` must be on a reviewed writer allow-list | guard test + db unit tests |
| 5 | MED entity-xref market label | S | resolve `property_master.market` (`Columbus OH`) to lease-market ids (`columbus`) via candidate slugs | `entity-xref.test.ts` with the real production labels |
| 6 | MED `cumulative_reduction_pct` grain mixing | M | NEW migration `032_lm_cumulative_reduction_event_chain.sql` recreates `lm_v_listing_metrics` (+ dependent `lm_v_current_spaces`) deriving the figure from the recorded price-event chain | `migration-032` test: the two reviewer repros (-0.36 -> -0.04; GROSS->NNN chain) |
| 7 | MED comp-selection tie-break on `listingId` | S | strict total order on DATA (unrounded score, distance, |SF delta|, rent, address) with `listingId` last | permutation-invariance test: 8.50-vs-11.00 repro returns identical medians in every row order |
| 8 | MED stranded `portfolio.json` | — | see report: it is a live-server byproduct, rewritten while this ran; not committed from here | — |

## Order / verification
1,2,3 independent -> 4,5 (share db.ts / entity-xref) -> 6 -> 7 -> `npm run gate` -> refute workflow on the branch
diff -> fix real defects -> trailer -> PR.

**Rollback:** every task is a separate commit; `git revert <sha>`. Migration 032 is additive (views only, no
data) and reversible by re-creating the 029 view definitions.

## File inventory
- Create: `server/warehouse/migrations/032_lm_cumulative_reduction_event_chain.sql`, `tests/unit/migration-032-*.test.ts`,
  `tests/unit/warehouse-open-sites.test.ts`
- Modify: `scripts/warehouse-backup.ts`, `server/warehouse/{backup,db,entity-xref,migrate}.ts`,
  `scripts/{check-refute-required,reconcile-noi-crosscheck,seed-entity-xref,lease-market,register-mirror-classify-offfleet-task}.ts|ps1`,
  `server/brief/run.ts`, `src/analytics/lease-market/similarity.ts`, matching tests, `architecture/{status,ownership}.json`,
  `architecture/database-schema.md`
- Must not touch: migration 029, `data/**`, `.env`, main checkout working tree.
