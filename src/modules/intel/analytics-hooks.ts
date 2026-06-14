// src/modules/intel/analytics-hooks.ts
//
// TanStack Query hooks over the /api/warehouse/analytics/* routes (Phase B engine).
// Reuses fetchJson / QUERY_OPTS / WarehouseUnavailableError / isWarehouseUnavailable
// from hooks.ts — NO duplicate fetch logic. On the static mirror (or a cold/headless
// environment) the analytics routes 503 → fetchJson throws WarehouseUnavailableError →
// the consuming views degrade to the existing offline Card (pre-mortem #3). Patterns
// mirror hooks.ts (staleTime 30s, retry 1).
//
// H6 read boundary: every response crosses a Zod schema in src/contracts/warehouse.ts
// (the SAME schemas the server .parse()s before c.json). The engine-mirroring enums and
// payload interfaces that used to be hand-redeclared here are GONE — the z.infer types are
// imported from the contract and re-exported below under their historical names so the intel
// views that import them (BenchmarksView, PropertyIntelView, synthesis, …) are unchanged.
import { useQuery } from '@tanstack/react-query';
import type { z } from 'zod';
import { QUERY_OPTS, fetchJson } from './hooks';
import {
  MetricsResponseSchema, ScoresResponseSchema, GrowthResponseSchema, AnomaliesResponseSchema,
  PmScorecardsResponseSchema, BenchmarksResponseSchema, DriversResponseSchema,
} from '@contracts/warehouse';
import type {
  NumericMetricKey, GrowthResponse, BenchmarksResponse,
} from '@contracts/warehouse';

// Re-export the contract types under the names the intel module has always imported from here,
// so no consumer import has to change. `NoiDecomposition` is the drivers ROUTE envelope (the engine
// decomposition wrapped with propertyId/from/to), which is what useDrivers returns.
export type {
  HealthBand, AttentionBand, AnomalySeverity, AnomalyKind, Quartile, NumericMetricKey, CapitalAction,
  PropertyScore, PeriodMetrics, GrowthPoint, SinceAcquisition, NoiDriver, AnomalyFlag,
  MetricBenchmark, PropertyRank, PmScorecard, GrowthResponse, BenchmarksResponse,
} from '@contracts/warehouse';
export type { DriversResponse as NoiDecomposition } from '@contracts/warehouse';

/** Fetch a route then .parse() its body through the contract schema — the client half of the H6
 *  read boundary. fetchJson still throws WarehouseUnavailableError on a 503 / non-JSON mirror BEFORE
 *  any parse runs, so the offline-degradation path is unchanged. */
async function fetchParsed<S extends z.ZodTypeAny>(path: string, schema: S): Promise<z.infer<S>> {
  return schema.parse(await fetchJson<unknown>(path));
}

// ---------------------------------------------------------------------------
// Query keys — all rooted at ['warehouse','analytics',…] so useWarehouseInvalidate's
// prefix invalidation drops every analytics query after a mutation (pre-mortem #4).
// ---------------------------------------------------------------------------

export const ANALYTICS_KEYS = {
  scores: ['warehouse', 'analytics', 'scores'] as const,
  metrics: ['warehouse', 'analytics', 'metrics'] as const,
  growth: ['warehouse', 'analytics', 'growth'] as const,
  anomalies: ['warehouse', 'analytics', 'anomalies'] as const,
  pm: ['warehouse', 'analytics', 'pm'] as const,
  benchmarks: (period: string, metric: NumericMetricKey) =>
    ['warehouse', 'analytics', 'benchmarks', period, metric] as const,
  drivers: (propertyId: string, from: string, to: string) =>
    ['warehouse', 'analytics', 'drivers', propertyId, from, to] as const,
};

// ---------------------------------------------------------------------------
// Read hooks. Each unwraps the parsed route envelope to the bare payload; an unavailable
// warehouse surfaces via `error` (isWarehouseUnavailable) — the hooks never throw at call.
// ---------------------------------------------------------------------------

export function useScores() {
  return useQuery({
    queryKey: ANALYTICS_KEYS.scores,
    queryFn: () => fetchParsed('/api/warehouse/analytics/scores', ScoresResponseSchema).then((r) => r.scores),
    ...QUERY_OPTS,
  });
}

export function useMetrics() {
  return useQuery({
    queryKey: ANALYTICS_KEYS.metrics,
    queryFn: () => fetchParsed('/api/warehouse/analytics/metrics', MetricsResponseSchema).then((r) => r.metrics),
    ...QUERY_OPTS,
  });
}

export function useGrowth() {
  return useQuery({
    queryKey: ANALYTICS_KEYS.growth,
    queryFn: (): Promise<GrowthResponse> =>
      fetchParsed('/api/warehouse/analytics/growth', GrowthResponseSchema),
    ...QUERY_OPTS,
  });
}

export function useAnomalies() {
  return useQuery({
    queryKey: ANALYTICS_KEYS.anomalies,
    queryFn: () =>
      fetchParsed('/api/warehouse/analytics/anomalies', AnomaliesResponseSchema).then((r) => r.anomalies),
    ...QUERY_OPTS,
  });
}

export function usePmScorecards() {
  return useQuery({
    queryKey: ANALYTICS_KEYS.pm,
    queryFn: () =>
      fetchParsed('/api/warehouse/analytics/pm', PmScorecardsResponseSchema).then((r) => r.scorecards),
    ...QUERY_OPTS,
  });
}

/** Benchmark summary + rankings for one (period, metric). Enabled only when a period is
 *  supplied (the route 400s on a malformed period; the selector offers only present FYs). */
export function useBenchmarks(period: string | null, metric: NumericMetricKey) {
  return useQuery({
    queryKey: ANALYTICS_KEYS.benchmarks(period ?? '', metric),
    queryFn: (): Promise<BenchmarksResponse> =>
      fetchParsed(
        `/api/warehouse/analytics/benchmarks?period=${encodeURIComponent(period ?? '')}&metric=${encodeURIComponent(metric)}`,
        BenchmarksResponseSchema,
      ),
    enabled: period !== null && period !== '',
    ...QUERY_OPTS,
  });
}

/** ΔNOI driver decomposition for one property between two FY periods. Enabled only when
 *  all three of propertyId/from/to are present (drivers need ≥2 comparable periods). */
export function useDrivers(propertyId: string | null, from: string | null, to: string | null) {
  const enabled = propertyId !== null && from !== null && to !== null;
  return useQuery({
    queryKey: ANALYTICS_KEYS.drivers(propertyId ?? '', from ?? '', to ?? ''),
    queryFn: () =>
      fetchParsed(
        `/api/warehouse/analytics/drivers/${encodeURIComponent(propertyId ?? '')}?from=${encodeURIComponent(from ?? '')}&to=${encodeURIComponent(to ?? '')}`,
        DriversResponseSchema,
      ),
    enabled,
    ...QUERY_OPTS,
  });
}
