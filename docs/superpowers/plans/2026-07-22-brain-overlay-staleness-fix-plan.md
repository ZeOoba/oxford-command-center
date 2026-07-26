# Brain Overlay Staleness — Fix Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `server/brain.ts`'s in-memory overlay stay consistent with `data/overlay.json` on disk for the entire lifetime of a running server process, so an external writer (chiefly `scripts/ar-import-headless.ts`, the scheduled AR-aging feed — but the same gap applies to any future out-of-process writer) can never have its changes silently reverted by a subsequent server-mediated mutation.

**Architecture:** No new components, no new dependencies. Two changes to `server/brain.ts`: (1) every write-back method reads a **fresh** copy of the on-disk overlay immediately before applying its patch, instead of mutating the long-lived `this.overlay` field directly; (2) an optional `chokidar` watch on `overlay.json` (mirroring the existing workbook watch) so the server's own in-memory `snapshot` picks up an external write reactively, without requiring a user-triggered mutation first. (1) is the correctness fix; (2) is a freshness/UX improvement layered on top of it.

**Tech Stack:** TypeScript, Node ESM, `chokidar` (already a dependency, already used for the workbook watch), Vitest.

## Origin

Found during PR #230's (`feat/ar-balances-feed`) fourth adversarial-refute round, verifying that the interactive AR-import script's staleness recheck could actually observe a concurrent headless-sweep write. It could not — not because of a bug in the recheck itself, but because `/api/snapshot` (and therefore anything reading through the live server) reflects `Brain`'s in-memory overlay, which is loaded once at construction and never refreshed. That PR shipped with this disclosed as a known, out-of-scope limitation (see its final commit message and the corrected docstring in `scripts/ar-import-headless.ts`). Gabriel asked for a proper fix plan as the follow-up.

**Re-verify the line numbers and exact code below against the live file before executing this plan — `server/brain.ts` is actively maintained and may have shifted.** Verified against the file as of 2026-07-22.

## Root Cause

`server/brain.ts`:

```ts
class Brain extends EventEmitter {
  private base: PortfolioSnapshot | null = null;
  private snapshot: PortfolioSnapshot | null = null;
  private overlay: Overlay = loadOverlay();     // line 21 — runs ONCE, at `new Brain()` construction
  ...

  async refresh(reason = 'manual'): Promise<BrainState> {
    ...
    const merged = applyOverlay(snapshot, this.overlay);   // line 49 — reuses the SAME in-memory overlay;
    ...                                                      // does NOT re-read overlay.json from disk
  }

  private rederive(reason: string) {
    if (!this.base) return;
    this.snapshot = { ...applyOverlay(this.base, this.overlay), ... };
    void saveOverlay(this.overlay);              // line 82 — unconditional full-object overwrite
    this.persist(this.snapshot);
    ...
  }

  setDealStage(dealId: string, stage: DealStage): boolean {
    if (!this.base?.deals.some((d) => d.id === dealId)) return false;
    this.overlay = { ...this.overlay, dealStages: { ...this.overlay.dealStages, [dealId]: stage } };
    this.rederive('action:deal-stage');
    return true;
  }
  // ... 8 more write-back methods, ALL following this exact same pattern:
  // setRenewalStage, setTenantNote, setDealComps, setAcquisitionInput,
  // setNoiBudget, setTenantArrears, setMarketRent, addTask
```

Every one of the 9 write-back methods mutates `this.overlay` — a field that was populated once at server startup and is never re-synced with disk — then `rederive()` persists that same stale-rooted object back to `overlay.json` via an unconditional `saveOverlay(this.overlay)`.

**Concrete failure sequence** (the one that motivated this plan):
1. `npm run dev` starts. `Brain`'s constructor runs `loadOverlay()`, capturing overlay.json's contents at that instant (call it `O0`).
2. The scheduled AR-aging headless feed runs (out-of-process, no server dependency by design) and writes `overlay.json` directly to disk — now `O1` on disk, containing new `tenantArrears` entries `O0` never had.
3. The server is still running. `this.overlay` in memory is still `O0` — nothing in the server's process re-read the file.
4. **Any** subsequent server-mediated mutation fires — a deal-stage change in the UI, a task creation, a manual arrears edit, the interactive AR-import script's write, anything — say `setNoiBudget(...)`.
5. That method does `this.overlay = { ...this.overlay /* = O0 */, noiBudgets: {...} }` → produces `O0'` (O0 plus the new NOI budget, but **without** the headless feed's arrears from `O1`).
6. `rederive()` calls `saveOverlay(O0')`, which **overwrites `overlay.json` on disk**, permanently erasing every field the headless feed wrote in step 2 — not just AR, whatever else may have changed on disk in between too.
7. The `/api/snapshot` route reads `Brain.getSnapshot()`, which is derived from the same stale `this.overlay` — so even before step 4's write, any live client (the interactive script's recheck, a UI screen, a report) already saw stale AR data for the entire span between steps 2 and 4.

This is not a race requiring precise timing — the window is the server's **entire uptime** after any external write, until the server restarts.

## Design

### Task 1 — Convert write-back methods to read-fresh-then-patch

Each `setXxx`/`addTask` method currently does an in-place mutation of `this.overlay`. Change the pattern to: **load the current on-disk overlay fresh, apply this one method's patch on top of that fresh read, then adopt the result as the new `this.overlay` and persist it.**

```ts
// Before (all 9 methods follow this shape):
setDealStage(dealId: string, stage: DealStage): boolean {
  if (!this.base?.deals.some((d) => d.id === dealId)) return false;
  this.overlay = { ...this.overlay, dealStages: { ...this.overlay.dealStages, [dealId]: stage } };
  this.rederive('action:deal-stage');
  return true;
}

// After:
setDealStage(dealId: string, stage: DealStage): boolean {
  if (!this.base?.deals.some((d) => d.id === dealId)) return false;
  const fresh = loadOverlay();  // re-read from disk, not this.overlay
  this.overlay = { ...fresh, dealStages: { ...fresh.dealStages, [dealId]: stage } };
  this.rederive('action:deal-stage');
  return true;
}
```

Apply the identical change to all 9 methods: `setDealStage`, `setRenewalStage`, `setTenantNote`, `setDealComps`, `setAcquisitionInput`, `setNoiBudget`, `setTenantArrears`, `setMarketRent`, `addTask`.

**Why this is sufficient on its own:** it closes the write-side of the race completely. Any mutation now starts from whatever is *actually on disk* at the moment of the write, so it can never blindly stomp a concurrent external writer's changes — the worst case left is two writes racing each other in an interleaved way (see Task 1a), not one silently erasing the other's entire file.

**Cost:** one extra synchronous `readFileSync` + JSON parse + per-field Zod/coercion validation per mutation. These are human- or scheduled-task-triggered, not a hot path (no UI action fires more than a few times a minute at most) — negligible.

**Task 1a — narrow race that remains, and why it's acceptable:** two concurrent writers (e.g., two browser tabs, or the headless feed and a UI action landing in the same few milliseconds) can still both read the same `fresh` snapshot before either writes back, and the second write wins outright (last-write-wins on the WHOLE overlay, not just the touched field) — this is the same class of gap `server/ar/resolve-latest.ts`'s `filterAgainstPersisted` was built to close specifically for AR, but generalized across all 9 overlay domains a true fix would need per-domain conflict resolution, which is disproportionate here. Document this as an accepted, narrow (millisecond-scale) residual race — it is categorically smaller than the current defect (an entire server-uptime-long window), and no known caller in this codebase fires concurrent overlapping writes today.

### Task 2 — Re-derive from a stale `this.overlay` is also wrong in `refresh()`

`refresh()` (line 49) has the same bug on the READ side: it calls `applyOverlay(snapshot, this.overlay)` using the in-memory copy, not a fresh read. Fix: `refresh()` should also `this.overlay = loadOverlay();` before calling `applyOverlay`, so a full workbook refresh (which already re-reads the workbook from disk) also re-reads the overlay from disk in the same pass — closing the gap for the "scheduled task ran overnight, server restarts fine but a live server's next `npm run master-workbook-ingest`-triggered refresh should also pick up the freshest overlay" case.

### Task 3 (optional, freshness/UX layer — not required for correctness) — watch overlay.json

Mirror the existing workbook chokidar watch (`startWatching()`) with a second watcher on `overlayPath()`. On an external change: `this.overlay = loadOverlay(); this.rederive('external:overlay-changed');` (debounced, same pattern as the workbook watcher). This makes the server's own `snapshot`/SSE clients pick up an external write within ~1-2s without needing any user-triggered mutation to "discover" it first. Purely additive — Task 1 is what makes the system CORRECT; this makes it feel responsive.

**Do this only if Task 1+2 ship clean and there's appetite for the added watcher-lifecycle complexity — it's not required to close the bug.**

## Non-Goals

- **Not** attempting per-field/per-domain conflict resolution across all 9 overlay maps (only AR has that, via `resolve-latest.ts`, and only because AR specifically has a point-in-time-vs-cumulative semantic that makes "last write wins" actively wrong; the other 8 domains — deal stages, tasks, notes, comps, acquisition inputs, NOI budgets, market rents, renewal stages — are simple key-value overwrites where last-write-wins is the correct, intended semantic once the write is based on fresh data).
- **Not** changing `overlay.json`'s file format, the `Overlay` type, or `loadOverlay`/`saveOverlay`'s own signatures — this plan only changes *when* they're called relative to `this.overlay`.
- **Not** touching the AR feed itself (`scripts/ar-import-headless.ts`, `scripts/ar-import.ts`) — those already do their own fresh-read-then-write via `loadOverlay()`/`filterAgainstPersisted` at the process level; this plan fixes the *server's* long-lived-process staleness, a different failure mode.

## Testing Strategy (TDD — write these first)

New/extended `tests/unit/brain.test.ts` cases:
1. **Regression test for the exact failure sequence above:** construct a `Brain`, call one write-back method (establishing `this.overlay` in memory), then externally `saveOverlay()` a DIFFERENT change directly (simulating the headless feed), then call a second write-back method on the same `Brain` instance — assert the final on-disk `overlay.json` contains **both** changes, not just the second one clobbering the first.
2. Repeat case 1 for at least 2 of the 9 methods (not just one) to catch a copy-paste miss across the mechanical edit.
3. `refresh()` picks up an externally-written overlay change without requiring a prior write-back call.
4. If Task 3 is implemented: the overlay watcher's debounce fires `rederive` on an external file change, verified via a temp-dir `OVERLAY_PATH` + a direct file write + waiting for the debounce window (same pattern the existing workbook-watcher tests likely already use — check `tests/unit/brain.test.ts` for the existing watcher test idiom before writing this one).

## Verification Gate (before declaring done)

- [ ] All 9 write-back methods converted (grep for `this.overlay = { ...this.overlay` in brain.ts afterward — should return zero matches; every occurrence should read `{ ...fresh` or equivalent)
- [ ] `refresh()` re-reads the overlay
- [ ] New regression tests pass; full suite green; typecheck 0 across all 3 tsconfigs; lint 0
- [ ] **Adversarial refute pass required** (`.claude/workflows/refute-financial-change.js`) before merge — this is financial-decision-adjacent code (it's the write path for NOI budgets, acquisition inputs, and AR arrears, among others) per CLAUDE.md's Engineering OS mandate. Budget for at least 2 rounds given this session's own experience on the AR PR (round 1 rarely catches everything).
- [ ] `CHANGELOG.md` entry
- [ ] PR opened from an isolated worktree (this repo's shared-checkout single-writer convention), reviewed, refute-required CI gate green, merged
