import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { existsSync, readFileSync, rmSync } from 'node:fs';
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
    return { snapshot: h.base, flags: [] };
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
  rmSync(h.snapshotPath, { force: true });
  vi.clearAllMocks();
  vi.resetModules();
  ({ brain } = await import('../../server/brain'));
});

afterAll(() => {
  rmSync(h.snapshotPath, { force: true });
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
