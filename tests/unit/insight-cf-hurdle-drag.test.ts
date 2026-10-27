/**
 * tests/unit/insight-cf-hurdle-drag.test.ts
 *
 * Phase 3 UnitE — CF-1 hurdle-drag generator
 * TDD RED phase: all tests fail until the generator is implemented.
 *
 * Rate-basis correctness invariant:
 *   impliedCapRate = Spine-A NOI / Oxford workbook value (unlevered current yield)
 *   capRateGap     = impliedCapRate − marketCapP50
 *   subTargetYieldGap = abs(capRateGap) when capRateGap < 0
 *   This is a cap-rate-to-cap-rate comparison only — never levered IRR.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type { CapitalAllocationReport } from '@contracts/capital-allocation';
import { generateCfHurdleDrag } from '../../server/insights/generators/cf-hurdle-drag';

// ---------------------------------------------------------------------------
// Minimal fixture factory
// ---------------------------------------------------------------------------

function makeEntry(
  overrides: Partial<{
    propertyId: string;
    propertyName: string | null;
    capitalAction: 'invest' | 'hold' | 'monitor' | 'disposition-candidate';
    impliedCapRate: number | null;
    capRateGap: number | null;
    noi: number;
    leasingRisk: number;
  }> = {},
) {
  return {
    propertyId: 'prop-1',
    propertyName: 'Test Property',
    market: 'Columbus OH',
    sf: 20000,
    capitalAction: 'hold' as const,
    priorityScore: 60,
    healthScore: 70,
    attentionScore: 30,
    nearTermExpiryRent: 0,
    atRiskLikelihoodCount: 0,
    debtScore: null,
    balloonMonths: null,
    dscr: null,
    rationale: [],
    noi: 500_000,
    noiPerSf: 25,
    noiBasis: 'spine-a' as const,
    leasingRisk: 0,
    impliedCapRate: 0.065,
    capRateGap: -0.01,
    capRatePercentile: null,
    ...overrides,
  };
}

function makeReport(
  entries: ReturnType<typeof makeEntry>[],
): CapitalAllocationReport {
  return {
    asOf: '2026-06-23',
    propertyCount: entries.length,
    entries,
    portfolioNoi: entries.reduce((s, e) => s + e.noi, 0),
    portfolioNoBasis: 'spine-a' as const,
    investCount: 0,
    holdCount: entries.filter((e) => e.capitalAction === 'hold').length,
    monitorCount: 0,
    dispositionCount: 0,
    macro: { tenYearRate: null, cpi: null, source: 'mock' as const, asOf: null },
    marketBenchmarks: { available: false, source: 'unavailable' as const, asOf: null },
    regionalMacro: null,
  };
}

// ---------------------------------------------------------------------------
// Test cases
// ---------------------------------------------------------------------------

describe('generateCfHurdleDrag', () => {
  // 1. Hold trailing market → one insight emitted
  it('emits one insight for a hold entry trailing the market', () => {
    const entry = makeEntry({
      propertyId: 'prop-1',
      capitalAction: 'hold',
      impliedCapRate: 0.065,
      capRateGap: -0.01, // trailing market by 100 bps
      noi: 500_000,
    });
    const report = makeReport([entry]);
    const results = generateCfHurdleDrag(report);

    expect(results).toHaveLength(1);
    const insight = results[0]!;

    // id
    expect(insight.id).toBe('cf-hurdle-drag::prop-1');

    // spine
    expect(insight.spine).toBe('A');

    // family
    expect(insight.family).toBe('CF');

    // title: must contain "Premium" (not "drag" or "sub-target")
    expect(insight.title).toMatch(/[Pp]remium/);
    expect(insight.title).not.toMatch(/\bdrag\b/i);
    expect(insight.title).not.toMatch(/sub-target/i);

    // discovery: must contain "below" and "market median"
    expect(insight.discovery).toMatch(/below/i);
    expect(insight.discovery).toMatch(/market median/i);
    expect(insight.discovery).not.toMatch(/annual yield drag/i);

    // materialityUsd: belowMarketGap * oxfordValue
    // oxfordValue = noi / impliedCapRate = 500000 / 0.065 ≈ 7,692,307.69
    // belowMarketGap = abs(-0.01) = 0.01
    // materialityUsd ≈ 0.01 * 7,692,307.69 ≈ 76,923.08
    const expectedOxfordValue = 500_000 / 0.065;
    const expectedMaterialityUsd = 0.01 * expectedOxfordValue;
    expect(insight.materialityUsd).toBeCloseTo(expectedMaterialityUsd, 0);

    // advisoryOnly must be literal true
    expect(insight.advisoryOnly).toBe(true);

    // confidence seed
    expect(insight.confidence).toBe(0.7);

    // novelty: Math.min(1, belowMarketGap / 0.02) = Math.min(1, 0.01/0.02) = 0.5
    expect(insight.novelty).toBeCloseTo(0.5, 10);
  });

  // 1b. Money in the prose uses the same compact format as the rest of the UI ("$77K"), never a raw
  //     unformatted integer ("$76923") — 2026-10-27 Overview review.
  it('formats the dollar figure in discovery compactly, not as a raw integer', () => {
    const entry = makeEntry({
      propertyId: 'prop-1',
      capitalAction: 'hold',
      impliedCapRate: 0.065,
      capRateGap: -0.01,
      noi: 500_000, // materialityUsd ≈ 76,923
    });
    const insight = generateCfHurdleDrag(makeReport([entry]))[0]!;
    expect(insight.discovery).toContain('$77K');
    expect(insight.discovery).not.toMatch(/\$\d{4,}/);
    // The figure is still the unrounded value on the numeric field.
    expect(insight.materialityUsd).toBeCloseTo(76_923, 0);
  });

  // 2. Hold at-or-above market → zero insights
  it('emits no insights when capRateGap is positive (at or above market)', () => {
    const entry = makeEntry({
      capitalAction: 'hold',
      impliedCapRate: 0.08,
      capRateGap: 0.005, // above market median — not trailing
      noi: 400_000,
    });
    const report = makeReport([entry]);
    expect(generateCfHurdleDrag(report)).toHaveLength(0);
  });

  // 3. Non-hold skipped even with negative capRateGap
  it('skips entries where capitalAction is not hold', () => {
    const entry = makeEntry({
      capitalAction: 'invest',
      impliedCapRate: 0.065,
      capRateGap: -0.01,
      noi: 500_000,
    });
    const report = makeReport([entry]);
    expect(generateCfHurdleDrag(report)).toHaveLength(0);
  });

  // 4. Null impliedCapRate skipped
  it('skips entries where impliedCapRate is null', () => {
    const entry = makeEntry({
      capitalAction: 'hold',
      impliedCapRate: null,
      capRateGap: -0.01,
    });
    const report = makeReport([entry]);
    expect(generateCfHurdleDrag(report)).toHaveLength(0);
  });

  // 5. Null capRateGap skipped
  it('skips entries where capRateGap is null', () => {
    const entry = makeEntry({
      capitalAction: 'hold',
      impliedCapRate: 0.065,
      capRateGap: null,
    });
    const report = makeReport([entry]);
    expect(generateCfHurdleDrag(report)).toHaveLength(0);
  });

  // 6. n equals portfolio size
  it('sets n equal to the total number of entries in the report', () => {
    const entries = [
      makeEntry({ propertyId: 'prop-1', capitalAction: 'hold', impliedCapRate: 0.065, capRateGap: -0.01, noi: 500_000 }),
      makeEntry({ propertyId: 'prop-2', capitalAction: 'hold', impliedCapRate: 0.075, capRateGap: 0.005, noi: 300_000 }),
      makeEntry({ propertyId: 'prop-3', capitalAction: 'monitor', impliedCapRate: 0.07, capRateGap: -0.005, noi: 200_000 }),
    ];
    const report = makeReport(entries);
    const results = generateCfHurdleDrag(report);

    // Only prop-1 qualifies (hold + negative gap)
    expect(results).toHaveLength(1);
    expect(results[0]!.n).toBe(report.entries.length); // = 3
  });

  // 7. No hardcoded rate literals in the generator source
  it('does not contain hardcoded rate literals or levered IRR references in generator source', () => {
    const generatorPath = join(
      __dirname,
      '../../server/insights/generators/cf-hurdle-drag.ts',
    );
    const src = readFileSync(generatorPath, 'utf-8');

    // These must not appear as numeric literals or identifiers
    expect(src).not.toMatch(/\b0\.08\b/);
    expect(src).not.toMatch(/\b0\.085\b/);
    expect(src).not.toMatch(/\bacqIrr\b/);
    expect(src).not.toMatch(/\bhurdleRatePct\b/);
    expect(src).not.toMatch(/\bleveredIrr\b/);
  });

  // 8. Empty report → returns [] without throwing
  it('handles an empty entries array without throwing', () => {
    const report = makeReport([]);
    expect(() => generateCfHurdleDrag(report)).not.toThrow();
    expect(generateCfHurdleDrag(report)).toEqual([]);
  });
});
