import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { watch } from 'chokidar';
import { PortfolioSnapshot, type BrainState, type DataQualityFlag, type Task, type DealStage, type RenewalStage, type CompSet } from '../src/contracts/index';
import { tenantScorecards } from '../src/brain/tenants';
import { parseWorkbook } from './workbook/parse';
import { applyOverlay, loadOverlay, saveOverlay, type Overlay } from './overlay';
import { checkSnapshot } from './reconcile-runtime';
import { SNAPSHOT_PATH, WORKBOOK_PATH } from './config';

/**
 * The live brain: single source of in-memory truth. Parses the workbook on demand,
 * watches it for changes, and notifies subscribers (→ SSE → client refetch).
 */
class Brain extends EventEmitter {
  /** The freshly-parsed workbook (read-only canonical), before overlay merge. */
  private base: PortfolioSnapshot | null = null;
  private snapshot: PortfolioSnapshot | null = null;
  private overlay: Overlay = loadOverlay();
  private state: BrainState = {
    status: 'idle',
    source: 'none',
    lastUpdated: null,
    lastError: null,
    workbookPath: WORKBOOK_PATH,
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
      const { snapshot, flags } = await parseWorkbook(WORKBOOK_PATH);
      this.base = snapshot;
      const merged = applyOverlay(snapshot, this.overlay);
      // Runtime reconciliation: surface any internal inconsistency as data-quality flags.
      const rtFlags = checkSnapshot(merged);
      this.snapshot = rtFlags.length ? { ...merged, dataQuality: [...merged.dataQuality, ...rtFlags] } : merged;
      this.persist(this.snapshot);
      this.setState({
        status: 'fresh',
        source: 'workbook',
        lastUpdated: new Date().toISOString(),
        lastError: null,
        flagCount: this.snapshot.dataQuality.length,
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
    this.snapshot = applyOverlay(this.base, this.overlay);
    saveOverlay(this.overlay);
    this.persist(this.snapshot);
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
    const known = new Set(tenantScorecards(this.base).map((t) => t.id));
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

  /** Write-back: append a user-created task. */
  addTask(task: Task): void {
    this.overlay = { ...this.overlay, tasks: [task, ...this.overlay.tasks] };
    this.rederive('action:add-task');
  }

  private persist(snapshot: PortfolioSnapshot) {
    try {
      mkdirSync(dirname(SNAPSHOT_PATH), { recursive: true });
      writeFileSync(SNAPSHOT_PATH, JSON.stringify(snapshot, null, 2));
    } catch {
      /* mirror persistence is best-effort */
    }
  }

  private loadFallback(): boolean {
    if (this.snapshot) return true;
    if (!existsSync(SNAPSHOT_PATH)) return false;
    try {
      this.snapshot = PortfolioSnapshot.parse(JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8')));
      return true;
    } catch {
      return false;
    }
  }

  /** Watch the workbook; debounce noisy save events into one refresh. */
  startWatching() {
    if (!existsSync(WORKBOOK_PATH)) {
      this.setState({ lastError: `Workbook not found at ${WORKBOOK_PATH}` });
      return;
    }
    let timer: NodeJS.Timeout | null = null;
    const watcher = watch(WORKBOOK_PATH, {
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
