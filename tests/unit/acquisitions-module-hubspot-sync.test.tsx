// tests/unit/acquisitions-module-hubspot-sync.test.tsx
//
// TDD: PR #203 shipped syncHubSpotPipeline() + POST /acq/sync/hubspot but never wired a
// frontend trigger — unlike the symmetric Notion sync (see
// acquisitions-module-live-pipeline.test.tsx), which has always had a "Sync from Notion"
// button. This closes that gap: a "Sync from HubSpot" button, mirroring the Notion one
// exactly (own sync state, same POST-and-invalidate-query flow).
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import type { Deal } from '../../src/contracts/deal';
import { AcquisitionsModule } from '../../src/modules/acquisitions/AcquisitionsModule';

function makeDeal(partial: Partial<Deal> & Pick<Deal, 'id' | 'name' | 'stage'>): Deal {
  return {
    shortName: null, location: null, market: null, sf: null, buildings: null,
    estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null,
    lender: null, status: null, nextAction: null, owner: null, targetCloseDate: null,
    notionDealId: null, confidential: false, estimatedFields: [],
    ...partial,
  };
}

function seededClient(deals: Deal[]): QueryClient {
  const qc = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity, gcTime: Infinity } },
  });
  qc.setQueryData(['snapshot'], {
    snapshot: { deals, acquisitionInputs: {} } as never,
    state: {} as never,
  });
  return qc;
}

const DEALS = [
  makeDeal({ id: 'a1', name: 'Test Deal', stage: 'Candidate', capRate: 0.08 }),
];

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/acq/sync/hubspot')) {
      return new Response(JSON.stringify({ inserted: 4, updated: 0, errors: [] }), { status: 200 });
    }
    return new Response(JSON.stringify({}), { status: 500 });
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AcquisitionsModule — Sync from HubSpot button (closes the missing-trigger gap)', () => {
  it('renders a Sync from HubSpot button', () => {
    render(
      <MemoryRouter>
        <QueryClientProvider client={seededClient(DEALS)}>
          <AcquisitionsModule />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /sync from hubspot/i })).toBeTruthy();
  });

  it('posts to /acq/sync/hubspot and shows syncing state while in flight', async () => {
    let resolve!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/acq/sync/hubspot')) {
        return new Promise<Response>((res) => { resolve = res; });
      }
      return new Response('{}', { status: 500 });
    }));

    render(
      <MemoryRouter>
        <QueryClientProvider client={seededClient(DEALS)}>
          <AcquisitionsModule />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const btn = screen.getByRole('button', { name: /sync from hubspot/i });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(btn.textContent).toMatch(/syncing/i);
    });

    resolve(new Response(JSON.stringify({ inserted: 0, updated: 0, errors: [] }), { status: 200 }));
  });

  it('shows sync result after a successful sync', async () => {
    render(
      <MemoryRouter>
        <QueryClientProvider client={seededClient(DEALS)}>
          <AcquisitionsModule />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const btn = screen.getByRole('button', { name: /sync from hubspot/i });
    fireEvent.click(btn);

    await waitFor(() => {
      const result = screen.queryByText(/synced/i) ?? screen.queryByText(/inserted/i) ?? screen.queryByText(/updated/i);
      expect(result).not.toBeNull();
    });
  });

  it('shows error state when sync fails (e.g. HUBSPOT_TOKEN not configured)', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/acq/sync/hubspot')) {
        return new Response(JSON.stringify({ error: 'HUBSPOT_TOKEN not configured' }), { status: 400 });
      }
      return new Response('{}', { status: 500 });
    }));

    render(
      <MemoryRouter>
        <QueryClientProvider client={seededClient(DEALS)}>
          <AcquisitionsModule />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const btn = screen.getByRole('button', { name: /sync from hubspot/i });
    fireEvent.click(btn);

    await waitFor(() => {
      const errEl = screen.queryByText(/sync failed/i) ?? screen.queryByText(/error/i) ?? screen.queryByText(/HUBSPOT_TOKEN/i);
      expect(errEl).not.toBeNull();
    });
  });

  it('triggering HubSpot sync does not touch Notion sync state (no state collision)', async () => {
    render(
      <MemoryRouter>
        <QueryClientProvider client={seededClient(DEALS)}>
          <AcquisitionsModule />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    const hubspotBtn = screen.getByRole('button', { name: /sync from hubspot/i });
    const notionBtn = screen.getByRole('button', { name: /sync from notion/i });

    fireEvent.click(hubspotBtn);

    await waitFor(() => {
      expect(screen.queryByText(/synced.*4 inserted/i)).not.toBeNull();
    });

    // Notion's own button/state must be completely untouched by the HubSpot sync above —
    // the default fetch mock 500s any URL that isn't /acq/sync/hubspot, so if Notion's
    // handler had fired (or the two SyncState slices collided) this would surface here.
    expect(notionBtn.textContent).toMatch(/sync from notion/i);
    expect(screen.queryByText(/sync failed/i)).toBeNull();
    expect(screen.getAllByText(/synced/i)).toHaveLength(1);
  });
});
