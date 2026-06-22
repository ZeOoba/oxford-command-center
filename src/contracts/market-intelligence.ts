// src/contracts/market-intelligence.ts
//
// Phase 5 (Track 3) — Market Intelligence: Cap Rate Benchmarks.
//
// Zod contracts for external market cap-rate benchmark bands, sourced from FRED (when a
// key is present) or a documented seeded fallback. These are MARKET benchmarks (external
// reference), kept strictly separate from the firm's in-place Spine-A cap rates.
//
// Discrete-band doctrine: a property's position vs the market is reported as one of three
// DISCRETE bands (bottom / median / top) — never a continuous percentile. The benchmark
// itself carries the three boundary points (p25/p50/p75) so the UI can show the band edges,
// but the per-property classification (`CapRatePercentile`) is always one of the three labels.
//
// CAP-RATE SIGN CONVENTION (read carefully): a HIGHER cap rate = a LOWER price per dollar of
// NOI = a "cheaper" asset. So a property whose implied cap rate sits ABOVE the market p75
// boundary is in the 'top' (cheap / high-yield) band; one BELOW p25 is 'bottom' (rich /
// low-yield). The band names describe cap-rate level, not desirability — interpretation is
// left to the analyst.
import { z } from 'zod';
import { Market, PropertyType } from './common';

/**
 * Discrete cap-rate band for a single property vs its market+type benchmark.
 *   'bottom' — implied cap < market p25  (richly priced / low yield)
 *   'median' — implied cap within [p25, p75]
 *   'top'    — implied cap > market p75  (cheaply priced / high yield)
 * NEVER interpolate a continuous percentile — the band is a deliberate three-state simplification
 * so the dashboard never implies false precision on what is a sparse, slow-moving benchmark.
 */
export const CapRatePercentile = z.enum(['bottom', 'median', 'top']);
export type CapRatePercentile = z.infer<typeof CapRatePercentile>;

/**
 * A single market+property-type cap-rate benchmark, expressed as three discrete percentile
 * boundaries (decimal fractions, e.g. 0.075 = 7.50%). p25 ≤ p50 ≤ p75 is an invariant the
 * builder enforces; the contract validates the ordering defensively.
 *
 * source:'fred'  — live-fetched (future; the FRED adapter is a stub today and returns null).
 * source:'seed'  — documented static fallback (industrial cap-rate ranges, labeled in the UI).
 */
export const CapRateBenchmark = z
  .object({
    market: Market,
    propertyType: PropertyType,
    capRateP25: z.number().positive(),
    capRateP50: z.number().positive(),
    capRateP75: z.number().positive(),
    source: z.enum(['fred', 'seed']),
    asOf: z.string().nullable(),
  })
  .refine((b) => b.capRateP25 <= b.capRateP50 && b.capRateP50 <= b.capRateP75, {
    message: 'cap-rate percentiles must satisfy p25 <= p50 <= p75',
  });
export type CapRateBenchmark = z.infer<typeof CapRateBenchmark>;

/**
 * The full benchmark set returned by getMacroMarketBenchmarks().
 * `available:false` is the fail-open empty state — when neither FRED nor the seed could
 * produce data, callers MUST render cap-rate columns as null rather than erroring.
 */
export const MarketBenchmarkSet = z.object({
  available: z.boolean(),
  source: z.enum(['fred', 'seed', 'unavailable']),
  asOf: z.string().nullable(),
  benchmarks: z.array(CapRateBenchmark),
});
export type MarketBenchmarkSet = z.infer<typeof MarketBenchmarkSet>;

/**
 * Classify an implied cap rate into a discrete band against a benchmark.
 * Pure, total, and side-effect-free so both the engine and tests share one oracle.
 * Boundary rule: strictly-below p25 → 'bottom'; strictly-above p75 → 'top'; otherwise 'median'
 * (values exactly on a boundary fall in 'median', the conservative middle).
 */
export function classifyCapRateBand(
  impliedCapRate: number,
  benchmark: Pick<CapRateBenchmark, 'capRateP25' | 'capRateP75'>,
): CapRatePercentile {
  if (impliedCapRate < benchmark.capRateP25) return 'bottom';
  if (impliedCapRate > benchmark.capRateP75) return 'top';
  return 'median';
}

/** Deterministic key for indexing a benchmark set by market+type. */
export function benchmarkKey(market: Market, propertyType: PropertyType): string {
  return `${market}::${propertyType}`;
}
