// tests/unit/edge-view.test.tsx — spec §8.2 banner + error/empty states, §8.5 data health, readout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EdgeMarketsResponse, EdgePullQueueResponse } from '@contracts/edge';
import { EdgeView } from '../../src/modules/acquisitions/EdgeView';
import { EdgeMarketReadout } from '../../src/modules/acquisitions/EdgeMarketReadout';
import { EDGE_BOARD_DEFAULT_STATE, EDGE_KEYS, EDGE_PULL_SERIES } from '../../src/modules/acquisitions/edge-hooks';
import { fourMarkets, mkMarketsResponse } from './edge-test-helpers';

function client(markets?: EdgeMarketsResponse): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  if (markets) qc.setQueryData(EDGE_KEYS.markets, markets);
  return qc;
}
function renderView(markets?: EdgeMarketsResponse, queue?: EdgePullQueueResponse) {
  const qc = client(markets);
  if (queue) qc.setQueryData(EDGE_KEYS.pullQueue, queue);
  return render(
    <QueryClientProvider client={qc}>
      <EdgeView board={EDGE_BOARD_DEFAULT_STATE} onBoardChange={() => {}} />
    </QueryClientProvider>,
  );
}
const KINDS = ['storage', 'ios', 'mfgInvest', 'truck'] as const;
const mkQueue = (opens: number[]): EdgePullQueueResponse => ({
  today: '2026-10-02',
  automatedCoverage: { truck: [] },
  items: opens.map((open, i) => ({
    kind: KINDS[i % KINDS.length]!, label: `Synthetic pull ${i}`, cadenceDays: 90, cadenceLabel: 'Quarterly',
    scopeType: 'market' as const, why: 'synthetic', caveat: 'synthetic', counts: { open, due: 0, current: 0 }, scopes: [],
  })),
});
const never = () => new Promise<Response>(() => {});
/** The KPI tile (a Card root) that contains the label; independent of how deep the label is nested. */
const kpi = (label: string) => screen.getByText(label).closest<HTMLElement>('.overflow-hidden')!;
const empty = (availability: EdgeMarketsResponse['availability'], issues: string[] = []) =>
  mkMarketsResponse([], { availability, issues, freshness: null, coverage: [], marketCount: 0, dir: 'C:/edge/output' });

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'warehouse unavailable' }), { status: 503, headers: { 'content-type': 'application/json' } })));
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('EdgeView', () => {
  it('F1: STALE banner with the exact firm-rule copy', () => {
    renderView(mkMarketsResponse(fourMarkets()));
    expect(screen.getByText('STALE')).toBeTruthy();
    expect(screen.getByText('Edge dataset as of 2026-07-14 — 80 days old. Firm rule: a mirror more than 7 days behind is never presented as current.')).toBeTruthy();
  });

  it('fresh data shows a neutral As of badge', () => {
    const data = mkMarketsResponse(fourMarkets());
    renderView({ ...data, freshness: { ...data.freshness!, stale: false, ageDays: 1, asOf: '2026-10-01' } });
    expect(screen.getByText('As of 2026-10-01')).toBeTruthy();
    expect(screen.queryByText('STALE')).toBeNull();
  });

  it('stale by age: names where asOf came from (data pulled)', () => {
    renderView(mkMarketsResponse(fourMarkets()));
    expect(screen.getByText('data pulled 2026-07-14')).toBeTruthy();
  });

  it('stale with asOf from the file mtime → "file modified"', () => {
    const data = mkMarketsResponse(fourMarkets());
    renderView({ ...data, freshness: { ...data.freshness!, metaPulled: '2026-09-01', fileMtime: '2026-07-14T18:38:00.000Z', asOf: '2026-07-14' } });
    expect(screen.getByText('file modified 2026-07-14')).toBeTruthy();
  });

  it('stale but not by age (clock skew / unreadable date) → reason line, no self-contradicting age claim', () => {
    const data = mkMarketsResponse(fourMarkets());
    // Realistic edgeFreshness output for an unreadable mtime: asOf falls back to the valid pulled date.
    renderView({ ...data, freshness: { metaPulled: '2026-09-30', fileMtime: 'unknown', asOf: '2026-09-30', ageDays: 2, staleAfterDays: 7, stale: true } });
    expect(screen.getByText('STALE')).toBeTruthy();
    expect(screen.getByText('data pulled 2026-09-30')).toBeTruthy();
    expect(screen.getByText(/Date could not be verified \(file timestamp in the future or unreadable\) — treated as stale\./)).toBeTruthy();
    expect(screen.queryByText(/2 days old/)).toBeNull();
  });

  it('readError with no freshness still shows the readError line', () => {
    const data = mkMarketsResponse(fourMarkets(), { readError: 'EBUSY: gone', lastGoodLoadedAt: null });
    renderView({ ...data, freshness: null });
    expect(screen.getByText('Last re-read failed (EBUSY: gone); showing the copy loaded at an earlier load.')).toBeTruthy();
    expect(screen.queryByText('STALE')).toBeNull();
  });

  it('readError → red last-good line', () => {
    renderView(mkMarketsResponse(fourMarkets(), { readError: 'EBUSY: simulated', lastGoodLoadedAt: '2026-10-02T12:00:00.000Z' }));
    expect(screen.getByText('Last re-read failed (EBUSY: simulated); showing the copy loaded at 2026-10-02T12:00:00.000Z.')).toBeTruthy();
  });

  it('missing → names the dir and the env var', () => {
    renderView(empty('missing'));
    expect(screen.getByText('markets.json not found at C:/edge/output. Set OXFORD_EDGE_DIR in .env on this machine.')).toBeTruthy();
    expect(screen.queryByText('Market board')).toBeNull();
  });

  it('unreadable → OneDrive hint with the error', () => {
    renderView(empty('unreadable', ['EBUSY: resource busy']));
    expect(screen.getByText('markets.json could not be read (OneDrive lock or sync in progress?): EBUSY: resource busy. Retrying on next load.')).toBeTruthy();
  });

  it('invalid → schema message plus the first 5 issues', () => {
    renderView(empty('invalid', ['meta.fieldMeta: Required', 'b', 'c', 'd', 'e', 'f']));
    expect(screen.getByText('markets.json failed schema validation — the upstream file changed shape.')).toBeTruthy();
    expect(screen.getByText('meta.fieldMeta: Required')).toBeTruthy();
    expect(screen.getByText('e')).toBeTruthy();
    expect(screen.queryByText('f')).toBeNull();
  });

  it('rejected markets → amber note, valid markets still render', () => {
    renderView(mkMarketsResponse(fourMarkets(), { rejectedMarkets: [{ id: 'broken', reason: 'pop: Required' }] }));
    expect(screen.getByText('Rejected from markets.json: broken — pop: Required')).toBeTruthy();
    expect(screen.getByText('Market board')).toBeTruthy();
  });

  it('WarehouseUnavailableError (mirror / server down) → local-only message', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    renderView();
    expect(await screen.findByText('Edge is local-only — start the Brain Server on the workstation.')).toBeTruthy();
  });

  it('pull-queue 503: board and data health still render; queue says warehouse offline', async () => {
    renderView(mkMarketsResponse(fourMarkets()));
    expect(screen.getByText('Market board')).toBeTruthy();
    expect(screen.getByText('Data health')).toBeTruthy();
    expect(await screen.findByText('Warehouse offline — pull status unavailable')).toBeTruthy();
  });

  it('data health: proxy badges, manual-pull links, subs line, out-of-scope states', () => {
    renderView(mkMarketsResponse(fourMarkets(), { outsidePullScope: { truck: ['DC', 'ND', 'SD', 'TN'], mfgInvest: ['DC', 'ND', 'SD', 'TN'] } }));
    expect(screen.getAllByText('[PROXY]')).toHaveLength(3);
    const links = screen.getAllByRole('link', { name: 'Manual pull required' }).map((a) => a.getAttribute('href'));
    expect(links.sort()).toEqual(['#edge-pull-ios', '#edge-pull-mfgInvest', '#edge-pull-storage']);
    expect(screen.getByText('3/4 markets — 1 metro-only markets have no CoStar submarket breakdown (permanent).')).toBeTruthy();
    expect(screen.getByText('Outside pull scope — truck: DC, ND, SD, TN · mfgInvest: DC, ND, SD, TN')).toBeTruthy();
  });
});

describe('EdgeView KPI strip', () => {
  it('shows Markets loaded, Buy-box markets, Series fully real', () => {
    const data = mkMarketsResponse(fourMarkets());
    renderView(data);
    expect(within(kpi('Markets loaded')).getByText('4')).toBeTruthy();
    expect(within(kpi('Buy-box markets')).getByText('3')).toBeTruthy();
    const fully = data.coverage.filter((r) => r.pct === 1).length;
    const card = kpi('Series fully real');
    expect(within(card).getByText(String(fully))).toBeTruthy();
    expect(within(card).getByText(`of ${data.coverage.length}`)).toBeTruthy();
  });

  it('Open manual pulls sums the queue and derives the pull count from EDGE_PULL_SERIES', () => {
    renderView(mkMarketsResponse(fourMarkets()), mkQueue([2, 1]));
    const card = kpi('Open manual pulls');
    expect(within(card).getByText('3')).toBeTruthy();
    expect(within(card).getByText(`across the ${EDGE_PULL_SERIES.size} manual pulls`)).toBeTruthy();
    expect(within(card).queryByText('queue unavailable')).toBeNull();
  });

  it('Open manual pulls at zero reads 0, not unavailable', () => {
    renderView(mkMarketsResponse(fourMarkets()), mkQueue([0]));
    const card = kpi('Open manual pulls');
    expect(within(card).getByText('0')).toBeTruthy();
    expect(within(card).queryByText('queue unavailable')).toBeNull();
  });

  it('queue errored → dash and "queue unavailable"', async () => {
    renderView(mkMarketsResponse(fourMarkets()));
    expect(await within(kpi('Open manual pulls')).findByText('queue unavailable')).toBeTruthy();
    expect(within(kpi('Open manual pulls')).getByText('—')).toBeTruthy();
  });

  it('queue still loading → neutral loading sublabel, never "queue unavailable"', () => {
    vi.stubGlobal('fetch', vi.fn(never));
    renderView(mkMarketsResponse(fourMarkets()));
    const card = kpi('Open manual pulls');
    expect(within(card).getByText('loading queue…')).toBeTruthy();
    expect(within(card).queryByText('queue unavailable')).toBeNull();
  });

  it('rejected markets → amber notes (incl. no-id), board still renders, KPI counts loaded markets only', () => {
    renderView(mkMarketsResponse(fourMarkets(), { rejectedMarkets: [{ id: 'broken', reason: 'pop: Required' }, { id: null, reason: 'id: Required' }] }));
    expect(screen.getByText('Rejected from markets.json: broken — pop: Required')).toBeTruthy();
    expect(screen.getByText('Rejected from markets.json: (no id) — id: Required')).toBeTruthy();
    expect(within(kpi('Markets loaded')).getByText('4')).toBeTruthy();
    expect(within(kpi('Markets loaded')).queryByText('6')).toBeNull();
    expect(screen.getByText('Market board')).toBeTruthy();
  });

  it('missing and unreadable states are announced with role="status"', () => {
    renderView(empty('missing'));
    expect(screen.getByRole('status').textContent).toContain('markets.json not found');
    cleanup();
    renderView(empty('unreadable', ['EBUSY']));
    expect(screen.getByRole('status').textContent).toContain('could not be read');
  });

  it('status-mix line carries a legend', () => {
    renderView(mkMarketsResponse(fourMarkets()));
    expect(screen.getAllByLabelText('actual · estimated · nowcast · guide only · not published').length).toBeGreaterThan(0);
  });
});

describe('EdgeMarketReadout', () => {
  function renderReadout(deal: { market: 'Columbus OH' | null; location: string | null }, markets?: EdgeMarketsResponse) {
    return render(<QueryClientProvider client={client(markets)}><EdgeMarketReadout deal={deal} /></QueryClientProvider>);
  }

  it('matched deal → four values, STALE badge next to the numbers, View in Edge', () => {
    renderReadout({ market: 'Columbus OH', location: 'Columbus, OH' }, mkMarketsResponse(fourMarkets()));
    expect(screen.getByText('Flex vacancy')).toBeTruthy();
    expect(screen.getByText('3.0%')).toBeTruthy();
    expect(screen.getByText('+1.8%')).toBeTruthy();
    expect(screen.getByText('180 kSF')).toBeTruthy();
    expect(screen.getByText('+4.0%')).toBeTruthy();
    expect(screen.getByText('STALE')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View in Edge' })).toBeTruthy();
  });

  it('TBD deal → No Edge market + reason', () => {
    renderReadout({ market: null, location: 'TBD' }, mkMarketsResponse(fourMarkets()));
    expect(screen.getByText('No Edge market')).toBeTruthy();
    expect(screen.getByText('no parseable "City, ST" in the deal location')).toBeTruthy();
  });

  it('fresh data → neutral As of badge, no STALE', () => {
    const data = mkMarketsResponse(fourMarkets());
    renderReadout({ market: 'Columbus OH', location: 'Columbus, OH' }, { ...data, freshness: { ...data.freshness!, stale: false, ageDays: 1, asOf: '2026-10-01' } });
    expect(screen.getByText('As of 2026-10-01')).toBeTruthy();
    expect(screen.queryByText('STALE')).toBeNull();
  });

  it.each([
    ['missing', 'Edge dataset missing — open Acquisitions › Edge for detail.'],
    ['unreadable', 'Edge dataset unreadable — open Acquisitions › Edge for detail.'],
    ['invalid', 'Edge dataset invalid — open Acquisitions › Edge for detail.'],
  ] as const)('availability %s → its own message', (availability, text) => {
    renderReadout({ market: 'Columbus OH', location: 'Columbus, OH' }, empty(availability));
    expect(screen.getByText(text)).toBeTruthy();
  });

  it('no_market_for_location → calm text', () => {
    renderReadout({ market: null, location: 'Nowhere, ZZ' }, mkMarketsResponse(fourMarkets()));
    expect(screen.getByText('No Edge market')).toBeTruthy();
    expect(screen.getByText('no Edge market for this city and state')).toBeTruthy();
  });

  it('edge_id_absent → calm text', () => {
    renderReadout({ market: 'Cleveland MSA' as never, location: 'Cleveland, OH' }, mkMarketsResponse(fourMarkets()));
    expect(screen.getByText('the mapped Edge market is missing from markets.json')).toBeTruthy();
  });

  it('ambiguous city/state → calm text', () => {
    const ms = fourMarkets();
    ms.push({ ...structuredClone(ms[0]!), id: 'columbus_two' });
    renderReadout({ market: null, location: 'Columbus, OH' }, mkMarketsResponse(ms));
    expect(screen.getByText('more than one Edge market matches this city and state')).toBeTruthy();
  });

  it('placeholder series read "Pending manual pull", never 0', () => {
    const ms = fourMarkets().map((m) => ({
      ...m,
      series: { ...m.series, per: { values: [null, null, null, null, null], status: Array(5).fill('guide_only') } },
    })) as ReturnType<typeof fourMarkets>;
    renderReadout({ market: 'Columbus OH', location: 'Columbus, OH' }, mkMarketsResponse(ms));
    expect(screen.getByText(/Pending manual pull/)).toBeTruthy();
    expect(screen.queryByText(/^0$/)).toBeNull();
  });
});
