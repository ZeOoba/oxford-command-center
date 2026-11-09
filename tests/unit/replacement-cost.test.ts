import { describe, expect, it } from 'vitest';
import {
  RCT_V03,
  RCT_VERSION,
  vintageFloor,
  replacementCostAnalysis,
} from '../../src/brain/replacement-cost';

describe('RCT v03 table', () => {
  it('pins the ratified version so a Basis score stays reproducible', () => {
    expect(RCT_VERSION).toBe('RCT v03');
  });

  it('carries the ratified per-market LOW figures', () => {
    expect(RCT_V03['Columbus OH']!.low).toBeCloseTo(229.65, 2);
    expect(RCT_V03['Kansas City MO']!.low).toBeCloseTo(227.9, 2);
    expect(RCT_V03['Indianapolis IN']!.low).toBeCloseTo(253.83, 2);
    expect(RCT_V03['Mid-Atlantic']!.low).toBeCloseTo(232.97, 2);
  });

  it('LOW is 90% of POINT for every market (the ±10% band)', () => {
    for (const m of Object.values(RCT_V03)) {
      if (!m) continue;
      expect(m.low).toBeCloseTo(m.point * 0.9, 1);
      expect(m.high).toBeCloseTo(m.point * 1.1, 1);
    }
  });

  it('COHERENCE: all-in POINT must exceed C&W hard cost — the test RCT v02 failed', () => {
    for (const [name, m] of Object.entries(RCT_V03)) {
      if (!m) continue;
      expect(m.point, `${name}: all-in must exceed hard cost`).toBeGreaterThan(m.cwHardPsf);
      expect(m.point / m.cwHardPsf).toBeGreaterThan(1.5);
    }
  });
});

describe('vintageFloor — linear ramp 65% @<=1995 -> 60% @>=2005', () => {
  it('floors at 65% for anything 1995 or older', () => {
    expect(vintageFloor(1918)).toBeCloseTo(0.65, 4);
    expect(vintageFloor(1995)).toBeCloseTo(0.65, 4);
  });

  it('caps at 60% for anything 2005 or newer', () => {
    expect(vintageFloor(2005)).toBeCloseTo(0.6, 4);
    expect(vintageFloor(2020)).toBeCloseTo(0.6, 4);
  });

  it('interpolates linearly at -0.5%/yr between', () => {
    expect(vintageFloor(2000)).toBeCloseTo(0.625, 4);
    expect(vintageFloor(1996)).toBeCloseTo(0.645, 4);
  });

  it('UNKNOWN vintage defaults to 1995 (the STRICTEST floor) — never the loosest', () => {
    expect(vintageFloor(null)).toBeCloseTo(0.65, 4);
    expect(vintageFloor(null)).toBe(vintageFloor(1995));
    expect(vintageFloor(null)).toBeGreaterThan(vintageFloor(2005)!);
  });
});

describe('replacementCostAnalysis', () => {
  const deal = (over: Partial<Parameters<typeof replacementCostAnalysis>[0]> = {}) => ({
    sf: 40_000,
    estPrice: 3_000_000,
    market: 'Columbus OH' as const,
    yearBuilt: 1980,
    ...over,
  });

  it('returns null when SF is unknown — cannot compute a basis', () => {
    expect(replacementCostAnalysis(deal({ sf: null }))).toBeNull();
    expect(replacementCostAnalysis(deal({ sf: 0 }))).toBeNull();
  });

  it('includes the 2% closing cost in basis — doctrine defines basis as all-in', () => {
    const rc = replacementCostAnalysis(deal({ sf: 100, estPrice: 10_000 }))!;
    expect(rc.basisPsf!).toBeCloseTo(102, 6);
  });

  it('clears the floor when basis is at or below RCT LOW x (1 - floor)', () => {
    // Columbus LOW 229.65, 1980 -> floor 0.65 -> clears at 80.3775/SF
    const rc = replacementCostAnalysis(deal({ estPrice: (80 * 40_000) / 1.02 }))!;
    expect(rc.floorPsf!).toBeCloseTo(80.3775, 3);
    expect(rc.basisPsf!).toBeCloseTo(80, 6);
    expect(rc.clearsFloor).toBe(true);
    expect(rc.verdict).toBe('Clears basis floor');
  });

  it('fails the floor a dollar above it', () => {
    const rc = replacementCostAnalysis(deal({ estPrice: (81 * 40_000) / 1.02 }))!;
    expect(rc.clearsFloor).toBe(false);
    expect(rc.verdict).toBe('Fails basis floor');
  });

  it('exposes the walk price — the max price that would clear', () => {
    const rc = replacementCostAnalysis(deal())!;
    expect(rc.walkPrice!).toBeCloseTo((rc.floorPsf! * 40_000) / 1.02, 4);
    const at = replacementCostAnalysis(deal({ estPrice: rc.walkPrice! }))!;
    expect(at.clearsFloor).toBe(true);
  });

  it('a newer building gets a LOOSER floor (the ramp), so it clears at a higher price', () => {
    const old = replacementCostAnalysis(deal({ yearBuilt: 1950 }))!;
    const neu = replacementCostAnalysis(deal({ yearBuilt: 2010 }))!;
    expect(neu.floorPsf!).toBeGreaterThan(old.floorPsf!);
    expect(neu.walkPrice!).toBeGreaterThan(old.walkPrice!);
  });

  it('flags an unknown vintage and applies the STRICT default', () => {
    const rc = replacementCostAnalysis(deal({ yearBuilt: null }))!;
    expect(rc.vintageAssumed).toBe(true);
    expect(rc.floorPsf!).toBeCloseTo(229.65 * 0.35, 3);
  });

  it('refuses to invent a denominator for a market not in the RCT', () => {
    for (const m of ['Toledo OH', 'Cleveland MSA', 'Other', 'Unknown', null] as const) {
      const rc = replacementCostAnalysis(deal({ market: m }))!;
      expect(rc.marketCovered, `${m} must not be silently priced`).toBe(false);
      expect(rc.floorPsf).toBeNull();
      expect(rc.clearsFloor).toBeNull();
      expect(rc.verdict).toBeNull();
    }
  });

  it('marks PROXY markets so a verdict is never presented as fully sourced', () => {
    expect(replacementCostAnalysis(deal({ market: 'Mid-Atlantic' }))!.proxy).toBe(false);
  });

  it('price-to-replacement is measured against POINT, and ORA buys at ~35-40% of it', () => {
    const rc = replacementCostAnalysis(deal({ estPrice: (80 * 40_000) / 1.02 }))!;
    expect(rc.basisToPoint!).toBeLessThan(0.45);
    expect(rc.basisToPoint!).toBeGreaterThan(0.2);
  });
});
