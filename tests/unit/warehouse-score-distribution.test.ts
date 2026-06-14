import { describe, expect, it } from 'vitest';
import {
  MIN_PROPERTIES_FOR_COLLAPSE_CHECK,
  SINGLE_BAND_COLLAPSE_SHARE,
  scoreBandDistribution,
} from '../../server/warehouse/scores';
import type { PropertyScore } from '../../server/warehouse/scores';

// Synthetic PropertyScore — only the fields the distribution check reads matter; the rest are
// filled with deterministic placeholders. noiPerSfQuartile is deliberately exercised with null
// (a property with null $/SF) to prove the histogram is null-safe.
function mkScore(
  id: string,
  attentionBand: PropertyScore['attentionBand'],
  healthBand: PropertyScore['healthBand'],
  quartile: PropertyScore['noiPerSfQuartile'],
): PropertyScore {
  return {
    propertyId: id,
    propertyName: id,
    period: '2025',
    health: 50,
    healthBand,
    attentionBand,
    capitalAction: 'hold',
    subScores: {},
    noiPerSfQuartile: quartile,
    benchmarkCohortSize: 0, // distribution check does not read it; deterministic placeholder
    reasons: [],
  };
}

const ATT = ['green', 'yellow', 'orange', 'red'] as const;
const HEALTH = ['excellent', 'good', 'watch', 'concern'] as const;

describe('scoreBandDistribution (warehouse:verify score-band sanity)', () => {
  it('FAILS the gate when every scored property collapses into ONE attentionBand', () => {
    // The PFI 2026-06-12 symptom: a cross-grain YTD-vs-full-year leak pushed all properties to red.
    const scores = Array.from({ length: 12 }, (_, i) => mkScore(`p${i}`, 'red', 'concern', 4));
    const d = scoreBandDistribution(scores);
    expect(d.collapsed).toBe(true);
    expect(d.reason).toMatch(/attentionBand collapse/);
    expect(d.attentionHist.red).toBe(12);
  });

  it('PASSES the gate on a healthy spread across bands', () => {
    const scores = Array.from({ length: 12 }, (_, i) =>
      mkScore(`p${i}`, ATT[i % 4]!, HEALTH[i % 4]!, ((i % 4) + 1) as 1 | 2 | 3 | 4),
    );
    const d = scoreBandDistribution(scores);
    expect(d.collapsed).toBe(false);
    expect(d.reason).toBeNull();
    // every bucket non-empty, max share 25% — well under the collapse threshold
    expect(Math.max(...Object.values(d.attentionHist)) / d.total).toBeLessThan(SINGLE_BAND_COLLAPSE_SHARE);
  });

  it('FAILS on a healthBand collapse even when attentionBand is spread (and survives null quartiles)', () => {
    const scores = Array.from({ length: 12 }, (_, i) => mkScore(`p${i}`, ATT[i % 4]!, 'concern', null));
    const d = scoreBandDistribution(scores);
    expect(d.collapsed).toBe(true);
    expect(d.reason).toMatch(/healthBand collapse/);
    expect(d.quartileHist.null).toBe(12); // null $/SF bucketed, not crashed
  });

  it('null noiPerSfQuartile never crashes the histogram', () => {
    const scores = [
      mkScore('a', 'green', 'good', null),
      mkScore('b', 'yellow', 'watch', 1),
      mkScore('c', 'orange', 'concern', null),
      mkScore('d', 'red', 'concern', 4),
      mkScore('e', 'green', 'excellent', 2),
    ];
    expect(() => scoreBandDistribution(scores)).not.toThrow();
    const d = scoreBandDistribution(scores);
    expect(d.quartileHist.null).toBe(2);
    expect(d.total).toBe(5);
  });

  it('does NOT flag a uniform band below the small-N guard', () => {
    const scores = Array.from({ length: MIN_PROPERTIES_FOR_COLLAPSE_CHECK - 1 }, (_, i) =>
      mkScore(`p${i}`, 'green', 'excellent', 1),
    );
    const d = scoreBandDistribution(scores);
    expect(d.total).toBe(MIN_PROPERTIES_FOR_COLLAPSE_CHECK - 1);
    expect(d.collapsed).toBe(false);
  });

  it('flags a >~90% single-bucket share even when it is not literally 100%', () => {
    // 11 of 12 = 91.7% >= 90% threshold
    const scores = [
      ...Array.from({ length: 11 }, (_, i) => mkScore(`r${i}`, 'red', 'concern', 4)),
      mkScore('g', 'green', 'excellent', 1),
    ];
    const d = scoreBandDistribution(scores);
    expect(d.collapsed).toBe(true);
  });

  it('does NOT flag an 80% single-bucket / 80% worst-two share (just under threshold)', () => {
    const scores = [
      ...Array.from({ length: 8 }, (_, i) => mkScore(`r${i}`, 'red', 'concern', 4)),
      mkScore('g', 'green', 'good', 2),
      mkScore('y', 'yellow', 'excellent', 1),
    ];
    // attention: red 8/10 = 80% single, red+orange = 80% worst-two (the 2 non-red are green/yellow);
    // health: concern 8/10 = 80% single, concern+watch = 80% worst-two — all < 90%.
    const d = scoreBandDistribution(scores);
    expect(d.collapsed).toBe(false);
  });

  it('FAILS on a distress smear across the worst TWO attention bands (orange+red) with no single band >=90%', () => {
    // A milder cross-grain leak: 6 orange + 6 red — neither single band hits 90%, but the worst
    // two combined are 100%. Health is spread so only the attention smear can trip.
    const scores = Array.from({ length: 12 }, (_, i) =>
      mkScore(`p${i}`, i % 2 === 0 ? 'orange' : 'red', HEALTH[i % 4]!, ((i % 4) + 1) as 1 | 2 | 3 | 4),
    );
    const d = scoreBandDistribution(scores);
    expect(d.collapsed).toBe(true);
    expect(d.reason).toMatch(/attentionBand distress smear/);
  });

  it('FAILS on a distress smear across the worst TWO health bands (watch+concern) with attention spread', () => {
    const scores = Array.from({ length: 12 }, (_, i) =>
      mkScore(`p${i}`, ATT[i % 4]!, i % 2 === 0 ? 'watch' : 'concern', null),
    );
    const d = scoreBandDistribution(scores);
    expect(d.collapsed).toBe(true);
    expect(d.reason).toMatch(/healthBand distress smear/);
  });

  it('does NOT flag a HEALTHY concentration in the best two bands (green+yellow / excellent+good)', () => {
    // 100% concentrated, but in the BEST bands — that is a healthy portfolio, not a scoring bug.
    const scores = Array.from({ length: 12 }, (_, i) =>
      mkScore(`p${i}`, i % 2 === 0 ? 'green' : 'yellow', i % 2 === 0 ? 'excellent' : 'good', 1),
    );
    const d = scoreBandDistribution(scores);
    expect(d.collapsed).toBe(false);
    expect(d.reason).toBeNull();
  });

  it('is deterministic — same input deep-equals on re-run', () => {
    const scores = Array.from({ length: 12 }, (_, i) => mkScore(`p${i}`, ATT[i % 4]!, HEALTH[i % 4]!, null));
    expect(scoreBandDistribution(scores)).toEqual(scoreBandDistribution(scores));
  });
});
