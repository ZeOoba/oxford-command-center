import { describe, expect, it } from 'vitest';
import type { MonthPoint, RentBridgeStep } from '@analytics/portfolio-trends';
import { kpiAt, rentChangeBars, rentSeries, vacancySeries } from '@/modules/portfolio/trends-chart-data';

const pt = (month: string, inPlaceRent: number, vacancyPct: number): MonthPoint => ({
  month, isForecast: false, inPlaceRent, leasedSf: 0, totalSf: 100, vacantSf: vacancyPct * 100, vacancyPct, leaseCount: 1,
});

describe('trends chart data', () => {
  const pts = [pt('2025-09', 800, 0.1), pt('2026-08', 900, 0.05), pt('2026-09', 1000, 0.08)];
  it('maps to chart series', () => {
    expect(rentSeries(pts)[2]).toEqual({ date: '2026-09-01', value: 1000 });
    expect(vacancySeries(pts)[2]!.value).toBeCloseTo(8, 6);
  });
  it('maps bridge steps to net-change bars', () => {
    const s: RentBridgeStep = { month: '2026-11', isForecast: true, opening: 1000, escalations: 30, newLeases: 0, expirations: 0, closing: 1030 };
    expect(rentChangeBars([s])).toEqual([{ label: '2026-11', value: 30 }]);
  });
  it('computes KPI deltas as fractions / percentage points, null when the comparison month is absent', () => {
    const k = kpiAt(pts, '2026-09');
    expect(k.rent).toBe(1000);
    expect(k.rentMoM).toBeCloseTo(1000 / 900 - 1, 6);
    expect(k.rentYoY).toBeCloseTo(1000 / 800 - 1, 6);
    expect(k.vacancyMoMPts).toBeCloseTo(3, 6);
    expect(kpiAt([pt('2026-09', 1000, 0.08)], '2026-09').rentMoM).toBeNull();
  });
});
