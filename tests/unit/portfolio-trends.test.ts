import { describe, expect, it } from 'vitest';
import type { Lease, Property } from '@contracts/index';
import { addMonths, monthRange, leaseActive, leaseRent, buildPortfolioTrend, rentBridge } from '@analytics/portfolio-trends';

const lease = (o: Partial<Lease>): Lease =>
  ({
    id: 'l', propertyKey: 'P', propertyId: 'p1', tenantName: 't', unit: 'A', company: 'c',
    sf: 1000, monthlyRent: 1000, rentPerSf: 12, leaseStart: '2026-01-01', leaseEnd: '2026-12-31',
    escalationDate: null, escalationPct: null, status: 'Active', annualRent: 12000,
    monthsToExpiry: 6, flags: [], ...o,
  }) as Lease;

const prop = (o: Partial<Property>): Property => ({ id: 'p1', type: 'Flex', sf: 10000, ...o }) as Property;

describe('month math', () => {
  it('addMonths wraps years in both directions', () => {
    expect(addMonths('2026-11', 3)).toBe('2027-02');
    expect(addMonths('2026-01', -1)).toBe('2025-12');
  });
  it('monthRange is inclusive', () => {
    expect(monthRange('2026-11', '2027-01')).toEqual(['2026-11', '2026-12', '2027-01']);
  });
});

describe('leaseActive', () => {
  it('is active for every month touched by [start,end]', () => {
    const l = lease({ leaseStart: '2026-05-15', leaseEnd: '2026-08-31' });
    expect(leaseActive(l, '2026-04')).toBe(false);
    expect(leaseActive(l, '2026-05')).toBe(true);
    expect(leaseActive(l, '2026-08')).toBe(true);
    expect(leaseActive(l, '2026-09')).toBe(false);
  });
  it('treats a null end as ongoing and a null start as inactive', () => {
    expect(leaseActive(lease({ leaseEnd: null }), '2035-01')).toBe(true);
    expect(leaseActive(lease({ leaseStart: null }), '2026-06')).toBe(false);
  });
  it('treats an undefined end as ongoing', () => {
    expect(leaseActive(lease({ leaseEnd: undefined as unknown as null }), '2035-01')).toBe(true);
  });
});

describe('leaseRent', () => {
  const l = lease({ monthlyRent: 1000, escalationDate: '2026-11-01', escalationPct: 0.03 });
  it('is flat through asOf and until the next escalation', () => {
    expect(leaseRent(l, '2026-10', '2026-10')).toBe(1000);
    expect(leaseRent(l, '2026-10', '2026-09')).toBe(1000);
  });
  it('steps up at the escalation month and compounds annually', () => {
    expect(leaseRent(l, '2026-11', '2026-10')).toBeCloseTo(1030, 6);
    expect(leaseRent(l, '2027-10', '2026-10')).toBeCloseTo(1030, 6);
    expect(leaseRent(l, '2027-11', '2026-10')).toBeCloseTo(1060.9, 6);
  });
  it('rolls a stale (already-passed) escalation date forward without applying it', () => {
    const stale = lease({ monthlyRent: 1000, escalationDate: '2026-05-01', escalationPct: 0.03 });
    expect(leaseRent(stale, '2026-12', '2026-10')).toBe(1000);
    expect(leaseRent(stale, '2027-05', '2026-10')).toBeCloseTo(1030, 6);
  });
  it('ignores a null/zero escalation pct', () => {
    expect(leaseRent(lease({ escalationDate: '2026-11-01', escalationPct: null }), '2027-06', '2026-10')).toBe(1000);
  });
});

describe('buildPortfolioTrend', () => {
  const A = lease({ id: 'A', sf: 6000, monthlyRent: 1000, leaseStart: '2026-01-01', leaseEnd: '2026-12-31' });
  const B = lease({ id: 'B', sf: 2000, monthlyRent: 500, leaseStart: '2026-06-01', leaseEnd: '2027-12-31' });
  const opts = { asOf: '2026-09-30', monthsBack: 6, monthsForward: 6 };
  const t = buildPortfolioTrend([A, B], [prop({})], opts);
  const at = (m: string) => t.portfolio.find((p) => p.month === m)!;

  it('spans asOf-monthsBack .. asOf+monthsForward and flags forecast months', () => {
    expect(t.months[0]).toBe('2026-03');
    expect(t.months.at(-1)).toBe('2027-03');
    expect(at('2026-09').isForecast).toBe(false);
    expect(at('2026-10').isForecast).toBe(true);
  });
  it('computes leased/vacant SF, vacancy and rent per month', () => {
    expect(at('2026-03')).toMatchObject({ leasedSf: 6000, vacantSf: 4000, vacancyPct: 0.4, inPlaceRent: 1000, leaseCount: 1 });
    expect(at('2026-06')).toMatchObject({ leasedSf: 8000, vacantSf: 2000, vacancyPct: 0.2, inPlaceRent: 1500, leaseCount: 2 });
    expect(at('2027-01')).toMatchObject({ leasedSf: 2000, vacantSf: 8000, vacancyPct: 0.8, inPlaceRent: 500 });
  });
  it('exposes the same series per property', () => {
    expect(t.byProperty['p1']!.map((p) => p.vacancyPct)).toEqual(t.portfolio.map((p) => p.vacancyPct));
  });
  it('excludes residences and leases with a null or unknown propertyId', () => {
    const res = buildPortfolioTrend(
      [A, lease({ id: 'X', propertyId: null }), lease({ id: 'Y', propertyId: 'ghost' }), lease({ id: 'R', propertyId: 'home' })],
      [prop({}), prop({ id: 'home', type: 'Residence', sf: 5000 })],
      opts,
    );
    expect(Object.keys(res.byProperty)).toEqual(['p1']);
    expect(res.portfolio.find((p) => p.month === '2026-03')).toMatchObject({ totalSf: 10000, leaseCount: 1 });
  });
  it('excludes Vacant placeholder rows from every count', () => {
    const v = lease({ id: 'V', status: 'Vacant', sf: 3000, monthlyRent: 700 });
    const r = buildPortfolioTrend([A, v], [prop({})], opts);
    expect(r.portfolio.find((p) => p.month === '2026-03')).toMatchObject({ leasedSf: 6000, inPlaceRent: 1000, leaseCount: 1 });
  });
  it('pins vacancy to the lease-SF basis, independent of workbook occPct', () => {
    // occPct says 50% occupied; active leases cover 6000 of 10000 SF -> 40% vacant.
    const r = buildPortfolioTrend([A], [prop({ occPct: 0.5 })], opts);
    const cur = r.portfolio.find((p) => p.month === '2026-09')!;
    expect(cur.vacancyPct).toBeCloseTo((10000 - 6000) / 10000, 9);
    expect(r.byProperty['p1']!.find((p) => p.month === '2026-09')!.vacancyPct).toBeCloseTo(0.4, 9);
  });
  it('never divides by zero for a property with no SF', () => {
    const z = buildPortfolioTrend([], [prop({ sf: 0 })], opts);
    expect(z.portfolio.every((p) => p.vacancyPct === 0)).toBe(true);
  });
});

describe('rentBridge', () => {
  it('books new leases and expirations and closes to the series', () => {
    const A = lease({ id: 'A', monthlyRent: 1000, leaseStart: '2026-01-01', leaseEnd: '2026-12-31' });
    const B = lease({ id: 'B', monthlyRent: 500, leaseStart: '2026-06-01', leaseEnd: '2027-12-31' });
    const t = buildPortfolioTrend([A, B], [prop({})], { asOf: '2026-09-30', monthsBack: 6, monthsForward: 6 });
    const step = (m: string) => t.bridge.find((s) => s.month === m)!;
    expect(step('2026-06')).toMatchObject({ opening: 1000, newLeases: 500, expirations: 0, escalations: 0, closing: 1500 });
    expect(step('2027-01')).toMatchObject({ opening: 1500, newLeases: 0, expirations: -1000, closing: 500 });
    for (const s of t.bridge) {
      expect(s.closing).toBeCloseTo(s.opening + s.escalations + s.newLeases + s.expirations, 6);
      expect(s.closing).toBeCloseTo(t.portfolio.find((p) => p.month === s.month)!.inPlaceRent, 6);
    }
  });
  it('books a scheduled escalation as an increase', () => {
    const E = lease({ monthlyRent: 1000, leaseStart: '2025-01-01', leaseEnd: '2028-12-31', escalationDate: '2026-11-01', escalationPct: 0.03 });
    const steps = rentBridge([E], ['2026-10', '2026-11'], '2026-09');
    expect(steps).toHaveLength(1);
    expect(steps[0]!.escalations).toBeCloseTo(30, 6);
    expect(steps[0]!.closing).toBeCloseTo(1030, 6);
  });
});
