import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Deal } from '../../src/contracts/index';
import { isDeclassified } from '../../server/sources/deal-declassification';

const deal = (o: Partial<Deal>): Deal => ({
  id: 'd', name: 'D', shortName: null, location: null, market: null, sf: null, buildings: null,
  stage: 'Candidate', estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
  lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
  confidential: false, estimatedFields: [], ...o,
});

// A synthetic roster — never the real deal terms, which live only in the gitignored, off-machine
// confidential-terms.json (Hard Invariant 3).
const ROSTER = {
  live_deal: { label: 'Live Deal', active: true, always: ['zephyr', '9900 quarry'] },
  retired_deal: { label: 'Retired Deal', active: false, always: ['obsidian'] },
};

let dir: string;
const originalPath = process.env.CONFIDENTIAL_TERMS_PATH;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'ora-declass-'));
  const p = join(dir, 'terms.json');
  writeFileSync(p, JSON.stringify(ROSTER), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = originalPath;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('isDeclassified — the allowlist can only subtract from the fail-closed default', () => {
  it('is false for a deal that is not on the allowlist (the default path)', () => {
    expect(isDeclassified(deal({ id: 'notion-anything' }), [])).toBe(false);
  });

  it('is true for an allowlisted deal the ACTIVE roster does not claim', () => {
    expect(isDeclassified(deal({ id: 'notion-clean', name: 'Clean Deal' }), ['notion-clean'])).toBe(true);
  });

  it('is false for an allowlisted deal that still matches an ACTIVE roster group — roster wins', () => {
    const d = deal({ id: 'notion-zephyr', name: 'Zephyr Logistics' });
    expect(isDeclassified(d, ['notion-zephyr'])).toBe(false);
  });

  it('matches the roster on address and counterparty, not just the deal name', () => {
    const byAddress = deal({ id: 'notion-a', name: 'Anonymous Deal', location: '9900 Quarry Rd' });
    expect(isDeclassified(byAddress, ['notion-a'])).toBe(false);
  });

  it('honors a RETIRED (active:false) roster group — that is what declassification means', () => {
    const d = deal({ id: 'notion-obsidian', name: 'Obsidian Park' });
    expect(isDeclassified(d, ['notion-obsidian'])).toBe(true);
  });

  it('FAILS CLOSED when the roster file is unreadable — allowlist goes inert', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'does-not-exist.json');
    expect(isDeclassified(deal({ id: 'notion-clean', name: 'Clean Deal' }), ['notion-clean'])).toBe(false);
  });

  it('defaults to the committed allowlist, which ships empty', async () => {
    const { PUBLIC_DEAL_IDS } = await import('../../src/data/public-deals');
    expect(PUBLIC_DEAL_IDS).toEqual([]);
    expect(isDeclassified(deal({ id: 'notion-clean' }))).toBe(false);
  });
});
