// tests/unit/acquisition-ruleset-v2.test.ts
//
// Ruleset 2.0.0 (Gabriel in-turn ratification 2026-11-12) — brings the engine to acquisition-underwriting SKILL.md v4.45:
//   1. IRR floor (SKILL.md STAGE 1 "IRR floor", v4.33/v4.40): 10-yr UNLEVERED IRR >= MAX(10.0%, 10-yr UST + 550 bps),
//      + 100 bps when > 50% of the SF is vacant at close. Levered IRR is REPORTED ONLY — never a floor (the retired
//      levered >= 15% 5-yr / >= 12% 10-yr floor is gone). UST unknown => test at 10.0% and flag [UST UNVERIFIED].
//   2. Basis full credit (SKILL.md STAGE 2 row 1): 25 pts at >= 76% discount (was 0.90 in the engine).
//   3. Yield floor (SKILL.md STAGE 1 "Yield floor"): stabilized YoC STRICTLY > 8%.
// Synthetic fixtures only: no candidate IDs, addresses or APNs.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AcquisitionInput, RULESET_VERSION } from '@contracts/acquisition';
import { assertProductionRuleset, loadRatifiedRct, parseRuleset, parseUtcAnchoredDate, scoreAcquisition } from '../../server/warehouse/acquisition';
import { buildInput } from '../../src/modules/acquisitions/acquisition-score';

const rawJson = JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')) as Record<string, unknown>;
const ruleset = parseRuleset(rawJson);
const RCT = loadRatifiedRct();
const NOW = '2026-11-12T00:00:00Z';

// No market => the firm-wide conservative RCT fallback LOW ($/SF) is the divisor. Read it, never hand-type it.
const FALLBACK_LOW_PSF = RCT.psf.low;
const TOTAL_SF = 60_000;
const REPLACEMENT = TOTAL_SF * FALLBACK_LOW_PSF;

const BASE: Record<string, unknown> = {
  dealId: 'v2-synthetic',
  price: 3_500_000, maxBuildingSf: 42_000, totalSf: TOTAL_SF,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6, multiStory: false, truckCourtFt: 120,
  constructionType: 'block-tilt-brick', yearBuilt: 2005,
  sfhaOnPad: false,
  allInBasis: 1_200_000, stabilizedYoc: 0.12,
  unleveredIrr10yr: 0.12, ust10yr: 0.043, ustAsOf: '2026-11-10', vacantSfShareAtClose: 0,
  leveredIrr: 0.18, underwriteHorizonYrs: 5,
  clusterTier: 'owned-submarket',
  sellerMotivationScore: 0.8,
  isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5,
  valueAddScore: 0.5,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
};
const deal = (over: Record<string, unknown> = {}) => AcquisitionInput.parse({ ...BASE, ...over });
const score = (over: Record<string, unknown> = {}) => scoreAcquisition(deal(over), ruleset, { now: NOW, rct: RCT });
const irrFloor = (over: Record<string, unknown> = {}) => score(over).floors.find((f) => f.id === 'irr')!;
const flagFields = (over: Record<string, unknown> = {}) => score(over).dataQuality.map((d) => d.field);

describe('ruleset 2.0.0 — ratified values (Gabriel in-turn 2026-11-12)', () => {
  it('is version 2.0.0, ratified, signed and cites SKILL.md v4.45', () => {
    expect(ruleset.rulesetVersion).toBe('2.0.0');
    expect(RULESET_VERSION).toBe('2.0.0');
    expect(ruleset.ratification).toBe('ratified');
    expect(ruleset.ratifiedBy).toBe('Gabriel Goldberg');
    expect(ruleset.ratifiedDate).toBe('2026-11-12');
    expect(ruleset.skillVersion).toBe('acquisition-underwriting v4.45');
    expect(() => assertProductionRuleset(ruleset)).not.toThrow();
  });
  it('carries the unlevered IRR floor and no levered IRR floor', () => {
    expect(ruleset.floors.unleveredIrrFloorMin).toBe(0.10);
    expect(ruleset.floors.unleveredIrrUstSpread).toBe(0.055);
    expect(ruleset.floors.majorityVacantIrrPremium).toBe(0.01);
    expect(ruleset.floors.majorityVacantSfShare).toBe(0.5);
    expect(rawJson.floors).not.toHaveProperty('leveredIrrFloor5yr');
    expect(rawJson.floors).not.toHaveProperty('leveredIrrFloor10yr');
  });
  it('basisFullCreditDiscount is 0.76 and the vintage ramp and yield anchors are unchanged', () => {
    expect(ruleset.scoring.basisFullCreditDiscount).toBe(0.76);
    expect(ruleset.floors.basisDiscountMinPreMillennium).toBe(0.65);
    expect(ruleset.floors.basisDiscountMinPostMillennium).toBe(0.6);
    expect(ruleset.floors.stabilizedYocFloorPct).toBe(0.08);
    expect(ruleset.scoring.yocZeroPct).toBe(0.08);
    expect(ruleset.scoring.yocFullPct).toBe(0.11);
  });
  it('the archived 1.1.0 ruleset is preserved (Invariant 6)', () => {
    const archived = JSON.parse(readFileSync(resolve(process.cwd(), 'config/archive/acquisition-ruleset.v1.1.0.json'), 'utf8'));
    expect(archived.rulesetVersion).toBe('1.1.0');
    expect(archived.floors.leveredIrrFloor5yr).toBe(0.15);
    expect(archived.scoring.basisFullCreditDiscount).toBe(0.9);
  });
});

describe('IRR floor — 10-yr unlevered, MAX(10%, UST + 550 bps)', () => {
  it('reads unleveredIrr10yr; levered IRR never decides the floor', () => {
    const f = irrFloor({ leveredIrr: 0.05, unleveredIrr10yr: 0.12 });
    expect(f.actual).toBe(0.12);
    expect(f.passed).toBe(true);
    expect(score({ leveredIrr: 0.05, unleveredIrr10yr: 0.12 }).verdict).not.toBe('KILLED');
  });
  it('a strong levered IRR cannot stand in for a missing unlevered IRR (indeterminate, caps at T2)', () => {
    const s = score({ leveredIrr: 0.30, unleveredIrr10yr: null });
    const f = s.floors.find((x) => x.id === 'irr')!;
    expect(f.actual).toBeNull();
    expect(f.passed).toBe(false);
    expect(s.floorIndeterminate).toBe(true);
    expect(s.tier).not.toBe('T1');
    expect(s.verdict).not.toBe('KILLED');
    expect(s.dataQuality.map((d) => d.field)).toContain('unleveredIrr10yr');
  });
  it('required = 10.0% when UST + 550 bps is below 10%', () => {
    expect(irrFloor({ ust10yr: 0.040 }).required).toBeCloseTo(0.10, 10);
    expect(irrFloor({ ust10yr: 0.045 }).required).toBeCloseTo(0.10, 10);
  });
  it('required = UST + 550 bps when that is above 10%', () => {
    expect(irrFloor({ ust10yr: 0.05 }).required).toBeCloseTo(0.105, 10);
    expect(irrFloor({ ust10yr: 0.052 }).required).toBeCloseTo(0.107, 10);
  });
  it('UST unknown => test at 10.0% and flag [UST UNVERIFIED]', () => {
    const s = score({ ust10yr: null, ustAsOf: null });
    expect(s.floors.find((f) => f.id === 'irr')!.required).toBeCloseTo(0.10, 10);
    const flag = s.dataQuality.find((d) => d.field === 'ust10yr');
    expect(flag?.issue).toMatch(/UST UNVERIFIED/);
  });
  it('a UST without its as-of date is used but flagged (the floor line must cite value and date)', () => {
    expect(flagFields({ ustAsOf: null })).toContain('ustAsOf');
    expect(irrFloor({ ust10yr: 0.05, ustAsOf: null }).required).toBeCloseTo(0.105, 10);
  });
  it('the floor detail cites the UST value and date', () => {
    expect(irrFloor({ ust10yr: 0.043, ustAsOf: '2026-11-10' }).detail).toMatch(/UST 4\.30% as of 2026-11-10/);
  });
  it('boundary: unlevered IRR exactly at the floor passes (>=)', () => {
    expect(irrFloor({ ust10yr: 0.05, unleveredIrr10yr: 0.105 }).passed).toBe(true);
  });
  it('a computable unlevered IRR below the floor fails the floor (engine floor-miss semantics unchanged in 2.0.0)', () => {
    const s = score({ unleveredIrr10yr: 0.0999 });
    expect(s.floors.find((f) => f.id === 'irr')!.passed).toBe(false);
    expect(s.floorsPassed).toBe(false);
    expect(s.verdict).toBe('KILLED');
  });
});

describe('IRR floor — majority-vacant premium (+100 bps when > 50% SF vacant at close)', () => {
  it('adds 100 bps when the vacant share is above 50%', () => {
    expect(irrFloor({ vacantSfShareAtClose: 0.6, ust10yr: 0.04 }).required).toBeCloseTo(0.11, 10);
    expect(irrFloor({ vacantSfShareAtClose: 0.6, ust10yr: 0.05 }).required).toBeCloseTo(0.115, 10);
  });
  it('exactly 50% vacant is not majority-vacant', () => {
    expect(irrFloor({ vacantSfShareAtClose: 0.5, ust10yr: 0.04 }).required).toBeCloseTo(0.10, 10);
  });
  it('a fully vacant deal (isVacant) with no share supplied takes the premium', () => {
    expect(irrFloor({ isVacant: true, vacantSfShareAtClose: null, ust10yr: 0.04 }).required).toBeCloseTo(0.11, 10);
  });
  it('isVacant wins over a contradictory low share (strictest reading)', () => {
    expect(irrFloor({ isVacant: true, vacantSfShareAtClose: 0.2, ust10yr: 0.04 }).required).toBeCloseTo(0.11, 10);
  });
  it('unknown vacant share on a not-fully-vacant deal: no premium, flagged', () => {
    const s = score({ vacantSfShareAtClose: null, ust10yr: 0.04 });
    expect(s.floors.find((f) => f.id === 'irr')!.required).toBeCloseTo(0.10, 10);
    expect(s.dataQuality.map((d) => d.field)).toContain('vacantSfShareAtClose');
  });
  it('the detail names the premium when applied', () => {
    expect(irrFloor({ vacantSfShareAtClose: 0.6 }).detail).toMatch(/majority-vacant \+100 bps/);
  });
});

describe('Basis ramp — 25 pts at >= 76% discount', () => {
  // yearBuilt 2005 => vintage floor 0.60; Yield at 12% YoC is full 20, so basis sub-score = cat1 + 20.
  const basisSub = (discount: number) =>
    score({ allInBasis: (1 - discount) * REPLACEMENT }).subScores.find((x) => x.id === 'basis')!.points;
  it('0 at the vintage floor', () => {
    expect(basisSub(0.60)).toBeCloseTo(20, 1);
  });
  it('linear between the floor and 76%', () => {
    expect(basisSub(0.70)).toBeCloseTo(20 + 25 * (0.10 / 0.16), 1);
    expect(basisSub(0.68)).toBeCloseTo(20 + 25 * (0.08 / 0.16), 1);
  });
  it('full 25 at 76% and above', () => {
    expect(basisSub(0.76)).toBeCloseTo(45, 1);
    expect(basisSub(0.85)).toBeCloseTo(45, 1);
  });
  it('pre-1995 vintage (65% floor): 70% discount earns 25 x 5/11', () => {
    const pts = score({ yearBuilt: 1990, allInBasis: 0.30 * REPLACEMENT }).subScores.find((x) => x.id === 'basis')!.points;
    expect(pts).toBeCloseTo(20 + 25 * (0.05 / 0.11), 1);
  });
});

describe('Yield floor — stabilized YoC strictly above 8%', () => {
  const yieldFloor = (yoc: number) => score({ stabilizedYoc: yoc }).floors.find((f) => f.id === 'yield')!;
  it('exactly 8.0% fails', () => {
    expect(yieldFloor(0.08).passed).toBe(false);
  });
  it('just above 8.0% passes', () => {
    expect(yieldFloor(0.0801).passed).toBe(true);
  });
});

// ── Refute wf_27e6656a-51c (medium): the Grader form converts percents with n/100, which can land one ULP below the
// decimal (10.1/100 = 0.10099999999999999). Both sides of the comparison are now rounded to 1e-8. ──
describe('IRR floor — exact-boundary entries through the Grader form path', () => {
  const viaForm = (form: Record<string, string>, over: Record<string, unknown> = {}) =>
    scoreAcquisition(AcquisitionInput.parse({ ...BASE, ...over, ...buildInput(form, 'v2-synthetic') }), ruleset, { now: NOW, rct: RCT })
      .floors.find((f) => f.id === 'irr')!;
  it('UST 4.6% / IRR 10.1% (the reported repro) passes', () => {
    const f = viaForm({ ust10yr: '4.6', unleveredIrr10yr: '10.1', ustAsOf: '2026-11-10' });
    expect(f.required).toBeCloseTo(0.101, 10);
    expect(f.passed).toBe(true);
  });
  it('UST 4.54% / IRR 10.04% passes', () => {
    expect(viaForm({ ust10yr: '4.54', unleveredIrr10yr: '10.04', ustAsOf: '2026-11-10' }).passed).toBe(true);
  });
  it('UST 4.52% + majority vacant / IRR 11.02% passes', () => {
    expect(viaForm({ ust10yr: '4.52', unleveredIrr10yr: '11.02', ustAsOf: '2026-11-10', vacantSfShareAtClose: '60' }).passed).toBe(true);
  });
  it('sweep: every 2-dp UST from 0.00% to 20.00%, with and without the premium, entered exactly at the floor, passes; one bp below fails', () => {
    const misses: string[] = [];
    for (let bp = 0; bp <= 2000; bp++) {
      const ust = (bp / 100).toFixed(2);
      for (const share of ['0', '60']) {
        const reqPct = Math.max(10, bp / 100 + 5.5) + (share === '60' ? 1 : 0);
        const at = viaForm({ ust10yr: ust, unleveredIrr10yr: reqPct.toFixed(2), ustAsOf: '2026-11-10', vacantSfShareAtClose: share });
        const below = viaForm({ ust10yr: ust, unleveredIrr10yr: (reqPct - 0.01).toFixed(2), ustAsOf: '2026-11-10', vacantSfShareAtClose: share });
        if (!at.passed || below.passed) misses.push(`${ust}/${share}`);
      }
    }
    expect(misses).toEqual([]);
  });
});

// ── Gabriel in-turn 2026-11-12: unknown vacant share caps at T2 only when it DECIDES the floor. ──
describe('IRR floor — unknown vacant share decides the floor => indeterminate', () => {
  const unknown = { vacantSfShareAtClose: null, ust10yr: 0.04 }; // floor 10.00%, 11.00% if majority-vacant
  it('IRR between the two floors: indeterminate (null actual, T2 cap, not KILLED), IRR visible in the detail', () => {
    const s = score({ ...unknown, unleveredIrr10yr: 0.105 });
    const f = s.floors.find((x) => x.id === 'irr')!;
    expect(f.actual).toBeNull();
    expect(f.passed).toBe(false);
    expect(f.detail).toMatch(/10\.50%/);
    expect(f.detail).toMatch(/11\.00% if majority-vacant/);
    expect(s.floorIndeterminate).toBe(true);
    expect(s.verdict).not.toBe('KILLED');
    expect(s.tier).not.toBe('T1');
  });
  it('IRR clears even the premium floor: passes', () => {
    const f = irrFloor({ ...unknown, unleveredIrr10yr: 0.11 });
    expect(f.passed).toBe(true);
    expect(f.actual).toBe(0.11);
  });
  it('IRR below the no-premium floor: a decided miss, still KILLED', () => {
    expect(score({ ...unknown, unleveredIrr10yr: 0.0999 }).verdict).toBe('KILLED');
  });
  it('a known share or isVacant never produces the indeterminate case', () => {
    expect(irrFloor({ vacantSfShareAtClose: 0.2, ust10yr: 0.04, unleveredIrr10yr: 0.105 }).passed).toBe(true);
    expect(score({ isVacant: true, vacantSfShareAtClose: null, ust10yr: 0.04, unleveredIrr10yr: 0.105 }).verdict).toBe('KILLED');
  });
});

describe('IRR floor — UST date is checked against the screen date', () => {
  it('a UST dated more than 30 days before the screen is flagged', () => {
    const s = score({ asAtUtc: '2026-11-12T00:00:00Z', ustAsOf: '2026-09-01' });
    expect(s.dataQuality.find((d) => d.field === 'ustAsOf')?.issue).toMatch(/days before the screen/);
  });
  it('a UST dated after the screen is flagged', () => {
    const s = score({ asAtUtc: '2026-11-12T00:00:00Z', ustAsOf: '2026-12-15' });
    expect(s.dataQuality.find((d) => d.field === 'ustAsOf')?.issue).toMatch(/after the screen date/);
  });
  it('a UST dated within the 30-day window is not flagged', () => {
    expect(flagFields({ asAtUtc: '2026-11-12T00:00:00Z', ustAsOf: '2026-11-10' })).not.toContain('ustAsOf');
  });
});

// ── Refute wf_47a03538-486: the UST recency check must run on production paths (which set no asAtUtc) and must not
// depend on the host timezone. ──
describe('IRR floor — UST recency on production paths', () => {
  it('no asAtUtc: checked against the scoring clock (a 2019 UST is flagged)', () => {
    const s = score({ asAtUtc: null, ustAsOf: '2019-01-02' }); // score() passes now = 2026-11-12
    expect(s.dataQuality.find((d) => d.field === 'ustAsOf')?.issue).toMatch(/days before the screen/);
  });
  it('the Grader form path (ISO-Z date, no asAtUtc) is checked too', () => {
    const input = AcquisitionInput.parse({ ...BASE, asAtUtc: null, ...buildInput({ ust10yr: '3.0', ustAsOf: '2019-01-02', unleveredIrr10yr: '12' }, 'v2-synthetic') });
    const s = scoreAcquisition(input, ruleset, { now: NOW, rct: RCT });
    expect(s.dataQuality.find((d) => d.field === 'ustAsOf')?.issue).toMatch(/days before the screen/);
  });
  it('a current UST on the form path is not flagged', () => {
    const input = AcquisitionInput.parse({ ...BASE, asAtUtc: null, ...buildInput({ ust10yr: '4.3', ustAsOf: '2026-11-10', unleveredIrr10yr: '12' }, 'v2-synthetic') });
    expect(scoreAcquisition(input, ruleset, { now: NOW, rct: RCT }).dataQuality.map((d) => d.field)).not.toContain('ustAsOf');
  });
  it('a non-UTC-anchored ustAsOf is flagged, never read in the host timezone', () => {
    for (const bad of ['10/13/2026', '2026-10-13T00:00:00']) {
      const s = score({ ustAsOf: bad });
      expect(s.dataQuality.find((d) => d.field === 'ustAsOf')?.issue).toMatch(/not a UTC-anchored date/);
    }
  });
  it('parseUtcAnchoredDate: date-only is UTC midnight; offsets honoured; zone-less rejected', () => {
    expect(parseUtcAnchoredDate('2026-10-13')).toBe(Date.UTC(2026, 9, 13));
    expect(parseUtcAnchoredDate('2026-10-13T05:00:00-05:00')).toBe(Date.UTC(2026, 9, 13, 10));
    expect(parseUtcAnchoredDate('2026-10-13T00:00:00.000Z')).toBe(Date.UTC(2026, 9, 13));
    expect(Number.isNaN(parseUtcAnchoredDate('2026-10-13T00:00:00'))).toBe(true);
    expect(Number.isNaN(parseUtcAnchoredDate('10/13/2026'))).toBe(true);
  });
});

// ── Refute wf_23a4f392-2bb (lows, fixed in-pass). ──
describe('round-3 lows', () => {
  it('parseUtcAnchoredDate rejects calendar-impossible dates instead of rolling them forward', () => {
    for (const bad of ['2026-02-30', '2026-11-31', '2026-13-01', '2026-11-12T24:00Z', '2026-11-12T10:60:00Z']) {
      expect(Number.isNaN(parseUtcAnchoredDate(bad))).toBe(true);
    }
    expect(parseUtcAnchoredDate('2028-02-29')).toBe(Date.UTC(2028, 1, 29)); // leap day is real
    expect(score({ ustAsOf: '2026-02-30' }).dataQuality.find((d) => d.field === 'ustAsOf')?.issue).toMatch(/not a UTC-anchored date/);
  });
  it('UST recency compares whole UTC days: the same dates flag the same at 00:30Z and 23:59Z', () => {
    const at = (now: string) => scoreAcquisition(deal({ asAtUtc: null, ustAsOf: '2026-10-12' }), ruleset, { now, rct: RCT })
      .dataQuality.filter((d) => d.field === 'ustAsOf').map((d) => d.issue);
    expect(at('2026-11-12T00:30:00Z')).toEqual(at('2026-11-12T23:59:00Z'));
    expect(at('2026-11-12T00:30:00Z')[0]).toMatch(/31 days before/);
    expect(scoreAcquisition(deal({ asAtUtc: null, ustAsOf: '2026-10-13' }), ruleset, { now: '2026-11-12T23:59:00Z', rct: RCT })
      .dataQuality.map((d) => d.field)).not.toContain('ustAsOf'); // exactly 30 days: inside the window
  });
  it('the undecided-premium case raises exactly one vacantSfShareAtClose flag', () => {
    const s = score({ vacantSfShareAtClose: null, ust10yr: 0.04, unleveredIrr10yr: 0.1005 });
    expect(s.dataQuality.filter((d) => d.field === 'vacantSfShareAtClose')).toHaveLength(1);
  });
  it('contradictory vacancy inputs are flagged', () => {
    expect(score({ isVacant: false, vacantSfShareAtClose: 1 }).dataQuality.find((d) => d.field === 'vacantSfShareAtClose')?.issue)
      .toMatch(/not marked 100% vacant/);
    expect(score({ isVacant: true, vacantSfShareAtClose: 0.4 }).dataQuality.find((d) => d.field === 'vacantSfShareAtClose')?.issue)
      .toMatch(/marked 100% vacant but vacant SF share at close is 40%/);
    expect(score({ isVacant: true, vacantSfShareAtClose: 1 }).dataQuality.map((d) => d.field)).not.toContain('vacantSfShareAtClose');
  });
});
