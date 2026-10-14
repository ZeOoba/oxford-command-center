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

const h = vi.hoisted(() => ({ snapshotPath: '' }));

vi.mock('../../server/config', async (importOriginal) => ({
  ...(await importOriginal<typeof ConfigModule>()),
  workbookPath: () => '/nonexistent/oxford-test-workbook.xlsx',
  get SNAPSHOT_PATH() { return h.snapshotPath; },
}));
vi.mock('../../server/workbook/parse', () => ({
  parseWorkbook: vi.fn(async () => { throw new Error('workbook locked'); }),
}));
vi.mock('chokidar', () => ({ watch: vi.fn(() => ({ on: vi.fn() })) }));

let dir: string;
const originalPath = process.env.CONFIDENTIAL_TERMS_PATH;
const originalPlaceholder = process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;

/** Real, schema-valid snapshot (the tracked mirror) with deals[] replaced by synthetic rows. */
function writeFallbackSnapshot(deals: Deal[]): void {
  const base = JSON.parse(readFileSync(join(process.cwd(), 'data', 'snapshots', 'portfolio.json'), 'utf8'));
  writeFileSync(h.snapshotPath, JSON.stringify({ ...base, deals }), 'utf8');
}

beforeEach(() => {
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  dir = mkdtempSync(join(tmpdir(), 'ora-brain-fallback-'));
  const terms = join(dir, 'terms.json');
  writeFileSync(terms, JSON.stringify(ROSTER), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = terms;
  h.snapshotPath = join(dir, 'portfolio.json');
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
