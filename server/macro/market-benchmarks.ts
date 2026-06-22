// server/macro/market-benchmarks.ts
//
// Phase 5 (Track 3) — Market Intelligence: Cap Rate Benchmarks provider.
//
// getMacroMarketBenchmarks(): returns external market cap-rate benchmark bands per
// (market, propertyType). Fail-open by contract: if no source is reachable it returns
// { available:false, source:'unavailable', benchmarks:[] } — NEVER throws, so the
// capital-allocation synthesis (which calls this) degrades to null cap-rate columns.
//
// Source precedence:
//   1. FRED (live) — STUB. FRED publishes no direct CRE cap-rate series; a real adapter would
//      proxy from a commercial data feed (CBRE/RCA/Green Street) keyed off FRED rates. Until
//      that integration exists, fetchFredCapRates() returns null and we fall through to the seed.
//   2. Seed (documented static fallback) — industrial/flex cap-rate ranges for ORA's target
//      markets, labeled source:'seed' so the UI badges it as a snapshot (mirrors getMacro.ts).
//
// This module holds NO capital-allocation decision math: it only supplies external reference
// bands. The implied-cap / gap / band classification lives in the contract (classifyCapRateBand)
// and is applied in capital-allocation.ts as a pure diagnostic overlay — it does not feed the
// priorityScore or capitalAction.
import { WORKBOOK_AS_OF } from '../config';
import {
  type CapRateBenchmark,
  type MarketBenchmarkSet,
  type Market,
  type PropertyType,
} from '../../src/contracts/index';

/**
 * Live FRED/commercial-feed adapter. STUB — returns null until a real CRE cap-rate feed is wired.
 * Kept as a seam so the seed → live cutover is a one-function change with no caller edits.
 */
async function fetchFredCapRates(): Promise<CapRateBenchmark[] | null> {
  // No FRED_API_KEY path today: FRED has no first-party cap-rate series, so even with a key
  // there is nothing to fetch. Explicit null keeps the fail-open contract honest.
  return null;
}

/**
 * Documented seeded fallback. Industrial/flex shallow-bay cap-rate bands (decimal fractions)
 * for ORA's target markets, reflecting secondary-Midwest Class B/C industrial as of mid-2026.
 * These are reference ranges for relative positioning only — NOT a property valuation input and
 * NOT a governor. Bands intentionally wide (p25→p75 ≈ 100–150 bps) to avoid false precision.
 *
 * Markets without an explicit row inherit the 'Other' band. Property types other than the two
 * industrial-family types ORA holds (Industrial, Flex) inherit Industrial as the closest proxy.
 */
function seededBenchmarks(): CapRateBenchmark[] {
  const asOf = WORKBOOK_AS_OF;
  const seed = (
    market: Market,
    propertyType: PropertyType,
    p25: number,
    p50: number,
    p75: number,
  ): CapRateBenchmark => ({
    market,
    propertyType,
    capRateP25: p25,
    capRateP50: p50,
    capRateP75: p75,
    source: 'seed',
    asOf,
  });

  return [
    // Columbus OH — deepest ORA market; tightest cap rates of the set.
    seed('Columbus OH', 'Industrial', 0.0675, 0.075, 0.085),
    seed('Columbus OH', 'Flex', 0.075, 0.0825, 0.0925),
    // Mid-Atlantic — coastal premium, tighter than Midwest.
    seed('Mid-Atlantic', 'Industrial', 0.065, 0.0725, 0.0825),
    seed('Mid-Atlantic', 'Flex', 0.07, 0.08, 0.09),
    // Kansas City MO — secondary Midwest, wider bands.
    seed('Kansas City MO', 'Industrial', 0.075, 0.0825, 0.0925),
    seed('Kansas City MO', 'Flex', 0.08, 0.09, 0.10),
    // Indianapolis IN — secondary Midwest, comparable to KC.
    seed('Indianapolis IN', 'Industrial', 0.0725, 0.08, 0.09),
    seed('Indianapolis IN', 'Flex', 0.0775, 0.0875, 0.0975),
    // Toledo OH / Cleveland MSA — tertiary/secondary OH, widest of the OH set.
    seed('Toledo OH', 'Industrial', 0.085, 0.095, 0.105),
    seed('Toledo OH', 'Flex', 0.09, 0.10, 0.11),
    seed('Cleveland MSA', 'Industrial', 0.08, 0.0875, 0.0975),
    seed('Cleveland MSA', 'Flex', 0.085, 0.095, 0.105),
    // Other / Unknown — broad national-secondary industrial fallback.
    seed('Other', 'Industrial', 0.0775, 0.0875, 0.0975),
    seed('Other', 'Flex', 0.0825, 0.0925, 0.1025),
    seed('Unknown', 'Industrial', 0.0775, 0.0875, 0.0975),
    seed('Unknown', 'Flex', 0.0825, 0.0925, 0.1025),
  ];
}

/**
 * Resolve the market cap-rate benchmark set. Fail-open: any error yields the unavailable set.
 * Live FRED first (stub → null today), then the documented seed.
 */
export async function getMacroMarketBenchmarks(): Promise<MarketBenchmarkSet> {
  try {
    const live = await fetchFredCapRates().catch(() => null);
    if (live && live.length > 0) {
      return { available: true, source: 'fred', asOf: WORKBOOK_AS_OF, benchmarks: live };
    }
    const seed = seededBenchmarks();
    return { available: true, source: 'seed', asOf: WORKBOOK_AS_OF, benchmarks: seed };
  } catch {
    return { available: false, source: 'unavailable', asOf: null, benchmarks: [] };
  }
}
