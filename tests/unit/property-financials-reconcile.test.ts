// @vitest-environment node
//
// tests/unit/property-financials-reconcile.test.ts — T3 of docs/superpowers/plans/2026-10-05-property-financials-module.md.
// Rebuilds every figure in properties[id].periods and monthly[id][YYYY-MM] from monthly-long.csv ALONE
// and requires each to tie to the cent (|diff| < 0.005) for all 11 entities and all periods. Ratios the
// dataset stores rounded to 2 dp tie at that precision. Nothing here is tolerance-tuned: a miss is a
// finding, not a flake.
import { describe, expect, it } from 'vitest';
import {
  ANNUAL_PERIODS,
  OPEX_CATEGORIES,
  PF_ANNUAL_ENTITY_IDS,
  PF_ENTITY_IDS,
  PF_MONTHLY_ENTITY_IDS,
  STANDARD_PERIODS,
  type PfEntityId,
} from '@contracts/property-financials';
import { parseCsv } from '@analytics/property-financials/csv';
import {
  ANNUAL_CSV_PERIOD_KEYS,
  LINE_TYPES,
  aggregateRows,
  indexRows,
  parseMonthlyLong,
  periodKeysFor,
  rebuildMonth,
  rebuildPeriods,
  type MonthlyLongRow,
} from '@analytics/property-financials/aggregate';
import { driverNature, driverTiming } from '@analytics/property-financials/metrics';
import { loadCsvText, loadDataset } from './property-financials-helpers';

const D = loadDataset();
const CSV_TEXT = loadCsvText();
const ROWS = parseMonthlyLong(CSV_TEXT);
const INDEX = indexRows(ROWS);

const CENT = 0.005;
const RATIO_2DP = 0.005 + 1e-9;

function expectCent(actual: number, expected: number, label: string): void {
  expect(Math.abs(actual - expected), `${label}: rebuilt ${actual} vs dataset ${expected} (delta ${(actual - expected).toFixed(4)})`).toBeLessThan(CENT);
}

function expectRatio(actual: number | null, expected: number | null, label: string): void {
  if (expected === null) {
    expect(actual, label).toBeNull();
    return;
  }
  expect(actual, label).not.toBeNull();
  expect(Math.abs((actual as number) - expected), `${label}: rebuilt ${actual} vs dataset ${expected}`).toBeLessThanOrEqual(RATIO_2DP);
}

// -------------------------------------------------------------------------------------------------
// CSV parser
// -------------------------------------------------------------------------------------------------

describe('parseCsv (dependency-free, RFC 4180 quoting)', () => {
  it('handles quoted fields with commas, escaped quotes, embedded newlines, CRLF and a trailing newline', () => {
    const text = 'a,b,c\r\n1,"x, y","say ""hi"""\r\n2,"multi\nline",z\n';
    expect(parseCsv(text)).toEqual([
      ['a', 'b', 'c'],
      ['1', 'x, y', 'say "hi"'],
      ['2', 'multi\nline', 'z'],
    ]);
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('only,one\n')).toEqual([['only', 'one']]);
    expect(parseCsv('a,,c\n,,\n')).toEqual([['a', '', 'c'], ['', '', '']]);
  });

  it('rejects an unterminated quote', () => {
    expect(() => parseCsv('a,"b\n')).toThrow(/unterminated/i);
  });

  it('parses the committed monthly-long.csv: 15,493 rows x 6 columns under the documented header', () => {
    const grid = parseCsv(CSV_TEXT);
    expect(grid[0]).toEqual(['entity', 'period', 'line_type', 'category', 'source_account', 'amount_usd']);
    expect(grid.length - 1).toBe(15_493);
    expect(grid.every((r) => r.length === 6)).toBe(true);
  });
});

describe('parseMonthlyLong', () => {
  it('types every row and only knows the 8 documented line types', () => {
    expect(ROWS).toHaveLength(15_493);
    expect(LINE_TYPES).toEqual(['rev', 'opex', 'capex', 'dist', 'debt', 'nonop', 'inctax', 'noncash']);
    for (const r of ROWS) {
      expect(Number.isFinite(r.amount_usd)).toBe(true);
      expect(LINE_TYPES).toContain(r.line_type);
    }
    expect(new Set(ROWS.map((r) => r.entity))).toEqual(new Set(PF_ENTITY_IDS));
  });

  it('fails loudly on a bad header, a non-numeric amount, an unknown line type, or a ragged row', () => {
    const header = 'entity,period,line_type,category,source_account,amount_usd\n';
    expect(() => parseMonthlyLong('entity,period,line_type,category,account,amount\n')).toThrow(/header/i);
    expect(() => parseMonthlyLong(`${header}X,2024-01,rev,Base rent,Rent,abc\n`)).toThrow(/row 2.*amount/i);
    expect(() => parseMonthlyLong(`${header}X,2024-01,income,Base rent,Rent,1\n`)).toThrow(/row 2.*line_type/i);
    expect(() => parseMonthlyLong(`${header}X,2024-01,rev,Base rent,Rent\n`)).toThrow(/row 2.*6 columns/i);
    expect(() => parseMonthlyLong(`${header}X,2024-01,rev,Base rent,Rent,NaN\n`)).toThrow(/row 2.*amount/i);
  });
});

// -------------------------------------------------------------------------------------------------
// Period keys
// -------------------------------------------------------------------------------------------------

describe('period keys', () => {
  it('monthly entities use meta.periods month lists; annual entities use the <year>-FY / 2026-YTD(thru ...) CSV keys', () => {
    expect(periodKeysFor('FY2024', 'monthly', D.meta.periods)).toEqual(D.meta.periods.FY2024.months);
    expect(periodKeysFor('TTM26', 'monthly', D.meta.periods)).toHaveLength(12);
    expect(ANNUAL_CSV_PERIOD_KEYS).toEqual({
      FY2024: '2024-FY',
      FY2025: '2025-FY',
      'YTD26_partial_thru_2026-06-12': '2026-YTD(thru 2026-06-12)',
    });
    expect(periodKeysFor('FY2025', 'annual', D.meta.periods)).toEqual(['2025-FY']);
    // Every annual CSV key actually occurs in the file, and only for the annual entities.
    const annualKeys = new Set(Object.values(ANNUAL_CSV_PERIOD_KEYS));
    const seen = ROWS.filter((r) => annualKeys.has(r.period));
    expect(new Set(seen.map((r) => r.entity))).toEqual(new Set(PF_ANNUAL_ENTITY_IDS));
    expect(new Set(seen.map((r) => r.period))).toEqual(annualKeys);
  });
});

// -------------------------------------------------------------------------------------------------
// properties[id].periods — every figure, every entity, every period
// -------------------------------------------------------------------------------------------------

describe('properties[id].periods rebuild from the CSV alone', () => {
  for (const id of PF_ENTITY_IDS) {
    const prop = D.properties[id];
    const periods = prop.kind === 'monthly' ? STANDARD_PERIODS : ANNUAL_PERIODS;
    const rebuilt = rebuildPeriods(INDEX, id, prop.kind, D.meta.periods);

    for (const per of periods) {
      it(`${id} / ${per} ties to the cent`, () => {
        const exp = (prop.periods as Record<string, (typeof prop.periods)[keyof typeof prop.periods]>)[per];
        const got = rebuilt[per];
        if (!exp || !got) throw new Error(`missing period ${per}`);
        for (const k of [
          'base_rent', 'vacancy_waivers', 'reimbursements', 'recoveries', 'utility_reimb', 'other_income', 'energy_income',
          'revenue', 'opex', 'noi', 'pool', 'capex', 'dist',
        ] as const) {
          expectCent(got[k], exp[k], `${id}/${per}/${k}`);
        }
        for (const c of OPEX_CATEGORIES) expectCent(got.opex_by[c], exp.opex_by[c], `${id}/${per}/opex_by/${c}`);
        expectRatio(got.noi_margin, exp.noi_margin, `${id}/${per}/noi_margin`);
        expectRatio(got.opex_ratio, exp.opex_ratio, `${id}/${per}/opex_ratio`);
        expectRatio(got.mgmt_fee_pct, exp.mgmt_fee_pct, `${id}/${per}/mgmt_fee_pct`);
        expectRatio(got.recovery_ratio, exp.recovery_ratio, `${id}/${per}/recovery_ratio`);
        if (prop.kind === 'monthly') {
          expect(got.n_months, `${id}/${per}/n_months`).toBe(exp.n_months);
        } else {
          // Annual statements are one CSV row-group per period; the dataset's 12 / 12 / 5.4 month
          // counts are declared from the statement dates, not derivable from the CSV.
          expect(got.n_months, `${id}/${per}/n_months (statement groups)`).toBe(1);
        }
      });
    }
  }

  it('NOI is exactly revenue minus recurring opex: no below-line type leaks into either side', () => {
    const r = aggregateRows(INDEX, '9050 Red Branch', D.meta.periods.FY2025.months);
    const rows = ROWS.filter((x) => x.entity === '9050 Red Branch' && D.meta.periods.FY2025.months.includes(x.period));
    const sum = (lt: MonthlyLongRow['line_type']) => rows.filter((x) => x.line_type === lt).reduce((a, x) => a + x.amount_usd, 0);
    expectCent(r.revenue, sum('rev'), 'revenue = sum(rev)');
    expectCent(r.opex, sum('opex'), 'opex = sum(opex)');
    expectCent(r.noi, sum('rev') - sum('opex'), 'noi');
    expectCent(r.capex, sum('capex'), 'capex');
    expectCent(r.dist, sum('dist'), 'dist');
    // debt / nonop / inctax / noncash are present in the file for some entities and never counted.
    expect(ROWS.some((x) => x.line_type === 'debt')).toBe(true);
  });

  it('security-deposit receipts are absent from the CSV revenue rows (excluded upstream), prepaid rent rows are present and counted', () => {
    const revAccounts = new Set(ROWS.filter((x) => x.line_type === 'rev').map((x) => x.source_account));
    // Deposit RECEIPTS would be a liability movement; only forfeiture INCOME accounts appear.
    for (const acc of revAccounts) {
      if (/deposit/i.test(acc)) expect(acc, acc).toMatch(/forfeit/i);
    }
    const prepaid = ROWS.filter((x) => /prepaid/i.test(x.source_account));
    expect(prepaid.length).toBeGreaterThan(0);
    expect(new Set(prepaid.map((x) => `${x.line_type}|${x.category}`))).toEqual(new Set(['rev|Vacancy / waivers / bad debt']));
  });
});

// -------------------------------------------------------------------------------------------------
// monthly[id][YYYY-MM] — every month, every monthly entity
// -------------------------------------------------------------------------------------------------

describe('monthly[id][YYYY-MM] rebuild from the CSV alone', () => {
  for (const id of PF_MONTHLY_ENTITY_IDS) {
    it(`${id}: every cube month ties to the cent and no 2024+ CSV month is missing from the cube`, () => {
      const cube = D.monthly[id];
      for (const [month, exp] of Object.entries(cube)) {
        const got = rebuildMonth(INDEX, id, month);
        expect(got, `${id}/${month} has rows`).not.toBeNull();
        if (!got) continue;
        for (const k of ['base_rent', 'reimbursements', 'other_income', 'vacancy_waivers', 'revenue', 'opex', 'noi', 'capex'] as const) {
          expectCent(got[k], exp[k], `${id}/${month}/${k}`);
        }
        for (const c of OPEX_CATEGORIES) expectCent(got.opex_by[c], exp.opex_by[c], `${id}/${month}/opex_by/${c}`);
      }
      const csvMonths = [...(INDEX.get(id)?.keys() ?? [])].filter((p) => /^\d{4}-\d{2}$/.test(p) && p >= '2024-01').sort();
      expect(csvMonths).toEqual(Object.keys(cube).sort());
    });
  }

  it('a month with no rows rebuilds to null, never to a zero month', () => {
    expect(rebuildMonth(INDEX, '3034 Westerville', '2024-10')).toBeNull();
    expect(rebuildMonth(INDEX, '3883 Livingston', '2025-07')).toBeNull();
    expect(rebuildMonth(INDEX, 'no such entity' as PfEntityId, '2024-01')).toBeNull();
  });
});

// -------------------------------------------------------------------------------------------------
// history[id].yr / ytd totals (bonus parity: same CSV, full history back to the first month on file)
// -------------------------------------------------------------------------------------------------

describe('history[id].yr and .ytd totals rebuild from the CSV', () => {
  for (const id of PF_MONTHLY_ENTITY_IDS) {
    it(`${id}: br / rev / opex / noi / n tie for every year and Jan-Sep slice`, () => {
      const h = D.history[id];
      for (const [year, exp] of Object.entries(h.yr)) {
        const months = Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
        const got = aggregateRows(INDEX, id, months);
        expectCent(got.base_rent, exp.br, `${id}/yr/${year}/br`);
        expectCent(got.revenue, exp.rev, `${id}/yr/${year}/rev`);
        expectCent(got.opex, exp.opex, `${id}/yr/${year}/opex`);
        expectCent(got.noi, exp.noi, `${id}/yr/${year}/noi`);
        expect(got.n_months, `${id}/yr/${year}/n`).toBe(exp.n);
      }
      for (const [year, exp] of Object.entries(h.ytd)) {
        const months = Array.from({ length: 9 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
        const got = aggregateRows(INDEX, id, months);
        expectCent(got.base_rent, exp.br, `${id}/ytd/${year}/br`);
        expectCent(got.revenue, exp.rev, `${id}/ytd/${year}/rev`);
        expectCent(got.opex, exp.opex, `${id}/ytd/${year}/opex`);
        expectCent(got.noi, exp.noi, `${id}/ytd/${year}/noi`);
        expect(got.n_months, `${id}/ytd/${year}/n`).toBe(exp.n);
      }
    });
  }
});

describe('history[id].yr.partial is NOT a usable flag for monthly entities', () => {
  it('is false on every monthly-entity year, including years with n < 12 — consumers must derive partial from n (the artifact does)', () => {
    // Data-dictionary v02 says "Years with n below 12 are partial"; the flag field only encodes that
    // for the two annual entities (2026 statement). Pinned so a refreshed dataset that starts
    // populating it is noticed and this guard retired.
    const shortYears: string[] = [];
    for (const id of PF_MONTHLY_ENTITY_IDS) {
      for (const [year, row] of Object.entries(D.history[id].yr)) {
        expect(row.partial, `${id}/${year}`).toBe(false);
        if (row.n < 12) shortYears.push(`${id}/${year}`);
      }
    }
    expect(shortYears.length).toBeGreaterThan(0);
    for (const id of PF_ANNUAL_ENTITY_IDS) {
      expect(D.history[id].yr['2026']?.partial).toBe(true);
      expect(D.history[id].yr['2025']?.partial).toBe(false);
    }
  });
});

// -------------------------------------------------------------------------------------------------
// history[id].drv nature tags recomputed from CSV timing (T2 rule, CSV-derived inputs)
// -------------------------------------------------------------------------------------------------

describe('history[id].drv[period][].nat from CSV account timing', () => {
  it('every driver of every monthly entity gets the dataset nature tag from CSV-derived activeMonths / topShare', () => {
    let checked = 0;
    for (const id of PF_MONTHLY_ENTITY_IDS) {
      const h = D.history[id];
      for (const [per, drivers] of Object.entries(h.drv)) {
        const year = per === 'YTD26' ? '2026' : per;
        const monthCount = per === 'YTD26' ? 9 : 12;
        const months = Array.from({ length: monthCount }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`);
        for (const d of drivers) {
          const byMonth = months.map((m) => ({
            month: m,
            amount: (INDEX.get(id)?.get(m) ?? [])
              .filter((r) => r.line_type === d.lt && r.category === d.c && r.source_account === d.a)
              .reduce((a, r) => a + r.amount_usd, 0),
          }));
          const timing = driverTiming(byMonth);
          expect(timing.activeMonths, `${id}/${per}/${d.a} nm`).toBe(d.nm);
          expect(Math.abs(timing.topShare - d.conc), `${id}/${per}/${d.a} conc`).toBeLessThanOrEqual(RATIO_2DP);
          expect(timing.topMonth, `${id}/${per}/${d.a} top`).toBe(d.top);
          // d.n is stored as whole dollars (the builder's rounding of an exact .5 differs from Math.round).
          expect(Math.abs(timing.total - d.n), `${id}/${per}/${d.a} current total`).toBeLessThanOrEqual(0.5 + 1e-6);
          expect(driverNature({ activeMonths: timing.activeMonths, topShare: timing.topShare }), `${id}/${per}/${d.a} nat`).toBe(d.nat);
          checked++;
        }
      }
    }
    expect(checked).toBeGreaterThan(450);
  });
});
