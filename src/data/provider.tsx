import { useEffect, useState, type ReactNode } from 'react';
import { QueryClientProvider, useQueryClient } from '@tanstack/react-query';
import type { BrainState } from '@contracts/index';
import { queryClient, SNAPSHOT_KEY, useSnapshot, useRefresh } from './queries';
import { connectBrainSSE } from './sse';
import { BrainContext } from './brain-context';
import { isStill } from '@/lib/stillMode';
import { useToast } from '@/primitives/toast-context';

function BrainBridge({ children }: { children: ReactNode }) {
  const qc = useQueryClient();
  const snapshot = useSnapshot();
  const refresh = useRefresh();
  const { toast } = useToast();
  const [liveState, setLiveState] = useState<BrainState | null>(null);

  useEffect(() => {
    if (isStill()) return; // no perpetual connection during capture
    return connectBrainSSE({
      onState: setLiveState,
      onSnapshot: () => void qc.invalidateQueries({ queryKey: SNAPSHOT_KEY }),
    });
  }, [qc]);

  const state = liveState ?? snapshot.data?.state ?? null;
  const refreshing = refresh.isPending || state?.status === 'refreshing';

  const doRefresh = () =>
    refresh.mutate(undefined, {
      onSuccess: (s) =>
        toast({ tone: 'success', title: 'Data refreshed', description: s.source === 'workbook' ? 'From the live workbook' : 'From cached snapshot' }),
      onError: () => toast({ tone: 'error', title: 'Refresh failed', description: 'Could not reach the Brain Server.' }),
    });

  return (
    <BrainContext.Provider value={{ state, refreshing, refresh: doRefresh }}>
      {children}
    </BrainContext.Provider>
  );
}

export function DataProvider({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>
      <BrainBridge>{children}</BrainBridge>
    </QueryClientProvider>
  );
}
