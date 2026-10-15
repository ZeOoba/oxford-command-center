import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { watch, type FSWatcher } from 'chokidar';
import { PortfolioSnapshot, type BrainState, type DataQualityFlag, type Task, type DealStage, type RenewalStage, type CompSet, type AcquisitionInput, type TenantArrears, type QbActuals, type Property } from '../src/contracts/index';
import { tenantScorecards } from '../src/brain/tenants';
import { parseWorkbook } from './workbook/parse';
import { applyOverlay, evaluateOverlayPrecondition, loadOverlay, overlayPath, saveOverlay, type Overlay } from './overlay';
import { checkSnapshot, hasReconciliationError } from './reconcile-runtime';
import { SNAPSHOT_PATH, workbookPath, referenceDate } from './config';
import { resolveQuickbooks, type ResolvedQuickbooks } from './sources/quickbooks';
import { evaluateAnomalyFloor, loadPreviousLeaseIds } from './anomaly-floor';
import { renameSyncWithRetry } from './lib/rename-retry';
import { hasDealsPipelineFailure, applyRosterOverride, type DealsDegradation } from './sources/notion-deals';
import { termsPath as confidentialRosterPath } from './briefing/confidential';
import { hasM365TasksFailure, type M365TasksDegradation } from './sources/m365-tasks';

/** Trailing debounce for roster-file events (editors emit write bursts / unlink+add pairs). */
const ROSTER_RECHECK_DEBOUNCE_MS = 250;

/**
 * resolveQuickbooks(), layered with an in-memory preference (2026-08-17 — refute pass on the
 * resolveQuickbooks fix itself). resolveQuickbooks's disk fallback reads SNAPSHOT_PATH from disk,
 * but brain.persist() DECLINES to write that file during a deals-degraded or reconciliation-error
 * window — so the disk mirror can lag behind a FRESHER quickbooks block this live server is
 * already holding in memory from an earlier successful CSV parse. A later transient CSV failure
 * would then have resolveQuickbooks's disk fallback silently replace the fresher in-memory block
 * with the staler on-disk one. A fresh CSV parse always wins outright (freshest possible data);
 * only when that fails do we compare the in-memory candidate's parsedAt against whatever
 * resolveQuickbooks found (disk fallback or null) and keep whichever is newer.
 */
function resolveQuickbooksPreferMemory(
  properties: Property[],
  snapshotPath: string,
  inMemory: QbActuals | null,
): ResolvedQuickbooks {
  const result = resolveQuickbooks(properties, snapshotPath);
  if (result.quickbooks && result.preservedFrom === null) return result; // fresh CSV parse always wins
  if (inMemory && (!result.quickbooks || inMemory.parsedAt >= result.quickbooks.parsedAt)) {
    return { quickbooks: inMemory, preservedFrom: 'memory' };
  }
  return result;
}

/**
 * The live brain: single source of in-memory truth. Parses the workbook on demand,
 * watches it for changes, and notifies subscribers (→ SSE → client refetch).
 */
class Brain extends EventEmitter {
  /** The freshly-parsed workbook (read-only canonical), before overlay merge. */
  private base: PortfolioSnapshot | null = null;
  private snapshot: PortfolioSnapshot | null = null;
  /**
   * How the deals source degraded on the most recent parse. Held on the instance rather than read
   * per-write because `rederive()` (every UI write-back) persists WITHOUT re-parsing, so a
   * parse-local check would guard `refresh()` and leak on that second path.
   */
  private dealsDegraded: DealsDegradation | null = null;
  /** Same contract as dealsDegraded above, for the M365 To-Do source (2026-09-05). */
  private m365Degraded: M365TasksDegradation | null = null;
  private overlay: Overlay = loadOverlay();
  private state: BrainState = {
    status: 'idle',
    source: 'none',
    lastUpdated: null,
    lastError: null,
    workbookPath: workbookPath(),
    flagCount: 0,
  };

  getSnapshot(): PortfolioSnapshot | null {
    return this.snapshot;
  }
  getState(): BrainState {
    return this.state;
  }

  private setState(patch: Partial<BrainState>) {
    this.state = { ...this.state, ...patch };
    this.emit('state', this.state);
  }

  /** Parse the live workbook → cache → persist mirror. Falls back to last snapshot on error. */
  async refresh(reason = 'manual'): Promise<BrainState> {
    this.setState({ status: 'refreshing' });
    try {
      const { snapshot, flags, dealsDegraded, m365Degraded } = await parseWorkbook(workbookPath());

      // Anomaly floor: gate the in-memory ADOPTION itself, not just the disk mirror below --
      // this.snapshot is what refresh()/rederive() serve live to the UI/API, so refusing only
      // the file write would still hand every downstream reader a corrupted lease set
      // immediately. On every refresh after the first, the true previous lease set already
      // lives in memory (this.snapshot, read here before anything below reassigns it) --
      // cheaper than a disk re-read and unaffected by any OneDrive-sync race on the mirror
      // file. Only the very first refresh since server startup (this.snapshot still null) has
      // no in-memory baseline, so it falls back to the on-disk mirror from a prior session, the
      // same baseline a one-shot CLI regen would use. A refusal here is thrown so it flows
      // through the existing catch/fallback path below exactly like a parseWorkbook() failure --
      // no separate error-handling branch needed.
      let previousIds: Set<string>;
      if (this.snapshot) {
        previousIds = new Set(this.snapshot.leases.map((l) => l.id));
      } else {
        const previous = loadPreviousLeaseIds(SNAPSHOT_PATH);
        if (previous.corrupt) {
          // Not a refusal (see loadPreviousLeaseIds' doc comment -- a live server must not
          // refuse a good fresh parse just because a stale mirror is unreadable), but it must
          // not be invisible: the removed-fraction check below is about to run with no real
          // baseline, silently, unless this is logged.
          console.error(`✗ Brain.refresh: previous mirror at ${SNAPSHOT_PATH} is corrupt -- proceeding with no removed-fraction baseline for this refresh.`);
        }
        previousIds = previous.ids;
      }
      const currentIds = new Set(snapshot.leases.map((l) => l.id));
      const removedCount = [...previousIds].filter((id) => !currentIds.has(id)).length;
      const floor = evaluateAnomalyFloor(previousIds.size, currentIds.size, removedCount);
      if (floor.refuse) throw new Error(floor.reason);

      this.base = snapshot;
      // Adopted together with `base`, never before the floor gate above. Assigning it right after
      // parseWorkbook meant a floor-REFUSED parse left its degradation attached to the retained
      // clean snapshot, so every later write-back declined to mirror genuinely-live deals and logged
      // a seed-placeholder reason that was false for the snapshot being written. The field must
      // always describe the parse that was actually adopted. (Refute pass on this branch, 2 lenses.)
      this.dealsDegraded = dealsDegraded;
      this.m365Degraded = m365Degraded;
      // Roster re-check happens inside adoptSnapshot() (the parse is async and the roster can be edited
      // while it runs, so the check must be synchronous with adoption, not at parse time).
      const merged = applyOverlay(snapshot, this.overlay);
      // Attach QuickBooks actuals via resolveQuickbooks (2026-08-17 fix): a live server's refresh()
      // fires far more often than either CLI writer, so a transient read/parse failure here (a
      // OneDrive sync lock on QUICKBOOKS_CSV, a momentary schema hiccup) is MORE likely to hit,
      // not less -- and this path feeds `this.snapshot`, which persist() below writes straight to
      // the git-tracked, auto-committed mirror. Bare loadQuickbooks() would null a populated block
      // on any such failure and reproduce the exact 828-line-deletion incident this fix closed for
      // the two CLI writers, just via the server path instead. Same pattern as
      // scripts/extract-workbook.ts / scripts/lease-snapshot-drift-check.ts.
      const { quickbooks, preservedFrom } = resolveQuickbooksPreferMemory(merged.properties, SNAPSHOT_PATH, this.snapshot?.quickbooks ?? null);
      if (preservedFrom === 'memory') console.log(`ℹ Brain.refresh: no fresh QUICKBOOKS_CSV parse — kept the fresher in-memory block (parsedAt ${quickbooks!.parsedAt}) over a staler on-disk one.`);
      else if (preservedFrom) console.log(`ℹ Brain.refresh: no fresh QUICKBOOKS_CSV parse — carried forward the previous snapshot's block (parsedAt ${quickbooks!.parsedAt}) instead of nulling it.`);
      const withQb = { ...merged, quickbooks };
      // Runtime reconciliation: surface any internal inconsistency as data-quality flags.
      const rtFlags = checkSnapshot(withQb);
      const adopted = this.adoptSnapshot(rtFlags.length ? { ...withQb, dataQuality: [...withQb.dataQuality, ...rtFlags] } : withQb);
      this.persist(adopted);
      this.setState({
        status: 'fresh',
        source: 'workbook',
        lastUpdated: new Date().toISOString(),
        lastError: null,
        flagCount: adopted.dataQuality.length,
        workbookPath: workbookPath(),
      });
      this.emit('snapshot', { reason, flags: [...flags, ...rtFlags] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const recovered = this.loadFallback();
      this.setState({
        status: recovered ? 'fresh' : 'error',
        source: recovered ? 'snapshot-fallback' : 'none',
        lastError: message,
      });
      this.emit('snapshot', { reason: `${reason}:fallback`, flags: [] as DataQualityFlag[] });
    }
    return this.state;
  }

  /** Re-derive the merged snapshot from the cached base + overlay (no workbook re-parse). */
  private rederive(reason: string) {
    if (!this.base) return;
    // Same resolveQuickbooks fix as refresh() above -- this path re-runs on EVERY UI write-back
    // (a deal-stage click, a task edit), so it re-arms the null-out risk far more often than a
    // scheduled refresh alone.
    const { quickbooks, preservedFrom } = resolveQuickbooksPreferMemory(this.base.properties, SNAPSHOT_PATH, this.snapshot?.quickbooks ?? null);
    if (preservedFrom === 'memory') console.log(`ℹ Brain.rederive: no fresh QUICKBOOKS_CSV parse — kept the fresher in-memory block (parsedAt ${quickbooks!.parsedAt}) over a staler on-disk one.`);
    else if (preservedFrom) console.log(`ℹ Brain.rederive: no fresh QUICKBOOKS_CSV parse — carried forward the previous snapshot's block (parsedAt ${quickbooks!.parsedAt}) instead of nulling it.`);
    const merged = { ...applyOverlay(this.base, this.overlay), quickbooks };
    // Reconciliation is re-run here, not just in refresh(). Rebuilding from base+overlay and
    // persisting WITHOUT it meant every UI write-back rewrote the mirror carrying the same breached
    // numbers with the reconciliation flags ABSENT -- which erases conditions.ts's 'reconcile-fail'
    // critical condition (it filters entity==='reconciliation'). Breach intact, alarm gone, and
    // self-clearing on any deal-stage click. It also means the persist() gate below could not fire on
    // this path at all, so M1 and H2 are one change. `this.base` never carries rtFlags (it is the
    // pre-overlay parse result), so recomputing cannot double-add them.
    // (Catch-up sweep 2026-07-28..08-04, M1 -- found by 2 lenses.)
    const rtFlags = checkSnapshot(merged);
    const adopted = this.adoptSnapshot(
      rtFlags.length ? { ...merged, dataQuality: [...merged.dataQuality, ...rtFlags] } : merged,
    );
    void saveOverlay(this.overlay);
    this.persist(adopted);
    this.setState({ lastUpdated: new Date().toISOString() });
    this.emit('snapshot', { reason, flags: [] as DataQualityFlag[] });
  }

  /** Write-back: advance/override a deal's stage. Returns false if the deal is unknown. */
  setDealStage(dealId: string, stage: DealStage): boolean {
    if (!this.base?.deals.some((d) => d.id === dealId)) return false;
    this.overlay = { ...this.overlay, dealStages: { ...this.overlay.dealStages, [dealId]: stage } };
    this.rederive('action:deal-stage');
    return true;
  }

  /** Write-back: set a lease's renewal stage. Returns false if the lease is unknown. */
  setRenewalStage(leaseId: string, stage: RenewalStage): boolean {
    if (!this.base?.leases.some((l) => l.id === leaseId)) return false;
    this.overlay = { ...this.overlay, renewalStages: { ...this.overlay.renewalStages, [leaseId]: stage } };
    this.rederive('action:renewal-stage');
    return true;
  }

  /** Write-back: set (or clear) a tenant's free-text note. Returns false if the tenant is unknown. */
  setTenantNote(tenantId: string, note: string): boolean {
    if (!this.base) return false;
    // Only tenant IDs are consumed here, but pass the run date anyway — no call site may rely
    // on tenantScorecards' silent `?? s.meta.asOf` day-count fallback (OI-023 audit).
    const known = new Set(tenantScorecards(this.base, referenceDate()).map((t) => t.id));
    if (!known.has(tenantId)) return false;
    const notes = { ...this.overlay.tenantNotes };
    const trimmed = note.trim();
    if (trimmed) notes[tenantId] = trimmed;
    else delete notes[tenantId];
    this.overlay = { ...this.overlay, tenantNotes: notes };
    this.rederive('action:tenant-note');
    return true;
  }

  /** Write-back: cache AI-sourced comps for a deal. Returns false if the deal is unknown. */
  setDealComps(dealId: string, comps: CompSet): boolean {
    if (!this.base?.deals.some((d) => d.id === dealId)) return false;
    this.overlay = { ...this.overlay, dealComps: { ...this.overlay.dealComps, [dealId]: comps } };
    this.rederive('action:deal-comps');
    return true;
  }

  /** Write-back: persist a deal's Acquisition Workbench underwriting inputs. Returns false if unknown. */
  setAcquisitionInput(dealId: string, input: AcquisitionInput): boolean {
    if (!this.base?.deals.some((d) => d.id === dealId)) return false;
    this.overlay = { ...this.overlay, acquisitionInputs: { ...this.overlay.acquisitionInputs, [dealId]: input } };
    this.rederive('action:acquisition-input');
    return true;
  }

  /** Write-back: set the annual NOI budget for a property. Returns false if the property is unknown. */
  setNoiBudget(propertyId: string, amount: number): boolean {
    if (!this.base?.properties.some((p) => p.id === propertyId)) return false;
    this.overlay = { ...this.overlay, noiBudgets: { ...this.overlay.noiBudgets, [propertyId]: amount } };
    this.rederive('action:noi-budget');
    return true;
  }

  /** Write-back: set a lease's AR aging buckets (audit Fix #2). Returns false if the lease is unknown. */
  setTenantArrears(leaseId: string, arrears: TenantArrears): boolean {
    if (!this.base?.leases.some((l) => l.id === leaseId)) return false;
    this.overlay = { ...this.overlay, tenantArrears: { ...this.overlay.tenantArrears, [leaseId]: arrears } };
    this.rederive('action:tenant-arrears');
    return true;
  }

  /** Write-back: set a user-supplied market rent for a property key (Phase 3 leasing intelligence). */
  setMarketRent(key: string, rentPsf: number): boolean {
    if (!this.base) return false;
    const knownKeys = new Set(this.base.leases.map((l) => l.propertyKey));
    if (!knownKeys.has(key)) return false;
    const marketRents = { ...this.overlay.marketRents };
    if (rentPsf <= 0) {
      delete marketRents[key];
    } else {
      marketRents[key] = rentPsf;
    }
    this.overlay = { ...this.overlay, marketRents };
    this.rederive('action:market-rent');
    return true;
  }

  /** Write-back: append a user-created task. */
  addTask(task: Task): void {
    this.overlay = { ...this.overlay, tasks: [task, ...this.overlay.tasks] };
    this.rederive('action:add-task');
  }

  private persist(snapshot: PortfolioSnapshot) {
    // The live server keeps SERVING a deals-degraded snapshot (the UI staying up matters more than
    // the deals section being live), but it must not write those seed placeholders to the shared,
    // git-tracked portfolio.json -- that mirror is what the scheduled refresh commits and pushes,
    // and this path runs neither evaluateReconciliationGate nor requireLiveDealsSource. Declining
    // the write leaves the last good mirror in place; the next healthy refresh rewrites it.
    //
    // Gate on the RAW degradation, not only on the error-severity flag. `dealsDegradationFlag` maps
    // `not-configured` (no NOTION_TOKEN) to NO flag on purpose -- flagging it would make a dev
    // server permanently dirty -- and requireLiveDealsSource, the one guard that DOES treat a
    // missing token as "the same wipe as a failed fetch", has zero server-side callers. Gating on
    // the flag alone therefore left this writer open in precisely the mode the code documents as
    // supported: a token-less server adopts the ~6-deal seed set with no flag at all and rewrote
    // this mirror on every refresh (and every UI write-back), reproducing the 2026-08-09 wipe on a
    // file that is auto-committed unattended. ANY degradation disqualifies the SHARED mirror;
    // in-memory serving is unchanged. (2026-08-11 integrity sweep H1 -- 2 of 3 lenses, independently.)
    const dealsReason = this.dealsDegraded?.reason ?? null;
    if (dealsReason !== null || hasDealsPipelineFailure(snapshot.dataQuality)) {
      console.error(
        `✗ Brain.persist: declining to write ${SNAPSHOT_PATH} — the Notion deals pipeline is ` +
          `${dealsReason ? `degraded (${dealsReason})` : 'unavailable'}, so this snapshot's ` +
          `deals/counterparties are seed placeholders. Serving it in memory; the on-disk mirror is ` +
          `left at its last good state.`,
      );
      return;
    }
    // The same policy, for the M365 To-Do source (2026-09-05). Gated on the RAW degradation for the
    // same reason as deals: m365TasksDegradationFlag maps `not-configured` to NO flag so a Graph-less
    // dev box isn't permanently dirty, but this mirror is git-tracked and auto-committed, and a
    // Graph-less server writing it drops every live M365 row a Graph-configured writer had put there
    // -- the identical 56-row loss, just sourced from a missing credential instead of a failed fetch.
    // Serving from memory is unchanged; only the shared mirror is declined.
    const m365Reason = this.m365Degraded?.reason ?? null;
    if (m365Reason !== null || hasM365TasksFailure(snapshot.dataQuality)) {
      console.error(
        `✗ Brain.persist: declining to write ${SNAPSHOT_PATH} — the Microsoft 365 To-Do source is ` +
          `${m365Reason ? `degraded (${m365Reason})` : 'unavailable'}, so this snapshot's tasks ` +
          `section is missing every live M365 row. Serving it in memory; the on-disk mirror is ` +
          `left at its last good state.`,
      );
      return;
    }
    // The same policy again, for the OVERLAY itself (2026-09-06, refute on PR #311 -- 2 of 5 lenses,
    // independently). This is the FIFTH writer of the tracked portfolio.json, and the one the
    // overlay precondition had not reached: `this.overlay` comes from loadOverlay(), which fails
    // OPEN to EMPTY_OVERLAY on a missing, unparseable or wrong-shaped file, and rederive() merges
    // that into the mirror on EVERY UI write-back without re-parsing. A server started against an
    // absent or truncated overlay would therefore publish tenantArrears/arBalances/renewalStages/
    // dealComps/marketRents/noiBudgets as EMPTY to a git-tracked, auto-committed, auto-pushed file
    // -- the exact 2026-09-05 loss, from the one writer the CLI-side fix did not cover.
    //
    // expectEnriched, like both CLI writers: this path MERGES the overlay onto a snapshot rather
    // than populating it. Serving from memory is unchanged; only the shared mirror is declined.
    const overlayCheck = evaluateOverlayPrecondition(overlayPath(), { expectEnriched: true });
    if (overlayCheck.refuse) {
      console.error(
        `✗ Brain.persist: declining to write ${SNAPSHOT_PATH} — ${overlayCheck.reason} Serving in ` +
          `memory; the on-disk mirror is left at its last good state.`,
      );
      return;
    }
    // H2: the same reconciliation policy both CLI writers apply. PR #252 wired checkSnapshot into
    // "BOTH portfolio.json writers", but there are FOUR publication paths and this is the third -- so
    // the error-severity inconsistencies those writers REFUSE (cash total vs Σ entities, duplicate
    // property ids, near-duplicate deal rows) were still published here by every live-server refresh,
    // to a mirror that is auto-committed and pushed off-machine. This path's own comment above conceded
    // it "runs neither evaluateReconciliationGate nor requireLiveDealsSource"; that is now only true of
    // requireLiveDealsSource.
    //
    // ERROR only, never warn: warn-severity reconciliation findings are long-lived and informational,
    // and blocking on them would strand the mirror permanently. The accepted tradeoff is that a
    // genuine error DOES stall the mirror until a human fixes the workbook -- the same tradeoff #252
    // already made for the CLI writers, made visible by the console.error and backstopped by the
    // snapshot-freshness gate. Serving from memory is unchanged either way.
    // (Catch-up sweep 2026-07-28..08-04, H2 -- found by 2 of 3 lenses.)
    if (hasReconciliationError(snapshot.dataQuality)) {
      const which = snapshot.dataQuality
        .filter((f) => f.severity === 'error' && f.entity === 'reconciliation')
        .map((f) => f.field)
        .join(', ');
      console.error(
        `✗ Brain.persist: declining to write ${SNAPSHOT_PATH} — this snapshot is internally ` +
          `inconsistent (reconciliation error on: ${which}). Both CLI writers refuse the same state. ` +
          `Serving it in memory; the on-disk mirror is left at its last good state.`,
      );
      return;
    }
    // Declared outside the try so the catch below can clean it up -- a renameSync failure still
    // leaves the temp file written by writeFileSync on disk; without this it leaks a
    // `.tmp-<pid>-<timestamp>` file on every failed persist (2026-07-26 adversarial review finding).
    let tmp: string | undefined;
    try {
      mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
      // Atomic write (temp file + rename): a crash or a reader mid-read must never see a
      // truncated/partial portfolio.json -- same pattern as scripts/extract-workbook.ts and
      // scripts/lease-snapshot-drift-check.ts, which write the same file.
      tmp = `${SNAPSHOT_PATH}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmp, JSON.stringify(snapshot, null, 2));
      // Retried on the Windows AV/indexer transient lock (EPERM/EBUSY/EACCES) -- see lib/rename-retry.
      renameSyncWithRetry(tmp, SNAPSHOT_PATH);
    } catch (err) {
      // Mirror persistence is best-effort -- a write failure must not crash the live server or
      // block serving this.snapshot from memory -- but it must not be INVISIBLE either: a
      // silently-stale portfolio.json would mislead every external reader (the daily brief,
      // loadFallback() after a restart) with no trace of why. Logged, not swallowed.
      console.error(`✗ Brain.persist: failed to write ${SNAPSHOT_PATH}:`, err instanceof Error ? err.message : err);
      if (tmp) {
        try {
          unlinkSync(tmp);
        } catch {
          /* best-effort cleanup of the orphaned temp file -- the logged error above is what matters */
        }
      }
    }
  }

  /**
   * Roster-check a deals array (Hard Invariant 3). applyRosterOverride fails closed internally; if it
   * throws anyway, serving the stale verdicts is the one wrong answer, so force everything confidential.
   */
  private rosterChecked(deals: PortfolioSnapshot['deals'], where: string): PortfolioSnapshot['deals'] {
    try {
      return applyRosterOverride(deals);
    } catch (err) {
      console.error(`✗ Brain ${where}: roster check threw — forcing all deals confidential:`, err instanceof Error ? err.message : err);
      return deals.map((d) => (d.confidential ? d : { ...d, confidential: true }));
    }
  }

  /**
   * THE choke point: the only place `this.snapshot` is assigned (pinned by
   * tests/unit/brain-snapshot-chokepoint.test.ts). Every snapshot Brain serves — fresh parse, UI
   * write-back, on-disk or in-memory fallback, roster re-check — passes through here, so a deal the
   * ACTIVE roster claims can never be served confidential:false, whatever path produced it or however
   * long ago its flag was stamped (Hard Invariant 3). Idempotent (only ever false -> true), so callers
   * that already checked may pass through it again. Returns the adopted snapshot.
   */
  private adoptSnapshot(next: PortfolioSnapshot): PortfolioSnapshot {
    const adopted = { ...next, deals: this.rosterChecked(next.deals, 'adoptSnapshot') };
    this.snapshot = adopted;
    return adopted;
  }

  private loadFallback(): boolean {
    if (this.snapshot) {
      // Warm path: adopted earlier, roster may have changed since — re-adopt to re-check.
      this.adoptSnapshot(this.snapshot);
      return true;
    }
    if (!existsSync(SNAPSHOT_PATH)) return false;
    try {
      const stored = PortfolioSnapshot.parse(JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')));
      // The stored deals[] were stamped when the snapshot was written; adoptSnapshot re-checks them.
      this.adoptSnapshot(stored);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Roster-only re-check of the SERVED deals (Hard Invariant 3) — no workbook re-parse, no persist.
   * getSnapshot() returns the cached object, so without this a roster edit with no later Brain event
   * would leave deals confidential:false until the next refresh / write-back / restart.
   *
   * With a parsed `base`, deals are rebuilt from base+overlay exactly as rederive() does, so a TRANSIENT
   * fail-closed that happened AFTER the last parse (roster mid-write or briefly unreadable → everything
   * confidential) releases once the roster reads cleanly. Verdicts fixed INTO `base` at parse time
   * (parseWorkbook roster-checks deals[]) are not released here — they stay confidential until the next
   * refresh, which fails safe. With no base (snapshot served from the on-disk fallback) only the cached
   * snapshot exists, so the check is one-way (can force true, never release) until the next refresh.
   * Emits only when a verdict actually changed, so an irrelevant roster edit costs clients no refetch.
   * Logs counts only — never roster terms or deal names.
   */
  private recheckRoster(reason: string) {
    const current = this.snapshot;
    if (!current) return;
    const source = this.base ? applyOverlay(this.base, this.overlay).deals : current.deals;
    const deals = this.rosterChecked(source, `recheckRoster:${reason}`);
    // Positional, NOT keyed by deal id: nothing enforces unique Deal.id on a disk snapshot, and an id-keyed
    // Map keeps only the last row's flag, so a newly claimed row sharing an id with an already-confidential
    // one counted as unchanged and was never adopted (refute wf_2881eb22-27c / wf_dbf6e86a-30a). `deals` is
    // derived from base+overlay or from current.deals in the same order; a length mismatch means the two
    // diverged, which is itself a change worth adopting.
    const aligned = deals.length === current.deals.length;
    const tightened = aligned ? deals.filter((d, i) => d.confidential && !current.deals[i]!.confidential).length : 0;
    const released = aligned ? deals.filter((d, i) => !d.confidential && current.deals[i]!.confidential).length : 0;
    if (aligned && tightened === 0 && released === 0) return;
    this.adoptSnapshot({ ...current, deals });
    console.warn(`[brain] confidential roster changed (${reason}): ${tightened} deal(s) now confidential, ${released} released.`);
    // `action:` prefix: server/index.ts's snapshot listener skips those reasons, and it must — it writes
    // occupancy / debt time series from the snapshot on workbook refreshes only, and a roster edit can
    // land while Brain is serving a stale disk fallback. Clients still refetch via the SSE push.
    this.emit('snapshot', { reason: 'action:roster-change', flags: [] as DataQualityFlag[] });
  }

  private rosterWatcher: FSWatcher | null = null;

  /** Watch the confidential roster file; debounce bursts into one roster-only re-check. */
  private watchRoster() {
    if (this.rosterWatcher) return;
    let timer: NodeJS.Timeout | null = null;
    const schedule = (reason: string) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        this.recheckRoster(reason);
      }, ROSTER_RECHECK_DEBOUNCE_MS);
    };
    try {
      const watcher = watch(confidentialRosterPath(), { ignoreInitial: true });
      watcher.on('add', () => schedule('roster-add'));
      watcher.on('change', () => schedule('roster-change'));
      watcher.on('unlink', () => schedule('roster-unlink'));
      // ignoreInitial skips the initial scan, and the watcher is armed only after the startup refresh
      // adopted its snapshot — an edit in that gap would raise no event. 'ready' closes it.
      watcher.on('ready', () => this.recheckRoster('roster-watch-ready'));
      // An unhandled 'error' on an EventEmitter throws, and a watcher error means an event may have been
      // missed: re-check now rather than waiting out a debounce.
      watcher.on('error', (err) => {
        console.error('✗ Brain roster watcher error — re-checking roster immediately:', err instanceof Error ? err.message : err);
        if (timer) clearTimeout(timer);
        timer = null;
        this.recheckRoster('roster-watch-error');
      });
      this.rosterWatcher = watcher;
    } catch (err) {
      // Not fatal to the server, but loud: without this watcher a roster edit only lands on the next
      // refresh / write-back / restart.
      console.error('✗ Brain: could not watch the confidential roster file —', err instanceof Error ? err.message : err);
    }
  }

  /** Watch the workbook; debounce noisy save events into one refresh. */
  startWatching() {
    // Before the workbook early-return below: the roster guard does not depend on the workbook.
    this.watchRoster();
    if (!existsSync(workbookPath())) {
      this.setState({ lastError: `Workbook not found at ${workbookPath()}` });
      return;
    }
    let timer: NodeJS.Timeout | null = null;
    const watcher = watch(workbookPath(), {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 1200, pollInterval: 200 },
    });
    watcher.on('change', () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => void this.refresh('file-change'), 300);
    });
  }
}

export const brain = new Brain();
