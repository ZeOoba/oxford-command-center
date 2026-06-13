// src/modules/intel/analytics-hooks.ts
//
// TanStack Query hooks over the /api/warehouse/analytics/* routes (Phase B engine).
// Reuses fetchJson / QUERY_OPTS / WarehouseUnavailableError / isWarehouseUnavailable
// from hooks.ts — NO duplicate fetch logic. On the static mirror (or a cold/headless
// environment) the analytics routes 503 → fetchJson throws WarehouseUnavailableError →
// the consuming views degrade to the existing offline Card (pre-mortem #3). Patterns
// mirror hooks.ts (staleTime 30s, retry 1).
//
// Response interfaces mirror the engine return types verified against source:
//   scores.ts (PropertyScore), metrics.ts (PeriodMetrics), growth.ts (GrowthPoint,
//   SinceAcquisition), drivers.ts (NoiDriver/NoiDecomposition), anomalies.ts (AnomalyFlag),
//   benchmarks.ts (MetricBenchmark, PropertyRank, PmScorecard).
import { useQuery } from '@tanstack/react-query';
import { QUERY_OPTS, fetchJson } from './hooks';

// ---------------------------------------------------------------------------
// Engine-mirroring enums + response shapes (camelCase, as the routes serialize them).
// ---------------------------------------------------------------------------

export type HealthBand = 'excellent' | 'good' | 'watch' | 'concern';
export type AttentionBand = 'green' | 'yellow' | 'orange' | 'red';
export type CapitalAction = 'invest' | 'hold' | 'monitor' | 'disposition-candidate';
export type AnomalySeverity = 'low' | 'moderate' | 'high' | 'critical';
export type AnomalyKind =
  | 'expense-growth'
  | 'revenue-decline'
  | 'noi-decline'
  | 'noi-per-sf-decline'
  | 'new-category'
  | 'category-spike';
export type Quartile = 1 | 2 | 3 | 4 | null;

/** A benchmarkable numeric metric key (kept in lockstep with the route's enum). */
export type NumericMetricKey =
  | 'revenue'
  | 'opex'
  | 'noi'
  | 'oxfordNoi'
  | 'noiMargin'
  | 'expenseRatio'
  | 'revenuePerSf'
  | 'noiPerSf'
  | 'expensePerSf'
  | 'taxesPerSf'
  | 'insurancePerSf'
  | 'repairsPerSf';

/** Per-property health + attention score (scores.ts → PropertyScore). */
export interface PropertyScore {
  propertyId: string;
  propertyName: string | null;
  period: string; // scoring period = latest full-year period
  health: number; // 0..100
  healthBand: HealthBand;
  attentionBand: AttentionBand;
  capitalAction: CapitalAction;
  subScores: Record<string, number>;
  noiPerSfQuartile: Quartile;
  reasons: string[];
}

/** Per (propertyId, period) financial metrics (metrics.ts → PeriodMetrics). */
export interface PeriodMetrics {
  propertyId: string;
  propertyName: string | null;
  period: string; // 'YYYY'
  grainHint: string | null; // 'year' | 'ytd'
  rentableSf: number | null;
  ownershipPct: number;
  revenue: number;
  opex: number;
  noi: number;
  noiMargin: number | null;
  expenseRatio: number | null;
  capex: number;
  ti: number;
  leasing: number;
  categories: Record<string, number>;
  revenueCategories: Record<string, number>;
  revenuePerSf: number | null;
  noiPerSf: number | null;
  expensePerSf: number | null;
  taxesPerSf: number | null;
  insurancePerSf: number | null;
  repairsPerSf: number | null;
  oxfordNoi: number;
}

/** Period-over-period growth point (growth.ts → GrowthPoint). */
export interface GrowthPoint {
  propertyId: string;
  period: string;
  comparable: boolean;
  revenueGrowth: number | null;
  expenseGrowth: number | null;
  noiGrowth: number | null;
  noiPerSfGrowth: number | null;
}

/** Anchor→latest same-grain spread (growth.ts → SinceAcquisition). */
export interface SinceAcquisition {
  propertyId: string | null;
  anchorPeriod: string | null;
  latestPeriod: string | null;
  comparable: boolean;
  revenueGrowth: number | null;
  noiGrowth: number | null;
  noiPerSfGrowth: number | null;
  taxesGrowth: number | null;
  insuranceGrowth: number | null;
  revenuePerSfGrowth: number | null;
  noiCagr: number | null;
}

/** Single ΔNOI driver (drivers.ts → NoiDriver). */
export interface NoiDriver {
  category: string;
  delta: number;
  contributionPct: number | null;
}

/** ΔNOI decomposition for a property between two periods (drivers route payload). */
export interface NoiDecomposition {
  propertyId: string;
  from: string;
  to: string;
  totalDelta: number;
  drivers: NoiDriver[];
}

/** A flagged anomaly between consecutive same-grain periods (anomalies.ts → AnomalyFlag). */
export interface AnomalyFlag {
  propertyId: string;
  period: string;
  kind: AnomalyKind;
  severity: AnomalySeverity;
  detail: string;
  metricValue: number | null;
}

/** Portfolio benchmark summary for one (period, metric) (benchmarks.ts → MetricBenchmark). */
export interface MetricBenchmark {
  period: string;
  metric: NumericMetricKey;
  avg: number | null;
  median: number | null;
  p25: number | null;
  p75: number | null;
  n: number;
  // Cross-basis discipline (PFI Phase 1a): the distinct accounting bases of the cohort, and whether
  // they are mixed. A benchmark drawn across cash + accrual (or unknown) is not like-for-like — the
  // UI must surface mixedBasis, never present it as a clean comparison.
  bases: string[];
  mixedBasis: boolean;
}

/** Property's rank within a (period, metric) cohort (benchmarks.ts → PropertyRank). */
export interface PropertyRank {
  propertyId: string;
  value: number;
  rank: number;
  quartile: Quartile;
}

/** PM-level aggregate scorecard (benchmarks.ts → PmScorecard). */
export interface PmScorecard {
  propertyManager: string;
  propertyCount: number;
  smallSample: boolean;
  avgNoiPerSf: number | null;
  avgNoiGrowth: number | null;
  avgExpenseGrowth: number | null;
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
// Read hooks. Each unwraps the route envelope to the bare payload; an unavailable
// warehouse surfaces via `error` (isWarehouseUnavailable) — the hooks never throw at call.
// ---------------------------------------------------------------------------

export function useScores() {
  return useQuery({
    queryKey: ANALYTICS_KEYS.scores,
    queryFn: () => fetchJson<{ scores: PropertyScore[] }>('/api/warehouse/analytics/scores').then((r) => r.scores),
    ...QUERY_OPTS,
  });
}

export function useMetrics() {
  return useQuery({
    queryKey: ANALYTICS_KEYS.metrics,
    queryFn: () => fetchJson<{ metrics: PeriodMetrics[] }>('/api/warehouse/analytics/metrics').then((r) => r.metrics),
    ...QUERY_OPTS,
  });
}

export interface GrowthResponse {
  growth: GrowthPoint[];
  sinceAcquisition: SinceAcquisition[];
}

export function useGrowth() {
  return useQuery({
    queryKey: ANALYTICS_KEYS.growth,
    queryFn: () => fetchJson<GrowthResponse>('/api/warehouse/analytics/growth'),
    ...QUERY_OPTS,
  });
}

export function useAnomalies() {
  return useQuery({
    queryKey: ANALYTICS_KEYS.anomalies,
    queryFn: () =>
      fetchJson<{ anomalies: AnomalyFlag[] }>('/api/warehouse/analytics/anomalies').then((r) => r.anomalies),
    ...QUERY_OPTS,
  });
}

export function usePmScorecards() {
  return useQuery({
    queryKey: ANALYTICS_KEYS.pm,
    queryFn: () => fetchJson<{ scorecards: PmScorecard[] }>('/api/warehouse/analytics/pm').then((r) => r.scorecards),
    ...QUERY_OPTS,
  });
}

export interface BenchmarksResponse {
  byMetric: MetricBenchmark;
  rankings: PropertyRank[];
}

/** Benchmark summary + rankings for one (period, metric). Enabled only when a period is
 *  supplied (the route 400s on a malformed period; the selector offers only present FYs). */
export function useBenchmarks(period: string | null, metric: NumericMetricKey) {
  return useQuery({
    queryKey: ANALYTICS_KEYS.benchmarks(period ?? '', metric),
    queryFn: () =>
      fetchJson<BenchmarksResponse>(
        `/api/warehouse/analytics/benchmarks?period=${encodeURIComponent(period ?? '')}&metric=${encodeURIComponent(metric)}`,
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
      fetchJson<NoiDecomposition>(
        `/api/warehouse/analytics/drivers/${encodeURIComponent(propertyId ?? '')}?from=${encodeURIComponent(from ?? '')}&to=${encodeURIComponent(to ?? '')}`,
      ),
    enabled,
    ...QUERY_OPTS,
  });
}
