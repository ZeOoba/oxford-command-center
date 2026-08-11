import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, readFileSync, readdirSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { dirname, basename } from 'node:path';
import type { DealStage, RenewalStage } from '../../src/contracts/index';
import { AcquisitionInput } from '../../src/contracts/acquisition';
import type { brain as BrainSingleton } from '../../server/brain';

/**
 * Orchestration tests for the live Brain (server/brain.ts) — the in-memory single source of
 * truth for Spine A. All collaborators (workbook parse, overlay merge, runtime reconcile,
 * QuickBooks, tenant scorecards, file watcher) are mocked so we can assert the orchestration
 * itself: refresh state machine, reconcile-flag merging, snapshot persistence, fallback
 * recovery, and the write-back guards.
 */

// Shared, mutable test state — hoisted above the vi.mock factories so they can read it.
const h = vi.hoisted(() => {
  const tmp = (process.env.TMPDIR || '/tmp').replace(/\/$/, '');
  return {
    snapshotPath: `${tmp}/oxford-brain-test-${process.pid}/portfolio.json`,
    parseError: null as Error | null,
    reconcileFlags: [] as unknown[],
    /** The overlay applyOverlay last received — lets us assert write-backs mutate it. */
    lastOverlay: null as Record<string, unknown> | null,
    tenantIds: [] as string[],
    base: null as Record<string, unknown> | null,
    /** DealsLoad.degraded as parseWorkbook now reports it (2026-08-11 sweep H1). */
    dealsDegraded: null as { reason: string; detail: string } | null,
  };
});

function makeBase(): Record<string, unknown> {
  return {
    deals: [{ id: 'd1' }],
    leases: [{ id: 'l1' }],
    properties: [{ id: 'p1' }],
    dataQuality: [],
  };
}

function makeBaseWithLeaseIds(ids: string[]): Record<string, unknown> {
  return { ...makeBase(), leases: ids.map((id) => ({ id })) };
}

vi.mock('../../server/config', () => ({
  workbookPath: () => '/nonexistent/oxford-test-workbook.xlsx',
  SNAPSHOT_PATH: h.snapshotPath,
  serverPort: () => 8911,
  WORKBOOK_AS_OF: '2026-06-01',
  // setTenantNote passes the run date to tenantScorecards (OI-023) — ids-only usage, any date works.
  referenceDate: () => '2026-07-22',
}));

vi.mock('../../server/workbook/parse', () => ({
  parseWorkbook: vi.fn(async () => {
    if (h.parseError) throw h.parseError;
    return { snapshot: h.base, flags: [], dealsDegraded: h.dealsDegraded };
  }),
}));

vi.mock('../../server/overlay', () => ({
  loadOverlay: vi.fn(() => ({
    dealStages: {}, tasks: [], renewalStages: {}, tenantNotes: {},
    dealComps: {}, noiBudgets: {}, tenantArrears: {}, acquisitionInputs: {}, leaseRunAssumptions: {},
  })),
  saveOverlay: vi.fn(),
  applyOverlay: vi.fn((s: Record<string, unknown>, o: Record<string, unknown>) => {
    h.lastOverlay = o;
    return { ...s };
  }),
}));

vi.mock('../../server/reconcile-runtime', () => ({
  checkSnapshot: vi.fn(() => h.reconcileFlags),
}));

vi.mock('../../server/sources/quickbooks', () => ({
  loadQuickbooks: vi.fn(() => null),
}));

vi.mock('../../src/brain/tenants', () => ({
  tenantScorecards: vi.fn(() => h.tenantIds.map((id) => ({ id }))),
}));

vi.mock('chokidar', () => ({
  watch: vi.fn(() => ({ on: vi.fn() })),
}));

let brain: typeof BrainSingleton;

beforeEach(async () => {
  h.parseError = null;
  h.reconcileFlags = [];
  h.tenantIds = [];
  h.lastOverlay = null;
  h.base = makeBase();
  h.dealsDegraded = null;
  rmSync(h.snapshotPath, { force: true });
  vi.clearAllMocks();
  vi.resetModules();
  ({ brain } = await import('../../server/brain'));
});

afterAll(() => {
  rmSync(h.snapshotPath, { force: true });
});

/**
 * 2026-08-11 integrity sweep, H1 (found independently by 2 of 3 refuter lenses).
 *
 * PR #265 closed the seed-placeholder wipe for both CLI writers, but Brain.persist — the THIRD
 * writer of portfolio.json — gated only on hasDealsPipelineFailure(), which matches error-severity
 * flags. `not-configured` (no NOTION_TOKEN) deliberately raises NO flag so a dev server isn't
 * permanently "dirty", and requireLiveDealsSource (which does treat a missing token as the same
 * wipe as a failed fetch) has zero server-side callers. So a token-less live server deterministically
 * rewrote the git-tracked, unattended-auto-committed mirror with the ~6-deal seed set on every
 * refresh — the exact 2026-08-09 signature, reachable in normal use via a worktree env-drop.
 */
describe('Brain.persist — deals-degradation mirror guard', () => {
  it('declines the mirror write when the deals source is not configured, but keeps serving', async () => {
    h.dealsDegraded = { reason: 'not-configured', detail: 'NOTION_TOKEN is not set' };

    const state = await brain.refresh();

    // Serving is unchanged — the UI staying up matters more than the deals section being live.
    expect(state.status).toBe('fresh');
    expect(brain.getSnapshot()).not.toBeNull();
    // The shared mirror must NOT carry seed placeholders.
    expect(existsSync(h.snapshotPath)).toBe(false);
  });

  it('leaves a pre-existing good mirror byte-intact rather than overwriting it with seed', async () => {
    mkdirSync(dirname(h.snapshotPath), { recursive: true });
    const lastGood = JSON.stringify({ deals: [{ id: 'live-1' }, { id: 'live-2' }] });
    writeFileSync(h.snapshotPath, lastGood);
    h.dealsDegraded = { reason: 'not-configured', detail: 'NOTION_TOKEN is not set' };

    await brain.refresh();

    expect(readFileSync(h.snapshotPath, 'utf8')).toBe(lastGood);
  });

  it('also declines on the rederive write-back path, not just refresh', async () => {
    h.dealsDegraded = { reason: 'not-configured', detail: 'NOTION_TOKEN is not set' };
    await brain.refresh();
    expect(existsSync(h.snapshotPath)).toBe(false);

    // A UI write-back calls rederive() → persist() without re-parsing, so the degradation must be
    // remembered on the instance rather than re-derived from the parse result each time.
    brain.setDealStage('d1', 'Diligence' as DealStage);

    expect(existsSync(h.snapshotPath)).toBe(false);
  });

  it('still writes the mirror when the deals source is healthy (control)', async () => {
    h.dealsDegraded = null;

    await brain.refresh();

    expect(existsSync(h.snapshotPath)).toBe(true);
  });
});

describe('Brain.refresh', () => {
  it('parses the workbook, reaches the fresh state, and persists the mirror', async () => {
    const events: Array<{ reason: string }> = [];
    brain.on('snapshot', (e) => events.push(e as { reason: string }));

    const state = await brain.refresh();

    expect(state.status).toBe('fresh');
    expect(state.source).toBe('workbook');
    expect(state.lastError).toBeNull();
    expect(state.flagCount).toBe(0);
    expect(brain.getSnapshot()).not.toBeNull();
    // Snapshot mirror was written and is valid JSON carrying the parsed data.
    expect(existsSync(h.snapshotPath)).toBe(true);
    const persisted = JSON.parse(readFileSync(h.snapshotPath, 'utf8')) as { deals: unknown[] };
    expect(persisted.deals).toHaveLength(1);
    expect(events).toHaveLength(1);
    expect(events[0]!.reason).toBe('manual');
  });

  it('merges runtime reconcile flags into the snapshot and the flag count', async () => {
    h.reconcileFlags = [{ code: 'NOI_MISMATCH', message: 'x' }];
    await brain.refresh();
    expect(brain.getState().flagCount).toBe(1);
    expect(brain.getSnapshot()!.dataQuality).toHaveLength(1);
  });

  it('threads the refresh reason through to subscribers', async () => {
    const reasons: string[] = [];
    brain.on('snapshot', (e) => reasons.push((e as { reason: string }).reason));
    await brain.refresh('startup');
    expect(reasons).toEqual(['startup']);
  });

  it('enters the error state when parsing fails and there is no fallback', async () => {
    h.parseError = new Error('workbook locked');
    const reasons: string[] = [];
    brain.on('snapshot', (e) => reasons.push((e as { reason: string }).reason));

    const state = await brain.refresh();

    expect(state.status).toBe('error');
    expect(state.source).toBe('none');
    expect(state.lastError).toBe('workbook locked');
    expect(brain.getSnapshot()).toBeNull();
    expect(reasons).toEqual(['manual:fallback']);
  });

  it('recovers the last good snapshot when a later parse fails', async () => {
    await brain.refresh(); // seed a good snapshot
    h.parseError = new Error('transient read error');

    const state = await brain.refresh('file-change');

    expect(state.status).toBe('fresh');
    expect(state.source).toBe('snapshot-fallback');
    expect(state.lastError).toBe('transient read error');
    expect(brain.getSnapshot()).not.toBeNull();
  });
});

describe('Brain.refresh — anomaly floor', () => {
  it('refuses to adopt a 0-lease parse and keeps serving the last good in-memory snapshot', async () => {
    await brain.refresh(); // seed: leases=[l1]
    h.base = makeBaseWithLeaseIds([]);

    const state = await brain.refresh('file-change');

    expect(state.status).toBe('fresh');
    expect(state.source).toBe('snapshot-fallback');
    expect(state.lastError).toContain('0-lease');
    expect(brain.getSnapshot()!.leases).toHaveLength(1);
    // The disk mirror from the good refresh is untouched -- the bad parse never reached persist().
    const persisted = JSON.parse(readFileSync(h.snapshotPath, 'utf8')) as { leases: unknown[] };
    expect(persisted.leases).toHaveLength(1);
  });

  it('refuses to adopt a parse that removes more than 25% of the previous lease set', async () => {
    h.base = makeBaseWithLeaseIds(['l1', 'l2', 'l3', 'l4']);
    await brain.refresh();
    h.base = makeBaseWithLeaseIds(['l1']); // 3 of 4 removed = 75%

    const state = await brain.refresh('file-change');

    expect(state.status).toBe('fresh');
    expect(state.source).toBe('snapshot-fallback');
    expect(state.lastError).toContain('removed');
    expect(brain.getSnapshot()!.leases).toHaveLength(4);
  });

  it('adopts a parse at exactly the 25% removed boundary (not > 25%)', async () => {
    h.base = makeBaseWithLeaseIds(['l1', 'l2', 'l3', 'l4']);
    await brain.refresh();
    h.base = makeBaseWithLeaseIds(['l1', 'l2', 'l3']); // 1 of 4 = 25%, not >25%

    const state = await brain.refresh('file-change');

    expect(state.status).toBe('fresh');
    expect(state.source).toBe('workbook');
    expect(brain.getSnapshot()!.leases).toHaveLength(3);
  });

  it('adopts a normal parse where leases were only added', async () => {
    h.base = makeBaseWithLeaseIds(['l1']);
    await brain.refresh();
    h.base = makeBaseWithLeaseIds(['l1', 'l2']);

    const state = await brain.refresh('file-change');

    expect(state.status).toBe('fresh');
    expect(state.source).toBe('workbook');
    expect(brain.getSnapshot()!.leases).toHaveLength(2);
  });

  it('falls back to the on-disk mirror as the baseline on the very first refresh since startup', async () => {
    // Simulate a prior server session's good snapshot on disk; THIS brain instance has never
    // refreshed yet, so this.snapshot is still null and refresh() must fall back to disk.
    mkdirSync(dirname(h.snapshotPath), { recursive: true });
    writeFileSync(
      h.snapshotPath,
      JSON.stringify({ leases: Array.from({ length: 10 }, (_, i) => ({ id: `prior-${i}` })) }),
    );
    h.base = makeBaseWithLeaseIds([]); // this process's first-ever parse comes back empty

    const state = await brain.refresh();

    // No in-memory fallback exists either (this.snapshot was never set), and the disk file isn't
    // a valid PortfolioSnapshot (loadFallback() rejects it) -- genuinely nothing safe to serve.
    expect(state.status).toBe('error');
    expect(state.lastError).toContain('0-lease');
    expect(state.lastError).toContain('10');
  });

  it('logs (does not refuse) when the on-disk baseline is corrupt on the first refresh', async () => {
    mkdirSync(dirname(h.snapshotPath), { recursive: true });
    writeFileSync(h.snapshotPath, '{ not valid json at all');
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const state = await brain.refresh();

    // A corrupt stale mirror must not block adopting a good fresh parse into memory.
    expect(state.status).toBe('fresh');
    expect(state.source).toBe('workbook');
    expect(errSpy).toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0]![0])).toContain('corrupt');
    errSpy.mockRestore();
  });
});

describe('Brain.persist', () => {
  it('writes the mirror atomically -- no leftover tmp file after a successful refresh', async () => {
    await brain.refresh();
    const dir = dirname(h.snapshotPath);
    const leftovers = readdirSync(dir).filter((f) => f.includes('.tmp-'));
    expect(leftovers).toEqual([]);
    expect(existsSync(h.snapshotPath)).toBe(true);
  });

  it('logs (does not throw or corrupt the refresh outcome) when the mirror write fails', async () => {
    rmSync(h.snapshotPath, { force: true, recursive: true });
    mkdirSync(h.snapshotPath, { recursive: true }); // SNAPSHOT_PATH itself is now a directory
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    let state: Awaited<ReturnType<typeof brain.refresh>> | undefined;
    try {
      state = await brain.refresh();
    } finally {
      // Cleanup runs even if the assertions below throw, so the directory never leaks into the
      // next test's beforeEach -- but restoring/asserting on the spy happens AFTER, below.
      rmSync(h.snapshotPath, { force: true, recursive: true });
    }

    expect(state!.status).toBe('fresh');
    expect(state!.source).toBe('workbook');
    expect(errSpy).toHaveBeenCalled();
    expect(String(errSpy.mock.calls[0]![0])).toContain(basename(h.snapshotPath));
    errSpy.mockRestore();
  });
});

describe('Brain write-backs', () => {
  beforeEach(async () => {
    await brain.refresh(); // establish a base to write against
  });

  it('setDealStage rejects an unknown deal and accepts a known one', () => {
    expect(brain.setDealStage('nope', 'Closing' as DealStage)).toBe(false);

    const events: Array<{ reason: string }> = [];
    brain.on('snapshot', (e) => events.push(e as { reason: string }));
    expect(brain.setDealStage('d1', 'Closing' as DealStage)).toBe(true);
    expect(events.at(-1)!.reason).toBe('action:deal-stage');
    expect((h.lastOverlay!.dealStages as Record<string, string>).d1).toBe('Closing');
  });

  it('setRenewalStage guards on an unknown lease', () => {
    expect(brain.setRenewalStage('zzz', 'In Negotiation' as RenewalStage)).toBe(false);
    expect(brain.setRenewalStage('l1', 'In Negotiation' as RenewalStage)).toBe(true);
    expect((h.lastOverlay!.renewalStages as Record<string, string>).l1).toBe('In Negotiation');
  });

  it('setNoiBudget guards on an unknown property', () => {
    expect(brain.setNoiBudget('zzz', 250000)).toBe(false);
    expect(brain.setNoiBudget('p1', 250000)).toBe(true);
    expect((h.lastOverlay!.noiBudgets as Record<string, number>).p1).toBe(250000);
  });

  it('setTenantArrears guards on an unknown lease and persists for a known one', () => {
    const ar = { d30: 0, d60: 4000, d90: 0, d90plus: 0 };
    expect(brain.setTenantArrears('zzz', ar)).toBe(false);
    const events: Array<{ reason: string }> = [];
    brain.on('snapshot', (e) => events.push(e as { reason: string }));
    expect(brain.setTenantArrears('l1', ar)).toBe(true);
    expect(events.at(-1)!.reason).toBe('action:tenant-arrears');
    expect((h.lastOverlay!.tenantArrears as Record<string, unknown>).l1).toEqual(ar);
  });

  it('setTenantNote sets, then clears, a note for a known tenant', () => {
    h.tenantIds = ['t1'];
    expect(brain.setTenantNote('unknown', 'hi')).toBe(false);
    expect(brain.setTenantNote('t1', '  remodel pending  ')).toBe(true);
    expect((h.lastOverlay!.tenantNotes as Record<string, string>).t1).toBe('remodel pending');
    // Empty note removes the key.
    expect(brain.setTenantNote('t1', '   ')).toBe(true);
    expect((h.lastOverlay!.tenantNotes as Record<string, string>).t1).toBeUndefined();
  });

  it('setAcquisitionInput rejects an unknown deal and persists for a known one', () => {
    const input = AcquisitionInput.parse({ dealId: 'd1', clusterTier: 'entry', stabilizedYoc: 0.09 });
    expect(brain.setAcquisitionInput('nope', input)).toBe(false);

    const events: Array<{ reason: string }> = [];
    brain.on('snapshot', (e) => events.push(e as { reason: string }));
    expect(brain.setAcquisitionInput('d1', input)).toBe(true);
    expect(events.at(-1)!.reason).toBe('action:acquisition-input');
    const stored = (h.lastOverlay!.acquisitionInputs as Record<string, AcquisitionInput>).d1;
    expect(stored).toBeDefined();
    expect(stored!.clusterTier).toBe('entry');
    expect(stored!.stabilizedYoc).toBeCloseTo(0.09, 9);
  });

  it('addTask prepends a user task and re-derives', () => {
    const events: Array<{ reason: string }> = [];
    brain.on('snapshot', (e) => events.push(e as { reason: string }));
    brain.addTask({
      id: 't-1', label: 'Call lender', section: 'Manual', role: null, type: 'Manual',
      dueDay: null, notes: null, status: 'pending', monthlyPmt: null,
    });
    expect(events.at(-1)!.reason).toBe('action:add-task');
    expect((h.lastOverlay!.tasks as unknown[])).toHaveLength(1);
  });
});

describe('Brain.startWatching', () => {
  it('records an error (and does not throw) when the workbook is absent', () => {
    expect(() => brain.startWatching()).not.toThrow();
    expect(brain.getState().lastError).toContain('Workbook not found');
  });
});
