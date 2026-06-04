import { describe, it, expect, vi, afterEach } from 'vitest';
import type { ReactNode } from 'react';
import { renderHook, act } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import * as client from '../../src/data/client';
import { useSnapshot, SNAPSHOT_REFETCH_MS } from '../../src/data/queries';

const wrap = (qc: QueryClient) =>
  ({ children }: { children: ReactNode }) => <QueryClientProvider client={qc}>{children}</QueryClientProvider>;

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

describe('useSnapshot auto-refresh', () => {
  it('exposes a 5-minute refetch interval', () => {
    expect(SNAPSHOT_REFETCH_MS).toBe(300_000);
  });

  it('re-fetches on the interval while mounted', async () => {
    vi.useFakeTimers();
    const spy = vi
      .spyOn(client, 'fetchSnapshot')
      .mockResolvedValue({ snapshot: {} as never, state: {} as never });
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    renderHook(() => useSnapshot(), { wrapper: wrap(qc) });

    await act(async () => { await vi.advanceTimersByTimeAsync(0); }); // initial fetch
    expect(spy).toHaveBeenCalledTimes(1);
    await act(async () => { await vi.advanceTimersByTimeAsync(SNAPSHOT_REFETCH_MS + 50); }); // one interval later
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});
