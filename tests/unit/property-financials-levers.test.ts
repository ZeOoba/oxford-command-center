// tests/unit/property-financials-levers.test.ts — T6 of
// docs/superpowers/plans/2026-10-05-property-financials-module.md. The "value of a point" sensitivity
// table (reference artifact LEVERS block). Every expected value here is computed INDEPENDENTLY from
// the raw dataset JSON (plain loops over the parsed file), never by calling the lever code, so a
// wrong formula in src/analytics/property-financials/levers.ts cannot pass by agreeing with itself.
import { describe, expect, it } from 'vitest';
import { LEVERS, computeLevers, describeLeverRate, type LeverDef } from '@analytics/property-financials/levers';
import { usd } from '@analytics/property-financials/format';
import { loadDataset, loadDatasetText } from './property-financials-helpers';
import { pfGolden } from './golden-helpers';

const D = loadDataset();
// A second, independent copy of the data: the raw JSON, untouched by the contract parser.
const RAW = JSON.parse(loadDatasetText()) as {
  properties: Record<string, { kind: string; periods: Record<string, Record<string, number> & { opex_by: Record<string, number> }> }>;
  leases: Array<{ property: string; sf: number | null; source: string; confidence: string; rent_schedule_monthly?: Array<[string, string | null, number]> }>;
};
const PM = Object.keys(RAW.properties).filter((k) => RAW.properties[k]!.kind === 'monthly');

// RULE (pmField / pmOpex levers): a portfolio sum covers only the members whose period is COMPLETE
// (rule 1 in periods.ts: a partial period is displayed, never annualized — and a 6-month tax figure
// summed under an "annual value" column is an annualization by omission). A partial member is left out
// of the base and named in the basis ("excludes ..."); the lever itself stays a value. This is the same
// rule the recoveryPool lever applies to its single member (n/m on a partial period). It departs from the
// reference artifact, whose sumP() summed every PM asset regardless of n_months (FY2025 tax including
// 3883 Livingston's 6-month figure).
const FULL_MONTHS = 12;
const complete = (id: string, period: string) => RAW.properties[id]!.periods[period]!.n_months === FULL_MONTHS;
function sumField(period: string, field: string): number {
  let s = 0;
  for (const id of PM) if (complete(id, period)) s += RAW.properties[id]!.periods[period]![field] as number;
  return s;
}
function sumOpex(period: string, cat: string): number {
  let s = 0;
  for (const id of PM) if (complete(id, period)) s += RAW.properties[id]!.periods[period]!.opex_by[cat]!;
  return s;
}
function pool(id: string, period: string): number {
  const o = RAW.properties[id]!.periods[period]!.opex_by;
  return o['Real estate & property tax']! + o.Insurance! + o.Utilities! + o['Grounds / snow / lot']! + o['Repairs & maintenance']!;
}

const byId = (rs: ReturnType<typeof computeLevers>) => new Map(rs.map((r) => [r.id, r]));

describe('lever config', () => {
  it('is ONE exported object covering the artifact rows in the artifact order', () => {
    expect(LEVERS.map((l) => l.id)).toEqual([
      'rentGrowth',
      'fishelPerSf',
      'recoveryFvc',
      'recovery9620',
      'recoveryRarig',
      'reTaxAppeal',
      'utilities',
      'grounds',
      'repairs',
      'mgmtFee',
      'insurance',
    ]);
    expect(PM).toHaveLength(9);
  });

  it('label text is generated from the rate, so the label and the value move together', () => {
    const r = byId(computeLevers(D));
    expect(r.get('rentGrowth')!.label).toBe('+1 point of annual rent growth, all PM assets');
    expect(r.get('fishelPerSf')!.label).toBe('Fishel: each $1.00/SF NNN on 24,000 SF');
    expect(r.get('recoveryFvc')!.label).toBe('FVC: +10 points of recovery on the cost pool');
    expect(r.get('reTaxAppeal')!.label).toBe('Real estate tax: 5% reduction through appeals');
    expect(r.get('mgmtFee')!.label).toBe('Management fee: 50 bps on revenue');
    expect(r.get('insurance')!.label).toBe('Insurance: 8% through one blanket program');
    expect(describeLeverRate({ unit: 'points', rate: 0.01 })).toBe('1 point');
    expect(describeLeverRate({ unit: 'points', rate: 0.1 })).toBe('10 points');
    expect(describeLeverRate({ unit: 'bps', rate: 0.005 })).toBe('50 bps');
    expect(describeLeverRate({ unit: 'pct', rate: 0.08 })).toBe('8%');
    expect(describeLeverRate({ unit: 'usdPerSf', rate: 1 })).toBe('$1.00/SF');
  });
});

describe('lever arithmetic (independent spot-checks from the raw dataset)', () => {
  const r = byId(computeLevers(D));

  it('rent: +1 point on TTM base rent of the nine PM assets', () => {
    expect(r.get('rentGrowth')!.value.value).toBeCloseTo(sumField('TTM26', 'base_rent') * 0.01, 6);
    expect(r.get('rentGrowth')!.basis).toBe(`Base rent TTM Sep-26 ${usd(sumField('TTM26', 'base_rent'))}`);
  });

  it('Fishel: $1.00/SF x the lease SF from the dataset leases, with its source cited', () => {
    const lease = RAW.leases.find((l) => l.property.startsWith('7658 Fishel'))!;
    expect(lease.sf).toBe(24_000);
    const f = r.get('fishelPerSf')!;
    expect(f.value.value).toBe(lease.sf! * 1.0);
    expect(f.basis).toContain('24,000 SF per lease');
    expect(f.basis).toContain(lease.source);
    // Every renewal step in the schedule is +2.0% over the prior step's monthly rent.
    const amts = lease.rent_schedule_monthly!.map((x) => x[2]);
    for (let i = 1; i < amts.length; i++) expect(amts[i]! / amts[i - 1]! - 1).toBeCloseTo(0.02, 3);
    expect(f.basis).toContain('+2.0%/yr');
  });

  it('recovery: +10 points of each named cost pool (FVC FY2025, 9620 TTM, Rarig FY2025)', () => {
    expect(r.get('recoveryFvc')!.value.value).toBeCloseTo(pool('FVC', 'FY2025') * 0.1, 6);
    expect(r.get('recovery9620')!.value.value).toBeCloseTo(pool('9620 State 350', 'TTM26') * 0.1, 6);
    expect(r.get('recovery9620')!.value.value).toBeCloseTo(pfGolden().locks.recovery9620Lever, 2); // value lock
    expect(r.get('recoveryRarig')!.value.value).toBeCloseTo(pool('1100 Rarig', 'FY2025') * 0.1, 6);
    // The recomputed pool is the dataset's own pool figure.
    expect(pool('FVC', 'FY2025')).toBeCloseTo(RAW.properties.FVC!.periods.FY2025!.pool as number, 2);
    expect(r.get('recoveryFvc')!.basis).toBe(`FY25 pool ${usd(pool('FVC', 'FY2025'))}`);
  });

  it('cost levers: % of the summed PM category in the stated period', () => {
    expect(r.get('reTaxAppeal')!.value.value).toBeCloseTo(sumOpex('FY2025', 'Real estate & property tax') * 0.05, 6);
    expect(r.get('utilities')!.value.value).toBeCloseTo(sumOpex('TTM26', 'Utilities') * 0.1, 6);
    expect(r.get('grounds')!.value.value).toBeCloseTo(sumOpex('TTM26', 'Grounds / snow / lot') * 0.1, 6);
    expect(r.get('repairs')!.value.value).toBeCloseTo(sumOpex('TTM26', 'Repairs & maintenance') * 0.1, 6);
    expect(r.get('insurance')!.value.value).toBeCloseTo(sumOpex('TTM26', 'Insurance') * 0.08, 6);
  });

  it('management fee: 50 bps on TTM revenue; basis states the fee and its share of revenue', () => {
    const rev = sumField('TTM26', 'revenue');
    const fees = sumOpex('TTM26', 'Management fees');
    expect(r.get('mgmtFee')!.value.value).toBeCloseTo(rev * 0.005, 6);
    expect(r.get('mgmtFee')!.basis).toBe(`Fees TTM Sep-26 ${usd(fees)} (${((fees / rev) * 100).toFixed(1)}% of revenue)`);
  });

  it('a partial-period member is EXCLUDED from the sum and named in the basis (FY2025: 3883 Livingston has 6 months)', () => {
    expect(RAW.properties['3883 Livingston']!.periods.FY2025!.n_months).toBe(6);
    const tax = r.get('reTaxAppeal')!;
    const full = sumOpex('FY2025', 'Real estate & property tax');
    const livingston = RAW.properties['3883 Livingston']!.periods.FY2025!.opex_by['Real estate & property tax']!;
    expect(livingston).toBeGreaterThan(0); // not vacuous: leaving it out moves the base
    expect(tax.base).toBeCloseTo(full, 6);
    expect(tax.value.value).toBeCloseTo(full * 0.05, 6);
    expect(tax.basis).toBe(`FY25 tax ${usd(full)}; excludes 3883 Livingston (partial period: 6 of 12 months)`);
    expect(r.get('utilities')!.basis).not.toMatch(/excludes|of 12 months/);
  });

  it('the same rule on a pmField lever: a partial TTM member leaves the base-rent and revenue sums', () => {
    const p = D.properties['1100 Rarig'];
    if (p.kind !== 'monthly') throw new Error('Rarig is monthly');
    const short = { ...D, properties: { ...D.properties, '1100 Rarig': { ...p, periods: { ...p.periods, TTM26: { ...p.periods.TTM26, n_months: 11 } } } } };
    const s = byId(computeLevers(short));
    const rarig = p.periods.TTM26;
    expect(s.get('rentGrowth')!.base).toBeCloseTo(sumField('TTM26', 'base_rent') - rarig.base_rent, 6);
    expect(s.get('rentGrowth')!.basis).toMatch(/; excludes 1100 Rarig \(partial period: 11 of 12 months\)$/);
    expect(s.get('mgmtFee')!.base).toBeCloseTo(sumField('TTM26', 'revenue') - rarig.revenue, 6);
    expect(s.get('utilities')!.base).toBeCloseTo(sumOpex('TTM26', 'Utilities') - rarig.opex_by.Utilities, 6);
  });
});

describe('changing a lever parameter changes its value (single config)', () => {
  it('doubling the utilities rate doubles its value and rewrites its label; nothing else moves', () => {
    const base = byId(computeLevers(D));
    const cloned: LeverDef[] = LEVERS.map((l) => (l.id === 'utilities' ? { ...l, rate: 0.2 } : l));
    const after = byId(computeLevers(D, cloned));
    expect(after.get('utilities')!.value.value).toBeCloseTo(base.get('utilities')!.value.value! * 2, 6);
    expect(after.get('utilities')!.label).toBe('Utilities: 20% reduction (supply bid, submeters, leaks)');
    for (const l of LEVERS) if (l.id !== 'utilities') expect(after.get(l.id)!.value).toEqual(base.get(l.id)!.value);
  });

  it('moving the Fishel $/SF moves the value; a lease without SF is n/m with a reason, never 0', () => {
    const cloned = LEVERS.map((l) => (l.id === 'fishelPerSf' ? { ...l, rate: 1.5 } : l));
    expect(byId(computeLevers(D, cloned)).get('fishelPerSf')!.value.value).toBe(36_000);
    const noSf = { ...D, leases: D.leases.map((l) => (l.property.startsWith('7658 Fishel') ? { ...l, sf: null } : l)) };
    const f = byId(computeLevers(noSf)).get('fishelPerSf')!;
    expect(f.value.value).toBeNull();
    expect(f.value.reason).toMatch(/no square footage/);
    const noLease = { ...D, leases: D.leases.filter((l) => !l.property.startsWith('7658 Fishel')) };
    expect(byId(computeLevers(noLease)).get('fishelPerSf')!.value.reason).toMatch(/no lease on file/);
  });

  it('a recovery lever on a partial period is n/m, not a scaled-down number', () => {
    const cloned = LEVERS.map((l) => (l.id === 'recoveryRarig' ? { ...l, base: { kind: 'recoveryPool' as const, entity: '3883 Livingston' as const, period: 'FY2025' as const } } : l));
    const v = byId(computeLevers(D, cloned)).get('recoveryRarig')!.value;
    expect(v.value).toBeNull();
    expect(v.reason).toMatch(/partial period: 6 of 12 months/);
  });
});
