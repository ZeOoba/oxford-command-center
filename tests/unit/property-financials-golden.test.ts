// @vitest-environment node
//
// tests/unit/property-financials-golden.test.ts — T2 of docs/superpowers/plans/2026-10-05-property-financials-module.md.
// Golden normalized-NOI values, the period/YoY/per-SF rules, parity of the pure calc library with the
// dataset's own derived blocks (recovery ratio, Q3 run-rate, driver nature, rent-step events), the
// THRESHOLDS config + RAG function (single-threshold flip), and the formatters.
import { describe, expect, it } from 'vitest';
import {
  OPEX_CATEGORIES,
  PF_ENTITY_IDS,
  PF_MONTHLY_ENTITY_IDS,
  SAME_STORE,
  STANDARD_PERIODS,
  type PfMonthlyProperty,
} from '@contracts/property-financials';
import {
  COMPARISONS,
  expectedMonths,
  isPartialPeriod,
  notMeaningful,
  ok,
  partialReason,
  periodFamily,
} from '@analytics/property-financials/periods';
import {
  driverNature,
  driverTiming,
  evaluationInputs,
  evaluationResults,
  fvcSepichMappingFlag,
  median,
  pctChange,
  perSf,
  q3RunRate,
  recoveryPool,
  recoveryRatio,
  rentStepEvents,
  RENT_STEP_RULES,
  runRateQ3Table,
  sameStoreSeries,
  trailingAverage,
  yoy,
} from '@analytics/property-financials/metrics';
import { EVALUATION_TEST_IDS, THRESHOLDS, ragMatrix, ragStatus, type RagStatus } from '@analytics/property-financials/thresholds';
import { DASH, NM, axisUsd, fmtResult, pct, pctLevel, usd } from '@analytics/property-financials/format';
import { isSynthetic, pfGolden } from './golden-helpers';
import { loadDataset } from './property-financials-helpers';

const D = loadDataset();
const RE_TAX = 'Real estate & property tax';

function monthlyProp(id: (typeof PF_MONTHLY_ENTITY_IDS)[number]): PfMonthlyProperty {
  const p = D.properties[id];
  if (p.kind !== 'monthly') throw new Error(`${id} is not monthly`);
  return p;
}

// -------------------------------------------------------------------------------------------------
// Golden values
// -------------------------------------------------------------------------------------------------

describe('golden normalized NOI (USD, rounded)', () => {
  // Value lock (refute run 2026-11-11): the exact per-entity NOI lives in the gitignored
  // data/property-financials/golden.local.json, written only by `npm run golden:ratify` from the real
  // dataset (in CI: the committed synthetic copy). A builder / mapping regression fails here until a
  // human re-ratifies on purpose. The FY figures must also agree with the history and monthly blocks.
  const G = pfGolden();
  const SYNTH = isSynthetic('data/property-financials/dataset.json');
  const GOLDEN_IDS = ['1100 Rarig', '1900 Broadway', '29000 Info Lane', '3540 E 5th', '9050 Red Branch', 'FVC', '55 New Plant (EGFLLC)', '1851 South Club Solar'] as const;

  it('the value lock covers every golden entity', () => {
    for (const id of GOLDEN_IDS) expect(G.noi[id], id).toBeDefined();
  });

  for (const id of GOLDEN_IDS) {
    it(`${id}: FY2024 / FY2025 NOI equal the ratified value lock and agree across blocks`, () => {
      const p = D.properties[id];
      expect(Math.round(p.periods.FY2024.noi)).toBe(G.noi[id]!.FY2024);
      expect(Math.round(p.periods.FY2025.noi)).toBe(G.noi[id]!.FY2025);
      for (const [per, y] of [['FY2024', '2024'], ['FY2025', '2025']] as const) {
        const noi = p.periods[per].noi;
        expect(Math.round(D.history[id].yr[y]!.noi), `${id}/${per} history`).toBe(Math.round(noi));
        if (p.kind === 'monthly') {
          const months = Object.entries(D.monthly[id as keyof typeof D.monthly] ?? {}).filter(([m]) => m.startsWith(`${y}-`));
          expect(months, `${id}/${per} months`).toHaveLength(12);
          // exact on the real data; the synthetic copy rounds each month separately (<= 12 cents)
          const sum = months.reduce((a, [, f]) => a + f.noi, 0);
          if (SYNTH) expect(Math.abs(sum - noi), `${id}/${per} monthly sum`).toBeLessThanOrEqual(0.12);
          else expect(sum, `${id}/${per} monthly sum`).toBeCloseTo(noi, 2);
        }
      }
    });
  }

  it('NOI is revenue minus opex to the cent in every period of every entity (definition check)', () => {
    for (const id of PF_ENTITY_IDS) {
      const p = D.properties[id];
      for (const [per, f] of Object.entries(p.periods)) {
        expect(Math.abs(f.revenue - f.opex - f.noi), `${id}/${per}`).toBeLessThan(0.005);
        expect(Math.abs(f.recoveries + f.utility_reimb - f.reimbursements), `${id}/${per} reimbursements`).toBeLessThan(0.005);
      }
    }
  });

  // v03.2 prepaid-rent ruling (2026-10-06): base rent and opex do not touch the excluded rows; NOI moved
  // +5.3% -> +4.9% (YTD25 2,288,999 -> 2,297,654; YTD26 2,409,726 -> 2,409,530).
  it('same-store Jan-Sep 2026 vs Jan-Sep 2025: base rent, opex excl. RE tax and NOI changes equal the value lock', () => {
    const sum = (per: 'YTD25' | 'YTD26', f: (x: PfMonthlyProperty['periods']['YTD25']) => number) =>
      SAME_STORE.reduce((a, id) => a + f(monthlyProp(id).periods[per]), 0);
    const baseRent = pctChange(sum('YTD25', (x) => x.base_rent), sum('YTD26', (x) => x.base_rent));
    const opexExTax = pctChange(
      sum('YTD25', (x) => x.opex - x.opex_by[RE_TAX]),
      sum('YTD26', (x) => x.opex - x.opex_by[RE_TAX]),
    );
    const noi = pctChange(sum('YTD25', (x) => x.noi), sum('YTD26', (x) => x.noi));
    // ratified values (golden lock); the v03.2 ruling moved NOI from +5.3% to +4.9% on the real data
    expect(pct(baseRent.value)).toBe(G.sameStoreYtd.baseRent);
    expect(pct(opexExTax.value)).toBe(G.sameStoreYtd.opexExTax);
    expect(pct(noi.value)).toBe(G.sameStoreYtd.noi);
  });
});

// -------------------------------------------------------------------------------------------------
// Period rules
// -------------------------------------------------------------------------------------------------

describe('period rules', () => {
  it('knows the expected month count of every period family', () => {
    expect(expectedMonths('FY2024')).toBe(12);
    expect(expectedMonths('TTM26')).toBe(12);
    expect(expectedMonths('YTD25')).toBe(9);
    expect(expectedMonths('YTD26_partial_thru_2026-06-12')).toBe(12);
    expect(expectedMonths('Q3-2026')).toBeNull();
    expect(periodFamily('YTD26_partial_thru_2026-06-12')).toBe('ANNUAL_PARTIAL');
  });

  it('flags partial periods from the dataset (Westerville FY2024 = 3 months, annual 2026 = 5.4 months)', () => {
    expect(isPartialPeriod('FY2024', monthlyProp('3034 Westerville').periods.FY2024.n_months)).toBe(true);
    expect(isPartialPeriod('FY2025', monthlyProp('3034 Westerville').periods.FY2025.n_months)).toBe(false);
    expect(isPartialPeriod('TTM25', monthlyProp('3034 Westerville').periods.TTM25.n_months)).toBe(true); // 11 of 12
    expect(isPartialPeriod('YTD26_partial_thru_2026-06-12', 5.4)).toBe(true);
    expect(partialReason('FY2024', 3)).toBe('partial period: 3 of 12 months');
    expect(partialReason('FY2024', 12)).toBeNull();
    for (const id of PF_MONTHLY_ENTITY_IDS) {
      for (const per of STANDARD_PERIODS) {
        const n = monthlyProp(id).periods[per].n_months;
        expect(isPartialPeriod(per, n)).toBe(n < (expectedMonths(per) ?? 0));
      }
    }
  });

  it('a partial period NEVER produces a YoY, with a tooltip reason', () => {
    const w = monthlyProp('3034 Westerville');
    const r = yoy({
      current: w.periods.FY2025.noi,
      prior: w.periods.FY2024.noi,
      currentPeriod: { id: 'FY2025', n_months: w.periods.FY2025.n_months },
      priorPeriod: { id: 'FY2024', n_months: w.periods.FY2024.n_months },
    });
    expect(r.value).toBeNull();
    expect(r.reason).toMatch(/partial period: 3 of 12 months/);
    // The dataset agrees: it carries null for that comparison.
    expect(w.yoy.FY2025_vs_FY2024).toBeNull();
    // Reversed roles (current partial) also refuse.
    const r2 = yoy({ current: 1, prior: 1, currentPeriod: { id: 'YTD26', n_months: 8 }, priorPeriod: { id: 'YTD25', n_months: 9 } });
    expect(r2.value).toBeNull();
    expect(r2.reason).toMatch(/8 of 9 months/);
  });

  it('a zero or negative base NEVER produces a percent', () => {
    expect(pctChange(0, 100)).toEqual({ value: null, reason: 'prior-period base is zero or negative' });
    expect(pctChange(-5, 100).value).toBeNull();
    expect(pctChange(null, 100).value).toBeNull();
    expect(pctChange(100, null).value).toBeNull();
    expect(pctChange(Number.NaN, 100).value).toBeNull();
    const fine = pctChange(200, 210);
    expect(fine.reason).toBeNull();
    expect(fine.value).toBeCloseTo(0.05, 12);
    // Livingston FY2024 revenue is 0: its FY2025 vs FY2024 YoY must be n/m even on the full-year comparison.
    const l = monthlyProp('3883 Livingston');
    expect(pctChange(l.periods.FY2024.revenue, l.periods.FY2025.revenue).value).toBeNull();
  });

  /**
   * Known dataset deviation from the rule: 9620 State 350 TTM26 vs TTM25 NOI is -3.28 in the file
   * (NOI went from -$52,492 to +$119,703). A percent on a negative base is meaningless; the module
   * shows n/m there. Pinned so a refreshed dataset that drops the figure makes this list shrink
   * visibly rather than silently.
   */
  const NEGATIVE_BASE_YOY_IN_DATASET = ['9620 State 350/TTM26_vs_TTM25/noi'];
  const negativeBaseCarried: string[] = [];

  it('full-period YoY matches the dataset yoy block to its 2-dp rounding for every monthly entity', () => {
    for (const id of PF_MONTHLY_ENTITY_IDS) {
      const p = monthlyProp(id);
      for (const [cmp, { current, prior }] of Object.entries(COMPARISONS)) {
        const row = p.yoy[cmp as keyof typeof p.yoy];
        const cur = p.periods[current];
        const pri = p.periods[prior];
        const partial = isPartialPeriod(current, cur.n_months) || isPartialPeriod(prior, pri.n_months);
        if (row === null) {
          // The dataset only nulls a comparison when a side is partial or has no revenue base.
          expect(partial || pri.revenue <= 0, `${id}/${cmp} null without a reason`).toBe(true);
          continue;
        }
        expect(partial, `${id}/${cmp} has a yoy but a partial side`).toBe(false);
        for (const k of ['base_rent', 'revenue', 'opex', 'noi'] as const) {
          const r = yoy({ current: cur[k], prior: pri[k], currentPeriod: { id: current, n_months: cur.n_months }, priorPeriod: { id: prior, n_months: pri.n_months } });
          const exp = row[k];
          if (pri[k] <= 0) {
            // Rule beats dataset: a non-positive base never yields a percent, even where the
            // committed file carries one (see NEGATIVE_BASE_YOY_IN_DATASET below).
            expect(r.value, `${id}/${cmp}/${k} non-positive base`).toBeNull();
            if (exp !== null) negativeBaseCarried.push(`${id}/${cmp}/${k}`);
            continue;
          }
          if (exp === null) expect(r.value, `${id}/${cmp}/${k}`).toBeNull();
          else expect(Math.abs((r.value ?? Number.NaN) - exp), `${id}/${cmp}/${k}`).toBeLessThanOrEqual(0.005 + 1e-9);
        }
      }
    }
  });

  it('the only dataset percent on a non-positive base is the pinned 9620 TTM NOI case', () => {
    expect(negativeBaseCarried).toEqual(NEGATIVE_BASE_YOY_IN_DATASET);
  });

  it('MetricResult constructors', () => {
    expect(ok(0.1)).toEqual({ value: 0.1, reason: null });
    expect(notMeaningful('x')).toEqual({ value: null, reason: 'x' });
  });
});

// -------------------------------------------------------------------------------------------------
// Metrics
// -------------------------------------------------------------------------------------------------

describe('per-SF', () => {
  it('divides by CURRENT total SF and never annualizes a 9-month period', () => {
    const r = monthlyProp('1100 Rarig');
    const ytd = perSf(r.periods.YTD26.base_rent, r.sf);
    expect(ytd.value).toBeCloseTo(r.periods.YTD26.base_rent / 21_000, 10);
    const fy = perSf(r.periods.FY2025.base_rent, r.sf);
    expect(fy.value).toBeCloseTo(r.periods.FY2025.base_rent / 21_000, 10);
    // 9-month figure is ~3/4 of the annual, not scaled up to it.
    expect((ytd.value ?? 0) < (fy.value ?? 0)).toBe(true);
  });

  it('is n/m without square footage', () => {
    expect(perSf(1000, null).value).toBeNull();
    expect(perSf(1000, 0).reason).toMatch(/square footage/);
    expect(perSf(null, 21_000).value).toBeNull();
  });
});

describe('recovery ratio', () => {
  it('pool = tax + insurance + utilities + grounds + R&M, and matches the dataset pool/recovery_ratio for every period', () => {
    for (const id of PF_MONTHLY_ENTITY_IDS) {
      const p = monthlyProp(id);
      for (const per of STANDARD_PERIODS) {
        const f = p.periods[per];
        expect(Math.abs(recoveryPool(f.opex_by) - f.pool), `${id}/${per} pool`).toBeLessThan(0.005);
        const r = recoveryRatio(f);
        if (f.recovery_ratio === null) expect(r.value, `${id}/${per}`).toBeNull();
        else expect(Math.abs((r.value ?? Number.NaN) - f.recovery_ratio), `${id}/${per}`).toBeLessThanOrEqual(0.005 + 1e-9);
      }
    }
  });

  it('is n/m for a single-tenant NNN asset when the caller says so, and for an empty pool', () => {
    const f = monthlyProp('3540 E 5th').periods.TTM26;
    expect(recoveryRatio(f).value).not.toBeNull();
    expect(recoveryRatio(f, { singleTenantNnn: true })).toEqual({ value: null, reason: expect.stringMatching(/single-tenant NNN/) });
    const empty = { ...f, opex_by: Object.fromEntries(OPEX_CATEGORIES.map((c) => [c, 0])) as typeof f.opex_by };
    expect(recoveryRatio(empty).value).toBeNull();
  });
});

describe('Q3 base-rent run-rate', () => {
  it('is the Jul-Sep average x 12, Q3 vs Q3, and matches the dataset table for all 9 monthly entities', () => {
    for (const id of PF_MONTHLY_ENTITY_IDS) {
      const table = runRateQ3Table(D.monthly[id]);
      const exp = monthlyProp(id).base_rent_runrate_q3;
      for (const y of ['q3_2024', 'q3_2025', 'q3_2026'] as const) {
        if (exp[y] === null) expect(table[y], `${id}/${y}`).toBeNull();
        else expect(Math.abs((table[y] ?? Number.NaN) - exp[y]), `${id}/${y}`).toBeLessThan(0.01);
      }
      for (const y of ['yoy_2025', 'yoy_2026'] as const) {
        if (exp[y] === null) expect(table[y].value, `${id}/${y}`).toBeNull();
        else expect(Math.abs((table[y].value ?? Number.NaN) - exp[y]), `${id}/${y}`).toBeLessThanOrEqual(0.005 + 1e-9);
      }
    }
  });

  it('needs all three months', () => {
    const m = D.monthly['1100 Rarig'];
    expect(q3RunRate({ '2026-07': m['2026-07']!, '2026-08': m['2026-08']! }, 2026)).toBeNull();
    expect(q3RunRate(m, 2026)).toBeCloseTo(((m['2026-07']!.base_rent + m['2026-08']!.base_rent + m['2026-09']!.base_rent) / 3) * 12, 6);
  });
});

describe('same-store series', () => {
  it('is a 3-month trailing average of base rent and opex excl. RE tax over the six same-store assets', () => {
    const months = D.meta.periods.FY2024.months;
    const s = sameStoreSeries(D.monthly, SAME_STORE, months);
    expect(s.months).toEqual(months);
    expect(s.baseRent.slice(0, 2)).toEqual([null, null]);
    const raw = (i: number) => SAME_STORE.reduce((a, id) => a + D.monthly[id][months[i]!]!.base_rent, 0);
    expect(s.baseRent[2]).toBeCloseTo((raw(0) + raw(1) + raw(2)) / 3, 6);
    const rawOx = (i: number) => SAME_STORE.reduce((a, id) => a + D.monthly[id][months[i]!]!.opex - D.monthly[id][months[i]!]!.opex_by[RE_TAX], 0);
    expect(s.opexExTax[11]).toBeCloseTo((rawOx(9) + rawOx(10) + rawOx(11)) / 3, 6);
    expect(trailingAverage([1, 2, 3, null, 5, 6, 7])).toEqual([null, null, 2, null, null, null, 6]);
  });

  it('is null at a month any member lacks (never silently treats a missing export as zero)', () => {
    // Westerville's cube starts 2024-09 and lacks the 2024-10 export.
    const s = sameStoreSeries(D.monthly, ['1100 Rarig', '3034 Westerville'], ['2024-08', '2024-09', '2024-10', '2024-11', '2024-12', '2025-01']);
    expect(s.baseRent[2]).toBeNull(); // window Aug-Oct: Aug and Oct missing
    expect(s.baseRent[3]).toBeNull(); // window Sep-Nov: Oct missing
    expect(s.baseRent[4]).toBeNull(); // window Oct-Dec: Oct missing
    expect(s.baseRent[5]).not.toBeNull(); // window Nov-Jan: all present for both members
    const rarig = D.monthly['1100 Rarig'];
    const west = D.monthly['3034 Westerville'];
    const expected = (['2024-11', '2024-12', '2025-01'] as const).reduce((a, m) => a + rarig[m]!.base_rent + west[m]!.base_rent, 0) / 3;
    expect(s.baseRent[5]).toBeCloseTo(expected, 6);
  });
});

describe('driver nature', () => {
  it('applies the lumpy / recurring / mixed / annual rule', () => {
    expect(driverNature({ annualOnly: true, activeMonths: 12, topShare: 0.1 })).toBe('annual');
    expect(driverNature({ activeMonths: 0, topShare: 0 })).toBe('lumpy');
    expect(driverNature({ activeMonths: 2, topShare: 0.5 })).toBe('lumpy');
    expect(driverNature({ activeMonths: 4, topShare: 0.51 })).toBe('lumpy');
    expect(driverNature({ activeMonths: 6, topShare: 0.5 })).toBe('lumpy'); // >=50% over <=6 active months
    expect(driverNature({ activeMonths: 7, topShare: 0.75 })).toBe('recurring'); // billed in >=6 months beats concentration
    expect(driverNature({ activeMonths: 6, topShare: 0.2 })).toBe('recurring');
    expect(driverNature({ activeMonths: 4, topShare: 0.43 })).toBe('mixed');
    expect(driverNature({ activeMonths: 3, topShare: 0.49 })).toBe('mixed');
  });

  it('F4: an exact-cents 50% top month is lumpy, not mixed (no float-summation drift)', () => {
    // 0.10 + 0.20 + 0.30 sums to 0.6000000000000001 in floating point: 0.30 / that = 0.49999999999999994
    const t = driverTiming([
      { month: '2026-01', amount: 0.1 },
      { month: '2026-02', amount: 0.2 },
      { month: '2026-03', amount: 0.3 },
      { month: '2026-04', amount: 0 },
    ]);
    expect(t.activeMonths).toBe(3);
    expect(t.topShare).toBe(0.5);
    expect(driverNature({ activeMonths: t.activeMonths, topShare: t.topShare })).toBe('lumpy');
    // the threshold comparison itself tolerates float noise below the boundary ...
    expect(driverNature({ activeMonths: 3, topShare: 0.49999999999999994 })).toBe('lumpy');
    // ... but not a real cent below it
    expect(driverNature({ activeMonths: 3, topShare: 0.4999 })).toBe('mixed');
    // signed postings still share by gross cents: |-25.50| of (10.25 + 25.50 + 15.25) = 50%
    const s = driverTiming([
      { month: '2026-01', amount: 10.25 },
      { month: '2026-02', amount: -25.5 },
      { month: '2026-03', amount: 15.25 },
    ]);
    expect(s.topShare).toBe(0.5);
    expect(s.topMonth).toBe('2026-02');
    expect(s.total).toBeCloseTo(0, 10);
  });

  it('driverTiming counts active months and the top-month share', () => {
    const t = driverTiming([
      { month: '2025-01', amount: 100 },
      { month: '2025-02', amount: 0 },
      { month: '2025-03', amount: 300 },
    ]);
    expect(t).toEqual({ activeMonths: 2, topShare: 0.75, topMonth: '2025-03', total: 400 });
    expect(driverTiming([]).topMonth).toBeNull();
  });

  it('reproduces the dataset nature tag from its own nm/conc for every driver (conc exactly at the 0.50 rounding edge excluded)', () => {
    let checked = 0;
    for (const id of PF_ENTITY_IDS) {
      const h = D.history[id];
      for (const [per, list] of Object.entries(h.drv)) {
        for (const x of list) {
          if (h.monthly && x.conc === 0.5) continue; // dataset rounds conc to 2 dp; the CSV-derived check lives in the reconcile test
          expect(driverNature({ annualOnly: !h.monthly, activeMonths: x.nm, topShare: x.conc }), `${id}/${per}/${x.a}`).toBe(x.nat);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(450);
  });
});

describe('rent-step events', () => {
  it('median handles odd and even counts', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });

  it('pins the rules: 3-month medians, >=2% and >=$500/month, >=4 months apart', () => {
    expect(RENT_STEP_RULES).toMatchObject({ window: 3, minPct: 0.02, minDollars: 500, minGapMonths: 4 });
  });

  it('reproduces every persisted base-rent step in history[entity].ev for all 9 monthly entities', () => {
    let total = 0;
    for (const id of PF_MONTHLY_ENTITY_IDS) {
      const h = D.history[id];
      if (!h.months) throw new Error('monthly entity without months');
      const got = rentStepEvents(h.months.g, h.months.br);
      expect(got.map((e) => e.m), id).toEqual(h.ev.map((e) => e.m));
      got.forEach((e, i) => {
        const exp = h.ev[i]!;
        expect(Math.abs(e.a - exp.a), `${id}/${e.m} a`).toBeLessThanOrEqual(1); // history months are rounded to whole dollars
        expect(Math.abs(e.b - exp.b), `${id}/${e.m} b`).toBeLessThanOrEqual(1);
        expect(Math.abs(e.pct - exp.pct), `${id}/${e.m} pct`).toBeLessThan(0.001);
      });
      total += got.length;
    }
    // every monthly entity's persisted steps are reproduced (the count is the dataset's own)
    expect(total).toBe(PF_MONTHLY_ENTITY_IDS.reduce((a, id) => a + D.history[id].ev.length, 0));
    expect(total).toBeGreaterThan(0);
  });

  it('ignores a step below $500 or below 2% and enforces the 4-month gap', () => {
    const g = Array.from({ length: 14 }, (_, i) => `2025-${String(i + 1).padStart(2, '0')}`.replace('2025-13', '2026-01').replace('2025-14', '2026-02'));
    const flat = Array<number>(14).fill(10_000);
    expect(rentStepEvents(g, flat)).toEqual([]);
    const small = [...flat.slice(0, 6), ...Array<number>(8).fill(10_400)]; // +4% but $400
    expect(rentStepEvents(g, small)).toEqual([]);
    const tiny = [...Array<number>(6).fill(100_000), ...Array<number>(8).fill(101_500)]; // $1,500 but 1.5%
    expect(rentStepEvents(g, tiny)).toEqual([]);
    // Two steps two months apart: the second is inside the 4-month gap and is absorbed.
    const close = [...Array<number>(4).fill(10_000), ...Array<number>(2).fill(12_000), ...Array<number>(8).fill(15_000)];
    expect(rentStepEvents(g, close).map((e) => e.m)).toEqual(['2025-05']);
    // Two steps four months apart: both reported.
    const apart = [...Array<number>(4).fill(10_000), ...Array<number>(4).fill(12_000), ...Array<number>(6).fill(15_000)];
    expect(rentStepEvents(g, apart).map((e) => e.m)).toEqual(['2025-05', '2025-09']);
    // A missing (null) or pre-lease (0) month is dropped from the window, not read as a $0 rent.
    const gap = [10_000, 10_000, null, 10_000, 12_000, 12_000, 12_000, 12_000, 12_000, 12_000, 12_000, 12_000, 12_000, 12_000];
    expect(rentStepEvents(g, gap).map((e) => [e.m, e.a, e.b])).toEqual([['2025-05', 10_000, 12_000]]);
  });
});

describe('FVC Sepich mapping flag', () => {
  it('is present until the inferred mapping is cleared in the dataset note', () => {
    const f = fvcSepichMappingFlag(D.sf.FVC);
    expect(f.active).toBe(true);
    expect(f.text).toContain('Inferred by reconciliation');
    expect(f.text).toContain('Confirm');
    expect(fvcSepichMappingFlag({ ...D.sf.FVC, note: 'Mapping confirmed by Gabriel 2026-10-20 against Sepich property-level exports.' }).active).toBe(false);
  });
});

// -------------------------------------------------------------------------------------------------
// Thresholds + RAG
// -------------------------------------------------------------------------------------------------

describe('THRESHOLDS + ragStatus', () => {
  it('pins the eight evaluation tests exactly as the reference artifact', () => {
    expect(EVALUATION_TEST_IDS).toEqual([
      'noiMargin', 'opexExTaxRatio', 'recoveryRatio', 'mgmtFeePct', 'contraRevenue', 'rentRunRateGrowth', 'utilityGrowth', 'repairsGrowth',
    ]);
    expect(THRESHOLDS.noiMargin).toMatchObject({ direction: 'higher-is-better', green: 0.65, amber: 0.5 });
    expect(THRESHOLDS.opexExTaxRatio).toMatchObject({ direction: 'lower-is-better', green: 0.2, amber: 0.3 });
    expect(THRESHOLDS.recoveryRatio).toMatchObject({ direction: 'higher-is-better', green: 0.85, amber: 0.5 });
    expect(THRESHOLDS.mgmtFeePct).toMatchObject({ direction: 'lower-is-better', green: 0.04, amber: 0.05 });
    expect(THRESHOLDS.contraRevenue).toMatchObject({ direction: 'lower-is-better', green: 0.015, amber: 0.035 });
    expect(THRESHOLDS.rentRunRateGrowth).toMatchObject({ direction: 'higher-is-better', green: 0.03, amber: 0 });
    expect(THRESHOLDS.utilityGrowth).toMatchObject({ direction: 'lower-is-better', green: 0.05, amber: 0.15, minPriorBase: 1000 });
    expect(THRESHOLDS.repairsGrowth).toMatchObject({ direction: 'lower-is-better', green: 0.1, amber: 0.3, minPriorBase: 1000 });
  });

  it('boundaries are inclusive on the green/amber side exactly like the artifact', () => {
    expect(ragStatus('noiMargin', 0.65)).toBe('g');
    expect(ragStatus('noiMargin', 0.6499)).toBe('a');
    expect(ragStatus('noiMargin', 0.5)).toBe('a');
    expect(ragStatus('noiMargin', 0.4999)).toBe('r');
    expect(ragStatus('mgmtFeePct', 0.04)).toBe('g');
    expect(ragStatus('mgmtFeePct', 0.0401)).toBe('a');
    expect(ragStatus('mgmtFeePct', 0.05)).toBe('a');
    expect(ragStatus('mgmtFeePct', 0.0501)).toBe('r');
    expect(ragStatus('rentRunRateGrowth', 0)).toBe('a');
    expect(ragStatus('rentRunRateGrowth', -0.001)).toBe('r');
    expect(ragStatus('utilityGrowth', null)).toBe('n');
    expect(ragStatus('utilityGrowth', Number.NaN)).toBe('n');
  });

  it('evaluationInputs reproduces the artifact scorecard inputs (TTM26 ratios, Q3 run-rate, YTD growth with the $1,000 prior guard)', () => {
    const r = monthlyProp('1100 Rarig');
    const v = evaluationInputs(r, D.monthly['1100 Rarig']);
    const t = r.periods.TTM26;
    expect(v.noiMargin).toBeCloseTo(t.noi / t.revenue, 10);
    expect(v.opexExTaxRatio).toBeCloseTo((t.opex - t.opex_by[RE_TAX]) / t.revenue, 10);
    expect(v.recoveryRatio).toBeCloseTo((t.recoveries + t.utility_reimb) / t.pool, 10);
    expect(v.mgmtFeePct).toBeCloseTo(t.opex_by['Management fees'] / t.revenue, 10);
    expect(v.contraRevenue).toBeCloseTo(Math.abs(t.vacancy_waivers) / t.base_rent, 10);
    expect(v.rentRunRateGrowth).toBeCloseTo(r.base_rent_runrate_q3.q3_2026! / r.base_rent_runrate_q3.q3_2025! - 1, 6);
    // Without the cube the artifact's displayed (2-dp) run-rate growth is used.
    expect(evaluationInputs(r).rentRunRateGrowth).toBe(r.base_rent_runrate_q3.yoy_2026);
    expect(v.utilityGrowth).toBeCloseTo(r.periods.YTD26.opex_by.Utilities / r.periods.YTD25.opex_by.Utilities - 1, 10);
    expect(v.repairsGrowth).toBeCloseTo(r.periods.YTD26.opex_by['Repairs & maintenance'] / r.periods.YTD25.opex_by['Repairs & maintenance'] - 1, 10);
    // Livingston: no Q3-2025 -> run-rate n/m. Its Jan-Sep 2025 window holds only 3 of 9 months, so the
    // utility / repairs growth is n/m for the PARTIAL PERIOD — not the $1,000 floor, which the repairs
    // prior base clears. A 3-month vs 9-month comparison would have read +489.6% / -66.8%; the partial
    // rule refuses before any arithmetic.
    const liv = monthlyProp('3883 Livingston');
    const l = evaluationInputs(liv, D.monthly['3883 Livingston']);
    expect(l.rentRunRateGrowth).toBeNull();
    const ly = liv.periods.YTD25.opex_by;
    expect(liv.periods.YTD25.n_months).toBe(3);
    expect(ly.Utilities).toBeGreaterThan(0);
    expect(ly['Repairs & maintenance']).toBeGreaterThan(THRESHOLDS.repairsGrowth.minPriorBase ?? 0);
    expect(l.utilityGrowth).toBeNull();
    expect(l.repairsGrowth).toBeNull();
    const lr = evaluationResults(liv, D.monthly['3883 Livingston']);
    expect(lr.utilityGrowth.reason).toBe('YTD25: partial period: 3 of 9 months');
    expect(lr.repairsGrowth.reason).toBe('YTD25: partial period: 3 of 9 months');
  });

  it('changing ONE threshold flips exactly the cells it governs and nothing else', () => {
    const inputs = Object.fromEntries(PF_MONTHLY_ENTITY_IDS.map((id) => [id, evaluationInputs(monthlyProp(id), D.monthly[id])]));
    const before = Object.fromEntries(PF_MONTHLY_ENTITY_IDS.map((id) => [id, ragMatrix(inputs[id]!, THRESHOLDS)])) as Record<string, Record<string, RagStatus>>;
    // Raise the NOI-margin green floor from 65% to just above the smallest green margin in THIS
    // dataset (real or synthetic, whose margins are its own draws), so the
    // flip is observed on any dataset.
    const greens = PF_MONTHLY_ENTITY_IDS.map((id) => inputs[id]!.noiMargin).filter((v): v is number => v !== null && v >= THRESHOLDS.noiMargin.green);
    expect(greens.length).toBeGreaterThan(0);
    const bump = Math.min(...greens) + 1e-9;
    const tweaked = { ...THRESHOLDS, noiMargin: { ...THRESHOLDS.noiMargin, green: bump } };
    const after = Object.fromEntries(PF_MONTHLY_ENTITY_IDS.map((id) => [id, ragMatrix(inputs[id]!, tweaked)])) as Record<string, Record<string, RagStatus>>;
    let flipped = 0;
    for (const id of PF_MONTHLY_ENTITY_IDS) {
      for (const test of EVALUATION_TEST_IDS) {
        const b = before[id]![test]!;
        const a = after[id]![test]!;
        if (test !== 'noiMargin') {
          expect(a, `${id}/${test} must not move`).toBe(b);
          continue;
        }
        const v = inputs[id]![test];
        const shouldFlip = v !== null && v >= 0.65 && v < bump;
        expect(a !== b, `${id}/noiMargin flip`).toBe(shouldFlip);
        if (shouldFlip) {
          expect(b).toBe('g');
          expect(a).toBe('a');
          flipped++;
        }
      }
    }
    // At least the smallest green margin flips, so the check is observed, not vacuous.
    expect(flipped).toBeGreaterThan(0);
    expect(flipped).toBe(PF_MONTHLY_ENTITY_IDS.filter((id) => { const v = inputs[id]!.noiMargin; return v !== null && v >= 0.65 && v < bump; }).length);
  });
});

// -------------------------------------------------------------------------------------------------
// Formatters
// -------------------------------------------------------------------------------------------------

describe('formatters (reference artifact usd / pc / pl)', () => {
  it('usd', () => {
    expect(usd(1_234_567)).toBe('$1.23M');
    expect(usd(1_234_567, 'f')).toBe('$1,234,567');
    expect(usd(-1_234_567)).toBe('-$1.23M');
    expect(usd(222_187.84)).toBe('$222,188');
    expect(usd(12_345, 'k')).toBe('$12.3K');
    expect(usd(1_234_567, 'k')).toBe('$1,234.6K');
    expect(usd(-500, 'k')).toBe('-$0.5K');
    expect(usd(null)).toBe(DASH);
    expect(usd(Number.NaN)).toBe(DASH);
  });

  it('pct is signed with one decimal; pctLevel is unsigned with zero decimals by default', () => {
    expect(pct(0.0261)).toBe('+2.6%');
    expect(pct(-0.08)).toBe('-8.0%');
    expect(pct(0)).toBe('0.0%');
    expect(pct(0.1234, 0)).toBe('+12%');
    expect(pct(null)).toBe(DASH);
    expect(pctLevel(0.58)).toBe('58%');
    expect(pctLevel(0.0401, 1)).toBe('4.0%');
    expect(pctLevel(null)).toBe(DASH);
  });

  it('fmtResult renders n/m for a null MetricResult and the formatted value otherwise', () => {
    expect(fmtResult(notMeaningful('partial'), (v) => pct(v))).toBe(NM);
    expect(fmtResult(ok(0.053), (v) => pct(v))).toBe('+5.3%');
    expect(NM).toBe('n/m');
  });

  it('axisUsd compacts for axes/KPIs only: $1.23M / $520K / $120', () => {
    expect(axisUsd(1_234_567)).toBe('$1.23M');
    expect(axisUsd(520_000)).toBe('$520K');
    expect(axisUsd(120)).toBe('$120');
    expect(axisUsd(-50_000)).toBe('-$50K');
  });
});
