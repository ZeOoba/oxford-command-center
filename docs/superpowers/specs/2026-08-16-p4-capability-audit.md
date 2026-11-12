# P4 — Capability Audit

**2026-08-16** · Commissioned by Gabriel after spec v02 was found to overlap working code.
Method: read the codebase component-by-component against spec v02's six components. Read-only; nothing modified.

---

## 1. Headline

**ORA already owns a working PM-data reconciliation and exception capability. It is dark because nobody ever created `data/ar/inbox` and dropped eight files into it.**

Five of spec v02's six components exist and are tested. The ingestion subsystem was shipped as PR #230 (`feat/ar-balances-feed`) and hardened over two adversarial refute rounds on 2026-07-22. All five Phase-1 detectors exist in the condition engine. The regime registry exists and is populated in the warehouse.

What is genuinely missing is narrower and different from what v02 described.

---

## 2. Component-by-component

### 2.1 §4.1 Port layer / ingestion — **EXISTS**

| Module | Lines | Role |
|---|---|---|
| `server/ar/ar-aging.ts` | 221 | Yardi "Aging Detail" + AppFolio "Aged Receivable Detail" parsers; explicitly rejects unsupported formats with a reason rather than mis-parsing |
| `server/ar/rent-manager-delinquency.ts` | 325 | The third format `ar-aging.ts` rejects |
| `server/ar/derive-ar-balances.ts` | 55 | Projects `tenantArrears` → `arBalances[]`; called from `applyOverlay` so it cannot drift |
| `server/ar/pdf-extract.ts` | — | Shared PDF→text step |
| `scripts/ar-import.ts` | 334 | Interactive import |
| `scripts/ar-import-headless.ts` | 486 | Unattended import, built for a scheduled task |

**`ar-import-headless.ts` already accepts `.xlsx`** (line 209 filters `.pdf` or `.xlsx`; ExcelJS imported at line 64; `isXlsx` branch at line 249) — the exact format of the eight files in `Business/A.R. Reports/`. It also notes the xlsx path is the only one with a reliable in-file as-of date.

**Verdict:** v02's "port four Python parsers to TypeScript" is unnecessary. The TypeScript parsers exist and are better guarded. The `_pipeline` Python copy is the redundant one.

### 2.2 §4.2 Match ladder — **EXISTS, and is better than the spec**

`server/ar/match-tenant.ts` (110 lines) returns `{leaseId, confidence, score, candidate, ambiguous}` with tiers `exact | high | low | none`. It handles entity-suffix drift (`Acme` vs `Acme, LLC`), `Last, First` vs `First Last` inversion, and PDF wrap/truncation. `ambiguous: true` when ≥2 leases tie at top score — always forcing human review.

v02's R1–R4 ladder is a re-description of this with different names. The existing version additionally carries a numeric score and an explicit ambiguity flag, neither of which v02 specified.

### 2.3 §4.3 Alias ledger + unmatched handling — **EXISTS**

- `server/ar/mapping-cache.ts` (51 lines) — persistent confirmed name→leaseId cache at `data/ar-mapping-cache.json`. **Carries a documented collision hazard in its own source:** `cacheKey()` deliberately keeps entity suffixes because `normalizeTokens()` would collapse `Apex LLC` and `Apex Inc` to one key, and a cache hit skips review entirely — silently mis-attributing one tenant's delinquency to another across runs.
- `server/ar/partition-confidence.ts` (142 lines) — splits auto-writable from review-required.
- `server/ar/merge-buckets.ts` (43 lines) — sums by leaseId before write, because the overlay write is REPLACE not accumulate, so without it parse order decides financial state.
- `server/ar/resolve-latest.ts` (186 lines) — `filterAgainstPersisted`, `isSafeToWrite`, `ambiguousTies`.

**Decision #5 was already implemented.** `ar-import-headless.ts` header: *"partition → AUTO-WRITE HIGH-CONFIDENCE ONLY · exact / high-≥2-token / cache-confirmed → write · everything else → review queue (never written)."* That is exactly the R1/R2-autonomous, R3/R4-propose rule ruled on 2026-08-16, shipped a month earlier.

### 2.4 §4.4 Detectors — **ALL FIVE EXIST**

`src/analytics/conditions.ts` is an 896-line condition engine. Emitted insight ids:

| v02 detector | Existing condition | Threshold |
|---|---|---|
| `escalation.ts` | `escalation-${leaseId}` | — |
| `holdover.ts` | `expired-*`, `lease-lapsed-*` (L-2), `lease-mtm-*` (L-3) | `lapsedHoldoverGraceDays: 0` |
| `renewalNotStarted.ts` | `lease-expiry-*` (L-1) | `expiryNoSignalDays: 90` |
| `arReconcile.ts` | `arrears-${leaseId}`, `ar-stale` | `arrearsMaterialUsd: 5000`, `arStalenessMaxDays: 35` |
| `insurance.ts` | `ins-*`, `ins-lapsed-*`, `ins-lapsed-live-*`, `ins-expiry-*`, `ins-gap-*`, `insurance-warehouse-drift-*` | `insuranceRenewWarnDays: 30` |
| `cam.ts` | *(correctly absent)* | — |

Plus signals v02 never proposed: `lease-undermarket-*` (L-4, fires only when a market rent is present — no fabrication), `rollover-concentration-*` (L-5), `refi-spread-*`, `dscr-*`, `ltv-governor-*`.

The L-family carries documented mutual-exclusion logic (L-1 future ≤90d vs L-2 past expiry; L-3 co-fires with L-2 at different severity and distinct ids) — the sort of false-positive discipline v02 proposed building.

**Critical:** `arrears-*` and `ar-stale` read `tenantArrears`, which has **0 entries**. The entire collections alert family is dormant for want of one import run.

### 2.5 §4.6 False-positive control — **PARTIAL**

- **Exception state machine — EXISTS.** `server/alerts/store.ts` + `src/contracts/alerts.ts` (`AlertInboxState`) + `applyAlertAction` in `src/brain/alerts-view.ts`. Atomic temp-file-then-rename writes; parse failure falls back to empty state.
- **Bulk-change tripwire — EXISTS, coarse.** `server/anomaly-floor.ts` refuses a lease-set write that is empty or removes >25% of the prior set. Canonical and consolidated 2026-07-26 after two reverts — Gabriel-directed, "mine should win." Do not duplicate it.
- **Convention ledger / definition epochs — MISSING.** Nothing records that the 2026-08-01 vacancy convention changed. The 25% floor would not have caught it (it was a definitional restatement, not a mass removal).
- **Time-derived field exclusion — unverified** in this audit.

### 2.6 §3 Regime registry — **EXISTS AND IS POPULATED**

`property_master.property_manager` in `data/warehouse/finance.sqlite`, plus `SourceSystem = z.enum(['quickbooks','yardi','rent-manager','appfolio','unknown'])` in `src/contracts/warehouse.ts:39`.

| PM firm | Properties | Platform |
|---|---|---|
| Kohr Royer Griffith | 1100 Rarig · 3034 Westerville · 3540 E 5th · 3875-3883 E Livingston · Sepich Portfolio | AppFolio |
| CRC | 1900 N Broadway · 9050 Red Branch | Yardi |
| SVN | 2203-2207 Northwood | RentManager |
| Thomas Park | 29000 Information Lane | Yardi |
| Peak Real Estate Partners | 9620 E State Route 350 | AppFolio |
| *(null)* | 55 New Plant Ct · 401 Sunburst Hwy · 7658 Fishel Dr N | self-managed |

**This independently confirms Gabriel's 2026-08-16 correction:** 3875-3883 E Livingston is Kohr Royer Griffith, not self-managed. The three nulls match his self-managed list exactly.

**Firm ≠ platform.** Kohr Royer Griffith / CRC / SVN / Thomas Park / Peak are the *firms* — who to email. AppFolio / Yardi / RentManager are the *software* — which parser applies. Both mappings are required and they are not the same axis. Spec v02 conflated them.

**Resolves both v02 §11 unknowns:** E Livingston → KRG/AppFolio. 9620 → Peak Real Estate Partners on AppFolio (not Venture Property Management, whose report in that deal folder is from 2025 and is stale).

### 2.7 §4.7 Instrumentation — **PARTIAL**

Present: atomic writes, fail-loud envelope parsing (`parse-snapshot-for-import.ts` throws rather than defaulting to empty, explicitly so an empty roster can never be mistaken for a verified-empty one), degraded-roster halt, `filterAgainstPersisted` TOCTOU guard.

Missing: the outside-in artifact-existence probe on a separate fleet, the run manifest, and the three-state `CLEAN / EXCEPTIONS / COVERAGE GAP` rendering contract.

---

## 3. Why the capability is dark

Five verified facts, in causal order:

1. `data/ar/` **does not exist** — the inbox directory was never created.
2. Nothing moves the eight `Business/A.R. Reports/*.xlsx` files (dated 7.15.2026) into an inbox.
3. `data/overlay.json` → `tenantArrears`: **0 entries**.
4. No mapping cache, no review queue on disk — `ar-import-headless.ts` has never completed a run.
5. Nothing schedules it.

Consequence: `arBalances[]` is empty, the `arrears-*` and `ar-stale` conditions never fire, and the daily brief's Section 4c collections block has no data. Meanwhile `_pipeline` computed a six-figure AR total ([amount redacted]) from the same eight files on 2026-07-17 and wrote it to a standalone HTML dashboard nothing else reads.

---

## 4. What is actually missing

Ranked by value per unit of work.

| # | Gap | Size |
|---|---|---|
| 1 | **Nothing runs the AR import.** Inbox, file delivery, first run, scheduling. | Small |
| 2 | **PM rent-roll ingestion.** No billed-rent feed exists in either system, so lease-vs-billed leakage has never been checkable. This is the one thing v02 got right about the gap. | Large — external dependency on 5 PM firms |
| 3 | **Convention ledger / definition epochs.** The 08-01 vacancy restatement is unrecorded; `anomaly-floor.ts` would not have caught it. | Small |
| 4 | **Exception-report artifact.** Run manifest, three-state rendering, per-property coverage line, Notion Ops Hub output. | Medium |
| 5 | **Outside-in probe** on a separate fleet. | Small |
| 6 | **`mapping-cache.ts` collision hazard** — documented in source, unfixed. | Small |
| 7 | **9510 Persimmon Tree Rd is absent from `property_master`** (14 rows, but one is `1851-s-club-solar`, a project not a property). | Small |
| 8 | **CAM under-recovery** — still unbuildable, no recovery-type or pro-rata-share fields anywhere. | Blocked |

---

## 5. Corrections to spec v02

| v02 claim | Reality |
|---|---|
| Port Python parsers to TypeScript (decision #2) | TS parsers already exist; the Python copy is redundant. Decision #2 is moot. |
| Build the R1–R4 match ladder | `match-tenant.ts` implements this with confidence tiers, scoring, and ambiguity detection. |
| Build an alias ledger; grant R1/R2 autonomy (decision #5) | `mapping-cache.ts` + `partition-confidence.ts` already implement exactly this rule. |
| Build five detectors | All five exist in `conditions.ts`, with mutual-exclusion logic v02 did not specify. |
| Build a regime registry | `property_master.property_manager` exists and is populated; it corroborates Gabriel's correction. |
| Build an exception state machine | `AlertInboxState` + `applyAlertAction` exist. |
| Build a change tripwire | `anomaly-floor.ts` exists (coarse); only the convention-epoch layer is new. |
| "No scheduled process reconciles PM data against lease truth" | True, but the reason is an empty inbox, not a missing capability. |

---

## 6. Method note

This audit was commissioned because three successive discoveries — `_pipeline`, then `server/ar/`, then `conditions.ts` — each invalidated part of a plan already approved. The failure mode was writing a spec from a memory-and-doc reading of the system instead of from the system. The standing rule (`feedback_absence_claims_need_verification_before_building.md`: "nothing checks X" usually means it exists but is disconnected) was cited *in* v01 and still not applied to v01's own claims.

Recorded so the next spec starts from a capability audit rather than ending with one.
