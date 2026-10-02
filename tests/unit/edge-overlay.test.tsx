// tests/unit/edge-overlay.test.tsx — spec §8.4 surfaces: DealDrawer "Edge Market" card and the
// Sourcing list's Edge column; confidential deals get a readout and no deal identity reaches /edge/.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { Deal, PortfolioSnapshot } from '@contracts/index';
import type { AcqCandidateRow, RankedCandidate } from '@contracts/acquisition';
import { DealDrawer } from '../../src/brain/DealDrawer';
import { RankedCandidateList } from '../../src/modules/acquisitions/RankedCandidateList';
import { fourMarkets, mkMarketsResponse } from './edge-test-helpers';

function makeDeal(p: Partial<Deal> & Pick<Deal, 'id'>): Deal {
  return {
    name: 'Fixture Deal', shortName: null, location: null, market: null, sf: null, buildings: null, stage: 'Candidate',
    estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null, lender: null, status: null, nextAction: null,
    owner: null, targetCloseDate: null, notionDealId: null, confidential: false, estimatedFields: [], ...p,
  };
}
function makeCandidate(p: Partial<AcqCandidateRow> & Pick<AcqCandidateRow, 'id'>): RankedCandidate {
  return {
    candidate: {
      source: 'notion-pipeline', sourceBatchId: null, address: '100 Fixture Ave', county: null, state: null, market: 'established',
      rentableSf: null, yearBuilt: null, ownerName: null, parcelScreenScore: null, status: 'active', notionDealId: null,
      createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z', ...p,
    },
    latestScore: null, governorDscrCleared: null, governorLtvCleared: null, calibrationHitRate: null, scoredAt: null,
  };
}
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
function stubFetch() {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (String(url).includes('/api/warehouse/edge/markets')) return json(mkMarketsResponse(fourMarkets()));
    return new Response('{}', { status: 500 });
  }));
}
const edgeCalls = () => vi.mocked(fetch).mock.calls.filter(([u]) => String(u).includes('/edge/'));

function renderDrawer(deal: Deal) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const snapshot = { deals: [deal], dealComps: {}, acquisitionInputs: {} } as unknown as PortfolioSnapshot;
  return render(
    <QueryClientProvider client={qc}>
      <DealDrawer dealId={deal.id} snapshot={snapshot} canWrite={false} onClose={() => {}} onDraft={() => {}} onAdvanceStage={() => {}} />
    </QueryClientProvider>,
  );
}
function renderList(items: RankedCandidate[], deals: Deal[], edgeEnabled: boolean) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(['snapshot'], { snapshot: { deals, governors: null } as never, state: {} as never });
  return render(
    <QueryClientProvider client={qc}>
      <RankedCandidateList items={items} advisoryOnly={false} writesEnabled={false} edgeEnabled={edgeEnabled} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  stubFetch();
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('DealDrawer — Edge Market card', () => {
  it('Columbus OH deal → readout with STALE badge', async () => {
    renderDrawer(makeDeal({ id: 'd1', market: 'Columbus OH', location: 'Columbus, OH' }));
    expect(screen.getByText('Edge Market')).toBeTruthy();
    expect(await screen.findByText('Flex vacancy')).toBeTruthy();
    expect(screen.getByText('3.0%')).toBeTruthy();
    expect(screen.getByText('STALE')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'View in Edge' })).toBeTruthy();
  });

  it('TBD deal → No Edge market', async () => {
    renderDrawer(makeDeal({ id: 'd2', location: 'TBD' }));
    expect(await screen.findByText('No Edge market')).toBeTruthy();
  });

  it('Mid-Atlantic + Salisbury → unmatched, no Edge market', async () => {
    renderDrawer(makeDeal({ id: 'd3', market: 'Mid-Atlantic', location: 'Salisbury, MD' }));
    expect(await screen.findByText('No Edge market')).toBeTruthy();
  });

  it('conflicting market and location → No Edge market (conflicting location)', async () => {
    renderDrawer(makeDeal({ id: 'd5', market: 'Columbus OH', location: 'Columbus, IN' }));
    expect(await screen.findByText('No Edge market (conflicting location)')).toBeTruthy();
  });

  it('only the Edge Market card is a labelled region', async () => {
    renderDrawer(makeDeal({ id: 'd4', market: 'Columbus OH' }));
    expect(screen.getByRole('region', { name: 'Edge Market' })).toBeTruthy();
    expect(screen.getAllByRole('region')).toHaveLength(1);
    await screen.findByText('Flex vacancy');
  });

  it('confidential deal gets a readout and its identity never reaches /edge/', async () => {
    renderDrawer(makeDeal({ id: 'secret-deal-7', name: 'Secret', market: 'Columbus OH', confidential: true }));
    expect(await screen.findByText('Flex vacancy')).toBeTruthy();
    const calls = edgeCalls();
    expect(calls).toHaveLength(1);
    expect(String(calls[0]![0])).toBe('/api/warehouse/edge/markets');
    for (const [u, init] of calls) {
      expect(String(u)).not.toContain('secret');
      expect(init?.body ?? null).toBeNull();
    }
  });
});

describe('RankedCandidateList — Edge column', () => {
  const linked = makeDeal({ id: 'page-1', market: 'Columbus OH', location: 'Columbus, OH' });

  it('linked candidate → vacancy · rent growth; unlinked → no linked deal', async () => {
    renderList([makeCandidate({ id: 'c1', notionDealId: 'page-1' }), makeCandidate({ id: 'c2', notionDealId: null, address: '200 Other Rd' })], [linked], true);
    expect(screen.getByRole('columnheader', { name: 'Edge' })).toBeTruthy();
    expect(await screen.findByText('3.0% · +1.8% · STALE')).toBeTruthy();
    expect(screen.getByText('No Edge market (no linked deal)')).toBeTruthy();
  });

  it('candidate whose notionDealId matches Deal.id resolves; Deal.notionDealId (DEAL-n) is not the join', async () => {
    const d = makeDeal({ id: 'page-9', notionDealId: 'DEAL-3', market: 'Columbus OH' });
    renderList([makeCandidate({ id: 'c3', notionDealId: 'DEAL-3' })], [d], true);
    expect(await screen.findByText('No Edge market (no linked deal)')).toBeTruthy();
    cleanup();
    renderList([makeCandidate({ id: 'c4', notionDealId: 'page-9' })], [d], true);
    expect(await screen.findByText('3.0% · +1.8% · STALE')).toBeTruthy();
  });

  it('linked candidate whose deal has no Edge market → No Edge market', async () => {
    const d = makeDeal({ id: 'page-2', market: 'Mid-Atlantic', location: 'Salisbury, MD' });
    renderList([makeCandidate({ id: 'c5', notionDealId: 'page-2' })], [d], true);
    expect(await screen.findByText('No Edge market')).toBeTruthy();
  });

  it('errored Edge query → neutral placeholder, never "Edge dataset ok"', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    renderList([makeCandidate({ id: 'c6', notionDealId: 'page-1' })], [linked], true);
    const cell = await screen.findByText('Edge unavailable');
    expect(cell.getAttribute('title')).toBe('Edge data could not be loaded');
    expect(document.body.innerHTML).not.toContain('Edge dataset ok');
  });

  it('F11: with edgeEnabled false the column fires no /edge/ request', async () => {
    renderList([makeCandidate({ id: 'c1', notionDealId: 'page-1' })], [linked], false);
    expect(screen.getByRole('columnheader', { name: 'Edge' })).toBeTruthy();
    const ph = screen.getByText('—', { selector: 'span[title]' });
    expect(ph.getAttribute('title')).toBe('Edge market data not loaded yet');
    await new Promise((r) => setTimeout(r, 20));
    expect(edgeCalls()).toHaveLength(0);
  });

  it('enabling triggers exactly the markets request', async () => {
    renderList([makeCandidate({ id: 'c1', notionDealId: 'page-1' })], [linked], true);
    await waitFor(() => expect(edgeCalls()).toHaveLength(1));
    expect(String(edgeCalls()[0]![0])).toBe('/api/warehouse/edge/markets');
  });
});
