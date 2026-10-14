import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Deal } from '../../src/contracts/index';
import type * as ConfigModule from '../../server/config';
import type * as NotionDealsModule from '../../server/sources/notion-deals';

// Hard Invariant 3 regression: Brain serves a cached snapshot, and the roster was only re-applied on
// refresh / loadFallback / rederive. A roster edit with no subsequent Brain event therefore left the
// served deals confidential:false until the next refresh, write-back or restart. startWatching() now
// watches the roster file and runs a roster-only re-check (no workbook re-parse).
// Synthetic roster and synthetic deals only — never real deal terms.
const CLAIMING_ROSTER = {
  live_deal: { label: 'Live Deal', active: true, always: ['zephyr', '9900 quarry'] },
  retired_deal: { label: 'Retired Deal', active: false, always: ['obsidian'] },
};
const CLEAN_ROSTER = { live_deal: { label: 'Live Deal', active: true, always: ['nothing-matches-this'] } };
const RETIRED_ROSTER = { live_deal: { label: 'Live Deal', active: false, always: ['zephyr'] } };
const DEBOUNCE_MS = 250;

const deal = (o: Partial<Deal>): Deal => ({
  id: 'd', name: 'D', shortName: null, location: null, market: null, sf: null, buildings: null,
  stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
  lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
  notionDealId: null, confidential: false, estimatedFields: [], ...o,
});

type Handler = (...args: unknown[]) => void;
interface FakeWatcher { path: unknown; opts: unknown; handlers: Record<string, Handler[]> }

const h = vi.hoisted(() => ({
  snapshotPath: '',
  parseError: null as Error | null,
  base: null as unknown,
  /** Runs inside the mocked parseWorkbook — lets a test edit the roster MID-refresh. */
  duringParse: null as null | (() => void),
  watchers: [] as Array<{ path: unknown; opts: unknown; handlers: Record<string, Array<(...a: unknown[]) => void>> }>,
}));

vi.mock('../../server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigModule>()),
  workbookPath: () => '/nonexistent/oxford-test-workbook.xlsx',
  get SNAPSHOT_PATH() { return h.snapshotPath; },
}));
vi.mock('../../server/workbook/parse', () => ({
  parseWorkbook: vi.fn(async () => {
    // Real parseWorkbook roster-checks deals[] at parse time (loadDeals → applyRosterOverride), so the
    // verdict is fixed into `base`. Mirror that, THEN run the mid-parse hook (an edit after the check).
    const { applyRosterOverride } = await vi.importActual<typeof NotionDealsModule>('../../server/sources/notion-deals');
    const parsed = h.base as { deals: Deal[] } | null;
    const snapshot = parsed ? { ...parsed, deals: applyRosterOverride(parsed.deals) } : parsed;
    h.duringParse?.();
    if (h.parseError) throw h.parseError;
    return { snapshot, flags: [], dealsDegraded: null };
  }),
}));
vi.mock('chokidar', () => ({
  watch: vi.fn((path: unknown, opts: unknown) => {
    const w: FakeWatcher = { path, opts, handlers: {} };
    h.watchers.push(w);
    const api = {
      on: (evt: string, cb: Handler) => {
        (w.handlers[evt] ??= []).push(cb);
        return api;
      },
    };
    return api;
  }),
}));

let dir: string;
let termsFile: string;
const originalPath = process.env.CONFIDENTIAL_TERMS_PATH;
const originalPlaceholder = process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;

/** Real, schema-valid snapshot (the tracked mirror) with deals[] replaced by synthetic rows. */
function snapshotWith(deals: Deal[]): Record<string, unknown> {
  const base = JSON.parse(readFileSync(join(process.cwd(), 'data', 'snapshots', 'portfolio.json'), 'utf8')) as Record<string, unknown>;
  return { ...base, deals };
}
function setRoster(roster: unknown): void {
  writeFileSync(termsFile, JSON.stringify(roster), 'utf8');
}
const rosterWatcher = (): FakeWatcher | undefined => h.watchers.find((w) => w.path === termsFile);
/** Deliver a chokidar event to every handler the Brain registered for it, then let the debounce elapse. */
function fire(evt: string, ...args: unknown[]): void {
  const w = rosterWatcher();
  expect(w, 'Brain must have registered a watcher on the roster file').toBeDefined();
  for (const cb of w!.handlers[evt] ?? []) cb(...args);
}
function settle(): void {
  vi.advanceTimersByTime(DEBOUNCE_MS + 1);
}

beforeEach(() => {
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  dir = mkdtempSync(join(tmpdir(), 'ora-brain-roster-watch-'));
  termsFile = join(dir, 'terms.json');
  setRoster(CLEAN_ROSTER);
  process.env.CONFIDENTIAL_TERMS_PATH = termsFile;
  h.snapshotPath = join(dir, 'portfolio.json');
  h.parseError = null;
  h.duringParse = null;
  h.watchers.length = 0;
  h.base = snapshotWith([deal({ id: 'a', name: 'Zephyr Logistics' }), deal({ id: 'b', name: 'Clean Deal' })]);
  vi.resetModules();
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  if (originalPath === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = originalPath;
  if (originalPlaceholder === undefined) delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  else process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = originalPlaceholder;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function adoptCleanSnapshot({ expectClaimed = false, claimedId = 'a' } = {}) {
  const { brain } = await import('../../server/brain');
  const state = await brain.refresh('manual');
  expect(state.source).toBe('workbook');
  brain.startWatching();
  const byId = () => Object.fromEntries(brain.getSnapshot()!.deals.map((d) => [d.id, d.confidential]));
  expect(byId()[claimedId]).toBe(expectClaimed);
  return { brain, byId };
}

describe('Brain.startWatching — roster watcher registration', () => {
  it('watches the roster file even when the workbook is absent, for add/change/unlink/error', async () => {
    const { brain } = await import('../../server/brain');
    brain.startWatching(); // workbook path does not exist → early return for the WORKBOOK watcher only
    expect(brain.getState().lastError).toContain('Workbook not found');
    const w = rosterWatcher();
    expect(w).toBeDefined();
    for (const evt of ['add', 'change', 'unlink', 'error']) expect(w!.handlers[evt]?.length, evt).toBeGreaterThan(0);
  });

  it('is idempotent — a second startWatching() does not stack a second roster watcher', async () => {
    const { brain } = await import('../../server/brain');
    brain.startWatching();
    brain.startWatching();
    expect(h.watchers.filter((w) => w.path === termsFile)).toHaveLength(1);
  });
});

describe('Brain — a roster edit with NO subsequent Brain event still reaches served deals', () => {
  it('flips a served deal to confidential:true when the roster is edited to claim it', async () => {
    const { brain, byId } = await adoptCleanSnapshot();
    const events: string[] = [];
    brain.on('snapshot', (e: { reason: string }) => events.push(e.reason));

    setRoster(CLAIMING_ROSTER);
    fire('change');
    settle();

    expect(byId().a).toBe(true);
    expect(byId().b).toBe(false);
    expect(events).toEqual(['action:roster-change']);
  });

  it('debounces: nothing flips before the window elapses, and a burst coalesces to one re-check', async () => {
    const { brain, byId } = await adoptCleanSnapshot();
    const events: string[] = [];
    brain.on('snapshot', (e: { reason: string }) => events.push(e.reason));

    setRoster(CLAIMING_ROSTER);
    fire('change');
    fire('change');
    fire('add');
    expect(byId().a).toBe(false); // still inside the debounce window
    settle();

    expect(byId().a).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('does not emit (no spurious client refetch) when the edit changes no verdict', async () => {
    const { brain } = await adoptCleanSnapshot();
    const before = brain.getSnapshot();
    const events: string[] = [];
    brain.on('snapshot', (e: { reason: string }) => events.push(e.reason));

    setRoster({ ...CLEAN_ROSTER, extra: { label: 'X', active: true, always: ['also-nothing'] } });
    fire('change');
    settle();

    expect(events).toEqual([]);
    expect(brain.getSnapshot()).toBe(before);
  });

  it('catches a claim made through a non-name field (nextAction)', async () => {
    h.base = snapshotWith([deal({ id: 'a', name: 'Innocuous', nextAction: 'Call re 9900 Quarry Rd' })]);
    const { brain } = await adoptCleanSnapshot();
    setRoster(CLAIMING_ROSTER);
    fire('change');
    settle();
    expect(brain.getSnapshot()!.deals[0]!.confidential).toBe(true);
  });

  it('is a no-op (and does not throw) when no snapshot has been adopted yet', async () => {
    const { brain } = await import('../../server/brain');
    brain.startWatching();
    setRoster(CLAIMING_ROSTER);
    expect(() => { fire('change'); settle(); }).not.toThrow();
    expect(brain.getSnapshot()).toBeNull();
  });

  it('also covers a snapshot served from the on-disk fallback (no base in memory)', async () => {
    writeFileSync(h.snapshotPath, JSON.stringify(h.base), 'utf8');
    h.parseError = new Error('workbook locked');
    const { brain } = await import('../../server/brain');
    const state = await brain.refresh('manual');
    expect(state.source).toBe('snapshot-fallback');
    brain.startWatching();
    expect(brain.getSnapshot()!.deals.find((d) => d.id === 'a')!.confidential).toBe(false);

    setRoster(CLAIMING_ROSTER);
    fire('change');
    settle();
    expect(brain.getSnapshot()!.deals.find((d) => d.id === 'a')!.confidential).toBe(true);
  });
});

describe('Brain roster watcher — fail closed', () => {
  it('marks every served deal confidential when the roster file is deleted', async () => {
    const { byId } = await adoptCleanSnapshot();
    unlinkSync(termsFile);
    fire('unlink');
    settle();
    expect(byId()).toEqual({ a: true, b: true });
  });

  it('marks every served deal confidential when the roster is rewritten as unparseable JSON', async () => {
    const { byId } = await adoptCleanSnapshot();
    writeFileSync(termsFile, '{ "live_deal": { "always": [', 'utf8'); // truncated mid-write
    fire('change');
    settle();
    expect(byId()).toEqual({ a: true, b: true });
  });

  it('marks every served deal confidential when the roster is deleted, even with CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER=1', async () => {
    process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
    const { byId } = await adoptCleanSnapshot();
    unlinkSync(termsFile);
    fire('unlink');
    settle();
    expect(byId()).toEqual({ a: true, b: true });
  });

  it('recovers from a TRANSIENT unreadable roster: a later clean read releases the deals nothing claims', async () => {
    const { byId } = await adoptCleanSnapshot();
    writeFileSync(termsFile, '{ truncated', 'utf8');
    fire('change');
    settle();
    expect(byId()).toEqual({ a: true, b: true });

    setRoster(CLAIMING_ROSTER); // editor finished the write; 'zephyr' is now genuinely claimed
    fire('change');
    settle();
    expect(byId()).toEqual({ a: true, b: false });
  });

  it('a parse-time verdict stays confidential after the group is retired (fails safe) until the next refresh releases it', async () => {
    setRoster(CLAIMING_ROSTER);
    const { brain, byId } = await adoptCleanSnapshot({ expectClaimed: true }); // forced at PARSE time → fixed into base
    setRoster(RETIRED_ROSTER);
    fire('change');
    settle();
    expect(byId().a).toBe(true); // roster-only re-check never releases what the parse fixed
    await brain.refresh('file-change');
    expect(byId().a).toBe(false);
  });

  it('re-checks when the watcher reports ready (closes the gap between adoption and watcher arming)', async () => {
    const { byId } = await adoptCleanSnapshot();
    setRoster(CLAIMING_ROSTER); // edited in the arming gap: no add/change event will ever be raised for it
    fire('ready');
    expect(byId().a).toBe(true); // immediate, no debounce
  });

  it('a roster flip keeps overlay edits (rebuild from base must not revert write-backs)', async () => {
    const { brain, byId } = await adoptCleanSnapshot();
    brain.setDealStage('b', 'Diligence' as never);
    expect(brain.getSnapshot()!.deals.find((d) => d.id === 'b')!.stage).toBe('Diligence');
    setRoster(CLAIMING_ROSTER);
    fire('change');
    settle();
    expect(byId().a).toBe(true);
    expect(brain.getSnapshot()!.deals.find((d) => d.id === 'b')!.stage).toBe('Diligence');
  });

  it('re-checks IMMEDIATELY on a watcher error (an event may have been missed) — no debounce wait', async () => {
    const { byId } = await adoptCleanSnapshot();
    setRoster(CLAIMING_ROSTER);
    fire('error', new Error('EMFILE: too many open files, watch'));
    expect(byId().a).toBe(true); // no settle()
  });

  it('never logs roster terms, deal names or deal ids (ids are name slugs) while re-checking', async () => {
    h.base = snapshotWith([deal({ id: 'zephyr-logistics', name: 'Zephyr Logistics' }), deal({ id: 'clean-deal', name: 'Clean Deal' })]);
    const { brain } = await adoptCleanSnapshot({ claimedId: 'zephyr-logistics' });
    setRoster(CLAIMING_ROSTER);
    fire('change');
    settle();
    expect(brain.getSnapshot()!.deals.find((d) => d.id === 'zephyr-logistics')!.confidential).toBe(true);
    const logged = [console.warn, console.error, console.log]
      .flatMap((fn) => vi.mocked(fn).mock.calls.flat().map(String))
      .join('\n')
      .toLowerCase();
    expect(logged).not.toContain('zephyr');
    expect(logged).not.toContain('quarry');
  });
});

describe('Brain.refresh — adoption re-checks the roster (closes the in-flight-refresh race)', () => {
  it('a roster edit made WHILE the parse runs is not overwritten by the parse-time verdict', async () => {
    // parseWorkbook's own roster check ran before this edit (mocked here as "no check"); without an
    // adoption-time re-check the refresh would install confidential:false AFTER the watcher fired.
    const { brain } = await import('../../server/brain');
    h.duringParse = () => setRoster(CLAIMING_ROSTER);
    await brain.refresh('file-change');
    expect(brain.getSnapshot()!.deals.find((d) => d.id === 'a')!.confidential).toBe(true);
    expect(brain.getSnapshot()!.deals.find((d) => d.id === 'b')!.confidential).toBe(false);
  });
});
