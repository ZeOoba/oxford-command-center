/**
 * server/insights/generators/cf-hurdle-drag.ts
 *
 * Phase 3 UnitE — CF-1 sub-target-yield generator.
 *
 * Detects hold-rated properties whose in-place cap rate (impliedCapRate) trails
 * the market benchmark median, as signalled by a negative capRateGap.
 *
 * Rate-basis correctness:
 *   impliedCapRate = Spine-A NOI / Oxford workbook value (unlevered current yield)
 *   capRateGap     = impliedCapRate − marketCapP50  (negative = trailing market)
 *   subTargetYieldGap = abs(capRateGap) when capRateGap < 0
 *
 *   Both legs are cap rates — a valid apples-to-apples comparison.
 *   Never compared against any levered return measure (IRR, levered return %, etc.).
 *
 * advisoryOnly: true on every emitted insight — hard invariant.
 * spine: 'A' on every emitted insight — Spine A only (workbook-based NOI + value).
 *
 * No hardcoded rate thresholds. The filter is sign-based (capRateGap < 0) only.
 */

import type { CapitalAllocationReport } from '@contracts/capital-allocation';
import type { RankInput } from '../rank';

// Novelty ceiling: 200 bps sub-target gap = full novelty 1.0
const NOVELTY_FULL_GAP = 0.02;

/**
 * Generate CF-1 hurdle-drag insights from a CapitalAllocationReport.
 *
 * For each 'hold' entry where the implied cap rate trails the market median
 * (capRateGap < 0), emits one RankInput describing the annual yield drag.
 */
export function generateCfHurdleDrag(report: CapitalAllocationReport): RankInput[] {
  const results: RankInput[] = [];
  const portfolioSize = report.entries.length;

  for (const entry of report.entries) {
    // Filter: only hold entries with valid, trailing cap-rate data
    if (entry.capitalAction !== 'hold') continue;
    if (entry.impliedCapRate === null || entry.impliedCapRate <= 0) continue;
    if (entry.capRateGap === null || entry.capRateGap >= 0) continue;

    const impliedCapRate = entry.impliedCapRate;
    const capRateGap = entry.capRateGap;

    // subTargetYieldGap: how far below market median, as a positive fraction
    const subTargetYieldGap = Math.abs(capRateGap);

    // Back-compute Oxford asset value from Spine-A NOI and implied cap rate
    const oxfordValue = entry.noi / impliedCapRate;

    // Annual run-rate dollar impact of the yield shortfall
    const materialityUsd = subTargetYieldGap * oxfordValue;

    // Market median cap rate = impliedCapRate - capRateGap
    const marketMedianCapRate = impliedCapRate - capRateGap;

    const propertyLabel = entry.propertyName ?? entry.propertyId;

    const insight: RankInput = {
      id: `cf-hurdle-drag::${entry.propertyId}`,
      family: 'CF',
      generatorId: 'cf-hurdle-drag',
      propertyId: entry.propertyId,
      spine: 'A',

      attribution: {
        inputs: {
          impliedCapRate,
          capRateGap,
          subTargetYieldGap,
          oxfordValue,
          portfolioSize,
        },
      },

      confidence: 0.7, // seed benchmark — not live market data

      goal: 1, // acquisition velocity

      materialityUsd,

      title: `${propertyLabel} yields ${(impliedCapRate * 100).toFixed(2)}% vs ${(marketMedianCapRate * 100).toFixed(2)}% market median`,

      discovery:
        `In-place cap rate of ${(impliedCapRate * 100).toFixed(1)}% trails the market median of ` +
        `${(marketMedianCapRate * 100).toFixed(1)}% by ${Math.round(subTargetYieldGap * 10_000)} bps, ` +
        `implying $${materialityUsd.toFixed(0)} annual yield drag on a ~$${oxfordValue.toFixed(0)} asset.`,

      prov: {
        source: 'capital-allocation-report',
        confidence: 'derived',
        asOf: report.asOf,
      },

      advisoryOnly: true,

      // RankInput extensions
      n: portfolioSize,
      novelty: Math.min(1, subTargetYieldGap / NOVELTY_FULL_GAP),
    };

    results.push(insight);
  }

  return results;
}
