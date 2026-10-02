import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot, Lease } from '@contracts/index';
import { evaluateConditions, ALERT_THRESHOLDS, type MonthSnapshotInput } from '@analytics/conditions';
import type { PropertyExpenseSeries } from '@analytics/expense-trends';
import { addMonths } from '@analytics/portfolio-trends';

const ASOF = '2026-12-20';
const NOW = Date.parse('2026-12-20T12:00:00.000Z');
const base = { now: NOW };

function snap(over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  const b = {
    meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: '2026-12-20T00:00:00.000Z', source: 't', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: ASOF },
    properties: [], leases: [], loans: [], deals: [], insurance: [], tasks: [], counterparties: [],
    renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, quickbooks: null, dataQuality: [],
    tenantArrears: {}, acquisitionInputs: {},
    cash: { asOf: ASOF, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
  };
  return { ...b, ...over } as unknown as PortfolioSnapshot;
}

const ms = (propertyId: string, month: string, leasedSf: number, inPlaceRent = 1000, totalSf = 10000): MonthSnapshotInput =>
  ({ propertyId, month, leasedSf, totalSf, inPlaceRent });

const props = [{ id: 'p1', name: '1100 Rarig Ave' }, { id: 'p2', name: '200 Oak St' }];
const withProps = () => snap({ properties: props } as unknown as Partial<PortfolioSnapshot>);
const run = (monthSnapshots: MonthSnapshotInput[], referenceDate?: string) =>
  evaluateConditions(withProps(), { ...base, monthSnapshots, ...(referenceDate ? { referenceDate } : {}) });
const vac = (out: ReturnType<typeof run>) => out.filter((i) => i.id.startsWith('vacancy-rising-'));
const rent = (out: ReturnType<typeof run>) => out.filter((i) => i.id.startsWith('rent-drop-'));

describe('thresholds', () => {
  it('ratified values', () => {
    expect(ALERT_THRESHOLDS.vacancyRiseMinPts).toBe(2.0);
    expect(ALERT_THRESHOLDS.rentDropWarnPct).toBe(0.03);
    expect(ALERT_THRESHOLDS.opexSpikeWarnPct).toBe(0.25);
  });
});

describe('vacancy-rising', () => {
  // totalSf 10000; leased 9500/9350/9180 -> vacancy 5.0% / 6.5% / 8.2%; rise 3.2 pts >= 2.0
  const rising = [ms('p1', '2026-10', 9500), ms('p1', '2026-11', 9350), ms('p1', '2026-12', 9180)];

  it('fires on a 3-month strictly rising sequence with exact detail', () => {
    const v = vac(run(rising));
    expect(v).toHaveLength(1);
    const i = v[0]!;
    expect(i.id).toBe('vacancy-rising-p1-2026-12');
    expect(i.title).toBe('Vacancy rising — 1100 Rarig Ave');
    expect(i.severity).toBe('warning');
    expect(i.entityType).toBe('property');
    expect(i.entityId).toBe('p1');
    expect(i.impactAnnualUsd).toBeNull();
    expect(i.provenance).toBe('derived');
    expect(i.detail).toBe('Vacancy 5.0% → 6.5% → 8.2% (Oct–Dec 2026, recorded, lease-SF basis)');
  });
  it('fires at exactly the 2.0-point floor (inclusive)', () => {
    // 5.0 / 6.0 / 7.0 -> rise 2.0 pts
    expect(vac(run([ms('p1', '2026-10', 9500), ms('p1', '2026-11', 9400), ms('p1', '2026-12', 9300)]))).toHaveLength(1);
  });
  it('silent below the floor (1.0 pts)', () => {
    expect(vac(run([ms('p1', '2026-10', 9500), ms('p1', '2026-11', 9450), ms('p1', '2026-12', 9400)]))).toHaveLength(0);
  });
  it('silent with only 2 recorded months', () => {
    expect(vac(run(rising.slice(1)))).toHaveLength(0);
  });
  it('silent with exactly one recorded month (today\'s data)', () => {
    expect(vac(run(rising.slice(2)))).toHaveLength(0);
  });
  it('silent when a month is missing from the window (gap)', () => {
    expect(vac(run([rising[0]!, rising[2]!, ms('p1', '2026-09', 9600)]))).toHaveLength(0);
  });
  it('silent when vacancy rises then falls', () => {
    expect(vac(run([ms('p1', '2026-10', 9500), ms('p1', '2026-11', 9000), ms('p1', '2026-12', 9300)]))).toHaveLength(0);
  });
  it('silent when vacancy falls then rises', () => {
    expect(vac(run([ms('p1', '2026-10', 9000), ms('p1', '2026-11', 9500), ms('p1', '2026-12', 9300)]))).toHaveLength(0);
  });
  it('silent when totalSf is 0', () => {
    expect(vac(run(rising.map((r) => ({ ...r, totalSf: 0 }))))).toHaveLength(0);
  });
  it('uses the latest three consecutive months of a longer series; input order irrelevant', () => {
    const longer = [ms('p1', '2026-12', 9180), ms('p1', '2026-08', 9900), ms('p1', '2026-10', 9500), ms('p1', '2026-11', 9350), ms('p1', '2026-09', 9700)];
    const v = vac(run(longer));
    expect(v.map((i) => i.id)).toEqual(['vacancy-rising-p1-2026-12']);
  });
  it('crosses a year boundary', () => {
    const v = vac(run([ms('p1', '2026-11', 9500), ms('p1', '2026-12', 9350), ms('p1', '2027-01', 9180)], '2027-01-20'));
    expect(v[0]!.id).toBe('vacancy-rising-p1-2027-01');
    expect(v[0]!.detail).toContain('Nov 2026–Jan 2027');
  });
});

describe('rent-drop', () => {
  it('fires at exactly 3.0% (inclusive) with exact detail', () => {
    const r = rent(run([ms('p1', '2026-11', 9000, 1000), ms('p1', '2026-12', 9000, 970)]));
    expect(r).toHaveLength(1);
    const i = r[0]!;
    expect(i.id).toBe('rent-drop-p1-2026-12');
    expect(i.title).toBe('In-place rent down — 1100 Rarig Ave');
    expect(i.severity).toBe('warning');
    expect(i.impactAnnualUsd).toBeNull();
    expect(i.entityId).toBe('p1');
    expect(i.provenance).toBe('derived');
    expect(i.detail).toBe('In-place rent $1,000 → $970 (-3.0%), Nov–Dec 2026, recorded');
  });
  it('silent at 2.9%', () => {
    expect(rent(run([ms('p1', '2026-11', 9000, 1000), ms('p1', '2026-12', 9000, 971)]))).toHaveLength(0);
  });
  it('silent when rent rises', () => {
    expect(rent(run([ms('p1', '2026-11', 9000, 1000), ms('p1', '2026-12', 9000, 1100)]))).toHaveLength(0);
  });
  it('silent with a gap', () => {
    expect(rent(run([ms('p1', '2026-10', 9000, 1000), ms('p1', '2026-12', 9000, 500)]))).toHaveLength(0);
  });
  it('silent with prior rent 0', () => {
    expect(rent(run([ms('p1', '2026-11', 9000, 0), ms('p1', '2026-12', 9000, 0)]))).toHaveLength(0);
  });
  it('silent with one recorded month', () => {
    expect(rent(run([ms('p1', '2026-12', 9000, 1000)]))).toHaveLength(0);
  });
});

function expSeries(over: Partial<PropertyExpenseSeries> = {}, latest = 1250, nBase = 12, base0 = 1000, latestMonth = '2026-10'): PropertyExpenseSeries {
  // baseline = the nBase months immediately before latestMonth
  const months = [];
  for (let k = nBase; k >= 1; k--) months.push({ month: addMonths(latestMonth, -k), total: base0, byCategory: {} });
  months.push({ month: latestMonth, total: latest, byCategory: {} });
  return { propertyId: 'p1', basis: 'accrual', months, ...over };
}
const opex = (series: PropertyExpenseSeries[], referenceDate = '2026-11-15') =>
  evaluateConditions(withProps(), { ...base, referenceDate, expenseSeries: series }).filter((i) => i.id.startsWith('opex-spike-'));

describe('opex-spike', () => {
  it('fires at exactly +25% with exact detail', () => {
    const o = opex([expSeries()]);
    expect(o).toHaveLength(1);
    const i = o[0]!;
    expect(i.id).toBe('opex-spike-p1-2026-10');
    expect(i.title).toBe('Opex spike — 1100 Rarig Ave');
    expect(i.severity).toBe('warning');
    expect(i.impactAnnualUsd).toBeNull();
    expect(i.entityType).toBe('property');
    expect(i.entityId).toBe('p1');
    expect(i.provenance).toBe('derived');
    expect(i.detail).toBe('Opex $1,250 in Oct 2026 vs trailing-12 average $1,000 (+25.0%), accrual basis');
  });
  it('silent at +24%', () => expect(opex([expSeries({}, 1240)])).toHaveLength(0));
  it('silent without a full 12-month window', () => expect(opex([expSeries({}, 5000, 11)])).toHaveLength(0));
  it('silent with a 0 baseline', () => expect(opex([expSeries({}, 500, 12, 0)])).toHaveLength(0));
  it('silent with a negative baseline (credits)', () => expect(opex([expSeries({}, 500, 12, -100)])).toHaveLength(0));
  it('silent on a decrease', () => expect(opex([expSeries({}, 500)])).toHaveLength(0));
  it('states the cash basis', () => {
    expect(opex([expSeries({ basis: 'cash' })])[0]!.detail).toMatch(/cash basis$/);
  });
  it('one Insight per property, latest month only', () => {
    const o = opex([expSeries(), expSeries({ propertyId: 'p2' })]);
    expect(o.map((i) => i.id).sort()).toEqual(['opex-spike-p1-2026-10', 'opex-spike-p2-2026-10']);
  });
});

describe('cross-cutting', () => {
  const inputs = {
    monthSnapshots: [
      ms('p1', '2026-10', 9500, 1000), ms('p1', '2026-11', 9350, 1000), ms('p1', '2026-12', 9180, 900),
      ms('p2', '2026-10', 9500, 1000), ms('p2', '2026-11', 9350, 1000), ms('p2', '2026-12', 9180, 900),
    ],
    expenseSeries: [expSeries({}, 1250, 12, 1000, '2026-12'), expSeries({ propertyId: 'p2' }, 1250, 12, 1000, '2026-12')],
  };
  it('ids stable across evaluations, unique across properties/rules; impact always null', () => {
    const a = evaluateConditions(withProps(), { ...base, ...inputs });
    const b = evaluateConditions(withProps(), { ...base, ...inputs });
    expect(a.map((i) => i.id)).toEqual(b.map((i) => i.id));
    expect(new Set(a.map((i) => i.id)).size).toBe(a.length);
    expect(a).toHaveLength(6); // 2 props x (vacancy, rent, opex)
    for (const i of a) expect(i.impactAnnualUsd).toBeNull();
  });
  it('byte-identical output when the new opts are absent (existing fixture with live alerts)', () => {
    const lease: Lease = {
      id: 'l1', propertyKey: 'Prop A', propertyId: 'p1', tenantName: 'T', unit: null, company: 'Acme',
      sf: 1000, monthlyRent: 1000, rentPerSf: null, leaseStart: null, leaseEnd: '2027-01-15', escalationDate: null,
      escalationPct: null, status: 'Active', annualRent: 12000, monthsToExpiry: null, flags: [],
    };
    const s = snap({ leases: [lease] });
    const before = JSON.stringify(evaluateConditions(s, base));
    expect(before).toContain('expir'); // fixture actually produces alerts
    expect(JSON.stringify(evaluateConditions(s, { ...base, monthSnapshots: undefined, expenseSeries: undefined }))).toBe(before);
    expect(JSON.stringify(evaluateConditions(s, { ...base, monthSnapshots: [], expenseSeries: [] }))).toBe(before);
  });
});

describe('recency guard (reference month = asOf month)', () => {
  const rising = [ms('p1', '2026-10', 9500), ms('p1', '2026-11', 9350), ms('p1', '2026-12', 9180)];
  const drop = [ms('p1', '2026-11', 9000, 1000), ms('p1', '2026-12', 9000, 900)];
  // latest data month = 2026-12
  it.each([
    ['stale (ref 3 months after latest)', '2027-03-15', 0],
    ['ref = latest + 2 months', '2027-02-15', 0],
    ['ref = latest + 1 month', '2027-01-15', 1],
    ['ref = latest month', '2026-12-15', 1],
    ['future-dated latest (ref = latest - 1)', '2026-11-15', 0],
  ])('vacancy-rising and rent-drop: %s', (_n, ref, expected) => {
    expect(vac(run(rising, ref))).toHaveLength(expected);
    expect(rent(run(drop, ref))).toHaveLength(expected);
  });
  // opex latest month = 2026-10
  it.each([
    ['stale (ref 3 months after latest)', '2027-01-15', 0],
    ['ref = latest + 2 months', '2026-12-15', 0],
    ['ref = latest + 1 month', '2026-11-15', 1],
    ['ref = latest month', '2026-10-15', 1],
    ['future-dated latest (ref = latest - 1)', '2026-09-15', 0],
  ])('opex-spike: %s', (_n, ref, expected) => {
    expect(opex([expSeries()], ref)).toHaveLength(expected);
  });
});

describe('titles / extra cases', () => {
  it('falls back to the raw id when the property is not in the snapshot', () => {
    const out = evaluateConditions(snap(), { ...base, monthSnapshots: [ms('zz9', '2026-10', 9500), ms('zz9', '2026-11', 9350), ms('zz9', '2026-12', 9180)] });
    expect(out.find((i) => i.id === 'vacancy-rising-zz9-2026-12')!.title).toBe('Vacancy rising — zz9');
  });
  it('vacancy rise of 1.99 points does not fire', () => {
    // leased 9500 / 9400 / 9301 -> 5.00 / 6.00 / 6.99% => 1.99 pts
    expect(vac(run([ms('p1', '2026-10', 9500), ms('p1', '2026-11', 9400), ms('p1', '2026-12', 9301)]))).toHaveLength(0);
  });
  it('rent-drop across a Dec -> Jan year boundary', () => {
    const r = rent(run([ms('p1', '2026-12', 9000, 1000), ms('p1', '2027-01', 9000, 900)], '2027-01-20'));
    expect(r).toHaveLength(1);
    expect(r[0]!.id).toBe('rent-drop-p1-2027-01');
    expect(r[0]!.detail).toBe('In-place rent $1,000 → $900 (-10.0%), Dec 2026–Jan 2027, recorded');
  });
  it('two properties with different data are isolated', () => {
    const out = run([
      ms('p1', '2026-10', 9500, 1000), ms('p1', '2026-11', 9350, 1000), ms('p1', '2026-12', 9180, 1000),
      ms('p2', '2026-10', 9500, 1000), ms('p2', '2026-11', 9600, 1000), ms('p2', '2026-12', 9700, 1000),
    ]);
    expect(vac(out).map((i) => i.id)).toEqual(['vacancy-rising-p1-2026-12']);
    expect(rent(out)).toHaveLength(0);
  });
});

describe('vacancy clamp (matches Trends tab) and non-investment filter', () => {
  it('over-leased months clamp to 0% and cannot form a strict rise (105% -> 101% -> 98%)', () => {
    expect(vac(run([ms('p1', '2026-10', 10500), ms('p1', '2026-11', 10100), ms('p1', '2026-12', 9800)]))).toHaveLength(0);
  });
  it('clamped months still allow a genuine strict rise; detail shows clamped values', () => {
    // 101% -> 99% -> 97%: clamped 0.0% / 1.0% / 3.0% -> +3.0 pts, strictly rising
    const v = vac(run([ms('p1', '2026-10', 10100), ms('p1', '2026-11', 9900), ms('p1', '2026-12', 9700)]));
    expect(v).toHaveLength(1);
    expect(v[0]!.detail).toBe('Vacancy 0.0% → 1.0% → 3.0% (Oct–Dec 2026, recorded, lease-SF basis)');
  });
  const resSnap = () => snap({ properties: [...props, { id: 'res', name: '9510 Persimmon Tree', type: 'Residence' }] } as unknown as Partial<PortfolioSnapshot>);
  it('residence ids emit nothing for all three rules; investment and unknown ids still fire', () => {
    const rows = ['p1', 'res', 'zz9'].flatMap((id) => [
      ms(id, '2026-10', 9500, 1000), ms(id, '2026-11', 9350, 1000), ms(id, '2026-12', 9180, 900),
    ]);
    const out = evaluateConditions(resSnap(), {
      ...base, monthSnapshots: rows,
      expenseSeries: ['p1', 'res', 'zz9'].map((id) => expSeries({ propertyId: id }, 1250, 12, 1000, '2026-12')),
    });
    const ids = out.map((i) => i.id).filter((i) => /^(vacancy-rising|rent-drop|opex-spike)-/.test(i)).sort();
    expect(ids).toEqual([
      'opex-spike-p1-2026-12', 'opex-spike-zz9-2026-12',
      'rent-drop-p1-2026-12', 'rent-drop-zz9-2026-12',
      'vacancy-rising-p1-2026-12', 'vacancy-rising-zz9-2026-12',
    ]);
    expect(out.find((i) => i.id === 'vacancy-rising-zz9-2026-12')!.title).toBe('Vacancy rising — zz9');
  });
});
