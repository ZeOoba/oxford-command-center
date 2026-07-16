// tests/unit/acquisition-score.test.ts
import { describe, it, expect } from 'vitest';
import { AcquisitionInput } from '@contracts/acquisition';
import { FIELD_GROUPS, buildInput, dealToForm, inputToForm } from '../../src/modules/acquisitions/acquisition-score';

describe('acquisition Workbench form mapping', () => {
  it('inputToForm → buildInput round-trips the key fields (persistence reload)', () => {
    const input = AcquisitionInput.parse({
      dealId: 'd1', price: 4_800_000, totalSf: 60_000, maxBuildingSf: 42_000,
      productType: 'shallow-bay-multi', officePct: 0.1, clearHeightFt: 28,
      multiStory: false, hasDock: true, dockCount: 6, constructionType: 'block-tilt-brick',
      sfhaOnPad: false, allInBasis: 3_600_000, stabilizedYoc: 0.12, leveredIrr: 0.18,
      underwriteHorizonYrs: 5, clusterTier: 'owned-submarket', sellerMotivationScore: 0.8,
      isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5, valueAddScore: 0.5,
      ddKnown: { flood: true, roof: true },
    });
    const round = buildInput(inputToForm(input), 'd1');
    expect(round.dealId).toBe('d1');
    expect(round.price).toBe(4_800_000);
    expect(round.maxBuildingSf).toBe(42_000);
    expect(round.clusterTier).toBe('owned-submarket');
    expect(round.constructionType).toBe('block-tilt-brick');
    expect(round.underwriteHorizonYrs).toBe(5);
    expect(round.stabilizedYoc).toBeCloseTo(0.12, 9);   // pct round-trip
    expect(round.sellerMotivationScore).toBeCloseTo(0.8, 9); // frac01 round-trip
    expect(round.multiStory).toBe(false);  // tribool 'no' → false (preserves unknown-vs-false)
    expect(round.sfhaOnPad).toBe(false);
    expect(round.ddKnown).toEqual({ flood: true, roof: true });
  });

  it('an unset tri-state stays UNKNOWN through the round-trip (never coerced to false)', () => {
    const input = AcquisitionInput.parse({ dealId: 'd2' }); // everything null/unknown
    const round = buildInput(inputToForm(input), 'd2');
    expect('multiStory' in round).toBe(false);  // omitted ⇒ server applies null (unknown), not false
    expect('sfhaOnPad' in round).toBe(false);
    expect(round.ddKnown).toBeUndefined();
  });

  it('dealToForm prefills price / SF / IRR / horizon from a pipeline Deal', () => {
    const f = dealToForm({ sf: 50_000, estPrice: 4_000_000, irr: 0.16, holdYrs: 5 });
    expect(f.price).toBe('4000000');
    expect(f.totalSf).toBe('50000');
    expect(f.leveredIrr).toBe('16');          // decimal → percent
    expect(f.underwriteHorizonYrs).toBe('5');
  });
});

describe('RCT v03 hygiene — the Workbench form must not present the retired flat table', () => {
  const allSpecs = FIELD_GROUPS.flatMap((g) => g.fields);

  it('does not render the DORMANT replacementCostBand selector (engine ignores it since the 2026-07-14 refute fix)', () => {
    // The Basis floor/score divisor is HARDCODED to the per-market RCT LOW (see
    // server/warehouse/acquisition.ts `rcBand`). A form control that appears to choose the divisor
    // band — but is silently ignored — misrepresents how the deal is actually scored.
    expect(allSpecs.some((s) => s.key === 'replacementCostBand')).toBe(false);
  });

  it('carries no label/option text asserting the retired flat $125/$137.50/$150 replacement cost', () => {
    // Those figures were the superseded replacement-cost.v1 flat table — roughly HALF true all-in
    // shallow-bay replacement cost. RCT v03 (ratified 2026-07-14) is per-market; the UI must never
    // present the old constants as live.
    const texts = allSpecs.flatMap((s) => [s.label, s.hint ?? '', ...(s.options ?? []).map((o) => o.label)]);
    for (const t of texts) {
      expect(t, `stale flat-RCT figure in form text: "${t}"`).not.toMatch(/\$1(25|37\.50?|50)\s*\/\s*SF/);
    }
  });
});
