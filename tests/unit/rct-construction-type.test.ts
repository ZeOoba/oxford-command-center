// tests/unit/rct-construction-type.test.ts
//
// RCT v3.2 (Gabriel in-turn 2026-11-12, PR-B of the 2026-11-12 doctrine-drift audit) brings the replacement-cost
// denominator to acquisition-underwriting SKILL.md v4.45:
//   1. Construction-Type Multiplier Schedule (v4.37): POINT × multiplier, then the adder schedule, LOW/HIGH at ±10%.
//      Tilt-up/precast 1.00 · CMU 0.97 · brick 1.10 · hybrid 0.93 · PEMB 0.88 / 0.90 / 0.92 by SF. Unknown => the PEMB
//      value for the subject SF capped at 0.90 (0.88 under ~20,000 SF), the STRICTEST applicable multiplier.
//   2. Legacy `block-tilt-brick` => CMU ×0.97 (Gabriel ruling 2026-11-12).
//   3. The true all-in walk (STAGE 1): (adjusted LOW × (1 − floor) × SF − CapEx − carry) ÷ 1.02; without CapEx/carry the
//      walk is an UPPER BOUND, labelled [EXCL. CAPEX/CARRY].
//   4. The Chicago Cook County IL row (LOW 225.59 / POINT 250.66 / HIGH 275.73), now also the cheapest-market fallback.
// Synthetic fixtures only (the drift audit's Columbus 25,000 SF case): no candidate IDs, addresses or APNs.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AcquisitionInput } from '@contracts/acquisition';
import { computeInputsVersion, loadRatifiedRct, parseRuleset, replacementCostPsf, scoreAcquisition } from '../../server/warehouse/acquisition';
import { fallbackFromConfig, rcDealFor, RCT_FALLBACK, RCT_SCHEDULE, replacementCostAnalysis, scheduleFromConfig } from '../../src/brain/replacement-cost';
import type { Deal } from '@contracts/deal';
import { adderTotal, adjustBand, constructionMultiplier, pembMultiplier, RCT_CONSTRUCTION_TYPES, tiltSfFor } from '../../src/lib/rct-adjust';
import { buildInput, dealToForm, denominatorNotes, inputToForm } from '../../src/modules/acquisitions/acquisition-score';

const rawRuleset = JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')) as Record<string, unknown>;
const rctJson = JSON.parse(readFileSync(resolve(process.cwd(), 'config/replacement-cost.v3.json'), 'utf8')) as Record<string, unknown>;
const ruleset = parseRuleset(rawRuleset);
const RCT = loadRatifiedRct();
const SCHED = RCT.constructionMultipliers;
const NOW = '2026-11-12T00:00:00Z';
const COLUMBUS = RCT.markets['Columbus OH']!;

describe('construction-type multiplier (SKILL.md v4.37 schedule)', () => {
  it('checked types take the schedule value', () => {
    expect(constructionMultiplier('tilt-precast', 30_000, SCHED)).toMatchObject({ multiplier: 1, assumed: false });
    expect(constructionMultiplier('cmu', 30_000, SCHED)).toMatchObject({ multiplier: 0.97, assumed: false, label: 'CMU ×0.97' });
    expect(constructionMultiplier('brick', 30_000, SCHED)).toMatchObject({ multiplier: 1.1, assumed: false });
    expect(constructionMultiplier('hybrid', 30_000, SCHED)).toMatchObject({ multiplier: 0.93, assumed: false });
  });

  it('PEMB size tilt: 0.88 under 20,000 SF, 0.90 to under 40,000, 0.92 to 50,000, 0.92 tagged outside band above', () => {
    const at = (sf: number | null) => constructionMultiplier('pemb', sf, SCHED);
    expect(at(19_999).multiplier).toBe(0.88);
    expect(at(20_000).multiplier).toBe(0.9);
    expect(at(39_999).multiplier).toBe(0.9);
    expect(at(40_000).multiplier).toBe(0.92);
    expect(at(50_000)).toMatchObject({ multiplier: 0.92, outsideBand: false });
    expect(at(50_001)).toMatchObject({ multiplier: 0.92, outsideBand: true });
    expect(at(50_001).label).toMatch(/outside band/);
    // unknown SF => the smallest band, the strictest value
    expect(at(null).multiplier).toBe(0.88);
  });

  it('unknown type => PEMB for the SF capped at 0.90, tagged [DATA-GAP: construction type]', () => {
    for (const t of ['unknown', null, undefined] as const) {
      expect(constructionMultiplier(t, 15_000, SCHED)).toMatchObject({ multiplier: 0.88, assumed: true });
      expect(constructionMultiplier(t, 25_000, SCHED)).toMatchObject({ multiplier: 0.9, assumed: true });
      expect(constructionMultiplier(t, 45_000, SCHED)).toMatchObject({ multiplier: 0.9, assumed: true }); // PEMB 0.92, capped
      expect(constructionMultiplier(t, 25_000, SCHED).label).toMatch(/DATA-GAP: construction type/);
    }
  });

  it('a mixed façade (no façade share in the engine) takes the strict unknown value and says why', () => {
    const m = constructionMultiplier('mixed', 25_000, SCHED);
    expect(m).toMatchObject({ multiplier: 0.9, assumed: true });
    expect(m.label).toMatch(/mixed façade/);
  });

  it('an unchecked building never prices better than a checked metal one, at any SF', () => {
    for (let sf = 1_000; sf <= 80_000; sf += 500) {
      const unknown = constructionMultiplier('unknown', sf, SCHED).multiplier;
      for (const t of RCT_CONSTRUCTION_TYPES) {
        expect(unknown, `${t} @ ${sf}`).toBeLessThanOrEqual(constructionMultiplier(t, sf, SCHED).multiplier);
      }
      expect(unknown).toBeLessThanOrEqual(pembMultiplier(sf, SCHED.pemb).multiplier);
    }
  });
});

describe('adders and the adjusted band', () => {
  it('sums each adder once and discloses stacked site-work adders', () => {
    expect(adderTotal(null, RCT.adders)).toEqual({ psf: 0, ids: [], siteWorkStacked: false });
    expect(adderTotal(['esfr', 'cranes', 'esfr'], RCT.adders)).toMatchObject({ psf: 22, siteWorkStacked: false });
    expect(adderTotal(['excess-site-work', 'paving-lighting'], RCT.adders)).toMatchObject({ psf: 16, siteWorkStacked: true });
    // a function of the set, not the sequence, even for non-integer schedule values
    const odd = { ...RCT.adders, esfr: 0.1, cranes: 0.2, 'heavy-office': 0.3 };
    expect(adderTotal(['esfr', 'cranes', 'heavy-office'], odd).psf).toBe(adderTotal(['heavy-office', 'esfr', 'cranes'], odd).psf);
  });

  it('tilt-up with no adders is EXACTLY the ratified row (no rounding drift off the ratified LOW)', () => {
    expect(adjustBand(COLUMBUS, 1, 0)).toEqual({ low: COLUMBUS.low, point: COLUMBUS.point, high: COLUMBUS.high });
  });

  it('POINT × multiplier + adders, LOW/HIGH at ±10% of the adder', () => {
    const b = adjustBand(COLUMBUS, 0.9, 22);
    expect(b.point).toBeCloseTo(255.16 * 0.9 + 22, 10);
    expect(b.low).toBeCloseTo(229.65 * 0.9 + 0.9 * 22, 10);
    expect(b.high).toBeCloseTo(280.68 * 0.9 + 1.1 * 22, 10);
  });
});

// The drift audit's synthetic case: Columbus, 25,000 SF, 1980 vintage (floor 65%). Engine walk at ×1.00 = $1,970,037.
const SF = 25_000;
const BASE: Record<string, unknown> = {
  dealId: 'rct-synthetic', market: 'Columbus OH',
  price: 1_900_000, maxBuildingSf: SF, totalSf: SF,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 24, hasDriveIn: true, hasDock: true, dockCount: 3, driveInCount: 3, multiStory: false, truckCourtFt: 120,
  constructionType: 'tilt-precast', yearBuilt: 1980,
  sfhaOnPad: false,
  allInBasis: 1_900_000, stabilizedYoc: 0.12,
  unleveredIrr10yr: 0.12, ust10yr: 0.043, ustAsOf: '2026-11-10', vacantSfShareAtClose: 0,
  clusterTier: 'owned-submarket', sellerMotivationScore: 0.8,
  isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5, valueAddScore: 0.5,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
};
const input = (over: Record<string, unknown> = {}) => AcquisitionInput.parse({ ...BASE, ...over });
const score = (over: Record<string, unknown> = {}) => scoreAcquisition(input(over), ruleset, { now: NOW, rct: RCT });
const basisFloor = (over: Record<string, unknown> = {}) => score(over).floors.find((f) => f.id === 'basis')!;

describe('engine: the Basis floor divides by the construction-type-adjusted LOW', () => {
  it.each([
    ['tilt-precast', 1],
    ['cmu', 0.97],
    ['brick', 1.1],
    ['hybrid', 0.93],
    ['pemb', 0.9],
    ['unknown', 0.9],
    [null, 0.9],
  ] as const)('%s at 25,000 SF => LOW × %s', (type, m) => {
    const f = basisFloor({ constructionType: type });
    expect(f.actual).toBeCloseTo(1 - 1_900_000 / (SF * COLUMBUS.low * m), 12);
  });

  it('adders raise the denominator (LOW + 0.90 × adder)', () => {
    const f = basisFloor({ rctAdders: ['esfr', 'heavy-office'] });
    expect(f.actual).toBeCloseTo(1 - 1_900_000 / (SF * (COLUMBUS.low + 0.9 * 19)), 12);
    expect(f.detail).toMatch(/\$19\/SF adders/);
  });

  it('cites the multiplier on the floor line, as doctrine requires on every screen', () => {
    expect(basisFloor({ constructionType: 'cmu' }).detail).toMatch(/RCT CMU ×0\.97, LOW \$222\.76\/SF/);
  });

  it('unknown construction type is the STRICTER verdict, never the looser one (the pre-v3.2 bug was the reverse)', () => {
    // At this price a tilt-up building clears the 65% floor and an unknown one does not.
    const price = 1_950_000;
    expect(basisFloor({ allInBasis: price, constructionType: 'tilt-precast' }).passed).toBe(true);
    expect(basisFloor({ allInBasis: price, constructionType: 'unknown' }).passed).toBe(false);
    const flags = score({ constructionType: 'unknown' }).dataQuality.filter((d) => d.field === 'replacementCost').map((d) => d.issue);
    expect(flags.some((i) => /strictest applicable multiplier/.test(i))).toBe(true);
  });

  it('the size tilt reads the single building SF (largest building), not the portfolio total', () => {
    const f = basisFloor({ constructionType: 'pemb', maxBuildingSf: 18_000, totalSf: 54_000, isPortfolio: true, allInBasis: 4_000_000 });
    expect(f.actual).toBeCloseTo(1 - 4_000_000 / (54_000 * COLUMBUS.low * 0.88), 12);
  });

  it('no largest-building SF => the strictest band, whatever the portfolio status (refute wf_3124f132-f17, wf_9e4b0fd3-241)', () => {
    const at = (over: Record<string, unknown>) => basisFloor({ constructionType: 'unknown', maxBuildingSf: null, totalSf: 36_000, allInBasis: 2_000_000, ...over }).actual;
    const strict = 1 - 2_000_000 / (36_000 * COLUMBUS.low * 0.88);
    // 'not a portfolio' is not 'one building' (a 6+ building deal is 'no'), so it never reads the tilt at the total
    for (const isPortfolio of [false, true, null]) expect(at({ isPortfolio }), String(isPortfolio)).toBeCloseTo(strict, 12);
    const issues = score({ constructionType: 'pemb', maxBuildingSf: null, totalSf: 36_000 }).dataQuality.map((d) => d.issue);
    expect(issues.some((i) => /largest building SF unknown/.test(i))).toBe(true);
  });

  it('isPortfolio null and false share an inputs_version key AND a verdict (the tilt never reads isPortfolio)', () => {
    const over = { constructionType: 'pemb', maxBuildingSf: null, totalSf: 36_000, allInBasis: 2_575_000, price: 1_900_000 };
    const a = input({ ...over, isPortfolio: false });
    const b = input({ ...over, isPortfolio: null });
    expect(computeInputsVersion(a, ruleset)).toBe(computeInputsVersion(b, ruleset));
    const sa = scoreAcquisition(a, ruleset, { now: NOW, rct: RCT });
    const sb = scoreAcquisition(b, ruleset, { now: NOW, rct: RCT });
    expect(sa.verdict).toBe(sb.verdict);
    expect(sa.floors.find((f) => f.id === 'basis')!.actual).toBe(sb.floors.find((f) => f.id === 'basis')!.actual);
  });

  it('a 6-building pipeline deal through the real form path reads the strictest band, as the drawer does', () => {
    const form = dealToForm({ sf: 45_000, buildings: 6, estPrice: 3_000_000, irr: null, holdYrs: null, market: 'Columbus OH' });
    const built = AcquisitionInput.parse({ ...BASE, ...buildInput({ ...form, constructionType: 'pemb' }, 'd'), maxBuildingSf: null });
    expect(built.isPortfolio).toBe(false);
    const engine = scoreAcquisition({ ...built, allInBasis: 3_250_000 }, ruleset, { now: NOW, rct: RCT }).floors.find((f) => f.id === 'basis')!;
    expect(engine.detail).toMatch(/PEMB ×0\.88/);
    const drawer = replacementCostAnalysis({ sf: 45_000, buildings: 6, estPrice: 3_000_000, market: 'Columbus OH', constructionType: 'pemb' })!;
    expect(drawer.multiplier).toBe(0.88);
  });

  it('a largest building above the total is clamped to the total and flagged', () => {
    expect(tiltSfFor(60_000, 45_000)).toBe(45_000);
    expect(tiltSfFor(30_000, 45_000)).toBe(30_000);
    expect(tiltSfFor(null, 45_000)).toBeNull();
    expect(tiltSfFor(30_000, null)).toBe(30_000);
    const s = score({ constructionType: 'pemb', maxBuildingSf: 52_000, totalSf: 18_000 });
    expect(s.floors.find((f) => f.id === 'basis')!.detail).toMatch(/PEMB ×0\.88/);
    expect(s.dataQuality.some((d) => d.field === 'maxBuildingSf' && /exceeds total SF/.test(d.issue))).toBe(true);
  });

  it('every denominator note reaches the Grader panel (denominatorNotes)', () => {
    const notes = (over: Record<string, unknown>) => denominatorNotes(score(over));
    expect(notes({ constructionType: 'unknown' }).some((n) => /strictest applicable multiplier/.test(n))).toBe(true);
    expect(notes({ constructionType: 'pemb', maxBuildingSf: null, totalSf: 36_000 }).some((n) => /largest building SF unknown/.test(n))).toBe(true);
    expect(notes({ constructionType: 'pemb', maxBuildingSf: 30_000, totalSf: 60_000 }).some((n) => /multi-building/.test(n))).toBe(true);
    expect(notes({ constructionType: 'pemb', maxBuildingSf: 52_000, totalSf: 52_000 }).some((n) => /outside the size-tilt band/.test(n))).toBe(true);
    expect(notes({ rctAdders: ['excess-site-work', 'paving-lighting'] }).some((n) => /site-work adders/.test(n))).toBe(true);
    expect(notes({ constructionType: 'pemb', maxBuildingSf: 52_000, totalSf: 18_000 }).some((n) => /exceeds total SF/.test(n))).toBe(true);
  });

  it('a multi-building deal with a known largest building discloses that the tilt is an upper bound', () => {
    const issues = score({ constructionType: 'pemb', maxBuildingSf: 30_000, totalSf: 60_000, isPortfolio: true }).dataQuality.map((d) => d.issue);
    expect(issues.some((i) => /multi-building deal/.test(i))).toBe(true);
    expect(score({ constructionType: 'tilt-precast', maxBuildingSf: 30_000, totalSf: 60_000 }).dataQuality.some((d) => /multi-building/.test(d.issue))).toBe(false);
  });

  it('discloses stacked site-work adders and PEMB outside the size band', () => {
    expect(score({ rctAdders: ['excess-site-work', 'paving-lighting'] }).dataQuality.map((d) => d.field)).toContain('rctAdders');
    const big = score({ constructionType: 'pemb', maxBuildingSf: 52_000, totalSf: 52_000 }).dataQuality.map((d) => d.issue);
    expect(big.some((i) => /outside the size-tilt band/.test(i))).toBe(true);
  });

  it('the Cat-3 construction score is unchanged by the split', () => {
    const constr = ruleset.scoring.cat3.constructionPoints;
    // The 'asset' sub-score is Cat 3 + Cat 7; Cat 7 does not read the construction type.
    const cat3 = (t: unknown) => score({ constructionType: t }).subScores.find((s) => s.id === 'asset')!.points;
    const base = cat3('tilt-precast');
    expect(cat3('cmu')).toBe(base);
    expect(cat3('brick')).toBe(base);
    expect(cat3('hybrid')).toBeCloseTo(base - constr.blockTiltBrick + constr.mixed, 10);
    expect(cat3('pemb')).toBeCloseTo(base - constr.blockTiltBrick + constr.pemb, 10);
  });
});

describe('legacy block-tilt-brick => CMU ×0.97 (Gabriel ruling 2026-11-12)', () => {
  it('parses as cmu, scores as cmu and hashes as cmu', () => {
    const legacy = input({ constructionType: 'block-tilt-brick' });
    expect(legacy.constructionType).toBe('cmu');
    expect(basisFloor({ constructionType: 'block-tilt-brick' }).actual).toBe(basisFloor({ constructionType: 'cmu' }).actual);
    expect(computeInputsVersion(legacy, ruleset)).toBe(computeInputsVersion(input({ constructionType: 'cmu' }), ruleset));
  });

  it('a stored legacy input reloads into the form as CMU', () => {
    expect(inputToForm(input({ constructionType: 'block-tilt-brick' })).constructionType).toBe('cmu');
  });

  it('decision-identical adder lists share one inputs_version key (order, duplicates, [] vs null)', () => {
    const key = (adders: unknown) => computeInputsVersion(input({ rctAdders: adders }), ruleset);
    expect(key(['esfr', 'cranes'])).toBe(key(['cranes', 'esfr']));
    expect(key(['cranes', 'esfr', 'esfr'])).toBe(key(['cranes', 'esfr']));
    expect(key([])).toBe(key(null));
    expect(key(['esfr'])).not.toBe(key(null));
  });

  it('rejects anything else outside the schedule', () => {
    expect(AcquisitionInput.safeParse({ ...BASE, constructionType: 'steel' }).success).toBe(false);
  });
});

describe('Chicago Cook County IL row (ratified 2026-11-12)', () => {
  it('is priced on its own row, not the fallback', () => {
    const s = score({ market: 'Chicago Cook County IL' });
    expect(s.dataQuality.some((d) => d.field === 'replacementCost' && /fallback/.test(d.issue))).toBe(false);
    expect(s.floors.find((f) => f.id === 'basis')!.actual).toBeCloseTo(1 - 1_900_000 / (SF * 225.59), 12);
  });

  it('the fallback is now the Chicago row — the cheapest market, so an unknown market is never looser than a ratified row', () => {
    expect(RCT.psf).toEqual({ low: 225.59, mid: 250.66, high: 275.73 });
    expect(replacementCostPsf(RCT, 'low', null).psf).toBe(225.59);
    expect(replacementCostPsf(RCT, 'low', 'Atlantis', { multiplier: 0.9, adderPsf: 0 }).psf).toBeCloseTo(225.59 * 0.9, 12);
  });

  it('the drawer prices it too', () => {
    const r = replacementCostAnalysis({ sf: SF, estPrice: 1_000_000, market: 'Chicago Cook County IL', yearBuilt: 1980, constructionType: 'tilt-precast' })!;
    expect(r.marketCovered).toBe(true);
    expect(r.floorPsf).toBeCloseTo(225.59 * 0.35, 10);
  });
});

describe('drawer: true all-in walk and construction multiplier', () => {
  const drawer = (over: Record<string, unknown> = {}) =>
    replacementCostAnalysis({ sf: SF, maxBuildingSf: SF, estPrice: 1_900_000, market: 'Columbus OH', yearBuilt: 1980, ...over })!;

  it('the drift audit\'s synthetic case: $1,970,037 at ×1.00 => $1,773,033 for an unknown type', () => {
    const tilt = drawer({ constructionType: 'tilt-precast', capex: 0, leaseUpCarry: 0 });
    expect(tilt.walkPrice!).toBeCloseTo((229.65 * 0.35 * SF) / 1.02, 6);
    expect(Math.round(tilt.walkPrice!)).toBe(1_970_037);
    const unknown = drawer({ capex: 0, leaseUpCarry: 0 });
    expect(unknown.multiplier).toBe(0.9);
    expect(unknown.multiplierAssumed).toBe(true);
    expect(Math.round(unknown.walkPrice!)).toBe(1_773_033);
    // ×1.00 is a sensitivity line only
    expect(Math.round(unknown.walkPriceAtBaseline!)).toBe(1_970_037);
    expect(tilt.walkPriceAtBaseline).toBeNull();
  });

  it('CapEx and lease-up carry come off the walk and onto the basis', () => {
    const r = drawer({ constructionType: 'tilt-precast', capex: 250_000, leaseUpCarry: 150_000 });
    expect(r.excludesCapexCarry).toBe(false);
    expect(r.walkPrice!).toBeCloseTo((229.65 * 0.35 * SF - 400_000) / 1.02, 6);
    expect(r.basisPsf!).toBeCloseTo((1_900_000 * 1.02 + 400_000) / SF, 10);
    expect(r.basis).not.toMatch(/EXCL\. CAPEX\/CARRY/);
  });

  it('unknown CapEx or carry => the walk is an UPPER BOUND, labelled [EXCL. CAPEX/CARRY]', () => {
    for (const over of [{}, { capex: 100_000 }, { leaseUpCarry: 50_000 }, { capex: null, leaseUpCarry: 0 }]) {
      const r = drawer({ constructionType: 'tilt-precast', ...over });
      expect(r.excludesCapexCarry).toBe(true);
      expect(r.basis).toMatch(/\[EXCL\. CAPEX\/CARRY\]/);
    }
    // a known part still comes off the walk; the label stays until both are known
    const partial = drawer({ constructionType: 'tilt-precast', capex: 100_000 });
    expect(partial.walkPrice!).toBeCloseTo((229.65 * 0.35 * SF - 100_000) / 1.02, 6);
  });

  it('a pipeline Deal (no type, CapEx or carry on the record) gets the strict multiplier and the upper-bound label', () => {
    const r = replacementCostAnalysis({ sf: SF, maxBuildingSf: SF, estPrice: 1_900_000, market: 'Columbus OH' })!;
    expect(r.multiplier).toBe(0.9);
    expect(r.multiplierLabel).toMatch(/DATA-GAP: construction type/);
    expect(r.excludesCapexCarry).toBe(true);
  });

  it('the drawer reads the size tilt at a single building, never the multi-building total (refute wf_3124f132-f17)', () => {
    // 3 × 12,000 SF: the total (36,000) would read ×0.90; per building (or unknown) it is ×0.88, as in the engine.
    const multi = replacementCostAnalysis({ sf: 36_000, buildings: 3, estPrice: 2_520_000, market: 'Columbus OH', yearBuilt: 1990 })!;
    expect(multi.multiplier).toBe(0.88);
    const unknownCount = replacementCostAnalysis({ sf: 36_000, estPrice: 2_520_000, market: 'Columbus OH', yearBuilt: 1990 })!;
    expect(unknownCount.multiplier).toBe(0.88);
    const withBuildingSf = replacementCostAnalysis({ sf: 36_000, buildings: 3, maxBuildingSf: 12_000, estPrice: 2_520_000, market: 'Columbus OH', yearBuilt: 1990 })!;
    expect(withBuildingSf.multiplier).toBe(0.88);
    // and the engine agrees on the same deal
    const engine = basisFloor({ constructionType: null, maxBuildingSf: null, totalSf: 36_000, isPortfolio: true, allInBasis: 2_520_000 * 1.02, yearBuilt: 1990 });
    expect(multi.clearsFloor).toBe(engine.passed);
  });

  it('a one-building Deal whose saved input has no largest-building SF prices like the engine: strictest band (refute wf_3b4097ae-24d)', () => {
    // The drawer never reads the total as a building, even with buildings === 1: the caller resolves maxBuildingSf.
    const drawer = replacementCostAnalysis({ sf: 45_000, buildings: 1, maxBuildingSf: null, estPrice: 3_150_000, market: 'Columbus OH', yearBuilt: 1980, constructionType: 'pemb' })!;
    expect(drawer.multiplier).toBe(0.88);
    const engine = basisFloor({ constructionType: 'pemb', maxBuildingSf: null, totalSf: 45_000, isPortfolio: false, allInBasis: 3_150_000 * 1.02 });
    expect(engine.detail).toMatch(/PEMB ×0\.88/);
    expect(drawer.clearsFloor).toBe(engine.passed);
  });

  it('a saved input whose market has no RCT row is priced on the engine\'s strictest fallback, never the Deal\'s row (refute wf_a7d3a06f-2a8)', () => {
    for (const market of [null, 'Other', 'Unknown', 'Toledo OH'] as const) {
      const drawer = replacementCostAnalysis({
        sf: 20_000, maxBuildingSf: 20_000, estPrice: 1_710_000 / 1.02, market, yearBuilt: 2000, constructionType: 'tilt-precast', engineFallback: true,
      })!;
      expect(drawer.onFallback, String(market)).toBe(true);
      expect(drawer.marketCovered).toBe(true);
      expect(drawer.basis).toMatch(/strictest firm-wide fallback/);
      const engine = basisFloor({ market, maxBuildingSf: 20_000, totalSf: 20_000, yearBuilt: 2000, allInBasis: 1_710_000, constructionType: 'tilt-precast' });
      expect(drawer.floorPsf! / (1 - drawer.vintageFloorPct!)).toBeCloseTo(RCT.psf.low, 9);
      expect(drawer.clearsFloor).toBe(engine.passed);
    }
    // without a saved input the drawer still prices nothing for an uncovered market
    const bare = replacementCostAnalysis({ sf: 20_000, estPrice: 1_000_000, market: 'Other' })!;
    expect(bare.marketCovered).toBe(false);
    expect(bare.onFallback).toBe(false);
    // a covered market never takes the fallback
    expect(replacementCostAnalysis({ sf: 20_000, estPrice: 1_000_000, market: 'Columbus OH', engineFallback: true })!.onFallback).toBe(false);
    expect(RCT_FALLBACK).toMatchObject({ low: 225.59, point: 250.66, high: 275.73 });
    expect(fallbackFromConfig({ ...rctJson, ratification: 'proposed' })).toBeNull();
  });

  describe('rcDealFor: one record per basis test (refute wf_0b88835c-c66)', () => {
    const pipelineDeal = {
      id: 'd', name: 'Synthetic', shortName: null, location: null, market: 'Cincinnati OH', sf: 30_000, buildings: 1,
      stage: 'Candidate', estPrice: 1_500_000, capRate: null, irr: null, equityMultiple: null, holdYrs: null, lender: null,
      status: null, nextAction: null, owner: null, targetCloseDate: null, notionDealId: null, confidential: false, estimatedFields: [],
    } as unknown as Deal;

    it('with a saved input, the numerator, SF and market all come from it, and the verdict matches the engine', () => {
      // Pipeline record is stale (30K SF / $1.5M, Cincinnati); the underwriter's saved input says 40K SF, $3.4M all-in, Columbus.
      const saved = input({ market: 'Columbus OH', totalSf: 40_000, maxBuildingSf: 40_000, price: 3_300_000, allInBasis: 3_400_000, constructionType: 'cmu', yearBuilt: 1980 });
      const rc = replacementCostAnalysis(rcDealFor(pipelineDeal, saved))!;
      expect(rc.basisFromSavedAllIn).toBe(true);
      expect(rc.basisPsf).toBeCloseTo(3_400_000 / 40_000, 10);
      expect(rc.basis).toMatch(/Columbus OH/);
      const engine = scoreAcquisition(saved, ruleset, { now: NOW, rct: RCT }).floors.find((f) => f.id === 'basis')!;
      expect(rc.clearsFloor).toBe(engine.passed);
      // and across a sweep of saved all-in bases, drawer and engine never disagree
      for (let allIn = 2_000_000; allIn <= 4_000_000; allIn += 25_000) {
        const s = input({ market: 'Columbus OH', totalSf: 40_000, maxBuildingSf: 40_000, allInBasis: allIn, constructionType: 'pemb', yearBuilt: 1980 });
        const d = replacementCostAnalysis(rcDealFor(pipelineDeal, s))!;
        const e = scoreAcquisition(s, ruleset, { now: NOW, rct: RCT }).floors.find((f) => f.id === 'basis')!;
        expect(d.clearsFloor, String(allIn)).toBe(e.passed);
      }
    });

    it('at the exact floor boundary, drawer and engine agree (one shared predicate; refute wf_fa550461-ced)', () => {
      const markets = ['Kansas City MO', 'Chicago Cook County IL', 'Louisville KY', 'Columbus OH', 'Toledo OH'] as const;
      const types = ['tilt-precast', 'pemb', 'cmu', null] as const;
      const adderSets = [[], ['esfr'], ['heavy-office', 'cranes']] as const;
      let checked = 0;
      for (const market of markets) for (const constructionType of types) for (const adders of adderSets)
        for (const sf of [6_000, 10_000, 17_000, 30_000]) for (const yearBuilt of [null, 1999, 2003]) {
          const probe = input({ market, totalSf: sf, maxBuildingSf: sf, constructionType, rctAdders: [...adders], yearBuilt, allInBasis: 1 });
          const lowPsf = replacementCostPsf(RCT, 'low', market, {
            multiplier: constructionMultiplier(constructionType, sf, SCHED).multiplier, adderPsf: adderTotal([...adders], RCT.adders).psf,
          }).psf;
          const boundary = lowPsf * (1 - basisFloor({ yearBuilt }).required) * sf;
          for (const allIn of [Math.floor(boundary), Math.round(boundary), Math.ceil(boundary), Math.round(boundary * 100) / 100]) {
            const saved = AcquisitionInput.parse({ ...probe, allInBasis: allIn });
            const engine = scoreAcquisition(saved, ruleset, { now: NOW, rct: RCT }).floors.find((f) => f.id === 'basis')!;
            const drawer = replacementCostAnalysis(rcDealFor(pipelineDeal, saved))!;
            expect(drawer.clearsFloor, `${market} ${constructionType} ${adders.join('+')} ${sf} ${yearBuilt} ${allIn}`).toBe(engine.passed);
            checked++;
          }
        }
      expect(checked).toBeGreaterThan(2000);
    });

    it('a saved input with no all-in basis gets no verdict (the engine floor is indeterminate) and never borrows the Deal price', () => {
      const saved = input({ market: 'Columbus OH', totalSf: 40_000, maxBuildingSf: 40_000, price: 3_300_000, allInBasis: null });
      const rc = replacementCostAnalysis(rcDealFor(pipelineDeal, saved))!;
      expect(rc.clearsFloor).toBeNull();
      expect(rc.verdict).toBeNull();
      expect(rc.basisPsf).toBeCloseTo((3_300_000 * 1.02) / 40_000, 10); // the saved price, shown as an estimate
      const noPrice = replacementCostAnalysis(rcDealFor(pipelineDeal, input({ market: 'Columbus OH', totalSf: 40_000, price: null, allInBasis: null })))!;
      expect(noPrice.basisPsf).toBeNull(); // not the Deal's $1.5M against the saved 40K SF
      const engine = scoreAcquisition(saved, ruleset, { now: NOW, rct: RCT }).floors.find((f) => f.id === 'basis')!;
      expect(engine.actual).toBeNull();
    });

    it('a saved input with no SF prices nothing, as the engine floor is indeterminate (never the Deal SF)', () => {
      const saved = input({ market: 'Columbus OH', totalSf: null, maxBuildingSf: null, allInBasis: 2_000_000, yearBuilt: 1990 });
      expect(replacementCostAnalysis(rcDealFor(pipelineDeal, saved))).toBeNull();
      const engine = scoreAcquisition(saved, ruleset, { now: NOW, rct: RCT }).floors.find((f) => f.id === 'basis')!;
      expect(engine.actual).toBeNull();
      expect(engine.passed).toBe(false);
    });

    it('a free-string market naming an Object.prototype key takes the fallback in the engine too', () => {
      expect(replacementCostPsf(RCT, 'low', 'constructor').psf).toBe(RCT.psf.low);
      expect(replacementCostPsf(RCT, 'low', 'toString')).toMatchObject({ marketCovered: false });
    });

    it('a saved market with no RCT row is labelled by name and priced on the fallback, never on the Deal row', () => {
      const saved = input({ market: 'Toledo OH', totalSf: 30_000, maxBuildingSf: 30_000, allInBasis: 2_000_000, constructionType: 'tilt-precast' });
      const rc = replacementCostAnalysis(rcDealFor(pipelineDeal, saved))!;
      expect(rc.onFallback).toBe(true);
      expect(rc.basis).toMatch(/Toledo OH \(not priced: strictest firm-wide fallback\)/);
    });

    it('without a saved input the Deal is priced as before (largest building known only for one building)', () => {
      expect(rcDealFor(pipelineDeal, null)).toMatchObject({ sf: 30_000, estPrice: 1_500_000, market: 'Cincinnati OH', maxBuildingSf: 30_000 });
      expect(rcDealFor({ ...pipelineDeal, buildings: 3 } as Deal, null).maxBuildingSf).toBeNull();
    });
  });

  it('drawer and engine divide by the same adjusted LOW for every type, SF band and adder set', () => {
    const adderSets = [[], ['esfr'], ['cranes', 'heavy-office', 'paving-lighting']] as const;
    for (const t of [...RCT_CONSTRUCTION_TYPES, null]) {
      for (const sf of [12_000, 25_000, 45_000, 60_000]) {
        for (const adders of adderSets) {
          const r = replacementCostAnalysis({ sf, maxBuildingSf: sf, estPrice: 1_000_000, market: 'Indianapolis IN', yearBuilt: 1980, constructionType: t, rctAdders: [...adders] })!;
          const m = constructionMultiplier(t, sf, SCHED);
          const engineLow = replacementCostPsf(RCT, 'low', 'Indianapolis IN', { multiplier: m.multiplier, adderPsf: adderTotal([...adders], RCT.adders).psf }).psf;
          expect(r.floorPsf! / (1 - r.vintageFloorPct!), `${t} ${sf} ${adders.join('+')}`).toBeCloseTo(engineLow, 9);
        }
      }
    }
  });

  it('the drawer schedule fails closed on an unsigned, mis-versioned or malformed config', () => {
    expect(RCT_SCHEDULE).not.toBeNull();
    expect(scheduleFromConfig({ ...rctJson, ratification: 'proposed' })).toBeNull();
    expect(scheduleFromConfig({ ...rctJson, rctVersion: 'replacement-cost.v3.1' })).toBeNull();
    expect(scheduleFromConfig({ ...rctJson, constructionMultipliers: { ...(rctJson.constructionMultipliers as object), cmu: 0 } })).toBeNull();
    expect(scheduleFromConfig({ ...rctJson, adders: { ...(rctJson.adders as object), esfr: -1 } })).toBeNull();
    const { adders: _a, ...noAdders } = rctJson;
    expect(scheduleFromConfig(noAdders)).toBeNull();
  });
});

describe('scoring form: adders round-trip', () => {
  it('ticked adders assemble into rctAdders and reload', () => {
    const built = buildInput({ 'adder:esfr': 'true', 'adder:cranes': 'true', 'adder:heavy-office': '' , constructionType: 'pemb' }, 'd');
    expect(built.rctAdders).toEqual(['cranes', 'esfr']);
    expect(built.constructionType).toBe('pemb');
    const parsed = AcquisitionInput.parse({ ...BASE, ...built });
    const f = inputToForm(parsed);
    expect(f['adder:esfr']).toBe('true');
    expect(f['adder:cranes']).toBe('true');
    expect(f['adder:heavy-office']).toBeUndefined();
  });

  it('no ticked adder sends no rctAdders (the stricter denominator)', () => {
    expect(buildInput({ constructionType: 'cmu' }, 'd').rctAdders).toBeUndefined();
  });
});
