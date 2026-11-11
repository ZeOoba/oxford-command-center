// @vitest-environment node
//
// The synthetic fixtures must not let anyone recover real figures. History: a single global scale
// factor was brute-forced out of the committed fixtures, and its replacement (a keyed HMAC multiplier
// per amount or per group, scripts/fixtures/perturb.ts) still let ONE public real figure reveal a whole
// entity's P&L (refute runs 2026-11-11). Synthetic money is now a seeded random draw keyed by
// structure (scripts/fixtures/synthetic-money.ts); no synthetic amount is a function of a real one.
//
//   1. the draw mechanism: deterministic, banded, sign / zero only, redraws off the avoid list;
//   2. CI-safe independence: the generator run on two inputs with the same structure but different
//      amounts gives byte-identical output;
//   3. CI-safe lattice: no single k de-scales the committed money onto cents-free round lattices;
//   4. attacks WITH the real data (operator machine only; skipped where it is absent, e.g. in CI):
//      brute-force k, within-entity ratios, known plaintext. Point SYNTH_REAL_SRC at a directory laid
//      out like the repo that holds the real files (the copy the fixtures were generated from), or run
//      on a checkout whose runtime files are real.
import { beforeAll, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DEFAULT_SF, SYNTH_SEED, bandFor, decimalsOf, makeMoneyDrawer, unit } from '../../scripts/fixtures/synthetic-money';
import { build, mapMoney, moneyLeaves, type MoneyFileKind } from '../../scripts/fixtures/build-synthetic-data';
import { isSynthetic } from './golden-helpers';

const FIXTURES = join(process.cwd(), 'fixtures', 'synthetic');
const FILES: ReadonlyArray<[string, MoneyFileKind]> = [
  ['data/snapshots/portfolio.json', 'snapshot'],
  ['data/property-financials/dataset.json', 'dataset'],
  ['data/cost-seg/cost-seg.json', 'costSeg'],
];
const readJson = (root: string, rel: string): unknown => JSON.parse(readFileSync(join(root, rel), 'utf8'));

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
      const tolK = (0.006 / v) * k;
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

describe('seeded draw mechanism', () => {
  it('the seed is public and the draw is a pure function of (seed, key)', () => {
    expect(SYNTH_SEED).toMatch(/^occ-synthetic-v\d+$/);
    expect(unit('a/b')).toBe(unit('a/b'));
    expect(unit('a/b')).not.toBe(unit('a/c'));
    expect(unit('a/b', 'another-seed')).not.toBe(unit('a/b'));
    const d1 = makeMoneyDrawer();
    const d2 = makeMoneyDrawer();
    expect(d1.draw('k', 1, 1000, 5000)).toBe(d2.draw('k', 1, 1000, 5000));
  });

  it('draws stay in the band, carry the requested precision and only the sign of the input', () => {
    const d = makeMoneyDrawer();
    for (let i = 0; i < 500; i++) {
      const x = d.draw(`band/${i}`, i % 2 ? -1 : 1, 1000, 9000, i % 3 ? 2 : 0);
      expect(Math.abs(x)).toBeGreaterThanOrEqual(1000);
      expect(Math.abs(x)).toBeLessThanOrEqual(9000);
      expect(Math.sign(x)).toBe(i % 2 ? -1 : 1);
      expect(decimalsOf(x)).toBeLessThanOrEqual(i % 3 ? 2 : 0);
    }
  });

  it('a draw on the avoid list (a real-amount fingerprint) is redrawn with a counter', () => {
    const first = makeMoneyDrawer().draw('collide', 1, 1000, 9000);
    const avoiding = makeMoneyDrawer(new Set([String(first)]));
    const again = avoiding.draw('collide', 1, 1000, 9000);
    expect(again).not.toBe(first);
    expect(avoiding.redraws).toBe(1);
    // a degenerate band (a no-jitter model value) steps by one cent instead of looping
    const flat = makeMoneyDrawer(new Set(['1234.5'])).draw('flat', 1, 1234.5, 1234.5);
    expect(flat).toBe(1234.51);
  });

  it('bands are per field; per-SF bands scale with the record SF', () => {
    expect(bandFor('base_rent').perSf).toBe(true);
    expect(bandFor('currentBalance').perSf).toBeFalsy();
    expect(bandFor('no-such-field').lo).toBeGreaterThan(0);
    expect(DEFAULT_SF).toBeGreaterThan(0);
  });
});

describe('generator output is independent of the real amounts (CI-safe)', () => {
  // Two inputs with the same structure (records, keys, SF, signs, zeros, which identities hold) and
  // different amounts: every amount x2 in one and x3 in the other (an exact rescale keeps every
  // identity). The committed fixtures stand in for "real" structure. Any functional link from a real
  // amount to its synthetic stand-in (a scale factor, a keyed multiplier, a magnitude bucket) would
  // make the two outputs differ.
  // A rescale multiplies rounding residuals too: two fields derived by DIVISION and stored rounded to
  // cents (cash avg3, comp price per SF) are first made exact, so "the identity held" means the same
  // thing at x2 and x3.
  type O = Record<string, unknown>;
  const canonical = (rel: string): unknown => {
    const v = readJson(FIXTURES, rel) as O;
    if (rel !== FILES[0]![0]) return v;
    const cash = v['cash'] as { entities: O[]; history: Array<{ balances: Record<string, number> }> };
    for (const e of cash.entities) {
      const s = cash.history.map((h) => h.balances[String(e['entity'])]).filter((x): x is number => typeof x === 'number').slice(-3);
      if (s.length && typeof e['avg3'] === 'number' && Math.abs((e['avg3'] as number) - s.reduce((a, x) => a + x, 0) / s.length) <= 0.01) e['avg3'] = s.reduce((a, x) => a + x, 0) / s.length;
    }
    for (const c of Object.values(v['dealComps'] as Record<string, { saleComps?: O[]; rentComps?: O[] }>)) {
      for (const x of [...(c.saleComps ?? []), ...(c.rentComps ?? [])]) {
        const [p, sf, pps] = [x['price'], x['sf'], x['pricePerSf']];
        if (typeof p === 'number' && typeof sf === 'number' && sf && typeof pps === 'number' && Math.abs(pps - p / sf) <= 0.01) x['pricePerSf'] = p / sf;
      }
    }
    return v;
  };
  const prepare = (k: number): string => {
    const root = mkdtempSync(join(tmpdir(), `synthetic-money-x${k}-`));
    for (const [rel, kind] of FILES) {
      const scaled = mapMoney(kind, canonical(rel) as never, (_p, x) => x * k);
      mkdirSync(dirname(join(root, rel)), { recursive: true });
      writeFileSync(join(root, rel), JSON.stringify(scaled));
    }
    return root;
  };

  it('x2 and x3 inputs give byte-identical synthetic files', async () => {
    // The fingerprint redraw (a draw equal to a real amount is redrawn) is the one deliberate contact
    // with the real amounts and can only move a value away from one; it is off for this comparison.
    const a = await build(prepare(2), false, { avoidRealAmounts: false });
    const b = await build(prepare(3), false, { avoidRealAmounts: false });
    expect([...a.contents.keys()].sort()).toEqual([...b.contents.keys()].sort());
    expect(a.contents.size).toBeGreaterThanOrEqual(FILES.length);
    for (const [rel, content] of a.contents) expect(content === b.contents.get(rel), rel).toBe(true);
    // not vacuous: the inputs really differ, and the output is not either input
    const inA = moneyLeaves('dataset', JSON.parse(readFileSync(join(prepare(2), FILES[1]![0]), 'utf8')));
    const inB = moneyLeaves('dataset', JSON.parse(readFileSync(join(prepare(3), FILES[1]![0]), 'utf8')));
    expect(inA.some(([, x], i) => x !== 0 && x !== inB[i]![1])).toBe(true);
    const out = moneyLeaves('dataset', JSON.parse(a.contents.get(FILES[1]![0])!));
    expect(out.filter(([, x], i) => x !== 0 && inA[i] && x === inA[i]![1]).length).toBeLessThan(out.length / 100);
  }, 120_000);
});

describe('committed synthetic fixtures resist the lattice brute force (no real data needed)', () => {
  for (const [rel, kind] of FILES.slice(0, 2)) {
    const leaves = moneyLeaves(kind, readJson(FIXTURES, rel) as never).filter(([, x]) => x !== 0);
    const values = leaves.map(([, x]) => x);
    it(`${rel}: money carries no more than cents (per-SF ratios aside)`, () => {
      expect(values.length).toBeGreaterThan(200);
      expect(leaves.filter(([, v, k]) => !/PerSf$/.test(k) && decimalsOf(v) > 2).map(([p, , k]) => `${k} ${p}`)).toEqual([]);
    });
    for (const L of [100, 1000]) {
      it(`${rel}: no single k de-scales a large share of the money onto multiples of ${L}`, () => {
        const sample = values.filter((_, i) => i % Math.max(1, Math.floor(values.length / 1500)) === 0);
        const { best, n } = latticeBest(sample, L);
        expect(n).toBeGreaterThan(20);
        expect(best / n).toBeLessThan(0.15);
      });
    }
  }

  it('the lattice detector is not vacuous: it breaks a single global factor', () => {
    let seed = 7;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31);
    const inputs = Array.from({ length: 300 }, () => 1000 * Math.round(50 + rnd() * 5000));
    const global = inputs.map((v) => Math.round(v * 0.6789 * 100) / 100);
    const { best, n } = latticeBest(global, 1000);
    expect(best / n).toBeGreaterThan(0.15);
  });
});

// ── attacks with the real data (operator machine only) ─────────────────────────────────────────────

const REAL_ROOT: string | null =
  process.env.SYNTH_REAL_SRC && existsSync(join(process.env.SYNTH_REAL_SRC, FILES[0]![0]))
    ? process.env.SYNTH_REAL_SRC
    : existsSync(join(process.cwd(), FILES[0]![0])) && !isSynthetic(FILES[0]![0])
      ? process.cwd()
      : null;

/** Real / synthetic amount pairs by positional path, nonzero, same sign, deduplicated by (r, s). */
function pairs(rel: string, kind: MoneyFileKind): Array<{ path: string; r: number; s: number }> {
  const real = new Map<string, number>(moneyLeaves(kind, readJson(REAL_ROOT!, rel) as never).map(([p, x]) => [p, x] as [string, number]));
  const out: Array<{ path: string; r: number; s: number }> = [];
  const seen = new Set<string>();
  for (const [path, s] of moneyLeaves(kind, readJson(FIXTURES, rel) as never)) {
    const r = real.get(path);
    if (r === undefined || r === 0 || s === 0 || Math.sign(r) !== Math.sign(s)) continue;
    const k = `${r}|${s}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ path, r: Math.abs(r), s: Math.abs(s) });
  }
  return out;
}

/** The group an amount belongs to: one P&L entity (across every dataset block), one snapshot record,
 *  one cost-seg study or fact. Positional segments are resolved against the real file's keys. */
function groupOf(kind: MoneyFileKind, path: string, realJson: Record<string, unknown>): string {
  const seg = path.split(/[/[\]]+/).filter(Boolean).map(Number);
  const top = Object.keys(realJson)[seg[0]!] ?? '';
  const block = realJson[top];
  const second = block && typeof block === 'object' && !Array.isArray(block) ? (Object.keys(block)[seg[1]!] ?? '') : String(seg[1]);
  if (kind === 'dataset' && ['properties', 'monthly', 'account_movers', 'history', 'sf'].includes(top)) return `entity:${second}`;
  return `${top}:${second}`;
}

describe.skipIf(REAL_ROOT === null)('attacks with the real data (skipped where the real files are absent)', () => {
  // collected in beforeAll: a skipped describe body still runs at collection time
  let all: Array<{ path: string; r: number; s: number; kind: MoneyFileKind }> = [];
  beforeAll(() => {
    all = FILES.flatMap(([rel, kind]) => pairs(rel, kind).map((p) => ({ ...p, kind })));
  });

  it('pairs line up (the fixtures were generated from this real copy)', () => {
    expect(all.length).toBeGreaterThan(2000);
  });

  it('brute-force k: no single scale factor explains more than half of the synthetic / real pairs', () => {
    // bucket log(s / r) at 0.5% resolution: a global factor would put most pairs in one bucket
    const bins = new Map<number, number>();
    for (const { r, s } of all) {
      const b = Math.round(Math.log(s / r) / Math.log(1.005));
      bins.set(b, (bins.get(b) ?? 0) + 1);
    }
    const top = Math.max(...bins.values()) / all.length;
    console.log(`[attack] brute-force k: ${all.length} pairs, best single k explains ${(100 * top).toFixed(2)}%`);
    expect(top).toBeLessThan(0.5);
  });

  it('ratio: real within-entity ratios (FY NOI change, revenue / opex) are not reproduced', () => {
    const real = readJson(REAL_ROOT!, FILES[1]![0]) as { properties: Record<string, { periods: Record<string, { noi: number; revenue: number; opex: number }> }> };
    const syn = readJson(FIXTURES, FILES[1]![0]) as typeof real;
    let n = 0;
    let hit = 0;
    const close = (a: number, b: number): boolean => Math.abs(a / b - 1) < 0.01;
    for (const [id, p] of Object.entries(real.properties)) {
      const sp = syn.properties[id];
      if (!sp) continue;
      const [r24, r25, s24, s25] = [p.periods.FY2024, p.periods.FY2025, sp.periods.FY2024, sp.periods.FY2025];
      if (r24 && r25 && s24 && s25 && r24.noi > 0 && s24.noi > 0) {
        n++;
        if (close(r25.noi / r24.noi, s25.noi / s24.noi)) hit++;
      }
      for (const per of Object.keys(p.periods)) {
        const [rp, spp] = [p.periods[per]!, sp.periods[per]];
        if (spp && rp.opex > 0 && spp.opex > 0) {
          n++;
          if (close(rp.revenue / rp.opex, spp.revenue / spp.opex)) hit++;
        }
      }
    }
    console.log(`[attack] ratios: ${hit} of ${n} real within-entity ratios reproduced within 1%`);
    expect(n).toBeGreaterThan(30);
    expect(hit / n).toBeLessThan(0.1);
  });

  it('known plaintext: one real figure + its synthetic counterpart predicts the group no better than chance', () => {
    // For every group, anchor on each pair in turn: k0 = s0 / r0, predict every other real figure of
    // the group as s / k0, and count predictions within 1%. Group keying scored ~100% here. The chance
    // baseline repeats the attack with the group's real figures shuffled.
    const groups = new Map<string, Array<{ r: number; s: number }>>();
    const realJson = Object.fromEntries(FILES.map(([rel, kind]) => [kind, readJson(REAL_ROOT!, rel) as Record<string, unknown>]));
    for (const p of all) {
      const g = `${p.kind}|${groupOf(p.kind, p.path, realJson[p.kind]!)}`;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g)!.push(p);
    }
    let seed = 11;
    const rnd = (): number => ((seed = (seed * 1103515245 + 12345) % 2 ** 31), seed / 2 ** 31);
    const attack = (xs: Array<{ r: number; s: number }>): [number, number] => {
      let tried = 0;
      let ok = 0;
      const anchors = xs.length > 40 ? xs.filter((_, i) => i % Math.ceil(xs.length / 40) === 0) : xs;
      for (const a of anchors) {
        const k0 = a.s / a.r;
        for (const b of xs) {
          if (b === a) continue;
          tried++;
          if (Math.abs(b.s / k0 / b.r - 1) < 0.01) ok++;
        }
      }
      return [ok, tried];
    };
    let [ok, tried, bOk, bTried] = [0, 0, 0, 0];
    let used = 0;
    for (const xs of groups.values()) {
      if (xs.length < 5) continue;
      used++;
      const [o, t] = attack(xs);
      ok += o;
      tried += t;
      const rs = xs.map((x) => x.r).sort(() => rnd() - 0.5);
      const [bo, bt] = attack(xs.map((x, i) => ({ r: rs[i]!, s: x.s })));
      bOk += bo;
      bTried += bt;
    }
    const rate = ok / tried;
    const chance = bOk / bTried;
    console.log(`[attack] known plaintext: ${used} groups, hit rate ${(100 * rate).toFixed(2)}% vs shuffled baseline ${(100 * chance).toFixed(2)}%`);
    expect(used).toBeGreaterThan(20);
    expect(rate).toBeLessThan(Math.max(3 * chance, 0.05));
  });
});
