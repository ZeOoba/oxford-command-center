// tests/unit/acquisition-score.test.ts
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it, expect } from 'vitest';
import { AcquisitionInput, ReplacementCostTable } from '@contracts/acquisition';
import { RCT_V03 } from '../../src/brain/replacement-cost';
import { scoreAcquisition, parseRuleset } from '../../server/warehouse/acquisition';
import { FIELD_GROUPS, applyDealMarket, buildInput, dealToForm, inputToForm } from '../../src/modules/acquisitions/acquisition-score';

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
    const f = dealToForm({ sf: 50_000, buildings: 1, estPrice: 4_000_000, irr: 0.16, holdYrs: 5 });
    expect(f.price).toBe('4000000');
    expect(f.totalSf).toBe('50000');
    expect(f.leveredIrr).toBe('16');          // decimal → percent
    expect(f.underwriteHorizonYrs).toBe('5');
  });
});

// Audit 2026-11-08 other-use-gate-unfed-fail-open: the other-use KILL gate had no input producer, and unknown inputs
// now cap the verdict at T2, so the underwriting form must be able to confirm them (tenure, env remediation, use).
describe('other-use gate inputs on the underwriting form (audit 2026-11-08)', () => {
  const keys = FIELD_GROUPS.flatMap((g) => g.fields).map((f) => f.key);

  it('carries tenure, ground-lease term, env remediation and the three use flags', () => {
    for (const k of ['groundLeased', 'groundLeaseYearsRemaining', 'envRemediationPctOfPrice', 'use:automotive', 'use:childRelated', 'use:childSafetyReviewed']) {
      expect(keys).toContain(k);
    }
  });

  it('round-trips confirmed other-use inputs (fee simple, 0% remediation, no disqualifying use)', () => {
    const input = AcquisitionInput.parse({
      dealId: 'ou1', groundLeased: false, envRemediationPctOfPrice: 0,
      use: { automotive: false, childRelated: true, childSafetyReviewed: true },
    });
    const round = buildInput(inputToForm(input), 'ou1');
    expect(round.groundLeased).toBe(false);
    expect(round.envRemediationPctOfPrice).toBe(0);
    expect(round.use).toEqual({ automotive: false, childRelated: true, childSafetyReviewed: true });
    expect(AcquisitionInput.parse(round).use).toEqual(input.use);
  });

  it('round-trips a ground-leased deal with its remaining term', () => {
    const input = AcquisitionInput.parse({ dealId: 'ou2', groundLeased: true, groundLeaseYearsRemaining: 40 });
    const round = buildInput(inputToForm(input), 'ou2');
    expect(round.groundLeased).toBe(true);
    expect(round.groundLeaseYearsRemaining).toBe(40);
  });

  it('leaves use UNKNOWN unless the screen is complete (a partial answer is not a screen, and never a KILL)', () => {
    expect('use' in buildInput({ 'use:automotive': 'no' }, 'ou3')).toBe(false);
    expect('use' in buildInput({ 'use:childRelated': 'no', 'use:childSafetyReviewed': 'yes' }, 'ou3')).toBe(false);
    // child-related with the safety review left blank stays UNKNOWN (caps at T2) — a blank is not "not reviewed"
    expect('use' in buildInput({ 'use:automotive': 'no', 'use:childRelated': 'yes' }, 'ou3')).toBe(false);
    expect(buildInput({ 'use:automotive': 'no', 'use:childRelated': 'yes', 'use:childSafetyReviewed': 'no' }, 'ou3').use)
      .toEqual({ automotive: false, childRelated: true, childSafetyReviewed: false });
    // not child-related: the safety-review field is irrelevant and may stay blank
    expect(buildInput({ 'use:automotive': 'no', 'use:childRelated': 'no' }, 'ou3').use)
      .toEqual({ automotive: false, childRelated: false, childSafetyReviewed: false });
  });

  it('tenure "No (fee simple)" drops a leftover ground-lease term so stale form state cannot KILL (refute wf_5337efe6-574)', () => {
    const round = buildInput({ groundLeased: 'no', groundLeaseYearsRemaining: '10' }, 'ou5');
    expect(round.groundLeased).toBe(false);
    expect('groundLeaseYearsRemaining' in round).toBe(false);
    // the term is kept when ground-leased or when tenure is unanswered (the engine then tests it)
    expect(buildInput({ groundLeased: 'yes', groundLeaseYearsRemaining: '10' }, 'ou5').groundLeaseYearsRemaining).toBe(10);
    expect(buildInput({ groundLeaseYearsRemaining: '10' }, 'ou5').groundLeaseYearsRemaining).toBe(10);
  });

  it('an untouched form leaves every other-use input unknown', () => {
    const round = buildInput(inputToForm(AcquisitionInput.parse({ dealId: 'ou4' })), 'ou4');
    for (const k of ['groundLeased', 'groundLeaseYearsRemaining', 'envRemediationPctOfPrice', 'use']) expect(k in round).toBe(false);
  });

  // Review N1: a KILL already determined by the answers given must never be dropped because another use box is blank.
  // Full 4x4x4 matrix of (unset | yes | no | '') answers, scored by the real engine on an otherwise PURSUE-grade deal.
  describe('use answers x engine verdict — every combination (review N1)', () => {
    const rct = ReplacementCostTable.parse(JSON.parse(readFileSync(resolve(process.cwd(), 'config/replacement-cost.v3.json'), 'utf8')));
    const ruleset = parseRuleset(JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')));
    const BASE: Record<string, unknown> = {
      dealId: 'm', price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000, productType: 'shallow-bay-multi', officePct: 0.1,
      clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6, multiStory: false, truckCourtFt: 120,
      constructionType: 'block-tilt-brick', yearBuilt: 2005, sfhaOnPad: false, groundLeased: false, envRemediationPctOfPrice: 0,
      allInBasis: 1_200_000, stabilizedYoc: 0.12, leveredIrr: 0.18, underwriteHorizonYrs: 5, clusterTier: 'owned-submarket',
      sellerMotivationScore: 0.8, isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5, valueAddScore: 0.5,
      ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
    };
    const verdictFor = (form: Record<string, string>) => {
      const use = (buildInput(form, 'm') as { use?: unknown }).use ?? null;
      return { use, verdict: scoreAcquisition(AcquisitionInput.parse({ ...BASE, use }), ruleset, { now: '2026-06-13T00:00:00Z', rct }).verdict };
    };
    const VALS = [undefined, 'yes', 'no', ''] as const;
    const cases: Array<[string | undefined, string | undefined, string | undefined]> = [];
    for (const a of VALS) for (const c of VALS) for (const r of VALS) cases.push([a, c, r]);

    it.each(cases)('automotive=%j childRelated=%j reviewed=%j', (a, c, r) => {
      const form: Record<string, string> = {};
      if (a !== undefined) form['use:automotive'] = a;
      if (c !== undefined) form['use:childRelated'] = c;
      if (r !== undefined) form['use:childSafetyReviewed'] = r;
      const { use, verdict } = verdictFor(form);
      const knownKill = a === 'yes' || (c === 'yes' && r === 'no');
      const screened = (a === 'yes' || a === 'no') && (c === 'no' || (c === 'yes' && (r === 'yes' || r === 'no')));
      if (knownKill) expect(verdict).toBe('KILLED');                 // a confirmed disqualifier is never dropped
      else if (screened) { expect(use).not.toBeNull(); expect(verdict).toBe('PURSUE'); }
      else { expect(use).toBeNull(); expect(verdict).toBe('WATCH'); } // incomplete screen: unknown, T2 cap, never KILL
    });

    it.each([
      [{ 'use:automotive': 'yes' }],
      [{ 'use:automotive': 'yes', 'use:childRelated': '' }],
      [{ 'use:automotive': 'yes', 'use:childRelated': 'yes' }],
      [{ 'use:automotive': 'yes', 'use:childRelated': 'yes', 'use:childSafetyReviewed': '' }],
      [{ 'use:childRelated': 'yes', 'use:childSafetyReviewed': 'no' }],
      [{ 'use:automotive': '', 'use:childRelated': 'yes', 'use:childSafetyReviewed': 'no' }],
    ])('partly blank but already disqualified %j -> KILLED', (form) => {
      expect(verdictFor(form).verdict).toBe('KILLED');
    });

    it('reloading a KILL with blanks restores only the decisive answers (a filled-in false never reappears as "no")', () => {
      const autoOnly = inputToForm(AcquisitionInput.parse({ dealId: 'k1', ...{ use: buildInput({ 'use:automotive': 'yes' }, 'k1').use } }));
      expect(autoOnly['use:automotive']).toBe('yes');
      expect(autoOnly['use:childRelated']).toBeUndefined();
      expect(autoOnly['use:childSafetyReviewed']).toBeUndefined();
      const childOnly = inputToForm(AcquisitionInput.parse({ dealId: 'k2', use: buildInput({ 'use:childRelated': 'yes', 'use:childSafetyReviewed': 'no' }, 'k2').use }));
      expect(childOnly['use:automotive']).toBeUndefined();
      expect(childOnly).toMatchObject({ 'use:childRelated': 'yes', 'use:childSafetyReviewed': 'no' });
      // and flipping the decisive answer after reload yields an incomplete screen (unknown), not a clean pass
      expect('use' in buildInput({ ...autoOnly, 'use:automotive': 'no' }, 'k1')).toBe(false);
      expect('use' in buildInput({ ...childOnly, 'use:childSafetyReviewed': 'yes' }, 'k2')).toBe(false);
    });

    // Review R1 (save -> reload -> edit). Case A: automotive=yes, child-related=yes, review blank. Case B: a clean screen
    // with child-related=no and review blank. Neither may reload a review answer the user never gave, and editing another
    // box after reload must not KILL on that phantom "no".
    const reload = (form: Record<string, string>) => inputToForm(AcquisitionInput.parse({ dealId: 'r', use: buildInput(form, 'r').use }));
    it('Case A: automotive KILL with an incomplete child screen reloads no child answers; flipping automotive is unknown, not KILLED', () => {
      const f = reload({ 'use:automotive': 'yes', 'use:childRelated': 'yes' });
      expect(f['use:automotive']).toBe('yes');
      expect(f['use:childRelated']).toBeUndefined();
      expect(f['use:childSafetyReviewed']).toBeUndefined();
      expect(verdictFor({ ...f, 'use:automotive': 'no' }).verdict).toBe('WATCH');
    });
    it('Case B: child-related=no with review blank reloads no review answer; marking child-related=yes is unknown, not KILLED', () => {
      const f = reload({ 'use:automotive': 'no', 'use:childRelated': 'no' });
      expect(f).toMatchObject({ 'use:automotive': 'no', 'use:childRelated': 'no' });
      expect(f['use:childSafetyReviewed']).toBeUndefined();
      expect(verdictFor({ ...f, 'use:childRelated': 'yes' }).verdict).toBe('WATCH');
    });
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

// OI-356 (cc-audit-army 2026-09-28): no live UI path ever set AcquisitionInput.market, so every UI-scored
// deal scored on the strictest firm-wide fallback (Kansas City LOW) while the deal drawer priced the deal by
// its own market. The form now carries the market, so the engine and the drawer use the same denominator.
describe('market plumbing: the deal form carries the market to the engine (OI-356)', () => {
  const rct = ReplacementCostTable.parse(JSON.parse(readFileSync(resolve(process.cwd(), 'config/replacement-cost.v3.json'), 'utf8')));
  const ruleset = parseRuleset(JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')));
  const deal = (market: string | null) => ({ sf: 60_000, estPrice: 3_000_000, irr: null, holdYrs: null, market } as never);
  const scoreFor = (market: string | null) =>
    scoreAcquisition(AcquisitionInput.parse({ ...buildInput(dealToForm(deal(market)), 'd'), allInBasis: 3_000_000, yearBuilt: 2000 }), ruleset, { rct });
  const replacementFlags = (m: string | null) => scoreFor(m).dataQuality.filter((f) => f.field === 'replacementCost').map((f) => f.issue);

  it('offers a Market select whose options are exactly the markets that have an RCT row', () => {
    const spec = FIELD_GROUPS.flatMap((g) => g.fields).find((f) => f.key === 'market');
    expect(spec?.kind).toBe('select');
    expect((spec?.options ?? []).map((o) => o.value).sort()).toEqual(Object.keys(RCT_V03).sort());
  });

  it('dealToForm prefills a covered market and leaves an uncovered one blank (never guessed)', () => {
    expect(dealToForm(deal('Cincinnati OH')).market).toBe('Cincinnati OH');
    expect(dealToForm(deal('Toledo OH')).market).toBeUndefined();
    expect(dealToForm(deal(null)).market).toBeUndefined();
  });

  it('buildInput emits the market and inputToForm round-trips it', () => {
    const built = buildInput(dealToForm(deal('Louisville KY')), 'd');
    expect(built.market).toBe('Louisville KY');
    expect(inputToForm(AcquisitionInput.parse(built)).market).toBe('Louisville KY');
  });

  it('a SAVED input that predates the Market field picks the market up from the deal (would otherwise rescore on the fallback)', () => {
    const saved = AcquisitionInput.parse({ dealId: 'd', price: 3_000_000, totalSf: 60_000 }); // no market stored
    const form = applyDealMarket(inputToForm(saved), deal('Richmond VA'));
    expect(form.market).toBe('Richmond VA');
    expect(buildInput(form, 'd').market).toBe('Richmond VA');
  });

  it('applyDealMarket never overrides a market the underwriter chose, and ignores an uncovered deal market', () => {
    expect(applyDealMarket({ market: 'Columbus OH' }, deal('Richmond VA')).market).toBe('Columbus OH');
    expect(applyDealMarket({}, deal('Toledo OH')).market).toBeUndefined();
    expect(applyDealMarket({}, null).market).toBeUndefined();
  });

  it('a stored market with no RCT row loads blank instead of a value the select cannot show', () => {
    const saved = AcquisitionInput.parse({ dealId: 'd', market: 'Toledo OH' });
    expect(inputToForm(saved).market).toBeUndefined();
  });

  it('every RCT market resolves to a per-market denominator through the REAL form -> engine path (no "not supplied" fallback flag)', () => {
    for (const market of Object.keys(RCT_V03)) {
      const msgs = replacementFlags(market).join(' | ');
      expect(msgs, `${market} fell back to the firm-wide denominator`).not.toMatch(/not supplied|not in /);
    }
  });

  it('a deal with no market still scores, on the strictest fallback, and says so', () => {
    expect(replacementFlags(null).join(' ')).toMatch(/not supplied/);
  });

  it('proxy markets carry the DENOMINATOR-SENSITIVE flag, matching the drawer warning', () => {
    for (const [market, entry] of Object.entries(RCT_V03)) {
      const msgs = replacementFlags(market).join(' ');
      if (entry?.proxy) expect(msgs, market).toMatch(/PROXY/);
      else expect(msgs, market).not.toMatch(/PROXY/);
    }
  });
});

// Audit 2026-11-08 dealtoform-portfolio-sf-false-kill. dealToForm prefilled maxBuildingSf (the per-building < 50K gate input)
// with the Deal's TOTAL SF, so a multi-building portfolio of small buildings (e.g. 3 x 30K = 90K) was KILLED on a building
// that does not exist. A pipeline Deal carries only total SF and a building count, never per-building SF, so the largest
// building is KNOWN only for a single-building deal. Mechanism only: the ratified 50K gate value is unchanged.
describe('dealToForm: per-building SF, never total SF, feeds the size gate (audit 2026-11-08)', () => {
  const rct = ReplacementCostTable.parse(JSON.parse(readFileSync(resolve(process.cwd(), 'config/replacement-cost.v3.json'), 'utf8')));
  const ruleset = parseRuleset(JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')));
  const gateMax = ruleset.gates.sizePrice.maxSfPerBuilding;
  const base = { estPrice: 9_000_000, irr: null, holdYrs: null, market: null } as const;
  const sizeGate = (form: Record<string, string>) =>
    scoreAcquisition(AcquisitionInput.parse(buildInput(form, 'd')), ruleset, { rct }).gates.find((g) => g.id === 'size-price')!;

  it('a 3-building 90K SF portfolio does not prefill maxBuildingSf with the 90K total, and is marked a portfolio', () => {
    const f = dealToForm({ ...base, sf: 90_000, buildings: 3 });
    expect(f.totalSf).toBe('90000');
    expect(f.maxBuildingSf).toBeUndefined();
    expect(f.isPortfolio).toBe('yes');
  });

  it('the portfolio is scored on the portfolio price cap and is not KILLED by its total SF (size gate unconfirmed, not failed)', () => {
    const f = dealToForm({ ...base, sf: 90_000, buildings: 3, estPrice: ruleset.gates.sizePrice.singleAssetPriceMax + 2_000_000 });
    const input = AcquisitionInput.parse(buildInput(f, 'd'));
    expect(input.isPortfolio).toBe(true);
    expect(input.maxBuildingSf).toBeNull();
    const g = sizeGate(f);
    expect(g.passed).toBe(true);
    expect(g.detail).toMatch(/SF unknown/);
  });

  it('once the underwriter enters the largest building, the unchanged gate value decides', () => {
    const f = dealToForm({ ...base, sf: 90_000, buildings: 3 });
    expect(sizeGate({ ...f, maxBuildingSf: String(gateMax - 1) }).passed).toBe(true);
    expect(sizeGate({ ...f, maxBuildingSf: String(gateMax) }).passed).toBe(false);
  });

  it('a single-building deal prefills the largest building with its SF and is not a portfolio', () => {
    const f = dealToForm({ ...base, sf: 42_000, buildings: 1 });
    expect(f.maxBuildingSf).toBe('42000');
    expect(f.isPortfolio).toBe('no');
    const big = dealToForm({ ...base, sf: 60_000, buildings: 1 });
    expect(sizeGate(big).passed).toBe(false); // a genuinely oversized single building still KILLs
  });

  it('isPortfolio is prefilled yes only for a 2-5 building portfolio (Amendment H); a larger count is left blank', () => {
    expect(dealToForm({ ...base, sf: 40_000, buildings: 2 }).isPortfolio).toBe('yes');
    expect(dealToForm({ ...base, sf: 90_000, buildings: 5 }).isPortfolio).toBe('yes');
    const six = dealToForm({ ...base, sf: 120_000, buildings: 6 });
    expect(six.isPortfolio).toBeUndefined();
    expect(six.maxBuildingSf).toBeUndefined();
  });

  it('an unknown building count prefills neither (total SF is not proof of the largest building)', () => {
    for (const buildings of [null, undefined, 0] as const) {
      const f = dealToForm({ ...base, sf: 60_000, buildings });
      expect(f.totalSf).toBe('60000');
      expect(f.maxBuildingSf).toBeUndefined();
      expect(f.isPortfolio).toBeUndefined();
    }
  });
});
