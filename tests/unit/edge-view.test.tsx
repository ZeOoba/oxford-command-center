// tests/unit/edge-view.test.tsx — spec §8.2 banner + error/empty states, §8.5 data health, readout.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { EdgeMarketsResponse } from '@contracts/edge';
import { EdgeView } from '../../src/modules/acquisitions/EdgeView';
import { EdgeMarketReadout } from '../../src/modules/acquisitions/EdgeMarketReadout';
import { EDGE_BOARD_DEFAULT_STATE, EDGE_KEYS } from '../../src/modules/acquisitions/edge-hooks';
import { fourMarkets, mkMarketsResponse } from './edge-test-helpers';

function client(markets?: EdgeMarketsResponse): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  if (markets) qc.setQueryData(EDGE_KEYS.markets, markets);
  return qc;
}
function renderView(markets?: EdgeMarketsResponse) {
  return render(
    <QueryClientProvider client={client(markets)}>
      <EdgeView board={EDGE_BOARD_DEFAULT_STATE} onBoardChange={() => {}} />
    </QueryClientProvider>,
  );
}
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
});
