// tests/unit/acquisitions-module-live-pipeline.test.tsx
//
// TDD for item-3: replace the amber "Seed pipeline" badge in AcquisitionsModule
// with a live Notion-synced pipeline. The badge must be gone; a "Sync from Notion"
// button must be present; and after a successful sync the status text must appear.
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
  // Default: all fetches resolve to 200 OK with an empty acq/intel body.
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    if (typeof url === 'string' && url.includes('/acq/sync/notion')) {
      return new Response(JSON.stringify({ inserted: 3, updated: 1, errors: [] }), { status: 200 });
    }
    // Stub acq/intel, scoring, and any other routes with a minimal 200.
    return new Response(JSON.stringify({}), { status: 500 });
  }));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('AcquisitionsModule — live Notion pipeline (item-3)', () => {
  it('does NOT render the amber seed-pipeline badge', () => {
    render(
      <MemoryRouter>
        <QueryClientProvider client={seededClient(DEALS)}>
          <AcquisitionsModule />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(screen.queryByText(/seed pipeline/i)).toBeNull();
    expect(screen.queryByText(/hubspot.*notion sync pending/i)).toBeNull();
  });

  it('renders a Sync from Notion button', () => {
    render(
      <MemoryRouter>
        <QueryClientProvider client={seededClient(DEALS)}>
          <AcquisitionsModule />
        </QueryClientProvider>
      </MemoryRouter>,
    );
    expect(screen.getByRole('button', { name: /sync from notion/i })).toBeTruthy();
  });

  it('shows syncing state while the request is in flight', async () => {
    let resolve!: (r: Response) => void;
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/acq/sync/notion')) {
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

    const btn = screen.getByRole('button', { name: /sync from notion/i });
    fireEvent.click(btn);

    await waitFor(() => {
      expect(btn.textContent).toMatch(/syncing/i);
    });

    resolve(new Response(JSON.stringify({ inserted: 0, updated: 0, errors: [] }), { status: 200 }));
  });

  it('shows sync result after successful sync', async () => {
    render(
      <MemoryRouter>
        <QueryClientProvider client={seededClient(DEALS)}>
          <AcquisitionsModule />
        </QueryClientProvider>
      </MemoryRouter>,
    );

    const btn = screen.getByRole('button', { name: /sync from notion/i });
    fireEvent.click(btn);

    await waitFor(() => {
      // After sync completes, some result indicator must appear.
      const result = screen.queryByText(/synced/i) ?? screen.queryByText(/inserted/i) ?? screen.queryByText(/updated/i);
      expect(result).not.toBeNull();
    });
  });

  it('shows error state when sync fails', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      if (typeof url === 'string' && url.includes('/acq/sync/notion')) {
        return new Response(JSON.stringify({ error: 'notion sync failed' }), { status: 502 });
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

    const btn = screen.getByRole('button', { name: /sync from notion/i });
    fireEvent.click(btn);

    await waitFor(() => {
      const errEl = screen.queryByText(/sync failed/i) ?? screen.queryByText(/error/i);
      expect(errEl).not.toBeNull();
    });
  });
});
