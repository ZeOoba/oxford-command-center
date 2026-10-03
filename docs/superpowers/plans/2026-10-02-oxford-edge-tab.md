# Oxford Edge Tab (Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a read-only fifth Acquisitions tab, **Edge**, that renders the Oxford Edge `markets.json` dataset (market board, data health, server-side manual-pull queue) and a strict deal→market overlay in the DealDrawer and Sourcing list, with no change to any score, ruleset or governor.

**Architecture:** A new `server/edge/*` module reads `markets.json` read-only (memo + last-good cache + retry), reshapes it into the `src/contracts/edge.ts` output contract, and serves it from a Hono sub-router mounted at `/api/warehouse/edge` through `WAREHOUSE_SUB_ROUTERS`. The only warehouse write is an append-only `edge_pull_log` table (migration 034) for manual-pull done-state. The client fetches with `fetchJson` + Zod (no mirror fallback), resolves deals to Edge markets client-side with a two-tier exact resolver, and lazy-mounts the tab.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), Zod 3, Hono 4, better-sqlite3, React 19, TanStack Query, react-aria-components primitives, Vitest (jsdom / node), ESLint `--max-warnings 0`.

**Spec:** `docs/superpowers/specs/2026-10-02-oxford-edge-tab-design.md` (all questions resolved in §12/§13). **Phase 2 (§13) is out of scope for this plan.**

## Global Constraints

- Phase 1 is **display only**. No change to `scoreAcquisition`, `config/acquisition-ruleset.v1.json`, `AcquisitionInput.marketFundamentalsAdj`, or any governor (DSCR 1.25 / LTV 40 aggregate / 65 per-property).
- No composite market score or rank number. The board sorts by observed series values and nothing else.
- No writes to `markets.json` or anything else in the OneDrive `oxford-edge` folder. `server/edge/loader.ts` imports only `readFileSync`/`statSync` (`node:fs`).
- Default dir: `join(homedir(), 'OneDrive - Oxford Capital Partners', 'Claude_Workspace', '03_Code', 'oxford-edge', 'output')`, overridable by env `OXFORD_EDGE_DIR`; one resolver `edgeDir()` in `server/edge/config.ts`. Never an absolute `C:\Users\Owner` literal in code.
- `EDGE_STALE_DAYS = 7`. `asOf` is the **earlier** of `meta.pulled` and the file mtime. Stale if age > 7 days. Future mtime (clock skew) → stale, `ageDays` clamped ≥ 0.
- Status rendering: `actual` → no marker · `estimated` → dotted underline + "Est." · `nowcast` → dotted underline + "Nowcast" · `guide_only` → "Pending manual pull" (never `0`) · `"null"` → "Not published". `truck` renders "Not yet available" where null.
- Coverage rule: a cell is filled iff `value !== null` AND `status ∈ {actual, estimated, nowcast}`; value/status disagreements are not filled and are listed in `coverage[].inconsistent`.
- Proxies (`isProxy === true`: `biz`, `hvacPermits`, `eGrocery`) always show `fieldMeta.trueLabel` + ` [PROXY]`, never the raw key.
- `availability ∈ {ok, missing, unreadable, invalid}` is returned as **HTTP 200**; `GET /markets` never goes through the `withDb` 503 guard.
- `/edge/*` is **not** added to `FIXED_ROUTES` in `scripts/bake-warehouse.ts`; no Edge tool in `server/ai/tools.ts`; nothing in briefings/PDF. The Edge API accepts and returns **no deal data**.
- Migration `034_edge_pull_log.sql` (renumber if 034 is taken before merge). Append-only, no DELETE path; "Undo" sets `voided_at`. Latest state per (kind, scope) = latest non-voided row ordered `done_on DESC, id DESC`.
- Pull scopes: `storage` 21 buy-box markets / 90 d · `ios` same 21 / 90 d · `mfgInvest` PA MD VA WV OH IN MI KY MO KS WI IA NE IL MN (15) / 30 d · `truck` OH IN WI PA MD KY MO KS IA NE WV IL MN (13) / 365 d. VA and MI are `automatedCoverage`, not queue rows. Launch state: all **70** scopes `open`, no seeding. `localStorage` `oe-guide-*` keys are **not imported**.
- `RecordPullRequest` (strict): `{ kind: 'storage'|'ios'|'mfgInvest'|'truck', scopeKey: string, doneOn: 'YYYY-MM-DD', note?: string (≤ 2000) }`; unknown scope, unreal date, or future date (server local date) → 400.
- Query keys: `['warehouse','edge','markets']` (`staleTime: 5 min`), `['warehouse','edge','pull-queue']` (`QUERY_OPTS`). Mutations send `ORA_JSON_MUTATION_HEADERS` / `ORA_CLIENT_HEADERS` and invalidate `['warehouse','edge','pull-queue']`.
- Tab: `{ id: 'edge', label: 'Edge', aliases: ['oxford edge', 'market board', 'markets', 'pull queue', 'data health'] }`; Acquisitions becomes exactly `MAX_TABS_PER_DESTINATION = 5`. Lazy (`<TabPanel id="edge">` without `FORCE_MOUNT_PANEL`). No tab badge. `src/shell/modules.tsx` is not edited.
- Test fixture `tests/fixtures/edge/markets.slice.json` is **synthetic** (`"_synthetic": true`, made-up values). Never copy real CoStar-derived values into git.
- Every commit touching `server/**` carries `Refute-Skip: Oxford Edge Phase 1 — read-only display ingest + manual-pull log; no scoring, NOI, governor or capital math`. `server/edge/*` is **not** added to `DELIVERY_ONLY_PATHS`; `src/contracts/edge.ts` is **not** added to `FINANCIAL_CONTRACT_PATHS`.
- Every commit ends with `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Commit explicit paths only — never `git add -A`. Gabriel owns integration to `main`. Never `--no-verify`.
- Worktree development uses the worktree-local `WAREHOUSE_DB` (`./data/warehouse/finance.sqlite` inside the worktree). Migration 034 reaches the live warehouse only when the dev server on `main` starts after merge.

---

## File Structure

All paths are relative to the worktree root `C:/Users/Owner/oxford-command-center/.claude/worktrees/oxford-edge-tab` unless absolute.

| Path | Status | Responsibility | Owner |
|---|---|---|---|
| `src/contracts/edge.ts` | Create | Zod output contracts, `EDGE_SERIES`, `SERIES_UNITS`, `EDGE_OBSERVED_STATUSES` | **Architect** |
| `src/contracts/index.ts` | Modify (+1 line after line 45) | `export * from './edge';` | **Architect** |
| `server/warehouse/migrations/034_edge_pull_log.sql` | Create | Append-only pull log table | **Architect** |
| `server/edge/config.ts` | Create | `edgeDir()`, `EDGE_STALE_DAYS` | Integration |
| `server/edge/series.ts` | Create | Re-exports `EDGE_SERIES`/`SERIES_UNITS`; `BUY_BOX_TYPES` | Integration |
| `server/edge/freshness.ts` | Create | `edgeFreshness()` | Integration |
| `server/edge/coverage.ts` | Create | `computeCoverage()` | Integration |
| `server/edge/loader.ts` | Create | Read-only loader, raw schema, memo, last-good, retry | Integration |
| `server/edge/pull-queue.ts` | Create | `PULL_ITEMS`, scope lists, state derivation, log read/write/void | Integration |
| `server/edge/edge-api.ts` | Create | Hono sub-router (4 routes) | Integration |
| `server/warehouse/sub-routers.ts` | Modify (+1 import after line 23, +1 entry after line 63) | Mount `/edge` | Shared single-writer (claimed) |
| `src/modules/acquisitions/edge-hooks.ts` | Create | Query/mutation hooks, status/format/board/readout helpers, resolver | UX |
| `src/modules/acquisitions/EdgeRankingBoard.tsx` | Create | Market board | UX |
| `src/modules/acquisitions/EdgePullQueue.tsx` | Create | Pull queue cards + write controls | UX |
| `src/modules/acquisitions/EdgeMarketReadout.tsx` | Create | Deal-level readout (drawer card) | UX |
| `src/modules/acquisitions/EdgeView.tsx` | Create | Tab body: banner, KPIs, states, board, data health, queue | UX |
| `src/modules/acquisitions/tabs.ts` | Modify (lines 7, 13–14) | `edge` tab | UX |
| `src/modules/acquisitions/AcquisitionsModule.tsx` | Modify (lines 1, 20, 53, 217–269) | Lifted board state, sticky Edge gate, Edge panel | UX |
| `src/modules/acquisitions/AcquisitionsIntel.tsx` | Modify (lines 36, 100–104) | Pass `edgeEnabled` through | UX |
| `src/modules/acquisitions/RankedCandidateList.tsx` | Modify (Props lines 72–76 in Task 13; imports 8–12, signature 78–79, column after the `market` column in Task 14) | Edge column | UX |
| `src/brain/DealDrawer.tsx` | Modify (after line 13, after line 127) | "Edge Market" card | UX |
| `env.example` | Modify (after line 19) | `OXFORD_EDGE_DIR` doc | Shared single-writer (claimed) |
| `C:/Users/Owner/oxford-command-center/.claude/launch.json` | Modify (gitignored, local, main checkout) | `edge-web` / `edge-server` preview entries | Shared single-writer (claimed) |
| `architecture/status.json` | Modify | `oxford-edge-tab` claim | Claim protocol |
| `tests/fixtures/edge/markets.slice.json` | Create | Synthetic 4-market fixture | — |
| `tests/unit/edge-test-helpers.ts` | Create | `mkMarket`, `obs`, `fourMarkets`, `mkMarketsResponse` | — |
| `tests/unit/edge-contracts.test.ts` | Create | Contract invariants | — |
| `tests/unit/edge-migration.test.ts` | Create | Migration 034 | — |
| `tests/unit/edge-config.test.ts` | Create | `edgeDir`, `BUY_BOX_TYPES` | — |
| `tests/unit/edge-freshness.test.ts` | Create | F1 matrix | — |
| `tests/unit/edge-coverage.test.ts` | Create | Coverage rule | — |
| `tests/unit/edge-loader.test.ts` | Create | F5–F8, F14, fixture coverage pin | — |
| `tests/unit/edge-pull-queue.test.ts` | Create | Pull model + store | — |
| `tests/unit/edge-api.test.ts` | Create | Routes, F9, F12, mount prefix, bake guard | — |
| `tests/unit/edge-status-label.test.ts` | Create | Status/format/latest/board model | — |
| `tests/unit/edge-resolver.test.ts` | Create | F2, F13 | — |
| `tests/unit/edge-board.test.tsx` | Create | Board UI (F3, F4) | — |
| `tests/unit/edge-pull-queue-ui.test.tsx` | Create | Queue UI | — |
| `tests/unit/edge-view.test.tsx` | Create | Banner/states/KPIs/health | — |
| `tests/unit/edge-overlay.test.tsx` | Create | DealDrawer card + Sourcing column | — |
| `tests/unit/acquisitions-tabs.test.tsx` | Modify | 5 tabs, Edge lazy, F11 | — |
| `tests/unit/ia-registry.test.ts` | Modify (line 312) | `pipeline` tab list | — |
| `tests/unit/palette-tabs.test.tsx` | Modify (line 44) | `Acquisitions › Edge` entry | — |

**Not touched:** `server/index.ts`, `server/warehouse/migrate.ts`, `server/warehouse/db.ts`, `src/shell/modules.tsx`, `scripts/bake-warehouse.ts`, `scripts/check-refute-required.ts`, `server/ai/tools.ts`, `src/primitives/*`, `architecture/ownership.json`.

---

### Task 0: Coordination, pre-flight, worktree, claim (spec §11)

**Files:**
- Create: `.claude/worktrees/oxford-edge-tab/` (worktree), `.claude/worktrees/oxford-edge-tab/.env` (gitignored), `.claude/worktrees/oxford-edge-tab/node_modules` (junction)
- Modify: `architecture/status.json` (append one entry)
- Bring onto branch: `docs/superpowers/specs/2026-10-02-oxford-edge-tab-design.md`, `docs/superpowers/plans/2026-10-02-oxford-edge-tab.md`

**Interfaces:**
- Consumes: nothing.
- Produces: branch `feat/oxford-edge-tab` at fresh `origin/main` + spec + plan + status claim; Gabriel's acknowledgment (required before Tasks 1–2).

- [ ] **Step 1: Pre-flight against ground truth (main checkout, read-only)**

Run (Git Bash, from `C:/Users/Owner/oxford-command-center`):

```bash
git fetch origin --prune
git worktree list
git status --short
git log --oneline -1 origin/main
git ls-tree --name-only origin/main server/warehouse/migrations/ | tail -3
for r in $(git for-each-ref --format='%(refname:short)' refs/remotes/origin); do git ls-tree --name-only "$r" server/warehouse/migrations/ 2>/dev/null; done | grep -E '/03[3-9]_' | sort -u
ls .claude/worktrees/ 2>/dev/null | grep -x oxford-edge-tab
node -e "const s=require('./architecture/status.json');for(const [k,v] of Object.entries(s)){if(v&&typeof v==='object'&&(v.status==='in_progress'||v.review_needed===true))console.log(k+' :: '+String(v.review_detail||v.phase).slice(0,200))}"
```

Expected:
- `git status --short` shows only other writers' files (at plan time: ` M data/snapshots/portfolio.json`, `?? docs/superpowers/plans/2026-10-02-portfolio-trends.md`, plus this plan file). Treat every uncommitted file you did not create as **locked**.
- The highest migration on `origin/main` is `032_lm_cumulative_reduction_event_chain.sql`.
- The `03[3-9]_` loop prints **nothing**. If it prints a `033_*` file: use the next free number everywhere this plan says `034` (file name, test name, `_migrations` assertions, status claim) and say so in the PR.
- No `oxford-edge-tab` directory exists.
- No open status entry claims `server/warehouse/sub-routers.ts`, `env.example`, `.claude/launch.json` or `src/contracts/index.ts`. If one does: STOP and ask Gabriel (AskUserQuestion) before continuing.
- Note `origin/main`'s SHA; Step 2 branches from it. If `origin/main` moved past `f36b995`, re-check the spec's verification ledger claims you depend on (`sub-routers.ts` shape, `tabs.ts` four tabs, `acquisitions-tabs.test.tsx` four-tab assertion) before Task 1.

- [ ] **Step 2: Create the worktree from fresh `origin/main`**

```bash
cd C:/Users/Owner/oxford-command-center
git worktree add .claude/worktrees/oxford-edge-tab -b feat/oxford-edge-tab origin/main
```

Expected: `Preparing worktree (new branch 'feat/oxford-edge-tab')`, HEAD at `origin/main`'s SHA.

- [ ] **Step 3: Bring the spec and this plan onto the feature branch (cherry-pick — least risky)**

The spec lives on `docs/oxford-edge-spec` as three docs-only commits that each touch exactly one file (`docs/superpowers/specs/2026-10-02-oxford-edge-tab-design.md`). Cherry-picking them is the least risky route: the feature branch stays based on `origin/main` (no docs-branch merge history to untangle), the file does not exist on `main` so no conflict is possible, and if `docs/oxford-edge-spec` is merged to `main` first, a later `git rebase origin/main` drops the identical commits automatically. Merging the docs branch into the feature branch would instead drag its base into this branch's history; opening a separate docs PR first would block this work on a second review.

```bash
cd C:/Users/Owner/oxford-command-center/.claude/worktrees/oxford-edge-tab
git log --reverse --format=%h origin/main..docs/oxford-edge-spec -- docs/superpowers/specs/2026-10-02-oxford-edge-tab-design.md
```

Expected: exactly the spec commits (at plan time `39c372c 59412e7 74e5c6c`). Confirm each touches only the spec file:

```bash
for c in $(git log --reverse --format=%h origin/main..docs/oxford-edge-spec -- docs/superpowers/specs/2026-10-02-oxford-edge-tab-design.md); do git show --stat --format='%h %s' "$c" | tail -2; done
git cherry-pick $(git log --reverse --format=%h origin/main..docs/oxford-edge-spec -- docs/superpowers/specs/2026-10-02-oxford-edge-tab-design.md)
```

Expected: each `1 file changed`; cherry-pick completes with no conflicts.

The plan file is untracked in the main checkout (do not commit it there). Copy it and commit it on the feature branch:

```bash
cp ../../../docs/superpowers/plans/2026-10-02-oxford-edge-tab.md docs/superpowers/plans/2026-10-02-oxford-edge-tab.md
git add docs/superpowers/plans/2026-10-02-oxford-edge-tab.md
git commit -F - <<'EOF'
docs(plan): Oxford Edge tab Phase 1 implementation plan

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 4: Worktree environment (`.env` + shared `node_modules` junction)**

```bash
cd C:/Users/Owner/oxford-command-center/.claude/worktrees/oxford-edge-tab
cp worktree-env.example .env
grep -E '^(WAREHOUSE_DB|OXFORD_EDGE_DIR)=' .env
```

Expected: exactly `WAREHOUSE_DB=./data/warehouse/finance.sqlite` (relative → resolves inside the worktree) and **no** `OXFORD_EDGE_DIR` line (the default path is under test).

Create the shared `node_modules` junction (PowerShell):

```powershell
New-Item -ItemType Junction -Path C:\Users\Owner\oxford-command-center\.claude\worktrees\oxford-edge-tab\node_modules -Target C:\Users\Owner\oxford-command-center\node_modules
Test-Path C:\Users\Owner\oxford-command-center\.claude\worktrees\oxford-edge-tab\node_modules\typescript
```

Expected: `True`. **Teardown rule (memory `node-modules-junction-footgun`):** before ever removing this worktree, `cmd /c rmdir <worktree>\node_modules` (bare `rmdir`, removes only the link), then `git worktree remove`. Never `git worktree remove --force` with the junction in place.

- [ ] **Step 5: Declare the claim in `architecture/status.json`**

`architecture/**` is Architect-owned and `.claude/hooks/file-guard.mjs` blocks the edit unless `.claude/overrides/architect-edit-ok` is fresh (60-min TTL). Do **not** create that sentinel yourself — it is Gabriel's acknowledgment. If the edit below is denied, ask Gabriel (AskUserQuestion, multiple choice, "(Recommended)" first) to grant it for the claim declaration only.

Read `architecture/status.json` immediately before editing. Insert this entry as the last top-level key (before the final `}`), replacing `<ISO-8601 now>` with the actual UTC timestamp:

```json
  "oxford-edge-tab": {
    "agent_role": "Integration Agent (server/edge/*) + UX Agent (src/modules/acquisitions/Edge*, edge-hooks.ts, DealDrawer card) - Claude Code session",
    "phase": "Oxford Edge Phase 1 - Acquisitions > Edge tab, display only. Spec docs/superpowers/specs/2026-10-02-oxford-edge-tab-design.md; plan docs/superpowers/plans/2026-10-02-oxford-edge-tab.md. Worktree .claude/worktrees/oxford-edge-tab, branch feat/oxford-edge-tab.",
    "status": "review_needed",
    "blocked_by": null,
    "review_needed": true,
    "review_detail": "Architect-owned touches: (1) NEW src/contracts/edge.ts + src/contracts/index.ts (+1 line: export * from './edge'); (2) NEW server/warehouse/migrations/034_edge_pull_log.sql (one isolated append-only table edge_pull_log; no existing table touched). Shared single-writer surfaces claimed: server/warehouse/sub-routers.ts (+1 import, +1 literal entry { prefix: '/edge', factory: edgeApi }), .claude/launch.json (gitignored local file in the main checkout: +2 worktree preview entries edge-web/edge-server), env.example (+OXFORD_EDGE_DIR doc lines). NOT touched: server/index.ts, migrate.ts, db.ts, any governor/ruleset/scoring file. Waiting for Gabriel's acknowledgment before editing any Architect-owned file.",
    "last_updated": "<ISO-8601 now>"
  }
```

Run: `npm run governance`
Expected: PASS (status-bus integrity accepts the entry).

- [ ] **Step 6: Commit the declaration**

```bash
git add architecture/status.json
git commit -F - <<'EOF'
chore(status): claim oxford-edge-tab (review_needed: contracts/edge.ts, migration 034, sub-routers)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

- [ ] **Step 7: WAIT for Gabriel's acknowledgment**

Ask with AskUserQuestion:
- "(Recommended) Acknowledge — I'll touch `.claude/overrides/architect-edit-ok` in the worktree; proceed with contracts + migration 034" — unblocks Tasks 1–2 inside one 60-minute window.
- "Hold — I want to review the claim first" — no Architect-owned edit until a later go.
- "Change scope" — Gabriel names the change; update the status entry and re-commit.

Do not start Task 1 until the acknowledgment arrives. Tasks 1 and 2 are the only Architect-owned edits; run them back-to-back inside one sentinel window. If the sentinel expires mid-task, stop and ask for a fresh acknowledgment.

---

### Task 1: Contracts `src/contracts/edge.ts` (Architect-owned)

**Files:**
- Create: `src/contracts/edge.ts`
- Modify: `src/contracts/index.ts:45` (add one line after `export * from './brain-report';`)
- Test: `tests/unit/edge-contracts.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (exact names used by every later task):
  - `EDGE_SERIES` (readonly tuple of 18 keys), `EdgeSeriesKey`, `EdgeStatus`, `EDGE_OBSERVED_STATUSES: readonly EdgeStatus[]`, `EdgeUnit`, `SERIES_UNITS: Readonly<Record<EdgeSeriesKey, EdgeUnit>>`
  - `EdgeSeriesCell` `{ values: (number|null)[]; status: EdgeStatus[] }`, `EdgeSeriesMap`, `EdgeSub`, `EdgeMarketType`, `EdgeTrajectory`, `EdgeMarket` `{ id, name, state, cbsa, lat, lon, type, trajectory, subs, series }`
  - `EdgeFieldMeta` `{ trueLabel, isProxy, unit }`, `EdgeFreshness` `{ metaPulled, fileMtime, asOf, ageDays, staleAfterDays, stale }`, `EdgeStatusCounts`, `EdgeCoverageRow` `{ field, filled, total, pct, byYear, allPlaceholder, statusCounts, inconsistent: {marketId, year}[] }`, `EdgeRejectedMarket` `{ id: string|null, reason }`, `EdgeAvailability`, `EdgeOutsidePullScope` `{ truck: string[], mfgInvest: string[] }`
  - `EdgeMarketsResponse` `{ availability, dir, freshness|null, readError|null, lastGoodLoadedAt|null, years, fieldMeta, sources, coverage, markets, rejectedMarkets, marketCount, issues: string[], outsidePullScope }`
  - `EdgePullKind`, `EdgePullState` (`open|current|due`), `EdgePullLink` `{ label, url }`, `EdgePullScopeState` `{ scopeKey, scopeLabel, state, lastDoneOn, lastNote, lastLogId, ageDays, links, blocker }`, `EdgePullItem` `{ kind, label, cadenceDays, cadenceLabel, scopeType, why, caveat, scopes, counts: {open,due,current} }`, `EdgePullQueueResponse` `{ items, automatedCoverage: { truck: string[] }, today }`, `RecordPullRequest`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/edge-contracts.test.ts`:

```ts
// @vitest-environment node
//
// tests/unit/edge-contracts.test.ts — Oxford Edge Phase 1 contract invariants (spec §3, §5.2, §6).
import { describe, expect, it } from 'vitest';
import {
  EDGE_SERIES, EdgeSeriesCell, EdgeStatus, RecordPullRequest, SERIES_UNITS, EdgeMarketsResponse,
} from '@contracts/edge';
import * as contracts from '@contracts/index';

describe('Edge contracts', () => {
  it('declares exactly 18 series and a unit for every one (no more, no less)', () => {
    expect(EDGE_SERIES).toHaveLength(18);
    expect(Object.keys(SERIES_UNITS).sort()).toEqual([...EDGE_SERIES].sort());
  });

  it('pins the unit table from spec §3', () => {
    expect(SERIES_UNITS.vac).toBe('pct_level');
    expect(SERIES_UNITS.loss).toBe('pct_level');
    expect(SERIES_UNITS.per).toBe('ksf');
    expect(SERIES_UNITS.carriers).toBe('per_10k');
    expect(SERIES_UNITS.incLevel).toBe('usd');
    expect(SERIES_UNITS.mfgInvest).toBe('usd');
    expect(SERIES_UNITS.migration).toBe('persons');
    expect(SERIES_UNITS.ios).toBe('signal');
    for (const k of ['pop', 'job', 'inc', 'trades', 'biz', 'hvacPermits', 'truck', 'storage', 'rent', 'eGrocery'] as const) {
      expect(SERIES_UNITS[k]).toBe('pct_yoy');
    }
  });

  it("treats 'null' as a string status member distinct from JSON null", () => {
    expect(EdgeStatus.safeParse('null').success).toBe(true);
    expect(EdgeStatus.safeParse(null).success).toBe(false);
  });

  it('rejects a series cell whose values and status lengths differ', () => {
    expect(EdgeSeriesCell.safeParse({ values: [1, null], status: ['actual'] }).success).toBe(false);
    expect(EdgeSeriesCell.safeParse({ values: [1, null], status: ['actual', 'null'] }).success).toBe(true);
  });

  it('RecordPullRequest is strict and bounds the note at 2000 chars', () => {
    const ok = { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30', note: 'baseline' };
    expect(RecordPullRequest.safeParse(ok).success).toBe(true);
    expect(RecordPullRequest.safeParse({ ...ok, extra: 1 }).success).toBe(false);
    expect(RecordPullRequest.safeParse({ ...ok, kind: 'rent' }).success).toBe(false);
    expect(RecordPullRequest.safeParse({ ...ok, doneOn: '09/30/2026' }).success).toBe(false);
    expect(RecordPullRequest.safeParse({ ...ok, note: 'x'.repeat(2001) }).success).toBe(false);
    const { note: _note, ...noNote } = ok;
    expect(RecordPullRequest.safeParse(noNote).success).toBe(true);
  });

  it('accepts an empty (missing-dataset) markets envelope', () => {
    const empty = {
      availability: 'missing', dir: 'C:/nowhere', freshness: null, readError: null, lastGoodLoadedAt: null,
      years: [], fieldMeta: {}, sources: {}, coverage: [], markets: [], rejectedMarkets: [], marketCount: 0,
      issues: [], outsidePullScope: { truck: [], mfgInvest: [] },
    };
    expect(EdgeMarketsResponse.safeParse(empty).success).toBe(true);
  });

  it('is re-exported from the contracts index', () => {
    expect(contracts.EDGE_SERIES).toBe(EDGE_SERIES);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/edge-contracts.test.ts`
Expected: FAIL — `Failed to resolve import "@contracts/edge"`.

- [ ] **Step 3: Write the contracts**

Create `src/contracts/edge.ts`:

```ts
// src/contracts/edge.ts
//
// Oxford Edge — Phase 1 display contracts (docs/superpowers/specs/2026-10-02-oxford-edge-tab-design.md §6).
// The OUTPUT shape of GET/POST /api/warehouse/edge/* only. The raw markets.json schema
// (RawEdgeMeta / rawEdgeMarketSchema) is an ingest concern and lives in server/edge/loader.ts, so an
// upstream file-shape change never needs an Architect contract change.
//
// NOT in FINANCIAL_CONTRACT_PATHS (scripts/check-refute-required.ts) and must not be added in
// Phase 1: nothing here feeds scoring. Phase 2 re-evaluates that (spec §13).
import { z } from 'zod';

/** The 18 Edge series, in display order. */
export const EDGE_SERIES = [
  'pop', 'job', 'inc', 'incLevel', 'trades', 'biz', 'hvacPermits', 'per', 'loss',
  'truck', 'storage', 'rent', 'vac', 'carriers', 'mfgInvest', 'ios', 'migration', 'eGrocery',
] as const;
export const EdgeSeriesKey = z.enum(EDGE_SERIES);
export type EdgeSeriesKey = z.infer<typeof EdgeSeriesKey>;

/** markets.json statusEnum. `'null'` is a STRING member, distinct from a JSON null value. */
export const EdgeStatus = z.enum(['actual', 'estimated', 'nowcast', 'guide_only', 'null']);
export type EdgeStatus = z.infer<typeof EdgeStatus>;

/** Statuses whose non-null value counts as observed data (coverage "filled", board "latest"). */
export const EDGE_OBSERVED_STATUSES: readonly EdgeStatus[] = ['actual', 'estimated', 'nowcast'];

export const EdgeUnit = z.enum(['pct_yoy', 'pct_level', 'ksf', 'per_10k', 'usd', 'persons', 'signal']);
export type EdgeUnit = z.infer<typeof EdgeUnit>;

/** Units are declared once, here: fieldMeta carries none, and the data dictionary's "all % YoY
 *  except incLevel and migration" is wrong for vac/per/loss/carriers/mfgInvest (spec §3).
 *  server/edge/series.ts re-exports this table; tests pin it against fieldMeta's key set. */
export const SERIES_UNITS: Readonly<Record<EdgeSeriesKey, EdgeUnit>> = {
  pop: 'pct_yoy',
  job: 'pct_yoy',
  inc: 'pct_yoy',
  trades: 'pct_yoy',
  biz: 'pct_yoy',
  hvacPermits: 'pct_yoy',
  truck: 'pct_yoy',
  storage: 'pct_yoy',
  rent: 'pct_yoy',
  eGrocery: 'pct_yoy',
  vac: 'pct_level',
  loss: 'pct_level',
  per: 'ksf',
  carriers: 'per_10k',
  incLevel: 'usd',
  mfgInvest: 'usd',
  migration: 'persons',
  ios: 'signal',
};

/** One series for one market: parallel values/status arrays, reshaped server-side so the client
 *  never zips two arrays by index. */
export const EdgeSeriesCell = z
  .object({ values: z.array(z.number().nullable()), status: z.array(EdgeStatus) })
  .refine((c) => c.values.length === c.status.length, { message: 'values and status must be the same length' });
export type EdgeSeriesCell = z.infer<typeof EdgeSeriesCell>;

export const EdgeSeriesMap = z.object({
  pop: EdgeSeriesCell,
  job: EdgeSeriesCell,
  inc: EdgeSeriesCell,
  incLevel: EdgeSeriesCell,
  trades: EdgeSeriesCell,
  biz: EdgeSeriesCell,
  hvacPermits: EdgeSeriesCell,
  per: EdgeSeriesCell,
  loss: EdgeSeriesCell,
  truck: EdgeSeriesCell,
  storage: EdgeSeriesCell,
  rent: EdgeSeriesCell,
  vac: EdgeSeriesCell,
  carriers: EdgeSeriesCell,
  mfgInvest: EdgeSeriesCell,
  ios: EdgeSeriesCell,
  migration: EdgeSeriesCell,
  eGrocery: EdgeSeriesCell,
});
export type EdgeSeriesMap = z.infer<typeof EdgeSeriesMap>;

export const EdgeSub = z.object({
  name: z.string(),
  vac: z.number(),
  rentGrowth: z.number(),
  invKsf: z.number(),
});
export type EdgeSub = z.infer<typeof EdgeSub>;

/** named + named_custom = the 21-market buy-box set; auto = the 34 auto-included CBSAs. */
export const EdgeMarketType = z.enum(['named', 'named_custom', 'auto']);
export type EdgeMarketType = z.infer<typeof EdgeMarketType>;

export const EdgeTrajectory = z.enum(['a_growing', 'b_stable', 'c_reversing']);
export type EdgeTrajectory = z.infer<typeof EdgeTrajectory>;

export const EdgeMarket = z.object({
  id: z.string().min(1),
  name: z.string(),
  /** Primary state only (a multi-state CBSA lists one state, e.g. washington_arlington_alexandria = DC). */
  state: z.string().length(2),
  cbsa: z.string(),
  lat: z.number(),
  lon: z.number(),
  type: EdgeMarketType,
  trajectory: EdgeTrajectory.nullable(),
  subs: z.array(EdgeSub),
  series: EdgeSeriesMap,
});
export type EdgeMarket = z.infer<typeof EdgeMarket>;

export const EdgeFieldMeta = z.object({
  trueLabel: z.string(),
  isProxy: z.boolean(),
  unit: EdgeUnit,
});
export type EdgeFieldMeta = z.infer<typeof EdgeFieldMeta>;

export const EdgeFreshness = z.object({
  metaPulled: z.string(),
  fileMtime: z.string(),
  /** The EARLIER of metaPulled and the file mtime date — an OneDrive re-sync that bumps mtime can
   *  never make old data read as fresh. */
  asOf: z.string(),
  ageDays: z.number().int().nonnegative(),
  staleAfterDays: z.number().int().positive(),
  stale: z.boolean(),
});
export type EdgeFreshness = z.infer<typeof EdgeFreshness>;

export const EdgeStatusCounts = z.object({
  actual: z.number().int().nonnegative(),
  estimated: z.number().int().nonnegative(),
  nowcast: z.number().int().nonnegative(),
  guide_only: z.number().int().nonnegative(),
  null: z.number().int().nonnegative(),
});
export type EdgeStatusCounts = z.infer<typeof EdgeStatusCounts>;

export const EdgeCoverageRow = z.object({
  field: EdgeSeriesKey,
  filled: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  pct: z.number().min(0).max(1),
  byYear: z.array(z.number().int().nonnegative()),
  allPlaceholder: z.boolean(),
  statusCounts: EdgeStatusCounts,
  /** Cells where value and status disagree (a value with status 'null'/guide_only, or null with an
   *  observed status). Counted as NOT filled. */
  inconsistent: z.array(z.object({ marketId: z.string(), year: z.number().int() })),
});
export type EdgeCoverageRow = z.infer<typeof EdgeCoverageRow>;

export const EdgeRejectedMarket = z.object({ id: z.string().nullable(), reason: z.string() });
export type EdgeRejectedMarket = z.infer<typeof EdgeRejectedMarket>;

/** Data states, returned as HTTP 200 (a 503 would be mis-rendered as "warehouse offline"). */
export const EdgeAvailability = z.enum(['ok', 'missing', 'unreadable', 'invalid']);
export type EdgeAvailability = z.infer<typeof EdgeAvailability>;

export const EdgeOutsidePullScope = z.object({
  truck: z.array(z.string()),
  mfgInvest: z.array(z.string()),
});
export type EdgeOutsidePullScope = z.infer<typeof EdgeOutsidePullScope>;

export const EdgeMarketsResponse = z.object({
  availability: EdgeAvailability,
  /** Returned only because the API is localhost-only. */
  dir: z.string(),
  freshness: EdgeFreshness.nullable(),
  /** Set when last-good is being served after a failed re-read. */
  readError: z.string().nullable(),
  lastGoodLoadedAt: z.string().nullable(),
  years: z.array(z.number().int()),
  fieldMeta: z.record(EdgeSeriesKey, EdgeFieldMeta),
  sources: z.record(z.string(), z.array(z.string())),
  coverage: z.array(EdgeCoverageRow),
  markets: z.array(EdgeMarket),
  rejectedMarkets: z.array(EdgeRejectedMarket),
  marketCount: z.number().int().nonnegative(),
  /** unreadable: [the I/O error]; invalid: the first 5 schema issues; otherwise []. */
  issues: z.array(z.string()),
  outsidePullScope: EdgeOutsidePullScope,
});
export type EdgeMarketsResponse = z.infer<typeof EdgeMarketsResponse>;

// ── Manual-pull queue ─────────────────────────────────────────────────────────────────────────

export const EdgePullKind = z.enum(['storage', 'ios', 'mfgInvest', 'truck']);
export type EdgePullKind = z.infer<typeof EdgePullKind>;

export const EdgePullState = z.enum(['open', 'current', 'due']);
export type EdgePullState = z.infer<typeof EdgePullState>;

export const EdgePullLink = z.object({ label: z.string(), url: z.string().url() });
export type EdgePullLink = z.infer<typeof EdgePullLink>;

export const EdgePullScopeState = z.object({
  scopeKey: z.string(),
  scopeLabel: z.string(),
  state: EdgePullState,
  lastDoneOn: z.string().nullable(),
  lastNote: z.string().nullable(),
  lastLogId: z.number().int().positive().nullable(),
  ageDays: z.number().int().nonnegative().nullable(),
  links: z.array(EdgePullLink),
  /** Truck only: the per-state blocker carried from the retired Morning Guide. */
  blocker: z.string().nullable(),
});
export type EdgePullScopeState = z.infer<typeof EdgePullScopeState>;

export const EdgePullItem = z.object({
  kind: EdgePullKind,
  label: z.string(),
  cadenceDays: z.number().int().positive(),
  cadenceLabel: z.string(),
  scopeType: z.enum(['market', 'state']),
  why: z.string(),
  caveat: z.string(),
  scopes: z.array(EdgePullScopeState),
  counts: z.object({
    open: z.number().int().nonnegative(),
    due: z.number().int().nonnegative(),
    current: z.number().int().nonnegative(),
  }),
});
export type EdgePullItem = z.infer<typeof EdgePullItem>;

export const EdgePullQueueResponse = z.object({
  items: z.array(EdgePullItem),
  /** States complete through the automated pull, derived from markets.json (never from the log). */
  automatedCoverage: z.object({ truck: z.array(z.string()) }),
  /** Server local date used for state derivation. */
  today: z.string(),
});
export type EdgePullQueueResponse = z.infer<typeof EdgePullQueueResponse>;

/** POST /api/warehouse/edge/pull-queue body. scopeKey membership, real-date and not-future checks
 *  are enforced by the route (they depend on code-declared scope lists and the server clock). */
export const RecordPullRequest = z
  .object({
    kind: EdgePullKind,
    scopeKey: z.string().min(2).max(64),
    doneOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    note: z.string().max(2000).optional(),
  })
  .strict();
export type RecordPullRequest = z.infer<typeof RecordPullRequest>;
```

Modify `src/contracts/index.ts` — after line 45 (`export * from './brain-report';`) add:

```ts
export * from './edge';
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/edge-contracts.test.ts && npm run typecheck`
Expected: 7 tests PASS; typecheck exits 0 (no export-name collision with existing contracts).

- [ ] **Step 5: Commit**

```bash
git add src/contracts/edge.ts src/contracts/index.ts tests/unit/edge-contracts.test.ts
git commit -F - <<'EOF'
feat(contracts): Oxford Edge Phase 1 display contracts (src/contracts/edge.ts)

Architect-owned; acknowledged per architecture/status.json oxford-edge-tab claim.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 2: Migration `034_edge_pull_log.sql` (Architect-owned)

**Files:**
- Create: `server/warehouse/migrations/034_edge_pull_log.sql`
- Test: `tests/unit/edge-migration.test.ts`

**Interfaces:**
- Consumes: `runMigrations(db)` from `server/warehouse/migrate.ts` (auto-discovers `NNN_*.sql`; not edited).
- Produces: table `edge_pull_log(id, pull_kind, scope_key, done_on, note, recorded_by, created_at, voided_at)` + index `ix_edge_pull_log_kind_scope`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/edge-migration.test.ts`:

```ts
// @vitest-environment node
//
// tests/unit/edge-migration.test.ts — migration 034 (spec §7). In-memory DB; never touches finance.sqlite.
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { runMigrations } from '../../server/warehouse/migrate';

function makeDb(): Database.Database {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  runMigrations(db);
  return db;
}

const insert = (db: Database.Database, kind: string, scope: string, doneOn: string, note: string | null = null) =>
  db.prepare('INSERT INTO edge_pull_log (pull_kind, scope_key, done_on, note) VALUES (?, ?, ?, ?)').run(kind, scope, doneOn, note);

describe('migration 034 — edge_pull_log', () => {
  it('a fresh DB migrates through 034 and records it', () => {
    const db = makeDb();
    const row = db.prepare("SELECT filename FROM _migrations WHERE filename = '034_edge_pull_log.sql'").get();
    expect(row).toBeDefined();
    const cols = (db.pragma('table_info(edge_pull_log)') as Array<{ name: string }>).map((c) => c.name);
    expect(cols).toEqual(['id', 'pull_kind', 'scope_key', 'done_on', 'note', 'recorded_by', 'created_at', 'voided_at']);
  });

  it('accepts a valid row and fills the defaults', () => {
    const db = makeDb();
    insert(db, 'storage', 'columbus', '2026-09-30', 'baseline');
    const row = db.prepare('SELECT recorded_by, created_at, voided_at FROM edge_pull_log').get() as {
      recorded_by: string; created_at: string; voided_at: string | null;
    };
    expect(row.recorded_by).toBe('ui');
    expect(row.created_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
    expect(row.voided_at).toBeNull();
  });

  it('CHECK rejects a bad pull_kind', () => {
    expect(() => insert(makeDb(), 'rent', 'columbus', '2026-09-30')).toThrow(/CHECK constraint failed/);
  });

  it("CHECK rejects a non-calendar done_on ('2026-02-30') and a non-date string", () => {
    const db = makeDb();
    expect(() => insert(db, 'storage', 'columbus', '2026-02-30')).toThrow(/CHECK constraint failed/);
    expect(() => insert(db, 'storage', 'columbus', 'not-a-date')).toThrow(/CHECK constraint failed/);
  });

  it('CHECK rejects an oversize note and an out-of-range scope_key', () => {
    const db = makeDb();
    expect(() => insert(db, 'storage', 'columbus', '2026-09-30', 'x'.repeat(2001))).toThrow(/CHECK constraint failed/);
    expect(() => insert(db, 'storage', 'x', '2026-09-30')).toThrow(/CHECK constraint failed/);
  });

  it('is idempotent — a second run does not re-apply', () => {
    const db = makeDb();
    const before = (db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n;
    runMigrations(db);
    expect((db.prepare('SELECT COUNT(*) AS n FROM _migrations').get() as { n: number }).n).toBe(before);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/edge-migration.test.ts`
Expected: FAIL — first test: `expected undefined to be defined` (no `034` row); others `no such table: edge_pull_log`.

- [ ] **Step 3: Write the migration**

Create `server/warehouse/migrations/034_edge_pull_log.sql`:

```sql
-- 034_edge_pull_log.sql — Oxford Edge manual-pull done-state (append-only log).
-- User state only; holds no market data. Scope/cadence live in server/edge/pull-queue.ts.
-- Spec: docs/superpowers/specs/2026-10-02-oxford-edge-tab-design.md §7.
--
-- Append-only: there is no DELETE path. "Undo" sets voided_at (never-delete rule; history kept).
-- Current state per (pull_kind, scope_key) = the latest row with voided_at IS NULL, ordered
-- done_on DESC, id DESC. scope_key membership is enforced in the route against PULL_ITEMS, not
-- here, so the scope list can change without a migration.
--
-- done_on CHECK: `date(done_on) IS NOT NULL` is added to the spec's `done_on = date(done_on)`.
-- SQLite treats a CHECK whose expression evaluates to NULL as satisfied, and date('not-a-date')
-- is NULL, so the bare equality alone would admit garbage. The equality still rejects overflow
-- dates such as '2026-02-30' (date() normalizes it to a different string).
CREATE TABLE IF NOT EXISTS edge_pull_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  pull_kind   TEXT NOT NULL CHECK (pull_kind IN ('storage', 'ios', 'mfgInvest', 'truck')),
  scope_key   TEXT NOT NULL CHECK (length(scope_key) BETWEEN 2 AND 64),
  done_on     TEXT NOT NULL CHECK (date(done_on) IS NOT NULL AND done_on = date(done_on)),
  note        TEXT CHECK (note IS NULL OR length(note) <= 2000),
  recorded_by TEXT NOT NULL DEFAULT 'ui',
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  voided_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_edge_pull_log_kind_scope
  ON edge_pull_log (pull_kind, scope_key, done_on DESC, id DESC);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/edge-migration.test.ts && npm run governance`
Expected: 6 tests PASS; governance PASS (no `DUPLICATE migration prefix 034`).

- [ ] **Step 5: Commit**

```bash
git add server/warehouse/migrations/034_edge_pull_log.sql tests/unit/edge-migration.test.ts
git commit -F - <<'EOF'
feat(warehouse): migration 034 edge_pull_log (append-only Oxford Edge pull log)

Architect-owned; acknowledged per architecture/status.json oxford-edge-tab claim.
One isolated table; no existing table touched. done_on CHECK adds `date(done_on) IS NOT NULL`
so a non-date string cannot pass via SQLite's NULL-CHECK semantics.

Refute-Skip: Oxford Edge Phase 1 — read-only display ingest + manual-pull log; no scoring, NOI, governor or capital math
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 3: `server/edge/config.ts`, `series.ts`, `freshness.ts`

**Files:**
- Create: `server/edge/config.ts`, `server/edge/series.ts`, `server/edge/freshness.ts`
- Test: `tests/unit/edge-config.test.ts`, `tests/unit/edge-freshness.test.ts`

**Interfaces:**
- Consumes: `EDGE_SERIES`, `SERIES_UNITS`, `EdgeMarket`, `EdgeFreshness` (Task 1).
- Produces: `edgeDir(): string`, `EDGE_STALE_DAYS = 7`, `BUY_BOX_TYPES: ReadonlySet<EdgeMarket['type']>`, `edgeFreshness(metaPulled: string, mtimeMs: number, now: Date): EdgeFreshness`.

- [ ] **Step 1: Write the failing tests**

Create `tests/unit/edge-config.test.ts`:

```ts
// @vitest-environment node
import { afterEach, describe, expect, it } from 'vitest';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { EDGE_STALE_DAYS, edgeDir } from '../../server/edge/config';
import { BUY_BOX_TYPES, EDGE_SERIES, SERIES_UNITS } from '../../server/edge/series';

const saved = process.env.OXFORD_EDGE_DIR;
afterEach(() => {
  if (saved === undefined) delete process.env.OXFORD_EDGE_DIR;
  else process.env.OXFORD_EDGE_DIR = saved;
});

describe('edgeDir()', () => {
  it('defaults to the home-relative OneDrive oxford-edge output folder (never a C:\\Users\\Owner literal)', () => {
    delete process.env.OXFORD_EDGE_DIR;
    expect(edgeDir()).toBe(
      join(homedir(), 'OneDrive - Oxford Capital Partners', 'Claude_Workspace', '03_Code', 'oxford-edge', 'output'),
    );
  });

  it('honours OXFORD_EDGE_DIR, resolved at call time', () => {
    process.env.OXFORD_EDGE_DIR = 'D:/elsewhere/edge';
    expect(edgeDir()).toBe('D:/elsewhere/edge');
  });

  it('treats a blank OXFORD_EDGE_DIR as unset', () => {
    process.env.OXFORD_EDGE_DIR = '   ';
    expect(edgeDir()).toContain('oxford-edge');
  });

  it('pins the 7-day firm staleness rule', () => {
    expect(EDGE_STALE_DAYS).toBe(7);
  });
});

describe('series.ts', () => {
  it('re-exports the contract series/unit tables and declares the buy-box types', () => {
    expect(EDGE_SERIES).toHaveLength(18);
    expect(SERIES_UNITS.vac).toBe('pct_level');
    expect([...BUY_BOX_TYPES].sort()).toEqual(['named', 'named_custom']);
  });
});
```

Create `tests/unit/edge-freshness.test.ts`:

```ts
// @vitest-environment node
//
// F1 matrix (spec §9): fresh / exactly-7 / 8-day / mtime-newer-than-pulled / mtime-older /
// future mtime (clock skew → stale, ageDays clamped ≥ 0).
import { describe, expect, it } from 'vitest';
import { edgeFreshness } from '../../server/edge/freshness';

const NOW = new Date('2026-10-02T12:00:00.000Z');
const ms = (iso: string) => Date.parse(iso);

describe('edgeFreshness', () => {
  it('spec example: pulled 2026-07-14 → 80 days old, STALE', () => {
    const f = edgeFreshness('2026-07-14', ms('2026-07-14T18:38:00.000Z'), NOW);
    expect(f).toEqual({
      metaPulled: '2026-07-14', fileMtime: '2026-07-14T18:38:00.000Z', asOf: '2026-07-14',
      ageDays: 80, staleAfterDays: 7, stale: true,
    });
  });

  it('fresh: same day → 0 days, not stale', () => {
    const f = edgeFreshness('2026-10-02', ms('2026-10-02T08:00:00Z'), NOW);
    expect(f.ageDays).toBe(0);
    expect(f.stale).toBe(false);
  });

  it('exactly 7 days → not stale', () => {
    const f = edgeFreshness('2026-09-25', ms('2026-09-25T10:00:00Z'), NOW);
    expect(f.ageDays).toBe(7);
    expect(f.stale).toBe(false);
  });

  it('8 days → stale', () => {
    const f = edgeFreshness('2026-09-24', ms('2026-09-24T10:00:00Z'), NOW);
    expect(f.ageDays).toBe(8);
    expect(f.stale).toBe(true);
  });

  it('mtime newer than pulled (OneDrive re-sync) never makes old data read fresh', () => {
    const f = edgeFreshness('2026-07-14', ms('2026-10-01T10:00:00Z'), NOW);
    expect(f.asOf).toBe('2026-07-14');
    expect(f.ageDays).toBe(80);
    expect(f.stale).toBe(true);
  });

  it('mtime older than pulled → asOf is the mtime date', () => {
    const f = edgeFreshness('2026-09-30', ms('2026-07-14T18:38:00Z'), NOW);
    expect(f.asOf).toBe('2026-07-14');
    expect(f.stale).toBe(true);
  });

  it('future mtime (clock skew) → stale even when the pulled date is recent', () => {
    const f = edgeFreshness('2026-10-01', ms('2026-10-05T00:00:00Z'), NOW);
    expect(f.asOf).toBe('2026-10-01');
    expect(f.ageDays).toBe(1);
    expect(f.stale).toBe(true);
  });

  it('future pulled + future mtime → ageDays clamped to 0 and stale', () => {
    const f = edgeFreshness('2026-10-04', ms('2026-10-05T00:00:00Z'), NOW);
    expect(f.ageDays).toBe(0);
    expect(f.stale).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/edge-config.test.ts tests/unit/edge-freshness.test.ts`
Expected: FAIL — `Failed to resolve import "../../server/edge/config"` / `"../../server/edge/freshness"`.

- [ ] **Step 3: Write the implementation**

Create `server/edge/config.ts`:

```ts
// server/edge/config.ts
//
// Oxford Edge (spec §3). The ONE home of the dataset directory default. Resolved at CALL time
// (same rationale as workbookPath() in server/config.ts): a top-level const would freeze whatever
// process.env held when this module was first imported, before .env loading.
import { homedir } from 'node:os';
import { join } from 'node:path';

/** Firm rule: a mirror more than 7 days behind is never presented as current (spec §12 Q4). */
export const EDGE_STALE_DAYS = 7;

/** Directory holding markets.json. OXFORD_EDGE_DIR overrides; blank counts as unset. */
export function edgeDir(): string {
  const fromEnv = process.env.OXFORD_EDGE_DIR?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), 'OneDrive - Oxford Capital Partners', 'Claude_Workspace', '03_Code', 'oxford-edge', 'output');
}
```

Create `server/edge/series.ts`:

```ts
// server/edge/series.ts
//
// Series vocabulary for the Edge server modules. EDGE_SERIES and SERIES_UNITS are declared once in
// src/contracts/edge.ts (the client needs them too, and src/** may not import server/**); they are
// re-exported here so server code has one local import point.
import type { EdgeMarket } from '../../src/contracts/edge';

export { EDGE_SERIES, SERIES_UNITS } from '../../src/contracts/edge';

/** Market types that make up the 21-market buy-box set (20 named + indianapolis_south). */
export const BUY_BOX_TYPES: ReadonlySet<EdgeMarket['type']> = new Set<EdgeMarket['type']>(['named', 'named_custom']);
```

Create `server/edge/freshness.ts`:

```ts
// server/edge/freshness.ts
//
// Freshness + stale rule (spec §8.2, F1). asOf is the EARLIER of meta.pulled and the file mtime
// date, so an OneDrive re-sync that bumps mtime can never make old data read as fresh. A future
// mtime or pulled date (clock skew) is treated as stale, with ageDays clamped to >= 0. All dates
// are compared as UTC calendar days.
import type { EdgeFreshness } from '../../src/contracts/edge';
import { EDGE_STALE_DAYS } from './config';

const DAY_MS = 86_400_000;

export function edgeFreshness(metaPulled: string, mtimeMs: number, now: Date): EdgeFreshness {
  const fileMtime = new Date(mtimeMs).toISOString();
  const mtimeDate = fileMtime.slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const asOf = metaPulled < mtimeDate ? metaPulled : mtimeDate;
  const rawAge = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / DAY_MS);
  const ageDays = Math.max(0, rawAge);
  const clockSkew = mtimeMs > now.getTime() || metaPulled > today;
  return {
    metaPulled,
    fileMtime,
    asOf,
    ageDays,
    staleAfterDays: EDGE_STALE_DAYS,
    stale: clockSkew || ageDays > EDGE_STALE_DAYS,
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/edge-config.test.ts tests/unit/edge-freshness.test.ts`
Expected: 13 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/edge/config.ts server/edge/series.ts server/edge/freshness.ts tests/unit/edge-config.test.ts tests/unit/edge-freshness.test.ts
git commit -F - <<'EOF'
feat(edge): dataset dir resolver, series vocabulary, freshness rule

Refute-Skip: Oxford Edge Phase 1 — read-only display ingest + manual-pull log; no scoring, NOI, governor or capital math
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 4: `server/edge/coverage.ts` + shared test helpers

**Files:**
- Create: `server/edge/coverage.ts`, `tests/unit/edge-test-helpers.ts`
- Test: `tests/unit/edge-coverage.test.ts`

**Interfaces:**
- Consumes: `EDGE_SERIES`, `EDGE_OBSERVED_STATUSES`, `EdgeMarket`, `EdgeCoverageRow`, `EdgeStatus`, `EdgeMarketsResponse`, `EdgeSeriesCell`, `SERIES_UNITS` (Task 1).
- Produces:
  - `computeCoverage(markets: readonly EdgeMarket[], years: readonly number[]): EdgeCoverageRow[]` (one row per `EDGE_SERIES` key, in order)
  - Test helpers (used by Tasks 5–14): `TEST_YEARS`, `TEST_FIELD_META`, `obs(values)`, `cell(values, status)`, `mkMarket(id, name, state, type, overrides?, subs?)`, `fourMarkets()`, `mkMarketsResponse(markets, overrides?)`

- [ ] **Step 1: Write the helpers and the failing test**

Create `tests/unit/edge-test-helpers.ts`:

```ts
// tests/unit/edge-test-helpers.ts
//
// Synthetic Oxford Edge builders for unit tests. Every value here is MADE UP (spec F14): never
// paste real markets.json numbers into tests. The trueLabels are the file's field descriptions,
// which are not licensed data.
import {
  EDGE_SERIES, SERIES_UNITS,
  type EdgeMarket, type EdgeMarketsResponse, type EdgeSeriesCell, type EdgeSeriesKey,
} from '@contracts/edge';
import { computeCoverage } from '../../server/edge/coverage';

export const TEST_YEARS: readonly number[] = [2021, 2022, 2023, 2024, 2025];

const TRUE_LABELS: Record<EdgeSeriesKey, string> = {
  pop: 'Population growth (Census PEP)',
  job: 'Total nonfarm employment growth (BLS SAE)',
  inc: 'Median household income growth (ACS5)',
  incLevel: 'Median household income, $ level (ACS5)',
  trades: 'Specialty trade contractor employment growth, NAICS 238 (QCEW)',
  biz: 'Total business establishment count growth (Census CBP)',
  hvacPermits: 'Residential building permits authorized, growth (Census BPS)',
  per: 'Industrial (Flex) construction pipeline, kSF (CoStar)',
  loss: 'Demolished SF as % of prior-year inventory (CoStar)',
  truck: 'Truck AADT growth on primary corridors (state DOT)',
  storage: 'Self-storage asking rate growth',
  rent: 'Industrial (Flex) asking rent growth (CoStar)',
  vac: 'Industrial (Flex) vacancy rate (CoStar)',
  carriers: 'New motor-carrier registrations per 10k population (FMCSA)',
  mfgInvest: 'Announced manufacturing investment $',
  ios: 'IOS/contractor-yard listing signal',
  migration: 'Net domestic migration, persons (IRS SOI)',
  eGrocery: 'Courier/messenger establishment count growth, NAICS 492 (Census CBP)',
};
const PROXIES: ReadonlySet<EdgeSeriesKey> = new Set<EdgeSeriesKey>(['biz', 'hvacPermits', 'eGrocery']);

export const TEST_FIELD_META: EdgeMarketsResponse['fieldMeta'] = Object.fromEntries(
  EDGE_SERIES.map((k) => [k, { trueLabel: TRUE_LABELS[k], isProxy: PROXIES.has(k), unit: SERIES_UNITS[k] }]),
);

export function cell(values: Array<number | null>, status: EdgeSeriesCell['status']): EdgeSeriesCell {
  return { values, status };
}

/** Observed where non-null, "Not published" ('null' status) where null. */
export function obs(values: Array<number | null>): EdgeSeriesCell {
  return { values, status: values.map((v) => (v === null ? 'null' : 'actual')) };
}

const PLACEHOLDER: EdgeSeriesCell = cell(
  [null, null, null, null, null],
  ['guide_only', 'guide_only', 'guide_only', 'guide_only', 'guide_only'],
);

export function mkMarket(
  id: string,
  name: string,
  state: string,
  type: EdgeMarket['type'],
  overrides: Partial<Record<EdgeSeriesKey, EdgeSeriesCell>> = {},
  subs: EdgeMarket['subs'] = [],
): EdgeMarket {
  const series = Object.fromEntries(EDGE_SERIES.map((k) => [k, overrides[k] ?? PLACEHOLDER])) as EdgeMarket['series'];
  return { id, name, state, cbsa: '00000', lat: 0, lon: 0, type, trajectory: type === 'auto' ? 'a_growing' : null, subs, series };
}

/** 3 buy-box (columbus, indianapolis_south, richmond) + 1 auto (cedar_rapids, no subs). */
export function fourMarkets(): EdgeMarket[] {
  const base: Partial<Record<EdgeSeriesKey, EdgeSeriesCell>> = {
    pop: obs([0.6, 0.7, 0.8, 0.9, 1.0]),
    trades: obs([2.0, 2.5, 3.0, 3.5, 4.0]),
    per: obs([100, 120, 140, 160, 180]),
    rent: obs([1.0, 1.2, 1.4, 1.6, 1.8]),
    vac: obs([5.0, 4.5, 4.0, 3.5, 3.0]),
    migration: obs([1000, 1100, 1200, null, null]),
    hvacPermits: obs([5.0, -3.0, 4.0, 2.0, null]),
    biz: obs([null, null, 1.0, 1.1, null]),
    eGrocery: obs([null, null, 2.0, 2.2, null]),
  };
  return [
    mkMarket('columbus', 'Columbus', 'OH', 'named', base, [{ name: 'Synthetic Sub A', vac: 3.3, rentGrowth: 1.1, invKsf: 1000 }]),
    mkMarket('indianapolis_south', 'Indianapolis (South Metro)', 'IN', 'named_custom',
      { ...base, trades: obs([1.0, 1.5, 2.0, 2.5, 6.0]) },
      [{ name: 'Synthetic Sub B', vac: 2.0, rentGrowth: 0.5, invKsf: 500 }]),
    mkMarket('cedar_rapids', 'Cedar Rapids', 'IA', 'auto',
      { ...base, trades: cell([1, 1, 1, 1, 9.0], ['actual', 'actual', 'actual', 'actual', 'estimated']) }),
    mkMarket('richmond', 'Richmond', 'VA', 'named',
      { ...base, trades: obs([0.5, 0.5, 0.5, 0.5, 0.5]), truck: obs([1.5, 2.0, -0.5, 3.0, 2.2]) },
      [{ name: 'Synthetic Sub C', vac: 4.0, rentGrowth: 1.0, invKsf: 800 }]),
  ];
}

export function mkMarketsResponse(markets: EdgeMarket[], overrides: Partial<EdgeMarketsResponse> = {}): EdgeMarketsResponse {
  return {
    availability: 'ok',
    dir: 'C:/synthetic/oxford-edge/output',
    freshness: {
      metaPulled: '2026-07-14', fileMtime: '2026-07-14T18:38:00.000Z', asOf: '2026-07-14',
      ageDays: 80, staleAfterDays: 7, stale: true,
    },
    readError: null,
    lastGoodLoadedAt: '2026-10-02T12:00:00.000Z',
    years: [...TEST_YEARS],
    fieldMeta: TEST_FIELD_META,
    sources: Object.fromEntries(EDGE_SERIES.map((k) => [k, [`SYNTH_${k.toUpperCase()}`]])),
    coverage: computeCoverage(markets, TEST_YEARS),
    markets,
    rejectedMarkets: [],
    marketCount: markets.length,
    issues: [],
    outsidePullScope: { truck: [], mfgInvest: [] },
    ...overrides,
  };
}
```

Create `tests/unit/edge-coverage.test.ts`:

```ts
// @vitest-environment node
//
// Coverage rule (spec §5.2): filled iff value !== null AND status ∈ {actual, estimated, nowcast};
// disagreements are not filled and are listed in inconsistent[]; allPlaceholder when nothing filled.
import { describe, expect, it } from 'vitest';
import { EDGE_SERIES } from '@contracts/edge';
import { computeCoverage } from '../../server/edge/coverage';
import { cell, fourMarkets, mkMarket, obs, TEST_YEARS } from './edge-test-helpers';

const row = (rows: ReturnType<typeof computeCoverage>, field: string) => {
  const r = rows.find((x) => x.field === field);
  if (!r) throw new Error(`no coverage row for ${field}`);
  return r;
};

describe('computeCoverage', () => {
  it('returns one row per series in EDGE_SERIES order', () => {
    expect(computeCoverage(fourMarkets(), TEST_YEARS).map((r) => r.field)).toEqual([...EDGE_SERIES]);
  });

  it('counts filled cells per series and per year', () => {
    const rows = computeCoverage(fourMarkets(), TEST_YEARS);
    expect(row(rows, 'pop')).toMatchObject({ filled: 20, total: 20, pct: 1, byYear: [4, 4, 4, 4, 4], allPlaceholder: false });
    expect(row(rows, 'migration')).toMatchObject({ filled: 12, byYear: [4, 4, 4, 0, 0] });
    expect(row(rows, 'truck')).toMatchObject({ filled: 5, total: 20, byYear: [1, 1, 1, 1, 1] });
  });

  it('counts estimated as filled and reports the status mix', () => {
    const r = row(computeCoverage(fourMarkets(), TEST_YEARS), 'trades');
    expect(r.filled).toBe(20);
    expect(r.statusCounts).toEqual({ actual: 19, estimated: 1, nowcast: 0, guide_only: 0, null: 0 });
  });

  it('flags allPlaceholder for storage, mfgInvest and ios', () => {
    const rows = computeCoverage(fourMarkets(), TEST_YEARS);
    for (const f of ['storage', 'mfgInvest', 'ios']) {
      expect(row(rows, f)).toMatchObject({ filled: 0, allPlaceholder: true });
      expect(row(rows, f).statusCounts.guide_only).toBe(20);
    }
  });

  it('lists value/status disagreements as inconsistent and never counts them filled', () => {
    const m = mkMarket('x', 'X', 'OH', 'auto', {
      vac: cell([1.0, null, 2.0, null, 3.0], ['null', 'actual', 'guide_only', 'null', 'actual']),
    });
    const r = row(computeCoverage([m], TEST_YEARS), 'vac');
    expect(r.filled).toBe(1);
    expect(r.inconsistent).toEqual([
      { marketId: 'x', year: 2021 },
      { marketId: 'x', year: 2022 },
      { marketId: 'x', year: 2023 },
    ]);
  });

  it('handles an empty market list without dividing by zero', () => {
    const r = row(computeCoverage([], TEST_YEARS), 'pop');
    expect(r).toMatchObject({ filled: 0, total: 0, pct: 0, allPlaceholder: false, byYear: [0, 0, 0, 0, 0] });
  });

  it('obs() helper marks nulls as Not published', () => {
    expect(obs([1, null]).status).toEqual(['actual', 'null']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/edge-coverage.test.ts`
Expected: FAIL — `Failed to resolve import "../../server/edge/coverage"`.

- [ ] **Step 3: Write the implementation**

Create `server/edge/coverage.ts`:

```ts
// server/edge/coverage.ts
//
// Per-series coverage for the Data health card (spec §5.2, §8.5). A cell counts as FILLED iff
// value !== null AND status ∈ {actual, estimated, nowcast}. A cell whose value and status disagree
// (a value under 'null'/guide_only, or null under an observed status) is NOT filled and is listed in
// `inconsistent`. allPlaceholder = the series has cells but none is filled (storage/mfgInvest/ios today).
import {
  EDGE_OBSERVED_STATUSES, EDGE_SERIES,
  type EdgeCoverageRow, type EdgeMarket, type EdgeStatus,
} from '../../src/contracts/edge';

export function computeCoverage(markets: readonly EdgeMarket[], years: readonly number[]): EdgeCoverageRow[] {
  return EDGE_SERIES.map((field) => {
    const byYear = years.map(() => 0);
    const statusCounts: Record<EdgeStatus, number> = { actual: 0, estimated: 0, nowcast: 0, guide_only: 0, null: 0 };
    const inconsistent: Array<{ marketId: string; year: number }> = [];
    let filled = 0;
    for (const m of markets) {
      const c = m.series[field];
      years.forEach((year, i) => {
        const status: EdgeStatus = c.status[i] ?? 'null';
        const value = c.values[i] ?? null;
        statusCounts[status] += 1;
        const observedStatus = EDGE_OBSERVED_STATUSES.includes(status);
        if (observedStatus && value !== null) {
          filled += 1;
          byYear[i] = (byYear[i] ?? 0) + 1;
        } else if (observedStatus !== (value !== null)) {
          inconsistent.push({ marketId: m.id, year });
        }
      });
    }
    const total = markets.length * years.length;
    return {
      field,
      filled,
      total,
      pct: total === 0 ? 0 : filled / total,
      byYear,
      allPlaceholder: total > 0 && filled === 0,
      statusCounts,
      inconsistent,
    };
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/edge-coverage.test.ts`
Expected: 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add server/edge/coverage.ts tests/unit/edge-test-helpers.ts tests/unit/edge-coverage.test.ts
git commit -F - <<'EOF'
feat(edge): per-series coverage computation + synthetic test builders

Refute-Skip: Oxford Edge Phase 1 — read-only display ingest + manual-pull log; no scoring, NOI, governor or capital math
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 5: Synthetic fixture + read-only loader `server/edge/loader.ts`

**Files:**
- Create: `tests/fixtures/edge/markets.slice.json`, `server/edge/loader.ts`
- Test: `tests/unit/edge-loader.test.ts`

**Interfaces:**
- Consumes: `computeCoverage` (Task 4), `edgeFreshness` (Task 3), contracts (Task 1).
- Produces:
  - `type EdgeLoadResult = Omit<EdgeMarketsResponse, 'outsidePullScope'>`
  - `interface EdgeFsDeps { readFile(path: string): string; stat(path: string): { mtimeMs: number; size: number }; sleep(ms: number): Promise<void> }`
  - `NODE_EDGE_FS: EdgeFsDeps`
  - `loadEdgeDataset(dir: string, now: Date, deps?: EdgeFsDeps): Promise<EdgeLoadResult>`
  - `resetEdgeLoaderCache(): void`
  - `RawEdgeMeta` (Zod, strict), `rawEdgeMarketSchema(yearCount: number)`

- [ ] **Step 1: Create the synthetic fixture**

Create `tests/fixtures/edge/markets.slice.json` (all values fabricated; shape and status patterns mirror the real file):

```json
{
  "_synthetic": true,
  "_comment": "SYNTHETIC Oxford Edge fixture (spec F14). Real field shape and status patterns; every number is made up. Never paste real markets.json values here — rent/vac/per/loss/subs are CoStar-licensed.",
  "meta": {
    "pulled": "2026-07-14",
    "years": [2021, 2022, 2023, 2024, 2025],
    "sources": {
      "pop": ["SYNTH_PEP"], "job": ["SYNTH_SAE"], "inc": ["SYNTH_ACS5"], "trades": ["SYNTH_QCEW_238"],
      "biz": ["SYNTH_CBP"], "hvacPermits": ["SYNTH_BPS"], "per": ["SYNTH_COSTAR_FLEX"], "loss": ["SYNTH_COSTAR_FLEX"],
      "truck": ["SYNTH_VDOT", "SYNTH_ODOT_TIMS_decommissioned"], "storage": ["SYNTH_GUIDE_ONLY"], "rent": ["SYNTH_COSTAR_FLEX"],
      "vac": ["SYNTH_COSTAR_FLEX"], "carriers": ["SYNTH_FMCSA"], "mfgInvest": ["SYNTH_GUIDE_ONLY"], "ios": ["SYNTH_GUIDE_ONLY"],
      "migration": ["SYNTH_IRS_SOI"], "eGrocery": ["SYNTH_CBP_492"], "incLevel": ["SYNTH_ACS5"]
    },
    "statusEnum": ["actual", "estimated", "nowcast", "guide_only", "null"],
    "fieldMeta": {
      "pop": { "trueLabel": "Population growth (Census PEP)", "isProxy": false },
      "job": { "trueLabel": "Total nonfarm employment growth (BLS SAE)", "isProxy": false },
      "inc": { "trueLabel": "Median household income growth (ACS5)", "isProxy": false },
      "trades": { "trueLabel": "Specialty trade contractor employment growth, NAICS 238 (QCEW)", "isProxy": false },
      "biz": { "trueLabel": "Total business establishment count growth (Census CBP)", "isProxy": true },
      "hvacPermits": { "trueLabel": "Residential building permits authorized, growth (Census BPS)", "isProxy": true },
      "per": { "trueLabel": "Industrial (Flex) construction pipeline, kSF (CoStar)", "isProxy": false },
      "loss": { "trueLabel": "Demolished SF as % of prior-year inventory (CoStar)", "isProxy": false },
      "truck": { "trueLabel": "Truck AADT growth on primary corridors (state DOT)", "isProxy": false },
      "storage": { "trueLabel": "Self-storage asking rate growth", "isProxy": false },
      "rent": { "trueLabel": "Industrial (Flex) asking rent growth (CoStar)", "isProxy": false },
      "vac": { "trueLabel": "Industrial (Flex) vacancy rate (CoStar)", "isProxy": false },
      "carriers": { "trueLabel": "New motor-carrier registrations per 10k population (FMCSA)", "isProxy": false },
      "mfgInvest": { "trueLabel": "Announced manufacturing investment $", "isProxy": false },
      "ios": { "trueLabel": "IOS/contractor-yard listing signal", "isProxy": false },
      "migration": { "trueLabel": "Net domestic migration, persons (IRS SOI)", "isProxy": false },
      "eGrocery": { "trueLabel": "Courier/messenger establishment count growth, NAICS 492 (Census CBP)", "isProxy": true },
      "incLevel": { "trueLabel": "Median household income, $ level (ACS5)", "isProxy": false }
    }
  },
  "markets": [
    {
      "id": "columbus", "name": "Columbus", "state": "OH", "cbsa": "18140", "lat": 40.0, "lon": -83.0, "type": "named", "trajectory": null,
      "pop": [0.6, 0.7, 0.8, 0.9, 1.0], "job": [1.0, 1.1, 1.2, 1.3, 1.4], "inc": [null, 2.0, 2.1, 2.2, null],
      "trades": [2.0, 2.5, 3.0, 3.5, 4.0], "biz": [null, null, 1.0, 1.1, null], "hvacPermits": [5.0, -3.0, 4.0, 2.0, null],
      "per": [100.0, 120.0, 140.0, 160.0, 180.0], "loss": [0.0, 0.1, 0.0, 0.0, 0.1], "truck": [null, null, null, null, null],
      "storage": [null, null, null, null, null], "rent": [1.0, 1.2, 1.4, 1.6, 1.8], "vac": [5.0, 4.5, 4.0, 3.5, 3.0],
      "carriers": [3.0, 3.1, 3.2, 3.3, 3.4], "mfgInvest": [null, null, null, null, null], "ios": [null, null, null, null, null],
      "migration": [1000, 1100, 1200, null, null], "eGrocery": [null, null, 2.0, 2.2, null], "incLevel": [60000, 61000, 62000, 63000, null],
      "status": {
        "pop": ["actual", "actual", "actual", "actual", "actual"], "job": ["actual", "actual", "actual", "actual", "actual"],
        "inc": ["null", "actual", "actual", "actual", "null"], "trades": ["actual", "actual", "actual", "actual", "actual"],
        "biz": ["null", "null", "actual", "actual", "null"], "hvacPermits": ["actual", "actual", "actual", "actual", "null"],
        "per": ["actual", "actual", "actual", "actual", "actual"], "loss": ["actual", "actual", "actual", "actual", "actual"],
        "truck": ["guide_only", "guide_only", "guide_only", "guide_only", "guide_only"], "storage": ["guide_only", "guide_only", "guide_only", "guide_only", "guide_only"],
        "rent": ["actual", "actual", "actual", "actual", "actual"], "vac": ["actual", "actual", "actual", "actual", "actual"],
        "carriers": ["actual", "actual", "actual", "actual", "actual"], "mfgInvest": ["guide_only", "guide_only", "guide_only", "guide_only", "guide_only"],
        "ios": ["guide_only", "guide_only", "guide_only", "guide_only", "guide_only"], "migration": ["actual", "actual", "actual", "null", "null"],
        "eGrocery": ["null", "null", "actual", "actual", "null"], "incLevel": ["actual", "actual", "actual", "actual", "null"]
      },
      "subs": [{ "name": "Synthetic Sub A", "vac": 3.3, "rentGrowth": 1.1, "invKsf": 1000.0 }, { "name": "Synthetic Sub B", "vac": 6.1, "rentGrowth": 0.4, "invKsf": 750.0 }]
    },
    {
      "id": "indianapolis_south", "name": "Indianapolis (South Metro)", "state": "IN", "cbsa": "26900S", "lat": 39.5, "lon": -86.1, "type": "named_custom", "trajectory": null,
      "pop": [0.9, 1.0, 1.1, 1.2, 1.3], "job": [1.5, 1.4, 1.3, 1.2, 1.1], "inc": [null, 3.0, 3.1, 3.2, null],
      "trades": [1.0, 1.5, 2.0, 2.5, 6.0], "biz": [null, null, 0.5, 0.6, null], "hvacPermits": [8.0, 2.0, -1.0, 3.0, null],
      "per": [50.0, 60.0, 70.0, 80.0, 90.0], "loss": [0.0, 0.0, 0.0, 0.2, 0.0], "truck": [null, null, null, null, null],
      "storage": [null, null, null, null, null], "rent": [0.8, 0.9, 1.0, 1.1, 1.2], "vac": [3.0, 2.8, 2.6, 2.4, 2.2],
      "carriers": [2.0, 2.1, 2.2, 2.3, 2.4], "mfgInvest": [null, null, null, null, null], "ios": [null, null, null, null, null],
      "migration": [2000, 2100, 2200, null, null], "eGrocery": [null, null, 1.0, 1.5, null], "incLevel": [70000, 71000, 72000, 73000, null],
      "status": {
        "pop": ["actual", "actual", "actual", "actual", "actual"], "job": ["actual", "actual", "actual", "actual", "actual"],
        "inc": ["null", "actual", "actual", "actual", "null"], "trades": ["actual", "actual", "actual", "actual", "actual"],
        "biz": ["null", "null", "actual", "actual", "null"], "hvacPermits": ["actual", "actual", "actual", "actual", "null"],
        "per": ["actual", "actual", "actual", "actual", "actual"], "loss": ["actual", "actual", "actual", "actual", "actual"],
        "truck": ["guide_only", "guide_only", "guide_only", "guide_only", "guide_only"], "storage": ["guide_only", "guide_only", "guide_only", "guide_only", "guide_only"],
        "rent": ["actual", "actual", "actual", "actual", "actual"], "vac": ["actual", "actual", "actual", "actual", "actual"],
        "carriers": ["actual", "actual", "actual", "actual", "actual"], "mfgInvest": ["guide_only", "guide_only", "guide_only", "guide_only", "guide_only"],
        "ios": ["guide_only", "guide_only", "guide_only", "guide_only", "guide_only"], "migration": ["actual", "actual", "actual", "null", "null"],
        "eGrocery": ["null", "null", "actual", "actual", "null"], "incLevel": ["actual", "actual", "actual", "actual", "null"]
      },
      "subs": [{ "name": "Synthetic Sub C", "vac": 2.0, "rentGrowth": 0.5, "invKsf": 500.0 }]
    },
    {
      "id": "cedar_rapids", "name": "Cedar Rapids", "state": "IA", "cbsa": "16300", "lat": 42.0, "lon": -91.7, "type": "auto", "trajectory": "a_growing",
      "pop": [0.1, 0.2, 0.3, 0.4, 0.5], "job": [0.5, 0.6, 0.7, 0.8, 0.9], "inc": [null, 1.0, 1.1, 1.2, null],
      "trades": [1.0, 1.0, 1.0, 1.0, 9.0], "biz": [null, null, 0.2, 0.3, null], "hvacPermits": [1.0, 1.0, 1.0, 1.0, null],
      "per": [10.0, 20.0, 30.0, 40.0, 50.0], "loss": [0.0, 0.0, 0.0, 0.0, 0.0], "truck": [null, null, null, null, null],
      "storage": [null, null, null, null, null], "rent": [0.1, 0.2, 0.3, 0.4, 0.5], "vac": [7.0, 6.5, 6.0, 5.5, 5.0],
      "carriers": [1.0, 1.1, 1.2, 1.3, 1.4], "mfgInvest": [null, null, null, null, null], "ios": [null, null, null, null, null],
      "migration": [-100, -200, -300, null, null], "eGrocery": [null, null, 0.1, 0.2, null], "incLevel": [55000, 56000, 57000, 58000, null],
      "status": {
        "pop": ["actual", "actual", "actual", "actual", "actual"], "job": ["actual", "actual", "actual", "actual", "actual"],
        "inc": ["null", "actual", "actual", "actual", "null"], "trades": ["actual", "actual", "actual", "actual", "estimated"],
        "biz": ["null", "null", "actual", "actual", "null"], "hvacPermits": ["actual", "actual", "actual", "actual", "null"],
        "per": ["actual", "actual", "actual", "actual", "actual"], "loss": ["actual", "actual", "actual", "actual", "actual"],
        "truck": ["guide_only", "guide_only", "guide_only", "guide_only", "guide_only"], "storage": ["guide_only", "guide_only", "guide_only", "guide_only", "guide_only"],
        "rent": ["actual", "actual", "actual", "actual", "actual"], "vac": ["actual", "actual", "actual", "actual", "actual"],
        "carriers": ["actual", "actual", "actual", "actual", "actual"], "mfgInvest": ["guide_only", "guide_only", "guide_only", "guide_only", "guide_only"],
        "ios": ["guide_only", "guide_only", "guide_only", "guide_only", "guide_only"], "migration": ["actual", "actual", "actual", "null", "null"],
        "eGrocery": ["null", "null", "actual", "actual", "null"], "incLevel": ["actual", "actual", "actual", "actual", "null"]
      },
      "subs": []
    },
    {
      "id": "richmond", "name": "Richmond", "state": "VA", "cbsa": "40060", "lat": 37.5, "lon": -77.4, "type": "named", "trajectory": null,
      "pop": [0.4, 0.5, 0.6, 0.7, 0.8], "job": [1.2, 1.3, 1.4, 1.5, 1.6], "inc": [null, 2.5, 2.6, 2.7, null],
      "trades": [0.5, 0.5, 0.5, 0.5, 0.5], "biz": [null, null, 0.9, 1.0, null], "hvacPermits": [3.0, 4.0, 5.0, 6.0, null],
      "per": [200.0, 210.0, 220.0, 230.0, 240.0], "loss": [0.1, 0.1, 0.1, 0.1, 0.1], "truck": [1.5, 2.0, -0.5, 3.0, 2.2],
      "storage": [null, null, null, null, null], "rent": [1.5, 1.6, 1.7, 1.8, 1.9], "vac": [4.0, 4.1, 4.2, 4.3, 4.4],
      "carriers": [4.0, 4.1, 4.2, 4.3, 4.4], "mfgInvest": [null, null, null, null, null], "ios": [null, null, null, null, null],
      "migration": [3000, 3100, 3200, null, null], "eGrocery": [null, null, 3.0, 3.1, null], "incLevel": [65000, 66000, 67000, 68000, null],
      "status": {
        "pop": ["actual", "actual", "actual", "actual", "actual"], "job": ["actual", "actual", "actual", "actual", "actual"],
        "inc": ["null", "actual", "actual", "actual", "null"], "trades": ["actual", "actual", "actual", "actual", "actual"],
        "biz": ["null", "null", "actual", "actual", "null"], "hvacPermits": ["actual", "actual", "actual", "actual", "null"],
        "per": ["actual", "actual", "actual", "actual", "actual"], "loss": ["actual", "actual", "actual", "actual", "actual"],
        "truck": ["actual", "actual", "actual", "actual", "actual"], "storage": ["guide_only", "guide_only", "guide_only", "guide_only", "guide_only"],
        "rent": ["actual", "actual", "actual", "actual", "actual"], "vac": ["actual", "actual", "actual", "actual", "actual"],
        "carriers": ["actual", "actual", "actual", "actual", "actual"], "mfgInvest": ["guide_only", "guide_only", "guide_only", "guide_only", "guide_only"],
        "ios": ["guide_only", "guide_only", "guide_only", "guide_only", "guide_only"], "migration": ["actual", "actual", "actual", "null", "null"],
        "eGrocery": ["null", "null", "actual", "actual", "null"], "incLevel": ["actual", "actual", "actual", "actual", "null"]
      },
      "subs": [{ "name": "Synthetic Sub D", "vac": 4.0, "rentGrowth": 1.0, "invKsf": 800.0 }]
    }
  ]
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/unit/edge-loader.test.ts`:

```ts
// @vitest-environment node
//
// tests/unit/edge-loader.test.ts — read-only loader (spec §4, §9 F5–F8, F14, §10).
// Fake fs deps for retry/memo/last-good; a real tmpdir copy for the no-write guarantees.
import { copyFileSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { EDGE_SERIES, SERIES_UNITS } from '@contracts/edge';
import { loadEdgeDataset, resetEdgeLoaderCache, type EdgeFsDeps, type EdgeLoadResult } from '../../server/edge/loader';

const FIXTURE_PATH = join(__dirname, '..', 'fixtures', 'edge', 'markets.slice.json');
const FIXTURE_TEXT = readFileSync(FIXTURE_PATH, 'utf8');
const NOW = new Date('2026-10-02T12:00:00.000Z');
const LOADER_SRC = readFileSync(resolve(__dirname, '..', '..', 'server', 'edge', 'loader.ts'), 'utf8');

function errno(code: string): Error {
  return Object.assign(new Error(`${code}: simulated`), { code });
}

function fakeFs(opts: { text: () => string; stat?: () => { mtimeMs: number; size: number } }) {
  const calls = { read: 0, sleeps: [] as number[] };
  const deps: EdgeFsDeps = {
    readFile: () => {
      calls.read += 1;
      return opts.text();
    },
    stat: opts.stat ?? (() => ({ mtimeMs: Date.parse('2026-07-14T18:38:00Z'), size: FIXTURE_TEXT.length })),
    sleep: async (ms) => {
      calls.sleeps.push(ms);
    },
  };
  return { deps, calls };
}

const cov = (r: EdgeLoadResult, field: string) => r.coverage.find((c) => c.field === field);

beforeEach(() => resetEdgeLoaderCache());

describe('fixture (F14)', () => {
  it('is synthetic', () => {
    expect((JSON.parse(FIXTURE_TEXT) as { _synthetic?: unknown })._synthetic).toBe(true);
  });

  it('SERIES_UNITS and fieldMeta agree on the series key set', () => {
    const meta = (JSON.parse(FIXTURE_TEXT) as { meta: { fieldMeta: Record<string, unknown> } }).meta;
    expect(Object.keys(meta.fieldMeta).sort()).toEqual(Object.keys(SERIES_UNITS).sort());
    expect(Object.keys(meta.fieldMeta).sort()).toEqual([...EDGE_SERIES].sort());
  });
});

describe('loadEdgeDataset — happy path', () => {
  it('parses the fixture into the reshaped output contract', async () => {
    const { deps } = fakeFs({ text: () => FIXTURE_TEXT });
    const r = await loadEdgeDataset('mem://happy', NOW, deps);
    expect(r.availability).toBe('ok');
    expect(r.marketCount).toBe(4);
    expect(r.markets.map((m) => m.id)).toEqual(['columbus', 'indianapolis_south', 'cedar_rapids', 'richmond']);
    const columbus = r.markets[0]!;
    expect(columbus.series.vac).toEqual({ values: [5.0, 4.5, 4.0, 3.5, 3.0], status: ['actual', 'actual', 'actual', 'actual', 'actual'] });
    expect(r.markets[2]!.subs).toEqual([]);
    expect(r.fieldMeta.hvacPermits).toEqual({
      trueLabel: 'Residential building permits authorized, growth (Census BPS)', isProxy: true, unit: 'pct_yoy',
    });
    expect(r.freshness).toMatchObject({ asOf: '2026-07-14', ageDays: 80, stale: true });
    expect(r.readError).toBeNull();
    expect(r.rejectedMarkets).toEqual([]);
  });

  it('pins coverage against the fixture counts', async () => {
    const { deps } = fakeFs({ text: () => FIXTURE_TEXT });
    const r = await loadEdgeDataset('mem://coverage', NOW, deps);
    expect(cov(r, 'truck')).toMatchObject({ filled: 5, total: 20, byYear: [1, 1, 1, 1, 1], allPlaceholder: false });
    expect(cov(r, 'storage')).toMatchObject({ filled: 0, allPlaceholder: true });
    expect(cov(r, 'trades')!.statusCounts.estimated).toBe(1);
    expect(cov(r, 'inc')).toMatchObject({ filled: 12, byYear: [0, 4, 4, 4, 0] });
    expect(cov(r, 'migration')).toMatchObject({ filled: 12, byYear: [4, 4, 4, 0, 0] });
  });
});

describe('loadEdgeDataset — missing / unreadable / invalid (F5, F6, F7)', () => {
  it('nonexistent dir → missing, never throws', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'edge-missing-')), 'nope');
    const r = await loadEdgeDataset(dir, NOW);
    expect(r).toMatchObject({ availability: 'missing', dir, markets: [], marketCount: 0, freshness: null });
  });

  it('EBUSY twice then OK → succeeds after two 250 ms backoffs', async () => {
    let n = 0;
    const { deps, calls } = fakeFs({
      text: () => {
        n += 1;
        if (n <= 2) throw errno('EBUSY');
        return FIXTURE_TEXT;
      },
    });
    const r = await loadEdgeDataset('mem://ebusy', NOW, deps);
    expect(r.availability).toBe('ok');
    expect(calls.sleeps).toEqual([250, 250]);
  });

  it('EBUSY on every attempt with no last-good → unreadable with the error in issues', async () => {
    const { deps, calls } = fakeFs({ text: () => { throw errno('EBUSY'); } });
    const r = await loadEdgeDataset('mem://ebusy-cold', NOW, deps);
    expect(r.availability).toBe('unreadable');
    expect(r.issues[0]).toContain('EBUSY');
    expect(calls.read).toBe(3);
  });

  it('truncated JSON cold → unreadable', async () => {
    const { deps } = fakeFs({ text: () => FIXTURE_TEXT.slice(0, 500) });
    const r = await loadEdgeDataset('mem://trunc-cold', NOW, deps);
    expect(r.availability).toBe('unreadable');
    expect(r.issues[0]).toContain('not valid JSON');
  });

  it('truncated JSON after a good load → last-good served with readError', async () => {
    let mtime = 1;
    let text = FIXTURE_TEXT;
    const { deps } = fakeFs({ text: () => text, stat: () => ({ mtimeMs: mtime, size: text.length }) });
    const first = await loadEdgeDataset('mem://trunc-warm', NOW, deps);
    expect(first.availability).toBe('ok');
    mtime = 2;
    text = FIXTURE_TEXT.slice(0, 500);
    const r = await loadEdgeDataset('mem://trunc-warm', new Date('2026-10-02T13:00:00Z'), deps);
    expect(r.availability).toBe('ok');
    expect(r.marketCount).toBe(4);
    expect(r.readError).toContain('not valid JSON');
    expect(r.lastGoodLoadedAt).toBe(NOW.toISOString());
  });

  it('meta missing fieldMeta → invalid with at most 5 issues', async () => {
    const broken = JSON.parse(FIXTURE_TEXT) as { meta: Record<string, unknown> };
    delete broken.meta.fieldMeta;
    const { deps } = fakeFs({ text: () => JSON.stringify(broken) });
    const r = await loadEdgeDataset('mem://invalid', NOW, deps);
    expect(r.availability).toBe('invalid');
    expect(r.markets).toEqual([]);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(r.issues.length).toBeLessThanOrEqual(5);
    expect(r.issues.join(' ')).toContain('fieldMeta');
  });

  it('a malformed market is quarantined; the rest are served', async () => {
    const f = JSON.parse(FIXTURE_TEXT) as { markets: unknown[] };
    f.markets.push({ id: 'broken', name: 'Broken' });
    const { deps } = fakeFs({ text: () => JSON.stringify(f) });
    const r = await loadEdgeDataset('mem://quarantine', NOW, deps);
    expect(r.marketCount).toBe(4);
    expect(r.rejectedMarkets).toHaveLength(1);
    expect(r.rejectedMarkets[0]!.id).toBe('broken');
  });

  it('a market whose series length differs from years.length is quarantined', async () => {
    const f = JSON.parse(FIXTURE_TEXT) as { markets: Array<Record<string, unknown>> };
    f.markets.push({ ...f.markets[0]!, id: 'short_years', pop: [1, 2, 3, 4] });
    const { deps } = fakeFs({ text: () => JSON.stringify(f) });
    const r = await loadEdgeDataset('mem://years', NOW, deps);
    expect(r.rejectedMarkets.map((x) => x.id)).toEqual(['short_years']);
    expect(r.rejectedMarkets[0]!.reason).toContain('pop');
  });
});

describe('loadEdgeDataset — memo', () => {
  it('re-parses only when mtime or size changes', async () => {
    let mtime = 1;
    const { deps, calls } = fakeFs({ text: () => FIXTURE_TEXT, stat: () => ({ mtimeMs: mtime, size: FIXTURE_TEXT.length }) });
    await loadEdgeDataset('mem://memo', NOW, deps);
    await loadEdgeDataset('mem://memo', NOW, deps);
    expect(calls.read).toBe(1);
    mtime = 2;
    await loadEdgeDataset('mem://memo', NOW, deps);
    expect(calls.read).toBe(2);
  });
});

describe('no-write guarantees (F8)', () => {
  it('imports only readFileSync/statSync from node:fs and calls no write API', () => {
    expect(LOADER_SRC).toContain("import { readFileSync, statSync } from 'node:fs';");
    expect(LOADER_SRC.match(/from ['"](node:)?fs(\/promises)?['"]/g)).toHaveLength(1);
    expect(LOADER_SRC).not.toMatch(
      /\b(writeFile|writeFileSync|appendFile|appendFileSync|rename|renameSync|unlink|unlinkSync|copyFile|copyFileSync|rmSync|mkdir|mkdirSync|createWriteStream|truncate|truncateSync)\s*\(/,
    );
  });

  it('leaves markets.json mtime, size and bytes unchanged after a real load', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'edge-nowrite-'));
    const file = join(dir, 'markets.json');
    copyFileSync(FIXTURE_PATH, file);
    const before = statSync(file);
    const r = await loadEdgeDataset(dir, NOW);
    expect(r.availability).toBe('ok');
    const after = statSync(file);
    expect(after.mtimeMs).toBe(before.mtimeMs);
    expect(after.size).toBe(before.size);
    expect(readFileSync(file, 'utf8')).toBe(FIXTURE_TEXT);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run tests/unit/edge-loader.test.ts`
Expected: FAIL — `Failed to resolve import "../../server/edge/loader"` (and `ENOENT` for `LOADER_SRC`).

- [ ] **Step 4: Write the loader**

Create `server/edge/loader.ts`:

```ts
// server/edge/loader.ts
//
// Read-only loader for the Oxford Edge dataset (spec §3–§4, §9 F5–F8). markets.json is written ONLY
// by the upstream oxford-edge pipeline. This module imports exactly two fs functions, readFileSync
// and statSync; tests/unit/edge-loader.test.ts fails if any other fs call ever appears here.
//
// Flow: stat → memo key (mtimeMs, size) → read with retry (EBUSY/EPERM/EACCES, 3 attempts, 250 ms
// backoff: OneDrive lock / mid-sync) → JSON.parse → strict RawEdgeMeta → per-market safeParse
// (bad markets quarantined, not fatal) → reshape to the EdgeMarket output contract. A read/parse
// failure after a good load serves the last-good copy with readError set; `unreadable` / `invalid`
// are returned only when no last-good exists. `missing` (ENOENT) never serves last-good.
import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import {
  EDGE_SERIES, EdgeMarketType, EdgeStatus, EdgeSub, EdgeTrajectory, SERIES_UNITS,
  type EdgeAvailability, type EdgeFieldMeta, type EdgeMarket, type EdgeMarketsResponse,
  type EdgeRejectedMarket, type EdgeSeriesKey,
} from '../../src/contracts/edge';
import { computeCoverage } from './coverage';
import { edgeFreshness } from './freshness';

export type EdgeLoadResult = Omit<EdgeMarketsResponse, 'outsidePullScope'>;

export interface EdgeFsDeps {
  readFile: (path: string) => string;
  stat: (path: string) => { mtimeMs: number; size: number };
  sleep: (ms: number) => Promise<void>;
}

export const NODE_EDGE_FS: EdgeFsDeps = {
  readFile: (path) => readFileSync(path, 'utf8'),
  stat: (path) => {
    const s = statSync(path);
    return { mtimeMs: s.mtimeMs, size: s.size };
  },
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

const RETRYABLE_CODES: ReadonlySet<string> = new Set(['EBUSY', 'EPERM', 'EACCES']);
const MISSING_CODES: ReadonlySet<string> = new Set(['ENOENT', 'ENOTDIR']);
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = 250;

/** Strict on meta (spec F7): an upstream key rename or addition fails loudly as `invalid`. */
export const RawEdgeMeta = z
  .object({
    pulled: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    years: z.array(z.number().int()).min(1),
    sources: z.record(z.string(), z.array(z.string())),
    statusEnum: z.array(z.string()),
    fieldMeta: z.record(z.string(), z.object({ trueLabel: z.string(), isProxy: z.boolean() }).strict()),
  })
  .strict();
type RawEdgeMeta = z.infer<typeof RawEdgeMeta>;

const RawEdgeFile = z.object({ meta: z.unknown(), markets: z.array(z.unknown()) });

/** Raw market schema, parameterized by years.length so every series/status array must match it. */
export function rawEdgeMarketSchema(yearCount: number) {
  const values = z.array(z.number().nullable()).length(yearCount);
  const statuses = z.array(EdgeStatus).length(yearCount);
  const seriesShape = Object.fromEntries(EDGE_SERIES.map((k) => [k, values])) as Record<EdgeSeriesKey, typeof values>;
  const statusShape = Object.fromEntries(EDGE_SERIES.map((k) => [k, statuses])) as Record<EdgeSeriesKey, typeof statuses>;
  return z.object({
    id: z.string().min(1),
    name: z.string(),
    state: z.string().length(2),
    cbsa: z.string(),
    lat: z.number(),
    lon: z.number(),
    type: EdgeMarketType,
    trajectory: EdgeTrajectory.nullable(),
    subs: z.array(EdgeSub),
    status: z.object(statusShape),
    ...seriesShape,
  });
}
type RawEdgeMarket = z.infer<ReturnType<typeof rawEdgeMarketSchema>>;

interface ParsedDataset {
  meta: RawEdgeMeta;
  markets: EdgeMarket[];
  rejectedMarkets: EdgeRejectedMarket[];
  mtimeMs: number;
  size: number;
  loadedAt: string;
}

/** Last good parse per directory: doubles as the memo (keyed by mtimeMs + size) and the last-good cache. */
const cache = new Map<string, ParsedDataset>();

export function resetEdgeLoaderCache(): void {
  cache.clear();
}

function errCode(e: unknown): string | null {
  if (typeof e === 'object' && e !== null && 'code' in e && typeof (e as { code: unknown }).code === 'string') {
    return (e as { code: string }).code;
  }
  return null;
}

function messageOf(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

async function withRetry<T>(fn: () => T, deps: EdgeFsDeps): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return fn();
    } catch (e) {
      const code = errCode(e);
      if (code === null || !RETRYABLE_CODES.has(code) || attempt >= MAX_ATTEMPTS) throw e;
      await deps.sleep(BACKOFF_MS);
    }
  }
}

function formatIssues(issues: readonly z.ZodIssue[], max: number): string[] {
  return issues.slice(0, max).map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`);
}

function idOf(raw: unknown): string | null {
  if (typeof raw === 'object' && raw !== null && typeof (raw as { id?: unknown }).id === 'string') {
    return (raw as { id: string }).id;
  }
  return null;
}

function toEdgeMarket(raw: RawEdgeMarket): EdgeMarket {
  const series = Object.fromEntries(
    EDGE_SERIES.map((k) => [k, { values: raw[k], status: raw.status[k] }]),
  ) as EdgeMarket['series'];
  return {
    id: raw.id,
    name: raw.name,
    state: raw.state,
    cbsa: raw.cbsa,
    lat: raw.lat,
    lon: raw.lon,
    type: raw.type,
    trajectory: raw.trajectory,
    subs: raw.subs,
    series,
  };
}

function emptyResult(availability: EdgeAvailability, dir: string, issues: string[]): EdgeLoadResult {
  return {
    availability,
    dir,
    freshness: null,
    readError: null,
    lastGoodLoadedAt: null,
    years: [],
    fieldMeta: {},
    sources: {},
    coverage: [],
    markets: [],
    rejectedMarkets: [],
    marketCount: 0,
    issues,
  };
}

function fromParsed(dir: string, p: ParsedDataset, now: Date, readError: string | null): EdgeLoadResult {
  const fieldMeta: Partial<Record<EdgeSeriesKey, EdgeFieldMeta>> = {};
  for (const k of EDGE_SERIES) {
    const fm = p.meta.fieldMeta[k];
    if (fm) fieldMeta[k] = { trueLabel: fm.trueLabel, isProxy: fm.isProxy, unit: SERIES_UNITS[k] };
  }
  return {
    availability: 'ok',
    dir,
    freshness: edgeFreshness(p.meta.pulled, p.mtimeMs, now),
    readError,
    lastGoodLoadedAt: p.loadedAt,
    years: p.meta.years,
    fieldMeta,
    sources: p.meta.sources,
    coverage: computeCoverage(p.markets, p.meta.years),
    markets: p.markets,
    rejectedMarkets: p.rejectedMarkets,
    marketCount: p.markets.length,
    issues: [],
  };
}

export async function loadEdgeDataset(dir: string, now: Date, deps: EdgeFsDeps = NODE_EDGE_FS): Promise<EdgeLoadResult> {
  const file = join(dir, 'markets.json');
  const lastGood = cache.get(dir) ?? null;
  const serveLastGoodOr = (fallback: EdgeLoadResult, readError: string): EdgeLoadResult =>
    lastGood ? fromParsed(dir, lastGood, now, readError) : fallback;

  let st: { mtimeMs: number; size: number };
  try {
    st = await withRetry(() => deps.stat(file), deps);
  } catch (e) {
    const code = errCode(e);
    if (code !== null && MISSING_CODES.has(code)) return emptyResult('missing', dir, []);
    const msg = `stat failed: ${messageOf(e)}`;
    return serveLastGoodOr(emptyResult('unreadable', dir, [msg]), msg);
  }

  if (lastGood && lastGood.mtimeMs === st.mtimeMs && lastGood.size === st.size) {
    return fromParsed(dir, lastGood, now, null);
  }

  let text: string;
  try {
    text = await withRetry(() => deps.readFile(file), deps);
  } catch (e) {
    const code = errCode(e);
    if (code !== null && MISSING_CODES.has(code)) return emptyResult('missing', dir, []);
    const msg = messageOf(e);
    return serveLastGoodOr(emptyResult('unreadable', dir, [msg]), msg);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    const msg = `markets.json is not valid JSON (${messageOf(e)})`;
    return serveLastGoodOr(emptyResult('unreadable', dir, [msg]), msg);
  }

  const fileShape = RawEdgeFile.safeParse(json);
  if (!fileShape.success) {
    const issues = formatIssues(fileShape.error.issues, 5);
    return serveLastGoodOr(emptyResult('invalid', dir, issues), `markets.json failed schema validation: ${issues[0] ?? ''}`);
  }
  const meta = RawEdgeMeta.safeParse(fileShape.data.meta);
  if (!meta.success) {
    const issues = formatIssues(meta.error.issues, 5).map((i) => `meta.${i}`);
    return serveLastGoodOr(emptyResult('invalid', dir, issues), `markets.json failed schema validation: ${issues[0] ?? ''}`);
  }

  const schema = rawEdgeMarketSchema(meta.data.years.length);
  const markets: EdgeMarket[] = [];
  const rejectedMarkets: EdgeRejectedMarket[] = [];
  for (const rawMarket of fileShape.data.markets) {
    const parsed = schema.safeParse(rawMarket);
    if (parsed.success) markets.push(toEdgeMarket(parsed.data));
    else rejectedMarkets.push({ id: idOf(rawMarket), reason: formatIssues(parsed.error.issues, 3).join('; ') });
  }

  const dataset: ParsedDataset = {
    meta: meta.data,
    markets,
    rejectedMarkets,
    mtimeMs: st.mtimeMs,
    size: st.size,
    loadedAt: now.toISOString(),
  };
  cache.set(dir, dataset);
  return fromParsed(dir, dataset, now, null);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/unit/edge-loader.test.ts && npm run typecheck`
Expected: 14 tests PASS; typecheck exits 0.

- [ ] **Step 6: Commit**

```bash
git add tests/fixtures/edge/markets.slice.json server/edge/loader.ts tests/unit/edge-loader.test.ts
git commit -F - <<'EOF'
feat(edge): read-only markets.json loader (memo, last-good, retry, quarantine) + synthetic fixture

Refute-Skip: Oxford Edge Phase 1 — read-only display ingest + manual-pull log; no scoring, NOI, governor or capital math
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 6: Pull-queue model + log store `server/edge/pull-queue.ts`

**Files:**
- Create: `server/edge/pull-queue.ts`
- Test: `tests/unit/edge-pull-queue.test.ts`

**Interfaces:**
- Consumes: `BUY_BOX_TYPES` (Task 3), `edge_pull_log` (Task 2), contracts (Task 1), `WarehouseDb`/`openWarehouse` (`server/warehouse/db.ts`), test helpers (Task 4).
- Produces:
  - `EDGE_BUY_BOX_FALLBACK: readonly EdgeBuyBoxScope[]` (`{ id, label, slug }`, 21 entries), `MFG_INVEST_STATES` (15), `TRUCK_STATES` (13), `MFG_INVEST_FEEDS`, `TRUCK_BLOCKERS`, `PULL_ITEMS: Readonly<Record<EdgePullKind, EdgePullItemDef>>`, `PULL_KIND_ORDER`
  - `deriveBuyBoxIds(markets): string[]`, `pullScopeKeys(kind, markets): string[]`, `automatedTruckStates(markets): string[]`, `computeOutsidePullScope(markets): EdgeOutsidePullScope`
  - `localIsoDate(d: Date): string`, `isRealIsoDate(s: string): boolean`, `scopeStateFor(lastDoneOn: string|null, cadenceDays: number, today: string): { state: EdgePullState; ageDays: number|null }`
  - `readEdgePullLatest(db): Map<string, EdgePullLogRow>` (key `${kind}|${scopeKey}`), `recordEdgePull(db, input: RecordPullRequest): number`, `voidEdgePull(db, id): VoidEdgePullResult`
  - `buildEdgePullItem(kind, markets, latest, today): EdgePullItem`, `buildEdgePullQueue(db, markets, today): EdgePullQueueResponse`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/edge-pull-queue.test.ts`:

```ts
// @vitest-environment node
//
// tests/unit/edge-pull-queue.test.ts — pull-queue model + append-only log (spec §5.3, F12).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse, type WarehouseDb } from '../../server/warehouse/db';
import {
  EDGE_BUY_BOX_FALLBACK, MFG_INVEST_STATES, TRUCK_STATES, automatedTruckStates, buildEdgePullItem, buildEdgePullQueue,
  computeOutsidePullScope, deriveBuyBoxIds, isRealIsoDate, localIsoDate, pullScopeKeys, readEdgePullLatest,
  recordEdgePull, scopeStateFor, voidEdgePull,
} from '../../server/edge/pull-queue';
import { fourMarkets, mkMarket, obs } from './edge-test-helpers';

function freshDb(): WarehouseDb {
  return openWarehouse(join(mkdtempSync(join(tmpdir(), 'edge-pq-')), 'w.sqlite'));
}

describe('scope lists', () => {
  it('launch scope counts are 21 / 21 / 15 / 13 = 70 with no dataset (frozen fallback)', () => {
    expect(pullScopeKeys('storage', [])).toHaveLength(21);
    expect(pullScopeKeys('ios', [])).toHaveLength(21);
    expect(pullScopeKeys('mfgInvest', [])).toHaveLength(15);
    expect(pullScopeKeys('truck', [])).toHaveLength(13);
  });

  it('pins the state lists from spec §5.3', () => {
    expect([...MFG_INVEST_STATES]).toEqual(['PA', 'MD', 'VA', 'WV', 'OH', 'IN', 'MI', 'KY', 'MO', 'KS', 'WI', 'IA', 'NE', 'IL', 'MN']);
    expect([...TRUCK_STATES]).toEqual(['OH', 'IN', 'WI', 'PA', 'MD', 'KY', 'MO', 'KS', 'IA', 'NE', 'WV', 'IL', 'MN']);
    expect(TRUCK_STATES).not.toContain('VA');
    expect(TRUCK_STATES).not.toContain('MI');
  });

  it('buy-box derivation from markets.json type equals the frozen artifact list', () => {
    const markets = [
      ...EDGE_BUY_BOX_FALLBACK.map((s) =>
        mkMarket(s.id, s.label, s.label.slice(-2), s.id === 'indianapolis_south' ? 'named_custom' : 'named')),
      mkMarket('akron', 'Akron', 'OH', 'auto'),
    ];
    expect(deriveBuyBoxIds(markets)).toEqual(EDGE_BUY_BOX_FALLBACK.map((s) => s.id));
  });

  // SUPERSEDED (PR #427 review fixes): storage/IOS scopes are now loaded buy-box ∪ frozen ∪ logged keys; final scope rules are in spec §5.3 and server/edge/pull-queue.ts.
  it('derives buy-box ids from the dataset when present (fixture-sized)', () => {
    expect(deriveBuyBoxIds(fourMarkets())).toEqual(['columbus', 'indianapolis_south', 'richmond']);
    for (const id of deriveBuyBoxIds(fourMarkets())) {
      expect(EDGE_BUY_BOX_FALLBACK.map((s) => s.id)).toContain(id);
    }
  });

  it('VA/MI truck coverage comes from markets.json, not the queue', () => {
    const markets = [...fourMarkets(), mkMarket('grand_rapids', 'Grand Rapids', 'MI', 'named', { truck: obs([1, 2, 3, 4, 5]) })];
    expect(automatedTruckStates(markets)).toEqual(['MI', 'VA']);
    expect(pullScopeKeys('truck', markets)).not.toContain('VA');
  });

  it('lists in-dataset states outside the pull scope (never silently omitted)', () => {
    const markets = [
      ...fourMarkets(),
      mkMarket('clarksville', 'Clarksville', 'TN', 'auto'),
      mkMarket('fargo', 'Fargo', 'ND', 'auto'),
      mkMarket('washington_arlington_alexandria', 'Washington-Arlington-Alexandria', 'DC', 'auto'),
    ];
    expect(computeOutsidePullScope(markets)).toEqual({ truck: ['DC', 'ND', 'TN'], mfgInvest: ['DC', 'ND', 'TN'] });
  });
});

describe('dates and state derivation', () => {
  it('localIsoDate formats the local calendar date', () => {
    expect(localIsoDate(new Date(2026, 9, 2, 23, 30))).toBe('2026-10-02');
  });

  it('isRealIsoDate rejects overflow and malformed dates', () => {
    expect(isRealIsoDate('2026-02-28')).toBe(true);
    expect(isRealIsoDate('2026-02-30')).toBe(false);
    expect(isRealIsoDate('2026-13-01')).toBe(false);
    expect(isRealIsoDate('2026-9-1')).toBe(false);
  });

  it('open / current / due at the cadence boundary', () => {
    expect(scopeStateFor(null, 90, '2026-10-02')).toEqual({ state: 'open', ageDays: null });
    expect(scopeStateFor('2026-07-04', 90, '2026-10-02')).toEqual({ state: 'current', ageDays: 90 });
    expect(scopeStateFor('2026-07-03', 90, '2026-10-02')).toEqual({ state: 'due', ageDays: 91 });
  });
});

describe('append-only log', () => {
  it('latest non-voided row wins, ordered done_on DESC then id DESC; void reverts to the prior row', () => {
    const db = freshDb();
    recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-06-01' });
    const id2 = recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-01', note: 'baseline' });
    recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-06-15' });
    expect(readEdgePullLatest(db).get('storage|columbus')?.id).toBe(id2);

    const id4 = recordEdgePull(db, { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-01' });
    expect(readEdgePullLatest(db).get('storage|columbus')?.id).toBe(id4);

    expect(voidEdgePull(db, id4)).toEqual({ status: 'voided', kind: 'storage' });
    expect(readEdgePullLatest(db).get('storage|columbus')?.id).toBe(id2);
    expect(voidEdgePull(db, id4)).toEqual({ status: 'already_voided', kind: 'storage' });
    expect(voidEdgePull(db, 9999)).toEqual({ status: 'not_found' });

    const count = (db.prepare('SELECT COUNT(*) AS n FROM edge_pull_log').get() as { n: number }).n;
    expect(count).toBe(4); // void never deletes
  });

  it('launch state: zero log rows → all 70 scopes open, no seeding', () => {
    const q = buildEdgePullQueue(freshDb(), [], '2026-10-02');
    expect(q.items.map((i) => i.kind)).toEqual(['storage', 'ios', 'mfgInvest', 'truck']);
    const scopes = q.items.flatMap((i) => i.scopes);
    expect(scopes).toHaveLength(70);
    expect(scopes.every((s) => s.state === 'open')).toBe(true);
    expect(q.items.map((i) => i.counts.open)).toEqual([21, 21, 15, 13]);
  });

  it('builds per-scope links and truck blockers', () => {
    const item = buildEdgePullItem('storage', [], new Map(), '2026-10-02');
    const columbus = item.scopes.find((s) => s.scopeKey === 'columbus');
    expect(columbus?.scopeLabel).toBe('Columbus, OH');
    expect(columbus?.links.map((l) => l.url)).toEqual([
      'https://www.storagecafe.com/self-storage-rates/columbus-oh/',
      'https://www.rentcafe.com/self-storage/usa/columbus-oh/',
    ]);
    const truck = buildEdgePullItem('truck', [], new Map(), '2026-10-02');
    expect(truck.scopes.find((s) => s.scopeKey === 'OH')?.blocker).toContain('decommissioned');
    expect(truck.scopes.find((s) => s.scopeKey === 'PA')?.blocker).toContain('PASDA');
    const mfg = buildEdgePullItem('mfgInvest', [], new Map(), '2026-10-02');
    expect(mfg.scopes.find((s) => s.scopeKey === 'OH')?.links[0]?.url).toBe('https://www.jobsohio.com/newsroom');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/edge-pull-queue.test.ts`
Expected: FAIL — `Failed to resolve import "../../server/edge/pull-queue"`.

- [ ] **Step 3: Write the implementation**

Create `server/edge/pull-queue.ts`:

> **Superseded (PR #427 review fixes):** the header comment and the `deriveBuyBoxIds` / `pullScopeKeys` snippets below are the original draft; final scope rules are in spec §5.3 and server/edge/pull-queue.ts.

```ts
// server/edge/pull-queue.ts
//
// Oxford Edge manual-pull queue (spec §5.3). Scope lists and cadences are CODE (versioned,
// reviewable); the DB holds only the append-only edge_pull_log (migration 034). The 21 storage/IOS
// scopes are derived from markets.json `type` when the dataset is available and fall back to the
// frozen copy of the retired Morning Guide's list when it is not. VA and MI truck coverage is
// automated (derived from markets.json), never a queue row. Labels, slugs, press feeds and truck
// blockers are carried from the retired artifact (morning_guide.html, 2026-07-14).
import type { WarehouseDb } from '../warehouse/db';
import type {
  EdgeMarket, EdgeOutsidePullScope, EdgePullItem, EdgePullKind, EdgePullLink, EdgePullQueueResponse,
  EdgePullScopeState, EdgePullState, RecordPullRequest,
} from '../../src/contracts/edge';
import { BUY_BOX_TYPES } from './series';

export interface EdgeBuyBoxScope {
  id: string;
  label: string;
  slug: string;
}

/** Frozen copy of the artifact's 21-market storage/IOS list (ids from markets.json, labels/slugs
 *  from the artifact). indianapolis_south uses the artifact's "Indianapolis, IN" storage slug. */
export const EDGE_BUY_BOX_FALLBACK: readonly EdgeBuyBoxScope[] = [
  { id: 'harrisburg', label: 'Harrisburg, PA', slug: 'harrisburg-pa' },
  { id: 'lancaster', label: 'Lancaster, PA', slug: 'lancaster-pa' },
  { id: 'york', label: 'York, PA', slug: 'york-pa' },
  { id: 'allentown', label: 'Allentown, PA', slug: 'allentown-pa' },
  { id: 'hagerstown', label: 'Hagerstown, MD', slug: 'hagerstown-md' },
  { id: 'winchester', label: 'Winchester, VA', slug: 'winchester-va' },
  { id: 'richmond', label: 'Richmond, VA', slug: 'richmond-va' },
  { id: 'roanoke', label: 'Roanoke, VA', slug: 'roanoke-va' },
  { id: 'columbus', label: 'Columbus, OH', slug: 'columbus-oh' },
  { id: 'cincinnati', label: 'Cincinnati, OH', slug: 'cincinnati-oh' },
  { id: 'dayton', label: 'Dayton, OH', slug: 'dayton-oh' },
  { id: 'toledo', label: 'Toledo, OH', slug: 'toledo-oh' },
  { id: 'fort_wayne', label: 'Fort Wayne, IN', slug: 'fort-wayne-in' },
  { id: 'grand_rapids', label: 'Grand Rapids, MI', slug: 'grand-rapids-mi' },
  { id: 'louisville', label: 'Louisville, KY', slug: 'louisville-ky' },
  { id: 'kansas_city', label: 'Kansas City, MO', slug: 'kansas-city-mo' },
  { id: 'madison', label: 'Madison, WI', slug: 'madison-wi' },
  { id: 'des_moines', label: 'Des Moines, IA', slug: 'des-moines-ia' },
  { id: 'lincoln', label: 'Lincoln, NE', slug: 'lincoln-ne' },
  { id: 'omaha', label: 'Omaha, NE', slug: 'omaha-ne' },
  { id: 'indianapolis_south', label: 'Indianapolis, IN', slug: 'indianapolis-in' },
];

export const MFG_INVEST_STATES = ['PA', 'MD', 'VA', 'WV', 'OH', 'IN', 'MI', 'KY', 'MO', 'KS', 'WI', 'IA', 'NE', 'IL', 'MN'] as const;
export const TRUCK_STATES = ['OH', 'IN', 'WI', 'PA', 'MD', 'KY', 'MO', 'KS', 'IA', 'NE', 'WV', 'IL', 'MN'] as const;

/** State economic-development press feeds (from the artifact). */
export const MFG_INVEST_FEEDS: Readonly<Record<string, string>> = {
  PA: 'https://dced.pa.gov/newsroom/',
  MD: 'https://commerce.maryland.gov/media',
  VA: 'https://www.vedp.org/news',
  WV: 'https://westvirginia.gov/category/news/',
  OH: 'https://www.jobsohio.com/newsroom',
  IN: 'https://iedc.in.gov/media',
  MI: 'https://www.michiganbusiness.org/press-releases/',
  KY: 'https://ced.ky.gov/News',
  MO: 'https://missouripartnership.com/news/',
  KS: 'https://www.kansascommerce.gov/newsroom/',
  WI: 'https://wedc.org/category/news/',
  IA: 'https://www.iowaeda.com/newsroom/',
  NE: 'https://opportunity.nebraska.gov/newsroom/',
  IL: 'https://dceo.illinois.gov/aboutdceo/newsroom.html',
  MN: 'https://mn.gov/deed/newscenter/',
};

const NOT_ATTEMPTED = 'Not attempted — out of scope for the 2026-07-14 pass (time-boxed to VA/MI/OH/IN/WI).';

/** Per-state truck AADT blockers, carried in intent from the artifact. */
export const TRUCK_BLOCKERS: Readonly<Record<string, string>> = {
  OH: 'Dead endpoint — the gis.dot.state.oh.us TIMS ArcGIS server is decommissioned (every known path 404s). Needs a fresh search for where ODOT now publishes its traffic-count GIS layer.',
  IN: "JS app only — INDOT's TCDS (tcds.indot.in.gov) is an interactive map, not a queryable REST endpoint. Check INDOT's open-data portal for a downloadable AADT shapefile/CSV.",
  WI: "Usable but risky — live ArcGIS endpoints carry no truck-class breakdown and count segments on an irregular multi-year rotation; a naive year-over-year join would fabricate deltas. Verify each segment's count years first.",
  PA: `${NOT_ATTEMPTED} PennDOT publishes open GIS traffic layers via PASDA — good first check.`,
  MO: `${NOT_ATTEMPTED} MoDOT publishes open GIS traffic layers via MSDIS — good first check.`,
  MD: NOT_ATTEMPTED,
  KY: NOT_ATTEMPTED,
  KS: NOT_ATTEMPTED,
  IA: NOT_ATTEMPTED,
  NE: NOT_ATTEMPTED,
  WV: NOT_ATTEMPTED,
  IL: NOT_ATTEMPTED,
  MN: NOT_ATTEMPTED,
};

export interface EdgePullItemDef {
  kind: EdgePullKind;
  label: string;
  cadenceDays: number;
  cadenceLabel: string;
  scopeType: 'market' | 'state';
  why: string;
  caveat: string;
}

export const PULL_ITEMS: Readonly<Record<EdgePullKind, EdgePullItemDef>> = {
  storage: {
    kind: 'storage',
    label: 'Self-storage asking rates',
    cadenceDays: 90,
    cadenceLabel: 'Quarterly',
    scopeType: 'market',
    why: 'Storage rates are the space-scarcity proxy almost nobody in industrial underwriting tracks.',
    caveat: "Today's rate only — record a baseline; growth accumulates from future pulls. StorageCafe/RentCafe keep no history, so 2021–2024 cannot be backfilled.",
  },
  ios: {
    kind: 'ios',
    label: 'IOS & contractor-yard listings',
    cadenceDays: 90,
    cadenceLabel: 'Quarterly',
    scopeType: 'market',
    why: 'Oxford buys IOS and almost nobody datasets it — a real edge if kept current.',
    caveat: 'Crexi and LoopNet block scripted pulls (JS shell, no listing data); a manual per-market scan is the realistic cadence.',
  },
  mfgInvest: {
    kind: 'mfgInvest',
    label: 'Manufacturing investment announcements',
    cadenceDays: 30,
    cadenceLabel: 'Monthly',
    scopeType: 'state',
    why: 'Every plant drags 20–40 small suppliers behind it — the earliest, biggest-magnitude signal in the dataset.',
    caveat: 'Unstructured press releases across 15 state economic-development sites; a QCEW manufacturing-employment proxy will not catch a plant until it reaches payroll data.',
  },
  truck: {
    kind: 'truck',
    label: 'Truck AADT',
    cadenceDays: 365,
    cadenceLabel: 'Annual',
    scopeType: 'state',
    why: 'Freight moving before jobs show up is the earliest demand signal there is.',
    caveat: 'VA and MI are complete through the automated state-DOT pull; each remaining state has a specific blocker below.',
  },
};

export const PULL_KIND_ORDER: readonly EdgePullKind[] = ['storage', 'ios', 'mfgInvest', 'truck'];

const DAY_MS = 86_400_000;

// SUPERSEDED (PR #427 review fixes): storage/IOS = loaded buy-box ∪ frozen-unless-explicitly-non-buy-box ∪ logged; truck excludes automated states.
export function deriveBuyBoxIds(markets: readonly EdgeMarket[]): string[] {
  if (markets.length === 0) return EDGE_BUY_BOX_FALLBACK.map((s) => s.id);
  return markets.filter((m) => BUY_BOX_TYPES.has(m.type)).map((m) => m.id);
}

export function pullScopeKeys(kind: EdgePullKind, markets: readonly EdgeMarket[]): string[] {
  if (kind === 'storage' || kind === 'ios') return deriveBuyBoxIds(markets);
  if (kind === 'mfgInvest') return [...MFG_INVEST_STATES];
  return [...TRUCK_STATES];
}

/** States with any non-null truck value in markets.json (VA + MI today). */
export function automatedTruckStates(markets: readonly EdgeMarket[]): string[] {
  const states = new Set<string>();
  for (const m of markets) if (m.series.truck.values.some((v) => v !== null)) states.add(m.state);
  return [...states].sort();
}

/** In-dataset states outside the artifact's pull scope (TN, ND, SD, DC today), listed in Data health. */
export function computeOutsidePullScope(markets: readonly EdgeMarket[]): EdgeOutsidePullScope {
  const datasetStates = [...new Set(markets.map((m) => m.state))].sort();
  const automated = new Set(automatedTruckStates(markets));
  const truckScope = new Set<string>(TRUCK_STATES);
  const mfgScope = new Set<string>(MFG_INVEST_STATES);
  return {
    truck: datasetStates.filter((s) => !truckScope.has(s) && !automated.has(s)),
    mfgInvest: datasetStates.filter((s) => !mfgScope.has(s)),
  };
}

/** Server LOCAL calendar date (the "not in the future" rule is relative to server local date). */
export function localIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function isRealIsoDate(s: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const y = Number(m[1]);
  const mo = Number(m[2]);
  const d = Number(m[3]);
  const dt = new Date(Date.UTC(y, mo - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
}

export function scopeStateFor(
  lastDoneOn: string | null,
  cadenceDays: number,
  today: string,
): { state: EdgePullState; ageDays: number | null } {
  if (lastDoneOn === null) return { state: 'open', ageDays: null };
  const raw = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${lastDoneOn}T00:00:00Z`)) / DAY_MS);
  const ageDays = Math.max(0, raw);
  return { state: ageDays <= cadenceDays ? 'current' : 'due', ageDays };
}

export interface EdgePullLogRow {
  id: number;
  kind: EdgePullKind;
  scopeKey: string;
  doneOn: string;
  note: string | null;
}

/** Latest non-voided row per (kind, scope), keyed `${kind}|${scopeKey}`. */
export function readEdgePullLatest(db: WarehouseDb): Map<string, EdgePullLogRow> {
  const rows = db
    .prepare(
      `SELECT id, pull_kind AS kind, scope_key AS scopeKey, done_on AS doneOn, note
         FROM edge_pull_log
        WHERE voided_at IS NULL
        ORDER BY pull_kind, scope_key, done_on DESC, id DESC`,
    )
    .all() as EdgePullLogRow[];
  const latest = new Map<string, EdgePullLogRow>();
  for (const r of rows) {
    const key = `${r.kind}|${r.scopeKey}`;
    if (!latest.has(key)) latest.set(key, r);
  }
  return latest;
}

/** Append one log row. Binds exactly kind/scopeKey/doneOn/note → pull_kind/scope_key/done_on/note
 *  (check:schema-drift cross-references these against RecordPullRequest). */
export function recordEdgePull(db: WarehouseDb, input: RecordPullRequest): number {
  const result = db
    .prepare('INSERT INTO edge_pull_log (pull_kind, scope_key, done_on, note) VALUES (?, ?, ?, ?)')
    .run(input.kind, input.scopeKey, input.doneOn, input.note ?? null);
  return Number(result.lastInsertRowid);
}

export type VoidEdgePullResult =
  | { status: 'voided'; kind: EdgePullKind }
  | { status: 'already_voided'; kind: EdgePullKind }
  | { status: 'not_found' };

/** Undo = set voided_at. There is no DELETE path (never-delete rule). */
export function voidEdgePull(db: WarehouseDb, id: number): VoidEdgePullResult {
  const row = db
    .prepare('SELECT pull_kind AS kind, voided_at AS voidedAt FROM edge_pull_log WHERE id = ?')
    .get(id) as { kind: EdgePullKind; voidedAt: string | null } | undefined;
  if (!row) return { status: 'not_found' };
  if (row.voidedAt !== null) return { status: 'already_voided', kind: row.kind };
  db.prepare("UPDATE edge_pull_log SET voided_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now') WHERE id = ? AND voided_at IS NULL").run(id);
  return { status: 'voided', kind: row.kind };
}

function scopeLabelFor(kind: EdgePullKind, scopeKey: string, markets: readonly EdgeMarket[]): string {
  if (kind === 'mfgInvest' || kind === 'truck') return scopeKey;
  const frozen = EDGE_BUY_BOX_FALLBACK.find((s) => s.id === scopeKey);
  if (frozen) return frozen.label;
  const m = markets.find((x) => x.id === scopeKey);
  return m ? `${m.name}, ${m.state}` : scopeKey;
}

function scopeLinks(kind: EdgePullKind, scopeKey: string): EdgePullLink[] {
  if (kind === 'mfgInvest') {
    const url = MFG_INVEST_FEEDS[scopeKey];
    return url ? [{ label: 'Press feed', url }] : [];
  }
  if (kind === 'truck') return [];
  const frozen = EDGE_BUY_BOX_FALLBACK.find((s) => s.id === scopeKey);
  if (!frozen) return [];
  if (kind === 'storage') {
    return [
      { label: 'StorageCafe', url: `https://www.storagecafe.com/self-storage-rates/${frozen.slug}/` },
      { label: 'RentCafe', url: `https://www.rentcafe.com/self-storage/usa/${frozen.slug}/` },
    ];
  }
  return [
    {
      label: 'Crexi',
      url: `https://www.crexi.com/properties?filters=%7B%22types%22%3A%5B%22land%22%5D%7D&searchTerm=${encodeURIComponent(frozen.label)}`,
    },
    { label: 'LoopNet', url: `https://www.loopnet.com/search/land/${frozen.slug}/` },
  ];
}

export function buildEdgePullItem(
  kind: EdgePullKind,
  markets: readonly EdgeMarket[],
  latest: ReadonlyMap<string, EdgePullLogRow>,
  today: string,
): EdgePullItem {
  const def = PULL_ITEMS[kind];
  const scopes: EdgePullScopeState[] = pullScopeKeys(kind, markets).map((scopeKey) => {
    const row = latest.get(`${kind}|${scopeKey}`) ?? null;
    const { state, ageDays } = scopeStateFor(row?.doneOn ?? null, def.cadenceDays, today);
    return {
      scopeKey,
      scopeLabel: scopeLabelFor(kind, scopeKey, markets),
      state,
      lastDoneOn: row?.doneOn ?? null,
      lastNote: row?.note ?? null,
      lastLogId: row?.id ?? null,
      ageDays,
      links: scopeLinks(kind, scopeKey),
      blocker: kind === 'truck' ? (TRUCK_BLOCKERS[scopeKey] ?? null) : null,
    };
  });
  return {
    kind,
    label: def.label,
    cadenceDays: def.cadenceDays,
    cadenceLabel: def.cadenceLabel,
    scopeType: def.scopeType,
    why: def.why,
    caveat: def.caveat,
    scopes,
    counts: {
      open: scopes.filter((s) => s.state === 'open').length,
      due: scopes.filter((s) => s.state === 'due').length,
      current: scopes.filter((s) => s.state === 'current').length,
    },
  };
}

export function buildEdgePullQueue(db: WarehouseDb, markets: readonly EdgeMarket[], today: string): EdgePullQueueResponse {
  const latest = readEdgePullLatest(db);
  return {
    items: PULL_KIND_ORDER.map((kind) => buildEdgePullItem(kind, markets, latest, today)),
    automatedCoverage: { truck: automatedTruckStates(markets) },
    today,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/edge-pull-queue.test.ts && npm run typecheck`
Expected: 12 tests PASS; typecheck exits 0.

- [ ] **Step 5: Commit**

```bash
git add server/edge/pull-queue.ts tests/unit/edge-pull-queue.test.ts
git commit -F - <<'EOF'
feat(edge): manual-pull queue model + append-only log store (void, never delete)

Refute-Skip: Oxford Edge Phase 1 — read-only display ingest + manual-pull log; no scoring, NOI, governor or capital math
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 7: Hono sub-router `server/edge/edge-api.ts` + mount via `sub-routers.ts`

**Files:**
- Create: `server/edge/edge-api.ts`
- Modify: `server/warehouse/sub-routers.ts:23` (add import after it), `server/warehouse/sub-routers.ts:63` (add entry after it)
- Test: `tests/unit/edge-api.test.ts`

**Interfaces:**
- Consumes: `loadEdgeDataset`, `NODE_EDGE_FS`, `EdgeFsDeps` (Task 5); everything exported in Task 6; `edgeDir` (Task 3); `WarehouseDb`.
- Produces: `interface EdgeApiDeps { edgeDir?: () => string; now?: () => Date; fs?: EdgeFsDeps }`, `edgeApi(getDb: () => WarehouseDb, deps?: EdgeApiDeps): Hono`; live routes `GET /api/warehouse/edge/markets`, `GET /api/warehouse/edge/pull-queue`, `POST /api/warehouse/edge/pull-queue`, `POST /api/warehouse/edge/pull-queue/:id/void`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/edge-api.test.ts`:

```ts
// @vitest-environment node
//
// tests/unit/edge-api.test.ts — in-process Hono (pattern: tests/unit/acq-api.test.ts). Fresh
// openWarehouse() on a tmpdir path, all migrations applied — never touches finance.sqlite.
import { copyFileSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { EdgeMarketsResponse, EdgePullItem, EdgePullQueueResponse } from '@contracts/edge';
import { openWarehouse, type WarehouseDb } from '../../server/warehouse/db';
import { edgeApi } from '../../server/edge/edge-api';
import { buildMountPrefixMap } from '../../scripts/check-write-schema-drift';

const REPO_ROOT = resolve(__dirname, '..', '..');
const FIXTURE = join(__dirname, '..', 'fixtures', 'edge', 'markets.slice.json');
const NOW = new Date('2026-10-02T12:00:00');

function freshDb(): WarehouseDb {
  return openWarehouse(join(mkdtempSync(join(tmpdir(), 'edge-api-db-')), 'w.sqlite'));
}
function fixtureDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'edge-api-data-'));
  copyFileSync(FIXTURE, join(dir, 'markets.json'));
  return dir;
}
function makeApp(getDb: () => WarehouseDb, dir = fixtureDir()) {
  return edgeApi(getDb, { edgeDir: () => dir, now: () => NOW });
}
const noDb = (): WarehouseDb => {
  throw new Error('warehouse unopenable');
};
async function post(app: ReturnType<typeof makeApp>, path: string, body?: unknown) {
  return app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}
function keysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v !== null && typeof v === 'object') {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      keysDeep(x, out);
    }
  }
  return out;
}

describe('GET /markets', () => {
  it('serves the fixture without the DB (no withDb guard)', async () => {
    const res = await makeApp(noDb).request('/markets');
    expect(res.status).toBe(200);
    const body = EdgeMarketsResponse.parse(await res.json());
    expect(body.availability).toBe('ok');
    expect(body.marketCount).toBe(4);
    expect(body.freshness).toMatchObject({ asOf: '2026-07-14', ageDays: 80, stale: true });
    expect(body.outsidePullScope).toEqual({ truck: [], mfgInvest: [] });
  });

  it('missing dir → 200 with availability missing and markets []', async () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'edge-api-missing-')), 'nope');
    const res = await makeApp(noDb, dir).request('/markets');
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ availability: 'missing', markets: [], dir });
  });

  it('F9: the response carries no deal-shaped key', async () => {
    const body = await (await makeApp(noDb).request('/markets')).json();
    expect(keysDeep(body).filter((k) => /^deal/i.test(k))).toEqual([]);
  });
});

describe('GET /pull-queue', () => {
  it('503 through the standard guard when the warehouse is unopenable', async () => {
    const res = await makeApp(noDb).request('/pull-queue');
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'warehouse unavailable' });
  });

  it('derives scopes from the fixture; VA is automated, not queued; all open', async () => {
    const db = freshDb();
    const body = EdgePullQueueResponse.parse(await (await makeApp(() => db).request('/pull-queue')).json());
    const byKind = Object.fromEntries(body.items.map((i) => [i.kind, i]));
    expect(byKind.storage!.scopes.map((s) => s.scopeKey)).toEqual(['columbus', 'indianapolis_south', 'richmond']);
    expect(byKind.mfgInvest!.scopes).toHaveLength(15);
    expect(byKind.truck!.scopes).toHaveLength(13);
    expect(body.automatedCoverage.truck).toEqual(['VA']);
    expect(body.items.flatMap((i) => i.scopes).every((s) => s.state === 'open')).toBe(true);
    expect(keysDeep(body).filter((k) => /^deal/i.test(k))).toEqual([]);
  });
});

describe('POST /pull-queue', () => {
  it('records a pull and returns the updated item', async () => {
    const db = freshDb();
    const app = makeApp(() => db);
    const res = await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30', note: 'baseline' });
    expect(res.status).toBe(200);
    const item = EdgePullItem.parse(await res.json());
    expect(item.scopes.find((s) => s.scopeKey === 'columbus')).toMatchObject({
      state: 'current', lastDoneOn: '2026-09-30', lastNote: 'baseline', ageDays: 2,
    });
    const queue = EdgePullQueueResponse.parse(await (await app.request('/pull-queue')).json());
    expect(queue.items[0]!.counts).toEqual({ open: 2, due: 0, current: 1 });
  });

  it.each([
    ['bad kind', { kind: 'rent', scopeKey: 'columbus', doneOn: '2026-09-30' }],
    ['unknown scope (F12)', { kind: 'storage', scopeKey: 'akron', doneOn: '2026-09-30' }],
    ['typo state', { kind: 'truck', scopeKey: 'OHH', doneOn: '2026-09-30' }],
    ['unreal date', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-02-30' }],
    ['future date', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-10-03' }],
    ['oversize note', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30', note: 'x'.repeat(2001) }],
    ['extra key (strict)', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30', dealId: 'd1' }],
  ])('400 on %s', async (_label, body) => {
    const db = freshDb();
    const res = await post(makeApp(() => db), '/pull-queue', body);
    expect(res.status).toBe(400);
    expect((db.prepare('SELECT COUNT(*) AS n FROM edge_pull_log').get() as { n: number }).n).toBe(0);
  });

  it('503 when the warehouse is unopenable', async () => {
    const res = await post(makeApp(noDb), '/pull-queue', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30' });
    expect(res.status).toBe(503);
  });
});

describe('POST /pull-queue/:id/void', () => {
  it('void reverts the scope to the prior row (F12); repeat → 409; unknown → 404; bad id → 400', async () => {
    const db = freshDb();
    const app = makeApp(() => db);
    await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-06-01' });
    const second = EdgePullItem.parse(await (await post(app, '/pull-queue', { kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-01' })).json());
    const id = second.scopes.find((s) => s.scopeKey === 'columbus')!.lastLogId!;

    const voided = await post(app, `/pull-queue/${id}/void`);
    expect(voided.status).toBe(200);
    expect(EdgePullItem.parse(await voided.json()).scopes.find((s) => s.scopeKey === 'columbus')!.lastDoneOn).toBe('2026-06-01');

    expect((await post(app, `/pull-queue/${id}/void`)).status).toBe(409);
    expect((await post(app, '/pull-queue/9999/void')).status).toBe(404);
    expect((await post(app, '/pull-queue/abc/void')).status).toBe(400);
  });
});

describe('mounting and mirror boundaries', () => {
  it('sub-routers.ts mounts edge-api at /api/warehouse/edge (literal-entry shape check:schema-drift reads)', () => {
    expect(buildMountPrefixMap(REPO_ROOT).get('edge-api')).toBe('/api/warehouse/edge');
  });

  it('F9: /edge is never baked into the Cloudflare mirror (FIXED_ROUTES)', () => {
    const src = readFileSync(join(REPO_ROOT, 'scripts', 'bake-warehouse.ts'), 'utf8');
    const start = src.indexOf('const FIXED_ROUTES = [');
    expect(start).toBeGreaterThan(-1);
    const block = src.slice(start, src.indexOf('];', start));
    expect(block).not.toContain('/edge');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/edge-api.test.ts`
Expected: FAIL — `Failed to resolve import "../../server/edge/edge-api"`.

- [ ] **Step 3: Write the router and mount it**

Create `server/edge/edge-api.ts`:

```ts
// server/edge/edge-api.ts
//
// Oxford Edge Hono sub-router (spec §5.2), mounted at /api/warehouse/edge via
// server/warehouse/sub-routers.ts. Routes:
//   GET  /markets               — loader result; NO withDb guard (works when the warehouse is down)
//   GET  /pull-queue            — queue state per item × scope; 503 through the standard guard
//   POST /pull-queue            — RecordPullRequest → append one log row → updated item
//   POST /pull-queue/:id/void   — set voided_at on one row (undo); no delete
// Mutations require X-ORA-Client, enforced upstream by server/host-guard.ts on every non-safe
// /api method. The routes accept and return NO deal data (spec §5.4, F9); deal→market resolution
// is client-side. Not added to scripts/bake-warehouse.ts FIXED_ROUTES: the data is CoStar-licensed.
import { Hono } from 'hono';
import type { WarehouseDb } from '../warehouse/db';
import { EdgeMarketsResponse, EdgePullItem, EdgePullQueueResponse, RecordPullRequest } from '../../src/contracts/edge';
import { edgeDir } from './config';
import { loadEdgeDataset, NODE_EDGE_FS, type EdgeFsDeps } from './loader';
import {
  buildEdgePullItem, buildEdgePullQueue, computeOutsidePullScope, isRealIsoDate, localIsoDate, pullScopeKeys,
  readEdgePullLatest, recordEdgePull, voidEdgePull,
} from './pull-queue';

export interface EdgeApiDeps {
  edgeDir?: () => string;
  now?: () => Date;
  fs?: EdgeFsDeps;
}

/**
 * Creates the Edge Hono sub-router.
 *
 * @param getDb - Lazy singleton getter; throws when the warehouse is unavailable.
 */
export function edgeApi(getDb: () => WarehouseDb, deps: EdgeApiDeps = {}): Hono {
  const app = new Hono();
  const dirOf = deps.edgeDir ?? edgeDir;
  const now = deps.now ?? (() => new Date());
  const fs = deps.fs ?? NODE_EDGE_FS;
  const load = () => loadEdgeDataset(dirOf(), now(), fs);

  /** Resolve the warehouse per-request behind a 503 guard (mirrors insights-api.ts / debt-api.ts). */
  const withDb = (handler: (db: WarehouseDb) => Response | Promise<Response>): Promise<Response> => {
    let db: WarehouseDb;
    try {
      db = getDb();
    } catch {
      return Promise.resolve(
        new Response(JSON.stringify({ error: 'warehouse unavailable' }), {
          status: 503,
          headers: { 'content-type': 'application/json' },
        }),
      );
    }
    return Promise.resolve(handler(db));
  };

  app.get('/markets', async (c) => {
    const result = await load();
    return c.json(EdgeMarketsResponse.parse({ ...result, outsidePullScope: computeOutsidePullScope(result.markets) }));
  });

  app.get('/pull-queue', (c) =>
    withDb(async (db) => {
      const { markets } = await load();
      return c.json(EdgePullQueueResponse.parse(buildEdgePullQueue(db, markets, localIsoDate(now()))));
    }),
  );

  app.post('/pull-queue', (c) =>
    withDb(async (db) => {
      const parsed = RecordPullRequest.safeParse(await c.req.json().catch(() => ({})));
      if (!parsed.success) return c.json({ error: 'invalid pull record', issues: parsed.error.issues }, 400);
      const input = parsed.data;
      const { markets } = await load();
      if (!pullScopeKeys(input.kind, markets).includes(input.scopeKey)) {
        return c.json({ error: `unknown scope '${input.scopeKey}' for ${input.kind}` }, 400);
      }
      if (!isRealIsoDate(input.doneOn)) {
        return c.json({ error: `doneOn '${input.doneOn}' is not a real calendar date` }, 400);
      }
      const today = localIsoDate(now());
      if (input.doneOn > today) {
        return c.json({ error: `doneOn '${input.doneOn}' is in the future (server date ${today})` }, 400);
      }
      recordEdgePull(db, input);
      return c.json(EdgePullItem.parse(buildEdgePullItem(input.kind, markets, readEdgePullLatest(db), today)), 200);
    }),
  );

  app.post('/pull-queue/:id/void', (c) =>
    withDb(async (db) => {
      const id = Number(c.req.param('id'));
      if (!Number.isInteger(id) || id <= 0) return c.json({ error: 'id must be a positive integer' }, 400);
      const result = voidEdgePull(db, id);
      if (result.status === 'not_found') return c.json({ error: `pull log row ${id} not found` }, 404);
      if (result.status === 'already_voided') return c.json({ error: `pull log row ${id} is already voided` }, 409);
      const { markets } = await load();
      return c.json(
        EdgePullItem.parse(buildEdgePullItem(result.kind, markets, readEdgePullLatest(db), localIsoDate(now()))),
        200,
      );
    }),
  );

  return app;
}
```

Modify `server/warehouse/sub-routers.ts` (re-read the file immediately before editing; it is a shared single-writer surface):

After line 23 (`import { insightsApi } from './insights-api';`) add:

```ts
import { edgeApi } from '../edge/edge-api';
```

After line 63 (`  { prefix: '/insights', factory: insightsApi },`) add — keep the literal `{ prefix: '...', factory: <bareName> }` shape that `buildMountPrefixMap()` reads as text:

```ts
  { prefix: '/edge', factory: edgeApi },
```

- [ ] **Step 4: Run tests, the mount-prefix guard, governance and schema-drift**

Run:
```bash
npx vitest run tests/unit/edge-api.test.ts tests/unit/sub-routers-mount-prefix.test.ts
npm run typecheck
npm run governance
npm run check:schema-drift
```
Expected:
- `edge-api.test.ts`: 17 tests PASS; `sub-routers-mount-prefix.test.ts`: PASS (10 prefixes resolved, `/api/warehouse/edge` among them).
- typecheck exit 0; governance PASS (no `/api/` literal in a top-level `server/*.ts` file, so FM-14 `checkRouteDuplication` cannot fire).
- `check:schema-drift` PASS with **no errors**. Expected non-blocking warnings, quote them in the PR: `COLUMN_FIELD_MISMATCH` for `edge_pull_log.pull_kind` bound to `input.kind` (deliberate column name per spec §7) and `NO_INPUT_SCHEMA` for `POST /api/warehouse/edge/pull-queue/:id/void` (no body). If it reports `FIELD_NOT_PERSISTED` or `FIELD_NOT_IN_SCHEMA`, the INSERT binding drifted — fix `recordEdgePull`, do not suppress.

- [ ] **Step 5: Commit**

```bash
git add server/edge/edge-api.ts server/warehouse/sub-routers.ts tests/unit/edge-api.test.ts
git commit -F - <<'EOF'
feat(edge): /api/warehouse/edge sub-router (markets, pull-queue, record, void) + mount

Shared single-writer surface server/warehouse/sub-routers.ts: +1 import, +1 literal entry
(claimed in architecture/status.json oxford-edge-tab). server/index.ts not touched.

Refute-Skip: Oxford Edge Phase 1 — read-only display ingest + manual-pull log; no scoring, NOI, governor or capital math
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 8: Client hooks + display helpers `src/modules/acquisitions/edge-hooks.ts`

**Files:**
- Create: `src/modules/acquisitions/edge-hooks.ts`
- Test: `tests/unit/edge-status-label.test.ts`

**Interfaces:**
- Consumes: contracts (Task 1); `fetchJson`, `isWarehouseUnavailable`, `QUERY_OPTS` (`src/modules/intel/hooks.ts`); `ORA_JSON_MUTATION_HEADERS`, `ORA_CLIENT_HEADERS` (`@contracts/client-header`).
- Produces (used by Tasks 9–14):
  - `EDGE_KEYS = { markets: ['warehouse','edge','markets'], pullQueue: ['warehouse','edge','pull-queue'] }`
  - `useEdgeMarkets(opts?: { enabled?: boolean })`, `useEdgePullQueue()`, `useRecordPull()` (mutate `RecordPullRequest`), `useVoidPull()` (mutate `logId: number`)
  - `edgeStatusLabel(status: EdgeStatus): EdgeStatusLabel` (`{ text: string|null; title: string|null; dotted: boolean }`)
  - `latestObserved(cell, years): EdgeLatest | null` (`{ value, year, status, isLatestYear }`)
  - `formatEdgeValue(value: number|null, unit: EdgeUnit): string | null`
  - `edgeCellDisplay(cell, unit, years, field): EdgeCellDisplay` (`{ text, title, dotted, observed }`)
  - `edgeSeriesHeader(field, fieldMeta): string`, `isBuyBox(m)`, `filterEdgeMarkets(markets, set)`, `sortEdgeMarkets(markets, state, years)`
  - `type EdgeSetFilter`, `type EdgeBoardSortKey`, `interface EdgeBoardState`, `EDGE_BOARD_DEFAULT_STATE`, `EDGE_BOARD_COLUMNS`, `EDGE_PICKER_SERIES`, `EDGE_READOUT_SERIES`, `EDGE_PULL_SERIES`
  - `localIsoToday(now?: Date): string`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/edge-status-label.test.ts`:

```ts
// tests/unit/edge-status-label.test.ts — status labels, value formatting, latest-observed, board
// model (spec §8.3, F3, F4).
import { describe, expect, it } from 'vitest';
import type { EdgeStatus } from '@contracts/edge';
import {
  EDGE_BOARD_DEFAULT_STATE, EDGE_PICKER_SERIES, edgeCellDisplay, edgeSeriesHeader, edgeStatusLabel, filterEdgeMarkets,
  formatEdgeValue, latestObserved, localIsoToday, sortEdgeMarkets,
} from '../../src/modules/acquisitions/edge-hooks';
import { cell, fourMarkets, mkMarket, obs, TEST_FIELD_META, TEST_YEARS } from './edge-test-helpers';

describe('edgeStatusLabel', () => {
  it.each<[EdgeStatus, { text: string | null; title: string | null; dotted: boolean }]>([
    ['actual', { text: null, title: null, dotted: false }],
    ['estimated', { text: null, title: 'Est.', dotted: true }],
    ['nowcast', { text: null, title: 'Nowcast', dotted: true }],
    ['guide_only', { text: 'Pending manual pull', title: 'Pending manual pull', dotted: false }],
    ['null', { text: 'Not published', title: 'Not published', dotted: false }],
  ])('%s', (status, expected) => {
    expect(edgeStatusLabel(status)).toEqual(expected);
  });
});

describe('formatEdgeValue (F4: never a number for null)', () => {
  it('formats each unit', () => {
    expect(formatEdgeValue(1.42, 'pct_yoy')).toBe('+1.4%');
    expect(formatEdgeValue(-0.5, 'pct_yoy')).toBe('-0.5%');
    expect(formatEdgeValue(4, 'pct_level')).toBe('4.0%');
    expect(formatEdgeValue(1086.8, 'ksf')).toBe('1,087 kSF');
    expect(formatEdgeValue(3.2, 'per_10k')).toBe('3.2 /10k');
    expect(formatEdgeValue(63000, 'usd')).toBe('$63,000');
    expect(formatEdgeValue(1200, 'persons')).toBe('+1,200');
    expect(formatEdgeValue(-92423, 'persons')).toBe('-92,423');
  });

  it('returns null for null — the status label always wins', () => {
    for (const u of ['pct_yoy', 'pct_level', 'ksf', 'per_10k', 'usd', 'persons', 'signal'] as const) {
      expect(formatEdgeValue(null, u)).toBeNull();
    }
  });
});

describe('latestObserved', () => {
  it('takes the last index with an observed status and a non-null value', () => {
    expect(latestObserved(obs([1000, 1100, 1200, null, null]), TEST_YEARS)).toEqual({
      value: 1200, year: 2023, status: 'actual', isLatestYear: false,
    });
  });

  it('ignores a value under a non-observed status and null under an observed status', () => {
    const c = cell([1, 2, 3, 4, null], ['actual', 'actual', 'actual', 'guide_only', 'actual']);
    expect(latestObserved(c, TEST_YEARS)?.year).toBe(2023);
  });

  it('returns null when nothing is observed', () => {
    expect(latestObserved(cell([null, null, null, null, null], ['guide_only', 'guide_only', 'guide_only', 'guide_only', 'guide_only']), TEST_YEARS)).toBeNull();
  });
});

describe('edgeCellDisplay', () => {
  it('shows the year when the latest observation is not the final year', () => {
    expect(edgeCellDisplay(obs([1000, 1100, 1200, null, null]), 'persons', TEST_YEARS, 'migration').text).toBe('+1,200 (2023)');
  });

  it('marks estimated values dotted with an Est. title', () => {
    const d = edgeCellDisplay(cell([1, 1, 1, 1, 9], ['actual', 'actual', 'actual', 'actual', 'estimated']), 'pct_yoy', TEST_YEARS, 'trades');
    expect(d).toEqual({ text: '+9.0%', title: 'Est.', dotted: true, observed: true });
  });

  it('F4: storage reads Pending manual pull, never 0', () => {
    const d = edgeCellDisplay(fourMarkets()[0]!.series.storage, 'pct_yoy', TEST_YEARS, 'storage');
    expect(d.text).toBe('— Pending manual pull');
    expect(d.text).not.toMatch(/\d/);
  });

  it('truck reads Not yet available where null', () => {
    expect(edgeCellDisplay(fourMarkets()[0]!.series.truck, 'pct_yoy', TEST_YEARS, 'truck').text).toBe('— Not yet available');
  });
});

describe('edgeSeriesHeader (F3)', () => {
  it('uses trueLabel + [PROXY] for the three proxies and never the raw key', () => {
    for (const k of ['hvacPermits', 'biz', 'eGrocery'] as const) {
      const h = edgeSeriesHeader(k, TEST_FIELD_META);
      expect(h).toBe(`${TEST_FIELD_META[k]!.trueLabel} [PROXY]`);
      expect(h).not.toContain(k);
    }
    expect(edgeSeriesHeader('storage', TEST_FIELD_META)).toBe('Self-storage asking rate growth');
    expect(edgeSeriesHeader('storage', {})).toBe('Unlabelled series');
  });

  it('the picker offers the 12 non-board series', () => {
    expect(EDGE_PICKER_SERIES).toHaveLength(12);
    expect(EDGE_PICKER_SERIES).toContain('hvacPermits');
    expect(EDGE_PICKER_SERIES).not.toContain('trades');
  });
});

describe('board model', () => {
  const a = mkMarket('a', 'Alpha', 'OH', 'named', { trades: obs([1, 1, 1, 1, 5]) });
  const b = mkMarket('b', 'Bravo', 'OH', 'auto', { trades: obs([1, 1, 1, 1, 9]) });
  const c = mkMarket('c', 'Charlie', 'OH', 'named_custom');
  const d = mkMarket('d', 'Delta', 'OH', 'auto', { trades: obs([1, 1, 1, 1, 1]) });
  const ids = (ms: { id: string }[]) => ms.map((m) => m.id);

  it('filters by set', () => {
    expect(ids(filterEdgeMarkets([a, b, c, d], 'buybox'))).toEqual(['a', 'c']);
    expect(ids(filterEdgeMarkets([a, b, c, d], 'auto'))).toEqual(['b', 'd']);
    expect(ids(filterEdgeMarkets([a, b, c, d], 'all'))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('pins buy-box first under All, sorted within each group, nulls last', () => {
    const s = { ...EDGE_BOARD_DEFAULT_STATE, set: 'all' as const };
    expect(ids(sortEdgeMarkets([a, b, c, d], s, TEST_YEARS))).toEqual(['a', 'c', 'b', 'd']);
    expect(ids(sortEdgeMarkets([a, b, c, d], { ...s, pinBuyBox: false }, TEST_YEARS))).toEqual(['b', 'a', 'd', 'c']);
    expect(ids(sortEdgeMarkets([a, b, c, d], { ...s, pinBuyBox: false, sortDir: 'asc' }, TEST_YEARS))).toEqual(['d', 'a', 'b', 'c']);
    expect(ids(sortEdgeMarkets([a, b, c, d], { ...s, pinBuyBox: false, sortKey: 'name', sortDir: 'asc' }, TEST_YEARS))).toEqual(['a', 'b', 'c', 'd']);
  });

  it('defaults to Buy-box, pinned, trades desc, no extra columns', () => {
    expect(EDGE_BOARD_DEFAULT_STATE).toEqual({ set: 'buybox', pinBuyBox: true, sortKey: 'trades', sortDir: 'desc', extraColumns: [] });
  });
});

describe('localIsoToday', () => {
  it('formats the local date', () => {
    expect(localIsoToday(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/edge-status-label.test.ts`
Expected: FAIL — `Failed to resolve import "../../src/modules/acquisitions/edge-hooks"`.

- [ ] **Step 3: Write the hooks + helpers**

Create `src/modules/acquisitions/edge-hooks.ts`:

```ts
// src/modules/acquisitions/edge-hooks.ts
//
// Oxford Edge client layer (spec §8.7): TanStack Query hooks over /api/warehouse/edge/* plus the pure
// display helpers every Edge surface shares (board, data health, pull queue, deal readout, Sourcing
// column) and the deal→market resolver (Task 9 appends it to this file).
//
// fetchJson + Zod parse only. The mirror-fallback variant (fetchParsedOrMirror) is deliberately NOT
// used: nothing Edge is baked (CoStar-licensed, spec §5.4), so on the mirror fetchJson throws
// WarehouseUnavailableError and the UI says "Edge is local-only".
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  EDGE_OBSERVED_STATUSES, EDGE_SERIES, EdgeMarketsResponse, EdgePullItem, EdgePullQueueResponse,
  type EdgeMarket, type EdgeSeriesCell, type EdgeSeriesKey, type EdgeStatus, type EdgeUnit, type RecordPullRequest,
} from '@contracts/edge';
import { ORA_CLIENT_HEADERS, ORA_JSON_MUTATION_HEADERS } from '@contracts/client-header';
import { fetchJson, isWarehouseUnavailable, QUERY_OPTS } from '../intel/hooks';

// ── Queries ────────────────────────────────────────────────────────────────────────────────────

export const EDGE_KEYS = {
  markets: ['warehouse', 'edge', 'markets'] as const,
  pullQueue: ['warehouse', 'edge', 'pull-queue'] as const,
};

/** One retry for a real failure; none when the Brain Server is absent (mirror / server down). */
function retryUnlessUnavailable(failureCount: number, error: unknown): boolean {
  return !isWarehouseUnavailable(error) && failureCount < 1;
}

export function useEdgeMarkets(opts: { enabled?: boolean } = {}) {
  return useQuery({
    queryKey: EDGE_KEYS.markets,
    queryFn: async () => EdgeMarketsResponse.parse(await fetchJson<unknown>('/api/warehouse/edge/markets')),
    staleTime: 5 * 60_000,
    retry: retryUnlessUnavailable,
    enabled: opts.enabled ?? true,
  });
}

export function useEdgePullQueue() {
  return useQuery({
    queryKey: EDGE_KEYS.pullQueue,
    queryFn: async () => EdgePullQueueResponse.parse(await fetchJson<unknown>('/api/warehouse/edge/pull-queue')),
    ...QUERY_OPTS,
    retry: retryUnlessUnavailable,
  });
}

async function readPullItem(res: Response): Promise<EdgePullItem> {
  const payload = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) {
    const err = (payload as { error?: unknown }).error;
    throw new Error(typeof err === 'string' ? err : `Edge pull update failed (${res.status})`);
  }
  return EdgePullItem.parse(payload);
}

export function useRecordPull() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: RecordPullRequest): Promise<EdgePullItem> => {
      const res = await fetch('/api/warehouse/edge/pull-queue', {
        method: 'POST',
        headers: ORA_JSON_MUTATION_HEADERS,
        body: JSON.stringify(input),
      });
      return readPullItem(res);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: EDGE_KEYS.pullQueue });
    },
  });
}

export function useVoidPull() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (logId: number): Promise<EdgePullItem> => {
      const res = await fetch(`/api/warehouse/edge/pull-queue/${logId}/void`, {
        method: 'POST',
        headers: ORA_CLIENT_HEADERS,
      });
      return readPullItem(res);
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: EDGE_KEYS.pullQueue });
    },
  });
}

// ── Status + value display (one source for every surface) ────────────────────────────────────

export interface EdgeStatusLabel {
  /** Replacement text when the cell has no observed value; null for observed statuses. */
  text: string | null;
  title: string | null;
  /** Dotted underline (the Provenance "estimated" visual convention). */
  dotted: boolean;
}

export function edgeStatusLabel(status: EdgeStatus): EdgeStatusLabel {
  switch (status) {
    case 'actual':
      return { text: null, title: null, dotted: false };
    case 'estimated':
      return { text: null, title: 'Est.', dotted: true };
    case 'nowcast':
      return { text: null, title: 'Nowcast', dotted: true };
    case 'guide_only':
      return { text: 'Pending manual pull', title: 'Pending manual pull', dotted: false };
    case 'null':
      return { text: 'Not published', title: 'Not published', dotted: false };
  }
}

export interface EdgeLatest {
  value: number;
  year: number;
  status: EdgeStatus;
  isLatestYear: boolean;
}

/** The last index whose status is observed (actual/estimated/nowcast) AND whose value is non-null. */
export function latestObserved(cell: EdgeSeriesCell, years: readonly number[]): EdgeLatest | null {
  for (let i = cell.values.length - 1; i >= 0; i--) {
    const value = cell.values[i];
    const status = cell.status[i];
    const year = years[i];
    if (value === null || value === undefined || status === undefined || year === undefined) continue;
    if (!EDGE_OBSERVED_STATUSES.includes(status)) continue;
    return { value, year, status, isLatestYear: i === years.length - 1 };
  }
  return null;
}

/** Never returns a number-looking string for null (F4): callers render the status label instead. */
export function formatEdgeValue(value: number | null, unit: EdgeUnit): string | null {
  if (value === null || !Number.isFinite(value)) return null;
  const signed = (s: string) => (value > 0 ? `+${s}` : s);
  switch (unit) {
    case 'pct_yoy':
      return `${signed(value.toFixed(1))}%`;
    case 'pct_level':
      return `${value.toFixed(1)}%`;
    case 'ksf':
      return `${Math.round(value).toLocaleString('en-US')} kSF`;
    case 'per_10k':
      return `${value.toFixed(1)} /10k`;
    case 'usd':
      return `$${Math.round(value).toLocaleString('en-US')}`;
    case 'persons':
      return signed(Math.round(value).toLocaleString('en-US'));
    case 'signal':
      return value.toFixed(2);
  }
}

export interface EdgeCellDisplay {
  text: string;
  title: string | null;
  dotted: boolean;
  observed: boolean;
}

export function edgeCellDisplay(
  cell: EdgeSeriesCell,
  unit: EdgeUnit,
  years: readonly number[],
  field: EdgeSeriesKey,
): EdgeCellDisplay {
  const latest = latestObserved(cell, years);
  if (latest) {
    const label = edgeStatusLabel(latest.status);
    const formatted = formatEdgeValue(latest.value, unit) ?? '—';
    return {
      text: latest.isLatestYear ? formatted : `${formatted} (${latest.year})`,
      title: label.title,
      dotted: label.dotted,
      observed: true,
    };
  }
  // Data dictionary: truck is never hidden and never reads as zero where it is null.
  if (field === 'truck') return { text: '— Not yet available', title: 'Not yet available', dotted: false, observed: false };
  const lastStatus: EdgeStatus = cell.status[cell.status.length - 1] ?? 'null';
  const text = edgeStatusLabel(lastStatus).text ?? 'Not published';
  return { text: `— ${text}`, title: text, dotted: false, observed: false };
}

/** Honest header: trueLabel from markets.json, + " [PROXY]" when isProxy. Never the raw key (F3). */
export function edgeSeriesHeader(field: EdgeSeriesKey, fieldMeta: EdgeMarketsResponse['fieldMeta']): string {
  const fm = fieldMeta[field];
  if (!fm) return 'Unlabelled series';
  return fm.isProxy ? `${fm.trueLabel} [PROXY]` : fm.trueLabel;
}

// ── Board model ────────────────────────────────────────────────────────────────────────────────

export type EdgeSetFilter = 'buybox' | 'all' | 'auto';
export type EdgeBoardSortKey = 'name' | EdgeSeriesKey;

/** Lifted into AcquisitionsModule so it survives a tab round-trip without force-mounting. */
export interface EdgeBoardState {
  set: EdgeSetFilter;
  pinBuyBox: boolean;
  sortKey: EdgeBoardSortKey;
  sortDir: 'asc' | 'desc';
  extraColumns: EdgeSeriesKey[];
}

export const EDGE_BOARD_DEFAULT_STATE: EdgeBoardState = {
  set: 'buybox',
  pinBuyBox: true,
  sortKey: 'trades',
  sortDir: 'desc',
  extraColumns: [],
};

/** Default board columns (spec §8.3). None is a proxy. */
export const EDGE_BOARD_COLUMNS: ReadonlyArray<{ field: EdgeSeriesKey; header: string }> = [
  { field: 'trades', header: 'Trades momentum' },
  { field: 'vac', header: 'Flex vacancy' },
  { field: 'rent', header: 'Flex rent growth' },
  { field: 'per', header: 'Pipeline' },
  { field: 'migration', header: 'Net migration' },
  { field: 'pop', header: 'Population' },
];

/** The other 12 series, offered in the column picker. */
export const EDGE_PICKER_SERIES: readonly EdgeSeriesKey[] = EDGE_SERIES.filter(
  (k) => !EDGE_BOARD_COLUMNS.some((c) => c.field === k),
);

/** The four values the deal readout shows (spec §8.4). */
export const EDGE_READOUT_SERIES: ReadonlyArray<{ field: EdgeSeriesKey; label: string }> = [
  { field: 'vac', label: 'Flex vacancy' },
  { field: 'rent', label: 'Flex rent growth' },
  { field: 'per', label: 'Pipeline (new supply, kSF)' },
  { field: 'trades', label: 'Trades momentum' },
];

/** Series that have a manual-pull queue item (Data health links them). */
export const EDGE_PULL_SERIES: ReadonlySet<EdgeSeriesKey> = new Set<EdgeSeriesKey>(['storage', 'ios', 'mfgInvest', 'truck']);

export function isBuyBox(m: EdgeMarket): boolean {
  return m.type === 'named' || m.type === 'named_custom';
}

export function filterEdgeMarkets(markets: readonly EdgeMarket[], set: EdgeSetFilter): EdgeMarket[] {
  if (set === 'all') return [...markets];
  return markets.filter((m) => (set === 'buybox' ? isBuyBox(m) : !isBuyBox(m)));
}

/** Sort by name or by the latest OBSERVED value; nulls last in both directions; under "All" with
 *  the pin on, the buy-box group comes first and each group keeps the sort order (stable sort). */
export function sortEdgeMarkets(
  markets: readonly EdgeMarket[],
  state: Pick<EdgeBoardState, 'set' | 'pinBuyBox' | 'sortKey' | 'sortDir'>,
  years: readonly number[],
): EdgeMarket[] {
  const dir = state.sortDir === 'asc' ? 1 : -1;
  const valueOf = (m: EdgeMarket): number | string | null =>
    state.sortKey === 'name' ? m.name : (latestObserved(m.series[state.sortKey], years)?.value ?? null);
  const sorted = [...markets].sort((a, b) => {
    const av = valueOf(a);
    const bv = valueOf(b);
    if (av === null && bv === null) return 0;
    if (av === null) return 1;
    if (bv === null) return -1;
    if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
    return String(av).localeCompare(String(bv)) * dir;
  });
  if (state.set !== 'all' || !state.pinBuyBox) return sorted;
  return [...sorted.filter(isBuyBox), ...sorted.filter((m) => !isBuyBox(m))];
}

/** Client local date for the "Mark done" form default (server re-validates against its own clock). */
export function localIsoToday(now: Date = new Date()): string {
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/edge-status-label.test.ts && npm run typecheck && npx eslint src/modules/acquisitions/edge-hooks.ts --max-warnings 0`
Expected: all tests PASS; typecheck 0; eslint 0 problems.

- [ ] **Step 5: Commit**

```bash
git add src/modules/acquisitions/edge-hooks.ts tests/unit/edge-status-label.test.ts
git commit -F - <<'EOF'
feat(acquisitions): Oxford Edge client hooks + status/format/board helpers

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 9: Strict deal→market resolver (appended to `edge-hooks.ts`)

**Files:**
- Modify: `src/modules/acquisitions/edge-hooks.ts` (append at end of file; extend the `@contracts/edge` type import)
- Test: `tests/unit/edge-resolver.test.ts`

**Interfaces:**
- Consumes: Task 8 helpers; `Deal`, `Market` (`@contracts/index`); `EdgeMarket`, `EdgeMarketsResponse`.
- Produces:
  - `type EdgeUnmatchedReason = 'no_location' | 'no_market_for_location' | 'ambiguous' | 'edge_id_absent'`
  - `type EdgeResolution = { kind: 'matched'; market: EdgeMarket; via: 'tier1_market' | 'tier2_location' } | { kind: 'unmatched'; reason: EdgeUnmatchedReason }`
  - `EDGE_TIER1_TABLE: Readonly<Partial<Record<Market, string>>>`, `EDGE_TIER2_MARKETS: ReadonlySet<Market>`, `EDGE_UNMATCHED_TEXT: Readonly<Record<EdgeUnmatchedReason, string>>`
  - `parseCityState(location: string | null): { city: string; state: string } | null`
  - `resolveEdgeMarket(deal: Pick<Deal, 'market' | 'location'>, markets: readonly EdgeMarket[]): EdgeResolution`
  - `findDealForCandidate(deals: readonly Deal[], notionDealId: string | null): Deal | null`
  - `edgeReadoutTitle(market: EdgeMarket, data: EdgeMarketsResponse): string`
  - `type EdgeQueryState = 'idle' | 'loading' | 'error' | 'ready'`; `edgeCandidateCell(notionDealId, deals, data, state): { text: string; title: string | null }`

- [ ] **Step 1: Write the failing test**

Create `tests/unit/edge-resolver.test.ts`:

```ts
// tests/unit/edge-resolver.test.ts — F2 / F13 (spec §8.4, §9). No fuzzy matching, no default.
import { describe, expect, it } from 'vitest';
import { Market } from '@contracts/common';
import type { Deal } from '@contracts/index';
import {
  EDGE_TIER1_TABLE, EDGE_TIER2_MARKETS, EDGE_UNMATCHED_TEXT, edgeCandidateCell, findDealForCandidate, parseCityState,
  resolveEdgeMarket,
} from '../../src/modules/acquisitions/edge-hooks';
import { fourMarkets, mkMarket, mkMarketsResponse } from './edge-test-helpers';

const MARKETS = [
  mkMarket('columbus', 'Columbus', 'OH', 'named'),
  mkMarket('cleveland', 'Cleveland', 'OH', 'auto'),
  mkMarket('hagerstown', 'Hagerstown', 'MD', 'named'),
  mkMarket('indianapolis_south', 'Indianapolis (South Metro)', 'IN', 'named_custom'),
  mkMarket('indianapolis_carmel_greenwood', 'Indianapolis-Carmel-Greenwood', 'IN', 'auto'),
  mkMarket('washington_arlington_alexandria', 'Washington-Arlington-Alexandria', 'DC', 'auto'),
  mkMarket('scranton_wilkes_barre', 'Scranton--Wilkes-Barre', 'PA', 'auto'),
];
const deal = (market: Deal['market'], location: string | null) => ({ market, location });

describe('Tier 1 (Deal.market enum)', () => {
  it('every Market member is either in the reviewed table or deferred to Tier 2 (enum-completeness guard)', () => {
    for (const m of Market.options) {
      const inTier1 = Object.prototype.hasOwnProperty.call(EDGE_TIER1_TABLE, m);
      expect(inTier1 || EDGE_TIER2_MARKETS.has(m), `Market '${m}' has no Edge decision`).toBe(true);
      expect(inTier1 && EDGE_TIER2_MARKETS.has(m), `Market '${m}' is in both tiers`).toBe(false);
    }
  });

  it("'Indianapolis IN' maps to the full CBSA, never the South cut", () => {
    expect(EDGE_TIER1_TABLE['Indianapolis IN']).toBe('indianapolis_carmel_greenwood');
    const r = resolveEdgeMarket(deal('Indianapolis IN', null), MARKETS);
    expect(r).toMatchObject({ kind: 'matched', via: 'tier1_market', market: { id: 'indianapolis_carmel_greenwood' } });
  });

  it("'Twinsburg, OH (Cleveland MSA)' with market Cleveland MSA → tier 1 cleveland", () => {
    const r = resolveEdgeMarket(deal('Cleveland MSA', 'Twinsburg, OH (Cleveland MSA)'), MARKETS);
    expect(r).toMatchObject({ kind: 'matched', via: 'tier1_market', market: { id: 'cleveland' } });
  });

  it('a table id missing from markets.json → edge_id_absent, never a substitute', () => {
    expect(resolveEdgeMarket(deal('Toledo OH', 'Toledo, OH'), MARKETS)).toEqual({ kind: 'unmatched', reason: 'edge_id_absent' });
  });
});

describe('Tier 2 (Deal.location exact City, ST)', () => {
  it('Mid-Atlantic + Hagerstown, MD → hagerstown', () => {
    expect(resolveEdgeMarket(deal('Mid-Atlantic', 'Hagerstown, MD'), MARKETS)).toMatchObject({
      kind: 'matched', via: 'tier2_location', market: { id: 'hagerstown' },
    });
  });

  it('Mid-Atlantic + Salisbury, MD → unmatched', () => {
    expect(resolveEdgeMarket(deal('Mid-Atlantic', 'Salisbury, MD'), MARKETS)).toEqual({ kind: 'unmatched', reason: 'no_market_for_location' });
  });

  it('TBD → no_location', () => {
    expect(resolveEdgeMarket(deal(null, 'TBD'), MARKETS)).toEqual({ kind: 'unmatched', reason: 'no_location' });
    expect(resolveEdgeMarket(deal(null, null), MARKETS)).toEqual({ kind: 'unmatched', reason: 'no_location' });
  });

  it('Columbus, IN never resolves to Columbus OH (state-checked)', () => {
    expect(resolveEdgeMarket(deal('Other', 'Columbus, IN'), MARKETS)).toEqual({ kind: 'unmatched', reason: 'no_market_for_location' });
  });

  it('F13: Alexandria, VA does not match the DC-primary CBSA', () => {
    expect(resolveEdgeMarket(deal('Other', 'Alexandria, VA'), MARKETS)).toEqual({ kind: 'unmatched', reason: 'no_market_for_location' });
  });

  it('street address + city: Indianapolis resolves to the full CBSA by principal city, not the South cut', () => {
    expect(resolveEdgeMarket(deal(null, '3849 N Richardt, Indianapolis, IN'), MARKETS)).toMatchObject({
      kind: 'matched', market: { id: 'indianapolis_carmel_greenwood' },
    });
  });

  it('matches the CBSA principal city on a double-hyphen title', () => {
    expect(resolveEdgeMarket(deal('Unknown', 'Scranton, PA'), MARKETS)).toMatchObject({ kind: 'matched', market: { id: 'scranton_wilkes_barre' } });
  });

  it('two candidates → ambiguous, never picks one', () => {
    const twins = [mkMarket('springfield', 'Springfield', 'MO', 'auto'), mkMarket('springfield_x', 'Springfield-Branson', 'MO', 'auto')];
    expect(resolveEdgeMarket(deal('Other', 'Springfield, MO'), twins)).toEqual({ kind: 'unmatched', reason: 'ambiguous' });
  });

  it('parseCityState takes the LAST City, ST pair after stripping parentheticals', () => {
    expect(parseCityState('3849 N Richardt, Indianapolis, IN')).toEqual({ city: 'Indianapolis', state: 'IN' });
    expect(parseCityState('Twinsburg, OH (Cleveland MSA)')).toEqual({ city: 'Twinsburg', state: 'OH' });
    expect(parseCityState('St. Louis, MO 63101')).toEqual({ city: 'St. Louis', state: 'MO' });
    expect(parseCityState('Columbus, Ohio')).toBeNull();
  });

  it('every reason has display text', () => {
    expect(Object.keys(EDGE_UNMATCHED_TEXT).sort()).toEqual(['ambiguous', 'edge_id_absent', 'no_location', 'no_market_for_location']);
  });
});

describe('Sourcing candidate join', () => {
  const columbusDeal: Deal = {
    id: 'page-1', name: 'Fixture', shortName: null, location: 'Columbus, OH', market: 'Columbus OH', sf: null, buildings: null,
    stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null, lender: null, status: null,
    nextAction: null, owner: null, targetCloseDate: null, notionDealId: 'DEAL-9', confidential: false, estimatedFields: [],
  };

  it('joins candidate.notionDealId to Deal.id (the Notion page id), never by name', () => {
    expect(findDealForCandidate([columbusDeal], 'page-1')).toBe(columbusDeal);
    expect(findDealForCandidate([columbusDeal], 'DEAL-9')).toBeNull();
    expect(findDealForCandidate([columbusDeal], null)).toBeNull();
  });

  it('edgeCandidateCell renders every state honestly', () => {
    const data = mkMarketsResponse(fourMarkets());
    expect(edgeCandidateCell(null, [columbusDeal], data, 'ready').text).toBe('No Edge market (no linked deal)');
    expect(edgeCandidateCell('page-1', [columbusDeal], undefined, 'idle').text).toBe('—');
    expect(edgeCandidateCell('page-1', [columbusDeal], undefined, 'error').text).toBe('Edge unavailable');
    const ok = edgeCandidateCell('page-1', [columbusDeal], data, 'ready');
    expect(ok.text).toBe('3.0% · +1.8% · STALE');
    expect(ok.title).toContain('Columbus, OH — Flex vacancy: 3.0%');
    expect(ok.title).toContain('STALE (as of 2026-07-14)');
    const tbd = { ...columbusDeal, market: null, location: 'TBD' };
    expect(edgeCandidateCell('page-1', [tbd], data, 'ready')).toEqual({ text: 'No Edge market', title: EDGE_UNMATCHED_TEXT.no_location });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/edge-resolver.test.ts`
Expected: FAIL — `SyntaxError: The requested module ... does not provide an export named 'EDGE_TIER1_TABLE'` (or TS error `has no exported member 'EDGE_TIER1_TABLE'`).

- [ ] **Step 3: Append the resolver**

In `src/modules/acquisitions/edge-hooks.ts`, add one import line below the existing `@contracts/client-header` import:

```ts
import type { Deal, Market } from '@contracts/index';
```

Append to the end of the file:

```ts
// ── Deal → Edge market resolver (spec §8.4; F2, F13) ───────────────────────────────────────────
// Pure, two tiers, no fuzzy matching, no default. Tier 1 decides whenever it applies. Runs
// client-side against the snapshot the client already holds: no deal identity reaches the Edge API.

export type EdgeUnmatchedReason = 'no_location' | 'no_market_for_location' | 'ambiguous' | 'edge_id_absent';

export type EdgeResolution =
  | { kind: 'matched'; market: EdgeMarket; via: 'tier1_market' | 'tier2_location' }
  | { kind: 'unmatched'; reason: EdgeUnmatchedReason };

/** Reviewed Tier-1 table. Every Market member is here or in EDGE_TIER2_MARKETS
 *  (tests/unit/edge-resolver.test.ts fails the build otherwise). */
export const EDGE_TIER1_TABLE: Readonly<Partial<Record<Market, string>>> = {
  'Columbus OH': 'columbus',
  'Toledo OH': 'toledo',
  'Cleveland MSA': 'cleveland',
  'Kansas City MO': 'kansas_city',
  // Full CBSA. indianapolis_south is a 3-county submarket cut (Johnson/Morgan/Shelby) and a deal
  // tagged only "Indianapolis IN" is not known to sit inside it. Phase 2's county crosswalk revisits.
  'Indianapolis IN': 'indianapolis_carmel_greenwood',
  'Cincinnati OH': 'cincinnati',
  'Madison WI': 'madison',
  'Grand Rapids MI': 'grand_rapids',
  'Des Moines IA': 'des_moines',
  'Louisville KY': 'louisville',
  'Richmond VA': 'richmond',
};

/** Market members (plus a null market) that defer to the Tier-2 location match. */
export const EDGE_TIER2_MARKETS: ReadonlySet<Market> = new Set<Market>(['Mid-Atlantic', 'Other', 'Unknown']);

export const EDGE_UNMATCHED_TEXT: Readonly<Record<EdgeUnmatchedReason, string>> = {
  no_location: 'no parseable "City, ST" in the deal location',
  no_market_for_location: 'no Edge market for this city and state',
  ambiguous: 'more than one Edge market matches this city and state',
  edge_id_absent: 'the mapped Edge market is missing from markets.json',
};

/** The LAST "City, ST" pair in a location string, after stripping parentheticals. */
export function parseCityState(location: string | null): { city: string; state: string } | null {
  if (!location) return null;
  const stripped = location.replace(/\([^)]*\)/g, ' ');
  const re = /([A-Za-z][A-Za-z .'-]*?)\s*,\s*([A-Z]{2})\b/g;
  let last: { city: string; state: string } | null = null;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stripped)) !== null) {
    const city = m[1]?.trim();
    const state = m[2];
    if (city && state) last = { city, state };
  }
  return last;
}

/** First hyphen-segment of a CBSA title = its principal city ("Scranton--Wilkes-Barre" → "scranton"). */
function principalCity(name: string): string {
  return (name.split('-')[0] ?? name).trim().toLowerCase();
}

export function resolveEdgeMarket(deal: Pick<Deal, 'market' | 'location'>, markets: readonly EdgeMarket[]): EdgeResolution {
  const tier1Id = deal.market !== null ? EDGE_TIER1_TABLE[deal.market] : undefined;
  if (tier1Id !== undefined) {
    const market = markets.find((m) => m.id === tier1Id);
    return market ? { kind: 'matched', market, via: 'tier1_market' } : { kind: 'unmatched', reason: 'edge_id_absent' };
  }
  const pair = parseCityState(deal.location);
  if (!pair) return { kind: 'unmatched', reason: 'no_location' };
  const city = pair.city.toLowerCase();
  const hits = markets.filter(
    (m) => m.state === pair.state && (m.name.trim().toLowerCase() === city || principalCity(m.name) === city),
  );
  const only = hits.length === 1 ? hits[0] : undefined;
  if (only) return { kind: 'matched', market: only, via: 'tier2_location' };
  return { kind: 'unmatched', reason: hits.length === 0 ? 'no_market_for_location' : 'ambiguous' };
}

/**
 * Sourcing candidate → snapshot Deal. The join is `Deal.id === candidate.notionDealId`: both carry the
 * Notion PAGE id (server/warehouse/acq-notion-sync.ts stores page.id in acq_candidates.notion_deal_id;
 * server/sources/notion-deals.ts sets Deal.id = page.id for live pipeline rows). This is the same join
 * DealDrawer.findRankedCandidateForDeal and PipelineTierBoard already use. Deal.notionDealId holds the
 * Notion "Deal ID" unique-id ("DEAL-3"), which never equals a page id, so joining on it would leave
 * every candidate unlinked. `null` = unjoinable; never fall back to a name match.
 */
export function findDealForCandidate(deals: readonly Deal[], notionDealId: string | null): Deal | null {
  if (notionDealId === null) return null;
  return deals.find((d) => d.id === notionDealId) ?? null;
}

const SERIES_UNIT_OF = (field: EdgeSeriesKey, data: EdgeMarketsResponse): EdgeUnit =>
  data.fieldMeta[field]?.unit ?? 'signal';

export function edgeReadoutTitle(market: EdgeMarket, data: EdgeMarketsResponse): string {
  const parts = EDGE_READOUT_SERIES.map(
    ({ field, label }) => `${label}: ${edgeCellDisplay(market.series[field], SERIES_UNIT_OF(field, data), data.years, field).text}`,
  );
  const f = data.freshness;
  const fresh = f ? (f.stale ? ` · STALE (as of ${f.asOf})` : ` · as of ${f.asOf}`) : '';
  return `${market.name}, ${market.state} — ${parts.join(' · ')}${fresh}`;
}

export type EdgeQueryState = 'idle' | 'loading' | 'error' | 'ready';

/** Compact Sourcing-list cell: "vacancy · rent growth" (+ STALE), full readout in the tooltip. */
export function edgeCandidateCell(
  notionDealId: string | null,
  deals: readonly Deal[],
  data: EdgeMarketsResponse | undefined,
  state: EdgeQueryState,
): { text: string; title: string | null } {
  const deal = findDealForCandidate(deals, notionDealId);
  if (!deal) return { text: 'No Edge market (no linked deal)', title: null };
  if (state === 'idle' || state === 'loading') return { text: '—', title: null };
  if (state === 'error' || !data || data.availability !== 'ok') {
    return { text: 'Edge unavailable', title: data ? `Edge dataset ${data.availability}` : 'Edge is local-only (Brain Server)' };
  }
  const res = resolveEdgeMarket(deal, data.markets);
  if (res.kind === 'unmatched') return { text: 'No Edge market', title: EDGE_UNMATCHED_TEXT[res.reason] };
  const vac = edgeCellDisplay(res.market.series.vac, SERIES_UNIT_OF('vac', data), data.years, 'vac').text;
  const rent = edgeCellDisplay(res.market.series.rent, SERIES_UNIT_OF('rent', data), data.years, 'rent').text;
  return { text: `${vac} · ${rent}${data.freshness?.stale ? ' · STALE' : ''}`, title: edgeReadoutTitle(res.market, data) };
}
```

No other import changes: `EdgeMarketsResponse` (value), `EdgeMarket`, `EdgeSeriesKey` and `EdgeUnit` (types) are already in Task 8's `@contracts/edge` import, so do not add a second import from that module.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/unit/edge-resolver.test.ts tests/unit/edge-status-label.test.ts && npm run typecheck && npx eslint src/modules/acquisitions/edge-hooks.ts --max-warnings 0`
Expected: all PASS; typecheck 0; eslint 0.

- [ ] **Step 5: Commit**

```bash
git add src/modules/acquisitions/edge-hooks.ts tests/unit/edge-resolver.test.ts
git commit -F - <<'EOF'
feat(acquisitions): strict two-tier deal→Edge market resolver + Sourcing cell model

Candidate→deal join is Deal.id === candidate.notionDealId (Notion page id), matching
DealDrawer.findRankedCandidateForDeal; Deal.notionDealId holds the "DEAL-n" unique id.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 10: Market board `EdgeRankingBoard.tsx`

**Files:**
- Create: `src/modules/acquisitions/EdgeRankingBoard.tsx`
- Test: `tests/unit/edge-board.test.tsx`

**Interfaces:**
- Consumes: Task 8 board model + display helpers; `Card`, `CardHeader`, `DataTable`, `Column`, `Badge`, `SegmentedControl`, `Sparkline`.
- Produces: `EdgeRankingBoard({ data: EdgeMarketsResponse; board: EdgeBoardState; onBoardChange: (next: EdgeBoardState) => void })`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/edge-board.test.tsx`:

```tsx
// tests/unit/edge-board.test.tsx — market board (spec §8.3, F3, F4).
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { EdgeMarketsResponse } from '@contracts/edge';
import { EdgeRankingBoard } from '../../src/modules/acquisitions/EdgeRankingBoard';
import { EDGE_BOARD_DEFAULT_STATE, type EdgeBoardState } from '../../src/modules/acquisitions/edge-hooks';
import { fourMarkets, mkMarketsResponse } from './edge-test-helpers';

function Harness({ data }: { data: EdgeMarketsResponse }) {
  const [board, setBoard] = useState<EdgeBoardState>(EDGE_BOARD_DEFAULT_STATE);
  return <EdgeRankingBoard data={data} board={board} onBoardChange={setBoard} />;
}

const bodyRows = () => screen.getAllByRole('row').slice(1);

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('EdgeRankingBoard', () => {
  it('defaults to the buy-box set sorted by trades momentum desc, with honest set counts', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    expect(screen.getByRole('radio', { name: 'Buy-box (3)' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'All (4)' })).toBeTruthy();
    expect(screen.getByRole('radio', { name: 'Auto (1)' })).toBeTruthy();
    expect(bodyRows().map((r) => within(r).getAllByRole('cell')[0]!.textContent)).toEqual([
      expect.stringContaining('Indianapolis (South Metro), IN'),
      expect.stringContaining('Columbus, OH'),
      expect.stringContaining('Richmond, VA'),
    ]);
    expect(screen.queryByText('Cedar Rapids, IA')).toBeNull();
  });

  it('All shows every market, buy-box pinned on top', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    fireEvent.click(screen.getByRole('radio', { name: 'All (4)' }));
    const first = bodyRows().map((r) => within(r).getAllByRole('cell')[0]!.textContent ?? '');
    expect(first).toHaveLength(4);
    expect(first[3]).toContain('Cedar Rapids, IA');
  });

  it('has no rank column', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent ?? '');
    expect(headers.some((h) => /rank|#|score/i.test(h))).toBe(false);
    expect(headers).toEqual(['Market', 'Trades momentum', 'Flex vacancy', 'Flex rent growth', 'Pipeline', 'Net migration', 'Population']);
  });

  it('migration shows its year suffix because 2024–25 are unpublished', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    expect(screen.getAllByText('+1,200 (2023)')).toHaveLength(3);
  });

  it('F3: picker labels for the three proxies are trueLabel + [PROXY], never the raw key', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    expect(screen.getByLabelText('Residential building permits authorized, growth (Census BPS) [PROXY]')).toBeTruthy();
    expect(screen.getByLabelText('Total business establishment count growth (Census CBP) [PROXY]')).toBeTruthy();
    expect(screen.getByLabelText('Courier/messenger establishment count growth, NAICS 492 (Census CBP) [PROXY]')).toBeTruthy();
    expect(screen.queryByLabelText('hvacPermits')).toBeNull();
  });

  it('F4: adding the storage column renders Pending manual pull in every row, never 0', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    fireEvent.click(screen.getByLabelText('Self-storage asking rate growth'));
    expect(screen.getAllByRole('columnheader').map((h) => h.textContent)).toContain('Self-storage asking rate growth');
    expect(screen.getAllByText('— Pending manual pull')).toHaveLength(3);
  });

  it('truck renders Not yet available where null and the real value where observed', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    fireEvent.click(screen.getByLabelText('Truck AADT growth on primary corridors (state DOT)'));
    expect(screen.getAllByText('— Not yet available')).toHaveLength(2);
    expect(screen.getByText('+2.2%')).toBeTruthy();
  });

  it('row click opens the detail panel; metro-only markets say so', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    fireEvent.click(screen.getByText('Columbus, OH'));
    expect(screen.getByRole('region', { name: 'Columbus detail' })).toBeTruthy();
    expect(screen.getByText('Synthetic Sub A')).toBeTruthy();
    fireEvent.click(screen.getByRole('radio', { name: 'Auto (1)' }));
    fireEvent.click(screen.getByText('Cedar Rapids, IA'));
    expect(screen.getByText('CoStar publishes no submarket breakdown for this metro.')).toBeTruthy();
  });

  it('always shows the CoStar Flex footnote', () => {
    render(<Harness data={mkMarketsResponse(fourMarkets())} />);
    expect(screen.getByText(/Rent \/ vacancy \/ pipeline are CoStar Industrial Flex slice — not a ≤50K SF cut\./)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/edge-board.test.tsx`
Expected: FAIL — `Failed to resolve import "../../src/modules/acquisitions/EdgeRankingBoard"`.

- [ ] **Step 3: Write the board**

Create `src/modules/acquisitions/EdgeRankingBoard.tsx`:

```tsx
// src/modules/acquisitions/EdgeRankingBoard.tsx
//
// Oxford Edge market board (spec §8.3). Every market is a row; there is NO rank column and no
// composite: ordering comes only from the sort control over observed series values, so the board
// cannot be read as a score (spec §2 non-goals). Sort key/direction, set filter, buy-box pin and the
// picker columns are props lifted into AcquisitionsModule, so they survive a tab round-trip without
// FORCE_MOUNT_PANEL.
//
// DataTable's own header sort is deliberately unused (no column sets sortValue): it cannot express
// the pinned two-group order and does not report its internal sort for lifting. DataTable has no
// expandable rows, so a row click opens the detail panel directly beneath the table; its headers are
// plain strings, so header tooltips are replaced by the always-visible "Column definitions" list.
import { useState } from 'react';
import { SERIES_UNITS, type EdgeMarket, type EdgeMarketsResponse, type EdgeSeriesKey } from '@contracts/edge';
import { Card, CardHeader } from '@/primitives/Card';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge } from '@/primitives/Badge';
import { SegmentedControl } from '@/primitives/SegmentedControl';
import { Sparkline } from '@/charts/Sparkline';
import {
  EDGE_BOARD_COLUMNS, EDGE_PICKER_SERIES, edgeCellDisplay, edgeSeriesHeader, edgeStatusLabel, filterEdgeMarkets,
  formatEdgeValue, isBuyBox, sortEdgeMarkets,
  type EdgeBoardSortKey, type EdgeBoardState, type EdgeSetFilter,
} from './edge-hooks';

const TRAJECTORY_LABEL: Record<NonNullable<EdgeMarket['trajectory']>, string> = {
  a_growing: 'Growing',
  b_stable: 'Stable',
  c_reversing: 'Reversing',
};

const CONTROL_STYLE = {
  fontSize: '0.75rem',
  padding: '0.25rem 0.5rem',
  border: '1px solid var(--border-subtle)',
  borderRadius: '0.25rem',
  background: 'var(--surface-raised)',
  color: 'var(--text-primary)',
} as const;

const MUTED = { color: 'var(--text-tertiary)' } as const;

interface Props {
  data: EdgeMarketsResponse;
  board: EdgeBoardState;
  onBoardChange: (next: EdgeBoardState) => void;
}

function EdgeValue({ market, field, years }: { market: EdgeMarket; field: EdgeSeriesKey; years: readonly number[] }) {
  const d = edgeCellDisplay(market.series[field], SERIES_UNITS[field], years, field);
  const style = d.dotted ? { borderBottom: '1px dotted var(--text-tertiary)' } : d.observed ? undefined : MUTED;
  return (
    <span title={d.title ?? undefined} style={style}>
      {d.text}
    </span>
  );
}

/** Sparkline takes number[] only, so unpublished years are dropped rather than drawn as gaps. */
function observedValues(market: EdgeMarket, field: EdgeSeriesKey): number[] {
  return market.series[field].values.filter((v): v is number => v !== null);
}

function EdgeMarketDetail({ market, data, onClose }: { market: EdgeMarket; data: EdgeMarketsResponse; onClose: () => void }) {
  return (
    <div
      role="region"
      aria-label={`${market.name} detail`}
      className="mx-3 mb-3 rounded-[var(--radius-md)] p-3"
      style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)' }}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>
          {`${market.name}, ${market.state} · CBSA ${market.cbsa}`}
        </span>
        <button type="button" onClick={onClose} style={CONTROL_STYLE}>Close</button>
      </div>
      {market.subs.length === 0 ? (
        <p className="text-2xs" style={MUTED}>CoStar publishes no submarket breakdown for this metro.</p>
      ) : (
        <table className="ora-table mb-3 w-full text-xs">
          <thead>
            <tr>
              <th className="text-left">Submarket</th>
              <th className="text-right">Flex vacancy</th>
              <th className="text-right">Rent growth</th>
              <th className="text-right">Inventory</th>
            </tr>
          </thead>
          <tbody>
            {market.subs.map((s) => (
              <tr key={s.name}>
                <td>{s.name}</td>
                <td className="num text-right">{formatEdgeValue(s.vac, 'pct_level')}</td>
                <td className="num text-right">{formatEdgeValue(s.rentGrowth, 'pct_yoy')}</td>
                <td className="num text-right">{formatEdgeValue(s.invKsf, 'ksf')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <table className="ora-table w-full text-xs">
        <thead>
          <tr>
            <th className="text-left">Series</th>
            {data.years.map((y) => <th key={y} className="text-right">{y}</th>)}
          </tr>
        </thead>
        <tbody>
          {EDGE_BOARD_COLUMNS.map(({ field, header }) => (
            <tr key={field}>
              <td>{header}</td>
              {data.years.map((y, i) => {
                const value = market.series[field].values[i] ?? null;
                const label = edgeStatusLabel(market.series[field].status[i] ?? 'null');
                const text = value !== null ? (formatEdgeValue(value, SERIES_UNITS[field]) ?? '—') : (label.text ?? 'Not published');
                return (
                  <td
                    key={y}
                    className="num text-right"
                    title={label.title ?? undefined}
                    style={label.dotted ? { borderBottom: '1px dotted var(--text-tertiary)' } : value === null ? MUTED : undefined}
                  >
                    {text}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function EdgeRankingBoard({ data, board, onBoardChange }: Props) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const patch = (next: Partial<EdgeBoardState>) => onBoardChange({ ...board, ...next });

  const setOptions: ReadonlyArray<{ value: EdgeSetFilter; label: string }> = [
    { value: 'buybox', label: `Buy-box (${filterEdgeMarkets(data.markets, 'buybox').length})` },
    { value: 'all', label: `All (${data.markets.length})` },
    { value: 'auto', label: `Auto (${filterEdgeMarkets(data.markets, 'auto').length})` },
  ];
  const seriesColumns: ReadonlyArray<{ field: EdgeSeriesKey; header: string }> = [
    ...EDGE_BOARD_COLUMNS,
    ...board.extraColumns.map((field) => ({ field, header: edgeSeriesHeader(field, data.fieldMeta) })),
  ];
  const rows = sortEdgeMarkets(filterEdgeMarkets(data.markets, board.set), board, data.years);

  const toggleExtra = (field: EdgeSeriesKey) => {
    const removing = board.extraColumns.includes(field);
    patch({
      extraColumns: removing ? board.extraColumns.filter((f) => f !== field) : [...board.extraColumns, field],
      sortKey: removing && board.sortKey === field ? 'trades' : board.sortKey,
    });
  };

  const columns: Column<EdgeMarket>[] = [
    {
      key: 'market',
      header: 'Market',
      render: (m) => (
        <div className="flex items-center gap-1.5">
          <span style={{ fontWeight: 600 }}>{`${m.name}, ${m.state}`}</span>
          {isBuyBox(m) ? <Badge tone="gold">Buy-box</Badge> : <Badge tone="neutral">Auto</Badge>}
          {m.trajectory && <span className="text-2xs" style={MUTED}>{TRAJECTORY_LABEL[m.trajectory]}</span>}
        </div>
      ),
    },
    ...seriesColumns.map(
      ({ field, header }): Column<EdgeMarket> => ({
        key: field,
        header,
        align: 'right',
        render: (m) =>
          field === 'trades' ? (
            <span className="inline-flex items-center gap-2">
              <EdgeValue market={m} field={field} years={data.years} />
              <Sparkline data={observedValues(m, 'trades')} width={56} height={18} />
            </span>
          ) : (
            <EdgeValue market={m} field={field} years={data.years} />
          ),
      }),
    ),
  ];

  const selected = selectedId !== null ? (data.markets.find((m) => m.id === selectedId) ?? null) : null;

  return (
    <Card>
      <CardHeader title="Market board" trailing={<Badge tone="neutral">Sorted by observed values · no composite rank</Badge>} />
      <div className="flex flex-wrap items-center gap-3 px-3 pt-3">
        <SegmentedControl aria-label="Market set" options={setOptions} value={board.set} onChange={(v) => patch({ set: v })} />
        <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <input type="checkbox" checked={board.pinBuyBox} onChange={(e) => patch({ pinBuyBox: e.target.checked })} />
          Pin buy-box
        </label>
        <label className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
          Sort by
          <select
            aria-label="Sort board by"
            value={board.sortKey}
            onChange={(e) => patch({ sortKey: e.target.value as EdgeBoardSortKey })}
            style={CONTROL_STYLE}
          >
            <option value="name">Market</option>
            {seriesColumns.map((c) => <option key={c.field} value={c.field}>{c.header}</option>)}
          </select>
        </label>
        <button
          type="button"
          aria-label="Toggle sort direction"
          onClick={() => patch({ sortDir: board.sortDir === 'asc' ? 'desc' : 'asc' })}
          style={CONTROL_STYLE}
        >
          {board.sortDir === 'asc' ? '↑ Asc' : '↓ Desc'}
        </button>
      </div>
      <fieldset className="px-3 pt-2">
        <legend className="text-2xs uppercase" style={{ letterSpacing: '0.1em', color: 'var(--text-tertiary)' }}>Add series columns</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {EDGE_PICKER_SERIES.map((field) => (
            <label key={field} className="flex items-center gap-1.5 text-xs" style={{ color: 'var(--text-secondary)' }}>
              <input type="checkbox" checked={board.extraColumns.includes(field)} onChange={() => toggleExtra(field)} />
              {edgeSeriesHeader(field, data.fieldMeta)}
            </label>
          ))}
        </div>
      </fieldset>
      <div className="p-3">
        <DataTable
          columns={columns}
          rows={rows}
          getRowId={(m) => m.id}
          onRowClick={(m) => setSelectedId((cur) => (cur === m.id ? null : m.id))}
          minWidth={900}
        />
      </div>
      {selected && <EdgeMarketDetail market={selected} data={data} onClose={() => setSelectedId(null)} />}
      <dl className="grid grid-cols-1 gap-x-4 gap-y-0.5 px-3 pb-2 text-2xs md:grid-cols-2" style={MUTED}>
        {EDGE_BOARD_COLUMNS.map(({ field, header }) => (
          <div key={field} className="flex gap-1.5">
            <dt style={{ fontWeight: 600 }}>{header}</dt>
            <dd>{data.fieldMeta[field]?.trueLabel ?? 'Unlabelled series'}</dd>
          </div>
        ))}
      </dl>
      <p className="px-3 pb-3 text-2xs" style={MUTED}>
        Rent / vacancy / pipeline are CoStar Industrial Flex slice — not a ≤50K SF cut. Multi-state CBSAs list their primary state only.
      </p>
    </Card>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/edge-board.test.tsx && npm run typecheck && npx eslint src/modules/acquisitions/EdgeRankingBoard.tsx --max-warnings 0`
Expected: 9 tests PASS; typecheck 0; eslint 0.

- [ ] **Step 5: Commit**

```bash
git add src/modules/acquisitions/EdgeRankingBoard.tsx tests/unit/edge-board.test.tsx
git commit -F - <<'EOF'
feat(acquisitions): Oxford Edge market board (no rank column, honest proxy labels)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 11: Pull queue UI `EdgePullQueue.tsx`

**Files:**
- Create: `src/modules/acquisitions/EdgePullQueue.tsx`
- Test: `tests/unit/edge-pull-queue-ui.test.tsx`

**Interfaces:**
- Consumes: `useEdgePullQueue`, `useRecordPull`, `useVoidPull`, `localIsoToday`, `EDGE_KEYS` (Task 8); `useWarehouseLive`, `isWarehouseUnavailable` (`src/modules/intel/hooks.ts`); `EdgePullItem`, `EdgePullKind`, `EdgePullScopeState`.
- Produces: `EdgePullQueue()` (no props). Each item card has DOM id `edge-pull-${kind}` (Data health links to it).

- [ ] **Step 1: Write the failing test**

Create `tests/unit/edge-pull-queue-ui.test.tsx`:

```tsx
// tests/unit/edge-pull-queue-ui.test.tsx — spec §8.6: write controls only when the warehouse is live;
// Mark done → POST with ORA_JSON_MUTATION_HEADERS; Undo → confirm → POST /:id/void; 503 → offline note.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EdgePullQueueResponse } from '@contracts/edge';
import { EdgePullQueue } from '../../src/modules/acquisitions/EdgePullQueue';
import { EDGE_KEYS } from '../../src/modules/acquisitions/edge-hooks';

const QUEUE: EdgePullQueueResponse = {
  today: '2026-10-02',
  automatedCoverage: { truck: ['MI', 'VA'] },
  items: [
    {
      kind: 'storage', label: 'Self-storage asking rates', cadenceDays: 90, cadenceLabel: 'Quarterly', scopeType: 'market',
      why: 'Storage rates are the space-scarcity proxy.', caveat: "Today's rate only — record a baseline.",
      counts: { open: 1, due: 0, current: 1 },
      scopes: [
        { scopeKey: 'columbus', scopeLabel: 'Columbus, OH', state: 'open', lastDoneOn: null, lastNote: null, lastLogId: null, ageDays: null,
          links: [{ label: 'StorageCafe', url: 'https://www.storagecafe.com/self-storage-rates/columbus-oh/' }], blocker: null },
        { scopeKey: 'richmond', scopeLabel: 'Richmond, VA', state: 'current', lastDoneOn: '2026-09-01', lastNote: 'baseline $1.10/SF', lastLogId: 7, ageDays: 31,
          links: [], blocker: null },
      ],
    },
  ],
};

function renderQueue({ live, seed = true }: { live: boolean; seed?: boolean }) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity }, mutations: { retry: false } } });
  if (seed) qc.setQueryData(EDGE_KEYS.pullQueue, QUEUE);
  qc.setQueryData(['warehouse', 'live-probe'], live ? true : undefined);
  return render(<QueryClientProvider client={qc}><EdgePullQueue /></QueryClientProvider>);
}

const itemJson = () => new Response(JSON.stringify(QUEUE.items[0]), { status: 200, headers: { 'content-type': 'application/json' } });

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  // The live probe (GET /api/warehouse/noi) answers 503 so a non-seeded probe reads "not live";
  // every other call (the mutations) answers with the updated item.
  vi.stubGlobal('fetch', vi.fn(async (url: string) =>
    String(url).includes('/noi')
      ? new Response(JSON.stringify({ error: 'warehouse unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } })
      : itemJson()));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.restoreAllMocks(); });

describe('EdgePullQueue', () => {
  it('renders the card with cadence, counts, caveat and automated coverage', () => {
    renderQueue({ live: false });
    expect(screen.getByText('Self-storage asking rates · Quarterly')).toBeTruthy();
    expect(screen.getByText('1 open')).toBeTruthy();
    expect(screen.getByText('1 current')).toBeTruthy();
    expect(screen.getByText("Today's rate only — record a baseline.")).toBeTruthy();
    expect(screen.getByText('Truck AADT automated (not queued): MI, VA')).toBeTruthy();
    expect(document.getElementById('edge-pull-storage')).not.toBeNull();
  });

  it('hides write controls when the warehouse is not live', () => {
    renderQueue({ live: false });
    expect(screen.queryByRole('button', { name: /mark .* done/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
  });

  it('Mark done posts RecordPullRequest with the client header', async () => {
    renderQueue({ live: true });
    fireEvent.click(screen.getByRole('button', { name: 'Mark Columbus, OH done' }));
    fireEvent.change(screen.getByLabelText('Done on'), { target: { value: '2026-09-30' } });
    fireEvent.change(screen.getByLabelText('Note'), { target: { value: ' baseline $1.05/SF ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/warehouse/edge/pull-queue');
    expect(init?.method).toBe('POST');
    expect((init?.headers as Record<string, string>)['X-ORA-Client']).toBe('1');
    expect(JSON.parse(String(init?.body))).toEqual({ kind: 'storage', scopeKey: 'columbus', doneOn: '2026-09-30', note: 'baseline $1.05/SF' });
  });

  it('Undo asks for confirmation, then voids (never deletes)', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    renderQueue({ live: true });
    fireEvent.click(screen.getByRole('button', { name: 'Undo Richmond, VA' }));
    expect(fetch).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Undo Richmond, VA' }));
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    expect(confirm).toHaveBeenCalledTimes(2);
    const [url, init] = vi.mocked(fetch).mock.calls[0]!;
    expect(url).toBe('/api/warehouse/edge/pull-queue/7/void');
    expect(init?.method).toBe('POST');
  });

  it('503 → Warehouse offline — pull status unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'warehouse unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } })));
    renderQueue({ live: false, seed: false });
    expect(await screen.findByText('Warehouse offline — pull status unavailable')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/edge-pull-queue-ui.test.tsx`
Expected: FAIL — `Failed to resolve import "../../src/modules/acquisitions/EdgePullQueue"`.

- [ ] **Step 3: Write the component**

Create `src/modules/acquisitions/EdgePullQueue.tsx`:

```tsx
// src/modules/acquisitions/EdgePullQueue.tsx
//
// Oxford Edge manual-pull queue (spec §8.6). One card per pull kind; done-state is server-side in
// edge_pull_log (append-only), replacing the retired artifact's localStorage checkboxes (the
// oe-guide-* keys are NOT imported: per-browser and unverifiable). Write controls render only when
// useWarehouseLive() is true — the same fail-safe as Sourcing status writes. Undo voids a row after
// window.confirm; nothing is ever deleted.
import { useState } from 'react';
import type { EdgePullItem, EdgePullKind, EdgePullScopeState } from '@contracts/edge';
import { Card, CardHeader } from '@/primitives/Card';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge, type BadgeTone } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { isWarehouseUnavailable, useWarehouseLive } from '../intel/hooks';
import { localIsoToday, useEdgePullQueue, useRecordPull, useVoidPull } from './edge-hooks';

const STATE_TONE: Record<EdgePullScopeState['state'], BadgeTone> = { open: 'red', due: 'amber', current: 'green' };
const NOTE = { color: 'var(--text-tertiary)', fontSize: '0.875rem' } as const;
const BUTTON = {
  fontSize: '0.6875rem',
  padding: '0.125rem 0.5rem',
  border: '1px solid var(--border-strong)',
  borderRadius: '0.25rem',
  background: 'var(--surface-overlay)',
  color: 'var(--text-primary)',
} as const;

interface DraftPull {
  kind: EdgePullKind;
  scopeKey: string;
  scopeLabel: string;
  doneOn: string;
  note: string;
}

function PullItemCard({
  item, live, busy, draft, onMarkDone, onUndo, onDraftChange, onSave, onCancel,
}: {
  item: EdgePullItem;
  live: boolean;
  busy: boolean;
  draft: DraftPull | null;
  onMarkDone: (s: EdgePullScopeState) => void;
  onUndo: (s: EdgePullScopeState) => void;
  onDraftChange: (d: DraftPull) => void;
  onSave: () => void;
  onCancel: () => void;
}) {
  const editing = draft !== null && draft.kind === item.kind ? draft : null;
  const columns: Column<EdgePullScopeState>[] = [
    { key: 'scope', header: item.scopeType === 'market' ? 'Market' : 'State', render: (s) => s.scopeLabel },
    { key: 'status', header: 'Status', render: (s) => <Badge tone={STATE_TONE[s.state]}>{s.state}</Badge> },
    { key: 'last', header: 'Last done', render: (s) => s.lastDoneOn ?? '—' },
    { key: 'age', header: 'Age', align: 'right', render: (s) => (s.ageDays === null ? '—' : `${s.ageDays} d`) },
    {
      key: 'note',
      header: 'Note',
      render: (s) =>
        s.lastNote ? <span title={s.lastNote}>{s.lastNote.length > 48 ? `${s.lastNote.slice(0, 48)}…` : s.lastNote}</span> : '—',
    },
    {
      key: 'source',
      header: 'Source',
      render: (s) =>
        s.blocker ? (
          <span className="text-2xs" style={{ whiteSpace: 'normal', color: 'var(--text-secondary)', display: 'inline-block', maxWidth: '28rem' }}>
            {s.blocker}
          </span>
        ) : (
          <span className="flex gap-2">
            {s.links.map((l) => (
              <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="text-2xs" style={{ color: 'var(--text-accent)' }}>
                {l.label}
              </a>
            ))}
          </span>
        ),
    },
    ...(live
      ? [
          {
            key: 'actions',
            header: 'Actions',
            render: (s: EdgePullScopeState) => (
              <span className="flex gap-2">
                <button type="button" aria-label={`Mark ${s.scopeLabel} done`} disabled={busy} onClick={() => onMarkDone(s)} style={BUTTON}>
                  Mark done
                </button>
                {s.lastLogId !== null && (
                  <button type="button" aria-label={`Undo ${s.scopeLabel}`} disabled={busy} onClick={() => onUndo(s)} style={BUTTON}>
                    Undo
                  </button>
                )}
              </span>
            ),
          } satisfies Column<EdgePullScopeState>,
        ]
      : []),
  ];

  return (
    <Card>
      <div id={`edge-pull-${item.kind}`}>
        <CardHeader
          title={`${item.label} · ${item.cadenceLabel}`}
          trailing={
            <span className="flex gap-1.5">
              <Badge tone="red">{`${item.counts.open} open`}</Badge>
              <Badge tone="amber">{`${item.counts.due} due`}</Badge>
              <Badge tone="green">{`${item.counts.current} current`}</Badge>
            </span>
          }
        />
        <div className="flex flex-col gap-1 px-3 pt-2 text-xs" style={{ color: 'var(--text-secondary)' }}>
          <p><strong>Why it matters:</strong> {item.why}</p>
          <p style={{ color: 'var(--text-tertiary)' }}>{item.caveat}</p>
        </div>
        {editing && (
          <form
            className="mx-3 mt-2 flex flex-wrap items-end gap-2 rounded-[var(--radius-sm)] p-2"
            style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)' }}
            onSubmit={(e) => {
              e.preventDefault();
              onSave();
            }}
          >
            <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{`Mark ${editing.scopeLabel} done`}</span>
            <input
              type="date"
              aria-label="Done on"
              value={editing.doneOn}
              max={localIsoToday()}
              onChange={(e) => onDraftChange({ ...editing, doneOn: e.target.value })}
              style={BUTTON}
            />
            <textarea
              aria-label="Note"
              maxLength={2000}
              rows={1}
              value={editing.note}
              placeholder="Optional note (e.g. baseline $/SF)"
              onChange={(e) => onDraftChange({ ...editing, note: e.target.value })}
              style={{ ...BUTTON, minWidth: '16rem' }}
            />
            <button type="submit" disabled={busy || editing.doneOn === ''} style={BUTTON}>Save</button>
            <button type="button" onClick={onCancel} style={BUTTON}>Cancel</button>
          </form>
        )}
        <div className="p-3">
          <DataTable columns={columns} rows={item.scopes} getRowId={(s) => s.scopeKey} />
        </div>
      </div>
    </Card>
  );
}

export function EdgePullQueue() {
  const { data, isLoading, error } = useEdgePullQueue();
  const live = useWarehouseLive();
  const record = useRecordPull();
  const voidPull = useVoidPull();
  const [draft, setDraft] = useState<DraftPull | null>(null);

  if (isLoading) return <Skeleton className="h-40" />;
  if (isWarehouseUnavailable(error)) {
    return (
      <Card>
        <CardHeader title="Manual pull queue" />
        <p className="p-3" style={NOTE}>Warehouse offline — pull status unavailable</p>
      </Card>
    );
  }
  if (error || !data) {
    return (
      <Card>
        <CardHeader title="Manual pull queue" />
        <p className="p-3" style={NOTE}>{`Unable to load the pull queue: ${error instanceof Error ? error.message : 'unknown error'}`}</p>
      </Card>
    );
  }

  const undo = (scope: EdgePullScopeState) => {
    if (scope.lastLogId === null) return;
    if (!window.confirm(`Undo the ${scope.lastDoneOn ?? ''} pull for ${scope.scopeLabel}? The log row is voided, not deleted.`)) return;
    voidPull.mutate(scope.lastLogId);
  };
  const save = () => {
    if (!draft) return;
    const note = draft.note.trim();
    record.mutate(
      { kind: draft.kind, scopeKey: draft.scopeKey, doneOn: draft.doneOn, ...(note ? { note } : {}) },
      { onSuccess: () => setDraft(null) },
    );
  };
  const mutationError = record.error ?? voidPull.error;

  return (
    <section className="flex flex-col gap-3">
      <h3 className="num text-2xs font-semibold uppercase" style={{ letterSpacing: '0.14em', color: 'var(--text-secondary)' }}>
        Manual pull queue
      </h3>
      {data.automatedCoverage.truck.length > 0 && (
        <p className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          {`Truck AADT automated (not queued): ${data.automatedCoverage.truck.join(', ')}`}
        </p>
      )}
      {mutationError && (
        <p role="alert" className="text-xs" style={{ color: 'var(--text-neg)' }}>{mutationError.message}</p>
      )}
      {data.items.map((item) => (
        <PullItemCard
          key={item.kind}
          item={item}
          live={live}
          busy={record.isPending || voidPull.isPending}
          draft={draft}
          onMarkDone={(s) => setDraft({ kind: item.kind, scopeKey: s.scopeKey, scopeLabel: s.scopeLabel, doneOn: localIsoToday(), note: '' })}
          onUndo={undo}
          onDraftChange={setDraft}
          onSave={save}
          onCancel={() => setDraft(null)}
        />
      ))}
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/edge-pull-queue-ui.test.tsx && npm run typecheck && npx eslint src/modules/acquisitions/EdgePullQueue.tsx --max-warnings 0`
Expected: 5 tests PASS; typecheck 0; eslint 0.

- [ ] **Step 5: Commit**

```bash
git add src/modules/acquisitions/EdgePullQueue.tsx tests/unit/edge-pull-queue-ui.test.tsx
git commit -F - <<'EOF'
feat(acquisitions): Oxford Edge manual-pull queue UI (server-side done-state, void-not-delete)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 12: Tab body `EdgeView.tsx` + deal readout `EdgeMarketReadout.tsx`

**Files:**
- Create: `src/modules/acquisitions/EdgeView.tsx`, `src/modules/acquisitions/EdgeMarketReadout.tsx`
- Test: `tests/unit/edge-view.test.tsx`

**Interfaces:**
- Consumes: `EdgeRankingBoard` (Task 10), `EdgePullQueue` (Task 11), Task 8/9 hooks + helpers, `useUi` (`src/brain/ui-context.ts`), `KpiStat`, `fmtNum` (`@analytics/index`).
- Produces:
  - `EdgeView({ board: EdgeBoardState; onBoardChange: (next: EdgeBoardState) => void })`
  - `EdgeMarketReadout({ deal: Pick<Deal, 'market' | 'location'>; onNavigate?: () => void })` — in its own file so `DealDrawer` (shell bundle) imports only the readout and the pure helpers, not the board/queue. (Spec §8.4 places it "exported from EdgeView.tsx"; a re-export from a component file risks a `react-refresh/only-export-components` lint warning under `--max-warnings 0`, so the drawer imports `EdgeMarketReadout.tsx` directly.)

- [ ] **Step 1: Write the failing test**

Create `tests/unit/edge-view.test.tsx`:

```tsx
// tests/unit/edge-view.test.tsx — spec §8.2 banner + error/empty states, §8.5 data health, readout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EdgeMarketsResponse } from '@contracts/edge';
import { EdgeView } from '../../src/modules/acquisitions/EdgeView';
import { EdgeMarketReadout } from '../../src/modules/acquisitions/EdgeMarketReadout';
import { EDGE_BOARD_DEFAULT_STATE, EDGE_KEYS } from '../../src/modules/acquisitions/edge-hooks';
import { fourMarkets, mkMarketsResponse } from './edge-test-helpers';

function client(markets?: EdgeMarketsResponse): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  if (markets) qc.setQueryData(EDGE_KEYS.markets, markets);
  return qc;
}
function renderView(markets?: EdgeMarketsResponse) {
  return render(
    <QueryClientProvider client={client(markets)}>
      <EdgeView board={EDGE_BOARD_DEFAULT_STATE} onBoardChange={() => {}} />
    </QueryClientProvider>,
  );
}
const empty = (availability: EdgeMarketsResponse['availability'], issues: string[] = []) =>
  mkMarketsResponse([], { availability, issues, freshness: null, coverage: [], marketCount: 0, dir: 'C:/edge/output' });

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'warehouse unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('EdgeView', () => {
  it('F1: STALE banner with the exact firm-rule copy', () => {
    renderView(mkMarketsResponse(fourMarkets()));
    expect(screen.getByText('STALE')).toBeTruthy();
    expect(screen.getByText('Edge dataset as of 2026-07-14 — 80 days old. Firm rule: a mirror more than 7 days behind is never presented as current.')).toBeTruthy();
  });

  it('fresh data shows a neutral As of badge', () => {
    const data = mkMarketsResponse(fourMarkets());
    renderView({ ...data, freshness: { ...data.freshness!, stale: false, ageDays: 1, asOf: '2026-10-01' } });
    expect(screen.getByText('As of 2026-10-01')).toBeTruthy();
    expect(screen.queryByText('STALE')).toBeNull();
  });

  it('readError → red last-good line', () => {
    renderView(mkMarketsResponse(fourMarkets(), { readError: 'EBUSY: simulated', lastGoodLoadedAt: '2026-10-02T12:00:00.000Z' }));
    expect(screen.getByText('Last re-read failed (EBUSY: simulated); showing the copy loaded at 2026-10-02T12:00:00.000Z.')).toBeTruthy();
  });

  it('missing → names the dir and the env var', () => {
    renderView(empty('missing'));
    expect(screen.getByText('markets.json not found at C:/edge/output. Set OXFORD_EDGE_DIR in .env on this machine.')).toBeTruthy();
    expect(screen.queryByText('Market board')).toBeNull();
  });

  it('unreadable → OneDrive hint with the error', () => {
    renderView(empty('unreadable', ['EBUSY: resource busy']));
    expect(screen.getByText('markets.json could not be read (OneDrive lock or sync in progress?): EBUSY: resource busy. Retrying on next load.')).toBeTruthy();
  });

  it('invalid → schema message plus the first 5 issues', () => {
    renderView(empty('invalid', ['meta.fieldMeta: Required', 'b', 'c', 'd', 'e', 'f']));
    expect(screen.getByText('markets.json failed schema validation — the upstream file changed shape.')).toBeTruthy();
    expect(screen.getByText('meta.fieldMeta: Required')).toBeTruthy();
    expect(screen.getByText('e')).toBeTruthy();
    expect(screen.queryByText('f')).toBeNull();
  });

  it('rejected markets → amber note, valid markets still render', () => {
    renderView(mkMarketsResponse(fourMarkets(), { rejectedMarkets: [{ id: 'broken', reason: 'pop: Required' }] }));
    expect(screen.getByText('Rejected from markets.json: broken — pop: Required')).toBeTruthy();
    expect(screen.getByText('Market board')).toBeTruthy();
  });

  it('WarehouseUnavailableError (mirror / server down) → local-only message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    renderView();
    expect(await screen.findByText('Edge is local-only — start the Brain Server on the workstation.')).toBeTruthy();
  });

  it('pull-queue 503: board and data health still render; queue says warehouse offline', async () => {
    renderView(mkMarketsResponse(fourMarkets()));
    expect(screen.getByText('Market board')).toBeTruthy();
    expect(screen.getByText('Data health')).toBeTruthy();
    expect(await screen.findByText('Warehouse offline — pull status unavailable')).toBeTruthy();
  });

  it('data health: proxy badges, manual-pull links, subs line, out-of-scope states', () => {
    renderView(mkMarketsResponse(fourMarkets(), { outsidePullScope: { truck: ['DC', 'ND', 'SD', 'TN'], mfgInvest: ['DC', 'ND', 'SD', 'TN'] } }));
    expect(screen.getAllByText('[PROXY]')).toHaveLength(3);
    const links = screen.getAllByRole('link', { name: 'Manual pull required' }).map((a) => a.getAttribute('href'));
    expect(links.sort()).toEqual(['#edge-pull-ios', '#edge-pull-mfgInvest', '#edge-pull-storage']);
    expect(screen.getByText('3/4 markets — 1 metro-only markets have no CoStar submarket breakdown (permanent).')).toBeTruthy();
    expect(screen.getByText('Outside pull scope — truck: DC, ND, SD, TN · mfgInvest: DC, ND, SD, TN')).toBeTruthy();
  });
});

describe('EdgeMarketReadout', () => {
  function renderReadout(deal: { market: 'Columbus OH' | null; location: string | null }, markets?: EdgeMarketsResponse) {
    return render(<QueryClientProvider client={client(markets)}><EdgeMarketReadout deal={deal} /></QueryClientProvider>);
  }

  it('matched deal → four values, STALE badge next to the numbers, View in Edge', () => {
    renderReadout({ market: 'Columbus OH', location: 'Columbus, OH' }, mkMarketsResponse(fourMarkets()));
    expect(screen.getByText('Flex vacancy')).toBeTruthy();
    expect(screen.getByText('3.0%')).toBeTruthy();
    expect(screen.getByText('+1.8%')).toBeTruthy();
    expect(screen.getByText('180 kSF')).toBeTruthy();
    expect(screen.getByText('+4.0%')).toBeTruthy();
    expect(screen.getByText('STALE')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View in Edge' })).toBeTruthy();
  });

  it('TBD deal → No Edge market + reason', () => {
    renderReadout({ market: null, location: 'TBD' }, mkMarketsResponse(fourMarkets()));
    expect(screen.getByText('No Edge market')).toBeTruthy();
    expect(screen.getByText('no parseable "City, ST" in the deal location')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/edge-view.test.tsx`
Expected: FAIL — `Failed to resolve import "../../src/modules/acquisitions/EdgeView"`.

- [ ] **Step 3: Write the readout and the view**

Create `src/modules/acquisitions/EdgeMarketReadout.tsx`:

```tsx
// src/modules/acquisitions/EdgeMarketReadout.tsx
//
// Deal-level Oxford Edge readout (spec §8.4) for the DealDrawer "Edge Market" card. Its own file so
// the drawer (shell bundle) imports only this component plus the pure edge-hooks helpers, never the
// board or queue. Resolution is client-side against markets already fetched: no deal identity is
// sent to /api/warehouse/edge/* (spec §5.4). Confidential deals get a readout too — internal UI,
// public-source market data. Stale data always shows the STALE badge next to the numbers.
import type { Deal } from '@contracts/index';
import { SERIES_UNITS } from '@contracts/edge';
import { Badge } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { useUi } from '@/brain/ui-context';
import { isWarehouseUnavailable } from '../intel/hooks';
import { EDGE_READOUT_SERIES, EDGE_UNMATCHED_TEXT, edgeCellDisplay, resolveEdgeMarket, useEdgeMarkets } from './edge-hooks';

const TERTIARY = { color: 'var(--text-tertiary)' } as const;

export function EdgeMarketReadout({ deal, onNavigate }: { deal: Pick<Deal, 'market' | 'location'>; onNavigate?: () => void }) {
  const ui = useUi();
  const { data, isLoading, error } = useEdgeMarkets();

  if (isLoading) return <Skeleton className="h-16" />;
  if (isWarehouseUnavailable(error)) {
    return <p className="text-2xs" style={TERTIARY}>Edge is local-only — start the Brain Server on the workstation.</p>;
  }
  if (error || !data) {
    return <p className="text-2xs" style={TERTIARY}>{`Edge unavailable${error instanceof Error ? `: ${error.message}` : ''}.`}</p>;
  }
  if (data.availability !== 'ok') {
    return <p className="text-2xs" style={TERTIARY}>{`Edge dataset ${data.availability} — open Acquisitions › Edge for detail.`}</p>;
  }

  const viewInEdge = (
    <button
      type="button"
      onClick={() => {
        ui.openTab('pipeline', 'edge');
        onNavigate?.();
      }}
      className="text-2xs font-semibold"
      style={{ color: 'var(--text-accent)' }}
    >
      View in Edge
    </button>
  );

  const res = resolveEdgeMarket(deal, data.markets);
  if (res.kind === 'unmatched') {
    return (
      <div className="flex flex-col gap-1">
        <span className="text-xs" style={{ color: 'var(--text-primary)' }}>No Edge market</span>
        <span className="text-2xs" style={TERTIARY}>{EDGE_UNMATCHED_TEXT[res.reason]}</span>
        <div>{viewInEdge}</div>
      </div>
    );
  }

  const { market } = res;
  const fresh = data.freshness;
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center justify-between gap-2 pb-1">
        <span className="text-xs font-semibold" style={{ color: 'var(--text-primary)' }}>{`${market.name}, ${market.state}`}</span>
        {fresh && (
          <span className="flex items-center gap-1.5">
            {fresh.stale ? <Badge tone="amber">STALE</Badge> : <Badge tone="neutral">{`As of ${fresh.asOf}`}</Badge>}
            {fresh.stale && <span className="num text-2xs" style={TERTIARY}>{`as of ${fresh.asOf}`}</span>}
          </span>
        )}
      </div>
      {EDGE_READOUT_SERIES.map(({ field, label }) => {
        const d = edgeCellDisplay(market.series[field], SERIES_UNITS[field], data.years, field);
        return (
          <div
            key={field}
            className="flex items-center justify-between gap-3 py-1"
            style={{ borderTop: '1px solid color-mix(in oklab, var(--border-subtle) 60%, transparent)' }}
          >
            <span className="text-2xs uppercase" style={{ letterSpacing: '0.06em', color: 'var(--text-tertiary)' }}>{label}</span>
            <span
              className="num text-right text-xs"
              title={d.title ?? undefined}
              style={
                d.dotted
                  ? { color: 'var(--text-primary)', borderBottom: '1px dotted var(--text-tertiary)' }
                  : { color: d.observed ? 'var(--text-primary)' : 'var(--text-tertiary)' }
              }
            >
              {d.text}
            </span>
          </div>
        );
      })}
      <div className="pt-1">{viewInEdge}</div>
    </div>
  );
}
```

Create `src/modules/acquisitions/EdgeView.tsx`:

```tsx
// src/modules/acquisitions/EdgeView.tsx
//
// Acquisitions › Edge tab body (spec §8.2). Top to bottom: freshness banner, KPI strip, market board,
// data health, manual-pull queue. Lazy-mounted (no FORCE_MOUNT_PANEL): it fetches markets.json via
// the Brain Server and the pull queue from the warehouse. Each non-ok availability state replaces the
// board, health and queue bodies; the pull queue degrades on its own (503) while board + health stay.
import { fmtNum } from '@analytics/index';
import { SERIES_UNITS, type EdgeCoverageRow, type EdgeMarketsResponse, type EdgeUnit } from '@contracts/edge';
import { Card, CardHeader } from '@/primitives/Card';
import { KpiStat } from '@/primitives/KpiStat';
import { DataTable, type Column } from '@/primitives/DataTable';
import { Badge } from '@/primitives/Badge';
import { Skeleton } from '@/primitives/Skeleton';
import { isWarehouseUnavailable } from '../intel/hooks';
import { EdgeRankingBoard } from './EdgeRankingBoard';
import { EdgePullQueue } from './EdgePullQueue';
import { EDGE_PULL_SERIES, filterEdgeMarkets, useEdgeMarkets, useEdgePullQueue, type EdgeBoardState } from './edge-hooks';

const HEADING = { fontFamily: 'var(--font-display)', fontSize: '1.125rem', color: 'var(--text-primary)' } as const;
const NOTE = { color: 'var(--text-tertiary)', fontSize: '0.875rem' } as const;
const AMBER_BOX = {
  background: 'var(--color-warn-soft)',
  border: '1px solid var(--color-warn)',
  borderRadius: '0.375rem',
  padding: '0.625rem 0.875rem',
  fontSize: '0.8125rem',
  color: 'var(--text-warn)',
} as const;

const UNIT_LABEL: Record<EdgeUnit, string> = {
  pct_yoy: '% YoY',
  pct_level: '% level',
  ksf: 'kSF',
  per_10k: 'per 10k pop',
  usd: '$',
  persons: 'net persons',
  signal: 'signal (no unit)',
};

function EdgeFreshnessBanner({ data }: { data: EdgeMarketsResponse }) {
  const f = data.freshness;
  if (!f) return null;
  return (
    <div role="status" className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        {f.stale ? (
          <>
            <Badge tone="amber">STALE</Badge>
            <span className="text-xs" style={{ color: 'var(--text-warn)' }}>
              {`Edge dataset as of ${f.asOf} — ${f.ageDays} days old. Firm rule: a mirror more than ${f.staleAfterDays} days behind is never presented as current.`}
            </span>
          </>
        ) : (
          <Badge tone="neutral">{`As of ${f.asOf}`}</Badge>
        )}
      </div>
      {data.readError && (
        <p className="text-xs" style={{ color: 'var(--text-neg)' }}>
          {`Last re-read failed (${data.readError}); showing the copy loaded at ${data.lastGoodLoadedAt ?? 'an earlier load'}.`}
        </p>
      )}
    </div>
  );
}

function CoverageBars({ byYear, markets }: { byYear: number[]; markets: number }) {
  return (
    <span className="inline-flex items-end gap-0.5" aria-hidden style={{ height: 16 }}>
      {byYear.map((n, i) => (
        <span
          key={i}
          style={{
            width: 5,
            height: markets === 0 ? 1 : Math.max(1, Math.round((n / markets) * 16)),
            background: n === 0 ? 'var(--border-strong)' : 'var(--accent)',
          }}
        />
      ))}
    </span>
  );
}

function EdgeDataHealth({ data }: { data: EdgeMarketsResponse }) {
  const withSubs = data.markets.filter((m) => m.subs.length > 0).length;
  const columns: Column<EdgeCoverageRow>[] = [
    {
      key: 'label',
      header: 'Series',
      render: (r) => (
        <span className="flex items-center gap-1.5">
          <span>{data.fieldMeta[r.field]?.trueLabel ?? 'Unlabelled series'}</span>
          {data.fieldMeta[r.field]?.isProxy && <Badge tone="purple">[PROXY]</Badge>}
          {r.allPlaceholder && EDGE_PULL_SERIES.has(r.field) && (
            <a href={`#edge-pull-${r.field}`} aria-label="Manual pull required">
              <Badge tone="amber">Manual pull required</Badge>
            </a>
          )}
          {r.inconsistent.length > 0 && <Badge tone="amber">{`${r.inconsistent.length} inconsistent`}</Badge>}
        </span>
      ),
    },
    { key: 'unit', header: 'Unit', render: (r) => UNIT_LABEL[SERIES_UNITS[r.field]] },
    { key: 'coverage', header: 'Coverage', align: 'right', render: (r) => `${(r.pct * 100).toFixed(0)}% (${r.filled}/${r.total})` },
    { key: 'byYear', header: 'By year', render: (r) => <CoverageBars byYear={r.byYear} markets={data.marketCount} /> },
    {
      key: 'mix',
      header: 'Status mix',
      render: (r) => (
        <span className="num text-2xs">
          {`A ${r.statusCounts.actual} · E ${r.statusCounts.estimated} · N ${r.statusCounts.nowcast} · G ${r.statusCounts.guide_only} · — ${r.statusCounts.null}`}
        </span>
      ),
    },
    {
      key: 'sources',
      header: 'Source codes',
      render: (r) => (
        <span className="text-2xs" style={{ fontFamily: 'var(--font-mono)' }}>
          {(data.sources[r.field] ?? []).join(', ') || '—'}
        </span>
      ),
    },
  ];
  const outside = data.outsidePullScope;
  return (
    <Card>
      <CardHeader title="Data health" />
      <div className="p-3">
        <DataTable columns={columns} rows={data.coverage} getRowId={(r) => r.field} minWidth={960} />
      </div>
      <div className="flex flex-col gap-1 px-3 pb-3 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
        <p>{`${withSubs}/${data.marketCount} markets — ${data.marketCount - withSubs} metro-only markets have no CoStar submarket breakdown (permanent).`}</p>
        <p>{`Outside pull scope — truck: ${outside.truck.join(', ') || 'none'} · mfgInvest: ${outside.mfgInvest.join(', ') || 'none'}`}</p>
      </div>
    </Card>
  );
}

function EdgeBody({
  data, openPulls, board, onBoardChange,
}: {
  data: EdgeMarketsResponse;
  openPulls: number | null;
  board: EdgeBoardState;
  onBoardChange: (next: EdgeBoardState) => void;
}) {
  if (data.availability === 'missing') {
    return <p style={NOTE}>{`markets.json not found at ${data.dir}. Set OXFORD_EDGE_DIR in .env on this machine.`}</p>;
  }
  if (data.availability === 'unreadable') {
    return (
      <p style={NOTE}>
        {`markets.json could not be read (OneDrive lock or sync in progress?): ${data.issues[0] ?? 'unknown error'}. Retrying on next load.`}
      </p>
    );
  }
  if (data.availability === 'invalid') {
    return (
      <div role="alert" className="flex flex-col gap-1" style={AMBER_BOX}>
        <p>markets.json failed schema validation — the upstream file changed shape.</p>
        <ul className="list-disc pl-5">
          {data.issues.slice(0, 5).map((issue) => <li key={issue}><code>{issue}</code></li>)}
        </ul>
      </div>
    );
  }

  const buyBox = filterEdgeMarkets(data.markets, 'buybox').length;
  const fullyReal = data.coverage.filter((r) => r.pct === 1).length;
  return (
    <>
      <EdgeFreshnessBanner data={data} />
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        <KpiStat label="Markets loaded" value={data.marketCount} format={fmtNum} accentColor="var(--accent)" />
        <KpiStat label="Buy-box markets" value={buyBox} format={fmtNum} accentColor="var(--color-info)" />
        <KpiStat label="Series fully real" value={fullyReal} format={fmtNum} sublabel={`of ${data.coverage.length}`} accentColor="var(--color-pos)" />
        <KpiStat
          label="Open manual pulls"
          value={openPulls}
          format={fmtNum}
          sublabel={openPulls === null ? 'queue unavailable' : 'across the 4 manual pulls'}
          accentColor="var(--color-neg)"
        />
      </div>
      {data.rejectedMarkets.length > 0 && (
        <div role="alert" style={AMBER_BOX}>
          {data.rejectedMarkets.map((r) => (
            <p key={`${r.id ?? 'no-id'}-${r.reason}`}>{`Rejected from markets.json: ${r.id ?? '(no id)'} — ${r.reason}`}</p>
          ))}
        </div>
      )}
      <EdgeRankingBoard data={data} board={board} onBoardChange={onBoardChange} />
      <EdgeDataHealth data={data} />
      <EdgePullQueue />
    </>
  );
}

export function EdgeView({ board, onBoardChange }: { board: EdgeBoardState; onBoardChange: (next: EdgeBoardState) => void }) {
  const { data, isLoading, error } = useEdgeMarkets();
  const queue = useEdgePullQueue();
  const openPulls = queue.data ? queue.data.items.reduce((sum, item) => sum + item.counts.open, 0) : null;

  return (
    <section className="flex flex-col gap-4">
      <h2 style={HEADING}>Oxford Edge</h2>
      {isLoading ? (
        <Skeleton className="h-40" />
      ) : isWarehouseUnavailable(error) ? (
        <p style={NOTE}>Edge is local-only — start the Brain Server on the workstation.</p>
      ) : error || !data ? (
        <p style={NOTE}>{`Unable to load Edge: ${error instanceof Error ? error.message : 'unknown error'}`}</p>
      ) : (
        <EdgeBody data={data} openPulls={openPulls} board={board} onBoardChange={onBoardChange} />
      )}
    </section>
  );
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/unit/edge-view.test.tsx && npm run typecheck && npx eslint src/modules/acquisitions/EdgeView.tsx src/modules/acquisitions/EdgeMarketReadout.tsx --max-warnings 0`
Expected: 12 tests PASS; typecheck 0; eslint 0.

- [ ] **Step 5: Commit**

```bash
git add src/modules/acquisitions/EdgeView.tsx src/modules/acquisitions/EdgeMarketReadout.tsx tests/unit/edge-view.test.tsx
git commit -F - <<'EOF'
feat(acquisitions): Oxford Edge tab body (freshness banner, KPIs, data health, states) + deal readout

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 13: Tab registration (`tabs.ts`, `AcquisitionsModule.tsx`) + registry/palette tests

**Files:**
- Modify: `src/modules/acquisitions/tabs.ts:7` and `:13-14`
- Modify: `src/modules/acquisitions/AcquisitionsModule.tsx:1`, `:20`, `:53`, `:217-269`
- Modify: `src/modules/acquisitions/AcquisitionsIntel.tsx:36`, `:100-104`
- Modify: `src/modules/acquisitions/RankedCandidateList.tsx:72-79` (prop only; the column lands in Task 14)
- Test (modify): `tests/unit/acquisitions-tabs.test.tsx`, `tests/unit/ia-registry.test.ts:312`, `tests/unit/palette-tabs.test.tsx:44`

**Interfaces:**
- Consumes: `EdgeView` (Task 12), `EDGE_BOARD_DEFAULT_STATE`, `EdgeBoardState` (Task 8).
- Produces: `AcqTab` includes `'edge'`; `AcquisitionsIntel({ edgeEnabled?: boolean })`; `RankedCandidateList` prop `edgeEnabled?: boolean` (default `false`); sticky `edgeArmed` flag in `AcquisitionsModule`.

- [ ] **Step 1: Update the tests first (they must fail)**

In `tests/unit/acquisitions-tabs.test.tsx`:

Replace the header comment lines 3–5 with:

```ts
// IA decongestion Phase 3 — the Pipeline tab is split: Pipeline · Workbench · Sourcing · Grader, plus
// Oxford Edge (2026-10-02 spec §8.1) as the fifth tab. KPI strip + sync toolbar stay above the strip
// (R2). Pipeline / Workbench / Sourcing are force-mounted (state survives a tab round-trip); Grader
// and Edge stay lazy (each fires its own queries), and Acquisitions on ?tab=pipeline fires no /edge/
// request (spec F11).
```

Change the import line to add `waitFor`:

```ts
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
```

Replace the first test (lines 49–55) with:

```tsx
  it('renders five tabs, Pipeline selected by default, with stage bars + Active Deals visible', () => {
    renderAcq();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Pipeline', 'Workbench', 'Sourcing', 'Grader', 'Edge']);
    expect(tabIsSelected('Pipeline')).toBe(true);
    expect(isInInactivePanel(screen.getByText('Pipeline by Stage'))).toBe(false);
    expect(isInInactivePanel(screen.getByText('Est. Price'))).toBe(false); // Active Deals table header
  });
```

After the "Grader stays lazy" test add:

```tsx
  it('Edge stays lazy: its content is not rendered until the tab is selected', () => {
    renderAcq();
    expect(screen.queryByText('Oxford Edge')).toBeNull();
    selectTab('Edge');
    expect(screen.getByText('Oxford Edge')).toBeTruthy();
  });

  it('F11: Acquisitions on ?tab=pipeline fires no /edge/ request', async () => {
    renderAcq('/?tab=pipeline');
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const urls = vi.mocked(fetch).mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes('/edge/'))).toBe(false);
  });

  it('selecting Edge fetches the markets endpoint', async () => {
    renderAcq();
    selectTab('Edge');
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes('/api/warehouse/edge/markets'))).toBe(true),
    );
  });
```

In the `it.each` deep-link table add a row after `['grader', 'Grade an Acquisition'],`:

```tsx
    ['edge', 'Oxford Edge'],
```

In `tests/unit/ia-registry.test.ts` line 312 change:

```ts
    pipeline: ['pipeline', 'workbench', 'sourcing', 'grader', 'edge'],
```

In `tests/unit/palette-tabs.test.tsx` line 44 change the list to include the Edge entry:

```tsx
    for (const label of ['Acquisitions › Workbench', 'Acquisitions › Sourcing', 'Acquisitions › Grader', 'Acquisitions › Edge',
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/unit/acquisitions-tabs.test.tsx tests/unit/ia-registry.test.ts tests/unit/palette-tabs.test.tsx`
Expected: FAIL — tab list `['Pipeline','Workbench','Sourcing','Grader']` ≠ expected five; `Unable to find role="tab" and name "Edge"`; `pipeline declares [...]` mismatch; `Unable to find an element with the text: Acquisitions › Edge`.

- [ ] **Step 3: Register the tab and wire the module**

`src/modules/acquisitions/tabs.ts` — line 7 becomes:

```ts
export type AcqTab = 'pipeline' | 'workbench' | 'sourcing' | 'grader' | 'edge';
```

and lines 13–14 become:

```ts
  { id: 'grader', label: 'Grader', aliases: ['deal grader', 'grade a deal', 'score a deal'] },
  // Oxford Edge (2026-10-02 spec §8.1). This brings Acquisitions to exactly MAX_TABS_PER_DESTINATION
  // (5, src/shell/tab-types.ts) — any later tab needs an IA decision. No useBadge: a STALE badge would
  // add an eager query on every Acquisitions load; staleness is shown inside the tab.
  { id: 'edge', label: 'Edge', aliases: ['oxford edge', 'market board', 'markets', 'pull queue', 'data health'] },
];
```

`src/modules/acquisitions/AcquisitionsModule.tsx`:

Line 1 becomes:

```ts
import { useEffect, useState } from 'react';
```

After line 20 (`import { PipelineTierBoard } from './PipelineTierBoard';`) add:

```ts
import { EdgeView } from './EdgeView';
import { EDGE_BOARD_DEFAULT_STATE, type EdgeBoardState } from './edge-hooks';
```

After line 53 (`const acqTabSpecs = useTabSpecs(ACQUISITIONS_TABS);`) add:

```ts
  // Oxford Edge (spec §8.1/§8.4). The board's sort/filter state lives here, like scoreDealId, so it
  // survives a tab round-trip without force-mounting the Edge panel. edgeArmed is STICKY: it flips
  // true the first time Sourcing or Edge is selected (or deep-linked) and gates the force-mounted
  // Sourcing list's Edge column query, so loading Acquisitions on Pipeline fires no /edge/ request (F11).
  const [edgeBoard, setEdgeBoard] = useState<EdgeBoardState>(EDGE_BOARD_DEFAULT_STATE);
  const [edgeArmed, setEdgeArmed] = useState<boolean>(acqTab === 'sourcing' || acqTab === 'edge');
  useEffect(() => {
    if (acqTab === 'sourcing' || acqTab === 'edge') setEdgeArmed(true);
  }, [acqTab]);
```

Replace the comment block at lines 217–221 with:

```tsx
      {/* keyboardActivation="manual" — the Grader tab mounts PipelineTierBoard, which fires a
          fresh useAcqIntel() warehouse query on mount, and the Edge tab fetches markets.json + the
          pull queue on mount, so arrowing through the strip shouldn't fan out queries (plan R9).
          The pipeline / workbench / sourcing panels are force-mounted (they all mounted together
          before the split), so the Workbench form draft, the prefill selection, the Sourcing filters
          and the Active Deals sort survive a tab round-trip. Grader and Edge stay lazy. */}
```

Replace the Sourcing panel (around line 260–262):

```tsx
        <TabPanel id="sourcing" {...FORCE_MOUNT_PANEL}>
          <AcquisitionsIntel edgeEnabled={edgeArmed} />
        </TabPanel>
```

Insert after the Grader `</TabPanel>` and before `</Tabs>` (line 269):

```tsx
        <TabPanel id="edge">
          <EdgeView board={edgeBoard} onBoardChange={setEdgeBoard} />
        </TabPanel>
```

`src/modules/acquisitions/AcquisitionsIntel.tsx` — line 36 becomes:

```tsx
export function AcquisitionsIntel({ edgeEnabled = false }: { edgeEnabled?: boolean } = {}) {
```

and the `<RankedCandidateList ... />` call (lines 100–104) becomes:

```tsx
          <RankedCandidateList
            items={data.rankedCandidates}
            advisoryOnly={data.advisoryOnly}
            writesEnabled={writesEnabled}
            edgeEnabled={edgeEnabled}
          />
```

`src/modules/acquisitions/RankedCandidateList.tsx` — lines 72–76 (the `Props` type) become (the function signature is NOT changed here; Task 14 destructures the prop when it consumes it, so this task stays lint-clean and every commit typechecks):

```tsx
type Props = {
  items: RankedCandidate[];
  advisoryOnly: boolean;
  writesEnabled: boolean;
  /** Gate for the Edge column's markets query: this list lives in the force-mounted Sourcing panel,
   *  so the query fires only once AcquisitionsModule's sticky edgeArmed flag is set (spec F11). */
  edgeEnabled?: boolean;
};
```

- [ ] **Step 4: Run tests to verify they pass**

Run:
```bash
npx vitest run tests/unit/acquisitions-tabs.test.tsx tests/unit/ia-registry.test.ts tests/unit/palette-tabs.test.tsx
npm run typecheck
npx eslint src/modules/acquisitions/tabs.ts src/modules/acquisitions/AcquisitionsModule.tsx src/modules/acquisitions/AcquisitionsIntel.tsx src/modules/acquisitions/RankedCandidateList.tsx --max-warnings 0
```
Expected: all PASS; typecheck 0; eslint 0.

- [ ] **Step 5: Commit**

```bash
git add src/modules/acquisitions/tabs.ts src/modules/acquisitions/AcquisitionsModule.tsx src/modules/acquisitions/AcquisitionsIntel.tsx src/modules/acquisitions/RankedCandidateList.tsx tests/unit/acquisitions-tabs.test.tsx tests/unit/ia-registry.test.ts tests/unit/palette-tabs.test.tsx
git commit -F - <<'EOF'
feat(acquisitions): register lazy Edge tab (5th of 5) with lifted board state + sticky query gate

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 14: Deal overlay — Sourcing Edge column + DealDrawer "Edge Market" card

**Files:**
- Modify: `src/modules/acquisitions/RankedCandidateList.tsx:8-12` (imports), the `export function RankedCandidateList` line + the line after it (signature + hooks), after the `market` column (column)
- Modify: `src/brain/DealDrawer.tsx:13` (import), after `:127` (card)
- Test: `tests/unit/edge-overlay.test.tsx`

**Interfaces:**
- Consumes: `useEdgeMarkets`, `edgeCandidateCell`, `EdgeQueryState` (Tasks 8–9); `EdgeMarketReadout` (Task 12); `useSnapshot`.
- Produces: `RankedCandidateList` Edge column (key `'edge'`); DealDrawer `CardBox title="Edge Market"`.

- [ ] **Step 1: Write the failing test**

Create `tests/unit/edge-overlay.test.tsx`:

```tsx
// tests/unit/edge-overlay.test.tsx — spec §8.4 surfaces: DealDrawer "Edge Market" card and the
// Sourcing list's Edge column; confidential deals get a readout and no deal identity reaches /edge/.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Deal, PortfolioSnapshot } from '@contracts/index';
import type { AcqCandidateRow, RankedCandidate } from '@contracts/acquisition';
import { DealDrawer } from '../../src/brain/DealDrawer';
import { RankedCandidateList } from '../../src/modules/acquisitions/RankedCandidateList';
import { fourMarkets, mkMarketsResponse } from './edge-test-helpers';

function makeDeal(p: Partial<Deal> & Pick<Deal, 'id'>): Deal {
  return {
    name: 'Fixture Deal', shortName: null, location: null, market: null, sf: null, buildings: null, stage: 'Candidate',
    estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null, lender: null, status: null, nextAction: null,
    owner: null, targetCloseDate: null, notionDealId: null, confidential: false, estimatedFields: [], ...p,
  };
}
function makeCandidate(p: Partial<AcqCandidateRow> & Pick<AcqCandidateRow, 'id'>): RankedCandidate {
  return {
    candidate: {
      source: 'notion-pipeline', sourceBatchId: null, address: '100 Fixture Ave', county: null, state: null, market: 'established',
      rentableSf: null, yearBuilt: null, ownerName: null, parcelScreenScore: null, status: 'active', notionDealId: null,
      createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z', ...p,
    },
    latestScore: null, governorDscrCleared: null, governorLtvCleared: null, calibrationHitRate: null, scoredAt: null,
  };
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/api/warehouse/edge/markets')) return json(mkMarketsResponse(fourMarkets()));
    return new Response('{}', { status: 500 });
  }));
}
const edgeCalls = () => vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes('/edge/'));

function renderDrawer(deal: Deal) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const snapshot = { deals: [deal], dealComps: {}, acquisitionInputs: {} } as unknown as PortfolioSnapshot;
  return render(
    <QueryClientProvider client={qc}>
      <DealDrawer dealId={deal.id} snapshot={snapshot} canWrite={false} onClose={() => {}} onDraft={() => {}} onAdvanceStage={() => {}} />
    </QueryClientProvider>,
  );
}
function renderList(items: RankedCandidate[], deals: Deal[], edgeEnabled: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(['snapshot'], { snapshot: { deals, governors: null } as never, state: {} as never });
  return render(
    <QueryClientProvider client={qc}>
      <RankedCandidateList items={items} advisoryOnly={false} writesEnabled={false} edgeEnabled={edgeEnabled} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  stubFetch();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('DealDrawer — Edge Market card', () => {
  it('Columbus OH deal → readout with STALE badge', async () => {
    renderDrawer(makeDeal({ id: 'd1', market: 'Columbus OH', location: 'Columbus, OH' }));
    expect(screen.getByText('Edge Market')).toBeTruthy();
    expect(await screen.findByText('Flex vacancy')).toBeTruthy();
    expect(screen.getByText('3.0%')).toBeTruthy();
    expect(screen.getByText('STALE')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View in Edge' })).toBeTruthy();
  });

  it('TBD deal → No Edge market', async () => {
    renderDrawer(makeDeal({ id: 'd2', location: 'TBD' }));
    expect(await screen.findByText('No Edge market')).toBeTruthy();
  });

  it('confidential deal gets a readout and its identity never reaches /edge/', async () => {
    renderDrawer(makeDeal({ id: 'secret-deal-7', name: 'Secret', market: 'Columbus OH', confidential: true }));
    expect(await screen.findByText('Flex vacancy')).toBeTruthy();
    for (const [u, init] of edgeCalls()) {
      expect(String(u)).not.toContain('secret');
      expect(init?.body ?? null).toBeNull();
    }
  });
});

describe('RankedCandidateList — Edge column', () => {
  const linked = makeDeal({ id: 'page-1', market: 'Columbus OH', location: 'Columbus, OH' });

  it('linked candidate → vacancy · rent growth; unlinked → no linked deal', async () => {
    renderList([makeCandidate({ id: 'c1', notionDealId: 'page-1' }), makeCandidate({ id: 'c2', notionDealId: null, address: '200 Other Rd' })], [linked], true);
    expect(screen.getByRole('columnheader', { name: 'Edge' })).toBeTruthy();
    expect(await screen.findByText('3.0% · +1.8% · STALE')).toBeTruthy();
    expect(screen.getByText('No Edge market (no linked deal)')).toBeTruthy();
  });

  it('F11: with edgeEnabled false the column fires no /edge/ request', async () => {
    renderList([makeCandidate({ id: 'c1', notionDealId: 'page-1' })], [linked], false);
    expect(screen.getByRole('columnheader', { name: 'Edge' })).toBeTruthy();
    await new Promise((r) => setTimeout(r, 20));
    expect(edgeCalls()).toHaveLength(0);
  });

  it('enabling triggers exactly the markets request', async () => {
    renderList([makeCandidate({ id: 'c1', notionDealId: 'page-1' })], [linked], true);
    await waitFor(() => expect(edgeCalls()).toHaveLength(1));
    expect(String(edgeCalls()[0]![0])).toBe('/api/warehouse/edge/markets');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/unit/edge-overlay.test.tsx`
Expected: FAIL — `Unable to find an element with the text: Edge Market`; `Unable to find role="columnheader" and name "Edge"`.

- [ ] **Step 3: Implement both surfaces**

`src/modules/acquisitions/RankedCandidateList.tsx` — replace lines 8–12 (imports) with:

```tsx
import type { RankedCandidate } from '@contracts/acquisition';
import { GOVERNOR_FALLBACK } from '@contracts/index';
import { DataTable, type Column } from '@/primitives/DataTable';
import { useSetCandidateStatus } from './hooks';
import { useSnapshot } from '@/data/queries';
import { edgeCandidateCell, useEdgeMarkets, type EdgeQueryState } from './edge-hooks';
```

Replace the signature line and the line after it:

```tsx
export function RankedCandidateList({ items, advisoryOnly, writesEnabled, edgeEnabled = false }: Props) {
  const setStatus = useSetCandidateStatus();
```

Directly after `const setStatus = useSetCandidateStatus();` (before the `items.length === 0` early return, per the Rules of Hooks) add:

```tsx
  // Oxford Edge column (spec §8.4). AcqCandidateRow.market is a ClusterTier, not a metro, so a
  // candidate resolves only through notionDealId → snapshot Deal → resolveEdgeMarket. The query is
  // gated by edgeEnabled (this list is force-mounted in Sourcing; spec F11).
  const { data: snap } = useSnapshot();
  const deals = snap?.snapshot.deals ?? [];
  const edge = useEdgeMarkets({ enabled: edgeEnabled });
  const edgeState: EdgeQueryState = !edgeEnabled ? 'idle' : edge.isLoading ? 'loading' : edge.isError ? 'error' : 'ready';
```

After the `market` column object (ends at line 112, before `{ key: 'sf', ...`) insert:

```tsx
    {
      key: 'edge',
      header: 'Edge',
      render: (item) => {
        const cell = edgeCandidateCell(item.candidate.notionDealId, deals, edge.data, edgeState);
        return (
          <span title={cell.title ?? undefined} style={{ fontSize: '0.75rem', color: 'var(--text-secondary)' }}>
            {cell.text}
          </span>
        );
      },
    },
```

`src/brain/DealDrawer.tsx` — after line 13 (`import { useAcqIntel } from '@/modules/acquisitions/grader-hooks';`) add:

```tsx
import { EdgeMarketReadout } from '@/modules/acquisitions/EdgeMarketReadout';
```

After the "Deal Detail" `</CardBox>` (line 127) insert:

```tsx

                  <CardBox title="Edge Market">
                    <EdgeMarketReadout deal={deal} onNavigate={onClose} />
                  </CardBox>
```

- [ ] **Step 4: Run tests to verify they pass (including the untouched drawer suite)**

Run:
```bash
npx vitest run tests/unit/edge-overlay.test.tsx tests/unit/deal-drawer.test.tsx tests/unit/acquisitions-tabs.test.tsx
npm run typecheck
npx eslint src/modules/acquisitions/RankedCandidateList.tsx src/brain/DealDrawer.tsx --max-warnings 0
```
Expected: all PASS (existing `deal-drawer.test.tsx` still passes: its fetch stub returns non-JSON 500 for `/edge/`, the readout renders the local-only line, and it renders no `role="img"`); typecheck 0; eslint 0.

- [ ] **Step 5: Commit**

```bash
git add src/modules/acquisitions/RankedCandidateList.tsx src/brain/DealDrawer.tsx tests/unit/edge-overlay.test.tsx
git commit -F - <<'EOF'
feat(acquisitions): Edge market overlay in Sourcing list + DealDrawer "Edge Market" card

Strict resolver only; unlinked candidates read "No Edge market (no linked deal)". No deal
identity is sent to /api/warehouse/edge/*.

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 15: `env.example` doc line + worktree preview entries in `.claude/launch.json`

**Files:**
- Modify: `env.example:19` (insert after `# WORKBOOK_PATH=`)
- Modify: `C:/Users/Owner/oxford-command-center/.claude/launch.json` (gitignored, local, main checkout — never committed)

**Interfaces:**
- Consumes: `edgeDir()` default (Task 3).
- Produces: documented `OXFORD_EDGE_DIR`; preview configs `edge-web` (port 5273) and `edge-server` (port 8911) pointing `--prefix` at the worktree.

- [ ] **Step 1: Write the failing check**

Run: `grep -n "OXFORD_EDGE_DIR" env.example`
Expected: no output (exit 1).

- [ ] **Step 2: Edit `env.example`**

Re-read `env.example` immediately before editing (shared single-writer surface). After line 19 (`# WORKBOOK_PATH=`) insert:

```
# Oxford Edge market dataset directory (Acquisitions › Edge, read-only). Holds markets.json, which is
# written ONLY by the upstream oxford-edge pipeline. Defaults to the OneDrive path in
# server/edge/config.ts (edgeDir()); set only if the folder moved or on another machine.
# OXFORD_EDGE_DIR=
```

- [ ] **Step 3: Edit the main checkout's `.claude/launch.json` (local only)**

Read `C:/Users/Owner/oxford-command-center/.claude/launch.json` first (never overwrite a config unread). It is gitignored (`.gitignore:63`), so it lives only in the main checkout, where the Browser preview tools read it. Append two entries to `configurations` (mirroring the existing `trends-web` worktree entry):

```json
    {
      "name": "edge-web",
      "runtimeExecutable": "npm",
      "runtimeArgs": [
        "--prefix",
        "C:/Users/Owner/oxford-command-center/.claude/worktrees/oxford-edge-tab",
        "run",
        "dev:web"
      ],
      "port": 5273
    },
    {
      "name": "edge-server",
      "runtimeExecutable": "npm",
      "runtimeArgs": [
        "--prefix",
        "C:/Users/Owner/oxford-command-center/.claude/worktrees/oxford-edge-tab",
        "run",
        "dev:server:once"
      ],
      "port": 8911
    }
```

`npm --prefix <worktree> run …` runs the script with the worktree as cwd, so the server loads the worktree `.env` and its relative `WAREHOUSE_DB=./data/warehouse/finance.sqlite` resolves inside the worktree (spec §7 live-DB safety, F10).

- [ ] **Step 4: Verify**

Run:
```bash
grep -n "OXFORD_EDGE_DIR" env.example
node -e "const c=require('C:/Users/Owner/oxford-command-center/.claude/launch.json');console.log(c.configurations.filter(x=>x.name.startsWith('edge-')).map(x=>x.name+' '+x.runtimeArgs[1]).join('\n'))"
git -C C:/Users/Owner/oxford-command-center status --short .claude/launch.json
```
Expected: one `# OXFORD_EDGE_DIR=` line; two `edge-*` entries pointing at the worktree; `git status` prints nothing for `launch.json` (ignored).

- [ ] **Step 5: Commit (env.example only)**

```bash
git add env.example
git commit -F - <<'EOF'
docs(env): document OXFORD_EDGE_DIR (Oxford Edge dataset dir, read-only)

Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
EOF
```

---

### Task 16: Full gate + refute gate (honest record)

**Files:** none modified (verification only).

**Interfaces:**
- Consumes: the whole branch.
- Produces: a gate record (pass/fail per step, attempt counts) quoted verbatim in the PR body.

- [ ] **Step 1: Confirm a clean, isolated tree**

Run (worktree root): `git status --short && git log --oneline origin/main..HEAD`
Expected: clean status (the `.env` and `node_modules` junction are gitignored); commits from Tasks 0–15 only. One heavy process per worktree: do not run anything else here while the gate runs.

- [ ] **Step 2: Run the gate**

Run: `npm run gate`
Expected: all 11 steps green. Two known conditions — record them, never rationalize them, never `--no-verify`:
- **Intermittent `0xC0000005` (exit `-1073741819`)** during `test` (~30–50% of runs; all assertions pass): rerun `npm run gate`; record the attempt count. If a single file times out under load (60 s), rerun that file alone (`npx vitest run <file>`), then rerun the gate once for a clean record.
- **`reconcile` red on clean `main` since 2026-09-25** ("Cash history latest = current total", snapshot data drift). If it fails with that row, prove the branch does not touch its inputs:

```bash
git diff --stat origin/main...HEAD -- data/ scripts/reconcile.ts server/reconcile-runtime.ts
```
Expected: no output. Then run the later steps individually and keep their output for the PR:

```bash
npm run reconcile:noi-crosscheck
npm run warehouse:verify
npm run warehouse:drift
```
Expected: each PASS. The PR then states: "gate: 10/11 green; `reconcile` fails identically on `main` @ <base sha> (snapshot data drift, inputs untouched by this branch — empty diff above); later steps run individually and green (output quoted)." Never report the gate as green when it was not.

- [ ] **Step 3: Refute gate**

Run: `npx tsx scripts/check-refute-required.ts --strict --base=origin/main`
Expected: PASS — every commit touching `server/**` (Tasks 2–7) carries `Refute-Skip: Oxford Edge Phase 1 — read-only display ingest + manual-pull log; no scoring, NOI, governor or capital math`. If a commit is flagged, reword **that** commit's message to add the trailer (`git rebase -i` is unavailable here; use `git commit --amend` on the tip or `git rebase --exec` with a scripted message), never add the trailer to a later commit — attestation is per commit.

- [ ] **Step 4: Confirm the Phase 1 boundaries mechanically**

Run:
```bash
git diff --name-only origin/main...HEAD | grep -E '^(config/acquisition-ruleset|server/warehouse/acquisition|server/warehouse/intel-config|src/contracts/(acquisition|common|deal)\.ts|server/ai/|scripts/bake-warehouse|scripts/check-refute-required|server/index\.ts|server/warehouse/(migrate|db)\.ts)'
```
Expected: no output (no scoring, ruleset, governor, AI-tool, bake, refute-scope, index, migrate or db file touched).

- [ ] **Step 5: Record**

Save the gate/refute outputs to the session scratchpad for the PR body. No commit.

---

### Task 17: Preview verification (Browser tools, worktree servers)

**Files:** none (the worktree `.env` is edited temporarily in Step 6 and restored).

**Interfaces:**
- Consumes: `edge-web` / `edge-server` launch entries (Task 15).
- Produces: verified behaviour per spec §10 preview steps 1–8.

- [ ] **Step 1: Ports and live-DB safety (F10)**

Call `mcp__Claude_Browser__preview_list`. If anything already holds 5273/8911 that this session did not start, stop and ask Gabriel (another session's server; never kill it). Confirm `.env` in the worktree has `WAREHOUSE_DB=./data/warehouse/finance.sqlite` and no `OXFORD_EDGE_DIR`.

- [ ] **Step 2: Start the worktree servers**

`mcp__Claude_Browser__preview_start` with `name: "edge-server"`, then `name: "edge-web"`. Check `mcp__Claude_Browser__preview_logs` (level `error`) for both: expected no errors.

Prove migration 034 applied to the **worktree** DB and **not** the live warehouse:

```bash
cd C:/Users/Owner/oxford-command-center/.claude/worktrees/oxford-edge-tab
node -e "const D=require('better-sqlite3');for(const p of ['data/warehouse/finance.sqlite','C:/Users/Owner/oxford-command-center/data/warehouse/finance.sqlite']){const db=new D(p,{readonly:true,fileMustExist:true});console.log(p,'=>',!!db.prepare(\"SELECT 1 FROM sqlite_master WHERE name='edge_pull_log'\").get());db.close()}"
```
Expected: worktree path `=> true`; live path `=> false`. If the live path prints `true`, STOP and tell Gabriel immediately (2026-09-17 incident class).

- [ ] **Step 3: The tab (spec §10 step 3)**

Navigate (`mcp__Claude_Browser__navigate`) to `http://localhost:5273/pipeline?tab=edge`, then `mcp__Claude_Browser__get_page_text`. Verify:
- STALE banner: "Edge dataset as of 2026-07-14 — 80 days old." (age = days since 2026-07-14 on the run date; 80 on 2026-10-02).
- Market set shows `Buy-box (21)` (default) and `All (55)`; clicking `All (55)` (`mcp__Claude_Browser__find` → `computer` left_click) shows 55 rows.
- In "Add series columns", the label "Residential building permits authorized, growth (Census BPS) [PROXY]" exists; ticking "Self-storage asking rate growth" shows "— Pending manual pull" in rows.
- Manual pull queue: 21 + 21 + 15 + 13 scopes, all `open`; "Truck AADT automated (not queued): MI, VA".
- Data health: three `[PROXY]` badges; "51/55 markets — 4 metro-only markets …"; "Outside pull scope — truck: DC, ND, SD, TN · mfgInvest: DC, ND, SD, TN".

- [ ] **Step 4: Pull write path (spec §10 step 4)**

Click "Mark Columbus, OH done" in the storage card, keep today's date, note `preview check`, Save. Reload; confirm Columbus reads `current` with today's date. Click "Undo Columbus, OH", accept the confirm dialog; confirm it reverts to `open`. Confirm the row was voided, not deleted:

```bash
node -e "const D=require('better-sqlite3');const db=new D('data/warehouse/finance.sqlite',{readonly:true});console.log(db.prepare('SELECT id,pull_kind,scope_key,done_on,note,voided_at IS NOT NULL AS voided FROM edge_pull_log').all())"
```
Expected: one row, `voided: 1`.

- [ ] **Step 5: Deal overlay (spec §10 step 5)**

On `http://localhost:5273/pipeline?tab=pipeline`, open a deal whose market is `Columbus OH` (Active Deals row click) → "Edge Market" card shows the four values with STALE. Open a deal whose location is `TBD` → "No Edge market". If the worktree snapshot has no such deal, record exactly which deals were checked and their resolution (do not fabricate one). On `?tab=sourcing`, confirm the Edge column renders.

- [ ] **Step 6: Missing-path state (spec §10 step 6)**

Append `OXFORD_EDGE_DIR=C:/nonexistent/oxford-edge` to the worktree `.env`, `mcp__Claude_Browser__preview_stop` + `preview_start` `edge-server`, reload `?tab=edge`: expect "markets.json not found at C:/nonexistent/oxford-edge. Set OXFORD_EDGE_DIR in .env on this machine." Then remove that line from `.env`, restart `edge-server`, and confirm the board is back.

- [ ] **Step 7: Console + eager-query check (spec §10 step 7, F11)**

`mcp__Claude_Browser__read_console_messages` with `onlyErrors: true`: expected none attributable to Edge. Navigate fresh to `http://localhost:5273/pipeline?tab=pipeline`, wait, then `mcp__Claude_Browser__read_network_requests` with `urlPattern: "/edge/"`: expected **no** entries. Select the Sourcing tab: expected exactly one `/api/warehouse/edge/markets` request.

- [ ] **Step 8: Stop the servers**

`mcp__Claude_Browser__preview_stop` for `edge-web` and `edge-server`. Confirm `git status --short` in the worktree is clean (the `.env` edit from Step 6 is reverted; `.env` is gitignored either way).

---

### Task 18: PR, rollout, artifact retirement

**Files:**
- Modify: `architecture/status.json` (flip the claim on merge — Architect-owned; requires a fresh acknowledgment)

**Interfaces:**
- Consumes: Tasks 0–17.
- Produces: one squash-merge PR; post-merge verification; the retired-banner artifact.

- [ ] **Step 1: Push and open the PR (ask first — external push)**

Ask Gabriel (AskUserQuestion): "(Recommended) Push `feat/oxford-edge-tab` and open the PR" / "Hold". On yes:

```bash
git push -u origin feat/oxford-edge-tab
gh pr create --base main --head feat/oxford-edge-tab --title "feat(acquisitions): Oxford Edge tab — Phase 1 display (market board, data health, pull queue, deal overlay)" --body-file <scratchpad>/edge-pr-body.md
```

The PR body (`<scratchpad>/edge-pr-body.md`) lists: files changed by area (contracts, migration 034, `server/edge/*`, sub-router entry, UI, tests, env doc); the Architect-owned acknowledgment (status.json `oxford-edge-tab`); the gate record from Task 16 verbatim (attempt counts; the `reconcile` statement if applicable); `check:schema-drift` warnings quoted; `check:refute` result; preview results from Task 17; the deviations listed in this plan's "Spec coverage" notes; and ends with:

```
🤖 Generated with [Claude Code](https://claude.com/claude-code)
```

CI: if hosted runners fail in 1–3 s, that is the Actions-billing condition — use the `ora-ci-status` skill (self-hosted `CI_RUNNER=self`), never treat a bot check as a review verdict. This PR touches `server/warehouse/migrations/` (Architect/blast-radius) and `server/**`: request a real review (adversarial subagent pass, pinned model) before merge per the merge gate.

- [ ] **Step 2: Squash-merge message (Gabriel merges)**

Gabriel owns integration to `main`. The squash message must carry the union of branch trailers, one line each:

```
Refute-Skip: Oxford Edge Phase 1 — read-only display ingest + manual-pull log; no scoring, NOI, governor or capital math
Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>
```

Before merge, re-run Task 0 Step 1's migration-number loop against fresh `origin/main`; if `034` was taken meanwhile, renumber (file, test, PR text) and re-run the gate.

- [ ] **Step 3: Rollout verification (spec §11 rollout step 2)**

After merge, Gabriel restarts the dev server on `main` (this applies `034` to the live warehouse). Then:

```bash
curl -s http://localhost:8911/api/warehouse/edge/pull-queue | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const q=JSON.parse(s);const open=q.items.flatMap(i=>i.scopes).filter(x=>x.state==='open').length;console.log(open, q.items.map(i=>i.kind+':'+i.scopes.length).join(' '))})"
```
Expected: `70 storage:21 ios:21 mfgInvest:15 truck:13`. Also load `/pipeline?tab=edge` on `main` and confirm the STALE banner.

- [ ] **Step 4: Retire the artifact (only after Step 3 is verified; decided Q1)**

Load the `artifact-design` skill (the Artifact tool contract requires it before writing). `Artifact` action `read`, `url: https://claude.ai/artifact/Khu2pu9ZPaH3PqdZv4A6Kr`; build from the saved file it names. Insert, as the first child inside `<div class="wrap">` (using the page's own tokens):

```html
<div role="note" style="margin:0 0 24px;padding:12px 16px;border:1px solid var(--dead);background:var(--dead-bg);color:var(--dead);border-radius:8px;font-weight:600">Retired — live in Command Center › Acquisitions › Edge (local). This page is frozen at 2026-07-14.</div>
```

Publish with `Artifact` (`url` = the same artifact URL, `file_path` = the edited file, no `icon`). Do **not** delete the artifact. Confirm the read-back shows the banner.

- [ ] **Step 5: Close out the claim and the worktree**

With a fresh Architect acknowledgment (status.json is Architect-owned), set the `oxford-edge-tab` entry to `"status": "merged"`, `"review_needed": false`, `"review_detail": null`, new `last_updated`, and land it as a small PR or hand it to Gabriel. Remove the two `edge-*` entries from the main checkout's `.claude/launch.json`. Worktree teardown (memory `node-modules-junction-footgun`):

```powershell
cmd /c rmdir C:\Users\Owner\oxford-command-center\.claude\worktrees\oxford-edge-tab\node_modules
Test-Path C:\Users\Owner\oxford-command-center\node_modules\typescript
git -C C:/Users/Owner/oxford-command-center worktree remove .claude/worktrees/oxford-edge-tab
```
Expected: `True` after the junction removal (shared `node_modules` intact), then the worktree is removed. Delete the merged local branch only after Gabriel confirms the merge.

**Rollback (spec §11):** UI — `git revert -m 1 <squash sha>` (CLAUDE.md §8); `markets.json` is untouched by construction. DB — `034`'s table stays (never dropped; recorded pulls preserved); a re-land reuses it via `CREATE TABLE IF NOT EXISTS`.

---

## Spec coverage

| Spec § | Requirement | Task |
|---|---|---|
| §1, §2 G1 | Read `markets.json` live, read-only; render in Acquisitions | 5, 7, 12, 13 |
| §2 G2, §8.2 banner, F1 | Honest freshness, STALE on launch, `asOf = min(pulled, mtime)` | 3, 12, 17 |
| §2 G3, F3, F4 | Proxies honest; `guide_only`/null never 0 | 8, 10, 12 |
| §2 G4, §8.4, F2, F13 | Strict two-tier resolver, no guessing | 9, 14 |
| §2 G5, §5.3, §8.6 | Server-side pull queue replaces localStorage | 2, 6, 7, 11 |
| §2 non-goals | No score/ruleset/governor/mirror/AI/briefing change; no crosswalk | 16 Step 4, 7 (bake guard), 9 (no crosswalk) |
| §3 location, `edgeDir()`, env doc | Default path + `OXFORD_EDGE_DIR` | 3, 15 |
| §3 `SERIES_UNITS`, key-set test | Units in code; ⇔ fieldMeta test | 1, 5 |
| §3 licensing, F14 | Synthetic fixture | 5 |
| §4 loader (memo, retry, last-good, quarantine) | | 5 |
| §4 coverage / freshness modules | | 3, 4 |
| §5.1 files + owners | | 0 (claim), 1–7 |
| §5.2 routes, 200 envelopes, 503 guard, 400s | | 7 |
| §5.2 coverage rule + `inconsistent` | | 4 |
| §5.3 scopes 21/21/15/13, cadences, VA/MI automated, outside-scope states, launch 70 open | | 6, 7, 12 |
| §5.4 mirror/AI/confidentiality | | 7 (F9 tests), 14 (no deal id to /edge) |
| §6 contracts; raw schema in loader; not in `FINANCIAL_CONTRACT_PATHS` | | 1, 5, 16 |
| §7 migration 034, append-only, void, schema-drift binding, live-DB safety | | 2, 6, 7, 15, 17 |
| §8.1 tab registration, cap 5, palette, no badge, lazy, lifted state, tab test | | 13 |
| §8.2 layout, KPIs, error/empty states | | 12 |
| §8.3 board columns, latest rule, status labels, picker, set filter + pin, detail, footnote | | 8, 10 |
| §8.4 readout, drawer card, Sourcing column, eager-query guard, confidential handling | | 9, 12, 13, 14 |
| §8.5 data health | | 12 |
| §8.6 pull queue UI | | 11 |
| §8.7 hooks + helpers | | 8, 9 |
| §9 F1–F14 | | 3 (F1), 9 (F2, F13), 8/10 (F3, F4), 5 (F5–F8, F14), 7 (F9, F12), 17 (F10), 13/14 (F11) |
| §10 unit tests, gate caveats, Refute-Skip, preview steps 1–8 | | 1–14, 16, 17 |
| §11 coordination, rollout, artifact retirement, rollback | | 0, 18 |
| §12 Q1–Q4 | Retire-with-banner; unlinked → "no Edge market"; note-only; 7-day rule | 18, 9/14, 6/11, 3 |
| §13 Phase 2 | **Out of scope** — not planned | — |

**Resolved ambiguities / deviations from the spec text (state each in the PR):**
1. **Candidate→deal join** uses `Deal.id === candidate.notionDealId`, not `Deal.notionDealId`: `acq_candidates.notion_deal_id` stores the Notion page id, which is `Deal.id` for live pipeline rows; `Deal.notionDealId` holds the `DEAL-n` unique id. This is the join `DealDrawer.findRankedCandidateForDeal` already uses. Seed-matched deals (seed `id`) therefore read "no linked deal", same as the drawer's existing behaviour.
2. **Migration 034 `done_on` CHECK** adds `date(done_on) IS NOT NULL` — the spec's bare equality admits non-date strings because SQLite passes a NULL CHECK.
3. **`EdgeMarketReadout`** lives in its own file (not exported from `EdgeView.tsx`) to keep the drawer's import light and avoid a `react-refresh` lint warning.
4. **`DataTable` limits:** no expandable rows → detail panel under the table; string headers → always-visible "Column definitions" list instead of header tooltips; header sort unused (pinning needs a two-key sort and the sort must be liftable) → explicit sort control.
5. **Sparkline** takes `number[]`, so unpublished years are dropped rather than drawn as gaps.
6. **Contract additions beyond §5.2's abbreviated example:** `sources`, `issues`, `lastGoodLoadedAt`, `outsidePullScope` on the markets envelope; per-scope resolved `links` + `blocker` (instead of item-level `urlTemplate`), plus `why`/`caveat`/`cadenceLabel`/`counts`/`today` on the queue.
7. **`SERIES_UNITS`/`EDGE_SERIES`** are declared in `src/contracts/edge.ts` and re-exported by `server/edge/series.ts` (src may not import server).
8. **Coverage pin** is against the synthetic fixture's own counts; the published validation-report counts cannot be reproduced without real data in git.
