import { describe, it, expect } from 'vitest';
import { CompSet, SaleComp, DealCompsActionInput, RECORD_COMPS_TOOL } from '../../src/contracts/comps';

describe('CompSet contract', () => {
  it('defaults all comp arrays and fills nullable comp fields', () => {
    const cs = CompSet.parse({ sourcedAt: '2026-06-05T00:00:00.000Z' });
    expect(cs.saleComps).toEqual([]);
    expect(cs.rentComps).toEqual([]);
    expect(cs.submarketStats).toEqual([]);
    expect(cs.sources).toEqual([]);
    expect(cs.summary).toBeNull();
  });

  it('parses a sale comp with sparse fields (address + source required)', () => {
    const sc = SaleComp.parse({ address: '123 Main', source: 'LoopNet' });
    expect(sc.address).toBe('123 Main');
    expect(sc.pricePerSf).toBeNull();
    expect(SaleComp.safeParse({ source: 'x' }).success).toBe(false); // address required
  });

  it('validates the action input', () => {
    expect(DealCompsActionInput.safeParse({ dealId: 'd1' }).success).toBe(true);
    expect(DealCompsActionInput.safeParse({ dealId: '' }).success).toBe(false);
  });

  it('exposes a record_comps tool schema for the model', () => {
    expect(RECORD_COMPS_TOOL.name).toBe('record_comps');
    expect(RECORD_COMPS_TOOL.input_schema.type).toBe('object');
    expect(Object.keys(RECORD_COMPS_TOOL.input_schema.properties)).toEqual(
      expect.arrayContaining(['saleComps', 'rentComps', 'submarketStats', 'summary', 'sources']),
    );
  });
});

import { fetchDealComps } from '../../server/ai/comps';
import type { Deal } from '../../src/contracts/index';

const deal = {
  id: 'd1', name: 'Test Industrial', location: '100 Main, Columbus OH', market: 'Columbus',
  sf: 50000, estPrice: 4_000_000,
} as unknown as Deal;

// A fake `fetch` returning an Anthropic-shaped JSON body with a record_comps tool_use block.
const fakeFetch = (body: unknown): typeof fetch =>
  (async () => ({ ok: true, status: 200, json: async () => body, text: async () => '' })) as unknown as typeof fetch;

const NOW = '2026-06-05T12:00:00.000Z';

describe('fetchDealComps', () => {
  it('returns an error when no API key is configured', async () => {
    const r = await fetchDealComps(deal, { apiKey: undefined, now: NOW });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/not configured/i);
  });

  it('refuses a CONFIDENTIAL deal without egressing its identity to web search (B2)', async () => {
    let called = false;
    const spyFetch = (async () => {
      called = true;
      return { ok: true, status: 200, json: async () => ({}), text: async () => '' };
    }) as unknown as typeof fetch;
    const confidentialDeal = { ...deal, confidential: true } as unknown as Deal;
    const r = await fetchDealComps(confidentialDeal, { apiKey: 'sk-test', now: NOW, fetchImpl: spyFetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/confidential/i);
    expect(called).toBe(false); // must NOT have hit the network with the deal's name/location/price
  });

  it('parses a record_comps tool_use block into a validated CompSet, stamping sourcedAt', async () => {
    const body = {
      content: [
        { type: 'text', text: 'searched' },
        { type: 'tool_use', name: 'record_comps', input: {
          saleComps: [{ address: '200 A St', price: 3_500_000, pricePerSf: 70, capRate: 0.082, source: 'LoopNet' }],
          rentComps: [{ address: '210 B St', rentPerSf: 6.5, source: 'CREXI' }],
          submarketStats: [{ label: 'Vacancy', value: '4.1%', source: 'CBRE' }],
          summary: 'Priced below comps.',
          sources: ['https://loopnet.com/x'],
        } },
      ],
    };
    const r = await fetchDealComps(deal, { apiKey: 'sk-test', now: NOW, fetchImpl: fakeFetch(body) });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.comps.sourcedAt).toBe(NOW);
      expect(r.comps.saleComps[0]!.pricePerSf).toBe(70);
      expect(r.comps.rentComps[0]!.rentPerSf).toBe(6.5);
      expect(r.comps.submarketStats[0]!.label).toBe('Vacancy');
    }
  });

  it('errors when the model returned no record_comps block', async () => {
    const r = await fetchDealComps(deal, { apiKey: 'sk-test', now: NOW, fetchImpl: fakeFetch({ content: [{ type: 'text', text: 'no comps' }] }) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/no comps/i);
  });

  it('errors on a non-OK HTTP response', async () => {
    const failFetch = (async () => ({ ok: false, status: 403, json: async () => ({}), text: async () => 'web search disabled' })) as unknown as typeof fetch;
    const r = await fetchDealComps(deal, { apiKey: 'sk-test', now: NOW, fetchImpl: failFetch });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/403/);
  });
});

describe('fetchDealComps — upstream failures do not leak raw text', () => {
  it('network error: generic message, no raw exception text', async () => {
    const f = (async () => { throw new Error('connect ECONNREFUSED 10.1.2.3:443 C:/secret/proxy.pac'); }) as unknown as typeof fetch;
    const r = await fetchDealComps(deal, { apiKey: 'sk-test', now: NOW, fetchImpl: f });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toMatch(/ECONNREFUSED|10\.1\.2\.3|secret/);
  });

  it('non-2xx: status only, upstream body not echoed', async () => {
    const f = (async () => ({ ok: false, status: 500, json: async () => ({}), text: async () => 'upstream org-id org_SECRET123 trace' })) as unknown as typeof fetch;
    const r = await fetchDealComps(deal, { apiKey: 'sk-test', now: NOW, fetchImpl: f });
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain('500');
      expect(r.error).not.toContain('org_SECRET123');
    }
  });
});
