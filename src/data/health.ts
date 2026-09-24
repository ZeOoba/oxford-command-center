// src/data/health.ts
//
// Shared GET /api/health poll (2026-09-23 review, gap #2). System Health (full per-feed detail)
// and the always-visible TopBar HealthDot (folds feeds[] into its tone) both need this response.
// One hook, one query key, one poll — not two independently-effectful fetches racing each other.
import { useQuery } from '@tanstack/react-query';
import { useBrain } from './brain-context';

/** Backstop poll interval for a tab left open with no brain-state status change. Deliberately a
 *  local constant rather than importing queries.ts's SNAPSHOT_REFETCH_MS — several tests mock
 *  '@/data/queries' wholesale (only `useSnapshot`), which would leave an imported constant
 *  undefined and crash `useQuery`'s `refetchInterval` option. */
const HEALTH_REFETCH_MS = 5 * 60_000;

export interface BriefHealth {
  ranAt: string;
  briefSent: boolean;
  alertsSent: number;
  failures: string[];
}

export type FeedStatus = 'fresh' | 'stale' | 'missing';

export interface FeedHealth {
  id: string;
  label: string;
  lastAt: string | null;
  ageDays: number | null;
  maxAgeDays: number;
  status: FeedStatus;
  fix: string;
}

export interface HealthResponse {
  ai?: { configured: boolean; model: string };
  brief?: BriefHealth | null;
  feeds?: FeedHealth[];
}

async function fetchHealth(): Promise<HealthResponse> {
  const res = await fetch('/api/health');
  if (!res.ok) throw new Error('no server');
  return res.json() as Promise<HealthResponse>;
}

/**
 * `/api/health` re-fetches once per brain-state STATUS change (I-2, 2026-09-23 review: a
 * fixed-mount effect opened during startup — port bound before the first refresh — could freeze
 * on a "never" false alarm with no way to clear it short of a manual reload). Keyed on `status`
 * only, so a lastUpdated-only write-back (a UI rederive that changed no feed) never triggers a
 * redundant request. `refetchInterval` is a backstop for a tab left open with no status change.
 */
export function useHealth() {
  const { state } = useBrain();
  return useQuery({
    queryKey: ['health', state?.status] as const,
    queryFn: fetchHealth,
    staleTime: 30_000,
    refetchInterval: HEALTH_REFETCH_MS,
    retry: 1,
  });
}
