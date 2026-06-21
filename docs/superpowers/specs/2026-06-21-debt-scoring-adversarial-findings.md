# Debt Scoring Engine — Adversarial Refute Findings
**Date:** 2026-06-21
**Reviewer model:** claude-opus-4-8 (adversarial — instructed to refute)
**Reviewed file:** server/warehouse/debt-scoring.ts
**Result:** 2 CRITICAL, 2 IMPORTANT, 1 MINOR — all fixed in this commit

## [CRITICAL F1] — Refi/cash-out fire when DSCR unknown
- **Location (pre-fix):** lines 248–254 (refi branch); `isGovernorBlock` check at lines 237–239
- **Trigger:** Property has active loans, valid rate, but no full-year PeriodMetrics (noi=null → dscr=null).
- **Wrong behavior:** signal='refi' — capital-allocation recommendation with zero DSCR knowledge.
- **Fix:** Introduced `governorsClear` at line 253–255: action signals now require `dscr !== null && dscr >= governors.dscrFloor` (affirmative clearance). Unknown governor falls through to `'hold'` with an explicit reason string.

## [CRITICAL F2] — Unknown LTV silently clears LTV governor gate
- **Location (pre-fix):** lines 237–239 (`isGovernorBlock` — only fires when ltv !== null)
- **Trigger:** All loan rows have ltv=null (common when workbook LTV column is blank at snapshot time).
- **Wrong behavior:** signal='refi' or 'cash-out' despite LTV being completely unknown.
- **Fix:** `governorsClear` (line 253–255) also requires `ltv !== null && ltv <= governors.ltvCeiling`. Unknown LTV → `'hold'` with reason "Governor check incomplete — LTV unknown at snapshot time".

## [IMPORTANT F3] — Demand notes pass cash-out maturity gate
- **Location (pre-fix):** lines 219–231 (`minMonthsToMaturity` computation: `loan.months_to_maturity ?? 999`); line 260 (`(minMonthsToMaturity ?? 999) > 24`)
- **Trigger:** Demand note (months_to_maturity=null); `?? 999` treated null as "far away."
- **Wrong behavior:** Cash-out recommended on a note callable immediately — maximum maturity risk.
- **Fix:** minMonthsToMaturity computation (lines 224–238) now skips null-maturity loans entirely (they stay out of the minimum), keeping minMonthsToMaturity=null when any demand note exists. Cash-out gate (line 292–293) now requires `minMonthsToMaturity !== null && minMonthsToMaturity > 24`.

## [IMPORTANT F4] — annualDebtService=0 conflation
- **Location (pre-fix):** line 171 (`anyNonNull && sum > 0 ? sum : null`)
- **Trigger:** All payment fields null; `sum=0, anyNonNull=false` → annualDebtService=null (correct). But if payment fields were present and summed to 0, the same expression also returned null — losing the signal that debt service is legitimately zero.
- **Wrong behavior:** "fields populated but sum to zero" (paid-down loan) was silently conflated with "no payment data at all."
- **Fix:** line 177: `anyNonNull ? sum : null`. DSCR calculation at line 188 guards `annualDebtService !== null && annualDebtService > 0` separately to prevent division by zero.

## [MINOR F5] — LTV tie-break non-determinism on equal-balance tranches
- **Location (pre-fix):** lines 114–123 (`getLoansForProperty` SQL — no ORDER BY)
- **Trigger:** Two loans with equal current_balance but different ltv values; SQLite row order unspecified.
- **Wrong behavior:** Non-deterministic primary-LTV selection — identical inputs could produce different scores across runs or SQLite versions.
- **Fix:** Added `ORDER BY current_balance DESC, id ASC` at line 122. Deterministic tie-break: highest balance first, then lexicographic id for equal balances.

## [VERIFIED — could not break]
- Score clamp [0,100]: all-null case produces 50 (neutral sub-components). Cannot exceed range. ✓
- noDebtScore() score=100 satisfies Zod. ✓
- Division-by-zero: dscr guard (`annualDebtService !== null && annualDebtService > 0`) and debtYield guard (`totalBalance > 0`) prevent Infinity/NaN. ✓
- Lender suppression: DebtScore Zod and scorer never emit lender field. ✓
- Governor-block priority over cash-out/refi (known breach case): correct — isGovernorBlock check precedes governorsClear check. ✓
- Negative NOI: dscr = negative / positive = negative < dscrFloor → governor-block fires correctly. ✓
