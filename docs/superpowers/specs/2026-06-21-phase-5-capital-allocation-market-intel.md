# Phase 5 — Capital Allocation Capstone + Market Intelligence — Implementation Spec

**Author:** Lead Architect · **Date:** 2026-06-21 · **Target implementer:** Sonnet 4.6
**Roadmap line:** Phase 5 "Capital Allocation capstone + Market intelligence" (CLAUDE.md §3 — *Not started*)
**Next migration number:** `012` (the last shipped is `010_debt_scores.sql`; Phase 3 reserves `011`, so Phase 5 starts at `012` and must NOT collide with `011` even though Phase 3 is unshipped — see §5.)

> **READ FIRST.** This is the **capstone**. The Capital Allocation engine *consumes* every shipped
> scoring engine (property scores, debt scores, acquisition scores, governors, macro) and renders ONE
> comparable Buy/Hold/Sell/Refinance/Improve verdict per asset on a single risk-adjusted axis defined by
> a **new ratified hurdle-rate governor**. It builds almost nothing new in the way of raw data — it wires
> existing primitives into a comparability layer. Do NOT rebuild debt scoring, acquisition scoring,
> property scoring, governor loading, or FRED macro. Internalize §0 before writing a line.
>
> **Fail-closed discipline.** The hurdle rate is governor-class. Until Gabriel ratifies it (§16), the
> engine RUNS but stamps **every** verdict `advisoryOnly: true` and writes `advisory_only = 1` to the
> `recommendations` table. This is the single most important behavioral invariant in the phase.
>
> **Null-safe for Phase 3.** Phase 3 (forecast/leasing) is NOT shipped. The Capital Allocation engine
> accepts an OPTIONAL `forecastInputs` argument. When it is absent: no forward-return estimate is
> computed, `horizonPeriods` is `0` ("current state only"), and `confidence` is capped at `0.65`. This
> degradation is explicit and tested — never silent.

---

## 0. What Already Exists (DO NOT DUPLICATE)

These are shipped and load-bearing. Phase 5 consumes them verbatim. **All field names and signatures below are copied from the source — use them exactly.**

| Primitive | Location (absolute under repo root) | What it provides |
|---|---|---|
| `PropertyScore` | `src/contracts/warehouse.ts` | `{ propertyId, propertyName, period, health:number, healthBand, attentionBand, capitalAction, subScores, noiPerSfQuartile, benchmarkCohortSize, reasons }` |
| `HealthBand` | `src/contracts/warehouse.ts` | `z.enum(['excellent','good','watch','concern'])` |
| `AttentionBand` | `src/contracts/warehouse.ts` | `z.enum(['green','yellow','orange','red'])` |
| `CapitalAction` (4-way) | `src/contracts/warehouse.ts` (re-exported by `server/warehouse/intel-config.ts`) | `z.enum(['invest','hold','monitor','disposition-candidate'])` — single source of truth |
| `scoreProperties` | `server/warehouse/scores.ts` | `(db: WarehouseDb, metrics: PeriodMetrics[]) => PropertyScore[]` |
| `scoreBandDistribution`, `benchmarkSnapshot` | `server/warehouse/scores.ts` | distribution + benchmark snapshot (read-only refs) |
| `DebtScore` | `src/contracts/debt.ts` | `{ propertyId, propertyName, noiBasis, dscr:number\|null, dscrHeadroom:number\|null, ltv:number\|null, ltvHeadroom:number\|null, debtYield:number\|null, signal, signalReason, score:0..100, scoreBand, capitalConfigVersion }` |
| `DebtSignal` | `src/contracts/debt.ts` | `z.enum(['refi','cash-out','hold','governor-block','no-debt'])` — **note the exact members** |
| `DebtScoreBand` | `src/contracts/debt.ts` | `z.enum(['strong','adequate','watch','critical'])` |
| `scoreDebtPositions` | `server/warehouse/debt-scoring.ts` | `(db, metrics: PeriodMetrics[], marketRateFiveYearTreasury: number\|null) => DebtScore[]` |
| `AcquisitionScore` | `src/contracts/acquisition.ts` | `{ …, composite:0..100, tier, verdict, leveredIrr?…, advisoryOnly, confidence, reasons, dataQuality, dealId, ratification }` (the input `leveredIrr` lives on `AcquisitionInput`, NOT the score — see note ★) |
| `Tier` | `src/contracts/acquisition.ts` | `z.enum(['T1','T2','PASS','KILLED'])` |
| `Verdict` | `src/contracts/acquisition.ts` | `z.enum(['PURSUE','WATCH','PASS','KILLED'])` |
| `Ratification` | `src/contracts/acquisition.ts` | `z.enum(['ratified','proposed'])` — **reuse this exact pattern for `HurdleRateConfig`** |
| `RankedCandidate` | `src/contracts/acquisition.ts` | `{ candidate: AcqCandidateRow, latestScore: AcquisitionScore\|null, governorDscrCleared, governorLtvCleared, calibrationHitRate, scoredAt }` |
| `ClusterTier` | `src/contracts/acquisition.ts` | cluster enum used by acquisition + market intel (import from here; do NOT redefine) |
| `scoreAcquisition` | `server/warehouse/acquisition.ts` | `(rawInput: AcquisitionInput, ruleset, opts?) => AcquisitionScore` |
| `loadGovernors` / `Governors` / `GOVERNOR_DEFAULTS` | `server/warehouse/governors.ts` (re-export of `capital-config.ts`) | `loadGovernors(db) => CapitalConfigRow`; `Governors = CapitalConfigRow` |
| `CapitalConfigRow` | `server/warehouse/capital-config.ts` | `{ version, effectiveFrom, dscrFloor:1.25, ltvCeiling:0.40, dispositionCapRate:0.065, holdCapRate:0.075, acqIrr:0.12, capexIrr:0.15, refiTriggerBps:150, payoutPct, notes }` |
| `loadCapitalConfig` | `server/warehouse/capital-config.ts` | `(db) => CapitalConfigRow` — reads latest `capital_config` row, falls back to `CAPITAL_CONFIG` const |
| `capital_config` table | `server/warehouse/migrations/003_capital_config.sql` | governor table — Phase 5 **adds columns** here (§10) |
| `PeriodMetrics` / `propertyPeriodMetrics` | `src/contracts/warehouse.ts` (type) · `server/warehouse/metrics.ts` (fn) | `propertyPeriodMetrics(db) => PeriodMetrics[]`; metrics carry `noi`, `noiPerSf`, `revenue`, `rentableSf`, `period`, `propertyId`, `propertyName`, etc. |
| `growthSeries` | `server/warehouse/growth.ts` | trailing growth series → use for NOI CAGR (hold/improve return) |
| `rankProperties` / `benchmarkMetric` / `portfolioQuartiles` | `server/warehouse/benchmarks.ts` | benchmark math → portfolio NOI/SF median for `improve` trigger |
| `detectAnomalies` | `server/warehouse/anomalies.ts` | anomaly engine (read-only ref) |
| `getMacro` | `server/macro/getMacro.ts` | `() => Promise<MacroSnapshot>` — **always succeeds** (live FRED → seeded fallback). Gives T-10, T-5, Fed Funds, etc. Use THIS, not `fetchFredMacro` (which can return null). |
| `fetchFredMacro` | `server/macro/fred.ts` | `() => Promise<MacroSnapshot\|null>` — lower-level; prefer `getMacro` |
| `fetchDealComps` / `CompSet` | `server/ai/comps.ts` · `src/contracts/comps.ts` | `fetchDealComps(deal, opts) => Promise<FetchCompsResult>`; `CompSet = { saleComps, rentComps, submarketStats, summary, sources, sourcedAt }`. **There is NO `AgentCompResult` type and NO `server/warehouse/comps.ts`.** Market intel reads cached comp values from `market_series`, not from a live comps call. |
| `loadCapitalConfig`/calibration verdict log | `server/warehouse/calibration.ts` | `logVerdicts(db, verdicts: CalibrationVerdict[], opts?) => { written, skipped, error? }` — fail-open, idempotent via dedup_key. `verdictsFromScores` already emits `verdictKind: 'capital-action'`. |
| `CalibrationVerdict` | `src/contracts/warehouse.ts` | `{ subjectKind, subjectId, verdictKind, verdictSubkind, verdictEngine, predictedBand, predictedValue, predictedUnit, confidence, direction, reasons, asOfPeriod, horizonPeriods:int positive\|null, inputsVersion:length16, emittedBy }` |
| `computeInputsVersion` | `server/warehouse/calibration.ts` | produces the 16-char `inputsVersion` fingerprint — reuse for recommendation rows |
| `seedPropertyMaster` | `server/warehouse/property-master.ts` | `(db) => void` — seeds `property_master` from `CANON_PROPERTIES`. **NOTE: there is no `getPropertyMaster()` today** — §9 introduces the read helper. |
| `Confidence` | `src/contracts/common.ts` | `z.enum(['confirmed','estimated','derived'])` — **categorical, not numeric.** See ★★ below. |
| `DataQualityFlag` | `src/contracts/common.ts` | `{ entity, field, issue, rawValue?, severity:'info'\|'warn'\|'error' }` |
| `debtApi` (router pattern) | `server/warehouse/debt-api.ts` | the exact Hono `(getDb)=>Hono` + `withDb`/503/500 pattern to mirror |
| `MODULES` registry | `src/shell/modules.tsx` | `ModuleDef[]` with `{ id, label, icon, group, Component }`; groups `'Command'\|'Assets'\|'Capital'\|'Market'`; lazy import pattern |
| `MarketModule` | `src/modules/market/MarketModule.tsx` | existing FRED rate widget — Phase 5 **extends**, does not replace |
| `DebtModule` / `ScorecardView` | `src/modules/debt/` | UI conventions to mirror for the Capital module |

> **★ `leveredIrr` location.** `leveredIrr` is a field on **`AcquisitionInput`** (`z.number().nullable()`), not
> on `AcquisitionScore`. The Capital Allocation `buy` path therefore reads `leveredIrr` from the
> `RankedCandidate.latestScore` only if the engine has persisted it onto the score; in practice Phase 5
> reads the candidate's stored input IRR. To avoid a fragile dependency, §3 reads `leveredIrr` from the
> `acquisition_scores`/`acq_candidates` join the acquisition engine already persists (the `RankedCandidate`
> shape), and treats it as **`number | null`** — null IRR ⇒ no `buy` return estimate, never a fabricated one.
>
> **★★ `Confidence` is categorical** (`confirmed`/`estimated`/`derived`), but the Phase 5 contract needs a
> *numeric* confidence (the spec text references caps like `0.65`/`0.6`). To avoid overloading the shipped
> enum, Phase 5 introduces a **numeric `confidence01`** field (`z.number().min(0).max(1)`) on its own
> contracts AND a categorical `confidenceTier: Confidence` for display parity. Both are populated. Tests
> assert on `confidence01`. Do NOT redefine or widen `Confidence`.

**Two consequences:**
1. **Spine discipline (CLAUDE.md §1).** `PropertyScore`/`PeriodMetrics`/`DebtScore` are **Spine B** (warehouse). The acquisition pipeline is its own lane. The Capital Allocation engine is a **Spine B consumer** — it never reaches into Spine A (`PortfolioSnapshot`). It never reconciles a Spine A `Property.noi` against a Spine B ledger NOI. Every verdict's basis is the warehouse NOI basis already carried on `DebtScore.noiBasis` / `PeriodMetrics`.
2. **No new raw data.** Market intel reads **cached** rows from the new `market_series` table (§4) plus `getMacro()`. It does NOT call `fetchDealComps` on the hot path (that is an AI/egress call with confidential-deal guards) — comps land in `market_series` via manual/seeded inserts in v1 (§15 deferral).

---

## 1. Workstream Split (4 worktrees)

| WS | Worktree name | Title | Scope | Depends on | Refute? |
|---|---|---|---|---|---|
| **W1** | `phase-5-capital-w1` | Capital Allocation Engine + Market Intelligence (financial core) | Migrations 012+013(+014 governor cols), `src/contracts/capital.ts`, `server/warehouse/market-intel.ts`, `server/warehouse/capital-allocation.ts`, `server/warehouse/capital-allocation-api.ts`, governor extension in `capital-config.ts`/`governors.ts`, `intel-config.ts` hurdle field, calibration `capital-action-v2` extension, all engine/route/contract tests | — | **YES** — engine + market math + governor |
| **W2** | `phase-5-capital-w2` | Capital Allocation UI | `src/modules/capital/{CapitalModule,AllocationCard,HurdleRateBanner}.tsx`, register in `src/shell/modules.tsx`, render/shape tests | **W1 contracts** (`capital.ts` must land first) | UI exempt |
| **W3** | `phase-5-market-w3` | Market Intelligence UI | extend `src/modules/market/MarketModule.tsx` + new `src/modules/market/MarketScorecard.tsx`, render tests | **W1 contracts** (`MarketSignal`/`MarketIntelResponse`); runs **parallel to W2** | UI exempt |
| **W4** | `phase-5-onboarding-w4` | Data-driven property onboarding | `server/warehouse/property-onboarding.ts`, read-helper `getPropertyMaster()` in `property-master.ts`, `POST /api/warehouse/properties/onboard` mount in `server/index.ts`, small admin UI in `src/modules/intel/`, tests | **independent** (only touches `property_master`) | onboarding write-path is data plumbing → **no refute** unless it computes scoring (it does not); BUT it touches `property-master.ts` which is *not* in `DELIVERY_ONLY_PATHS` → see §6/§11 |

**Ordering law:** W1 lands `src/contracts/capital.ts` + the engines first. W2 and W3 branch from W1's merged contracts (or its branch if stacking — §7 of CLAUDE.md). W4 is fully independent and can start immediately. Do **not** block W4 on W1.

---

## 2. Data Contracts (`src/contracts/capital.ts` — NEW · **architect-owned**)

New file. All money is annual USD unless suffixed `Pct` (decimal fraction, `0.08` = 8%). All dates ISO `YYYY-MM-DD`. Mirror the `AcquisitionScore`/`Ratification` patterns.

```ts
import { z } from 'zod';
import { Confidence, DataQualityFlag } from './common';
import { AttentionBand, HealthBand } from './warehouse';
import { ClusterTier, Ratification } from './acquisition';

// ── Allocation action (5-way; supersedes the 4-way CapitalAction for verdicts) ──
// NOT a redefinition of CapitalAction — that 4-way enum stays the property-score
// recommendation. AllocationAction is the capstone decision axis.
export const AllocationAction = z.enum(['buy', 'hold', 'sell', 'refinance', 'improve']);
export type AllocationAction = z.infer<typeof AllocationAction>;

// ── Risk band (derived from attentionBand + debtScore.scoreBand) ────────────────
export const RiskBand = z.enum(['low', 'moderate', 'elevated', 'high']);
export type RiskBand = z.infer<typeof RiskBand>;

// ── Hurdle-rate governor (ratified-vs-proposed; same shape law as AcquisitionRuleset.ratification) ──
export const HurdleRateConfig = z.object({
  hurdleRatePct: z.number().min(0).max(1),        // unlevered IRR fraction; proposed default 0.08
  ratification: Ratification,                      // 'ratified' | 'proposed'
  ratifiedBy: z.string().nullable().default(null), // 'Gabriel Goldberg' when ratified
  ratifiedDate: z.string().nullable().default(null),
  capitalConfigVersion: z.number().int(),          // ties to the capital_config row it loaded from
});
export type HurdleRateConfig = z.infer<typeof HurdleRateConfig>;

// ── Per-asset allocation verdict ────────────────────────────────────────────────
export const AllocationVerdict = z.object({
  propertyId: z.string(),
  propertyName: z.string().nullable(),
  period: z.string(),                              // asOf period token (mirrors PropertyScore.period)
  action: AllocationAction,
  // Annualized UNLEVERED return for the recommended action, made comparable to hurdle.
  // null when undrivable (e.g. improve with no capex IRR, buy with null leveredIrr).
  expectedReturnPct: z.number().nullable(),
  returnAboveHurdle: z.boolean().nullable(),       // expectedReturnPct >= hurdle; null when expectedReturnPct null
  riskBand: RiskBand,
  timelineMonths: z.number().int().nonnegative(),  // recommended action horizon
  horizonPeriods: z.number().int().nonnegative(),  // 0 when forecast inputs absent ("current state only")
  confidence01: z.number().min(0).max(1),          // numeric confidence (see ★★ in §0)
  confidenceTier: Confidence,                      // categorical mirror for display
  advisoryOnly: z.boolean(),                        // true when hurdleConfig.ratification === 'proposed'
  reasons: z.array(z.string()),                    // ordered, first reason = primary trigger
  // Carry the consumed signals so the UI can show provenance without re-fetching.
  inputs: z.object({
    healthBand: HealthBand,
    attentionBand: AttentionBand,
    capitalAction: z.enum(['invest','hold','monitor','disposition-candidate']),
    debtSignal: z.enum(['refi','cash-out','hold','governor-block','no-debt']),
    debtScoreBand: z.enum(['strong','adequate','watch','critical']),
    dscr: z.number().nullable(),
    dscrHeadroom: z.number().nullable(),
    ltv: z.number().nullable(),
    noiPerSf: z.number().nullable(),
    forecastPresent: z.boolean(),                  // false until Phase 3 wires forecastInputs
  }),
  dataQuality: z.array(DataQualityFlag).default([]),
});
export type AllocationVerdict = z.infer<typeof AllocationVerdict>;

// ── Portfolio-wide ranked allocation ────────────────────────────────────────────
export const PortfolioAllocation = z.object({
  asOf: z.string(),
  hurdleRatePct: z.number(),
  advisoryOnly: z.boolean(),                        // top-level mirror; true if ANY verdict is advisory
  verdicts: z.array(AllocationVerdict),            // ranked (attentionBand priority DESC, expectedReturnPct DESC)
  actionCounts: z.record(AllocationAction, z.number().int().nonnegative()),
  // Pipeline candidates surfaced for the portfolio-level `buy` recommendation.
  pipeline: z.array(z.object({
    candidateId: z.string(),
    address: z.string().nullable(),
    market: ClusterTier.nullable(),
    composite: z.number().nullable(),              // AcquisitionScore.composite
    tier: z.enum(['T1','T2','PASS','KILLED']).nullable(),
    leveredIrr: z.number().nullable(),
    basisDiscountPct: z.number().nullable(),       // (replacementCost - allInBasis)/replacementCost when present
  })),
});
export type PortfolioAllocation = z.infer<typeof PortfolioAllocation>;

// ── Market intelligence ─────────────────────────────────────────────────────────
export const MarketAction = z.enum(['enter', 'expand', 'maintain', 'exit']);
export type MarketAction = z.infer<typeof MarketAction>;

export const MarketSourceTag = z.enum(['fred', 'census-acs', 'comps-ai', 'composite']);
export type MarketSourceTag = z.infer<typeof MarketSourceTag>;

export const MarketSignal = z.object({
  cluster: z.string(),                             // ClusterTier value (string-tolerant for unknown clusters)
  asOf: z.string(),
  marketScore: z.number().min(0).max(100).nullable(), // null when no data at all
  action: MarketAction,                            // 'maintain' is the safe default when score null
  confidence01: z.number().min(0).max(1),          // weighted source confidence; 0 when no data
  confidenceTier: Confidence,
  advisoryOnly: z.literal(true),                   // market scores are ALWAYS advisory in Phase 5
  oraPropertyCount: z.number().int().nonnegative(),// ORA properties already in this cluster
  sources: z.array(z.object({
    source: MarketSourceTag,
    metric: z.string(),                            // 'cap_rate' | 'pop_growth' | 'vacancy_pct' | 'rent_psf' | 'score'
    value: z.number().nullable(),
    confidence01: z.number().min(0).max(1),
    asOf: z.string(),
    stale: z.boolean(),                            // true when source older than staleness window
  })),
  reasons: z.array(z.string()),
  dataQuality: z.array(DataQualityFlag).default([]),
});
export type MarketSignal = z.infer<typeof MarketSignal>;

// ── Route envelopes ─────────────────────────────────────────────────────────────
export const CapitalAllocationResponse = z.object({
  asOf: z.string(),
  hurdleRate: HurdleRateConfig,
  advisoryOnly: z.boolean(),
  portfolio: PortfolioAllocation,
});
export type CapitalAllocationResponse = z.infer<typeof CapitalAllocationResponse>;

export const MarketIntelResponse = z.object({
  asOf: z.string(),
  signals: z.array(MarketSignal),
});
export type MarketIntelResponse = z.infer<typeof MarketIntelResponse>;
```

**Barrel export** — add `export * from './capital';` to `src/contracts/index.ts` (architect-owned). It already follows this pattern (`export * from './debt';`). Place after `./debt`.

**[RATIFY] — Hurdle rate.** Proposed default `hurdleRatePct: 0.08` (8.0% unlevered IRR), `ratification: 'proposed'`. The engine emits verdicts but every one is `advisoryOnly: true` until Gabriel ratifies (§16).

**[RATIFY] — Risk-band derivation matrix** (first match wins, on `(attentionBand, debtScoreBand)`):

| attentionBand | debtScoreBand | riskBand |
|---|---|---|
| `red` | `critical` or `watch` | `high` |
| `red` | any | `elevated` |
| `orange` | `critical` | `high` |
| `orange` | any | `elevated` |
| `yellow` | `critical` or `watch` | `elevated` |
| `yellow` | any | `moderate` |
| `green` | `critical` | `elevated` |
| `green` | `watch` | `moderate` |
| `green` | `strong` or `adequate` | `low` |

**[RATIFY] — Market action band thresholds** (proposed): `enter` ≥ 75, `expand` ≥ 65, `maintain` ≥ 45, `exit` < 45. Modulated by ORA property count (§4).

---

## 3. Capital Allocation Engine (`server/warehouse/capital-allocation.ts` — NEW · **Refute required**)

Pure-ish module: reads only what is passed plus the DB handle for the pipeline join. No ExcelJS, no network. Mirrors `debt-scoring.ts` style.

### 3.0 Imports & types

```ts
import type { WarehouseDb } from './db';
import type { PeriodMetrics } from '../../src/contracts/warehouse';
import type { PropertyScore } from '../../src/contracts/warehouse';
import type { DebtScore } from '../../src/contracts/debt';
import { growthSeries } from './growth';
import { portfolioQuartiles } from './benchmarks';
import {
  HurdleRateConfig,
  AllocationVerdict,
  PortfolioAllocation,
  CapitalAllocationResponse,
  AllocationAction,
  RiskBand,
} from '../../src/contracts/capital';

// Phase-3 forecast inputs are NOT yet shipped. This is the null-safe stub shape the engine
// accepts now; Phase 3 will populate it. Keep it minimal and forward-compatible.
export interface ForecastInputs {
  // propertyId -> forward NOI CAGR fraction over the forecast horizon
  forwardNoiCagrByProperty: Record<string, number>;
  horizonPeriods: number; // > 0 when present
}

// Pipeline candidate already ranked by the acquisition lane (RankedCandidate-shaped subset).
export interface PipelineCandidate {
  candidateId: string;
  address: string | null;
  market: string | null;
  composite: number | null;   // AcquisitionScore.composite
  tier: 'T1' | 'T2' | 'PASS' | 'KILLED' | null;
  leveredIrr: number | null;  // from AcquisitionInput.leveredIrr persisted on the score (★ §0)
  basisDiscountPct: number | null;
}
```

### 3.1 Signature

```ts
export function allocateCapital(
  db: WarehouseDb,
  metrics: PeriodMetrics[],
  scores: PropertyScore[],
  debtScores: DebtScore[],
  pipeline: PipelineCandidate[],   // ranked acquisition candidates (replaces raw AcquisitionScore[] — see ★ §0)
  hurdleConfig: HurdleRateConfig,
  forecastInputs?: ForecastInputs, // null-safe: undefined until Phase 3
): CapitalAllocationResponse
```

> The task brief lists `acqScores: AcquisitionScore[]`. Because `leveredIrr` lives on the *input* not the
> score (★ §0), the engine takes the already-joined `PipelineCandidate[]` (the `RankedCandidate` subset)
> so it never has to reach across lanes for the IRR. The API layer (§6) builds `pipeline` from the
> acquisition lane's ranked candidates. This keeps `capital-allocation.ts` dependency-free of the acq engine.

### 3.2 Per-asset decision logic (write in full — first match wins)

For each `PropertyScore s` (joined by `propertyId` to its `DebtScore d` and latest `PeriodMetrics m`):

```ts
const forecastPresent = !!forecastInputs && forecastInputs.horizonPeriods > 0;
const horizonPeriods = forecastPresent ? forecastInputs.horizonPeriods : 0;

// Portfolio NOI/SF median (for the `improve` trigger) computed ONCE before the loop:
//   portfolioNoiPerSfMedian = median of (m.noiPerSf) across all metrics where noiPerSf != null
//   (use portfolioQuartiles(...).p50 if available; else compute median inline). Null-safe: if
//   fewer than 3 properties have noiPerSf, median = null and `improve` cannot fire (degrade to hold).

// ── 1. SELL ──────────────────────────────────────────────────────────────────────
// Concern asset where better capital deployment exists AND debt posture says exit/recap.
if (
  s.healthBand === 'concern' &&
  (s.attentionBand === 'orange' || s.attentionBand === 'red') &&
  (d.signal === 'refi' || d.signal === 'cash-out') &&
  expectedReturnFor('sell', ...) !== null &&
  expectedReturnFor('sell', ...)! < hurdleConfig.hurdleRatePct
) action = 'sell';

// ── 2. REFINANCE ──────────────────────────────────────────────────────────────────
// Debt says refi AND DSCR headroom thin. Requires a post-refi NPV proxy (cash savings) be
// drivable; if the savings cannot be computed (no rate/balance), DO NOT emit refinance — fall through.
else if (
  d.signal === 'refi' &&
  d.dscrHeadroom !== null && d.dscrHeadroom < 0.15 &&
  refiCashSavingsPct(d) !== null   // post-refi annual savings as % of equity; null ⇒ skip refinance
) action = 'refinance';

// ── 3. IMPROVE ──────────────────────────────────────────────────────────────────────
// Monitor asset underperforming on NOI/SF AND capex IRR estimate clears hurdle.
// Capex IRR requires replacement-cost / property-characteristics data NOT in warehouse scope
// (§15 deferral). When absent, capexIrrEstimate(...) returns null ⇒ DEGRADE to 'hold'.
else if (
  s.capitalAction === 'monitor' &&
  portfolioNoiPerSfMedian !== null &&
  m.noiPerSf !== null && m.noiPerSf < portfolioNoiPerSfMedian &&
  capexIrrEstimate(s, m) !== null &&
  capexIrrEstimate(s, m)! > hurdleConfig.hurdleRatePct
) action = 'improve';

// ── 4. BUY (portfolio-level signal attached to no specific asset; see 3.5) ───────────
//   handled OUTSIDE the per-asset loop — see §3.5.

// ── 5. HOLD (default) ────────────────────────────────────────────────────────────────
else action = 'hold';
```

**Trigger-precedence note (refute lens #1, §14):** A *healthy* asset (`healthBand` ∈ {excellent, good}) with a large debt balance must NEVER hit `sell`. The `sell` guard requires `healthBand === 'concern'`. High LTV on a good asset routes to `refinance` (rule 2) or `hold`, never `sell`. This is asserted by test A-2-neg.

### 3.3 Expected-return (hurdle comparability) math — write in full

All actions are converted to an **annualized unlevered return fraction** so they sit on one axis vs. `hurdleRatePct`. Implement `expectedReturnFor(action, s, d, m, forecastInputs, pipeline)`:

```ts
function expectedReturnFor(action, s, d, m, forecast, candidate?): number | null {
  switch (action) {
    case 'hold':
    case 'improve': {
      // Trailing NOI CAGR from growthSeries() latest comparable point for this property.
      // If forecastPresent, prefer forecast.forwardNoiCagrByProperty[propertyId].
      const fwd = forecast?.forwardNoiCagrByProperty?.[s.propertyId];
      if (fwd !== undefined && Number.isFinite(fwd)) return fwd;
      const cagr = trailingNoiCagr(s.propertyId);  // from growthSeries(); null if < 2 comparable points
      return cagr;   // may be null
    }
    case 'refinance': {
      // Annualized post-refi cash savings as % of current equity.
      // savings = currentAnnualInterest - refiAnnualInterest(at market rate); equity = value - balance.
      // refiCashSavingsPct returns null when rate/balance/value missing → caller already gated.
      return refiCashSavingsPct(d);
    }
    case 'sell': {
      // Implied cap rate vs portfolio weighted-average cap rate.
      //   estimatedValue = trailingNoi / marketCapRate   (marketCapRate from holdCapRate governor or macro)
      //   impliedCapRate = trailingNoi / estimatedValue   (== marketCapRate by construction)
      // The "return" we compare is the OPPORTUNITY: redeploying sale proceeds at hurdle vs holding at
      // the asset's own NOI yield. expectedReturnPct for sell = the asset's trailing NOI yield
      //   = trailingNoi / estimatedValue. If < hurdle, selling+redeploying beats holding ⇒ sell signal.
      const trailingNoi = latestNoi(m);
      const valueCapRate = governorHoldCapRate ?? macroCapRate;   // decimal
      if (trailingNoi === null || valueCapRate === null || valueCapRate <= 0) return null;
      const estimatedValue = trailingNoi / valueCapRate;
      if (estimatedValue <= 0) return null;
      return trailingNoi / estimatedValue;  // == valueCapRate; the asset's unlevered yield
    }
    case 'buy': {
      // Use the candidate's leveredIrr converted to an APPROXIMATE unleveraged IRR via the
      // equity/price ratio implied by the governor LTV ceiling (conservative):
      //   equityShare = 1 - ltv     (ltv from candidate or governor ceiling 0.40 ⇒ equityShare 0.60)
      //   unleveredApprox = (1 + leveredIrr) * equityShare - 1   ... bounded, documented approximation
      // If candidate.leveredIrr is null ⇒ return null (no fabricated buy return).
      if (!candidate || candidate.leveredIrr === null) return null;
      const equityShare = 1 - (governorLtvCeiling ?? 0.40);
      return (1 + candidate.leveredIrr) * equityShare - 1;
    }
  }
}
```

**`returnAboveHurdle`** = `expectedReturnPct === null ? null : expectedReturnPct >= hurdleConfig.hurdleRatePct`.
A `false` value is **CAUTION, not a hard block** — the verdict still emits; the UI labels it. Hurdle never vetoes; only the ratified-vs-proposed flag changes `advisoryOnly`.

> **Undrivable sub-routines return `null`, never `0` or a guess.** `trailingNoiCagr`, `refiCashSavingsPct`,
> `capexIrrEstimate`, `latestNoi`, `macroCapRate` each return `number | null`. `capexIrrEstimate` always
> returns `null` in Phase 5 (replacement-cost data is out of scope, §15) — which is why `improve` degrades
> to `hold` in practice until Phase 4 v2 wires property characteristics. State this in `reasons[]`.

### 3.4 Verdict assembly (per asset)

```ts
riskBand        = riskBandFrom(s.attentionBand, d.scoreBand)         // §2 matrix
expectedReturnPct = expectedReturnFor(action, ...)
timelineMonths  = TIMELINE[action]                                    // see table
confidence01    = computeConfidence(s, forecastPresent, cohortSize)   // see §3.6
advisoryOnly    = hurdleConfig.ratification === 'proposed'            // PER VERDICT, not just top-level
reasons         = ordered: [primaryTrigger, hurdleComparison, dataCaveats...]
horizonPeriods  = forecastPresent ? forecastInputs.horizonPeriods : 0
```

`TIMELINE` (months): `hold = 12`, `improve = 12` (mid of 6–18), `refinance = 4` (mid of 3–6), `sell = 9` (mid of 3–12), `buy = 6` (pipeline-dependent placeholder; portfolio-level).

### 3.5 Portfolio-level `buy` + ranking

After the per-asset loop:

```ts
// BUY signal: portfolio recommends acquisition when pipeline has T1/T2 candidates clearing the bar.
const BUY_COMPOSITE_FLOOR = 70;
const BASIS_DISCOUNT_FLOOR = 0.05;   // [RATIFY] 5% all-in basis discount vs replacement cost
const buyable = pipeline.filter(c =>
  (c.tier === 'T1' || c.tier === 'T2') &&
  c.composite !== null && c.composite >= BUY_COMPOSITE_FLOOR &&
  (c.basisDiscountPct === null || c.basisDiscountPct >= BASIS_DISCOUNT_FLOOR)
);
// A portfolio-level `buy` AllocationVerdict is emitted ONLY when buyable.length > 0.
// It carries propertyId = `pipeline:${candidateId}` of the top-ranked buyable candidate,
// expectedReturnPct = expectedReturnFor('buy', ...top candidate...). NEVER emit buy on empty buyable
// (refute lens #4, §14 → test A-4-neg).

// RANK all verdicts:
//   primary:   attentionBand priority DESC  (red=3, orange=2, yellow=1, green=0)
//   secondary: expectedReturnPct DESC        (null sorts last)
```

`actionCounts` = tally of `action` across emitted verdicts. `advisoryOnly` (top-level) = `verdicts.some(v => v.advisoryOnly)` — which, while proposed, is always `true`.

### 3.6 Confidence computation

```ts
function computeConfidence(s, forecastPresent, cohortSize): number {
  let c = 0.80;                                   // base when fully driven
  if (!forecastPresent) c = Math.min(c, 0.65);    // forecast absent cap
  if (cohortSize < 3)   c = Math.min(c, 0.60);    // thin benchmark cohort cap
  // floor at 0.10 to avoid zero-confidence noise
  return Math.max(0.10, c);
}
```
`cohortSize` = `s.benchmarkCohortSize`. `confidenceTier` derives: `c >= 0.75 ⇒ 'confirmed'`, `c >= 0.5 ⇒ 'estimated'`, else `'derived'`.

---

## 4. Market Intelligence (`server/warehouse/market-intel.ts` — NEW · **Refute required**)

Reads cached rows from `market_series` (migration 012) + `getMacro()`. Confidence-tagged, weighted. No live comps call on the hot path.

### 4.1 Signature

```ts
import type { WarehouseDb } from './db';
import { MarketSignal, MarketAction } from '../../src/contracts/capital';
import { getMacro } from '../macro/getMacro';

// agentComps is OPTIONAL and currently always omitted on the hot path (v1). When a future
// caller passes freshly-pulled comps, they merge with the same confidence rules. The type is
// the CompSet subset the function consumes — NOT a new contract.
export interface AgentCompResult {
  cluster: string;
  medianRentPsf: number | null;
  vacancyPctEstimate: number | null;
  sourcedAt: string;        // ISO; staleness measured against asOf
}

export async function buildMarketIntel(
  db: WarehouseDb,
  cluster: string,
  asOf: string,                       // ISO YYYY-MM-DD evaluation date
  agentComps?: AgentCompResult,       // null/undefined when stale/unavailable (the v1 default)
): Promise<MarketSignal>
```

> The brief's signature omits `asOf` and makes it sync. Market intel reads `getMacro()` (async) and needs
> an evaluation date for staleness — both are added. The function is `async`.

### 4.2 Data sources, weights, staleness

Three confidence-tagged sources, priority order. Each contributes a 0..100 sub-score and a 0..1 confidence; the composite is a **confidence-weighted average of available sub-scores**.

| Source | Weight | Sub-score basis | Staleness window |
|---|---|---|---|
| FRED (`getMacro`) | **0.5** | Cap-rate vs T-10 spread → a 0..100 "yield environment" score (wider positive spread = higher score) | 35 days |
| Census ACS (`market_series` rows, `source='census-acs'`, metric `pop_growth`) | **0.3** | population/employment growth → 0..100 | 400 days (annual data) |
| Comps-AI (`market_series` rows `source='comps-ai'` OR `agentComps`) | **0.2** | rent trend + (100 − vacancy%) blended → 0..100 | 90 days |

```ts
// 1. Gather available sources for `cluster` from market_series (most recent per source/metric).
// 2. Mark each stale = (asOf - source.asOf) > window. Stale sources are EXCLUDED from the composite
//    AND lower confidence (refute lens: stale comps must not inflate the score — test M-5).
// 3. weightedScore = Σ(weight_i * subScore_i) / Σ(weight_i)   over NON-stale available sources.
//    confidence01 = Σ(weight_i)                                over NON-stale available sources.
//      → FRED-only ⇒ confidence01 == 0.5 (M-1). All three fresh ⇒ confidence01 == 1.0 (≥0.8, M-2).
// 4. NO data at all (no FRED, no rows) ⇒ marketScore = null, confidence01 = 0, action = 'maintain' (M-6).
```

> FRED via `getMacro()` **always returns a snapshot** (seeded fallback). So in practice FRED is always
> available unless its cap-rate/T-10 fields are null. M-6 ("no data at all") is reachable only when the
> macro snapshot lacks the needed fields AND `market_series` is empty for the cluster — handle by treating
> a null cap-rate spread as an absent FRED source.

### 4.3 Market action logic

```ts
oraPropertyCount = countOraPropertiesInCluster(db, cluster);   // join property_master.market ↔ cluster
if (marketScore === null) action = 'maintain';                 // safe default (M-6)
else if (marketScore >= 75 && oraPropertyCount === 0) action = 'enter';   // (M-4)
else if (marketScore >= 65 && oraPropertyCount < 3)  action = 'expand';
else if (marketScore >= 45)                          action = 'maintain';
else /* < 45 */                                      action = 'exit';     // ADVISORY ONLY (M-3)
```

`advisoryOnly` is **always `true`** (`z.literal(true)` in the contract). `exit` NEVER triggers a sell on its own — it is a *modulating input* to capital allocation; the actual sell decision is §3's `sell` rule.

### 4.4 `confidenceTier` + reasons

`confidenceTier`: `c >= 0.75 ⇒ 'confirmed'`, `>= 0.5 ⇒ 'estimated'`, else `'derived'`. `reasons[]` lists each contributing source with its sub-score and any staleness exclusion.

---

## 5. Migrations (architect-owned)

Phase 3 reserves `011`. Phase 5 uses `012`, `013`, `014`. **Do not create `011`.** If `011` already exists when you arrive (Phase 3 shipped first), keep `012+`. If it does not, still skip to `012` — leaving a gap is fine (the runner sorts numerically and tolerates gaps).

### 5.1 `012_market_series.sql` (NEW)

```sql
-- 012_market_series.sql
-- Phase 5 Market Intelligence: confidence-tagged public-data series per submarket/cluster.
-- Populated by manual/seeded inserts in v1 (Census ACS + comps-AI cache); FRED is read live
-- via getMacro() and is NOT stored here. Empty on initial migration — schema only.
CREATE TABLE IF NOT EXISTS market_series (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  cluster       TEXT NOT NULL,
  as_of         TEXT NOT NULL,               -- ISO YYYY-MM-DD
  source        TEXT NOT NULL,               -- 'fred' | 'census-acs' | 'comps-ai' | 'composite'
  metric        TEXT NOT NULL,               -- 'vacancy_pct' | 'rent_psf' | 'cap_rate' | 'pop_growth' | 'score'
  value         REAL,
  confidence    REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  source_detail TEXT,                         -- JSON blob of raw inputs
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS ix_market_series_cluster_asof ON market_series (cluster, as_of);
```

### 5.2 `013_recommendations.sql` (NEW)

```sql
-- 013_recommendations.sql
-- Phase 5 Capital Allocation: persisted per-asset allocation verdicts for trend + calibration.
-- advisory_only defaults to 1 (TRUE) until the hurdle rate is ratified (§16). Empty on migration.
CREATE TABLE IF NOT EXISTS recommendations (
  id                  INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id         TEXT NOT NULL,
  action              TEXT NOT NULL CHECK (action IN ('buy','hold','sell','refinance','improve')),
  expected_return_pct REAL,
  risk_band           TEXT NOT NULL CHECK (risk_band IN ('low','moderate','elevated','high')),
  timeline_months     INTEGER,
  confidence          REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  inputs_version      TEXT NOT NULL,
  advisory_only       INTEGER NOT NULL DEFAULT 1,
  reasons_json        TEXT NOT NULL DEFAULT '[]',
  as_of               TEXT NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS ix_recommendations_property ON recommendations (property_id, as_of);
```

### 5.3 `014_hurdle_rate.sql` (NEW — governor extension)

`capital_config` was created by `003_capital_config.sql`. SQLite supports `ADD COLUMN` but not `IF NOT EXISTS` on columns; the migration runs once (tracked in `_migrations`), so a plain `ALTER TABLE ADD COLUMN` is safe.

```sql
-- 014_hurdle_rate.sql
-- Phase 5 governor extension: add the hurdle-rate fields to capital_config.
-- Proposed default 0.08 (8% unlevered IRR), ratification 'proposed' (fail-closed: every
-- capital-allocation verdict is advisoryOnly until Gabriel ratifies — see spec §16).
ALTER TABLE capital_config ADD COLUMN hurdle_rate_pct REAL NOT NULL DEFAULT 0.08;
ALTER TABLE capital_config ADD COLUMN hurdle_rate_ratification TEXT NOT NULL DEFAULT 'proposed';
ALTER TABLE capital_config ADD COLUMN hurdle_rate_ratified_by TEXT;
ALTER TABLE capital_config ADD COLUMN hurdle_rate_ratified_date TEXT;
```

### 5.3a `015_property_onboarding.sql` (NEW — W4; durable alias/PM-system home)

```sql
-- 015_property_onboarding.sql
-- Phase 5 data-driven property onboarding (W4). Durable home for onboarded-property aliases,
-- PM system, and authoritative-source declaration. PROPERTY_ALIASES in detect.ts is a compile-time
-- const and cannot be written at runtime; this table is the runtime-writable companion. Wiring
-- detect.ts to READ aliases_json is a deferred Integration-agent follow-up (spec §9.2). Empty on
-- migration.
CREATE TABLE IF NOT EXISTS property_onboarding (
  property_id          TEXT PRIMARY KEY REFERENCES property_master(id),
  aliases_json         TEXT NOT NULL DEFAULT '[]',
  pm_system            TEXT NOT NULL CHECK (pm_system IN ('quickbooks','yardi','appfolio','rent-manager')),
  authoritative_source TEXT NOT NULL CHECK (authoritative_source IN ('pm-exports','internal-quickbooks','workbook-only')),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
```

### 5.4 Registration

All four are auto-discovered by `server/warehouse/migrate.ts` (it `readdirSync`s `migrations/`, filters `.sql`, sorts numerically). **No code edit to `migrate.ts` is strictly required** — but per CLAUDE.md the migrations directory is architect-owned, so still flag it (§13). Confirm `warehouse:verify` (fresh tmpdir, 32-file ingest) creates all three objects.

---

## 6. API Routes (`server/warehouse/capital-allocation-api.ts` — NEW)

Mirror `debt-api.ts` exactly: `(getDb: () => WarehouseDb) => Hono`, internal `withDb` returning 503 on a thrown getter, 500 on handler error, Zod-parse the response envelope.

```ts
import { Hono } from 'hono';
import type { WarehouseDb } from './db';
import { propertyPeriodMetrics } from './metrics';
import { scoreProperties } from './scores';
import { scoreDebtPositions } from './debt-scoring';
import { getMacro } from '../macro/getMacro';
import { loadGovernors } from './governors';
import { allocateCapital, type PipelineCandidate } from './capital-allocation';
import { buildMarketIntel } from './market-intel';
import { rankAcquisitionPipeline } from './acq-pipeline'; // existing acq lane ranked-candidate reader
import {
  CapitalAllocationResponse,
  MarketIntelResponse,
  HurdleRateConfig,
} from '../../src/contracts/capital';

export function capitalAllocationApi(getDb: () => WarehouseDb): Hono {
  const app = new Hono();
  const withDb = (handler: (db: WarehouseDb) => Response | Promise<Response>) => {
    let db: WarehouseDb;
    try { db = getDb(); }
    catch {
      return Promise.resolve(new Response(JSON.stringify({ error: 'warehouse unavailable' }), {
        status: 503, headers: { 'content-type': 'application/json' },
      }));
    }
    return handler(db);
  };

  // GET /api/warehouse/capital/allocate
  app.get('/allocate', (c) => withDb(async (db) => {
    try {
      const metrics = propertyPeriodMetrics(db);
      const scores = scoreProperties(db, metrics);
      const macro = await getMacro();
      // MacroSnapshot has NO flat `treasury5y` field. It carries `indicators: MacroIndicator[]`
      // (each `{ id, label, value: number|null, unit, change }`) + `tenYearHistory`. Extract the
      // 5y treasury by indicator id (the FRED DGS5 indicator — confirm its `id` string in
      // server/macro/fred.ts; it is one of the indicators array). value may be null (FRED outage)
      // → pass null through; scoreDebtPositions already accepts `number | null`.
      const t5 = macro.indicators.find((i) => i.id === 'DGS5')?.value ?? null;
      const debtScores = scoreDebtPositions(db, metrics, t5);
      const gov = loadGovernors(db);
      const hurdle: HurdleRateConfig = HurdleRateConfig.parse({
        hurdleRatePct: gov.hurdleRatePct ?? 0.08,
        ratification: gov.hurdleRateRatification ?? 'proposed',
        ratifiedBy: gov.hurdleRateRatifiedBy ?? null,
        ratifiedDate: gov.hurdleRateRatifiedDate ?? null,
        capitalConfigVersion: gov.version,
      });
      const pipeline: PipelineCandidate[] = rankAcquisitionPipeline(db).map(/* → PipelineCandidate */);
      const result = allocateCapital(db, metrics, scores, debtScores, pipeline, hurdle /* no forecast */);
      return c.json(CapitalAllocationResponse.parse(result));
    } catch (err) {
      console.error('[capital-api] /allocate error:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'capital allocation failed' }, 500);
    }
  }));

  // GET /api/warehouse/capital/market
  app.get('/market', (c) => withDb(async (db) => {
    try {
      const asOf = new Date().toISOString().slice(0, 10);
      const clusters = listClustersWithOraPresenceOrSeries(db); // property_master markets ∪ market_series clusters
      const signals = await Promise.all(clusters.map((cl) => buildMarketIntel(db, cl, asOf)));
      return c.json(MarketIntelResponse.parse({ asOf, signals }));
    } catch (err) {
      console.error('[capital-api] /market error:', err instanceof Error ? err.message : String(err));
      return c.json({ error: 'market intel failed' }, 500);
    }
  }));

  return app;
}
```

**Mount** in `server/index.ts` (architect-owned), after the debt mount:
```ts
app.route('/api/warehouse/capital', capitalAllocationApi(getWarehouse));
```

**`rankAcquisitionPipeline` / `acq-pipeline`:** if the acquisition lane exposes a ranked-candidate reader (it produces `RankedCandidate`), import it. If no single function exists, the route builds `PipelineCandidate[]` from the acq-candidate + latest-score tables directly (read-only SELECT). Either way this mapping lives in the **route file** (delivery-only), not the engine.

**Add `server/warehouse/capital-allocation-api.ts` to `DELIVERY_ONLY_PATHS`** in `scripts/check-refute-required.ts` (architect-owned). It is route plumbing — math lives in §3/§4. The refute trailer attaches to the engine commits.

Error policy: `503` when `getDb()` throws (warehouse unavailable); `500` on unexpected engine error. `getMacro()` never throws (seeded fallback), so macro is non-fatal.

---

## 7. Capital Allocation UI (`src/modules/capital/` — NEW · W2 · UI-exempt)

| File | Display (not implementation) |
|---|---|
| `CapitalModule.tsx` | Two panels. **Portfolio Allocation**: ranked `AllocationCard` list across all assets (sorted as the API returns). **Pipeline**: T1/T2 candidates from `portfolio.pipeline` (composite, tier chip, leveredIrr, basis-discount). Top: `HurdleRateBanner`. Fetch `GET /api/warehouse/capital/allocate` via a `useCapitalAllocation` hook (mirror `useMacro`/debt hooks). |
| `AllocationCard.tsx` | Per-asset card: action chip color-coded (`buy`=emerald, `hold`=slate, `sell`=red, `refinance`=amber, `improve`=indigo — ORA token equivalents), `expectedReturnPct` (`—` when null), `riskBand` badge, `timelineMonths`, a `confidence01` bar, and a `reasons[]` accordion. Show "vs hurdle" with `returnAboveHurdle` arrow. |
| `HurdleRateBanner.tsx` | Renders only when `advisoryOnly === true` (proposed hurdle). Amber banner: "Advisory only — hurdle rate {hurdleRatePct} pending ratification. Verdicts are non-binding." |

Register in `src/shell/modules.tsx` (UX-agent-owned): add to `MODULES` with `{ id: 'capital', label: 'Capital', icon: <Lucide icon, e.g. Scale or Coins>, group: 'Capital', Component: CapitalModule }` and the matching `lazy(() => import('@/modules/capital/CapitalModule')...)`. Style per existing ORA CSS tokens; no new palette.

---

## 8. Market Intelligence UI (`src/modules/market/` — REBUILD/EXTEND · W3 · UI-exempt)

Keep `MarketModule.tsx`'s existing FRED rate section verbatim. Add:

| File | Display |
|---|---|
| `MarketModule.tsx` (extend) | Below the existing FRED widget, render a `MarketScorecard` grid fed by `GET /api/warehouse/capital/market`. |
| `MarketScorecard.tsx` (NEW) | Per-cluster card: `marketScore` (0–100, `—` when null), `confidence01` bar, `action` chip (`enter`/`expand`/`maintain`/`exit`), source tags (FRED/Census/Comps with stale strikethrough), and a persistent **"Advisory only"** label on every card (`advisoryOnly` is always true). |

Add a `useMarketIntel` hook mirroring `useMacro`. No external API calls from the client — it hits the local route only.

---

## 9. Data-Driven Property Onboarding (`server/warehouse/property-onboarding.ts` — NEW · W4)

`property-master.ts` ships `seedPropertyMaster(db)` and `CANON_PROPERTIES` but **no read helper**. Phase 5 adds a coexistence path: a `property_master` DB row wins over the TS seed; nothing is deleted.

### 9.1 New read helper in `property-master.ts` (architect-touch — see §13)

```ts
export interface PropertyMasterRecord {
  id: string;
  name: string;
  market: string | null;
  rentableSf: number | null;
  ownershipPct: number;
  ownershipStatus: string;
  assetClass: string | null;
  source: 'db' | 'seed';   // provenance: which path produced this record
}

// Returns the merged universe: every property_master DB row, plus any CANON_PROPERTIES seed
// entry whose id is NOT present in the DB. DB always wins on id conflict (source='db').
export function getPropertyMaster(db: WarehouseDb): PropertyMasterRecord[]
```

> Implementation: `SELECT … FROM property_master`, build a `Set` of DB ids, then append seed entries whose
> id is absent. `seedPropertyMaster` already upserts the canon on first run, so in a freshly-seeded DB the
> DB and seed agree — the merge is a safety net for a hand-onboarded property that predates a code deploy.

### 9.2 Onboarding writer (`property-onboarding.ts`)

```ts
import type { WarehouseDb } from './db';

export interface PropertyOnboardingInput {
  id: string;            // 'fulton-st' — unique, URL-safe (kebab); validated
  name: string;
  aliases: string[];     // detect.ts filename aliases
  sfTotal: number | null;
  pmSystem: 'quickbooks' | 'yardi' | 'appfolio' | 'rent-manager';
  authoritativeSource: 'pm-exports' | 'internal-quickbooks' | 'workbook-only';
}

export function onboardProperty(
  db: WarehouseDb,
  input: PropertyOnboardingInput,
): { ok: boolean; propertyId?: string; error?: string }
```

Logic:
```text
1. Validate id: /^[a-z0-9][a-z0-9-]*$/ — else { ok:false, error:'invalid id (must be URL-safe kebab-case)' }.
2. Reject duplicate: SELECT 1 FROM property_master WHERE id = ? → if exists,
   { ok:false, error:`property '${id}' already exists` }.
3. INSERT into property_master (id, name, market=null, rentable_sf=sfTotal, ownership_pct=1,
   ownership_status='active', asset_class=null, …) within a transaction.
4. Persist aliases + pmSystem + authoritativeSource via a NEW table `property_onboarding`
   (migration `015_property_onboarding.sql`, architect-owned). The existing alias home,
   `PROPERTY_ALIASES` in `server/warehouse/detect.ts`, is a **compile-time TS `Record<string,string>`
   const** — it CANNOT be written at runtime, so a data-driven onboarding path REQUIRES a DB table.
   Store aliases as a JSON array column. (Do NOT silently drop aliases.)
5. Return { ok:true, propertyId: id }.
```

> **Alias resolution at detect time (deferred follow-up).** `detect.ts` resolves filename tokens via the
> static `PROPERTY_ALIASES` const. For an onboarded property's files to auto-detect, `detect.ts` would
> need to ALSO consult `property_onboarding.aliases_json` at runtime. That `detect.ts` change is an
> **Integration-agent surface** edit and is **out of Phase 5 scope** — note it as a follow-up. In Phase 5,
> onboarding registers the property + its declared aliases in the DB; wiring detection to read them is
> deferred (mirrors the AR-feed deferral pattern). The `015` table is the durable home for that future read.

### 9.3 API route

`POST /api/warehouse/properties/onboard` — mount in `server/index.ts` (architect-owned). Body = `PropertyOnboardingInput`; response = `{ ok: boolean; propertyId?: string; error?: string }`. Return `200` on `ok:true`, `400` on validation/duplicate failure (`ok:false`), `503` when warehouse unavailable. This route is **delivery-only** → add it to `DELIVERY_ONLY_PATHS` if it lives in its own file; if folded into the existing `warehouseRoutes`, that file is already whitelisted (`server/warehouse/api.ts`).

### 9.4 Admin UI (`src/modules/intel/`)

Add a minimal "Onboard property" form (new `AdminOnboardView.tsx` or a panel in `DataQualityView`): id, name, aliases (comma-split), SF, pmSystem select, authoritativeSource select → POSTs to the route, shows `ok`/`error`. UI-exempt.

---

## 10. Governor Extension (`capital-config.ts` + `governors.ts` + `intel-config.ts`)

### 10.1 `capital-config.ts` (architect-touch via migrations dir; the file itself is in `server/warehouse/` → Refute required)

Extend `CapitalConfigRow` and `loadCapitalConfig`:

```ts
export interface CapitalConfigRow {
  version: number;
  effectiveFrom: string;
  dscrFloor: number;
  ltvCeiling: number;
  dispositionCapRate: number;
  holdCapRate: number;
  acqIrr: number;
  capexIrr: number;
  refiTriggerBps: number;
  payoutPct: number;
  notes: string | null;
  // ── Phase 5 hurdle-rate governor ──
  hurdleRatePct: number;                 // default 0.08
  hurdleRateRatification: 'ratified' | 'proposed';
  hurdleRateRatifiedBy: string | null;
  hurdleRateRatifiedDate: string | null;
}
```

Add the four columns to the `loadCapitalConfig` SELECT with aliases:
```sql
hurdle_rate_pct           AS hurdleRatePct,
hurdle_rate_ratification  AS hurdleRateRatification,
hurdle_rate_ratified_by   AS hurdleRateRatifiedBy,
hurdle_rate_ratified_date AS hurdleRateRatifiedDate
```
Extend the compile-time `CAPITAL_CONFIG` fallback with `hurdleRatePct: 0.08, hurdleRateRatification: 'proposed', hurdleRateRatifiedBy: null, hurdleRateRatifiedDate: null`.

`governors.ts` is a pure re-export — `loadGovernors`/`Governors` automatically surface the new fields once `CapitalConfigRow` is extended. **No edit to `governors.ts` needed** beyond confirming the re-export compiles. (The brief says "loadGovernors must return this field" — it does, transitively.)

### 10.2 `intel-config.ts`

Add a `hurdleRate` block to the exported config surface for display/provenance parity (the *authoritative* value is the DB column; `intel-config` mirrors the proposed default + the ratified-vs-proposed doctrine note):

```ts
export const HURDLE_RATE = {
  proposedPct: 0.08,
  ratification: 'proposed' as const,
  basis: 'unlevered IRR — marginal cost of capital making buy/hold/sell/refi/improve comparable',
} as const;
```

**Every `AllocationVerdict.advisoryOnly` is `true` while `hurdleRateRatification === 'proposed'`.**

---

## 11. Calibration Extension (`server/warehouse/calibration.ts` — Refute required)

`verdictsFromScores` already emits `verdictKind: 'capital-action'` (the 4-way). Phase 5 adds a **5-way** logging path WITHOUT overloading the existing one:

- Add a function `verdictsFromAllocations(allocations: AllocationVerdict[], inputsVersion: string): CalibrationVerdict[]` that maps each `AllocationVerdict` to a `CalibrationVerdict` with `verdictKind: 'capital-action-v2'`, `verdictSubkind` = the 5-way `action`, `predictedBand` = `action`, `confidence` = `confidence01`, `horizonPeriods` = `null` when `0` (the schema requires positive-or-null), `inputsVersion` from `computeInputsVersion`, `emittedBy: 'capital-allocation'`.
- Log via the existing `logVerdicts(db, verdicts, opts)` (fail-open, idempotent). Call it from the `/allocate` route AFTER building the response (non-fatal — its failure never blocks the response).

This keeps `'capital-action'` (4-way property recommendation) and `'capital-action-v2'` (5-way allocation) as distinct, separately-calibratable verdict kinds.

---

## 12. Test Plan (vitest)

Test setup mirrors `tests/unit/debt-scoring.test.ts`: `// @vitest-environment node`, `freshDb()` via `mkdtempSync(join(tmpdir(), 'cap-alloc-test-'))` + `openWarehouse`, seed `property_master`/`ledger_entries`/`debt_positions` with helper inserts, then call the engine. Mock `getMacro` for route/market tests via `vi.mock('../../server/macro/getMacro', …)`.

### Market Intelligence — `tests/unit/market-intel.test.ts`
- **M-1** cluster with FRED data only (no `market_series` rows) → `marketScore` computed, `confidence01 === 0.5`, `action` ∈ {enter,expand,maintain,exit}.
- **M-2** cluster with all three fresh sources (seed `market_series` census+comps rows dated within window) → `confidence01 >= 0.8` (in fact `1.0`).
- **M-3** seed sources so `marketScore < 45` → `action === 'exit'`, `advisoryOnly === true`.
- **M-4** seed sources so `marketScore >= 75` AND `oraPropertyCount === 0` (no `property_master` row in cluster) → `action === 'enter'`.
- **M-5** seed a comps-ai row dated >90d before `asOf` → that source `stale === true`, excluded from composite; `confidence01` reduced (does not include the 0.2 comps weight); score reflects only fresh sources.
- **M-6** no FRED cap-rate spread (mock `getMacro` → null cap-rate fields) AND empty `market_series` → `marketScore === null`, `confidence01 === 0`, `action === 'maintain'`, no throw.

### Capital Allocation — `tests/unit/capital-allocation.test.ts`
- **A-1** `hurdleConfig.ratification === 'proposed'` → every verdict `advisoryOnly === true` AND `portfolio.advisoryOnly === true`.
- **A-2** seed property: `healthBand='concern'`, `attentionBand='red'`, debt `signal='cash-out'`, expectedReturn (asset NOI yield) `< 0.08` → `action === 'sell'`.
- **A-2-neg** healthy asset (`healthBand='good'`) with high LTV + `signal='cash-out'` → `action !== 'sell'` (must be `hold` or `refinance`). *(Refute lens #1.)*
- **A-3** debt `signal='refi'`, `dscrHeadroom = 0.10 (<0.15)`, drivable refi savings → `action === 'refinance'`.
- **A-3-neg** debt `signal='refi'`, `dscrHeadroom=0.10`, but refi savings undrivable (null rate/balance) → `action !== 'refinance'` (falls through to hold). *(Refute lens #2.)*
- **A-4** pipeline has a `tier='T1'`, `composite=78` candidate → portfolio emits a `buy` verdict with `propertyId` prefixed `pipeline:`.
- **A-4-neg** empty pipeline (no T1/T2 ≥70) → NO `buy` verdict in `verdicts`. *(Refute lens #4.)*
- **A-5** `healthBand='good'`, debt `scoreBand='strong'`, `signal='hold'`, no special trigger → `action === 'hold'`.
- **A-6** `capitalAction='monitor'`, `m.noiPerSf` below portfolio median, AND a stubbed `capexIrrEstimate` > hurdle → `action === 'improve'`. *(In production `capexIrrEstimate` returns null and this degrades to hold; the test injects a non-null estimate to exercise the branch.)*
- **A-6-neg** same as A-6 but `capexIrrEstimate` null (default) → `action === 'hold'` with a reason noting capex data absent.
- **A-7** `forecastInputs` undefined → every verdict `confidence01 <= 0.65`, `horizonPeriods === 0`, no throw.
- **A-8** seed a property whose `benchmarkCohortSize < 3` → its `confidence01 <= 0.60`.
- **A-9** comparability: for a property where `expectedReturnPct === 0.10` and `hurdleRatePct === 0.08` → `returnAboveHurdle === true`.
- **A-9-neg** `expectedReturnPct === null` → `returnAboveHurdle === null`.
- **A-10** multiple properties → `verdicts` ordered by attentionBand priority (red>orange>yellow>green) DESC, then `expectedReturnPct` DESC (null last).

### Routes — `tests/unit/capital-allocation-api.test.ts`
- **R-1** `GET /allocate` → 200; body parses via `CapitalAllocationResponse.parse`.
- **R-2** `GET /market` → 200; body parses via `MarketIntelResponse.parse`.
- **R-3** warehouse unavailable (getter throws) → 503.
- **R-4** response `advisoryOnly` reflects hurdle ratification: proposed config → `true`; ratified config (seed `capital_config` with `hurdle_rate_ratification='ratified'`) → `false`.

### Onboarding — `tests/unit/property-onboarding.test.ts`
- **O-1** valid new `PropertyOnboardingInput` → `onboardProperty` returns `{ ok:true, propertyId }`; row present in `property_master`.
- **O-2** duplicate id (already in `property_master`) → `{ ok:false, error }` with `error` containing `'already exists'`.
- **O-3** `getPropertyMaster(db)` returns the DB row merged with the TS seed; for an id present in BOTH, the returned record has `source==='db'` (DB wins).
- **O-4** invalid id (`'Fulton St'` — spaces/caps) → `{ ok:false, error }` containing `'URL-safe'`.

### Migration assertions (extend `warehouse:verify`)
On the fresh tmpdir 32-file ingest: `market_series`, `recommendations` tables exist; their indexes exist; `capital_config` has the four hurdle columns with defaults (`hurdle_rate_pct=0.08`, `hurdle_rate_ratification='proposed'`); `allocateCapital(...)` and `buildMarketIntel(...)` run clean on the fixture (no throw, valid Zod shapes).

---

## 13. Architect-Owned File Touches (flag every one)

For each: set `review_needed: true` in `architecture/status.json` with `review_detail` naming the specific file + why, commit that declaration, and wait for acknowledgment before editing.

| File | Touch | Owner gate |
|---|---|---|
| `src/contracts/capital.ts` | **NEW** | architect-owned (`src/contracts/`) |
| `src/contracts/index.ts` | barrel export `./capital` | architect-owned barrel |
| `server/warehouse/migrations/012_market_series.sql` | **NEW** | architect-owned migrations dir |
| `server/warehouse/migrations/013_recommendations.sql` | **NEW** | architect-owned migrations dir |
| `server/warehouse/migrations/014_hurdle_rate.sql` | **NEW** | architect-owned migrations dir |
| `server/warehouse/migrations/015_property_onboarding.sql` | **NEW** (required — `PROPERTY_ALIASES` is a compile-time const, no runtime alias table exists; §9.2) | architect-owned migrations dir |
| `server/warehouse/migrate.ts` | confirm auto-discovery (likely no edit) | architect-owned |
| `server/index.ts` | mount `/api/warehouse/capital` + `POST /properties/onboard` | architect-owned (`server/index.ts`) |
| `scripts/check-refute-required.ts` | add `capital-allocation-api.ts` (and onboarding route file if standalone) to `DELIVERY_ONLY_PATHS` | architect-owned |
| `server/warehouse/property-master.ts` | add `getPropertyMaster()` read helper | **NOT** in architect-only list, but `server/warehouse/` → re-read immediately before edit (Gabriel co-develops); see §11 refute note |

`server/warehouse/capital-allocation.ts`, `market-intel.ts`, `capital-config.ts`, `calibration.ts`, `property-onboarding.ts` and all `src/modules/**` are **not** architect-owned (Analytics/Integration/UX surfaces) — no status.json gate, but still post your worktree claim in `status.json` and re-read shared files immediately before editing.

---

## 14. Adversarial Refute Requirement

`scripts/check-refute-required.ts` mechanically enforces this (`isFinancialSourcePath` flags anything under `server/warehouse/` not in `DELIVERY_ONLY_PATHS`, plus `src/analytics/`, `server/overlay.ts`). The following commits MUST carry a `Refute-Reviewed:` trailer from an **opus reviewer, ≥3 lenses, told to REFUTE/break the change** (`refute-financial-change` skill / `.claude/workflows/refute-financial-change.js`), before the "done" claim. Reviewer model ≥ implementer; never below opus for this math.

- **`server/warehouse/capital-allocation.ts`** — the capstone; consumes all engines; feeds sell/refi/buy/improve decisions. Lenses:
  1. Does the `sell` trigger fire on a healthy property that merely carries a large debt balance? (False positive — high LTV on a good asset must route to `refinance`/`hold`, never `sell`. Guard: `healthBand === 'concern'`. → A-2-neg.)
  2. Does `refinance` ever emit without a post-refi savings computation? (It must NOT — rule 2 is gated on `refiCashSavingsPct(d) !== null`. → A-3-neg.)
  3. Does `advisoryOnly` propagate to **every** verdict when `ratification === 'proposed'`, not just the top-level flag? (→ A-1.)
  4. Can a `buy` verdict fire with no T1/T2 candidate? (Must never — gated on `buyable.length > 0`. → A-4-neg.)
  Plus: sign error in `expectedReturnFor`; the `buy` unlevered-approx formula `(1+leveredIrr)*equityShare - 1` direction; null-vs-zero discipline in every sub-routine.
- **`server/warehouse/market-intel.ts`** — confidence-weighting math. Lenses: stale comps inflating the score (M-5); confidence summing past 1.0; null-score → safe `maintain` default not a fabricated number (M-6); FRED-only weight exactly 0.5 (M-1).
- **`server/warehouse/capital-config.ts`** — hurdle rate is governor-class. Lenses: default must be `proposed` (fail-closed); the DB column must override the compile-time fallback; ratified path must require explicit `ratifiedBy`/`ratifiedDate`.
- **`server/warehouse/calibration.ts`** extension — `verdictsFromAllocations` mapping. Lenses: `horizonPeriods=0` must map to `null` (schema is positive-or-null); dedup_key must not collide `capital-action` with `capital-action-v2`.
- **`server/warehouse/property-master.ts`** (`getPropertyMaster`) — only if the refute check flags it; the DB-wins merge is data, not scoring, but re-read before edit regardless.

**Exempt (no refute trailer):** `server/warehouse/capital-allocation-api.ts` (once in `DELIVERY_ONLY_PATHS`), the onboarding route if folded into `server/warehouse/api.ts` (already whitelisted), `property-onboarding.ts` (pure data write — confirm `check-refute-required` does not flag it; if it does because it's under `server/warehouse/`, either add a `Refute-Skip:` trailer with justification or run a light refute), all `src/modules/**` UI, contract `.ts` (pure schema), `.test.ts`, migration `.sql`, this `.md`.

> **`property-onboarding.ts` caveat:** it lives under `server/warehouse/` so `isFinancialSourcePath` will
> flag it. It computes no scoring. Resolve by EITHER a justified `Refute-Skip:` trailer ("pure
> property-registration write; no financial math") OR adding it to `DELIVERY_ONLY_PATHS`. Prefer the
> `DELIVERY_ONLY_PATHS` route for a clean audit trail (architect-touch, §13).

---

## 15. Out of Scope / Deferred (state explicitly; do not build)

- **Phase 3 forecast integration** — `ForecastInputs` is a null-safe stub. Full forward-return wiring lands after Phase 3 ships. Until then `horizonPeriods=0`, confidence ≤ 0.65.
- **Capex IRR estimation for `improve`** — requires replacement-cost / property characteristics (Phase 4 v2). `capexIrrEstimate` returns `null` in Phase 5 ⇒ `improve` degrades to `hold` in production. Tests inject a value to exercise the branch.
- **Census ACS live pull** — `market_series` accepts manual/seeded inserts in v1. The `census-acs-extract` skill can populate it offline; no live pull on the hot path.
- **Live comps on the allocate/market hot path** — `fetchDealComps` is an AI/egress call with confidential-deal guards; market intel reads cached `market_series` comp rows only.
- **SQLite → Postgres migration** — document the path in `architecture/database-schema.md` (additive-only DDL, no `better-sqlite3`-specific pragmas in the Phase 5 tables; all new tables use portable types). No code migration in Phase 5.
- **AI narrative for capital-allocation memos** — cadenced briefing integration is a Phase 5 *stretch*; ship the engine + UI first.

---

## 16. Governance / Ratification Gate

Before any capital-allocation verdict fires **non-advisory**:

1. **Present** `HurdleRateConfig` defaults to Gabriel: proposed `hurdleRatePct: 0.08` (8.0% unlevered IRR), with the proposed risk-band matrix (§2), market thresholds (§4.3), `BUY_COMPOSITE_FLOOR=70`, `BASIS_DISCOUNT_FLOOR=0.05`. Name the tradeoff: a higher hurdle makes `sell` fire more readily (more assets fall below it); a lower hurdle biases `hold`.
2. **On ratification:** update the `capital_config` row — `hurdle_rate_pct`, `hurdle_rate_ratification='ratified'`, `hurdle_rate_ratified_by='Gabriel Goldberg'`, `hurdle_rate_ratified_date='2026-…'`. Do this via a new `capital_config` version row (the loader reads `ORDER BY version DESC LIMIT 1`), NOT an in-place UPDATE of the existing row — preserve the proposed-era row as history.
3. **Pre-ratification `recommendations`** rows remain `advisory_only = 1` and are read-only historical record. Post-ratification verdicts write `advisory_only = 0`.
4. The hurdle rate is a **governor** (CLAUDE.md hard invariant 4 class) — never modify `hurdleRatePct` post-ratification without explicit permission, exactly like DSCR/LTV.

---

## Definition of Done (per CLAUDE.md §6 + Engineering-OS)

TDD (tests written first, watched to fail) · typecheck 0 · lint 0 (`--max-warnings 0`) · full vitest green · `reconcile` + `warehouse:verify` + `governance` green · independent local code review · **adversarial refute pass on §14 files with `Refute-Reviewed:` trailer** · dev/preview server stopped before returning · no `--no-verify` · commit with explicit paths only · `architecture/status.json` updated to `merged` on merge · worktree removed + `ownership.json` entry cleaned per CLAUDE.md §7.
