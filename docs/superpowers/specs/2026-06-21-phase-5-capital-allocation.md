# Phase 5 — Capital Allocation Capstone

**Author:** Claude Code Sonnet 4.6 (architect-approval artifact)  
**Date:** 2026-06-21  
**Status:** Implementation in progress (`feat/phase-5-capital-allocation`)

---

## Goal

Synthesize all existing intelligence streams (Spine A property data, Phase 2 debt scores, Phase 3 leasing signals, existing per-property health/attention/capital scores) into a unified Capital Allocation Capstone module. The output is a single ranked list showing which properties receive capital priority and why, plus a FRED macro context banner.

**Success criteria:**
- `GET /api/warehouse/capital-allocation` returns a `CapitalAllocationReport` sorted by `priorityScore DESC`
- Every entry has explicit `noiBasis: 'spine-a'` tagging (ownership layer, not the Spine-B analytics layer)
- Debt urgency and leasing risk components are derived from Phase 2/3 engines without duplicating their logic
- Macro context pulls FRED live and falls back to seeded data (fail-open)
- `CapitalAllocationModule` renders in the sidebar under Capital group after Debt
- Gate: typecheck 0, lint 0, 1603+ tests passing, adversarial refute pass (financial-decision code)

---

## Data model

No new SQLite tables. This is a **pure synthesis layer** — it reads from:
- `brain.getSnapshot()` → Spine A properties + leases + renewalStages + tenantArrears + marketRents
- `scoreProperties(db, metrics)` → per-property health/attention/capitalAction scores
- `scoreDebtPositions(db, metrics, null)` → per-property debt scores (null market rate = fail-safe for this layer)
- `renewalSignals(leases, asOf, renewalStages, arrears)` → per-lease renewal likelihood signals
- `getMacro()` → FRED macro context (fail-open)

---

## New contracts

### `src/contracts/capital-allocation.ts` (new file)

```text
CapitalAllocationEntry  — per-property synthesis row
MacroContext            — FRED macro snapshot subset
CapitalAllocationReport — top-level report envelope
```

**`CapitalAllocationEntry`** fields:
- Identity: `propertyId`, `propertyName`, `market`, `sf`
- Synthesis output: `capitalAction` (from scores.ts), `priorityScore` (0–100 composite)
- Health component: `healthScore`, `attentionScore` (from scores.ts)
- Leasing component: `nearTermExpiryRent`, `atRiskLikelihoodCount`
- Debt component: `debtScore`, `balloonMonths`, `dscr` (null when no debt)
- Rationale: up to 3 strings
- NOI context: `noi`, `noiPerSf`, `noiBasis: 'spine-a'`

**`MacroContext`** fields: `tenYearRate`, `cpi`, `source: 'fred'|'mock'`, `asOf`

**`CapitalAllocationReport`** fields: `asOf`, `propertyCount`, `entries` (sorted), `portfolioNoi`, `portfolioNoBasis: 'spine-a'`, breakdown counts, `macro`

Export via `src/contracts/index.ts`.

---

## Priority score formula

**This is financial-decision code. Adversarial refute is MANDATORY before merge.**

```text
priorityScore = clamp(
  (100 - healthScore) * 0.35
  + attentionScore * 0.30
  + leasingRiskComponent * 0.20
  + debtUrgencyComponent * 0.15,
  0, 100
)
```

Where:
- `healthScore`, `attentionScore`: from scores.ts (null → 50 neutral, never 0)
- `leasingRiskComponent = min(100, (nearTermExpiryRent / noi) * 100 + atRiskLikelihoodCount * 10)`, capped at 50 when `noi === 0`
- `debtUrgencyComponent`: 0 when no debt; else `clamp(max(0, 100 - (balloonMonths / 12) * 10) + (dscr < 1.25 ? 30 : 0), 0, 100)`

Weight rationale:
- 0.35 health deficit: primary signal for capital need
- 0.30 attention: urgency driver from anomalies + growth
- 0.20 leasing risk: near-term revenue exposure
- 0.15 debt urgency: balloon + DSCR pressure (relevant for ~40% of portfolio with debt)

**Attention score mapping** (from attentionBand in scores.ts):
```text
green  → 0
yellow → 33
orange → 66
red    → 100
```

---

## API contracts

```text
GET /api/warehouse/capital-allocation
→ CapitalAllocationReport (200)
→ { error: 'warehouse unavailable' } (503)
→ { error: 'snapshot unavailable' } (503)
→ { error: 'capital allocation failed', detail: string } (500)
```

Route is mounted under the existing `/api/warehouse` prefix in `server/warehouse/api.ts` — no governance-check registration needed (already covered by existing `/api/warehouse/` prefix).

---

## Implementation plan

| Step | File | What |
|------|------|------|
| Step 0 | `docs/superpowers/specs/…` | This document |
| Step 1 | `src/contracts/capital-allocation.ts` | Zod contracts |
| Step 1b | `src/contracts/index.ts` | Add export |
| Step 2 | `server/warehouse/capital-allocation.ts` | Synthesis engine |
| Step 3 | `server/warehouse/api.ts` | Route `GET /capital-allocation` |
| Step 4 | `src/modules/capital/CapitalAllocationModule.tsx` | UI module |
| Step 4b | `src/shell/modules.tsx` | Register module |
| Step 5 | `tests/unit/capital-allocation.test.ts` | TDD unit tests (written first) |
| Step 6 | `architecture/status.json` | Claim worktree |

---

## Test strategy

Tests in `tests/unit/capital-allocation.test.ts` using in-memory SQLite + vi.mock:
- `buildCapitalAllocationReport` with 3-property mock → 3 entries sorted DESC
- Property with no debt → `debtScore: null`, `debtUrgencyComponent = 0`
- Property with health=20, attention=80 → high priorityScore
- Property with health=90, attention=10, no leasing risk, no debt → low priorityScore
- Null health/attention → treated as 50 (neutral)
- `leasingRiskComponent` when `noi = 0` → capped at 50
- Contract: `CapitalAllocationReport.parse()` rejects `portfolioNoBasis !== 'spine-a'`
- Contract: `MacroContext.parse()` with `source: 'fred'` → passes
- getMacro() throws → macro = `{ tenYearRate: null, cpi: null, source: 'mock', asOf: null }`

---

## Deferred (not in scope for this PR)

- Market intelligence layer (FRED trend charts, cap rate benchmarks)
- Per-property capital plan notes
- Export to PDF / IC memo
- Writeback to Notion (capital action decisions)
