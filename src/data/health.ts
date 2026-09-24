// src/data/health.ts
//
// Shared GET /api/health poll (2026-09-23 review, gap #2). System Health (full per-feed detail)
// and the always-visible TopBar HealthDot (folds feeds[] into its tone) both need this response.
// One hook, one query key, one poll — not two independently-effectful fetches racing each other.
import { useQuery, keepPreviousData } from '@tanstack/react-query';
import { useBrain } from './brain-context';
import type { FeedHealth, FeedStatus } from '../lib/feed-health';

// Re-exported so existing consumers of src/data/health.ts's types are unaffected — the types
// themselves now live in src/lib/feed-health.ts (lib must not depend on data; data depending on
// lib is fine) so src/lib/healthSignal.ts (a pure function module) never imports from src/data.
export type { FeedHealth, FeedStatus };

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
 *
 * `staleTime: 0` (review follow-up): the query key changes on every status transition, INCLUDING
 * a round-trip back to a status already seen (fresh -> refreshing -> fresh) — a positive staleTime
 * would let that round-trip skip the refetch entirely, silently re-showing however-old data under
 * a "just refreshed" status. `placeholderData: keepPreviousData` covers the resulting gap: while
 * the new key's request is in flight, the PREVIOUS key's data keeps rendering instead of both
 * observers (HealthDot + HealthModule) seeing `undefined` — which would flash HealthDot to a false
 * "healthy" green (no feeds = no stale feeds) and drop HealthModule's Data Feeds card entirely.
 * Both observers share the same query key + queryFn, so concurrent observers never double-fetch;
 * a newly mounted observer on already-stale data (e.g. opening System Health) still refetches once.
 */
export function useHealth() {
  const { state } = useBrain();
  return useQuery({
    queryKey: ['health', state?.status] as const,
    queryFn: fetchHealth,
    staleTime: 0,
    placeholderData: keepPreviousData,
    // staleTime 0 would otherwise refetch on every window focus; status changes + the backstop suffice.
    refetchOnWindowFocus: false,
    refetchInterval: HEALTH_REFETCH_MS,
    retry: 1,
  });
}
