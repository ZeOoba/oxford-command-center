# Governance Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the multi-agent governance protocol operational — every rule enforced by automation, not by trust.

**Architecture:** 15 failure modes were identified in the protocol. Fixes fall into 4 independent tracks: (A) Foundation — CLAUDE.md + architecture lock files that don't exist; (B) Enforcement — a governance gate script that blocks `npm run gate` on violations; (C) Database integrity — a migration system replacing the silent `CREATE TABLE IF NOT EXISTS` DDL; (D) Coordination — an ownership registry and worktree status bus.

**Tech Stack:** TypeScript (tsx), Node.js fs, better-sqlite3, vitest.

---

## Failure Modes Addressed

| # | Failure | Fix |
|---|---------|-----|
| FM-1 | No CLAUDE.md | Task 2 |
| FM-2 | No /architecture lock files | Task 1 |
| FM-3 | Zero enforcement of any rule | Task 3 + 4 |
| FM-4 | SQLite WAL contention | Documented (already mitigated: verify uses tmpdir, backfill uses WAREHOUSE_DB env) |
| FM-5 | No ownership registry | Task 6 |
| FM-6 | Shared files unprotected | Task 1 (agent-assignments) + Task 2 (CLAUDE.md) |
| FM-7 | No database migration system | Task 5 |
| FM-8 | Architect/Validation roles undefined | Task 1 (agent-assignments) + Task 2 (CLAUDE.md) |
| FM-9 | No freshness enforcement | Task 3 (governance-check warns on stale arch files) |
| FM-10 | No claim-lock system | Task 6 (OWNERSHIP.json + STATUS.json) |
| FM-11 | No inter-agent communication | Task 6 (STATUS.json schema) |
| FM-12 | Gate doesn't validate governance | Task 3 + 4 (wired into npm run gate) |
| FM-13 | PR stacking undocumented | Task 2 (CLAUDE.md §PR Protocol) |
| FM-14 | No duplicate implementation detection | Task 3 (route-prefix duplication check) |
| FM-15 | Protocol not self-applying | Task 2 (CLAUDE.md reads on session start) |

---

## File Map

**Created:**
- `architecture/system-overview.md` — authoritative two-spine architecture reference
- `architecture/database-schema.md` — SQLite table definitions + migration numbering
- `architecture/api-contracts.md` — all Hono routes with request/response types
- `architecture/coding-standards.md` — TypeScript patterns, naming, testing conventions
- `architecture/agent-assignments.md` — role definitions + file ownership matrix
- `CLAUDE.md` — conductor file; every agent reads this first
- `scripts/governance-check.ts` — gate step: validates CLAUDE.md + arch files + ownership
- `tests/unit/governance-check.test.ts` — unit tests for governance-check
- `server/warehouse/migrations/001_initial.sql` — canonical schema as numbered migration
- `server/warehouse/migrate.ts` — migration runner (tracks applied, idempotent)
- `tests/unit/warehouse-migrate.test.ts` — migration system unit tests
- `.claude/worktrees/OWNERSHIP.json` — file ownership registry per worktree
- `.claude/worktrees/STATUS.json` — inter-agent status bus template
- `.env.worktree.example` — environment variable template for worktree isolation

**Modified:**
- `server/warehouse/db.ts` — replace inline DDL with `runMigrations(db)` call
- `package.json` — add `governance` script; prepend to `gate`

---

## Task 1: Architecture Lock Files

**Files:**
- Create: `architecture/system-overview.md`
- Create: `architecture/database-schema.md`
- Create: `architecture/api-contracts.md`
- Create: `architecture/coding-standards.md`
- Create: `architecture/agent-assignments.md`

- [ ] **Step 1:** Write `architecture/system-overview.md` — two-spine architecture, module map, server topology, data flow, current build state, and roadmap phase summary.
- [ ] **Step 2:** Write `architecture/database-schema.md` — all 5 SQLite tables with column types, constraints, indexes, migration numbers, and future layers (period_metrics, scores).
- [ ] **Step 3:** Write `architecture/api-contracts.md` — every Hono route with method, path, Zod input schema, response shape, and auth note (localhost-only CORS).
- [ ] **Step 4:** Write `architecture/coding-standards.md` — TypeScript strict rules, naming conventions (camelCase fns, PascalCase types, kebab-case files), test patterns, import ordering, commit message format.
- [ ] **Step 5:** Write `architecture/agent-assignments.md` — Lead Architect, Analytics Agent, Integration Agent, UX Agent, Intelligence Agent, Validation Agent roles with owned files, prohibited files, and activation criteria.
- [ ] **Step 6:** Commit.

```bash
git add architecture/
git commit -m "docs(governance): add architecture lock files (FM-2, FM-6, FM-8)"
```

---

## Task 2: CLAUDE.md Conductor File

**Files:**
- Create: `CLAUDE.md`

- [ ] **Step 1:** Write `CLAUDE.md` with sections: Agent Pre-Flight, Architecture Overview, Current Build State, Active Roadmap, File Ownership, Worktree Setup Protocol, Gate Requirements, PR/Merge Protocol, Rollback Protocol, What NOT to Touch.
- [ ] **Step 2:** Commit.

```bash
git add CLAUDE.md
git commit -m "docs(governance): add CLAUDE.md conductor file (FM-1, FM-13, FM-14, FM-15)"
```

---

## Task 3: Governance Gate Script

**Files:**
- Create: `scripts/governance-check.ts`
- Create: `tests/unit/governance-check.test.ts`

- [ ] **Step 1:** Write failing test for governance-check — test that it exits 1 when CLAUDE.md is missing, exits 1 when architecture files are missing, exits 0 when all present.

```typescript
// tests/unit/governance-check.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { runGovernanceCheck } from '../../scripts/governance-check';

describe('governance-check', () => {
  it('fails when CLAUDE.md is missing', () => { ... });
  it('fails when architecture files are missing', () => { ... });
  it('passes when all required files exist', () => { ... });
  it('warns (non-blocking) when arch file is older than 14 days', () => { ... });
});
```

- [ ] **Step 2:** Run test — confirm it fails (function not defined).
- [ ] **Step 3:** Write `scripts/governance-check.ts` — checks CLAUDE.md, architecture/ files, OWNERSHIP.json existence; warns on stale files; prints clear failure reason; exits 1 on any violation.
- [ ] **Step 4:** Run `vitest run tests/unit/governance-check.test.ts` — confirm green.
- [ ] **Step 5:** Commit.

```bash
git add scripts/governance-check.ts tests/unit/governance-check.test.ts
git commit -m "feat(governance): add governance-check gate script (FM-3, FM-9, FM-14)"
```

---

## Task 4: Wire Governance into Gate

**Files:**
- Modify: `package.json`

- [ ] **Step 1:** Add `"governance": "tsx scripts/governance-check.ts"` to scripts.
- [ ] **Step 2:** Prepend `npm run governance && ` to the `gate` script so it runs first.
- [ ] **Step 3:** Run `npm run governance` — confirm it passes (all files now exist).
- [ ] **Step 4:** Commit.

```bash
git add package.json
git commit -m "chore(governance): wire governance-check into npm run gate (FM-3, FM-12)"
```

---

## Task 5: Database Migration System

**Files:**
- Create: `server/warehouse/migrations/001_initial.sql`
- Create: `server/warehouse/migrate.ts`
- Create: `tests/unit/warehouse-migrate.test.ts`
- Modify: `server/warehouse/db.ts`

- [ ] **Step 1:** Write failing test for migrate.ts — test that running on empty DB applies migration 001, test that running twice doesn't duplicate, test that _migrations table is created.

```typescript
// tests/unit/warehouse-migrate.test.ts
import { describe, it, expect } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';

describe('runMigrations', () => {
  it('applies 001_initial on first run', () => { ... });
  it('is idempotent — second call applies nothing new', () => { ... });
  it('creates _migrations tracking table', () => { ... });
  it('applies migrations in numeric order', () => { ... });
});
```

- [ ] **Step 2:** Run test — confirm it fails.
- [ ] **Step 3:** Create `server/warehouse/migrations/001_initial.sql` with the full current SCHEMA DDL.
- [ ] **Step 4:** Write `server/warehouse/migrate.ts` — creates `_migrations` table, reads `migrations/*.sql` files sorted numerically, applies unapplied ones transactionally, records completion.
- [ ] **Step 5:** Modify `server/warehouse/db.ts` — replace `db.exec(SCHEMA)` with `import { runMigrations } from './migrate'; runMigrations(db);`. Remove the inline SCHEMA constant.
- [ ] **Step 6:** Run `vitest run tests/unit/warehouse-migrate.test.ts` — confirm green.
- [ ] **Step 7:** Run `npm run gate` — confirm nothing broken.
- [ ] **Step 8:** Commit.

```bash
git add server/warehouse/migrations/ server/warehouse/migrate.ts server/warehouse/db.ts tests/unit/warehouse-migrate.test.ts
git commit -m "feat(warehouse): add migration system — replaces silent CREATE TABLE IF NOT EXISTS (FM-7)"
```

---

## Task 6: Coordination Infrastructure

**Files:**
- Create: `.claude/worktrees/OWNERSHIP.json`
- Create: `.claude/worktrees/STATUS.json`
- Create: `.env.worktree.example`

- [ ] **Step 1:** Write `.claude/worktrees/OWNERSHIP.json` — maps each active worktree to: owned modules, owned file patterns, prohibited file patterns, active PR, and current status.
- [ ] **Step 2:** Write `.claude/worktrees/STATUS.json` — template schema for agents to write their status: worktree name, phase, blocked_by, review_needed, last_updated.
- [ ] **Step 3:** Write `.env.worktree.example` — documents WAREHOUSE_DB, ANTHROPIC_API_KEY, FINANCIALS_DIR with worktree-specific path examples.
- [ ] **Step 4:** Commit.

```bash
git add .claude/worktrees/OWNERSHIP.json .claude/worktrees/STATUS.json .env.worktree.example
git commit -m "docs(governance): add coordination infrastructure — ownership registry + status bus (FM-5, FM-10, FM-11)"
```

---

## Task 7: Run Gate + Final Verification

- [ ] **Step 1:** Run `npm run gate` — must be fully green (typecheck + lint + test + reconcile + warehouse:verify + governance).
- [ ] **Step 2:** Verify test count increased by the new migration + governance tests.
- [ ] **Step 3:** Confirm `CLAUDE.md` exists and is readable.
- [ ] **Step 4:** Confirm `architecture/` has all 5 files.
- [ ] **Step 5:** Final commit if any loose files remain.
