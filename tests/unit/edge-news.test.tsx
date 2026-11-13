// tests/unit/edge-news.test.tsx — news overlay: server loader, GET /news, banner and board column.
// Every value is synthetic (spec F14).
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { EdgeNewsResponse } from '@contracts/edge';
import { loadEdgeNews, NEWS_FILE } from '../../server/edge/news';
import { edgeApi } from '../../server/edge/edge-api';
import { EdgeView } from '../../src/modules/acquisitions/EdgeView';
import { EDGE_BOARD_DEFAULT_STATE, EDGE_KEYS, edgeNewsLabel, formatJobsYoy, indexEdgeNews } from '../../src/modules/acquisitions/edge-hooks';
import { fourMarkets, mkMarketsResponse } from './edge-test-helpers';

const NOW = new Date('2026-10-10T12:00:00Z');
const GOOD = {
  asOf: '2026-10-08',
  headline: 'Synthetic headline.',
  entries: [
    { marketId: 'columbus', signal: 'up', jobsYoy: 0.4, note: 'Synthetic up note.' },
    { marketId: 'richmond', signal: 'down', jobsYoy: -0.7, note: 'Synthetic down note.' },
    { marketId: 'cedar_rapids', signal: 'none', jobsYoy: null, note: '' },
  ],
};
const reader = (body: unknown) => ({ readFile: () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const failing = (code: string | null) => ({
  readFile: () => {
    throw Object.assign(new Error('C:\\secret\\path boom'), code ? { code } : {});
  },
});

describe('loadEdgeNews', () => {
  it('loads a good overlay and reports it fresh', () => {
    const r = loadEdgeNews('d', NOW, reader(GOOD));
    expect(r.availability).toBe('ok');
    expect(r.asOf).toBe('2026-10-08');
    expect(r.ageDays).toBe(2);
    expect(r.stale).toBe(false);
    expect(r.entries).toHaveLength(3);
    expect(EdgeNewsResponse.safeParse(r).success).toBe(true);
  });

  it('is stale after the 7-day firm rule, not before', () => {
    expect(loadEdgeNews('d', new Date('2026-10-15T00:00:00Z'), reader(GOOD)).stale).toBe(false);
    const old = loadEdgeNews('d', new Date('2026-10-16T00:00:00Z'), reader(GOOD));
    expect(old.stale).toBe(true);
    expect(old.ageDays).toBe(8);
  });

  it('fails closed on a future or unreal asOf', () => {
    expect(loadEdgeNews('d', NOW, reader({ ...GOOD, asOf: '2026-10-20' })).stale).toBe(true);
    expect(loadEdgeNews('d', NOW, reader({ ...GOOD, asOf: '2026-02-30' })).stale).toBe(true);
  });

  it('ENOENT is missing, other I/O errors are unreadable, with no raw message or path', () => {
    expect(loadEdgeNews('d', NOW, failing('ENOENT'))).toMatchObject({ availability: 'missing', stale: true, entries: [] });
    const r = loadEdgeNews('d', NOW, failing('EBUSY'));
    expect(r.availability).toBe('unreadable');
    expect(r.issues).toEqual(['read failed (EBUSY)']);
    expect(JSON.stringify(loadEdgeNews('d', NOW, failing(null)))).not.toContain('secret');
  });

  it('bad JSON is unreadable with fixed text; schema violations are invalid with path + code only', () => {
    expect(loadEdgeNews('d', NOW, reader('{not json'))).toMatchObject({ availability: 'unreadable', issues: [`${NEWS_FILE} is not valid JSON`] });
    const bad = loadEdgeNews('d', NOW, reader({ ...GOOD, entries: [{ marketId: 'x', signal: 'sideways', jobsYoy: null, note: 'LEAK-ME' }] }));
    expect(bad.availability).toBe('invalid');
    expect(JSON.stringify(bad)).not.toContain('LEAK-ME');
  });

  it('rejects unknown keys and duplicate market ids', () => {
    expect(loadEdgeNews('d', NOW, reader({ ...GOOD, extra: 1 })).availability).toBe('invalid');
    const dup = loadEdgeNews('d', NOW, reader({ ...GOOD, entries: [GOOD.entries[0], GOOD.entries[0]] }));
    expect(dup.availability).toBe('invalid');
    expect(dup.issues[0]).toContain('entries.1.marketId');
  });

  it('only readFileSync is imported from node:fs (read-only module)', () => {
    const src = readFileSync(resolve(__dirname, '../../server/edge/news.ts'), 'utf8');
    const imports = [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'node:fs'/g)].flatMap((m) => m[1]!.split(',').map((s) => s.trim()));
    expect(imports).toEqual(['readFileSync']);
  });
});

describe('GET /api/warehouse/edge/news', () => {
  const noDb = () => {
    throw new Error('warehouse unopenable');
  };
  it('serves the overlay without a warehouse (no withDb guard)', async () => {
    const app = edgeApi(noDb as never, { edgeDir: () => 'd', now: () => NOW, newsFs: reader(GOOD) });
    const res = await app.request('/news');
    expect(res.status).toBe(200);
    expect(EdgeNewsResponse.parse(await res.json()).entries).toHaveLength(3);
  });
  it('a missing overlay is a 200 data state, not an error', async () => {
    const app = edgeApi(noDb as never, { edgeDir: () => 'd', now: () => NOW, newsFs: failing('ENOENT') });
    const res = await app.request('/news');
    expect(res.status).toBe(200);
    expect(((await res.json()) as { availability: string }).availability).toBe('missing');
  });
});

describe('news helpers', () => {
  it('labels every signal and indexes only an ok overlay', () => {
    expect(edgeNewsLabel('up').text).toBe('Improving');
    expect(edgeNewsLabel('down').text).toBe('Weakening');
    expect(edgeNewsLabel('mixed').text).toBe('Mixed');
    expect(edgeNewsLabel('none').text).toBe('No new item');
    expect(indexEdgeNews(loadEdgeNews('d', NOW, reader(GOOD))).get('richmond')?.jobsYoy).toBe(-0.7);
    expect(indexEdgeNews(loadEdgeNews('d', NOW, failing('ENOENT'))).size).toBe(0);
    expect(indexEdgeNews(null).size).toBe(0);
  });

  it('formats jobsYoy with a sign that matches the shown digits', () => {
    expect(formatJobsYoy(null)).toBe('—');
    expect(formatJobsYoy(1.25)).toBe('+1.3% jobs');
    expect(formatJobsYoy(-0.7)).toBe('-0.7% jobs');
    expect(formatJobsYoy(0.04)).toBe('0.0% jobs');
    expect(formatJobsYoy(-0.04)).toBe('0.0% jobs');
  });

  it('rejects a non-finite jobsYoy as invalid instead of showing it as not reported', () => {
    const body = JSON.stringify(GOOD).replace('-0.7', '1e999');
    expect(loadEdgeNews('d', NOW, reader(body)).availability).toBe('invalid');
  });
});

describe('EdgeView news overlay', () => {
  beforeEach(() => {
    vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'warehouse unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } })));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  function renderWith(news: ReturnType<typeof loadEdgeNews> | null) {
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
    qc.setQueryData(EDGE_KEYS.markets, mkMarketsResponse(fourMarkets()));
    if (news) qc.setQueryData(EDGE_KEYS.news, news);
    return render(
      <QueryClientProvider client={qc}>
        <EdgeView board={{ ...EDGE_BOARD_DEFAULT_STATE, set: 'all' }} onBoardChange={() => {}} />
      </QueryClientProvider>,
    );
  }

  it('fresh overlay: neutral as-of badge, headline, signal badges with jobs', () => {
    renderWith(loadEdgeNews('d', NOW, reader(GOOD)));
    expect(screen.getByText('News as of 2026-10-08')).toBeTruthy();
    expect(screen.getByText('Synthetic headline.')).toBeTruthy();
    expect(screen.getByText('Improving')).toBeTruthy();
    expect(screen.getByText('Weakening')).toBeTruthy();
    expect(screen.getByText('-0.7% jobs')).toBeTruthy();
    expect(screen.queryByText('NEWS STALE')).toBeNull();
  });

  it('stale overlay: amber NEWS STALE and every signal marked (stale), never styled as current', () => {
    renderWith(loadEdgeNews('d', new Date('2026-10-30T00:00:00Z'), reader(GOOD)));
    expect(screen.getByText('NEWS STALE')).toBeTruthy();
    expect(screen.getByText(/22 days old\. Signals are shown for reference only, never as current\./)).toBeTruthy();
    expect(screen.getByText('Improving (stale)')).toBeTruthy();
    expect(screen.queryByText('Improving')).toBeNull();
  });

  it('missing overlay: no banner and no News signal column', () => {
    renderWith(loadEdgeNews('d', NOW, failing('ENOENT')));
    expect(screen.queryByText('News signal')).toBeNull();
    expect(screen.queryByText(/News as of/)).toBeNull();
  });

  it('invalid overlay: says so and hides signals', () => {
    renderWith(loadEdgeNews('d', NOW, reader({ ...GOOD, extra: 1 })));
    expect(screen.getByText(/News overlay invalid:/)).toBeTruthy();
    expect(screen.queryByText('Improving')).toBeNull();
  });

  it('detail panel shows the sourced note for a signalled market', () => {
    renderWith(loadEdgeNews('d', NOW, reader(GOOD)));
    fireEvent.click(screen.getByLabelText('Show details for Richmond, VA'));
    expect(screen.getByText(/Synthetic down note\./)).toBeTruthy();
    // The reference month changes with every refresh; the panel must not hardcode one.
    expect(screen.getByText(/-0\.7% jobs year over year \(BLS\)\./)).toBeTruthy();
    expect(screen.queryByText(/June 2026/)).toBeNull();
  });
});
