import { describe, it, expect } from 'vitest';
import { REPLACEMENT_COST_PSF, replacementCostAnalysis } from '../../src/brain/replacement-cost';

describe('replacementCostAnalysis', () => {
  it('exposes the ratified ORA $125–$150/SF basis (mid $137.50)', () => {
    expect(REPLACEMENT_COST_PSF.low).toBe(125);
    expect(REPLACEMENT_COST_PSF.high).toBe(150);
    expect(REPLACEMENT_COST_PSF.mid).toBe(137.5);
  });

  it('returns null when SF is missing or non-positive', () => {
    expect(replacementCostAnalysis({ sf: null, estPrice: 1_000_000 })).toBeNull();
    expect(replacementCostAnalysis({ sf: 0, estPrice: 1_000_000 })).toBeNull();
  });

  it('computes low/mid/high replacement cost from SF', () => {
    const r = replacementCostAnalysis({ sf: 50_000, estPrice: null })!;
    expect(r.low).toBe(50_000 * 125);
    expect(r.mid).toBe(50_000 * 137.5);
    expect(r.high).toBe(50_000 * 150);
    expect(r.priceToReplacementMid).toBeNull();
    expect(r.verdict).toBeNull();
  });

  it('flags a discount when price is well below mid replacement', () => {
    const r = replacementCostAnalysis({ sf: 50_000, estPrice: 4_000_000 })!;
    expect(r.priceToReplacementMid).toBeCloseTo(4_000_000 / (50_000 * 137.5), 4);
    expect(r.verdict).toBe('Discount to replacement');
  });

  it('flags near-replacement within ±10% of mid', () => {
    const mid = 50_000 * 137.5;
    expect(replacementCostAnalysis({ sf: 50_000, estPrice: mid })!.verdict).toBe('Near replacement');
    expect(replacementCostAnalysis({ sf: 50_000, estPrice: mid * 1.05 })!.verdict).toBe('Near replacement');
  });

  it('flags a premium when price exceeds 110% of mid', () => {
    const mid = 50_000 * 137.5;
    expect(replacementCostAnalysis({ sf: 50_000, estPrice: mid * 1.25 })!.verdict).toBe('Premium to replacement');
  });

  it('basis string derives from REPLACEMENT_COST_PSF constants (never a stale hardcoded range)', () => {
    const r = replacementCostAnalysis({ sf: 10_000, estPrice: null })!;
    // Basis must reflect the live low/high constants so a future constant update auto-updates the UI.
    expect(r.basis).toContain(`${REPLACEMENT_COST_PSF.low}`);
    expect(r.basis).toContain(`${REPLACEMENT_COST_PSF.high}`);
    // Must NOT contain the old stale range.
    expect(r.basis).not.toContain('$85');
    expect(r.basis).not.toContain('$120/SF');
  });
});
