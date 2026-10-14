import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Deal } from '../../src/contracts/index';
import { mergeDeals, loadDeals } from '../../server/sources/notion-deals';
import { SEED_DEALS } from '../../src/data/seed-deals';
import { rosterClaimsDeal } from '../../server/sources/deal-declassification';
import { fetchDealComps } from '../../server/ai/comps';

// Audit findings 1 and 3 (2026-10-13): the confidential ROSTER, not a deal flag, is the source of
// record for Hard Invariant 3. A synthetic roster only — never real deal terms.
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

let dir: string;
const originalPath = process.env.CONFIDENTIAL_TERMS_PATH;
const originalPlaceholder = process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;

beforeEach(() => {
  delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  dir = mkdtempSync(join(tmpdir(), 'ora-audit-roster-'));
  const p = join(dir, 'terms.json');
  writeFileSync(p, JSON.stringify(ROSTER), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  if (originalPath === undefined) delete process.env.CONFIDENTIAL_TERMS_PATH;
  else process.env.CONFIDENTIAL_TERMS_PATH = originalPath;
  if (originalPlaceholder === undefined) delete process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER;
  else process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = originalPlaceholder;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('rosterClaimsDeal', () => {
  it('is false for a deal the active roster does not claim', () => {
    expect(rosterClaimsDeal(deal({ name: 'Clean Deal' }))).toBe(false);
  });
  it('is true on an active-group hit in any field, false for a retired group', () => {
    expect(rosterClaimsDeal(deal({ name: 'Zephyr Logistics' }))).toBe(true);
    expect(rosterClaimsDeal(deal({ nextAction: 'Call re 9900 Quarry Rd' }))).toBe(true);
    expect(rosterClaimsDeal(deal({ name: 'Obsidian Park' }))).toBe(false);
  });
  it('FAILS CLOSED on an unreadable roster', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    expect(rosterClaimsDeal(deal({ name: 'Clean Deal' }))).toBe(true);
  });
  it('FAILS CLOSED on the placeholder stand-in roster', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
    expect(rosterClaimsDeal(deal({ name: 'Clean Deal' }))).toBe(true);
  });
});

describe('mergeDeals — the roster outranks a seed confidential:false (finding 1)', () => {
  it('forces confidential when a seed-matched public deal is claimed by the roster via LIVE fields', () => {
    const out = mergeDeals(
      [deal({ id: 's1', name: 'Plain Name', notionDealId: 'DEAL-1', confidential: false })],
      [deal({ id: 'n1', name: 'Plain Name', notionDealId: 'DEAL-1', location: '9900 Quarry Rd', confidential: false })],
    );
    expect(out.find((d) => d.id === 's1')!.confidential).toBe(true);
  });

  it('forces confidential for an UNJOINED seed the roster claims', () => {
    const out = mergeDeals([deal({ id: 's2', name: 'Zephyr Logistics', confidential: false })], []);
    expect(out.find((d) => d.id === 's2')!.confidential).toBe(true);
  });

  it('keeps the seed escape hatch when no active roster group claims the deal', () => {
    const out = mergeDeals(
      [deal({ id: 's3', name: 'Known Public', notionDealId: 'DEAL-3', confidential: false })],
      [deal({ id: 'n3', name: 'Known Public', notionDealId: 'DEAL-3', confidential: false })],
    );
    expect(out.find((d) => d.id === 's3')!.confidential).toBe(false);
  });

  it('never un-flags a live row the pipeline already marked confidential (and warns)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const out = mergeDeals(
      [deal({ id: 's4', name: 'Known Public', notionDealId: 'DEAL-4', confidential: false })],
      [deal({ id: 'n4', name: 'Known Public', notionDealId: 'DEAL-4', confidential: true })],
    );
    expect(out.find((d) => d.id === 's4')!.confidential).toBe(true);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('s4'));
  });

  it('fails closed when the roster is unreadable', () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    const out = mergeDeals([deal({ id: 's5', name: 'Known Public', confidential: false })], []);
    expect(out.find((d) => d.id === 's5')!.confidential).toBe(true);
  });
});

describe('fetchDealComps — roster scan on the outbound prompt (finding 3)', () => {
  const NOW = '2026-10-13T12:00:00.000Z';
  const spy = () => {
    const calls: number[] = [];
    const f = (async () => {
      calls.push(1);
      return { ok: true, status: 200, json: async () => ({ content: [] }), text: async () => '' };
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  it('blocks a flag-false deal whose address the roster claims, before any network call', async () => {
    const { f, calls } = spy();
    const r = await fetchDealComps(
      deal({ name: 'Anonymous', location: '9900 Quarry Rd, Dayton OH', confidential: false }),
      { apiKey: 'sk-test', now: NOW, fetchImpl: f },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/confidential/i);
    expect(calls).toHaveLength(0);
  });

  it('blocks when the roster cannot be verified (fail closed)', async () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    const { f, calls } = spy();
    const r = await fetchDealComps(deal({ name: 'Clean', location: '1 Main St' }), { apiKey: 'sk-test', now: NOW, fetchImpl: f });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('uses an injected scan and lets a clean deal through to the network', async () => {
    const { f, calls } = spy();
    await fetchDealComps(deal({ name: 'Clean', location: '1 Main St' }), {
      apiKey: 'sk-test', now: NOW, fetchImpl: f, confidentialScan: () => null,
    });
    expect(calls).toHaveLength(1);
  });
});

describe('refute-pass fixes (2026-10-13)', () => {
  const NOW = '2026-10-13T12:00:00.000Z';
  const netSpy = () => {
    const calls: number[] = [];
    const f = (async () => {
      calls.push(1);
      return { ok: true, status: 200, json: async () => ({ content: [] }), text: async () => '' };
    }) as unknown as typeof fetch;
    return { f, calls };
  };

  it('comps FAILS CLOSED on the placeholder roster (previously went out with 1 network call)', async () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    process.env.CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER = '1';
    const { f, calls } = netSpy();
    const r = await fetchDealComps(deal({ name: 'Zephyr Logistics', location: '9900 Quarry Rd' }), { apiKey: 'sk-test', now: NOW, fetchImpl: f });
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('comps blocks on a whole-record roster hit the prompt never carries (owner / nextAction)', async () => {
    const { f, calls } = netSpy();
    const r = await fetchDealComps(
      deal({ name: 'Anonymous', location: '1 Main St', nextAction: 'Call re 9900 Quarry Rd' }),
      { apiKey: 'sk-test', now: NOW, fetchImpl: f, confidentialScan: () => null },
    );
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(0);
  });

  describe.each([
    ['fetch-failed', () => vi.fn().mockRejectedValue(new Error('fetch failed'))],
    ['empty-result', () => vi.fn().mockResolvedValue({ ok: true, json: async () => ({ results: [], has_more: false }), text: async () => '' })],
  ] as const)('loadDeals degraded=%s still applies the roster override', (reason, makeFetch) => {
    it('forces a roster-claimed seed confidential', async () => {
      const savedToken = process.env.NOTION_TOKEN;
      process.env.NOTION_TOKEN = 't';
      process.env.NOTION_DEALS_DATA_SOURCE = 'ds-1';
      vi.stubGlobal('fetch', makeFetch());
      try {
        const target = SEED_DEALS.find((d) => !d.confidential)!;
        const p = join(dir, 'seedroster2.json');
        writeFileSync(p, JSON.stringify({ g: { label: 'G', active: true, always: [target.name.toLowerCase()] } }), 'utf8');
        process.env.CONFIDENTIAL_TERMS_PATH = p;
        const load = await loadDeals();
        expect(load.degraded?.reason).toBe(reason);
        expect(load.deals.find((d) => d.id === target.id)!.confidential).toBe(true);
      } finally {
        vi.unstubAllGlobals();
        delete process.env.NOTION_DEALS_DATA_SOURCE;
        if (savedToken === undefined) delete process.env.NOTION_TOKEN;
        else process.env.NOTION_TOKEN = savedToken;
      }
    });
  });

  it('loadDeals degraded fallback (no NOTION_TOKEN) still applies the roster override to seeds', async () => {
    const savedToken = process.env.NOTION_TOKEN;
    delete process.env.NOTION_TOKEN;
    try {
      const target = SEED_DEALS.find((d) => !d.confidential);
      expect(target).toBeDefined();
      const p = join(dir, 'seedroster.json');
      writeFileSync(p, JSON.stringify({ g: { label: 'G', active: true, always: [target!.name.toLowerCase()] } }), 'utf8');
      process.env.CONFIDENTIAL_TERMS_PATH = p;
      const load = await loadDeals();
      expect(load.degraded?.reason).toBe('not-configured');
      expect(load.deals.find((d) => d.id === target!.id)!.confidential).toBe(true);
    } finally {
      if (savedToken === undefined) delete process.env.NOTION_TOKEN;
      else process.env.NOTION_TOKEN = savedToken;
    }
  });
});
