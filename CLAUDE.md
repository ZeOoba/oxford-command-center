# Oxford Command Center — CLAUDE.md

> **IF YOU ARE AN AGENT: READ THIS ENTIRE FILE BEFORE TOUCHING ANY FILE IN THIS REPO.**
> This is not optional. This is not a formality. Skipping this file is the root cause of every architectural collision this project has experienced.

**Maintained by:** Lead Architect · **Last verified:** 2026-06-21 (§2/§3 build-state rows and §6 gate step list refreshed 2026-07-06 to reflect the design-parity merge and the true 7-step gate; rest of file not re-audited)

---

## 0. Agent Pre-Flight Checklist

Before writing a single line of code, confirm:

- [ ] I know which **agent role** I am (see `architecture/agent-assignments.md`).
- [ ] I know which **files I own** and which files are **off-limits** to me.
- [ ] I know which **worktree** I am operating in (`git worktree list`).
- [ ] I have checked `architecture/status.json` for conflicts with other active agents.
- [ ] I have checked `architecture/agent-assignments.md` — if my task touches an Architect-owned file, I have set `review_needed: true` in STATUS.json and am waiting for acknowledgment.
- [ ] I know the **current build state** (see §2).
- [ ] I know the **active roadmap phase** (see §3).
- [ ] `npm run gate` was green on the commit I checked out.

**If any box is unchecked: STOP. Resolve it before proceeding.**

---

## 1. Architecture Summary

This is a **local-first investment intelligence platform**, not a web app. It runs entirely on one machine. There is no multi-tenant auth, no cloud database, no public API.

**Two data spines** (this is the single most important architectural fact):

- **Spine A — "Current State":** Master Workbook → ExcelJS → `PortfolioSnapshot` (Zod) → 18 client modules. This is the live, real-time spine.
- **Spine B — "Time Dimension":** Property P&L files (32 Excel/xlsm) → warehouse parser → SQLite (5 tables) → analytics engines → Intel module. This is the historical intelligence spine.

These two spines have one critical defect: `Property.noi` (Spine A) and `warehouse ledger NOI` (Spine B) are independent computations with no reconciliation check. You must never aggregate or compare them without explicit basis-matching. Phase 1a addressed this partially.

**Full architecture:** `architecture/system-overview.md`
**Database schema:** `architecture/database-schema.md`
**API contracts:** `architecture/api-contracts.md`
**Coding standards:** `architecture/coding-standards.md`
**Agent roles + file ownership:** `architecture/agent-assignments.md`

---

## 2. Current Build State (2026-06-22; last-merge row refreshed 2026-07-06)

| Item | State |
|------|-------|
| Branch | `main` (worktree tracking origin/main) |
| Most recent merge to main | PR #168 (`3278a2c`) — design-parity Waves 2/3 (insurance/tax/brain engines + 6 UI modules) |
| Recent merge history (newest first) | #168 → #155 (`a45ac30`, leasingRisk in IC memo — M6) → #129 (`5b81321`, ic-memo 501→live) → #117 (`6cd58ed`, Phase 5 Capital Allocation capstone) |
| Open PRs | *(none)* |
| Gate | governance + typecheck + lint + test + reconcile + warehouse:verify + warehouse:drift (7 steps — see §6) |
| Tests | 2253 vitest unit tests (independently re-verified 2026-07-06, after adding real coverage for parseWorkbook + lease-forecast-api + confidential.ts) |
| Uncommitted changes | Gabriel actively co-develops this tree — varies constantly |

**Off-limits rule (do NOT enumerate the locked set here — it goes stale the instant Gabriel commits; that staleness is itself a failure mode):**

> Run `git status` before editing anything. Treat **every uncommitted file you did not create** as locked — it is another writer's in-progress work. Re-read any shared file immediately before editing it. Commit only with explicit paths (never `git add -A`). Leave `main`/PR integration to Gabriel.

> **Shared-infra rule:** before touching a cross-cutting single-writer surface (`.github/workflows/*`, `.claude/settings.json`, `.gitignore`), check `architecture/status.json` for another session's in-progress claim and add your own entry first — two parallel sessions independently diagnosed the same CI breakage and collided on `ci.yml` (PRs #159/#161, 2026-07-05).

This is the single discipline that prevents the collision class this repo has already suffered. The canonical machine-readable ownership map is `architecture/ownership.json`; current declared activity is `architecture/status.json`.

---

## 3. Active Roadmap

**Do not start a phase without architect approval.**

| Phase | Description | Status |
|-------|-------------|--------|
| 1a | Basis discipline + NOI integrity gate | Shipped ✓ |
| 1b | FRED macro agent tool | Shipped ✓ |
| B (PR #13) | Analytics engine (growth/drivers/anomalies/benchmarks/scores) | **Merged ✓** — INTEL_CONFIG weights ratified 2026-06-14 |
| B2 (PR #14) | Intelligence UI | **Merged ✓** |
| B3/B4/B5 (PRs #34/#48/#50/#52/#76) | Calibration stack (005_calibration.sql, calibration.ts, src/modules/calibration/*) | **Merged ✓** — all on main |
| C | Briefings + PDF export (per-property + per-PM) | **Merged ✓** — PR #86; adversarial refute (opus-4.8, 3-lens) complete 2026-06-20 |
| Acq | Acquisition Workbench UI + scoring API | Contract + engine (PRs #25/#27) merged; Workbench UI in progress |
| 4 | **Acquisition Intelligence Engine** (firm priority #1) | **Merged ✓** — PRs #84/#85 (Steps 1–9); Notion UUID wired post-merge |
| 2 | Debt/Refi scoring + AI narrative briefings | **Merged ✓** — PRs #95/#96/#97 (Steps 1–6: migrations + scoring engine + API + Debt Scorecard UI) · #99 (W1: loan→property binding) · #101 (W2: AI narrative briefings Steps 7–11) |
| 3 | Forecast + Leasing intelligence | **W1+W2 Merged ✓** — PR #107 (W1: lease-forecast analytics + L-1..L-5 + leasingVelocity + migration 011) · PR #109 (W2: Leasing Intelligence UI); W3 (AI narrative) optional |
| 5 | Capital Allocation capstone + Market intelligence | **Merged ✓** — PRs #112/#113/#114/#116 (foundational) · **PR #117** (final capstone: 5-way verdict buy/hold/sell/refi/improve + Market Intelligence UI + Property Onboarding; 1686 tests; hurdle rate ratification pending Gabriel) |
| 3 | Forecast + Leasing intelligence | **Merged ✓** — PR #107 (W1) · PR #109 (W2) · PR #111 (W3: AI narrative leasing briefing) |
| 5 | Capital Allocation capstone + Market intelligence | **Merged ✓** — PR #117; W1 (engines + migrations 012-015 + contracts + calibration) · W2 (Capital Allocation UI) · W3 (Market Intelligence UI) · W4 (Property Onboarding); 1686 tests green; hurdle rate ratified 2026-06-22 |
| 5 · Track 2 | Parse-layer slug uniqueness enforcement | **Merged ✓** — PR #113; disambiguates colliding property ids at parse time (+8 tests) |
| 5 · Track 3 | Market intelligence — cap rate benchmarks | **Merged ✓** — PR #114; `CapRateBenchmark` contract + `getMacroMarketBenchmarks` + implied cap rate columns (impliedCapRate + capRateGap + capRatePercentile) in CapitalAllocationModule (+10 tests) |
| 5 · Scope B | Regional market dynamics — state unemployment via FRED | **Merged ✓** — PR #116; FRED state unemployment integration + regional dynamics enrichment |
| Direction 1 (PR #119) | Notion writeback for capital allocation decisions | **Merged ✓** — PR #119; syncCapitalActionsToNotion() pushes capitalAction + priorityScore to Notion Property Register (DB 24d6a531) via POST /capital-allocation/sync-notion |
| Direction 2 (PR #121) | IC Memo HTML export | **Merged ✓** — PR #121 |
| Direction 3 (PR #120) | Prospect Demand Intelligence foundation | **Merged ✓** — PR #120; migration 012 (prospect_demand_events) + ProspectDemandEvent contract + getProspectDemandReport engine + GET/POST /api/warehouse/prospect-demand routes + ProspectDemandModule UI (Demand Signals panel) |

| Design Parity (PRs #161/#166/#168) | Design-parity implementation: tier-board primitives, insights wiring + module, Grader UX, insurance analysis engine + UI, command-brain module, taxes module + assessor-data template, capital orphan fold (CapitalAllocationModule folded into CapitalModule) | **Merged ✓** — PR #161 (plan) → #166 (Waves 0/1) → #168 (Waves 2/3); independently re-verified 2026-07-06 on post-merge main (typecheck/lint/governance/build clean, full suite matched PR #168's claimed 2224/2224 exactly at that point — see §2 for the current total after subsequent audit-fix test additions) |

**Pending:** Hurdle rate ratification (8% unlevered IRR governor) pending Gabriel sign-off to upgrade from `advisoryOnly`. Phase 7 parity sweep MERGED via PR #169 (2026-07-06 — the previous version of this line was stale). P4c (insurance self-insure/deductible) and C2 tax refinements (cost-seg/filed-returns metadata) are BUILT on clearly-marked placeholder fixtures (docs/placeholder-data.md) pending real broker/assessor data — swap via warehouse:import-loss-runs; basis data needs a future migration. Next initiative TBD.

---

## 4. File Ownership (quick reference)

Full matrix in `architecture/agent-assignments.md`. The critical rules:

**Architect-only files** (post to STATUS.json before touching):
- `CLAUDE.md`, `architecture/`, `package.json`, `tsconfig.json`, `vite.config.ts`
- `server/index.ts`, `src/contracts/`, `src/analytics/engine.ts`
- `server/warehouse/db.ts`, `server/warehouse/migrate.ts`, `server/warehouse/migrations/`
- `scripts/governance-check.ts`

**Analytics Agent** owns `server/warehouse/metrics.ts`, `growth.ts`, `drivers.ts`, `anomalies.ts`, `benchmarks.ts`, `scores.ts`.

**Integration Agent** owns `server/warehouse/ingest.ts`, `detect.ts`, `mapping.ts`, `parse/`, all backfill/verify scripts.

**UX Agent** owns `src/modules/`, `src/charts/`, `src/shell/`, `src/primitives/`.

**Intelligence Agent** owns `server/ai/`, `server/alerts/`, `src/modules/intel/synthesis.ts`.

---

## 5. Worktree Setup Protocol

Every implementation agent must operate in its own isolated worktree. Never work on the shared main checkout unless you are the Lead Architect.

### Creating a new worktree

```bash
# From the main repo directory
git worktree add .claude/worktrees/<feature-name> -b <branch-name>

# Set a worktree-specific SQLite path (prevents WAL contention)
cd .claude/worktrees/<feature-name>
cp ../../worktree-env.example .env
# Edit .env: set WAREHOUSE_DB to a local path, e.g.:
# WAREHOUSE_DB=.claude/worktrees/<feature-name>/data/warehouse/finance.sqlite
```

### Claiming your worktree

Update `architecture/status.json`:
```json
{
  "worktree-name": {
    "agent_role": "Analytics Agent",
    "phase": "Phase B — analytics engine",
    "status": "in_progress",
    "blocked_by": null,
    "review_needed": false,
    "last_updated": "2026-06-13T10:00:00Z"
  }
}
```

### Before touching an Architect-owned file

1. Set `review_needed: true` in STATUS.json.
2. State specifically which file and why in `detail`.
3. Wait for acknowledgment before editing.

### Cleaning up

```bash
# After PR is merged
git worktree remove .claude/worktrees/<feature-name>
# Remove entry from STATUS.json and OWNERSHIP.json
```

---

## 6. Gate Requirements

**Every commit must leave `npm run gate` green.** The gate runs:

```
governance  → validates CLAUDE.md + architecture files + OWNERSHIP.json + status.json
typecheck   → tsc --noEmit (strict + noUncheckedIndexedAccess)
lint        → eslint --max-warnings 0
test        → vitest run (all unit tests)
reconcile   → $0-tolerance workbook self-totals check
warehouse:verify → fresh SQLite in tmpdir + 32 file ingest + assertions
warehouse:drift  → compares the live warehouse against a fresh re-ingest, flags silent drift
```

(This is the true 7-step `package.json` `gate` script — verify against it directly if this list
and `package.json` ever disagree; this file is documentation, not the source of truth.)

`warehouse:verify` uses `os.tmpdir()` — it never touches `data/warehouse/finance.sqlite`. Safe to run in any worktree.

**If any gate step fails:** Fix it before committing. Never `--no-verify`. Never skip the gate.

---

## 7. PR / Merge Protocol

### Standard PR

1. Branch from `main` (or the appropriate base branch for stacked PRs).
2. `npm run gate` green.
3. PR title: `type(scope): description` (match commit format).
4. PR body: list files changed, what tests cover it, any deferred items.
5. Validation Agent reviews before merge.
6. Squash-merge into main.

### Stacked PRs

When PR B depends on changes from PR A:

1. Branch B from A's branch (not from main).
2. PR B description: `Base branch: <A's branch>. Merge A first.`
3. Merge order: A → B. Never merge B before A.
4. If A's branch changes after B branches from it: rebase B onto the new A.

```bash
# Rebase stacked PR onto updated base
git -C .claude/worktrees/pfi-phase-b2 rebase --onto worktree-pfi-phase-b <old-base-commit> HEAD
```

### After your PR merges

1. Update STATUS.json: `"status": "merged"`.
2. Remove worktree: `git worktree remove .claude/worktrees/<name>`.
3. Update OWNERSHIP.json: remove the worktree entry.

---

## 8. Rollback Protocol

### Revert a bad commit (preferred — preserves history)

```bash
git revert <commit-sha> --no-edit
git push origin <branch>
```

### Reset to last good state (only if not yet pushed)

```bash
git reset --hard <last-good-sha>
```

### Emergency: revert a bad squash-merge to main

```bash
# Find the merge commit SHA
git log --oneline main | head -5
# Revert it
git revert -m 1 <merge-commit-sha> --no-edit
git push origin main
```

**Never `git push --force` on main.** If force-push is needed, escalate to Gabriel.

---

## 9. What NOT to Touch

The following will cause irreversible damage or confidentiality violations:

- **`data/overlay.json`** — user mutations; gitignored; don't commit or overwrite.
- **`data/warehouse/finance.sqlite`** — live warehouse; don't delete or run DDL against it directly; use migrations.
- **`confidential-terms.json`** — deal data; hook-blocked; never expose externally.
- **Gabriel's uncommitted files** (listed in §2) — treat as locked.
- **The gate** — never bypass (`--no-verify`); never remove a check without architect approval.
- **CORS config** (`server/index.ts`) — never relax the localhost-only rule.

---

## 10. Duplication Prevention

Before implementing any function, utility, or API route, search for existing implementations:

```bash
# Check for existing analytics functions
grep -r "function buildAnalytics\|export function" server/warehouse/metrics.ts

# Check for route conflicts
grep -r "app\.\(get\|post\|put\|delete\)" server/

# Check for duplicate type definitions
grep -r "export type\|export interface" src/contracts/
```

The governance gate (`scripts/governance-check.ts`) also scans for duplicate route prefixes. If it blocks you, don't work around it — fix the duplication.

---

## Quick Reference: Key Paths

| What | Where |
|------|-------|
| Zod contracts | `src/contracts/` |
| Analytics engine | `src/analytics/engine.ts` |
| Warehouse DB | `data/warehouse/finance.sqlite` (gitignored) |
| Warehouse path env | `WAREHOUSE_DB` |
| Overlay (write surface) | `data/overlay.json` (gitignored) |
| Property master seed | `server/warehouse/property-master.ts` |
| Account mapping seed | `docs/superpowers/specs/2026-06-12-pfi-account-mapping-seed.json` |
| Architecture lock files | `architecture/` |
| Worktree registry | `architecture/ownership.json` |
| Agent status bus | `architecture/status.json` |
| Implementation plans | `docs/superpowers/plans/` |
| Feature specs | `docs/superpowers/specs/` |
| Adversarial workflow | `.claude/workflows/refute-financial-change.js` |
