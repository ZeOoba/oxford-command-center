// tests/unit/portfolio-table-trends.test.ts — roadmap 2.4 trend cells on the Portfolio property table.
import { describe, expect, it } from 'vitest';
import type { TrendsHistoryPoint } from '../../src/contracts/trends';
import { fmtPp, ledgerSparkFor, recordedOccDelta } from '../../src/modules/portfolio/table-trends';

const cubeOf = (months: string[], noi = 1000) =>
  Object.fromEntries(months.map((m, i) => [m, { noi: noi + i, revenue: 0, opex: 0, base_rent: 0 }]));
const run = (start: number, n: number, year = 2025) =>
  Array.from({ length: n }, (_, i) => {
    const k = start - 1 + i;
    return `${year + Math.floor(k / 12)}-${String((k % 12) + 1).padStart(2, '0')}`;
  });
const entries = { E1: { canonicalId: 'p1' }, E2: { canonicalId: null } };

describe('ledgerSparkFor', () => {
  it('takes the latest 12 consecutive ledger months and sums them', () => {
    const months = run(1, 15); // 2025-01 .. 2026-03
    const s = ledgerSparkFor({ E1: cubeOf(months) }, entries, 'p1')!;
    expect(s.entity).toBe('E1');
    expect(s.months.map((m) => m.month)).toEqual(months.slice(-12));
    expect(s.through).toBe('2026-03');
    expect(s.t12).toBe(s.months.reduce((a, m) => a + m.noi, 0));
  });

  it('returns null when the latest 12 months contain a gap (never bridged)', () => {
    const months = run(1, 14).filter((m) => m !== '2025-09');
    expect(ledgerSparkFor({ E1: cubeOf(months) }, entries, 'p1')).toBeNull();
  });

  it('returns null with fewer than 12 months, no mapped entity, or no dataset', () => {
    expect(ledgerSparkFor({ E1: cubeOf(run(1, 11)) }, entries, 'p1')).toBeNull();
    expect(ledgerSparkFor({ E1: cubeOf(run(1, 12)) }, entries, 'other')).toBeNull();
    expect(ledgerSparkFor(undefined, entries, 'p1')).toBeNull();
    expect(ledgerSparkFor({ E1: cubeOf(run(1, 12)) }, undefined, 'p1')).toBeNull();
  });
});

const pt = (propertyId: string, month: string, leasedSf: number, totalSf = 1000): TrendsHistoryPoint => ({
  propertyId, month, capturedThrough: `${month}-28`, totalSf, leasedSf, inPlaceRent: 0, leaseCount: 1, occPct: null, frozen: true,
});

describe('recordedOccDelta', () => {
  it('compares the latest recorded month with the same month a year earlier when recorded', () => {
    const d = recordedOccDelta([pt('p1', '2025-09', 800), pt('p1', '2026-01', 850), pt('p1', '2026-09', 900)], 'p1')!;
    expect(d).toMatchObject({ from: '2025-09', to: '2026-09', spanMonths: 12 });
    expect(d.deltaPp).toBeCloseTo(10);
  });

  it('falls back to the earliest recorded month inside the 12-month window and states the span', () => {
    const d = recordedOccDelta([pt('p1', '2024-01', 100), pt('p1', '2026-06', 950), pt('p1', '2026-09', 900)], 'p1')!;
    expect(d).toMatchObject({ from: '2026-06', to: '2026-09', spanMonths: 3 });
    expect(d.deltaPp).toBeCloseTo(-5);
  });

  it('is null with a single recorded month, only out-of-window priors, or another property', () => {
    expect(recordedOccDelta([pt('p1', '2026-09', 900)], 'p1')).toBeNull();
    expect(recordedOccDelta([pt('p1', '2024-01', 100), pt('p1', '2026-09', 900)], 'p1')).toBeNull();
    expect(recordedOccDelta([pt('p2', '2026-08', 1), pt('p2', '2026-09', 2)], 'p1')).toBeNull();
  });

  it('ignores rows with zero total SF (no occupancy to compare)', () => {
    expect(recordedOccDelta([pt('p1', '2026-08', 0, 0), pt('p1', '2026-09', 900)], 'p1')).toBeNull();
  });

  it('is order-independent', () => {
    const d = recordedOccDelta([pt('p1', '2026-09', 900), pt('p1', '2025-09', 800)], 'p1')!;
    expect(d.from).toBe('2025-09');
  });
});

describe('fmtPp', () => {
  it('signs, rounds to 0.1 and uses a true minus', () => {
    expect(fmtPp(2.14)).toBe('+2.1 pp');
    expect(fmtPp(-0.44)).toBe('−0.4 pp');
    expect(fmtPp(0.04)).toBe('0.0 pp');
  });
});
