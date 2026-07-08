# Item E — WORKBOOK_PATH / OneDrive Dual-Library Mismatch: Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `npm run extract`, `npm run reconcile`, `npm run bake`, `npm run warehouse:backfill`, `npm run warehouse:verify`, and `npm run warehouse:drift` (and therefore `npm run gate`, which chains four of these) resolve the workbook, documents corpus, QuickBooks CSV, and property-financials paths to the OneDrive library that actually has the data on this machine — and make `.env` overrides for those paths actually take effect everywhere, which today they silently do not.

**Architecture:** No new components. Two mechanical layers: (1) correct three wrong path values and add two missing ones in the machine-local, gitignored `.env`; (2) fix a real, verified defect where `server/config.ts` computes `WORKBOOK_PATH` as an eagerly-evaluated module constant, so any `.env` override is silently discarded — convert it to a lazily-evaluated getter (mirroring the existing, already-correct `overlayPath()` pattern in `server/overlay.ts`) and thread the call-site change through every consumer. Three sibling scripts have the same "no `.env` override reaches this script at all" problem for a *different* reason (they never call `loadEnvFile()`) — that's a simpler, same-file fix.

**Tech Stack:** TypeScript, Node ESM (`"type": "module"`), `tsx` runtime, Vitest.

## Origin

[`docs/superpowers/plans/2026-07-07-capital-allocation-ts1005-followups-handoff.md`](2026-07-07-capital-allocation-ts1005-followups-handoff.md), Item E (lines 220–244): flagged 2026-07-07 that `WORKBOOK_PATH`'s default and `.env`'s `DOCUMENTS_DIR`/`QUICKBOOKS_CSV` point at a OneDrive library that's missing the master workbook on this machine. Per that doc: **"Gabriel's answer when asked (2026-07-07): not aware of the split — flag it, don't fix now."** This plan is the follow-up fix, written 2026-07-08 at Gabriel's request, after re-verifying Item E's finding from scratch (per that doc's own warning that its facts may have drifted) and tracing the problem one layer deeper than the original flag did.

**Everything below was re-verified against this machine's live filesystem and the real repo source on 2026-07-08 — re-check before acting if this plan is executed later than that.**

## Root Cause (three distinct, independently-confirmed defects)

### 1. Wrong OneDrive library, confirmed by direct filesystem inspection

Two OneDrive libraries exist side by side on this machine:

| | `OneDrive - Oxford Capital Partners (1)` (current hardcoded/`.env` target) | `OneDrive - Oxford Capital Partners` (no suffix — this session's own cwd) |
|---|---|---|
| `eric spreadsheets\Master Excel Template Company Wide -- Oxford.xlsx` | **absent** — no `eric spreadsheets` folder at all | **present** |
| `Quickbooks Backups -- CURRENT FILES\ora-pl-by-property.csv` | **absent** — no such folder | **present** |
| `Property Financials\` | **absent** | **present** |
| Any of the ~40 property subfolders in `.env`'s `DOCUMENTS_INCLUDE_DIRS` (e.g. `9050 Red Branch Rd`, `1900 North Broadway`, `2203-2207 Northwood`) | **zero matches** | **all present** |
| Top-level contents | Only generic OneDrive system folders (`Apps`, `Attachments`, `Desktop`, `Documents`, `Meetings`, `Pictures`, `Recordings`, `Whiteboards`, `Claude_Workspace`) plus loose individual files dumped at root (leases, LOIs, one-off docs — several with `(1)`/`(2)` dedup suffixes, consistent with an interrupted/partial OneDrive re-sync) | Full real business folder tree |

Conclusion: the `(1)`-suffixed library is an incomplete/partial sync on this machine — plausibly from a OneDrive re-link tied to the pending machine migration (per session context) — and is not usable as a data source here. The no-suffix library is the real one and happens to already be this session's own working directory.

### 2. Three scripts never call `loadEnvFile()` at all

`scripts/warehouse-backfill.ts`, `scripts/warehouse-verify.ts`, and `scripts/warehouse-live-drift-check.ts` each read `process.env.FINANCIALS_DIR` with their own inline hardcoded fallback to the `(1)`-suffixed `Property Financials` folder — and none of them ever load `.env`. Confirmed via `grep -L loadEnvFile scripts/*.ts | xargs grep -l FINANCIALS_DIR`. So even a correct `.env` value would never reach these three scripts; only a real OS-level environment variable would.

**These three are wired into `npm run gate`** (`package.json`: `"gate": "npm run governance && npm run typecheck && npm run lint && npm run test && npm run reconcile && npm run warehouse:verify && npm run warehouse:drift"`) — meaning **`npm run gate` is very likely currently broken on this machine**, not just "would fail if someone ran extract manually." This raises Item E's priority above where the original 2026-07-07 flag placed it.

### 3. A real, verified ES-module ordering bug in `server/config.ts` (the deeper defect Item E's original author didn't check)

`server/config.ts` computes `WORKBOOK_PATH` as an eagerly-evaluated top-level `const`:

```ts
export const WORKBOOK_PATH =
  process.env.WORKBOOK_PATH ??
  join(homedir(), 'OneDrive - Oxford Capital Partners (1)', 'eric spreadsheets', 'Master Excel Template Company Wide -- Oxford.xlsx');
```

`server/index.ts` calls `loadEnvFile()` (which populates `process.env` from `.env`) *and* imports `./config` — with the `loadEnvFile()` call textually positioned before the `config` import. **This does not work.** Under ES module semantics (this repo is `"type": "module"`), all of a file's static `import`s are evaluated — in the order first encountered — before any of that file's own top-level statements run, regardless of where those statements sit in the source. So `config.ts`'s module body (including its `WORKBOOK_PATH` computation) always runs before `loadEnvFile()`'s call statement in `index.ts`, no matter the source ordering.

This is not a theoretical concern — it was empirically proven against the real repo files, twice:

- A throwaway probe script (`import { loadEnvFile } from './server/load-env'; loadEnvFile('.env.hoisttest'); import { WORKBOOK_PATH } from './server/config';`, run via `npx tsx`, with a temp `.env.hoisttest` setting `WORKBOOK_PATH=HOIST_TEST_OVERRIDE_VALUE`) showed `process.env.WORKBOOK_PATH` correctly became `HOIST_TEST_OVERRIDE_VALUE`, but `config.ts`'s exported `WORKBOOK_PATH` constant still showed the hardcoded `(1)`-library default. Proves the override never reaches the constant.
- The same probe against the **real, unmodified `.env`** (which already has a real `QUICKBOOKS_CSV=` line, wrongly pointing at the `(1)` library) showed `config.ts`'s exported `QUICKBOOKS_CSV` constant is `null` (its coded fallback) even though `process.env.QUICKBOOKS_CSV` correctly holds the `.env` value.

Note on scope: `config.ts` also exports `QUICKBOOKS_CSV`, but that export is **dead code** — grepped the whole repo, nothing imports it (`server/brain.ts` imports only `SNAPSHOT_PATH, WORKBOOK_PATH` from `./config`). The real QuickBooks-actuals code path, `server/sources/quickbooks.ts`'s `loadQuickbooks()`, reads `process.env.QUICKBOOKS_CSV` *directly, inside a function body* — correctly lazy, called well after server startup's `loadEnvFile()` has run, so it is **not** affected by this bug. Likewise `server/sources/documents.ts`'s `DOCUMENTS_DIR` reads are all inside function bodies/parameter defaults (lazy) — also unaffected. **`WORKBOOK_PATH` is the only config.ts export that is both actively consumed and affected by this bug.** This is exactly the pattern `server/overlay.ts` already worked around — its `overlayPath()` function has a code comment explicitly explaining why it reads `process.env.OVERLAY_PATH` at call time rather than module load time. That fix was never applied to `config.ts`.

**Practical effect today:** even after Task 1 below corrects `.env`'s values, `WORKBOOK_PATH`-consuming entry points (the live Brain Server, `npm run extract`, `npm run reconcile`, `npm run bake`) would **still** silently use the wrong hardcoded default, because the `.env` override never reaches them. This is why Task 1 alone is necessary but not sufficient.

## Global Constraints

- `.env` is gitignored, machine-local — Task 1's edits do not affect any other machine or get committed. Never print its full contents (it holds live secrets: `ANTHROPIC_API_KEY`, `NOTION_TOKEN`, `GRAPH_CLIENT_SECRET`, `COMPOSIO_API_KEY`) into any log, doc, or commit.
- No changes to `server/warehouse/capital-allocation.ts` or any financial-calculation/governor logic — this plan touches only path-resolution plumbing.
- Repo is currently clean on `main`, up to date with `origin/main` (verified via `git status`/`git log` before starting this investigation) — safe to work directly on `main` or an isolated worktree per the shared-checkout single-writer rule; re-verify `git status` immediately before starting Task 1 if time has passed.
- `npm run gate` chains `reconcile`, `warehouse:verify`, `warehouse:drift` — treat a green `npm run gate` as this plan's overall Definition of Done, not just the individual npm scripts named in Item E.
- **Before touching anything:** re-run the existence checks in Task 1's Step 1 fresh — this plan's snapshot of "which library has what" could be stale by the time it's executed (mirrors the original handoff doc's own warning).
- **CI compatibility (verified during formal review):** `.github/workflows/full-gate-selfhosted.yml` runs `npm run gate` on a self-hosted runner with `WORKBOOK_PATH`/`FINANCIALS_DIR` set as real OS environment variables (not `.env` — the runner has no `.env`, it's gitignored). This plan's changes are compatible as-is: `loadEnvFile()` only fills env vars that are missing or empty (`server/load-env.ts:23`), so already-set OS vars always win, and `workbookPath()`/the `FINANCIALS_DIR` consts read `process.env` at call/module-eval time regardless of whether `.env` exists. No CI-specific change needed.
- **`loadEnvFile()` resolves `.env` relative to `process.cwd()`.** Every script this plan touches is invoked via `npm run <script>`, which guarantees repo-root cwd — fine today. Worth remembering if a future scheduled task ever invokes one of these scripts directly (not via `npm run`) from a different working directory, since `.env` would then silently fail to load.

---

### Task 1: Correct the machine-local `.env` OneDrive library paths

**Files:**
- Modify: `C:\Users\Owner\oxford-command-center\.env` (gitignored, not tracked by git — no commit for this task)

**Interfaces:**
- Produces: four corrected/added env vars (`DOCUMENTS_DIR`, `QUICKBOOKS_CSV`, `WORKBOOK_PATH`, `FINANCIALS_DIR`) that Tasks 2 and 3 depend on being correct.

- [ ] **Step 1: Re-verify current state fresh (facts may have drifted)**

Run:
```bash
cd "/c/Users/Owner/oxford-command-center"
find "/c/Users/Owner/OneDrive - Oxford Capital Partners/eric spreadsheets" -maxdepth 1 -iname "Master Excel Template*"
find "/c/Users/Owner/OneDrive - Oxford Capital Partners/Quickbooks Backups -- CURRENT FILES" -iname "ora-pl-by-property.csv"
find "/c/Users/Owner/OneDrive - Oxford Capital Partners/" -maxdepth 1 -iname "Property Financials"
```
Expected: all three print a matching path (confirmed present as of 2026-07-08). If any comes back empty, **stop** — the target paths below are wrong and need re-deriving before continuing.

- [ ] **Step 2: Edit `.env`**

Change this existing line:
```
DOCUMENTS_DIR=C:\Users\Owner\OneDrive - Oxford Capital Partners (1)
```
to:
```
DOCUMENTS_DIR=C:\Users\Owner\OneDrive - Oxford Capital Partners
```

Change this existing line:
```
QUICKBOOKS_CSV=C:\Users\Owner\OneDrive - Oxford Capital Partners (1)\Quickbooks Backups -- CURRENT FILES\ora-pl-by-property.csv
```
to:
```
QUICKBOOKS_CSV=C:\Users\Owner\OneDrive - Oxford Capital Partners\Quickbooks Backups -- CURRENT FILES\ora-pl-by-property.csv
```

Add two new lines (currently absent — these fall through to `config.ts`'s/the scripts' own wrong hardcoded defaults today) — place them near the `DOCUMENTS_DIR` block for locality:
```
WORKBOOK_PATH=C:\Users\Owner\OneDrive - Oxford Capital Partners\eric spreadsheets\Master Excel Template Company Wide -- Oxford.xlsx
FINANCIALS_DIR=C:\Users\Owner\OneDrive - Oxford Capital Partners\Property Financials
```

- [ ] **Step 3: Verify the edit parses correctly**

`server/load-env.ts`'s parser is a simple `KEY=VALUE` line regex with no special quoting for backslashes or spaces — confirm it round-trips correctly:
```bash
cd "/c/Users/Owner/oxford-command-center"
cat > .env-parse-probe.ts <<'EOF'
import { loadEnvFile } from './server/load-env';
loadEnvFile();
console.log('WORKBOOK_PATH:', process.env.WORKBOOK_PATH);
console.log('FINANCIALS_DIR:', process.env.FINANCIALS_DIR);
console.log('DOCUMENTS_DIR:', process.env.DOCUMENTS_DIR);
console.log('QUICKBOOKS_CSV:', process.env.QUICKBOOKS_CSV);
EOF
npx tsx .env-parse-probe.ts
rm .env-parse-probe.ts
```
Expected: all four print the no-suffix-library paths from Step 2, with no truncation at the ` -- ` or the space before `(1)`-less path.

- [ ] **Step 4: No commit** — `.env` is gitignored; confirm it's not staged:
```bash
git status --short | grep -i "^\S* \.env$" || echo "confirmed: .env not tracked/staged"
```

---

### Task 2: Wire `loadEnvFile()` into the three `FINANCIALS_DIR` scripts

These three read `process.env.FINANCIALS_DIR` as their own same-file top-level `const` (not imported from `config.ts`), so — unlike Task 3's problem — a `loadEnvFile()` call placed before that `const` in the *same file* works correctly (no cross-module import-hoisting is involved; only the constant, not a static import, needs to come after).

**Files:**
- Modify: `C:\Users\Owner\oxford-command-center\scripts\warehouse-backfill.ts:1-13`
- Modify: `C:\Users\Owner\oxford-command-center\scripts\warehouse-verify.ts:21-38`
- Modify: `C:\Users\Owner\oxford-command-center\scripts\warehouse-live-drift-check.ts:12-23`

**Interfaces:**
- Consumes: `loadEnvFile` from `server/load-env.ts` (`export function loadEnvFile(path = '.env'): void`) — already exists, no changes needed to it.
- Produces: all three scripts' `FINANCIALS_DIR` constant resolves the corrected `.env` value from Task 1 instead of the hardcoded `(1)`-library fallback.

- [ ] **Step 1: `scripts/warehouse-backfill.ts` — add the load-env import + call before the const**

Current (lines 1–14):
```ts
// scripts/warehouse-backfill.ts
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { openWarehouse } from '../server/warehouse/db';
import type { WarehouseDb } from '../server/warehouse/db';
import { ingestFile } from '../server/warehouse/ingest';
import { seedMappingsFromFile } from '../server/warehouse/mapping';
import { seedPropertyMaster } from '../server/warehouse/property-master';
import { seedLeaseTerms } from '../server/warehouse/lease-terms';
import { noiMatrix } from '../server/warehouse/queries';

const FINANCIALS_DIR = process.env.FINANCIALS_DIR
  ?? 'C:/Users/Owner/OneDrive - Oxford Capital Partners (1)/Property Financials';
const DB_PATH = process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
```

Change to:
```ts
// scripts/warehouse-backfill.ts
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { loadEnvFile } from '../server/load-env';
import { openWarehouse } from '../server/warehouse/db';
import type { WarehouseDb } from '../server/warehouse/db';
import { ingestFile } from '../server/warehouse/ingest';
import { seedMappingsFromFile } from '../server/warehouse/mapping';
import { seedPropertyMaster } from '../server/warehouse/property-master';
import { seedLeaseTerms } from '../server/warehouse/lease-terms';
import { noiMatrix } from '../server/warehouse/queries';

loadEnvFile();

const FINANCIALS_DIR = process.env.FINANCIALS_DIR
  ?? 'C:/Users/Owner/OneDrive - Oxford Capital Partners (1)/Property Financials';
const DB_PATH = process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
```

(The hardcoded `(1)`-library fallback stays as-is — it's now genuinely a fallback-of-last-resort, only reached if `.env` has no `FINANCIALS_DIR`. Not touching it here; see Task 5 for the fallback-value question.)

- [ ] **Step 2: `scripts/warehouse-verify.ts` — same pattern**

Current (lines 21–24, after the file's existing header comment):
```ts
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse } from '../server/warehouse/db';
```
...
```ts
const FINANCIALS_DIR = process.env.FINANCIALS_DIR
  ?? 'C:/Users/Owner/OneDrive - Oxford Capital Partners (1)/Property Financials';
```

Add the import alongside the existing `node:fs`/`node:os`/`node:path` imports, and the call immediately before the `FINANCIALS_DIR` const:
```ts
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from '../server/load-env';
import { openWarehouse } from '../server/warehouse/db';
```
...
```ts
loadEnvFile();

const FINANCIALS_DIR = process.env.FINANCIALS_DIR
  ?? 'C:/Users/Owner/OneDrive - Oxford Capital Partners (1)/Property Financials';
```

- [ ] **Step 3: `scripts/warehouse-live-drift-check.ts` — same pattern**

Current (lines 12–23):
```ts
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openWarehouse } from '../server/warehouse/db';
import { ingestFile } from '../server/warehouse/ingest';
import { seedMappingsFromFile } from '../server/warehouse/mapping';
import { seedPropertyMaster } from '../server/warehouse/property-master';
import { basisDrift, committedBasisMap } from '../server/warehouse/live-drift';

const FINANCIALS_DIR = process.env.FINANCIALS_DIR
  ?? 'C:/Users/Owner/OneDrive - Oxford Capital Partners (1)/Property Financials';
const LIVE_DB = process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
```

Change to:
```ts
import Database from 'better-sqlite3';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadEnvFile } from '../server/load-env';
import { openWarehouse } from '../server/warehouse/db';
import { ingestFile } from '../server/warehouse/ingest';
import { seedMappingsFromFile } from '../server/warehouse/mapping';
import { seedPropertyMaster } from '../server/warehouse/property-master';
import { basisDrift, committedBasisMap } from '../server/warehouse/live-drift';

loadEnvFile();

const FINANCIALS_DIR = process.env.FINANCIALS_DIR
  ?? 'C:/Users/Owner/OneDrive - Oxford Capital Partners (1)/Property Financials';
const LIVE_DB = process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
```

- [ ] **Step 4: Typecheck**

Run: `cd "C:\Users\Owner\oxford-command-center" && npm run typecheck`
Expected: 0 errors (these are additive import + call-statement changes only).

- [ ] **Step 5: Commit**

```bash
git add scripts/warehouse-backfill.ts scripts/warehouse-verify.ts scripts/warehouse-live-drift-check.ts
git commit -m "fix(warehouse): load .env before resolving FINANCIALS_DIR in backfill/verify/drift scripts"
```

---

### Task 3: Fix the root cause — make `WORKBOOK_PATH` a lazily-evaluated getter

This is the structural fix for defect #3. `TypeScript`'s compiler does the completeness-checking for us here: once `WORKBOOK_PATH` stops existing as a named export, every stale reference becomes a compile error — `npm run typecheck` is the checklist.

**Files:**
- Modify: `C:\Users\Owner\oxford-command-center\server\config.ts:1-15`
- Modify: `C:\Users\Owner\oxford-command-center\server\brain.ts:10,27,47,56-62,193,194,198`
- Modify: `C:\Users\Owner\oxford-command-center\scripts\extract-workbook.ts:1-8`
- Modify: `C:\Users\Owner\oxford-command-center\scripts\reconcile.ts:1-3,29-32`
- Modify: `C:\Users\Owner\oxford-command-center\scripts\bake-mirror.ts:1-6,29-34`
- Modify: `C:\Users\Owner\oxford-command-center\tests\unit\brain.test.ts:38-44`
- Modify: `C:\Users\Owner\oxford-command-center\AUDIT.md:35` (doc reference — stale after the rename)
- Test: `C:\Users\Owner\oxford-command-center\tests\unit\config.test.ts` (new)

**Interfaces:**
- Produces: `export function workbookPath(): string` from `server/config.ts`, replacing `export const WORKBOOK_PATH`. Every consumer changes `WORKBOOK_PATH` (bare identifier) → `workbookPath()` (call).
- `SNAPSHOT_PATH`, `SERVER_PORT`, `WORKBOOK_AS_OF` stay as-is (`const`) — not `.env`-overridden in current usage, not exhibiting this bug; converting them isn't needed for this fix and would only widen the diff.

- [ ] **Step 1: Write the failing test first**

Create `tests/unit/config.test.ts`:
```ts
import { describe, it, expect, afterEach } from 'vitest';
import { workbookPath } from '../../server/config';

describe('workbookPath()', () => {
  const original = process.env.WORKBOOK_PATH;

  afterEach(() => {
    if (original === undefined) delete process.env.WORKBOOK_PATH;
    else process.env.WORKBOOK_PATH = original;
  });

  it('re-reads process.env.WORKBOOK_PATH on every call, not just at module import time', () => {
    delete process.env.WORKBOOK_PATH;
    const before = workbookPath(); // establishes the module was already imported with no override

    process.env.WORKBOOK_PATH = '/tmp/late-set-override.xlsx';
    expect(workbookPath()).toBe('/tmp/late-set-override.xlsx');
    expect(workbookPath()).not.toBe(before);
  });

  it('falls back to the OneDrive default path when unset', () => {
    delete process.env.WORKBOOK_PATH;
    expect(workbookPath()).toContain('Master Excel Template Company Wide -- Oxford.xlsx');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cd "C:\Users\Owner\oxford-command-center" && npx vitest run tests/unit/config.test.ts`
Expected: **FAIL** — `workbookPath` is not exported from `server/config.ts` (only `WORKBOOK_PATH`, a const, exists today). This is the correct failure — proves the test is exercising code that doesn't exist yet, and (per the root-cause section above) would also fail an "old" `const`-based re-implementation, since a const captured at import time can't reflect an env var set inside the `it()` body afterward.

- [ ] **Step 3: Convert `server/config.ts`'s `WORKBOOK_PATH` to a lazy getter**

Current full file:
```ts
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The master workbook IS the company brain and the primary live data source.
 * Override with WORKBOOK_PATH env if the file moves.
 */
export const WORKBOOK_PATH =
  process.env.WORKBOOK_PATH ??
  join(
    homedir(),
    'OneDrive - Oxford Capital Partners (1)',
    'eric spreadsheets',
    'Master Excel Template Company Wide -- Oxford.xlsx',
  );

export const SNAPSHOT_PATH =
  process.env.SNAPSHOT_PATH ?? join(process.cwd(), 'data', 'snapshots', 'portfolio.json');

export const SERVER_PORT = Number(process.env.BRAIN_SERVER_PORT ?? 8911);

/** The workbook's stated "As of" date for v1 (the file carries June 1, 2026). */
export const WORKBOOK_AS_OF = process.env.WORKBOOK_AS_OF ?? '2026-06-01';

/** QuickBooks Desktop → SharePoint CSV export (P&L by property). Unset → /close shows no actuals. */
export const QUICKBOOKS_CSV = process.env.QUICKBOOKS_CSV ?? null;
```

Replace with:
```ts
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The master workbook IS the company brain and the primary live data source.
 * Override with WORKBOOK_PATH env if the file moves.
 *
 * Resolved at CALL time (not module load) — mirrors server/overlay.ts's overlayPath(). A
 * top-level `const` here would freeze in whatever process.env held when config.ts was first
 * imported, which happens (per ES module import evaluation order) before any importing
 * module's own loadEnvFile() call runs — silently discarding every .env override. Confirmed
 * empirically 2026-07-08: see docs/superpowers/plans/2026-07-08-workbook-path-dual-library-
 * and-env-loading-fix-plan.md.
 */
export function workbookPath(): string {
  return (
    process.env.WORKBOOK_PATH ??
    join(
      homedir(),
      'OneDrive - Oxford Capital Partners (1)',
      'eric spreadsheets',
      'Master Excel Template Company Wide -- Oxford.xlsx',
    )
  );
}

export const SNAPSHOT_PATH =
  process.env.SNAPSHOT_PATH ?? join(process.cwd(), 'data', 'snapshots', 'portfolio.json');

export const SERVER_PORT = Number(process.env.BRAIN_SERVER_PORT ?? 8911);

/** The workbook's stated "As of" date for v1 (the file carries June 1, 2026). */
export const WORKBOOK_AS_OF = process.env.WORKBOOK_AS_OF ?? '2026-06-01';
```

(`QUICKBOOKS_CSV` export removed — confirmed dead code, zero importers repo-wide; the real QuickBooks path is `server/sources/quickbooks.ts`'s `loadQuickbooks()`, which already reads `process.env.QUICKBOOKS_CSV` lazily and is unaffected by this bug. Removing rather than leaving it avoids leaving a second, subtly-broken-looking path-resolution export sitting next to the fixed one.)

- [ ] **Step 4: Update `server/brain.ts`'s import and all 6 call sites**

Line 10 — change:
```ts
import { SNAPSHOT_PATH, WORKBOOK_PATH } from './config';
```
to:
```ts
import { SNAPSHOT_PATH, workbookPath } from './config';
```

Line 27 — change:
```ts
    workbookPath: WORKBOOK_PATH,
```
to:
```ts
    workbookPath: workbookPath(),
```
(The `BrainState.workbookPath` property name is unrelated to the imported function name — this is `{ workbookPath: workbookPath() }`, valid TS, no shadowing.)

Line 47 — change:
```ts
      const { snapshot, flags } = await parseWorkbook(WORKBOOK_PATH);
```
to:
```ts
      const { snapshot, flags } = await parseWorkbook(workbookPath());
```

Lines 193–194 — change:
```ts
    if (!existsSync(WORKBOOK_PATH)) {
      this.setState({ lastError: `Workbook not found at ${WORKBOOK_PATH}` });
```
to:
```ts
    if (!existsSync(workbookPath())) {
      this.setState({ lastError: `Workbook not found at ${workbookPath()}` });
```

Line 198 — change:
```ts
    const watcher = watch(WORKBOOK_PATH, {
```
to:
```ts
    const watcher = watch(workbookPath(), {
```

**Additional fix found during formal review (Opus, 2026-07-08): `refresh()`'s success-path `setState` never updates `workbookPath`.** Verified: `BrainState.workbookPath` is set once, at `new Brain()` construction (the class-field initializer at line 27) — which, per this same defect #3, runs during `index.ts`'s import phase, *before* `loadEnvFile()`. `refresh()`'s success `setState` (lines 56–62) never touches `workbookPath`, so the live `/api/health` response would keep showing the stale pre-load default forever, even after this fix — a false "still broken" signal for anyone checking system health, independent of whether the actual workbook read is correct. Since `refresh()` runs at request/refresh time (well after `loadEnvFile()`), a fresh call there is safe and accurate.

Current (lines 56–62):
```ts
      this.setState({
        status: 'fresh',
        source: 'workbook',
        lastUpdated: new Date().toISOString(),
        lastError: null,
        flagCount: this.snapshot.dataQuality.length,
      });
```

Change to:
```ts
      this.setState({
        status: 'fresh',
        source: 'workbook',
        lastUpdated: new Date().toISOString(),
        lastError: null,
        flagCount: this.snapshot.dataQuality.length,
        workbookPath: workbookPath(),
      });
```

- [ ] **Step 5: Update `scripts/extract-workbook.ts`**

Current (lines 1–8):
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseWorkbook } from '../server/workbook/parse';
import { WORKBOOK_PATH, SNAPSHOT_PATH } from '../server/config';

async function main() {
  console.log(`→ Reading workbook: ${WORKBOOK_PATH}`);
  const { snapshot, flags } = await parseWorkbook(WORKBOOK_PATH);
```

Change to:
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { parseWorkbook } from '../server/workbook/parse';
import { loadEnvFile } from '../server/load-env';
import { workbookPath, SNAPSHOT_PATH } from '../server/config';

loadEnvFile();

async function main() {
  console.log(`→ Reading workbook: ${workbookPath()}`);
  const { snapshot, flags } = await parseWorkbook(workbookPath());
```

(This script had no `loadEnvFile()` call at all before — needed regardless of the getter fix, per defect #2's sibling issue for this specific script.)

- [ ] **Step 6: Update `scripts/reconcile.ts`**

Current (lines 1–3, 29–32):
```ts
import ExcelJS from 'exceljs';
import { parseWorkbook } from '../server/workbook/parse';
import { WORKBOOK_PATH } from '../server/config';
```
```ts
async function main() {
  const { snapshot } = await parseWorkbook(WORKBOOK_PATH);
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(WORKBOOK_PATH);
```

Change to:
```ts
import ExcelJS from 'exceljs';
import { parseWorkbook } from '../server/workbook/parse';
import { loadEnvFile } from '../server/load-env';
import { workbookPath } from '../server/config';

loadEnvFile();
```
```ts
async function main() {
  const { snapshot } = await parseWorkbook(workbookPath());
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(workbookPath());
```

- [ ] **Step 7: Update `scripts/bake-mirror.ts`**

Current (lines 1–6, 34):
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkbook } from '../server/workbook/parse';
import { getMacro } from '../server/macro/getMacro';
import { WORKBOOK_PATH } from '../server/config';
import type { PortfolioSnapshot } from '../src/contracts/index';
```
```ts
  const { snapshot: raw } = await parseWorkbook(WORKBOOK_PATH);
```

Change to:
```ts
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseWorkbook } from '../server/workbook/parse';
import { getMacro } from '../server/macro/getMacro';
import { loadEnvFile } from '../server/load-env';
import { workbookPath } from '../server/config';
import type { PortfolioSnapshot } from '../src/contracts/index';

loadEnvFile();
```
```ts
  const { snapshot: raw } = await parseWorkbook(workbookPath());
```

- [ ] **Step 8: Update `tests/unit/brain.test.ts`'s mock**

Current (lines 38–44):
```ts
vi.mock('../../server/config', () => ({
  WORKBOOK_PATH: '/nonexistent/oxford-test-workbook.xlsx',
  SNAPSHOT_PATH: h.snapshotPath,
  SERVER_PORT: 8911,
  WORKBOOK_AS_OF: '2026-06-01',
  QUICKBOOKS_CSV: null,
}));
```

Change to:
```ts
vi.mock('../../server/config', () => ({
  workbookPath: () => '/nonexistent/oxford-test-workbook.xlsx',
  SNAPSHOT_PATH: h.snapshotPath,
  SERVER_PORT: 8911,
  WORKBOOK_AS_OF: '2026-06-01',
}));
```
(`QUICKBOOKS_CSV: null` removed from the mock — the export no longer exists per Step 3, and nothing in `brain.ts` imports it.)

- [ ] **Step 9: Update the stale doc reference in `AUDIT.md`**

`AUDIT.md:35` currently reads (confirmed present at this line during formal review):
```
  config.ts                     WORKBOOK_PATH (canonical), SERVER_PORT 8911, WORKBOOK_AS_OF '2026-06-01'
```
Change to:
```
  config.ts                     workbookPath() (canonical, call-time), SERVER_PORT 8911, WORKBOOK_AS_OF '2026-06-01'
```

- [ ] **Step 10: Run the new test — verify it passes**

Run: `cd "C:\Users\Owner\oxford-command-center" && npx vitest run tests/unit/config.test.ts`
Expected: **PASS**, both cases.

- [ ] **Step 11: Typecheck the whole repo**

Run: `npm run typecheck`
Expected: 0 errors. If any file besides the five listed above still references bare `WORKBOOK_PATH`, this is where it surfaces — fix it the same way (`WORKBOOK_PATH` → `workbookPath()`, add the import) before continuing.

- [ ] **Step 12: Run the full unit suite**

Run: `npm run test`
Expected: all green, including `tests/unit/brain.test.ts` (mock updated in Step 8) and `tests/unit/config.test.ts` (new).

- [ ] **Step 13: Commit**

```bash
git add server/config.ts server/brain.ts scripts/extract-workbook.ts scripts/reconcile.ts scripts/bake-mirror.ts tests/unit/brain.test.ts tests/unit/config.test.ts AUDIT.md
git commit -m "fix(config): resolve WORKBOOK_PATH lazily so .env overrides actually take effect

Module-level const evaluation ran before loadEnvFile() in every consumer, per ES module
import ordering — .env's WORKBOOK_PATH (and the dead QUICKBOOKS_CSV export) were silently
discarded everywhere. Converts to a call-time getter, mirroring overlay.ts's existing
overlayPath() pattern. Also fixes refresh()'s success setState to refresh BrainState.workbookPath
at call time, so /api/health stops showing the frozen pre-load default. See
docs/superpowers/plans/2026-07-08-workbook-path-dual-library-and-env-loading-fix-plan.md for
the empirical proof and full root-cause writeup."
```

---

### Task 4: End-to-end verification against the real workbook

**Files:** none (verification only — running the fixed scripts against real, corrected paths).

- [ ] **Step 1: Re-verify `.env` is still correct (state may have drifted since Task 1)**

```bash
cd "C:\Users\Owner\oxford-command-center"
grep -E "^(WORKBOOK_PATH|DOCUMENTS_DIR|QUICKBOOKS_CSV|FINANCIALS_DIR)=" .env
```
Expected: all four show the no-suffix-library paths.

- [ ] **Step 2: `npm run extract`**

Run: `npm run extract`
Expected: `→ Reading workbook: C:\Users\Owner\OneDrive - Oxford Capital Partners\eric spreadsheets\...` followed by a reconciliation summary with non-zero Properties/Leases/Loans counts and no "file not found" error.

- [ ] **Step 3: `npm run reconcile`**

Run: `npm run reconcile`
Expected: `✓ Reconciliation passed` (or a clean list of ✓ PASS lines) — this is `npm run gate`'s first previously-broken step.

- [ ] **Step 4: `npm run warehouse:verify`**

Run: `npm run warehouse:verify`
Expected: exits 0. This builds a fresh warehouse in a temp dir from `FINANCIALS_DIR` — if it still errors on a missing/empty directory, re-check Task 1/2's edits before assuming a deeper data problem.

- [ ] **Step 5: `npm run warehouse:drift`**

Run: `npm run warehouse:drift`
Expected: exits 0 (or a clear, expected drift message unrelated to path resolution — e.g. it may report "no served DB yet" on first run, which is a documented pass condition per the script's own header comment, not a failure).

- [ ] **Step 6: Full gate**

Run: `npm run gate`
Expected: all steps green, including `governance`, `typecheck`, `lint`, `test`, `reconcile`, `warehouse:verify`, `warehouse:drift`.

- [ ] **Step 7: (Optional — writes local state) `npm run warehouse:backfill`**

Only run this if Gabriel wants the local `data/warehouse/finance.sqlite` cache actually rebuilt from the corrected `FINANCIALS_DIR` — it's a local, idempotent-by-file-hash write, no external side effects, but flag before running since it's the one step here that mutates repo-local state rather than just reading.

Run: `npm run warehouse:backfill`
Expected: ingest summary with a nonzero committed-import count, no "duplicate" spam on a first run against the corrected directory.

- [ ] **Step 8: Start the Brain Server and sanity-check `/api/health`**

`/api/health` is the real endpoint (confirmed via `grep "app.get('/api/health'" server/index.ts:146` — there is no `/api/state`). With Task 3's `refresh()` fix applied, its nested `state.workbookPath` now reflects the corrected path after the first successful refresh (not just at server-construction time).

Run: `npm run dev:server` (or `.\scripts\start-brain-server.ps1` if that's the standard local entry point), then in another shell:
```bash
curl -s http://localhost:8911/api/health | head -c 800
```
Expected: `state.workbookPath` in the response shows the no-suffix-library path, `state.status` is `fresh` (not stuck on an error referencing the `(1)` library). If `state.workbookPath` still shows the `(1)`-library default after a refresh has completed, Task 3's `refresh()` edit was missed or a refresh hasn't run yet — don't mistake this for the underlying fix being broken; cross-check against the `npm run extract` log line from Step 2, which reads the corrected path independent of `BrainState`. **Stop the server after checking** (per this repo's own verification-hygiene convention — don't leave dev servers running).

---

### Task 5 — Flagged, not auto-executed: shared hardcoded default (Gabriel's call)

`server/config.ts`'s `workbookPath()` (post-Task-3) and the three warehouse scripts' `FINANCIALS_DIR` still fall back to the `(1)`-suffixed library path when no `.env` override is present — this is git-tracked, shared code, so changing it affects every machine that clones this repo, not just this one. This plan deliberately does **not** touch that fallback: Task 1's `.env` edit is the correct, machine-local layer for a machine-specific OneDrive quirk, and the pending machine migration (session context: new machine not yet arrived) means the "(1)" library's status on the eventual replacement machine is unknown — changing the shared default now could just as easily need reverting after migration.

**If Gabriel wants the shared default changed too** (e.g. defense-in-depth against a future machine with no `.env` set up yet), that's a one-line follow-up in `server/config.ts` (drop the `(1)` suffix in the `join(...)` call) plus the equivalent in the three warehouse scripts' inline fallback strings — flagging rather than doing it here, consistent with Item E's original "flag it, don't fix now" instruction, since it's a policy call about which OneDrive library to trust as canonical repo-wide, not a mechanical bug fix.

---

## Priority / sequencing note

Task 1 alone already fixes `DOCUMENTS_DIR` (consumed lazily in `server/sources/documents.ts` — unaffected by defect #3) and the real `QUICKBOOKS_CSV` path (consumed lazily in `server/sources/quickbooks.ts` — also unaffected). Tasks 2 and 3 are what's needed for the `FINANCIALS_DIR`-dependent warehouse scripts and the `WORKBOOK_PATH`-dependent extract/reconcile/bake/live-server paths respectively. Do not skip Task 3 on the assumption that Task 1's `.env` fix alone resolves `npm run extract` — it demonstrably does not, per the empirical probe in the Root Cause section.
