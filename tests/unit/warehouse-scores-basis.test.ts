import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import { scoreProperties } from '../../server/warehouse/scores';
import { seedPropertyMaster } from '../../server/warehouse/property-master';
import type { PeriodMetrics } from '../../server/warehouse/metrics';

// scoreProperties uses the db only for canonical names; the metrics drive every score. Synthetic
// PeriodMetrics (cast convention) — only the fields the scorer reads need to be present.
const pm = (propertyId: string, basis: string, noiPerSf: number): PeriodMetrics =>
  ({
    propertyId,
    propertyName: propertyId,
    period: '2025',
    grainHint: 'year', // full-year ⇒ this IS the level/benchmark period
    basis,
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
