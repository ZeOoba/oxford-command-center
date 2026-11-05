# Oxford Command Center — CLAUDE.md

> **IF YOU ARE AN AGENT: READ THIS ENTIRE FILE BEFORE TOUCHING ANY FILE IN THIS REPO.**
> This is not optional. This is not a formality. Skipping this file is the root cause of every architectural collision this project has experienced.

**Maintained by:** Lead Architect · **Last verified:** 2026-10-08 (§2 merge-history table and §3 merged-phase table collapsed to pointers; §6 gate list drift-checked by tests/unit/gate-scripts.test.ts since 2026-11-05)

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

## 2. Current Build State

| Item | State |
|------|-------|
| Branch | `main` (worktree tracking origin/main) |
| Merge history / open PRs / test count | Not tracked here (they go stale within days). Run `git log origin/main --oneline` and `gh pr list`. |
| Gate | `npm run gate` — steps listed in §6 (source of truth: `package.json`; drift-checked by `tests/unit/gate-scripts.test.ts`). CI runs `gate:ci`. |
| Uncommitted changes | Gabriel actively co-develops this tree — varies constantly |

**Off-limits rule (do NOT enumerate the locked set here — it goes stale the instant Gabriel commits; that staleness is itself a failure mode):**

> Run `git status` before editing anything. Treat **every uncommitted file you did not create** as locked — it is another writer's in-progress work. Re-read any shared file immediately before editing it. Commit only with explicit paths (never `git add -A`). Leave `main`/PR integration to Gabriel.

> **Shared-infra rule:** before touching a cross-cutting single-writer surface (`.github/workflows/*`, `.claude/settings.json`, `.gitignore`), check `architecture/status.json` for another session's in-progress claim and add your own entry first — two parallel sessions independently diagnosed the same CI breakage and collided on `ci.yml` (PRs #159/#161, 2026-07-05).

This is the single discipline that prevents the collision class this repo has already suffered. The canonical machine-readable ownership map is `architecture/ownership.json`; current declared activity is `architecture/status.json`.

---

## 3. Active Roadmap

**Do not start a phase without architect approval.**

**Shipped history:** Phases 1a, 1b, B/B2/B3–B5 (analytics + intelligence UI + calibration), C (briefings + PDF), 2 (debt/refi + AI narrative), 3 (forecast + leasing intelligence), 4 (Acquisition Intelligence Engine), 5 (Capital Allocation capstone, market intelligence, onboarding), Directions 1–3 (Notion writeback, IC memo HTML export, prospect demand) and Design Parity are all merged to `main`. This file does not carry per-phase status or PR numbers; for history read `docs/superpowers/plans/` (per-initiative plans) and `git log origin/main`.

**Open / pending:**

- **Acquisition Workbench UI:** last recorded here as "in progress" (contract + engine merged). Not re-verified in this pass — confirm against `git log` and `docs/superpowers/plans/` before relying on it.
- **Hurdle rate:** RATIFIED. The 8% unlevered IRR governor is ratified in code (`server/warehouse/intel-config.ts` `HURDLE_RATE`: `ratification: 'ratified'`, ratified by Gabriel Goldberg, 2026-06-22) and by migration `017_ratify_hurdle_rate.sql`, which seeds the same state into `capital_config`. `advisoryOnly` on the capital-allocation verdict engine (`server/warehouse/capital-allocation.ts`) reads `config.hurdleRateRatification === 'proposed'` from the live DB row at runtime, so it resolves `false` on any warehouse with migration 017 applied (not re-verified against the live `data/warehouse/finance.sqlite`). `src/modules/intel/CapexIrrCalc.tsx`'s "not yet ratified" comment is a deliberate guard for a dormant `isProposed` banner ("Latent today — the live rate is ratified") — not stale, do not remove it.
- **Placeholder fixtures:** P4c (insurance self-insure/deductible) and C2 tax refinements (cost-seg/filed-returns metadata) are BUILT on clearly-marked placeholder fixtures (`docs/placeholder-data.md`) pending real broker/assessor data — swap via `warehouse:import-loss-runs`; basis data needs a future migration.
- **Next initiative:** TBD.

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
governance   → validates CLAUDE.md + architecture files + OWNERSHIP.json + status.json
typecheck    → tsc --noEmit (strict + noUncheckedIndexedAccess)
lint         → eslint --max-warnings 0
check:dev-css → boots the real dev-mode (vite dev) CSS pipeline against theme.css to catch
                parse errors that production's Lightning CSS optimize() pass silently masks
check:css-tokens → every var(--name) under src/ has a definition under src/ (an undefined
                custom property fails silently in the browser; scripts/check-css-tokens.ts)
check:schema-drift → cross-references migration columns, a route's Zod request schema, and
                the values actually bound into its INSERT/UPDATE, so a renamed/reordered field
                that Zod silently strips or a column bound to the wrong field is caught directly
test         → vitest run (all unit tests)
reconcile:snapshot → validates the live snapshot against its own self-totals
reconcile    → $0-tolerance workbook self-totals check
reconcile:noi-crosscheck → Spine A vs Spine B NOI tie-out (server/warehouse/reconcile-noi.ts)
warehouse:verify → fresh SQLite in tmpdir + full file ingest + assertions
warehouse:drift  → compares the live warehouse against a fresh re-ingest, flags silent drift
```

(`package.json` is the source of truth for both scripts. `tests/unit/gate-scripts.test.ts`
fails if this list omits a `gate` step or describes one `gate` no longer has, or if `gate:ci` stops being exactly `gate` minus the
four local-only steps (reconcile, reconcile:noi-crosscheck, warehouse:verify, warehouse:drift)
plus build and check:bundle — so neither this list nor that relationship can drift silently.)

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
- **Gabriel's uncommitted files** (see the §2 off-limits rule) — treat as locked.
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
