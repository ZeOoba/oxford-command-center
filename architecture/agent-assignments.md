# Agent Assignments — Oxford Command Center

**Status:** Architecture lock file — every feature must have exactly one owner. No agent may modify files outside its ownership boundary without architect approval.

**Claim protocol:** Before editing any file, check this document. If the file is "Architect-owned," post in `architecture/status.json` with `review_needed: true` before editing.

---

## Role Definitions

### Lead Architect

**Purpose:** Architecture, standards, ownership boundaries, roadmap, merge approvals, cross-module consistency.
**Implements:** Minimal. Reviews, plans, audits, approves.
**Final authority on:** Schema changes, new API routes, new module creation, changes to gate scripts, changes to `CLAUDE.md` or `architecture/`.

**Activation criteria:** Required before any PR touches: `server/warehouse/db.ts`, `server/warehouse/migrate.ts`, `server/warehouse/migrations/`, `src/contracts/`, `architecture/`, `CLAUDE.md`, `package.json`, `tsconfig.json`, `vite.config.ts`, `server/index.ts`.

---

### Analytics Agent

**Owns:** Warehouse computation layer, metrics, benchmarks, scores, drivers, anomalies, growth engines.

**Files owned:**
```
server/warehouse/metrics.ts
server/warehouse/growth.ts
server/warehouse/drivers.ts
server/warehouse/anomalies.ts
server/warehouse/benchmarks.ts
server/warehouse/scores.ts
server/warehouse/intel-config.ts
server/warehouse/queries.ts
server/warehouse/data-quality.ts
tests/unit/warehouse-*.test.ts  (analytics subset)
```

**Prohibited files (requires architect sign-off):**
```
server/warehouse/db.ts
server/warehouse/migrate.ts
server/warehouse/migrations/
server/warehouse/ingest.ts
server/warehouse/mapping.ts
```

---

### Integration Agent

**Owns:** External data ingestion, parsers, workbook, macro, document RAG, QB adapter.

**Files owned:**
```
server/warehouse/ingest.ts
server/warehouse/detect.ts
server/warehouse/raw-store.ts
server/warehouse/mapping.ts
server/warehouse/parse/
server/warehouse/property-master.ts
server/brain.ts
server/workbook/
server/macro/
server/sources/
scripts/warehouse-backfill.ts
scripts/warehouse-verify.ts
scripts/bake-mirror.ts
scripts/reconcile.ts
scripts/extract-workbook.ts
```

**Prohibited files:**
```
server/warehouse/metrics.ts
server/warehouse/scores.ts
src/contracts/        (read-only — contract changes require architect)
server/index.ts       (read-only — route mounting requires architect)
```

---

### UX Agent

**Owns:** All React modules, charts, shell, primitives, animations.

**Files owned:**
```
src/modules/
src/charts/
src/shell/
src/primitives/
src/brain/AiPanel.tsx
src/brain/EntityDrawer.tsx
src/brain/CommandPalette.tsx
tests/unit/*-view.test.ts
tests/unit/*.test.tsx
tests/e2e/
```

**Prohibited files:**
```
server/            (read-only)
src/analytics/     (read-only — analytics changes belong to Analytics Agent)
src/contracts/     (read-only — contract changes require architect)
src/data/          (read-only — client data layer belongs to Core)
```

---

### Intelligence Agent

**Owns:** AI agent tools, synthesis, briefings, the Intel module's intelligence layer.

**Files owned:**
```
server/ai/
server/alerts/
src/modules/intel/synthesis.ts
src/modules/intel/INTEL_CONFIG.ts
```

**Prohibited files:**
```
server/warehouse/   (read-only — computation is Analytics Agent territory)
src/modules/intel/  (except synthesis.ts and INTEL_CONFIG.ts — UI is UX Agent)
```

---

### Validation Agent

**Purpose:** Code review, security review, architecture review, performance review, duplication detection. Does NOT implement features.

**May read:** All files.
**May write:** Nothing in production code. Write only to `architecture/status.json`.
**Activation:** Required before any PR merges to `main`. Runs `npm run gate` + adversarial review.

---

### Testing Agent

**Owns:** Test infrastructure, vitest config, playwright config, test utilities.

**Files owned:**
```
vitest.config.ts
playwright.config.ts
tests/setup.ts
tests/helpers/
```

**May add tests to:** Any `tests/unit/` or `tests/e2e/` file.
**May not modify:** Production source files.

---

## Architect-Owned Files (require explicit architect approval to modify)

These files affect every agent. Changes require posting `review_needed: true` in `architecture/status.json` and waiting for architect acknowledgment.

```
CLAUDE.md
architecture/
package.json
tsconfig.json
tsconfig.node.json
vite.config.ts
server/index.ts
src/contracts/index.ts
src/contracts/warehouse.ts
src/analytics/engine.ts       (single metric source of truth)
scripts/governance-check.ts
server/warehouse/db.ts
server/warehouse/migrate.ts
server/warehouse/migrations/
```

---

## Active Worktree Assignments

| Worktree | Branch | Owner Role | PR | Status |
|----------|--------|------------|----|----|
| `feat/pfi-phase-1-foundation` | main checkout | Lead Architect | Pending | Gabriel review required |
| `.claude/worktrees/pfi-phase-b` | `worktree-pfi-phase-b` | Analytics Agent | #13 | Awaiting review |
| `.claude/worktrees/pfi-phase-b2` | `worktree-pfi-phase-b2` | UX Agent | #14 | Stacked on #13; awaiting review |

**Merge order:** #13 (Phase B analytics engine) → #14 (Phase B2 intelligence UI). Never merge #14 before #13.

---

## File Ownership Matrix

| File pattern | Owner | Can be modified by |
|-------------|-------|-------------------|
| `server/warehouse/db.ts` | Architect | Architect only |
| `server/warehouse/migrate.ts` | Architect | Architect only |
| `server/warehouse/migrations/` | Architect | Architect only |
| `server/warehouse/metrics.ts` | Analytics | Analytics + Architect |
| `server/warehouse/parse/` | Integration | Integration + Architect |
| `src/contracts/` | Architect | Architect only |
| `src/analytics/engine.ts` | Architect | Architect only |
| `src/modules/*/` | UX | UX + Architect |
| `src/modules/intel/synthesis.ts` | Intelligence | Intelligence + Architect |
| `server/ai/` | Intelligence | Intelligence + Architect |
| `server/index.ts` | Architect | Architect only |
| `package.json` | Architect | Architect only |
| `tsconfig.json` | Architect | Architect only |
| `architecture/` | Architect | Architect only |
| `CLAUDE.md` | Architect | Architect only |
| `tests/unit/` | Testing | Any agent (test additions) |
