import { describe, it, expect } from 'vitest';
import type { MonthPoint } from '../../src/analytics/portfolio-trends';
import type { TrendsHistoryPoint } from '../../src/contracts/trends';
import {
  recordedToMonthPoint,
  mergeRecorded,
  recordedYoY,
  type SourcedMonthPoint,
} from '../../src/modules/portfolio/trends-history';

const rec = (over: Partial<TrendsHistoryPoint> & Pick<TrendsHistoryPoint, 'propertyId' | 'month'>): TrendsHistoryPoint => ({
  capturedThrough: `${over.month}-28`,
  totalSf: 10000,
  leasedSf: 8000,
  inPlaceRent: 5000,
  leaseCount: 3,
  occPct: 0.8,
  frozen: false,
  ...over,
});

const recon = (month: string, isForecast = false): MonthPoint => ({
  month,
  isForecast,
  inPlaceRent: 1,
  leasedSf: 2,
  totalSf: 3,
  vacantSf: 1,
  vacancyPct: 1 / 3,
  leaseCount: 9,
});

describe('recordedToMonthPoint', () => {
  it('computes vacancy from totals', () => {
    const p = recordedToMonthPoint(rec({ propertyId: 'a', month: '2026-03', totalSf: 10000, leasedSf: 7500, inPlaceRent: 4200, leaseCount: 4 }));
    expect(p).toEqual({
      month: '2026-03', isForecast: false, inPlaceRent: 4200, leasedSf: 7500, totalSf: 10000,
      vacantSf: 2500, vacancyPct: 0.25, leaseCount: 4,
    });
  });
  it('zero SF yields 0 vacancy', () => {
    const p = recordedToMonthPoint(rec({ propertyId: 'a', month: '2026-03', totalSf: 0, leasedSf: 0 }));
    expect(p.vacantSf).toBe(0);
    expect(p.vacancyPct).toBe(0);
  });
  it('clamps leasedSf > totalSf to zero vacancy', () => {
    const p = recordedToMonthPoint(rec({ propertyId: 'a', month: '2026-03', totalSf: 1000, leasedSf: 1200 }));
    expect(p.vacantSf).toBe(0);
    expect(p.vacancyPct).toBe(0);
  });
});

describe('mergeRecorded', () => {
  const series = [recon('2026-01'), recon('2026-02'), recon('2026-03')];

  it('single-property: recorded month replaces reconstruction, others stay reconstructed', () => {
    const out = mergeRecorded(series, [rec({ propertyId: 'a', month: '2026-02', inPlaceRent: 777 })], {
      propertyIds: ['a', 'b'], propertyId: 'a',
    });
    expect(out.map((p) => p.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(out.map((p) => p.source)).toEqual(['reconstructed', 'recorded', 'reconstructed']);
    expect(out[1]!.inPlaceRent).toBe(777);
    expect(out[1]!.isForecast).toBe(false);
    expect(out[0]).toMatchObject({ inPlaceRent: 1, leaseCount: 9 });
  });

  it('single-property ignores other properties rows', () => {
    const out = mergeRecorded(series, [rec({ propertyId: 'b', month: '2026-02' })], { propertyIds: ['a', 'b'], propertyId: 'a' });
    expect(out.every((p) => p.source === 'reconstructed')).toBe(true);
  });

  it('portfolio: sums when every in-scope property has a row', () => {
    const out = mergeRecorded(
      series,
      [
        rec({ propertyId: 'a', month: '2026-02', totalSf: 10000, leasedSf: 8000, inPlaceRent: 5000, leaseCount: 3 }),
        rec({ propertyId: 'b', month: '2026-02', totalSf: 20000, leasedSf: 15000, inPlaceRent: 9000, leaseCount: 5 }),
      ],
      { propertyIds: ['a', 'b'] },
    );
    expect(out[1]).toEqual({
      month: '2026-02', isForecast: false, source: 'recorded',
      inPlaceRent: 14000, leasedSf: 23000, totalSf: 30000, vacantSf: 7000, vacancyPct: 7000 / 30000, leaseCount: 8,
    });
    expect(out[0]!.source).toBe('reconstructed');
  });

  it('portfolio: falls back to reconstruction when one property is missing (no partial sum)', () => {
    const out = mergeRecorded(series, [rec({ propertyId: 'a', month: '2026-02' })], { propertyIds: ['a', 'b'] });
    expect(out[1]!.source).toBe('reconstructed');
    expect(out[1]!.inPlaceRent).toBe(1);
  });

  it('portfolio: a row for a property outside scope is ignored', () => {
    const out = mergeRecorded(
      series,
      [
        rec({ propertyId: 'a', month: '2026-02', inPlaceRent: 100, totalSf: 1000, leasedSf: 500, leaseCount: 1 }),
        rec({ propertyId: 'x', month: '2026-02', inPlaceRent: 99999, totalSf: 99999, leasedSf: 99999, leaseCount: 99 }),
      ],
      { propertyIds: ['a'] },
    );
    expect(out[1]).toMatchObject({ source: 'recorded', inPlaceRent: 100, totalSf: 1000, leasedSf: 500, leaseCount: 1, vacantSf: 500, vacancyPct: 0.5 });
  });

  it('portfolio: excluded-only recorded rows do not replace anything', () => {
    const out = mergeRecorded(series, [rec({ propertyId: 'x', month: '2026-02' })], { propertyIds: ['a'] });
    expect(out.every((p) => p.source === 'reconstructed')).toBe(true);
  });

  it('forecast months are never replaced', () => {
    const s = [recon('2026-01'), recon('2026-02', true)];
    const out = mergeRecorded(s, [rec({ propertyId: 'a', month: '2026-02', inPlaceRent: 555 })], { propertyIds: ['a'], propertyId: 'a' });
    expect(out[1]).toMatchObject({ source: 'reconstructed', isForecast: true, inPlaceRent: 1 });
  });

  it('empty recorded returns the reconstruction, all reconstructed, order and length preserved', () => {
    const out = mergeRecorded(series, [], { propertyIds: ['a'] });
    expect(out).toHaveLength(3);
    expect(out.map((p) => p.month)).toEqual(['2026-01', '2026-02', '2026-03']);
    expect(out.every((p) => p.source === 'reconstructed')).toBe(true);
    expect(out[2]).toMatchObject(series[2]!);
  });
});

describe('recordedYoY', () => {
  const pt = (month: string, inPlaceRent: number, source: 'recorded' | 'reconstructed'): SourcedMonthPoint => ({
    ...recon(month), inPlaceRent, source,
  });

  it('computes cur/prev - 1 when both ends recorded', () => {
    const pts = [pt('2025-03', 1000, 'recorded'), pt('2026-03', 1100, 'recorded')];
    expect(recordedYoY(pts, '2026-03')).toBeCloseTo(0.1, 10);
  });
  it('null if either end is reconstructed', () => {
    expect(recordedYoY([pt('2025-03', 1000, 'reconstructed'), pt('2026-03', 1100, 'recorded')], '2026-03')).toBeNull();
    expect(recordedYoY([pt('2025-03', 1000, 'recorded'), pt('2026-03', 1100, 'reconstructed')], '2026-03')).toBeNull();
  });
  it('null if a month is absent', () => {
    expect(recordedYoY([pt('2026-03', 1100, 'recorded')], '2026-03')).toBeNull();
  });
  it('null for zero prior rent', () => {
    expect(recordedYoY([pt('2025-03', 0, 'recorded'), pt('2026-03', 1100, 'recorded')], '2026-03')).toBeNull();
  });
});
