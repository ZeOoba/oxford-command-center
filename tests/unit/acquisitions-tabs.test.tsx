// tests/unit/acquisitions-tabs.test.tsx
//
// IA decongestion Phase 3 — the Pipeline tab is split: Pipeline · Workbench · Sourcing · Grader, plus
// Oxford Edge (2026-10-02 spec §8.1) as the fifth tab. KPI strip + sync toolbar stay above the strip
// (R2). Pipeline / Workbench / Sourcing are force-mounted (state survives a tab round-trip); Grader
// and Edge stay lazy (each fires its own queries), and Acquisitions on ?tab=pipeline fires no /edge/
// request (spec F11).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { act, render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Deal } from '../../src/contracts/deal';
import { AcquisitionsModule } from '../../src/modules/acquisitions/AcquisitionsModule';
import { ACQUISITIONS_TABS } from '../../src/modules/acquisitions/tabs';
import type { AcqIntelResponse } from '../../src/contracts/acquisition';
import { fourMarkets, mkMarketsResponse } from './edge-test-helpers';
import { inactivePanelIsHiddenByClass, isInInactivePanel, selectTab, tabIsSelected } from './tab-test-utils';

function makeDeal(partial: Partial<Deal> & Pick<Deal, 'id' | 'name' | 'stage'>): Deal {
  return {
    shortName: null, location: null, market: null, sf: null, buildings: null,
    estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
    lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
    notionDealId: null, confidential: false, estimatedFields: [],
    ...partial,
  };
}

const DEALS = [makeDeal({ id: 'a1', name: 'Test Deal', stage: 'Candidate', capRate: 0.08, sf: 40000 })];

function seededClient(deals: Deal[] = DEALS): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(['snapshot'], { snapshot: { deals, acquisitionInputs: {} } as never, state: {} as never });
  return qc;
}

function renderAcq(entry = '/', deals: Deal[] = DEALS) {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={seededClient(deals)}>
        <AcquisitionsModule />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AcquisitionsModule — Phase 3 tab split', () => {
  it('renders five tabs, Pipeline selected by default, with stage bars + Active Deals visible', () => {
    renderAcq();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Pipeline', 'Workbench', 'Sourcing', 'Grader', 'Edge']);
    expect(tabIsSelected('Pipeline')).toBe(true);
    expect(isInInactivePanel(screen.getByText('Pipeline by Stage'))).toBe(false);
    expect(isInInactivePanel(screen.getByText('Est. Price'))).toBe(false); // Active Deals table header
  });

  it('keeps the KPI strip and the sync toolbar above the tab strip (visible on every tab)', () => {
    renderAcq('/?tab=grader');
    expect(isInInactivePanel(screen.getByText('Best Active Cap'))).toBe(false);
    expect(screen.getByRole('button', { name: /sync from notion/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /sync from hubspot/i })).toBeTruthy();
  });

  it('Workbench and Sourcing are hidden until their tab is selected, then reachable', () => {
    renderAcq();
    const workbench = screen.getByText('Underwriting Inputs');
    const sourcing = screen.getByText('Acquisition Intelligence');
    expect(isInInactivePanel(workbench)).toBe(true);
    expect(inactivePanelIsHiddenByClass(workbench)).toBe(true);
    expect(isInInactivePanel(sourcing)).toBe(true);

    selectTab('Workbench');
    expect(isInInactivePanel(workbench)).toBe(false);
    expect(isInInactivePanel(screen.getByText('Underwriting Inputs'))).toBe(false);
    expect(isInInactivePanel(sourcing)).toBe(true);
    expect(isInInactivePanel(screen.getByText('Pipeline by Stage'))).toBe(true);

    selectTab('Sourcing');
    expect(isInInactivePanel(screen.getByText('Acquisition Intelligence'))).toBe(false);
  });

  it('Grader stays lazy: its content is not rendered until the tab is selected', () => {
    renderAcq();
    expect(screen.queryByText('Grade an Acquisition')).toBeNull();
    selectTab('Grader');
    expect(screen.getByText('Grade an Acquisition')).toBeTruthy();
  });

  it('Edge stays lazy: its content is not rendered until the tab is selected', () => {
    renderAcq();
    expect(screen.queryByText('Oxford Edge')).toBeNull();
    selectTab('Edge');
    expect(screen.getByText('Oxford Edge')).toBeTruthy();
  });

  // The Edge query's only consumer on these tabs is RankedCandidateList (force-mounted inside the
  // Sourcing panel). The fetch stub must therefore SERVE a ranked candidate linked to a deal, or that
  // list never mounts and the F11 assertion passes vacuously.
  const COLUMBUS_DEAL = makeDeal({ id: 'a1', name: 'Test Deal', stage: 'Candidate', market: 'Columbus OH', location: 'Columbus, OH' });
  const jsonRes = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
  const INTEL: AcqIntelResponse = {
    rankedCandidates: [{
      candidate: {
        id: 'cand-1', source: 'manual', sourceBatchId: null, address: '100 Fixture Ave', county: null, state: null, market: null,
        rentableSf: null, yearBuilt: null, ownerName: null, parcelScreenScore: null, status: 'active', notionDealId: 'a1',
        createdAt: '2026-06-01T00:00:00Z', updatedAt: '2026-06-01T00:00:00Z',
      },
      latestScore: null, governorDscrCleared: null, governorLtvCleared: null, calibrationHitRate: null, scoredAt: null,
    }],
    calibrationSummary: { totalVerdicts: 0, resolvedVerdicts: 0, overallHitRate: null, wilsonLow: null, wilsonHigh: null },
    advisoryOnly: false, rulesetVersion: '1.1.0', asOf: '2026-06-14T00:00:00Z',
  };
  function stubServingCandidate() {
    vi.stubGlobal('fetch', vi.fn(async (u: unknown) => {
      const url = String(u);
      if (url.includes('/api/warehouse/acq/intel')) return jsonRes(INTEL);
      if (url.includes('/api/warehouse/edge/markets')) return jsonRes(mkMarketsResponse(fourMarkets()));
      return new Response('{}', { status: 500 });
    }));
  }
  const edgeCalls = () => vi.mocked(fetch).mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/edge/'));
  const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 50)); });

  it.each(['pipeline', 'workbench', 'grader'])('F11: Acquisitions on ?tab=%s fires no /edge/ request', async (tab) => {
    stubServingCandidate();
    renderAcq(`/?tab=${tab}`, [COLUMBUS_DEAL]);
    // Proof the consumer is mounted: the ranked list rendered the candidate (force-mounted, so present in the DOM).
    expect(await screen.findByText('100 Fixture Ave')).toBeTruthy();
    await flush(); // a late-mounting Edge fetch would have fired by now
    expect(edgeCalls()).toEqual([]);
  });

  it('arming is sticky: one /edge/markets call after Sourcing, no duplicate and no regression after returning to Pipeline', async () => {
    stubServingCandidate();
    renderAcq('/', [COLUMBUS_DEAL]);
    expect(await screen.findByText('100 Fixture Ave')).toBeTruthy();
    await flush();
    expect(edgeCalls()).toEqual([]);

    selectTab('Sourcing');
    await waitFor(() => expect(edgeCalls()).toHaveLength(1));
    expect(edgeCalls()[0]).toContain('/api/warehouse/edge/markets');
    await waitFor(() => expect(screen.getByText('3.0% · +1.8% · STALE')).toBeTruthy());

    selectTab('Pipeline');
    await flush();
    expect(edgeCalls()).toHaveLength(1); // still exactly one: no duplicate fetch
    // sticky: the column keeps its data instead of falling back to the idle placeholder
    expect(screen.getByText('3.0% · +1.8% · STALE')).toBeTruthy();
  });

  it('selecting Edge fetches the markets endpoint', async () => {
    renderAcq();
    selectTab('Edge');
    await waitFor(() =>
      expect(vi.mocked(fetch).mock.calls.some(([u]) => String(u).includes('/api/warehouse/edge/markets'))).toBe(true),
    );
  });

  it.each([
    ['workbench', 'Underwriting Inputs'],
    ['sourcing', 'Acquisition Intelligence'],
    ['grader', 'Grade an Acquisition'],
    ['edge', 'Oxford Edge'],
  ])('?tab=%s deep-links to that tab', (key, marker) => {
    renderAcq(`/?tab=${key}`);
    expect(screen.getByRole('tab', { name: new RegExp(`^${key}$`, 'i') }).getAttribute('aria-selected')).toBe('true');
    expect(isInInactivePanel(screen.getByText(marker))).toBe(false);
  });

  it('an unknown ?tab= falls back to Pipeline', () => {
    renderAcq('/?tab=bogus');
    expect(tabIsSelected('Pipeline')).toBe(true);
  });

  it('state survives a tab round-trip: Workbench prefill selection + draft input, Sourcing filter', () => {
    renderAcq();
    selectTab('Workbench');
    const prefill = screen.getByDisplayValue('— blank deal —') as HTMLSelectElement;
    fireEvent.change(prefill, { target: { value: 'a1' } });
    const inputs = screen.getAllByRole('spinbutton') as HTMLInputElement[];
    fireEvent.change(inputs[0]!, { target: { value: '4200000' } });
    expect(inputs[0]!.value).toBe('4200000');

    selectTab('Sourcing');
    const status = screen.getByDisplayValue('Active') as HTMLSelectElement;
    fireEvent.change(status, { target: { value: 'passed' } });

    selectTab('Pipeline');
    selectTab('Workbench');
    expect((screen.getByDisplayValue('Test Deal') as HTMLSelectElement).value).toBe('a1');
    expect((screen.getAllByRole('spinbutton')[0] as HTMLInputElement).value).toBe('4200000');
    selectTab('Sourcing');
    expect((screen.getByDisplayValue('Passed') as HTMLSelectElement).value).toBe('passed');
  });
});

describe('fix-pass 3 - Edge tab registration', () => {
  it('the edge tab declares its palette aliases', () => {
    const edge = ACQUISITIONS_TABS.find((t) => t.id === 'edge');
    expect(edge?.label).toBe('Edge');
    expect(edge?.aliases).toEqual(expect.arrayContaining(['oxford edge', 'market board', 'markets', 'pull queue', 'data health']));
  });
});
