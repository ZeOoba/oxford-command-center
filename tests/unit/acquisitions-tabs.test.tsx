// tests/unit/acquisitions-tabs.test.tsx
//
// IA decongestion Phase 3 — the Pipeline tab is split: Pipeline · Workbench · Sourcing · Grader, plus
// Oxford Edge (2026-10-02 spec §8.1) as the fifth tab. KPI strip + sync toolbar stay above the strip
// (R2). Pipeline / Workbench / Sourcing are force-mounted (state survives a tab round-trip); Grader
// and Edge stay lazy (each fires its own queries), and Acquisitions on ?tab=pipeline fires no /edge/
// request (spec F11).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Deal } from '../../src/contracts/deal';
import { AcquisitionsModule } from '../../src/modules/acquisitions/AcquisitionsModule';
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

function seededClient(): QueryClient {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } } });
  qc.setQueryData(['snapshot'], { snapshot: { deals: DEALS, acquisitionInputs: {} } as never, state: {} as never });
  return qc;
}

function renderAcq(entry = '/') {
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={seededClient()}>
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

  it.each(['pipeline', 'workbench', 'grader'])('F11: Acquisitions on ?tab=%s fires no /edge/ request', async (tab) => {
    renderAcq(`/?tab=${tab}`);
    await waitFor(() => expect(fetch).toHaveBeenCalled());
    const urls = vi.mocked(fetch).mock.calls.map(([u]) => String(u));
    expect(urls.some((u) => u.includes('/edge/'))).toBe(false);
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
