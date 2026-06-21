# Phase 3 — Forecast + Leasing Intelligence — Implementation Spec

**Author:** Lead Architect · **Date:** 2026-06-21 · **Target implementer:** Sonnet 4.6
**Roadmap line:** Phase 3 "Forecast + Leasing intelligence" (CLAUDE.md §3 — *Not started*)
**Next migration number:** `011` (010 is the last shipped: `010_debt_scores.sql`)

> **READ FIRST.** This spec is grounded in the *shipped* codebase as of `2ae0044`. Phase 3 **extends**
> a rich existing leasing layer — it does NOT reinvent it. Before writing anything, internalize §0
> (What Already Exists). Most of the "new" work is wiring existing primitives into a forecast envelope,
> a renewal-signal layer, and five new alert conditions. Do not re-parse leases, do not rebuild rollover
> math, do not add a second WALT.

---

## 0. What Already Exists (DO NOT DUPLICATE)

These are shipped and load-bearing. Phase 3 consumes them.

| Primitive | Location | What it gives you |
|---|---|---|
| `Lease` contract | `src/contracts/lease.ts` | `monthsToExpiry`, `annualRent`, `sf`, `leaseEnd`, `status`, `propertyId`, `escalationDate/Pct` |
| `RenewalStage` pipeline | `src/contracts/renewal.ts` | `['Expiring','Outreach','Negotiating','LOI','Executed']`, `nextRenewalStage`, `RenewalStageInput` |
| Overlay persistence | `server/overlay.ts` (`Overlay` interface) | `renewalStages: Record<leaseId, RenewalStage>`, `leaseRunAssumptions`, `noiBudgets`, `tenantArrears` |
| `walt`, `rolloverSchedule`, `revenueAtRisk`, `criticalDates` | `src/analytics/engine.ts` | WALT, half-year/year rollover buckets, within-90d/expired rent, notice/expiration/escalation dates |
| `RolloverBucket`, `CriticalDate`, `RevenueAtRisk` shapes | `src/analytics/types.ts` | Existing display shapes — reuse, do not redefine |
| `LeaseTerm`, `LeaseRunProjection`, `MarkToMarket` | `src/contracts/lease-run.ts` | Forward per-lease cashflow + below-market flag (NNN single-tenant v1) |
| `projectLeaseRun`, `computeMarkToMarket`, `CohortRentBenchmark` | `server/warehouse/lease-run.ts` | Per-lease forward projection + cohort mark-to-market |
| `getLeaseTerms`, `listLeaseTermPropertyIds`, `seedLeaseTerms` | `server/warehouse/lease-terms.ts` | Warehouse-side `LeaseTerm` read (migration 006 table `lease_terms`) |
| `evaluateConditions` + `ALERT_THRESHOLDS` | `src/analytics/conditions.ts` | The single canonical alert engine. Already emits `lease`-category alerts (`leaseCriticalDays:60`, `leaseWarningDays:180`) |
| `Insight` shape | `src/analytics/types.ts` | `impactAnnualUsd`, `spine`, `provenance`, `category`, `entityType`, `entityId`, `action` |
| `RenewalsModule`, `LeasesModule`, `CalendarModule`, `LeaseRunView` | `src/modules/` | Existing leasing UI surfaces to extend |
| `renewalBoard` | `src/brain/renewals.ts` | Builds the renewal kanban from snapshot + overlay |

**Two consequences:**
1. **Lease-expiration forecasting (scope item 1) and rent-roll-at-risk are ~80% done already** via `rolloverSchedule` + `revenueAtRisk` + `criticalDates`. Phase 3 adds (a) renewal-probability signals, (b) a forward rent **scenario** projection, (c) leasing-velocity, and (d) five new alert conditions.
2. **Spine discipline:** `Lease`/rollover are **Spine A** (workbook). `LeaseTerm`/`projectLeaseRun`/warehouse velocity are **Spine B** (warehouse). Never aggregate a Spine A `annualRent` with a Spine B `stabilizedNoi` without basis-matching. Every new `Insight` MUST set `spine` correctly and `provenance`.

---

## 1. Workstream Split (2–3 worktrees)

| WS | Title | Scope | Refute? |
|---|---|---|---|
| **W1** | Lease forecast engine + contracts + migration | Migration 011, `lease-forecast.ts` contract, `lease-forecast.ts` analytics (renewal-probability + velocity + rent scenarios), route sub-router, tests | **YES** — financial math |
| **W2** | Alert conditions + UI | 5 new conditions in `conditions.ts`, `LeaseForecastModule.tsx` + extensions to `RenewalsModule`/`LeasesModule`, tests | **YES** for `conditions.ts`; UI exempt |
| **W3** *(stretch)* | AI narrative leasing briefing | Leasing section in the briefing narrative pipeline (`server/ai/`, `server/brief/`) | YES if it touches scoring; otherwise narrative-only |

W1 must land before W2 (W2 imports W1 contracts + engine). W3 is independent and optional; do **not** block W1/W2 on it.

---

## 2. Data Contract (`src/contracts/lease-forecast.ts` — NEW · **architect-owned**)

New file. Mirror the `Insight`/`MarkToMarket` patterns. All money is annual USD unless suffixed. All dates ISO `YYYY-MM-DD`.

```ts
import { z } from 'zod';

// ── Expiration horizon bucket ─────────────────────────────────────────────
export const ExpiryBucket = z.enum(['0-6m', '6-12m', '12-24m', '24m+', 'expired']);
export type ExpiryBucket = z.infer<typeof ExpiryBucket>;

// ── Renewal probability signal ────────────────────────────────────────────
// DERIVED heuristic, NOT a governor. Bands, not a continuous score, to avoid
// false precision (we have tenure + stage + arrears, not a trained model).
export const RenewalLikelihood = z.enum(['likely', 'uncertain', 'at-risk', 'lapsing']);
export type RenewalLikelihood = z.infer<typeof RenewalLikelihood>;

export const RenewalSignal = z.object({
  leaseId: z.string(),
  tenantName: z.string(),
  propertyId: z.string().nullable(),
  propertyKey: z.string(),
  annualRent: z.number().nonnegative(),
  sf: z.number().nonnegative(),
  leaseEnd: z.string().nullable(),
  monthsToExpiry: z.number().nullable(),
  expiryBucket: ExpiryBucket,
  tenureMonths: z.number().nullable(),       // (asOf - leaseStart) in months; null if no leaseStart
  renewalStage: z.enum(['Expiring','Outreach','Negotiating','LOI','Executed']).nullable(), // from overlay
  arrearsUsd: z.number().nonnegative(),      // sum of overlay tenantArrears buckets; 0 when absent
  monthToMonth: z.boolean(),                 // leaseEnd in the past AND status not Expired→treated as holdover/MTM
  likelihood: RenewalLikelihood,
  // Plain-English why-string for the UI/briefing. Derived from the same inputs as `likelihood`.
  rationale: z.string(),
});
export type RenewalSignal = z.infer<typeof RenewalSignal>;

// ── Leasing velocity (Spine B; warehouse-derived) ─────────────────────────
// Per-property time-to-lease. v1 derives "days vacant→leased" from lease commencement
// gaps within the lease_terms table; where warehouse lacks vacancy history it returns
// nulls (provenance 'absent') — NEVER a fabricated number.
export const LeasingVelocity = z.object({
  propertyId: z.string(),
  propertyName: z.string(),
  medianDaysToLease: z.number().nullable(),  // null when insufficient history
  leasingEventsN: z.number().int().nonnegative(),
  slowLeasing: z.boolean(),                   // medianDaysToLease > VELOCITY_SLOW_DAYS threshold
});
export type LeasingVelocity = z.infer<typeof LeasingVelocity>;

// ── Rent forecast scenario ────────────────────────────────────────────────
export const RentScenario = z.enum(['renew_at_current', 'renew_at_market', 'vacancy_haircut']);
export type RentScenario = z.infer<typeof RentScenario>;

export const RentForecastInput = z.object({
  scenario: RentScenario,
  horizonMonths: z.union([z.literal(12), z.literal(24)]).default(12),
  // vacancy_haircut only: fraction of expiring rent assumed not to renew. 0..1.
  vacancyPct: z.number().min(0).max(1).default(0),
});
export type RentForecastInput = z.infer<typeof RentForecastInput>;

export const RentForecastResult = z.object({
  scenario: RentScenario,
  horizonMonths: z.number(),
  inPlaceAnnualRent: z.number().nonnegative(),     // today's contractual rent roll (Spine A)
  projectedAnnualRent: z.number().nonnegative(),   // rent roll at horizon under the scenario
  deltaUsd: z.number(),                            // projected - inPlace (signed)
  // NOI impact uses the impactAnnualUsd pattern: rent delta flows ~1:1 to NOI on NNN
  // (no opex offset on net leases). Stated explicitly so the UI labels it correctly.
  noiImpactAnnualUsd: z.number(),
  expiringRentInHorizon: z.number().nonnegative(), // rent exposed to the scenario
  spine: z.literal('A'),                           // workbook rent roll basis
  assumptions: z.array(z.string()),                // human-readable assumption ledger
});
export type RentForecastResult = z.infer<typeof RentForecastResult>;

// ── Market-rent gap (extends existing MarkToMarket to the lease grain) ─────
// Uses user-supplied market rents from overlay (NO external API — overlay pattern only).
export const MarketRentGap = z.object({
  leaseId: z.string(),
  tenantName: z.string(),
  propertyKey: z.string(),
  currentRentPsf: z.number().nullable(),
  marketRentPsf: z.number().nullable(),            // from overlay.marketRents; null if unset
  gapPsf: z.number().nullable(),                   // market - current
  gapAnnualUsd: z.number().nullable(),             // gapPsf * sf
  underMarket: z.boolean(),                        // current < market AND both present
  provenance: z.enum(['real', 'derived', 'absent']),
});
export type MarketRentGap = z.infer<typeof MarketRentGap>;

// ── Route envelopes ───────────────────────────────────────────────────────
export const LeaseForecastResponse = z.object({
  asOf: z.string(),
  signals: z.array(RenewalSignal),
  velocity: z.array(LeasingVelocity),
  marketGaps: z.array(MarketRentGap),
  bucketTotals: z.array(z.object({
    bucket: ExpiryBucket,
    count: z.number().int().nonnegative(),
    expiringRent: z.number().nonnegative(),
    expiringSf: z.number().nonnegative(),
  })),
});
export type LeaseForecastResponse = z.infer<typeof LeaseForecastResponse>;

export const RentForecastResponse = z.object({
  asOf: z.string(),
  results: z.array(RentForecastResult), // one per requested scenario (or all three by default)
});
export type RentForecastResponse = z.infer<typeof RentForecastResponse>;
```

**Export from `src/contracts/index.ts`** (architect-owned barrel) — add `export * from './lease-forecast';`.

**[RATIFIED] — Renewal-likelihood band thresholds.** The mapping below is a *heuristic*, not a governor,
but it drives a leasing-action signal Gabriel will act on. Ratified 2026-06-21 by Gabriel:

| Condition (first match wins) | `likelihood` |
|---|---|
| `renewalStage` ∈ {`LOI`,`Executed`} | `likely` |
| `monthToMonth` true OR (`leaseEnd` past AND no stage) | `lapsing` |
| `arrearsUsd ≥ ALERT_THRESHOLDS.arrearsMaterialUsd` AND `monthsToExpiry ≤ 12` | `at-risk` |
| `tenureMonths ≥ 36` AND `arrearsUsd == 0` AND `monthsToExpiry ≤ 12` | `likely` |
| `monthsToExpiry ≤ 6` AND `renewalStage` ∈ {null,`Expiring`} | `at-risk` |
| otherwise | `uncertain` |

**[RATIFIED] — Velocity slow threshold** `VELOCITY_SLOW_DAYS` = **60** days (proposed 120; Gabriel ratified 60 on 2026-06-21).

---

## 3. New Warehouse Analytics

Two analytics modules. **Both hold financial-decision math → both require a Refute-Reviewed trailer**
(they fall under `server/warehouse/` and are NOT in `DELIVERY_ONLY_PATHS`; see `scripts/check-refute-required.ts`).

### 3a. `src/analytics/lease-forecast.ts` (NEW — Spine A, pure, snapshot-driven)

Pure functions over `PortfolioSnapshot` + overlay-derived inputs. No DB. Mirrors `engine.ts` style.

```ts
export function bucketExpiry(monthsToExpiry: number | null, leaseEnd: string|null): ExpiryBucket
export function renewalSignals(
  leases: Lease[], asOf: string,
  renewalStages: Record<string,string>,
  arrears: Record<string,{d30:number;d60:number;d90:number;d90plus:number}>,
): RenewalSignal[]
export function marketRentGaps(
  leases: Lease[],
  marketRents: Record<string, number>,   // propertyKey|leaseId → market $/SF PSF, from overlay
): MarketRentGap[]
export function rentForecast(
  leases: Lease[], asOf: string, input: RentForecastInput,
  marketRents: Record<string, number>,
): RentForecastResult
```

- `renewalSignals`: compute `tenureMonths` from `leaseStart`; `monthToMonth` = `leaseEnd` in past AND
  status ≠ `Expired`; apply the [RATIFY] band table. **Defensive coercion** (overlay fields skip Zod on
  the live path — see MEMORY `overlay-not-reparsed-zod`): treat any non-finite arrears/stage as
  absent, never crash.
- `rentForecast` math (state in `assumptions[]`):
  - `renew_at_current`: projected = inPlace (rent roll holds). `deltaUsd = 0`.
  - `renew_at_market`: for each lease expiring within horizon, replace its `annualRent` with
    `marketRentPsf * sf` where a market rent exists; leases without a market rent hold at current.
    `noiImpactAnnualUsd = deltaUsd` (NNN, 1:1).
  - `vacancy_haircut`: `projectedAnnualRent = inPlace - (expiringRentInHorizon * vacancyPct)`.
    `noiImpactAnnualUsd = -(expiringRentInHorizon * vacancyPct)`.
- `expiringRentInHorizon`: sum `annualRent` of leases with `0 ≤ monthsToExpiry ≤ horizon`.

### 3b. `server/warehouse/lease-velocity.ts` (NEW — Spine B, DB-reading)

```ts
export function leasingVelocity(db: WarehouseDb): LeasingVelocity[]
```

- Reads `lease_terms` (migration 006) via `getLeaseTerms`/a direct query, plus the new
  `lease_events` table (migration 011 — see §6). v1 derives `medianDaysToLease` from the gap
  between a unit's prior `currentExpiry` and the next `commencement` for the same `propertyId`
  where both are known.
- **Where warehouse has no vacancy/turnover history, return `medianDaysToLease: null`,
  `leasingEventsN: 0`, `slowLeasing: false`.** Do NOT fabricate. This is the constraint: the
  warehouse currently has 2 seeded lease terms; velocity will be mostly null until `lease_events`
  is populated. That is acceptable — the contract surfaces `null` honestly.
- `slowLeasing = medianDaysToLease !== null && medianDaysToLease > VELOCITY_SLOW_DAYS`.

> **Do not re-parse leases.** Both modules consume already-parsed `Lease` (Spine A) and `LeaseTerm`
> (Spine B). No ExcelJS, no PDF, no new ingest.

---

## 4. New Alert Conditions (`src/analytics/conditions.ts` — **architect-touch**, **Refute required**)

Add to `evaluateConditions` after the existing lease block. Add the new thresholds to
`ALERT_THRESHOLDS`. Each `Insight` MUST set `category: 'lease'`, `spine`, `provenance`, and
`impactAnnualUsd`. The conditions consume `s.leases` + overlay-projected fields already on the snapshot
(`renewalStages`, `tenantArrears`) — same access pattern the collections conditions use.

New thresholds:
```ts
expiryNoSignalDays: 90,        // lease expires ≤90d with no renewal stage advance
marketRentGapWarnPct: 0.10,    // current ≥10% below market → under-market flag
lapsedHoldoverGraceDays: 0,    // leaseEnd past with no Executed stage → lapsed
velocitySlowDays: 60,          // [RATIFIED] mirror of VELOCITY_SLOW_DAYS (Gabriel ratified 60, not 120, 2026-06-21)
```

| # | Alert | Trigger | severity | impactAnnualUsd | spine / provenance |
|---|---|---|---|---|---|
| L-1 | **Expiring, no renewal signal** | `0 ≤ monthsToExpiry ≤ 3` (≤90d) AND `renewalStage` ∈ {null,`Expiring`} | `critical` | `lease.annualRent` (full rent at risk if it walks) | A / `real` |
| L-2 | **Renewal lapsed / holdover** | `leaseEnd` in past AND stage ≠ `Executed` | `warning` | `lease.annualRent` | A / `real` |
| L-3 | **Month-to-month exposure** | `monthToMonth` true (holdover, no fixed end) | `info` | `lease.annualRent` (unprotected revenue) | A / `derived` |
| L-4 | **Under-market lease** | `marketRentGap.underMarket` AND `gapPct ≥ marketRentGapWarnPct` | `info` | `gapAnnualUsd` (upside, positive) | A / `derived` |
| L-5 | **Concentrated rollover** | a single `ExpiryBucket` (`0-6m` or `6-12m`) holds ≥ `tenantNoiConcentrationInfo` (15%) of total annual rent | `warning` | sum of that bucket's `annualRent` | A / `derived` |

- L-4 fires **only** when a market rent exists in overlay for that lease/property (else `provenance:'absent'`, skip — no fabricated market rent).
- `action`: L-1/L-2 → `{ label:'Draft renewal', kind:'draft-renewal' }`; L-4/L-5 → `{ kind:'review' }`.
- Dedup: L-1 and L-2 are mutually exclusive (past vs future expiry); a holdover hits L-2/L-3 not L-1.

---

## 5. New API Routes

**New sub-router** `server/warehouse/lease-forecast-api.ts` (NEW). Mount in `server/index.ts`
(**architect-owned**) at `/api/warehouse/leasing`, mirroring the `debtApi` mounting pattern
(`app.route('/api/warehouse/debt', debtApi(getWarehouse))`).

> **Add `server/warehouse/lease-forecast-api.ts` to `DELIVERY_ONLY_PATHS`** in
> `scripts/check-refute-required.ts` (**architect-owned**) — it is a pure route-plumbing/dispatch file
> with no math (math lives in §3 modules). Mirror the `debt-api.ts` precedent. The refute trailer then
> attaches to the §3/§4 commits, not the route file.

| Method | Path | Request | Response (Zod) |
|---|---|---|---|
| `GET` | `/api/warehouse/leasing/forecast` | — | `LeaseForecastResponse` (signals + velocity + marketGaps + bucketTotals) |
| `GET` | `/api/warehouse/leasing/velocity` | — | `{ velocity: LeasingVelocity[] }` |
| `POST` | `/api/warehouse/leasing/rent-forecast` | `{ scenarios?: RentScenario[]; horizonMonths?: 12\|24; vacancyPct?: number }` (validate via `RentForecastInput`; default = all three scenarios) | `RentForecastResponse` |

Error policy (copy `debt-api.ts`): `503` when warehouse unavailable; `400` on Zod parse failure of
the POST body; `500` on unexpected engine error. The snapshot (Spine A) is fetched the same way the
existing analytics routes get it. **Confidentiality:** routes emit derived signals + rent-roll figures
for owned assets only — no confidential-deal data crosses this boundary (none is in scope).

---

## 6. Migration `011_lease_events.sql` (NEW — **architect-owned**)

Adds one table for leasing-velocity history (Spine B). Additive only; no DDL against shipped tables.

```sql
-- 011_lease_events.sql — Phase 3 leasing-velocity event log (Spine B).
-- A lease lifecycle event per (property, suite): vacate / commence. Enables days-vacant→leased.
CREATE TABLE IF NOT EXISTS lease_events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id   TEXT NOT NULL,
  suite         TEXT,                 -- null = single-tenant
  tenant        TEXT,
  event_kind    TEXT NOT NULL CHECK (event_kind IN ('vacate','commence')),
  event_date    TEXT NOT NULL,        -- ISO YYYY-MM-DD
  source_file   TEXT,                 -- provenance
  abstract_date TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS ix_lease_events_property ON lease_events (property_id, event_date);
```

- Register in `server/warehouse/migrate.ts` migration list (**architect-owned**) in order after `010`.
- **No seed required for v1.** Velocity returns `null` until events exist (§3b). A follow-up feed
  (analogous to the AR-aging feed) can populate it later — out of Phase 3 scope, note it as deferred.
- `warehouse:verify` must stay green: the fresh-tmpdir ingest runs all migrations; assert the new
  table exists and that `leasingVelocity(db)` returns `[]` (or all-null rows) on the 32-file fixture.

---

## 7. TDD Implementation Order

**W1 (worktree `phase-3-forecast-w1`):**
1. **Migration 011** + register in `migrate.ts`. Test: fresh DB has `lease_events`; `warehouse:verify` green.
2. **Contract** `src/contracts/lease-forecast.ts` + barrel export. Test: round-trip parse of each schema; reject bad enums.
3. **Analytics** `src/analytics/lease-forecast.ts` (test-first: §9 cases L-A1..L-A8) — `bucketExpiry`, `renewalSignals`, `marketRentGaps`, `rentForecast`.
4. **Analytics** `server/warehouse/lease-velocity.ts` (test-first: §9 V-1..V-4) — `leasingVelocity`.
5. **Route** `server/warehouse/lease-forecast-api.ts`; add to `DELIVERY_ONLY_PATHS`; mount in `index.ts`. Test: §9 R-1..R-5.

**W2 (worktree `phase-3-forecast-w2`, branched after W1 contracts land):**
6. **Conditions** L-1..L-5 in `conditions.ts` + thresholds (test-first: §9 C-1..C-7).
7. **UI** `LeaseForecastModule.tsx` + extend `RenewalsModule`/`LeasesModule` (§8). Test: render/shape tests only.

**W3 (optional):** 8. Leasing narrative block (§1).

Each step: write the failing test, watch it fail, implement, green. `npm run gate` green before every commit. Commit with explicit paths only.

---

## 8. UI Modules

| File | New/Extend | Display (not implementation) |
|---|---|---|
| `src/modules/leasing/LeaseForecastModule.tsx` | **NEW** | Top: four expiry-bucket cards (`0-6m`/`6-12m`/`12-24m`/`24m+`) showing count + expiring annual rent + SF. Middle: rent-forecast scenario toggle (current / market / vacancy-haircut + vacancyPct slider) showing `inPlace → projected` rent roll and `noiImpactAnnualUsd` (use `fmtUsdCompact`; label the spine). Bottom: leasing-velocity table per property (median days-to-lease; em-dash where null; amber when `slowLeasing`). |
| `src/modules/renewals/RenewalsModule.tsx` | **Extend** | Add a `likelihood` badge (`likely`/`uncertain`/`at-risk`/`lapsing`) and `tenureMonths` to each renewal card. Reuse `RenewalSignal`. Keep the existing kanban. |
| `src/modules/leases/LeasesModule.tsx` | **Extend** | Add a "vs market" column from `MarketRentGap` (gap $/SF; under-market chip). Em-dash where no market rent set. |
| `src/modules/overview/InsightList.tsx` | **No change** | Already renders any `Insight`; L-1..L-5 surface automatically. |

Register `LeaseForecastModule` in the shell module registry (UX-agent-owned `src/shell/`). Style per
ORA tokens (existing CSS vars; no new palette). Market-rent inputs are user-supplied via the overlay —
add a small inline editor that POSTs to a market-rent overlay action (mirror `advanceRenewalStage`/
`leaseRunAssumptions` overlay-write pattern); **no external API.**

> **Overlay addition:** add `marketRents: Record<string, number>` to the `Overlay` interface +
> `EMPTY_OVERLAY` + the load/validate path in `server/overlay.ts` (defensive coercion via
> `coerceNonNegMoney`, per MEMORY `overlay-not-reparsed-zod`). `server/overlay.ts` is **Refute-required**
> (it's in `isFinancialSourcePath`) — bundle this into a W1 financial commit.

---

## 9. Test Plan (vitest)

**Analytics — `src/analytics/lease-forecast.ts`** (`tests/unit/lease-forecast.test.ts`)
- **L-A1** `bucketExpiry`: 3→`0-6m`, 9→`6-12m`, 18→`12-24m`, 30→`24m+`, null/negative→`expired`.
- **L-A2** `renewalSignals`: tenure ≥36m + no arrears + ≤12m → `likely`.
- **L-A3** stage `LOI` overrides everything → `likely`.
- **L-A4** holdover (leaseEnd past, status≠Expired) → `monthToMonth:true`, `lapsing`.
- **L-A5** arrears ≥ material + ≤12m → `at-risk`.
- **L-A6** `marketRentGaps`: current 5.00, market 6.00, sf 10k → `gapPsf 1.00`, `gapAnnualUsd 10000`, `underMarket true`.
- **L-A7** `marketRentGaps`: no market rent → `provenance:'absent'`, `underMarket:false`, null gaps (no crash).
- **L-A8** `rentForecast` each scenario: `renew_at_current` delta 0; `renew_at_market` delta = sum of (market−current)×sf for in-horizon leases; `vacancy_haircut` 20% → `noiImpact = -0.2×expiringRentInHorizon`. Assert `assumptions[]` non-empty.
- **L-A9** defensive: non-finite arrears value in overlay record → coerced to 0, no throw.

**Velocity — `server/warehouse/lease-velocity.ts`** (`tests/unit/lease-velocity.test.ts`)
- **V-1** empty `lease_events` → `[]` or all-null rows; never throws.
- **V-2** two events (vacate then commence, 90d apart, same property) → `medianDaysToLease:90`, `leasingEventsN:1`.
- **V-3** median > `VELOCITY_SLOW_DAYS` → `slowLeasing:true`.
- **V-4** insufficient pairs → `medianDaysToLease:null`, `slowLeasing:false`.

**Conditions — `src/analytics/conditions.ts`** (extend `tests/unit/conditions.test.ts`)
- **C-1** ≤90d expiry, no stage → exactly one L-1, `critical`, `impactAnnualUsd = annualRent`, `spine:'A'`, `category:'lease'`.
- **C-2** ≤90d expiry but stage `LOI` → no L-1.
- **C-3** leaseEnd past, stage≠Executed → L-2 `warning`, not L-1.
- **C-4** under-market ≥10% → L-4 `info`, `impactAnnualUsd = gapAnnualUsd` (positive).
- **C-5** under-market but no market rent in overlay → no L-4.
- **C-6** one bucket ≥15% of total rent → L-5 `warning`, `impact = bucket rent`.
- **C-7** golden: full snapshot fixture → assert L-1..L-5 counts; every emitted Insight passes `Insight` shape (impactAnnualUsd present, spine set, provenance set).

**Routes — `server/warehouse/lease-forecast-api.ts`** (`tests/unit/lease-forecast-api.test.ts`)
- **R-1** `GET /forecast` → 200, body parses as `LeaseForecastResponse`.
- **R-2** `GET /velocity` → 200, `{velocity:[...]}` parses.
- **R-3** `POST /rent-forecast` default body → 200, three results.
- **R-4** `POST /rent-forecast` bad `vacancyPct:2` → 400.
- **R-5** warehouse unavailable → 503 (mock the getter to throw).

**Migration** (extend `warehouse:verify` assertions): `lease_events` table present; indexes created; `leasingVelocity` returns clean shape on the 32-file fixture.

---

## 10. Architect-Owned File Touches (flag every one)

| File | Touch | Required action |
|---|---|---|
| `src/contracts/lease-forecast.ts` | **NEW** | Set `review_needed:true` in `status.json`, state file+why, await ack before creating. |
| `src/contracts/index.ts` | barrel export | Same — architect-owned barrel. |
| `server/warehouse/migrations/011_lease_events.sql` | **NEW** | Architect-owned migrations dir. |
| `server/warehouse/migrate.ts` | register 011 | Architect-owned. |
| `server/index.ts` | mount `/api/warehouse/leasing` | Architect-owned (`server/index.ts` explicitly). |
| `scripts/check-refute-required.ts` | add route file to `DELIVERY_ONLY_PATHS` | Architect-owned (governance/refute enforcement). |
| `src/analytics/conditions.ts` | 5 new conditions + thresholds | Not in the architect-only list, but financial-decision source → **Refute required** + re-read immediately before edit (shared file; Gabriel co-develops). |
| `server/overlay.ts` | add `marketRents` | Financial-source (`isFinancialSourcePath`) → **Refute required**. |

`src/analytics/lease-forecast.ts`, `server/warehouse/lease-velocity.ts`,
`src/modules/leasing/*` are **not** architect-owned (Analytics-agent / UX-agent surfaces) — no
status.json review gate, but still post your worktree claim in `status.json`.

---

## 11. Adversarial Refute Requirement

`scripts/check-refute-required.ts` mechanically enforces this. The following commits **MUST** carry a
`Refute-Reviewed:` trailer (run `.claude/workflows/refute-financial-change.js` / the
`refute-financial-change` skill, multi-lens, before commit):

- `src/analytics/lease-forecast.ts` — **renewal-probability bands + rent-scenario NOI math feed capital/leasing decisions.** Refute lenses: (1) does `renew_at_market` overstate upside when market rents are stale/optimistic? (2) does `vacancy_haircut` double-count rent already expired? (3) is the likelihood band table mis-ranking an at-risk tenant as `likely`? (4) sign error in `noiImpactAnnualUsd`?
- `server/warehouse/lease-velocity.ts` — velocity math; refute the null-vs-fabricated boundary and the median computation on sparse data.
- `src/analytics/conditions.ts` — new alert `impactAnnualUsd` derivations; refute double-firing (L-1/L-2/L-3 overlap) and concentration-bucket math (L-5).
- `server/overlay.ts` — financial-source per the check; refute defensive coercion of `marketRents`.

**Exempt (no refute trailer):** `lease-forecast-api.ts` (once added to `DELIVERY_ONLY_PATHS`), all
`src/modules/**` UI, contract `.ts` (pure schema), `.test.ts`, migration `.sql`, this `.md`.

> Per Engineering-OS doctrine: this is financial-decision code (engine math / scoring feeding
> leasing + NOI). The refute pass is a **reviewer told to REFUTE/break the change**, not confirm it,
> and must precede the "done" claim. Reviewer model ≥ implementer; never below opus for this math.

---

## 12. Out of Scope / Deferred (state explicitly; do not build)

- **`lease_events` population feed** — table ships empty; velocity is honest-null until a feed lands (mirror the AR-aging deferral). Note in PR.
- **Trained renewal model** — v1 is a heuristic band, not ML. The `RenewalLikelihood` enum is forward-compatible with a future score.
- **External market-rent API** — explicitly forbidden by constraints; overlay-only.
- **Multi-tenant `LeaseTerm` velocity** — v1 single-tenant per `lease-run.ts` v1 scope; suite-level later.
- **W3 AI narrative** — stretch; ship W1+W2 first.

---

## Definition of Done (per CLAUDE.md §6 + Engineering-OS)

TDD (tests written first, watched to fail) · typecheck 0 · lint 0 (`--max-warnings 0`) · full vitest
green · `reconcile` + `warehouse:verify` + `governance` green · independent local code review ·
**adversarial refute pass on §11 files with trailer** · dev/preview server stopped before returning ·
no `--no-verify` · commit with explicit paths only · `status.json` updated to `merged` on merge.
