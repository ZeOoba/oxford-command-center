// @vitest-environment node
//
// tests/unit/market-benchmarks.test.ts
//
// Phase 5 (Track 3) — Market Intelligence: Cap Rate Benchmarks.
// Covers (1) the contract validation + discrete-band classification oracle, and
// (2) the getMacroMarketBenchmarks() provider (FRED stub → seed fallback, fail-open).
import { describe, expect, it } from 'vitest';
import {
  CapRateBenchmark,
  CapRatePercentile,
  MarketBenchmarkSet,
  classifyCapRateBand,
  benchmarkKey,
} from '../../src/contracts/market-intelligence';
import { getMacroMarketBenchmarks } from '../../server/macro/market-benchmarks';

// ── Contract validation ──────────────────────────────────────────────────────────────────────

describe('CapRateBenchmark contract', () => {
  const valid = {
    market: 'Columbus OH',
    propertyType: 'Industrial',
    capRateP25: 0.0675,
    capRateP50: 0.075,
    capRateP75: 0.085,
    source: 'seed',
    asOf: '2026-06-21',
  };

  it('accepts a well-ordered benchmark', () => {
    expect(CapRateBenchmark.safeParse(valid).success).toBe(true);
  });

  it('rejects p25 > p50 (ordering invariant)', () => {
    const bad = { ...valid, capRateP25: 0.09 };
    expect(CapRateBenchmark.safeParse(bad).success).toBe(false);
  });

  it('rejects p50 > p75 (ordering invariant)', () => {
    const bad = { ...valid, capRateP50: 0.099 };
    expect(CapRateBenchmark.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-positive cap rate', () => {
    const bad = { ...valid, capRateP25: 0 };
    expect(CapRateBenchmark.safeParse(bad).success).toBe(false);
  });

  it('rejects an unknown source', () => {
    const bad = { ...valid, source: 'guess' };
    expect(CapRateBenchmark.safeParse(bad).success).toBe(false);
  });
});

describe('CapRatePercentile enum', () => {
  it('accepts the three discrete bands only', () => {
    expect(CapRatePercentile.safeParse('bottom').success).toBe(true);
    expect(CapRatePercentile.safeParse('median').success).toBe(true);
    expect(CapRatePercentile.safeParse('top').success).toBe(true);
    expect(CapRatePercentile.safeParse('p50').success).toBe(false);
    expect(CapRatePercentile.safeParse('high').success).toBe(false);
  });
});

describe('MarketBenchmarkSet contract', () => {
  it('accepts the fail-open unavailable set', () => {
    const result = MarketBenchmarkSet.safeParse({
      available: false,
      source: 'unavailable',
      asOf: null,
      benchmarks: [],
    });
    expect(result.success).toBe(true);
  });
});

// ── Band classification oracle ─────────────────────────────────────────────────────────────────

describe('classifyCapRateBand', () => {
  const bench = { capRateP25: 0.0675, capRateP75: 0.085 };

  it('classifies below p25 as bottom (richly priced / low yield)', () => {
    expect(classifyCapRateBand(0.06, bench)).toBe('bottom');
  });

  it('classifies above p75 as top (cheaply priced / high yield)', () => {
    expect(classifyCapRateBand(0.095, bench)).toBe('top');
  });

  it('classifies within the band as median', () => {
    expect(classifyCapRateBand(0.075, bench)).toBe('median');
  });

  it('boundary values fall in median (conservative middle)', () => {
    expect(classifyCapRateBand(0.0675, bench)).toBe('median'); // exactly p25
    expect(classifyCapRateBand(0.085, bench)).toBe('median');  // exactly p75
  });
});

describe('benchmarkKey', () => {
  it('is deterministic and market+type specific', () => {
    expect(benchmarkKey('Columbus OH', 'Industrial')).toBe('Columbus OH::Industrial');
    expect(benchmarkKey('Columbus OH', 'Flex')).not.toBe(benchmarkKey('Columbus OH', 'Industrial'));
  });
});

// ── Provider ───────────────────────────────────────────────────────────────────────────────────

describe('getMacroMarketBenchmarks', () => {
  it('returns a seeded set (FRED stub → seed fallback)', async () => {
    const set = await getMacroMarketBenchmarks();
    expect(set.available).toBe(true);
    expect(set.source).toBe('seed');
    expect(set.benchmarks.length).toBeGreaterThan(0);
  });

  it('every seeded benchmark passes the contract (incl. p25<=p50<=p75)', async () => {
    const set = await getMacroMarketBenchmarks();
    for (const b of set.benchmarks) {
      expect(CapRateBenchmark.safeParse(b).success).toBe(true);
    }
    // Full set parses too.
    expect(MarketBenchmarkSet.safeParse(set).success).toBe(true);
  });

  it('covers ORA target markets for both industrial-family types', async () => {
    const set = await getMacroMarketBenchmarks();
    const keys = new Set(set.benchmarks.map((b) => benchmarkKey(b.market, b.propertyType)));
    expect(keys.has('Columbus OH::Industrial')).toBe(true);
    expect(keys.has('Columbus OH::Flex')).toBe(true);
    expect(keys.has('Mid-Atlantic::Industrial')).toBe(true);
    expect(keys.has('Kansas City MO::Industrial')).toBe(true);
    expect(keys.has('Indianapolis IN::Industrial')).toBe(true);
  });
});
