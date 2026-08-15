# Debt & Maturity Warehouse Module — v1 Design

**Branch:** `next5-debt-module` · **Date:** 2026-07-18 · **Origin:** N3 of next5-improvements-2026-07-18 (Gabriel-ruled) — the Intelligence Platform Master Plan's named "debt" gap.

**Status 2026-07-19: all PR #222 blocking items resolved.** Workbook column mapping confirmed by direct read (commit 53c8ea3); refi-window thresholds ratified by Gabriel ("approve as-is").

## 1. What already exists (explored first — do not duplicate)

The 06-13 master plan named debt as a gap; Phase 2 (PRs #95–#101, merged ~2026-07-10) closed most of it:

| Spec item | Already exists? | Where |
|---|---|---|
| Loans table (property, lender, balances, rate, maturity, amortization) | **Yes** | `debt_positions` (migration 009) + `writeDebtSnapshot()` (`debt-snapshot.ts`) |
| Maturity timeline | **Partially** — 4-bucket ladder | `GET /api/warehouse/debt/maturity` (`debt-api.ts`) |
| Rate type / next rate-reset | **No** — no columns, no contract fields | — |
| Per-property DSCR/LTV vs governors | **Yes** | `scoreDebtPositions()` (`debt-scoring.ts`), ratified D1/D2/D3 + F1–F5 |
| Refi-window flags (12/24-mo maturity windows) | **No** — buckets exist, no explicit window flags | — |
| Per-property LTV vs the **65% refi ceiling** | **No** (warehouse side) | 65% lives only in `src/analytics/conditions.ts` `ALERT_THRESHOLDS.ltvCeiling` (Spine A alerts) |
| Portfolio aggregate LTV vs the **40% governor** | **No** — existing code applies 0.40 per-property only | — |

v1 therefore builds only the missing four rows above, reusing the existing engine for everything else.

## 2. Governor constants — referenced, never redefined

- **DSCR 1.25 floor & LTV 0.40 ceiling:** `loadGovernors(db)` (`server/warehouse/governors.ts` → `capital-config.ts`, DB-backed with ratified compile-time fallback). No new literals.
- **65% per-property refi ceiling:** imported as `ALERT_THRESHOLDS.ltvCeiling` from `src/analytics/conditions.ts` (the codebase's single existing definition; server→`src/analytics` imports are established precedent — `server/ai/tools.ts`, `server/brief/run.ts`). No new literal.
- **12/24-month refi windows:** new v1 module constants (`REFI_WINDOW_MONTHS_NEAR = 12`, `REFI_WINDOW_MONTHS_FAR = 24`) — window definitions, not governors; no existing constant defines them. **RATIFIED by Gabriel 2026-07-19 ("approve as-is") on PR #222.**

## 3. New pieces

### 3a. Migration `023_debt_rate_reset.sql` (additive only)
- `ALTER TABLE debt_positions ADD COLUMN rate_type TEXT` — free-form workbook text ("Fixed", "Floating", …), nullable.
- `ALTER TABLE debt_positions ADD COLUMN next_rate_reset TEXT` — ISO date of next scheduled rate reset, nullable.
- Index on `(next_rate_reset, status)`.

Both columns stay **NULL — confirmed 2026-07-19, not merely unmapped.** Direct workbook inspection (full header scan of Loan Index A1:L8 and its live source `External Loans Summary` A1:AL5 — Loan Index's own A2 note: *"All metrics are live from External Loans Summary"*) found exactly one rate-related field in either sheet: **"Annual Rate."** No rate-type/structure column and no reset-date column exist anywhere in the Master Workbook today. `writeDebtSnapshot()` is correctly NOT extended to populate them — there is nothing to map. **Resolution, not open question:** if this data is wanted, it needs a new workbook column (Gabriel-added to External Loans Summary, which Loan Index would then inherit live) or a different source entirely (loan documents/term sheets). Guessing would violate Hard Invariant 7.

### 3b. `server/warehouse/debt-maturity.ts` (financial-decision code — refute pass required)
- `buildMaturityTimeline(db, asOf)` — one chronological event stream from active `debt_positions`:
  - `maturity` events (months-out recomputed fresh from `maturity_date` vs the reference date via the exported `effectiveMonthsToMaturity()` from `debt-scoring.ts` — never the stale stored column),
  - `rate-reset` events for non-null `next_rate_reset`,
  - `demand-callable` events for demand notes (callable now — sorted first, F3 spirit).
  - **Confidentiality:** no balance, rate value, or lender crosses this surface (tighter than the existing ladder, per migration-009's intent). `rate_type` (structure, not terms) is included.
- `buildRefiWindows(db, scores, asOf)` — per-property refi-window entries joining active loans with the already-computed `DebtScore[]` (no re-derivation of DSCR/LTV math):
  - `maturityWithin12mo` / `maturityWithin24mo` from the soonest **known** fresh months-to-maturity; a demand note forces both windows true (callable immediately > 12/24-mo urgency). **Nullable, not plain booleans (round 8 correction):** under a distrusted book (`bookTrust !== 'trusted'`), `/refi-windows` withholds these two fields to `null` alongside `soonestMaturityDate` / `monthsToSoonestMaturity`, since `buildRefiWindows`' maturity fields come from its own `activeLoans(db)` read, not the trust-aware scoring engine — see §3d.
  - `hasUnknownMaturity` surfaced explicitly (unknown ≠ far away, but also ≠ fabricated-near — flagged, not guessed);
  - `dscr`, `ltv` passthrough from `DebtScore` (D1 convention); `dscrFloorBreach` / `govLtvCeilingBreach` vs `loadGovernors()`; `refiLtvHeadroom` / `refiCeilingBreach` vs the 65% `ALERT_THRESHOLDS.ltvCeiling`. Unknown inputs → `null` flags, never a cleared/false verdict (F1/F2 precedent: unknown is not clearance).
- `computePortfolioAggregateLtv(db, governors)` — conservative aggregate vs the 40% governor:
  - Implied collateral value is derivable only for **single-active-loan properties with known ltv > 0** (balance ÷ ltv). Multi-loan properties are excluded — the workbook's per-loan LTV semantics for stacked loans are unconfirmed, and blending was already refute-rejected once (see C-2 note in `debt-scoring.ts`).
  - The denominator excludes unlevered-property value entirely (warehouse has no appraised values — `governors.ts` header), so this basis **overstates** LTV. Consequence: `complete`-coverage AND ≤ 40% ⇒ the true portfolio aggregate is also ≤ 40% (`clearedConservatively: true`). Anything else ⇒ `false`/`null` with an explanatory note — never a fabricated "breach" or "clear".
  - **CONFIRMED 2026-07-19** (direct workbook inspection): Loan Index's `ltv` column (I) is the live formula `='External Loans Summary'!O_` — that sheet's own header labels column O **"LTV (Balance/Value)"**, i.e. that single loan's outstanding balance ÷ that property's value (column N, "Property Value ($)"). Confirmed loan-balance/collateral-value, per-loan basis — **not** combined-debt/value. This validates the existing single-active-loan-only aggregation as the economically correct conservative choice: per-loan LTVs on a shared property aren't directly summable into a combined ratio without also re-deriving each loan's implied property value and checking they agree (which the code already tests for in the multi-loan-disagreement case and correctly excludes) — a true combined-LTV extension for multi-loan properties is a defined v2 scope item, not a blocker for v1.

### 3c. Contracts (`src/contracts/debt.ts`, additive)
`MaturityTimelineEvent/Response`, `RefiWindowEntry`, `PortfolioAggregateLtv`, `RefiWindowsResponse` (which also echoes the governor values used, read from the live set).

### 3d. API (`server/warehouse/debt-api.ts` — delivery-only, no math)
- `GET /api/warehouse/debt/timeline` → `MaturityTimelineResponse`.
- `GET /api/warehouse/debt/refi-windows` → `RefiWindowsResponse`. Calls `scoreDebtPositionsWithTrust(db, metrics, null, asOf)` inside one `db.transaction()` alongside the governors/metrics reads and `buildRefiWindows`/`computePortfolioAggregateLtv` — market rate deliberately null (no FRED dependency; the windows consume DSCR/LTV only, and a null rate merely suppresses the unused `refi` signal), keeping the route deterministic and offline-safe. The response carries a required `bookTrust`; under a distrusted book, maturity-window fields are withheld to `null` (see §3b).

### 3e. Small surgical export (`debt-scoring.ts`)
`effectiveMonthsToMaturity()` exported (with a structural `MaturityInputRow` param type) so the timeline reuses the ratified fresh-recompute + demand-note-first logic instead of duplicating date math.

## 4. What v1 does NOT do
- Does **not** ingest rate_type / next_rate_reset from the workbook — confirmed 2026-07-19 that no such columns exist in Loan Index or External Loans Summary (see §3a); the timeline emits no rate-reset events unless a future workbook change or alternate source adds this data.
- Does **not** compute a true portfolio aggregate LTV (needs appraised values for all properties, absent from the warehouse) — only the conservative-clearance estimate above.
- Does **not** compute per-loan DSCR (loan-level debt-service allocation against shared property NOI is not well-defined for stacked loans; per-property DSCR from the ratified engine is passed through instead).
- Does **not** add UI; API + contracts only.
- Does **not** modify any governor constant, the snapshot writer's filtering, or the existing `/scores` / `/maturity` routes.
