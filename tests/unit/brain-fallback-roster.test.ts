import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Deal } from '../../src/contracts/index';
import type * as ConfigModule from '../../server/config';

// Hard Invariant 3 regression (2026-10-13 re-verification, regression-sweep lens): when the workbook
// parse throws, Brain.refresh serves loadFallback()'s on-disk snapshot. A stored deal with
// confidential:false that the roster has SINCE claimed must be forced confidential before serving.
// Synthetic roster and synthetic deals only — never real deal terms.
const ROSTER = {
  live_deal: { label: 'Live Deal', active: true, always: ['zephyr', '9900 quarry'] },
  retired_deal: { label: 'Retired Deal', active: false, always: ['obsidian'] },
};

const deal = (o: Partial<Deal>): Deal => ({
  id: 'd', name: 'D', shortName: null, location: null, market: null, sf: null, buildings: null,
  stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
  lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
  notionDealId: null, confidential: false, estimatedFields: [], ...o,
});

const h = vi.hoisted(() => ({
  snapshotPath: '',
  parseError: null as Error | null,
  base: null as unknown,
  synthetic: [] as unknown[],
}));

vi.mock('../../server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigModule>()),
  workbookPath: () => '/nonexistent/oxford-test-workbook.xlsx',
  get SNAPSHOT_PATH() { return h.snapshotPath; },
}));
vi.mock('../../server/workbook/parse', () => ({
  parseWorkbook: vi.fn(async () => {
    if (h.parseError) throw h.parseError;
    return { snapshot: h.base, flags: [], dealsDegraded: null };
  }),
}));
vi.mock('chokidar', () => ({ watch: vi.fn(() => ({ on: vi.fn() })) }));
vi.mock('../../server/real-data-status', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../server/real-data-status')>()),
  syntheticDataFlags: vi.fn(() => h.synthetic),
}));

let dir: string;
const originalPath = process.env.CONFIDENTIAL_TERMS_PATH;
const originalPlaceholder = process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;

/** Real, schema-valid snapshot (the tracked mirror) with deals[] replaced by synthetic rows. */
function snapshotWith(deals: Deal[]): Record<string, unknown> {
  const base = JSON.parse(readFileSync(join(process.cwd(), 'data', 'snapshots', 'portfolio.json'), 'utf8')) as Record<string, unknown>;
  return { ...base, deals };
}
function writeFallbackSnapshot(deals: Deal[]): void {
  writeFileSync(h.snapshotPath, JSON.stringify(snapshotWith(deals)), 'utf8');
}
function setRoster(roster: unknown): void {
  writeFileSync(process.env.CONFIDENTIAL_TERMS_PATH!, JSON.stringify(roster), 'utf8');
}
const CLEAN_ROSTER = { live_deal: { label: 'Live Deal', active: true, always: ['nothing-matches-this'] } };

beforeEach(() => {
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  dir = mkdtempSync(join(tmpdir(), 'ora-brain-fallback-'));
  const terms = join(dir, 'terms.json');
  writeFileSync(terms, JSON.stringify(ROSTER), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = terms;
  h.snapshotPath = join(dir, 'portfolio.json');
  h.parseError = new Error('workbook locked');
  h.base = null;
  h.synthetic = [];
  vi.resetModules();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = originalPath;
  if (originalPlaceholder === undefined) delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  else process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = originalPlaceholder;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

async function refreshIntoFallback() {
  const { brain } = await import('../../server/brain');
  const state = await brain.refresh('manual');
  return { brain, state };
}

describe('Brain loadFallback — the roster outranks a stored confidential:false', () => {
  it('forces confidential on a stored deal the active roster now claims', async () => {
    writeFallbackSnapshot([
      deal({ id: 'a', name: 'Zephyr Logistics', confidential: false }),
      deal({ id: 'b', name: 'Clean Deal', confidential: false }),
    ]);
    const { brain, state } = await refreshIntoFallback();
    expect(state.source).toBe('snapshot-fallback');
    const byId = Object.fromEntries(brain.getSnapshot()!.deals.map((d) => [d.id, d.confidential]));
    expect(byId.a).toBe(true);
    expect(byId.b).toBe(false);
  });

  it('catches a claim made through a non-name field (nextAction)', async () => {
    writeFallbackSnapshot([deal({ id: 'a', name: 'Innocuous', nextAction: 'Call re 9900 Quarry Rd' })]);
    const { brain } = await refreshIntoFallback();
    expect(brain.getSnapshot()!.deals[0]!.confidential).toBe(true);
  });

  it('does not flag a deal only an INACTIVE roster group matches', async () => {
    writeFallbackSnapshot([deal({ id: 'a', name: 'Obsidian Park' })]);
    const { brain } = await refreshIntoFallback();
    expect(brain.getSnapshot()!.deals[0]!.confidential).toBe(false);
  });

  it('fails closed (all deals confidential) when the roster is unreadable', async () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    writeFallbackSnapshot([deal({ id: 'a', name: 'Clean Deal' })]);
    const { brain } = await refreshIntoFallback();
    expect(brain.getSnapshot()!.deals[0]!.confidential).toBe(true);
  });
});

describe('Brain — a roster change AFTER a snapshot is adopted still reaches served deals', () => {
  async function adoptCleanSnapshot() {
    setRoster(CLEAN_ROSTER);
    h.parseError = null;
    h.base = snapshotWith([deal({ id: 'a', name: 'Zephyr Logistics' }), deal({ id: 'b', name: 'Clean Deal' })]);
    const { brain, state } = await refreshIntoFallback();
    expect(state.source).toBe('workbook');
    expect(brain.getSnapshot()!.deals.find((d) => d.id === 'a')!.confidential).toBe(false);
    return brain;
  }

  it('warm fallback: in-memory snapshot is re-checked when a later parse fails', async () => {
    const brain = await adoptCleanSnapshot();
    setRoster(ROSTER); // roster now claims 'zephyr'
    h.parseError = new Error('workbook locked');
    const state = await brain.refresh('file-change');
    expect(state.source).toBe('snapshot-fallback');
    const byId = Object.fromEntries(brain.getSnapshot()!.deals.map((d) => [d.id, d.confidential]));
    expect(byId.a).toBe(true);
    expect(byId.b).toBe(false);
  });

  it('rederive: a UI write-back re-checks the roster instead of re-serving the stale flag', async () => {
    const brain = await adoptCleanSnapshot();
    setRoster(ROSTER);
    await brain.setDealStage('b', 'Diligence' as never);
    const byId = Object.fromEntries(brain.getSnapshot()!.deals.map((d) => [d.id, d.confidential]));
    expect(byId.a).toBe(true);
    expect(byId.b).toBe(false);
  });
});

describe('Brain loadFallback — cold start on synthetic stand-ins is flagged (refute 2026-11-11 review)', () => {
  it('re-derives the synthetic-data error flags for the files in place, never trusting the stored copy', async () => {
    const stale = { entity: 'data-source', field: 'old', issue: 'old is the committed SYNTHETIC stand-in, not real firm data', severity: 'error' };
    const fresh = { entity: 'data-source', field: 'data/snapshots/portfolio.json', issue: 'data/snapshots/portfolio.json is the committed SYNTHETIC stand-in, not real firm data', severity: 'error' };
    writeFileSync(h.snapshotPath, JSON.stringify({ ...snapshotWith([deal({ id: 'a' })]), dataQuality: [stale] }), 'utf8');
    h.synthetic = [fresh];
    const { brain, state } = await refreshIntoFallback();
    expect(state.source).toBe('snapshot-fallback');
    const dq = brain.getSnapshot()!.dataQuality;
    expect(dq).toContainEqual(fresh);
    expect(dq).not.toContainEqual(stale);
  });

  it('serves no synthetic flag when the files in place are real (a stale stored flag is dropped)', async () => {
    const stale = { entity: 'data-source', field: 'old', issue: 'old is the committed SYNTHETIC stand-in, not real firm data', severity: 'error' };
    writeFileSync(h.snapshotPath, JSON.stringify({ ...snapshotWith([deal({ id: 'a' })]), dataQuality: [stale] }), 'utf8');
    const { brain } = await refreshIntoFallback();
    expect(brain.getSnapshot()!.dataQuality.some((f) => f.issue.includes('SYNTHETIC stand-in'))).toBe(false);
  });
});
