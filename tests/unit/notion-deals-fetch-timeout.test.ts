// tests/unit/notion-deals-fetch-timeout.test.ts
//
// #513 follow-up (adversarial review 2026-10-30): server/sources/notion-deals.ts bounds BOTH of its
// Notion fetches (the deals-database data-source discovery GET and the data-source query POST) with
// a 15 s AbortSignal.timeout so a hung call degrades loadDeals to the seed instead of blocking
// parseWorkbook. #513 shipped no test for either. Each test drives a fake clock and a fetch that
// settles ONLY when its signal aborts, so removing or changing either bound fails it.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadDeals } from '../../server/sources/notion-deals';
import { SEED_DEALS } from '../../src/data/seed-deals';
import { hangUntilAborted, installFakeTimeoutClock, settlesWithin } from '../support/fetch-timeout';

const ENV_KEYS = ['NOTION_TOKEN', 'NOTION_DEALS_DATA_SOURCE'] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe('loadDeals — Notion fetches are bounded at 15 s', () => {
  it('a hung data-source discovery GET degrades to the seed (fetch-failed) once 15 s elapse, and not before', async () => {
    process.env.NOTION_TOKEN = 't';
    delete process.env.NOTION_DEALS_DATA_SOURCE; // force the /databases/{id} discovery call
    const timeoutSpy = installFakeTimeoutClock();
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/databases/')) return hangUntilAborted(init);
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchStub);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const load = loadDeals();
    expect(await settlesWithin(load, 14_999)).toBe(false);
    expect(await settlesWithin(load, 2)).toBe(true);
    const out = await load;
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(String(fetchStub.mock.calls[0]![0])).toContain('/databases/');
    expect(out.degraded?.reason).toBe('fetch-failed');
    expect(out.deals).toEqual(SEED_DEALS);
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
  });

  it('a hung data-source query POST degrades to the seed (fetch-failed) once 15 s elapse, and not before', async () => {
    process.env.NOTION_TOKEN = 't';
    process.env.NOTION_DEALS_DATA_SOURCE = 'ds-1'; // skip discovery: only the query call runs
    const timeoutSpy = installFakeTimeoutClock();
    const fetchStub = vi.fn(async (url: string, init?: RequestInit) => {
      if (String(url).includes('/data_sources/ds-1/query')) return hangUntilAborted(init);
      throw new Error(`unexpected fetch ${String(url)}`);
    });
    vi.stubGlobal('fetch', fetchStub);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const load = loadDeals();
    expect(await settlesWithin(load, 14_999)).toBe(false);
    expect(await settlesWithin(load, 2)).toBe(true);
    const out = await load;
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0]![1]?.method).toBe('POST');
    expect(out.degraded?.reason).toBe('fetch-failed');
    expect(out.deals).toEqual(SEED_DEALS);
    expect(timeoutSpy).toHaveBeenCalledWith(15_000);
  });
});
