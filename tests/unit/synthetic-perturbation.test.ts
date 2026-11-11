// @vitest-environment node
//
// The synthetic fixtures must not let anyone recover the real figures (refute run 2026-11-11: the
// original single global scale factor was brute-forced back out of the committed fixtures). Two layers:
//
//   1. the mechanism (scripts/fixtures/perturb.ts) under a throwaway test secret, attacked with full
//      knowledge of the inputs: a single global k, a ratio taken from one known record, and a
//      round-number lattice must each explain well under half of the outputs;
//   2. the committed fixtures themselves (no real data needed): a lattice brute force over every
//      money value of the synthetic snapshot must find no single k under which a large share of the
//      values de-scale to round hundreds / thousands, and no value carries extra decimals.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { BAND_HI, BAND_LO, decimalsOf, makePerturber, roundNative } from '../../scripts/fixtures/perturb';

const TEST_SECRET = 'test-only-secret-not-used-for-fixtures';

// Deterministic "real-looking" inputs: round thousands, whole dollars and cents.
function sampleInputs(): number[] {
  const out: number[] = [];
  let seed = 7;
  const rnd = (): number => {
    seed = (seed * 1103515245 + 12345) % 2 ** 31;
    return seed / 2 ** 31;
  };
  for (let i = 0; i < 150; i++) out.push(1000 * Math.round(50 + rnd() * 5000));
  for (let i = 0; i < 150; i++) out.push(Math.round(500 + rnd() * 200_000));
  for (let i = 0; i < 150; i++) out.push(Math.round((100 + rnd() * 50_000) * 100) / 100);
  return [...new Set(out)];
}

/** Lattice brute force without the inputs: the largest share of values v for which one k puts v/k on
 *  a multiple of L (within the rounding tolerance). Candidate k for v are v / (L * n), bucketed. */
function latticeBest(values: number[], L: number, kLo = 0.2, kHi = 1.0): { best: number; n: number } {
  const vs = values.filter((v) => Math.abs(v) >= 10 * L).map(Math.abs);
  const buckets = new Map<number, { count: number; last: number }>();
  let best = 0;
  vs.forEach((v, idx) => {
    const nLo = Math.ceil(v / (L * kHi));
    const nHi = Math.floor(v / (L * kLo));
    for (let n = nLo; n <= Math.min(nHi, nLo + 200_000); n++) {
      const k = v / (L * n);
      const tolK = (0.006 / v) * k; // |v/k - nL| <= 0.006/k  <=>  |k - v/(nL)| ~ 0.006 k / v
      const b0 = Math.floor((k - tolK) * 1e7);
      const b1 = Math.floor((k + tolK) * 1e7);
      for (let b = b0; b <= b1; b++) {
        const e = buckets.get(b) ?? { count: 0, last: -1 };
        if (e.last !== idx) {
          e.count += 1;
          e.last = idx;
          buckets.set(b, e);
          if (e.count > best) best = e.count;
        }
      }
    }
  });
  return { best, n: vs.length };
}

describe('perturbation mechanism (test secret, attacker knows the inputs)', () => {
  const p = makePerturber(TEST_SECRET);
  const inputs = sampleInputs();
  const outputs = inputs.map((v) => p.money(v));

  it('multipliers are in the band and outputs keep the source precision', () => {
    inputs.forEach((v, i) => {
      const k = outputs[i]! / v;
      expect(k).toBeGreaterThan(BAND_LO - 0.01);
      expect(k).toBeLessThan(BAND_HI + 0.01);
      expect(decimalsOf(outputs[i]!)).toBeLessThanOrEqual(Math.min(decimalsOf(v), 2));
    });
  });

  it('equal amounts stay equal (joins survive); a group shares one multiplier', () => {
    expect(p.money(12345.67)).toBe(p.money(12345.67));
    expect(p.money(-12345.67)).toBe(-p.money(12345.67));
    const a = p.money(1000, 'g1');
    const b = p.money(3000, 'g1');
    expect(b / a).toBeCloseTo(3, 2);
  });

  it('global-k attack: no single k over a fine grid reproduces more than half of the outputs', () => {
    let best = 0;
    for (let k = BAND_LO; k < BAND_HI; k += 1e-5) {
      let hit = 0;
      inputs.forEach((v, i) => {
        if (Math.abs(roundNative(v * k, v) - outputs[i]!) <= 0.005) hit++;
      });
      if (hit > best) best = hit;
    }
    expect(best / inputs.length).toBeLessThan(0.5);
  });

  it('ratio attack: the multiplier of one known record does not de-scale the others', () => {
    for (const anchor of [0, 200, 400]) {
      const k0 = outputs[anchor]! / inputs[anchor]!;
      const hit = inputs.filter((v, i) => Math.abs(roundNative(v * k0, v) - outputs[i]!) <= 0.01).length;
      expect(hit / inputs.length).toBeLessThan(0.5);
    }
  });

  it('round-lattice attack (inputs unknown): no k puts a large share of outputs on round thousands', () => {
    const { best, n } = latticeBest(outputs, 1000);
    expect(n).toBeGreaterThan(100);
    expect(best / n).toBeLessThan(0.1);
  });

  it('the attacks DO break a single global factor (the detector is not vacuous)', () => {
    const k = 0.6789;
    const global = inputs.map((v) => roundNative(v * k, v));
    const { best, n } = latticeBest(global, 1000);
    expect(best / n).toBeGreaterThan(0.15);
  });
});

describe('committed synthetic fixtures resist the lattice brute force', () => {
  const MONEY = new Set([
    'estValue100', 'oxfordValue', 'grossIncome', 'expenses', 'noi', 'debtService', 'netCashFlow', 'loanBalance', 'equityInvested',
    'monthlyRent', 'annualRent', 'currentBalance', 'monthlyPmt', 'priorBalance', 'avg3', 'minAllTime', 'maxAllTime', 'bal12moAgo',
    'premium', 'tiv', 'estPrice', 'price', 'd30', 'd60', 'd90', 'd90plus', 'annualIncome', 'annualExpense', 'amount',
  ]);
  const values: number[] = [];
  const walk = (v: unknown, key: string): void => {
    if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) walk(x, k);
    else if (typeof v === 'number' && MONEY.has(key) && v !== 0) values.push(v);
  };
  walk(JSON.parse(readFileSync(join(process.cwd(), 'fixtures', 'synthetic', 'data', 'snapshots', 'portfolio.json'), 'utf8')), '');

  it('money values carry no more than cents', () => {
    expect(values.length).toBeGreaterThan(200);
    expect(values.filter((v) => decimalsOf(v) > 2)).toEqual([]);
  });

  for (const L of [100, 1000]) {
    it(`no single k de-scales a large share of the snapshot's money onto multiples of ${L}`, () => {
      const { best, n } = latticeBest(values, L);
      expect(n).toBeGreaterThan(20);
      expect(best / n).toBeLessThan(0.15);
    });
  }
});
