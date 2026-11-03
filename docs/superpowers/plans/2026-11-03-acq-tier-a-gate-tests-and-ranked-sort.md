# Plan: Acquisition Tier-A, TA-1 + TA-2 (2026-11-03)

Source: cc-audit-army run wf_2680ced7-eb3 → cc-eval-plan-premortem run wf_f7ce443b-288 (Tier-A targets, validator-corrected).
Base: origin/main 88b541ba. Worktree: `.claude/worktrees/ta-acq-tier-a`, branch `fix/acq-tier-a-ranked-sort-and-gate-tests`.

## Objective
TA-1 pins the untested size-price `isPortfolio` branch and the `basisVintageFloor` degenerate-ramp branch. TA-2 makes the RankedCandidateList default order match the server's `/acq/intel` ORDER BY: verdict rank (PURSUE, WATCH, PASS, KILLED), composite descending within a rank, unscored rows last.

## Constraints
No change to the ruleset, governor constants, server, contracts or migrations. Fixtures are synthetic. The gate goes green, except for the `reconcile` step that has been known red on clean main since 2026-09-25. Push and PR wait for Gabriel.

## Tasks
| # | Size | Task | Verify |
|---|---|---|---|
| 1 | XS | TA-1: `tests/unit/acquisition-gate-branches.test.ts`. Bounds read from the ruleset; bound-in-detail asserted only on failing cases; SF pinned below the cap. | 17/17 green on unchanged code; a swapped ternary fails 6 tests; `<=`→`<` in the degenerate guard fails 3 tests |
| 2 | XS | TA-2a: extract the current `sortValue` into an exported `rankedSortValue` (behavior unchanged); write `tests/unit/ranked-candidate-list-sort.test.tsx` rendering a real DataTable with it | test is RED (PASS sorts above T1) |
| 3 | XS | TA-2b: `rankedSortValue` → `verdictRank*1000 + (100 - composite)`. Verdict falls back to the tier mapped to its coherent verdict; `null` when latestScore is absent (DataTable keeps nulls last in both directions) | test GREEN; existing acquisitions-*.test.tsx green |
| 4 | — | Adversarial review (Opus subagent): ordering, nulls, desc, enum drift, server parity | no unresolved REFUTED |
| 5 | — | `npm run gate` | green, or `reconcile`-only red with the later steps proven manually |

## Desc toggle (decision)
A user-clicked desc reverses the whole key: KILLED first, lowest composite first within a rank. This is an ordinary column reversal. Unscored rows stay last in both directions.

## Files
- Create: the two test files above, this plan, and `src/modules/acquisitions/ranked-sort.ts` (the sort key lives outside the component file so react-refresh/only-export-components stays at 0 warnings).
- Modify: `src/modules/acquisitions/RankedCandidateList.tsx`.
- Must not touch: `config/**`, `server/**`, `src/contracts/**`, `server/warehouse/migrations/**`, `architecture/**`.

## Risk
UI display order only; fully reversible. Not a financial-decision engine change (the verdict is unchanged), so refute-financial-change does not apply.
