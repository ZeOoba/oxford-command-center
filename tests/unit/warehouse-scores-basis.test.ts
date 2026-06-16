import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import { scoreProperties } from '../../server/warehouse/scores';
import { CANON_PROPERTIES, seedPropertyMaster } from '../../server/warehouse/property-master';
import type { PeriodMetrics } from '../../server/warehouse/metrics';

// scoreProperties uses the db only for canonical names; the metrics drive every score. Synthetic
// PeriodMetrics (cast convention) — only the fields the scorer reads need to be present. A real
// operating building by default (rentableSf 20000); `overrides` lets a test model a SF-less, non-
// real-estate entity (e.g. a rooftop-solar PPA royalty: rentableSf null, every $/SF metric null).
const pm = (
  propertyId: string,
  basis: string,
  noiPerSf: number,
  overrides: Partial<PeriodMetrics> = {},
): PeriodMetrics =>
  ({
    propertyId,
    propertyName: propertyId,
    period: '2025',
    grainHint: 'year', // full-year ⇒ this IS the level/benchmark period
    basis,
    rentableSf: 20000,
    noiPerSf,
    revenue: 100000,
    opex: 40000,
    noi: 60000,
    noiMargin: 0.6,
    expenseRatio: 0.4,
    revenuePerSf: noiPerSf * 2,
    taxesPerSf: 1,
    insurancePerSf: 0.5,
    repairsPerSf: 0.5,
    ownershipPct: 1,
    categories: {},
    revenueCategories: {},
    ...overrides,
  } as unknown as PeriodMetrics);

function db() {
  const dir = mkdtempSync(join(tmpdir(), 'whs-basis-'));
  const d = openWarehouse(join(dir, 'f.sqlite'));
  seedPropertyMaster(d);
  return d;
}

describe('scoring cross-basis discipline (G3 — partition by basis; cross-basis never feeds capital-allocation)', () => {
  it('a property with no same-basis peers is basis-isolated: quartile null, benchmark + efficiency sub-scores neutral, no invest/disposition', () => {
    const scores = scoreProperties(db(), [
      pm('1100-rarig-ave-columbus-oh', 'cash', 5),
      pm('9050-red-branch-rd-columbia-md', 'accrual', 6),
    ]);
    expect(scores.length).toBe(2);
    for (const s of scores) {
      expect(s.noiPerSfQuartile).toBeNull();                 // no same-basis peer ⇒ no quartile
      expect(s.subScores.benchmarkPosition).toBe(50);        // neutral
      // The four efficiency sub-scores must NOT be cross-basis percentiles — neutralized to 50.
      expect(s.subScores.expenseEfficiency).toBe(50);
      expect(s.subScores.taxEfficiency).toBe(50);
      expect(s.subScores.insuranceEfficiency).toBe(50);
      expect(s.subScores.repairEfficiency).toBe(50);
      expect(s.capitalAction).not.toBe('invest');
      expect(s.capitalAction).not.toBe('disposition-candidate');
      expect(s.reasons.some((r) => /same-basis|like-for-like/i.test(r))).toBe(true);
    }
  });

  it('ranks normally within a single-basis cohort (no isolation, real quartiles)', () => {
    const scores = scoreProperties(db(), [
      pm('1100-rarig-ave-columbus-oh', 'cash', 5),
      pm('9050-red-branch-rd-columbia-md', 'cash', 6),
    ]);
    expect(scores.some((s) => s.noiPerSfQuartile !== null)).toBe(true);
    expect(scores.every((s) => !/like-for-like/i.test(s.reasons.join(' ')))).toBe(true);
  });

  it('isolates an unknown-basis property — never pools it with other unknowns (unknown is not a comparable basis)', () => {
    const scores = scoreProperties(db(), [
      pm('1100-rarig-ave-columbus-oh', 'unknown', 5),
      pm('9050-red-branch-rd-columbia-md', 'unknown', 6),
      pm('3540-e-5th-ave-columbus-oh', 'cash', 4),
    ]);
    // The two 'unknown' properties must NOT rank against each other (an 'unknown' may be cash/accrual/tax).
    for (const id of ['1100-rarig-ave-columbus-oh', '9050-red-branch-rd-columbia-md']) {
      const s = scores.find((x) => x.propertyId === id)!;
      expect(s.noiPerSfQuartile).toBeNull();
      expect(s.subScores.benchmarkPosition).toBe(50);
      expect(s.subScores.expenseEfficiency).toBe(50);
      expect(s.reasons.some((r) => /basis unknown/i.test(r))).toBe(true);
    }
  });

  it('does NOT kill the whole cohort: a single off-basis property leaves the same-basis majority ranked (medium-finding regression)', () => {
    const cash = Array.from({ length: 13 }, (_, i) => pm(`cash-prop-${i}`, 'cash', 3 + i * 0.5));
    const accrual = pm('accrual-prop', 'accrual', 7);
    const scores = scoreProperties(db(), [...cash, accrual]);
    const accrualScore = scores.find((s) => s.propertyId === 'accrual-prop')!;
    const cashScores = scores.filter((s) => s.propertyId.startsWith('cash-prop-'));
    // The lone accrual property is isolated: ranked against just itself ⇒ quartile null.
    expect(accrualScore.noiPerSfQuartile).toBeNull();
    expect(accrualScore.reasons.some((r) => /1 same-basis \(accrual\)/.test(r))).toBe(true);
    // The 13 cash properties still rank against EACH OTHER — quartiles are NOT nulled portfolio-wide.
    expect(cashScores.filter((s) => s.noiPerSfQuartile !== null).length).toBeGreaterThanOrEqual(10);
    // The cash majority is benchmarked against its 13 same-basis peers (only the 1 accrual excluded).
    expect(cashScores.every((s) => s.reasons.some((r) => /13 same-basis \(cash\)/.test(r)))).toBe(true);
  });
});

describe('efficiency cohorts exclude SF-less (non-real-estate) entities — latent capital-allocation artifact exposed by 8ca91a5', () => {
  // A SF-less, non-real-estate operating entity: 1851 S Club is a 25% rooftop-solar PPA royalty with
  // NO building owned (rentableSf null). Every $/SF metric is null (perSf divides by SF), but
  // expenseRatio is revenue-based (opex/revenue) so it stays FINITE — the exact asymmetry behind the
  // defect: it self-excludes from the $/SF cohorts but not from the revenue-ratio expense cohort.
  const sfLessSolar = (expenseRatio: number): PeriodMetrics =>
    pm('1851-s-club-solar', 'accrual', 0, {
      rentableSf: null,
      noiPerSf: null,
      revenuePerSf: null,
      taxesPerSf: null,
      insurancePerSf: null,
      repairsPerSf: null,
      expenseRatio,
    });
  // A real industrial building (55 New Plant Ct, 34534 SF) — the other accrual-basis property.
  const realBuilding = (expenseRatio: number): PeriodMetrics =>
    pm('55-new-plant-ct-owings-mills-md', 'accrual', 6, { rentableSf: 34534, expenseRatio });

  it('a SF-less accrual entity does NOT pollute a real building\'s efficiency cohort — all four efficiency sub-scores stay neutral-50 when the only same-basis peer is SF-less', () => {
    // solar's expenseRatio (0.60) is WORSE than the building's (0.45): pre-fix the degenerate
    // 2-member accrual cohort {building, solar} percentile-ranked the building best-in-cohort ⇒
    // expenseEfficiency 100 (a spurious ~+5.0 health lift; weight 0.10). The per-SF cohorts already
    // dropped the SF-less solar (null ÷ SF); excluding it from the expense cohort too leaves the
    // building with no same-basis peer ⇒ singleton ⇒ neutral 50.
    const scores = scoreProperties(db(), [realBuilding(0.45), sfLessSolar(0.60)]);
    const building = scores.find((s) => s.propertyId === '55-new-plant-ct-owings-mills-md')!;
    expect(building).toBeDefined();
    expect(building.subScores.expenseEfficiency).toBe(50); // was a spurious 100 pre-fix
    expect(building.subScores.taxEfficiency).toBe(50);       // already 50 (per-SF null) — locked in
    expect(building.subScores.insuranceEfficiency).toBe(50);
    expect(building.subScores.repairEfficiency).toBe(50);
  });

  it('the SF-less entity does not change the real building\'s health at all (no spurious lift vs scoring the building alone)', () => {
    const withSolar = scoreProperties(db(), [realBuilding(0.45), sfLessSolar(0.60)])
      .find((s) => s.propertyId === '55-new-plant-ct-owings-mills-md')!;
    const alone = scoreProperties(db(), [realBuilding(0.45)])
      .find((s) => s.propertyId === '55-new-plant-ct-owings-mills-md')!;
    expect(withSolar).toBeDefined();
    expect(alone).toBeDefined();
    // The non-operating entity must be invisible to the building's capital-allocation score.
    expect(withSolar.subScores.expenseEfficiency).toBe(alone.subScores.expenseEfficiency);
    expect(withSolar.health).toBe(alone.health); // pre-fix: 58.5 vs 53.5 — a +5.0 artifact
  });

  it('the SF-less entity itself is not scored on a real building\'s cohort — neutral 50 even when its (meaningless) expense ratio would otherwise rank best', () => {
    // Here solar's expenseRatio (0.30) is LOWER than the building's (0.50): pre-fix solar self-ranked
    // best-in-cohort ⇒ expenseEfficiency 100 off a real building's value. A SF-less entity has no
    // comparable operating-expense profile ⇒ must be neutral 50.
    const scores = scoreProperties(db(), [realBuilding(0.50), sfLessSolar(0.30)]);
    const solar = scores.find((s) => s.propertyId === '1851-s-club-solar')!;
    expect(solar).toBeDefined();
    expect(solar.subScores.expenseEfficiency).toBe(50); // was a spurious 100 pre-fix
  });

  it('does NOT over-exclude: two genuine same-basis real-estate operating peers still produce a real expenseEfficiency percentile (not collapsed to 50)', () => {
    const scores = scoreProperties(db(), [
      pm('55-new-plant-ct-owings-mills-md', 'accrual', 6, { rentableSf: 34534, expenseRatio: 0.40 }), // best
      pm('9050-red-branch-rd-columbia-md', 'accrual', 5, { rentableSf: 90000, expenseRatio: 0.55 }),
    ]);
    const better = scores.find((s) => s.propertyId === '55-new-plant-ct-owings-mills-md')!;
    expect(better).toBeDefined();
    // Two real operating peers ⇒ a genuine percentile; the lower-expense-ratio building ranks best in
    // a 2-member cohort ⇒ 100, proving the SF-less guard did not collapse the real cohort to neutral.
    expect(better.subScores.expenseEfficiency).toBe(100);
  });
});

describe('negative-revenue guard — distressed property must not score as most-efficient (unguarded sibling of the growth null-on-non-positive guard)', () => {
  // metrics.ts computes expenseRatio = opex/revenue, guarding only revenue!==0. When revenue<0
  // (a large credit/refund nets out gross rent), expenseRatio is negative. Pre-fix:
  // efficiencyExpenseRatio() returned m.expenseRatio for any operating RE entity without checking
  // the sign; percentileRank(-8.0, peers) = 0 → efficiencyScore = 100 (best-in-cohort) even
  // though the property is bleeding money. The growth path correctly nulls on prev<=0 — this is
  // the analogous guard for the level-efficiency path.
  it('a property with negative revenue scores expenseEfficiency neutral (50), not ~100', () => {
    const distressed = pm('1100-rarig-ave-columbus-oh', 'cash', -0.1, {
      revenue: -5000,
      opex: 40000,
      noi: -45000,
      expenseRatio: -8.0, // opex / negative revenue → negative ratio
    });
    const peer = pm('9050-red-branch-rd-columbia-md', 'cash', 5, {
      revenue: 100000,
      opex: 40000,
      expenseRatio: 0.4,
    });
    const scores = scoreProperties(db(), [distressed, peer]);
    const d = scores.find((s) => s.propertyId === '1100-rarig-ave-columbus-oh')!;
    // negative expenseRatio = no-data for the efficiency cohort → neutral 50, not best-in-cohort 100
    expect(d.subScores.expenseEfficiency).toBe(50);
  });

  it('peer is not disadvantaged by the distressed property being excluded from the cohort (singleton → neutral 50)', () => {
    const distressed = pm('1100-rarig-ave-columbus-oh', 'cash', -0.1, {
      revenue: -5000,
      opex: 40000,
      noi: -45000,
      expenseRatio: -8.0,
    });
    const peer = pm('9050-red-branch-rd-columbia-md', 'cash', 5, {
      revenue: 100000,
      opex: 40000,
      expenseRatio: 0.4,
    });
    const scores = scoreProperties(db(), [distressed, peer]);
    const p = scores.find((s) => s.propertyId === '9050-red-branch-rd-columbia-md')!;
    // With the distressed property excluded, peer is a singleton → neutral 50 (not 100 from 1-member cohort).
    expect(p.subScores.expenseEfficiency).toBe(50);
  });
});

describe('CANON_PROPERTIES invariant — any entity with rentableSf == null excluded from efficiency cohorts', () => {
  // Regression net: if a future commit adds a new SF-less entry to CANON_PROPERTIES, or reverts the
  // isOperatingRealEstate guard in scores.ts, this test catches it automatically without requiring a
  // per-entity test. It also confirms the guard was not over-applied (real buildings still rank).
  it('all SF-less canon entities score neutral expenseEfficiency when mixed into a same-basis cohort with a real building', () => {
    const sfLessIds = CANON_PROPERTIES.filter((p) => p.rentableSf == null).map((p) => p.id);
    // Sanity: the invariant is vacuous if no SF-less entity exists — fail loudly if the roster empties.
    expect(sfLessIds.length).toBeGreaterThan(0);

    const d = db();
    const cohort = [
      // SF-less entities with a very low expense ratio — they would score expenseEfficiency 100
      // (best-in-cohort) if the isOperatingRealEstate guard were absent. Giving them the best
      // ratio maximises the sensitivity of the test: if they appear in the cohort at all, the
      // real building's score will be wrong AND the solar entity's own score will be wrong.
      ...sfLessIds.map((id) =>
        pm(id, 'accrual', 0, {
          rentableSf: null,
          noiPerSf: null,
          revenuePerSf: null,
          taxesPerSf: null,
          insurancePerSf: null,
          repairsPerSf: null,
          expenseRatio: 0.10, // deliberately low — would dominate the cohort if included
        }),
      ),
      // Real building: same accrual basis, higher expense ratio.
      pm('55-new-plant-ct-owings-mills-md', 'accrual', 6, { rentableSf: 34534, expenseRatio: 0.55 }),
    ];
    const scores = scoreProperties(d, cohort);

    for (const id of sfLessIds) {
      const s = scores.find((x) => x.propertyId === id);
      expect(s).toBeDefined();
      // SF-less entity has no comparable operating-expense profile → must be cohort-neutral.
      expect(s!.subScores.expenseEfficiency).toBe(50);
    }

    // Confirm the real building also stays neutral (only same-basis peer is SF-less → singleton → 50).
    const building = scores.find((s) => s.propertyId === '55-new-plant-ct-owings-mills-md')!;
    expect(building).toBeDefined();
    expect(building.subScores.expenseEfficiency).toBe(50);
  });
});
