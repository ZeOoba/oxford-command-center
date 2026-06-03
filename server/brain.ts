import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { watch } from 'chokidar';
import { PortfolioSnapshot, type BrainState, type DataQualityFlag } from '../src/contracts/index';
import { parseWorkbook } from './workbook/parse';
import { SNAPSHOT_PATH, WORKBOOK_PATH } from './config';

/**
 * The live brain: single source of in-memory truth. Parses the workbook on demand,
 * watches it for changes, and notifies subscribers (→ SSE → client refetch).
 */
class Brain extends EventEmitter {
  private snapshot: PortfolioSnapshot | null = null;
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
      this.snapshot = snapshot;
      this.persist(snapshot);
      this.setState({
        status: 'fresh',
        source: 'workbook',
        lastUpdated: new Date().toISOString(),
        lastError: null,
        flagCount: flags.length,
      });
      this.emit('snapshot', { reason, flags });
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
