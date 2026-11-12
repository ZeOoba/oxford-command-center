import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { isWarehouseUnavailable } from '../../src/modules/intel/hooks';
import { PremiumHistoryCard, PREMIUM_HISTORY_KEY } from '../../src/modules/insurance/PremiumHistoryCard';

// jsdom doesn't ship ResizeObserver; BarChart's useMeasure hook requires it (same stub as
// acquisitions-best-cap.test.tsx / lease-forecast-module.test.tsx / overview-module-wiring.test.tsx).
beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
});

afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('PremiumHistoryCard', () => {
  it('renders the policy-year chart and a sparkline for each multi-term line only', () => {
    const qc = new QueryClient();
    qc.setQueryData(PREMIUM_HISTORY_KEY, {
      byYear: [{ year: 2025, premium: 154800, lines: 30 }, { year: 2026, premium: 157390, lines: 30 }],
      lines: [
        { lineKey: 'a', property: '3034 Westerville Rd', policyType: 'PCKG', terms: [{ effectiveDate: '2025-07-05', premium: 6413 }, { effectiveDate: '2026-07-05', premium: 6163 }] },
        { lineKey: 'b', property: '1100 Rarig', policyType: 'BCL', terms: [{ effectiveDate: '2026-03-19', premium: 640 }] },
      ],
    });
    render(<QueryClientProvider client={qc}><PremiumHistoryCard /></QueryClientProvider>);
    expect(screen.getByText('Premium History')).toBeTruthy();
    expect(screen.getByText(/3034 Westerville Rd/)).toBeTruthy();
    expect(screen.queryByText(/1100 Rarig/)).toBeNull();
    expect(screen.getByText('-3.9%')).toBeTruthy();
  });

  // Review fix (2026-09-23 review, Task 25, Important): the loading/offline/error branches
  // (PremiumHistoryCard.tsx ~lines 26-54) had no coverage, unlike the analogous SavingsBoard
  // branches (insurance-module.test.tsx "SavingsBoard — offline treatment on the static
  // mirror"). Each test below uses a bare (unseeded) QueryClient so the real usePremiumHistory
  // hook runs its queryFn against a stubbed global fetch, mirroring that file's pattern exactly.
  const bareClient = () => new QueryClient({ defaultOptions: { queries: { retry: false } } });

  it('shows a loading Skeleton, not a blank or resolved panel, while the report is still loading', () => {
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>(() => {})));
    const { container } = render(
      <QueryClientProvider client={bareClient()}>
        <PremiumHistoryCard />
      </QueryClientProvider>,
    );
    expect(container.querySelector('[style*="200px"]')).toBeTruthy();
    expect(screen.queryByText('Premium History')).toBeNull();
    expect(screen.queryByText('offline')).toBeNull();
  });

  it('renders an informational offline card when the report is warehouse-unavailable on the static mirror', async () => {
    // Same stub as insurance-module.test.tsx's SavingsBoard offline test: a 500 with a
    // non-JSON content-type, which fetchJson maps to WarehouseUnavailableError.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    const qc = bareClient();
    render(
      <QueryClientProvider client={qc}>
        <PremiumHistoryCard />
      </QueryClientProvider>,
    );
    // Non-vacuous precondition: the query really settled into WarehouseUnavailableError.
    await waitFor(() => expect(qc.getQueryState(PREMIUM_HISTORY_KEY)?.status).toBe('error'), { timeout: 3000 });
    expect(isWarehouseUnavailable(qc.getQueryState(PREMIUM_HISTORY_KEY)?.error)).toBe(true);

    expect(screen.getByText('Premium History')).toBeTruthy();
    expect(screen.getByText('offline')).toBeTruthy();
    expect(screen.getByText(/Premium history requires the live brain server/)).toBeTruthy();
  });

  it('renders the error card with error.message on a real (non-warehouse-unavailable) fetch failure', async () => {
    // A JSON error body on a non-503 status is a real failure per fetchJson — surfaced as a
    // thrown Error, never swallowed into WarehouseUnavailableError.
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ error: 'boom: analysis engine crashed' }), {
        status: 500,
        headers: { 'content-type': 'application/json' },
      })),
    );
    const qc = bareClient();
    render(
      <QueryClientProvider client={qc}>
        <PremiumHistoryCard />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(qc.getQueryState(PREMIUM_HISTORY_KEY)?.status).toBe('error'), { timeout: 3000 });
    expect(isWarehouseUnavailable(qc.getQueryState(PREMIUM_HISTORY_KEY)?.error)).toBe(false);

    expect(screen.getByText('Premium History')).toBeTruthy();
    expect(screen.getByText('error')).toBeTruthy();
    expect(screen.getByText('boom: analysis engine crashed')).toBeTruthy();
  });
});
