# Schema Constraints 017/018 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add SQLite migrations 017 (unique index on `market_series`) and 018 (unique index + CHECK constraints on `recommendations` via table recreation), wire two warehouse-verify schema-presence assertions, and prove all constraints with a new vitest unit suite.

**Architecture:** These are deferred schema-quality constraints from the PR #117 CodeRabbit review. They were not folded into migrations 013/014 because those were already applied to live databases — new immutable migrations are the only correct path. Migration 017 is a plain `CREATE UNIQUE INDEX`. Migration 018 uses SQLite's table-recreation pattern (rename → recreate with CHECKs → copy → drop) because SQLite has no `ALTER TABLE ADD CONSTRAINT`.

**Tech Stack:** SQLite (better-sqlite3), TypeScript (strict), vitest.

## Global Constraints

- **No explicit `BEGIN`/`COMMIT` in any migration SQL.** `server/warehouse/migrate.ts` already wraps each migration in `db.transaction(() => { db.exec(sql); insertMigration.run(filename); })()`. A nested `BEGIN` inside an active better-sqlite3 transaction throws `cannot start a transaction within a transaction`. Migration 018's body is the bare DDL statements only.
- Never use `git add -A`; always commit with explicit file paths.
- The gate must be green: `npm run gate` = governance + typecheck + lint + test + reconcile + warehouse:verify.
- `review_needed: true` in `architecture/status.json` — migrations and `scripts/warehouse-verify.ts` are architect-owned. Set this and post `review_detail` (Task 1). Gabriel authorized this work in-session 2026-06-22; proceed without blocking on a separate ack, but the declaration must be committed.
- Migrations are append-only and immutable once written: 017 and 018 are new files; do NOT edit 013/014.
- TDD ordering: write the test suite and watch it FAIL before the migrations exist, then add migrations and watch it PASS.
- Branch: `claude/blissful-mendel-02834b`. Worktree: `C:\Users\Owner\oxford-command-center\.claude\worktrees\blissful-mendel-02834b`. HEAD at start = `6cd58ed` (= origin/main), clean.

## Failure Modes (verify before each step)

- **Nested transaction in 018** — top failure mode. The recreation DDL must have NO `BEGIN`/`COMMIT`. (Mitigated by Task 3 content.)
- **FK enforcement on `recommendations`** — `recommendations.property_id REFERENCES property_master(id)`. `openWarehouse` may enable `PRAGMA foreign_keys = ON`. Tests insert into `recommendations` directly, so each test that does so must first run `PRAGMA foreign_keys = OFF` on its db handle (simplest, avoids depending on property_master's full column set). This is per-connection state, so set it inside each test's db handle.
- **`column count mismatch` in 018 INSERT** — `INSERT INTO recommendations SELECT * FROM recommendations_old` requires the recreated table to have IDENTICAL column order/count to migration 014's table. The schema in Task 3 reproduces 014 column-for-column, in order, adding only CHECK clauses. Do NOT reorder or add columns.
- **Already-applied collision** — confirm `server/warehouse/migrations/` has no existing `017_*`/`018_*` file before writing (it does not, at HEAD `6cd58ed` — highest is `016`).

---

### Task 1: Claim the worktree in status.json

- [ ] Edit `architecture/status.json`. Add this entry at the top level of the object, immediately after the `"scope-b-regional"` block (before the final `"usage"` block). Match the existing two-space indentation. Replace `<time>` with the current UTC time in `HH:MM:SS` form.

```json
  "blissful-mendel-02834b": {
    "agent_role": "Engineering (Claude Code, Sonnet 4.6) — Gabriel-authorized 2026-06-22",
    "phase": "Schema constraints 017/018 — market_series unique index + recommendations CHECK constraints",
    "status": "in_progress",
    "blocked_by": null,
    "review_needed": true,
    "review_detail": "Migrations 017/018 and warehouse-verify.ts are architect-owned files. Content: (1) 017_market_series_constraints.sql adds ux_market_series_tuple unique index; (2) 018_recommendations_constraints.sql adds ux_recommendations_versioned unique index + CHECK constraints on expected_return_pct/timeline_months via table-recreation pattern (no explicit BEGIN/COMMIT — relies on migrate.ts outer transaction). Requesting architect ack before proceeding.",
    "last_updated": "2026-06-22T<time>Z"
  },
```

- [ ] The block immediately before it ends with `}` on its own line followed by a blank line then `"usage": {`. Insert the new block between `scope-b-regional`'s closing `},` and the `"usage"` key, keeping a trailing comma after the new block's closing brace.
- [ ] Commit with explicit path:

```bash
git -C "C:/Users/Owner/oxford-command-center/.claude/worktrees/blissful-mendel-02834b" add architecture/status.json
git -C "C:/Users/Owner/oxford-command-center/.claude/worktrees/blissful-mendel-02834b" commit -m "chore(status): claim blissful-mendel-02834b for schema constraints 017/018 (review_needed)

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

---

### Task 2: Migration 017 — market_series unique index

- [ ] Create `server/warehouse/migrations/017_market_series_constraints.sql` with EXACTLY this content:

```sql
-- Migration 017: market_series tuple uniqueness.
-- Deferred from PR #117 CR (migration 013 already applied to live DBs).
-- One observation per (cluster, as_of, source, metric); blocks duplicate market reads.
CREATE UNIQUE INDEX IF NOT EXISTS ux_market_series_tuple
  ON market_series (cluster, as_of, source, metric);
```

- [ ] Do NOT add `BEGIN`/`COMMIT`. Single statement; migrate.ts wraps it.

---

### Task 3: Migration 018 — recommendations constraints (table recreation)

- [ ] Create `server/warehouse/migrations/018_recommendations_constraints.sql` with EXACTLY this content. **No `BEGIN`/`COMMIT`** — migrate.ts provides the outer transaction. The recreated table reproduces migration 014's columns in identical order, adding CHECK clauses on `expected_return_pct` and `timeline_months`:

```sql
-- Migration 018: recommendations integrity constraints.
-- Deferred from PR #117 CR (migration 014 already applied to live DBs).
-- SQLite has no ALTER TABLE ADD CONSTRAINT; recreate the table.
-- NO BEGIN/COMMIT here — migrate.ts wraps every migration in db.transaction(); a
-- nested BEGIN throws "cannot start a transaction within a transaction".
ALTER TABLE recommendations RENAME TO recommendations_old;

CREATE TABLE recommendations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  property_id TEXT NOT NULL REFERENCES property_master(id) ON DELETE CASCADE,
  action TEXT NOT NULL CHECK (action IN ('buy','hold','sell','refinance','improve')),
  expected_return_pct REAL CHECK (expected_return_pct IS NULL OR (expected_return_pct >= -1.0 AND expected_return_pct <= 5.0)),
  risk_band TEXT NOT NULL CHECK (risk_band IN ('low','moderate','elevated','high')),
  timeline_months INTEGER CHECK (timeline_months IS NULL OR timeline_months > 0),
  confidence REAL NOT NULL CHECK (confidence BETWEEN 0 AND 1),
  inputs_version TEXT NOT NULL,
  advisory_only INTEGER NOT NULL DEFAULT 1,
  reasons_json TEXT NOT NULL DEFAULT '[]',
  as_of TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

INSERT INTO recommendations SELECT * FROM recommendations_old;
DROP TABLE recommendations_old;

CREATE UNIQUE INDEX IF NOT EXISTS ux_recommendations_versioned
  ON recommendations (property_id, as_of, inputs_version);
CREATE INDEX IF NOT EXISTS ix_recommendations_property
  ON recommendations (property_id, as_of);
```

- [ ] Verify the column list matches migration 014 (`server/warehouse/migrations/014_recommendations.sql`) column-for-column and in the same order — the bare `INSERT ... SELECT *` depends on it. (014's columns, in order: id, property_id, action, expected_return_pct, risk_band, timeline_months, confidence, inputs_version, advisory_only, reasons_json, as_of, created_at.)
- [ ] `ix_recommendations_property` is recreated because `DROP TABLE recommendations_old` drops 014's index of the same name along with the old table; re-adding it preserves the original index.

---

### Task 4: Write the test suite (TDD — write FIRST, watch it fail)

- [ ] Create `tests/unit/schema-constraints-017-018.test.ts` with EXACTLY this content:

```typescript
// @vitest-environment node
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';

function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'schema-017-018-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

// recommendations.property_id has a FK to property_master; tests insert synthetic
// property ids, so disable FK enforcement on the connection under test.
function insertMarketSeries(
  db: WarehouseDb,
  row: { cluster: string; as_of: string; source: string; metric: string; value?: number },
): void {
  db.prepare(
    `INSERT INTO market_series (cluster, as_of, source, metric, value, confidence)
     VALUES (@cluster, @as_of, @source, @metric, @value, 0.9)`,
  ).run({ value: null, ...row });
}

function insertRecommendation(
  db: WarehouseDb,
  row: {
    property_id?: string;
    action?: string;
    expected_return_pct?: number | null;
    risk_band?: string;
    timeline_months?: number | null;
    confidence?: number;
    inputs_version?: string;
    as_of?: string;
  },
): void {
  db.prepare(
    `INSERT INTO recommendations
       (property_id, action, expected_return_pct, risk_band, timeline_months, confidence, inputs_version, as_of)
     VALUES (@property_id, @action, @expected_return_pct, @risk_band, @timeline_months, @confidence, @inputs_version, @as_of)`,
  ).run({
    property_id: 'prop-1',
    action: 'hold',
    expected_return_pct: 0.1,
    risk_band: 'low',
    timeline_months: 12,
    confidence: 0.8,
    inputs_version: 'v1',
    as_of: '2026-06-01',
    ...row,
  });
}

describe('migration 017 — market_series unique index', () => {
  it('rejects a duplicate (cluster, as_of, source, metric) tuple', () => {
    const db = freshDb();
    const tuple = { cluster: 'OH', as_of: '2026-06-01', source: 'FRED', metric: 'unemp' };
    insertMarketSeries(db, tuple);
    expect(() => insertMarketSeries(db, tuple)).toThrow();
  });

  it('allows rows that differ in the metric component', () => {
    const db = freshDb();
    const base = { cluster: 'OH', as_of: '2026-06-01', source: 'FRED' };
    expect(() => {
      insertMarketSeries(db, { ...base, metric: 'unemp' });
      insertMarketSeries(db, { ...base, metric: 'cap_rate' });
    }).not.toThrow();
  });

  it('exposes the ux_market_series_tuple index in sqlite_master', () => {
    const db = freshDb();
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ux_market_series_tuple'")
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe('ux_market_series_tuple');
  });
});

describe('migration 018 — recommendations constraints', () => {
  it('rejects a duplicate (property_id, as_of, inputs_version) tuple', () => {
    const db = freshDb();
    db.exec('PRAGMA foreign_keys = OFF');
    insertRecommendation(db, { property_id: 'p', as_of: '2026-06-01', inputs_version: 'v1' });
    expect(() =>
      insertRecommendation(db, { property_id: 'p', as_of: '2026-06-01', inputs_version: 'v1' }),
    ).toThrow();
  });

  it('allows two rows for the same property/as_of with different inputs_version', () => {
    const db = freshDb();
    db.exec('PRAGMA foreign_keys = OFF');
    expect(() => {
      insertRecommendation(db, { property_id: 'p', as_of: '2026-06-01', inputs_version: 'v1' });
      insertRecommendation(db, { property_id: 'p', as_of: '2026-06-01', inputs_version: 'v2' });
    }).not.toThrow();
  });

  it('accepts in-range expected_return_pct values (NULL, 0.0, -1.0, 5.0)', () => {
    const db = freshDb();
    db.exec('PRAGMA foreign_keys = OFF');
    const cases: Array<number | null> = [null, 0.0, -1.0, 5.0];
    cases.forEach((v, i) => {
      expect(() =>
        insertRecommendation(db, { expected_return_pct: v, inputs_version: `v${i}` }),
      ).not.toThrow();
    });
  });

  it('rejects out-of-range expected_return_pct values (-1.1 and 5.1)', () => {
    const db = freshDb();
    db.exec('PRAGMA foreign_keys = OFF');
    expect(() => insertRecommendation(db, { expected_return_pct: -1.1, inputs_version: 'a' })).toThrow();
    expect(() => insertRecommendation(db, { expected_return_pct: 5.1, inputs_version: 'b' })).toThrow();
  });

  it('accepts valid timeline_months values (NULL and 1)', () => {
    const db = freshDb();
    db.exec('PRAGMA foreign_keys = OFF');
    expect(() => insertRecommendation(db, { timeline_months: null, inputs_version: 'a' })).not.toThrow();
    expect(() => insertRecommendation(db, { timeline_months: 1, inputs_version: 'b' })).not.toThrow();
  });

  it('rejects non-positive timeline_months values (0 and -1)', () => {
    const db = freshDb();
    db.exec('PRAGMA foreign_keys = OFF');
    expect(() => insertRecommendation(db, { timeline_months: 0, inputs_version: 'a' })).toThrow();
    expect(() => insertRecommendation(db, { timeline_months: -1, inputs_version: 'b' })).toThrow();
  });

  it('exposes the ux_recommendations_versioned index in sqlite_master', () => {
    const db = freshDb();
    const idx = db
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='ux_recommendations_versioned'")
      .get() as { name: string } | undefined;
    expect(idx?.name).toBe('ux_recommendations_versioned');
  });
});
```

- [ ] Confirm the `WarehouseDb` type is exported from `server/warehouse/db.ts` and that `openWarehouse` runs migrations on open (the same pattern `tests/unit/insurance-persistence.test.ts` relies on). If `WarehouseDb` is not a named export, read `server/warehouse/db.ts` and adjust the import to the correct type name — do NOT invent one.
- [ ] Run ONLY the new test BEFORE creating the migrations to confirm it fails for the right reason (missing index / missing CHECK), proving the test has teeth. If migrations are already created at this point because of task ordering, instead confirm by reasoning that the assertions map 1:1 to the migration DDL. Preferred TDD path: stash/hold migrations, run:

```bash
cd "C:/Users/Owner/oxford-command-center/.claude/worktrees/blissful-mendel-02834b" && npx vitest run tests/unit/schema-constraints-017-018.test.ts
```

Expect failures (no `ux_*` index; CHECK rejections not raised). Then proceed to confirm migrations (Tasks 2–3) make them pass (Task 5).

---

### Task 5: Verify the new tests pass

- [ ] With migrations 017 and 018 in place, run the new suite:

```bash
cd "C:/Users/Owner/oxford-command-center/.claude/worktrees/blissful-mendel-02834b" && npx vitest run tests/unit/schema-constraints-017-018.test.ts
```

- [ ] All 10 tests must pass. If `migration 018` tests throw on INSERT with a `NOT NULL`/`column count` error rather than the CHECK error, the recreated table column order does not match 014 — fix Task 3, do not loosen the test.
- [ ] If a duplicate-tuple test does NOT throw, the unique index did not apply — confirm `openWarehouse` ran migration 017/018 (check `server/warehouse/migrate.ts` migration discovery globs `*.sql` in `MIGRATIONS_DIR`).

---

### Task 6: Update warehouse-verify.ts schema assertions

- [ ] Edit `scripts/warehouse-verify.ts`. After the migration-016 block (section `8l.`, the `property_onboarding` check ending around line 358) and before the `// 9. Re-ingest smoke` comment, insert a new section `8m.`:

```typescript
    // 8m. Migration 017/018 schema presence — constraint indexes must exist.
    const marketSeriesTupleIdx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='ux_market_series_tuple'",
    ).get() as { name: string } | undefined;
    if (!marketSeriesTupleIdx) {
      failures.push('ux_market_series_tuple index missing — migration 017 did not apply');
    }
    const recommendationsVersionedIdx = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='index' AND name='ux_recommendations_versioned'",
    ).get() as { name: string } | undefined;
    if (!recommendationsVersionedIdx) {
      failures.push('ux_recommendations_versioned index missing — migration 018 did not apply');
    }
```

- [ ] Update the final summary `console.log` string (the PASSED line, after the `property_onboarding`/`prospect_demand_events` clauses). Locate the closing clause of that template string and append two clauses before the final `` ` `` and `)`. The string currently ends with the `prospect_demand_events schema present (migration 012)` clause; the actual current tail may include 013–016 clauses — append after whatever the last clause is. Add:

```typescript
      `, ux_market_series_tuple index present (migration 017)` +
      `, ux_recommendations_versioned index present (migration 018)`
```

Concretely, change the tail so it reads (preserving whatever clauses already precede it):

```typescript
      `prospect_demand_events schema present (migration 012), ` +
      `ux_market_series_tuple index present (migration 017), ` +
      `ux_recommendations_versioned index present (migration 018)`);
```

- [ ] If the summary string's last clause is NOT the `prospect_demand_events` one (later migrations may have appended clauses), append the two new clauses after the genuine last clause instead — read the lines around the `console.log('\nwarehouse:verify PASSED` call first and splice cleanly. The required end state: the two new clauses appear, comma-separated, as the final two clauses of the PASSED summary, and the string is still syntactically valid (the final clause has no trailing comma before the closing backtick).

---

### Task 7: Run the full gate

- [ ] Run the complete gate from the worktree:

```bash
cd "C:/Users/Owner/oxford-command-center/.claude/worktrees/blissful-mendel-02834b" && npm run gate
```

- [ ] All steps must be green: governance, typecheck (`tsc --noEmit`, strict + noUncheckedIndexedAccess), lint (`eslint --max-warnings 0`), test (full vitest suite, expect 1696 = 1686 + 10 new), reconcile, warehouse:verify (must print the two new clauses in its PASSED line).
- [ ] `warehouse:verify` builds a fresh SQLite in `os.tmpdir()` and ingests 32 files; the new `8m.` assertions confirm migrations 017/018 applied to that fresh DB. If they fail there but pass in the unit suite, the migration files are not being discovered by the verify path's migration runner — investigate `runMigrations`/migration glob, do not weaken the assertion.
- [ ] If lint flags the new test file (e.g. unused import, `any` cast), fix the code, not the lint config. Capture the green gate output as evidence before claiming done.

---

### Task 8: Commit and open PR

- [ ] Commit all four files with explicit paths (status.json already committed in Task 1; if it has further edits, include it):

```bash
cd "C:/Users/Owner/oxford-command-center/.claude/worktrees/blissful-mendel-02834b"
git add server/warehouse/migrations/017_market_series_constraints.sql \
        server/warehouse/migrations/018_recommendations_constraints.sql \
        tests/unit/schema-constraints-017-018.test.ts \
        scripts/warehouse-verify.ts
git commit -m "feat(warehouse): migrations 017/018 — market_series + recommendations constraints

017: ux_market_series_tuple unique index on (cluster, as_of, source, metric).
018: ux_recommendations_versioned unique index on (property_id, as_of,
inputs_version) + CHECK constraints on expected_return_pct ([-1.0, 5.0] or NULL)
and timeline_months (> 0 or NULL) via SQLite table-recreation (no explicit
BEGIN/COMMIT — relies on migrate.ts outer transaction). Deferred from PR #117 CR
because 013/014 were already applied to live DBs.

warehouse-verify: assert both constraint indexes present on the fresh-ingest DB.
+10 unit tests covering unique-index enforcement and CHECK bounds.

Co-Authored-By: Claude Sonnet 4.6 <noreply@anthropic.com>"
```

- [ ] Push and open the PR against `main`:

```bash
git push -u origin claude/blissful-mendel-02834b
gh pr create --base main --title "feat(warehouse): schema constraints 017/018 — market_series + recommendations" --body "$(cat <<'EOF'
## Summary
Deferred PR #117 CodeRabbit schema-quality follow-ups, shipped as new immutable migrations (013/014 were already applied to live DBs, so they can't be edited).

- **Migration 017** — `ux_market_series_tuple` unique index on `market_series (cluster, as_of, source, metric)`.
- **Migration 018** — `ux_recommendations_versioned` unique index on `recommendations (property_id, as_of, inputs_version)` + CHECK constraints on `expected_return_pct` (`NULL` or `[-1.0, 5.0]`) and `timeline_months` (`NULL` or `> 0`), applied via SQLite table-recreation. No explicit `BEGIN`/`COMMIT` — relies on `migrate.ts`'s outer `db.transaction()` wrapper.
- **warehouse-verify** — two new schema-presence assertions (`8m.`) + summary-line clauses confirming both indexes exist on the fresh-ingest DB.

## Files changed
- `server/warehouse/migrations/017_market_series_constraints.sql` (new)
- `server/warehouse/migrations/018_recommendations_constraints.sql` (new)
- `scripts/warehouse-verify.ts` (architect-owned — Gabriel-authorized 2026-06-22)
- `tests/unit/schema-constraints-017-018.test.ts` (new, +10 tests)
- `architecture/status.json` (worktree claim)

## Tests
10 new unit tests: 017 unique-index enforcement (dup rejected, distinct allowed, presence) and 018 (dup rejected, distinct version allowed, `expected_return_pct` in/out of range, `timeline_months` valid/invalid, index presence). Full gate green.

## Architect note
Migrations and `warehouse-verify.ts` are architect-owned; `status.json` carries `review_needed: true` with detail. Gabriel authorized this work in-session 2026-06-22.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

- [ ] After the PR is opened, update `architecture/status.json`: set this worktree's `status` to `review_needed` remains accurate (PR open, awaiting review) — leave `review_needed: true`. Do NOT merge; leave integration to Gabriel.

---

## Done Criteria

- [ ] `architecture/status.json` carries the `blissful-mendel-02834b` entry with `review_needed: true`.
- [ ] `server/warehouse/migrations/017_market_series_constraints.sql` and `018_recommendations_constraints.sql` exist; 018 has NO `BEGIN`/`COMMIT`.
- [ ] `tests/unit/schema-constraints-017-018.test.ts` has 10 passing tests.
- [ ] `scripts/warehouse-verify.ts` asserts both `ux_*` indexes and prints them in its PASSED summary.
- [ ] `npm run gate` green with command output captured as evidence.
- [ ] PR opened against `main`; not merged.
