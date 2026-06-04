import { useMemo } from 'react';
import { QueryClient, useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { buildAnalytics, type AnalyticsBundle } from '@analytics/index';
import { useUi } from '@/brain/ui-context';
import { fetchSnapshot, refreshSnapshot } from './client';
import { fetchMacro } from './macro';

export const SNAPSHOT_KEY = ['snapshot'] as const;

/** An open tab re-fetches the snapshot this often, so the static mirror reflects the latest
 *  hourly bake without a manual reload. On the local Brain Server this is a backstop behind the
 *  instant SSE push. */
export const SNAPSHOT_REFETCH_MS = 5 * 60_000;

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: true,
      retry: 1,
    },
  },
});

export function useSnapshot() {
  return useQuery({ queryKey: SNAPSHOT_KEY, queryFn: fetchSnapshot, refetchInterval: SNAPSHOT_REFETCH_MS });
}

/** Snapshot query + memoized derived analytics bundle. */
export function useAnalytics(): {
  isLoading: boolean;
  isError: boolean;
  analytics: AnalyticsBundle | null;
} {
  const q = useSnapshot();
  const { scenario } = useUi();
  const analytics = useMemo(
    () => (q.data ? buildAnalytics(q.data.snapshot, scenario) : null),
    [q.data, scenario],
  );
  return { isLoading: q.isLoading, isError: q.isError, analytics };
}

export function useMacro() {
  return useQuery({ queryKey: ['macro'], queryFn: fetchMacro, staleTime: 6 * 60 * 60 * 1000 });
}

export function useRefresh() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: refreshSnapshot,
    onSuccess: () => qc.invalidateQueries({ queryKey: SNAPSHOT_KEY }),
  });
}
