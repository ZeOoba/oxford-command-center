import { describe, expect, it } from 'vitest';
import { detectAnomalies } from '../../server/warehouse/anomalies';
import type { PeriodMetrics } from '../../server/warehouse/metrics';

// Build PeriodMetrics literals (pure, db-free). Only the fields the engine reads matter.
const mk = (
  period: string,
  opts: {
    revenue: number;
    opex: number;
    noiPerSf: number | null;
    categories: Record<string, number>;
    propertyId?: string;
    grainHint?: 'year' | 'ytd';
  },
): PeriodMetrics =>
  ({
    propertyId: opts.propertyId ?? 'p1',
    period,
    grainHint: opts.grainHint ?? null,
    revenue: opts.revenue,
    opex: opts.opex,
    noi: opts.revenue - opts.opex,
    noiPerSf: opts.noiPerSf,
    categories: opts.categories,
  }) as unknown as PeriodMetrics;

describe('anomalies', () => {
  it('flags expense spike + NOI decline with severity', () => {
    // 2024: opex 100k, NOI 100k, noiPerSf 5. 2025: opex 130k (+30%), NOI 92k (−8%), noiPerSf 4.6.
    const metrics: PeriodMetrics[] = [
      mk('2024', { revenue: 200000, opex: 100000, noiPerSf: 5, categories: { Taxes: 40000, Insurance: 60000 } }),
      mk('2025', { revenue: 222000, opex: 130000, noiPerSf: 4.6, categories: { Taxes: 40000, Insurance: 90000 } }),
    ];
    const flags = detectAnomalies(metrics);
    const exp = flags.find((f) => f.kind === 'expense-growth' && f.period === '2025')!;
    expect(exp.severity).toBe('moderate'); // 30% is 2× the 15% threshold → moderate (≥1.5×, <2.5×)
    expect(flags.some((f) => f.kind === 'noi-decline' && f.period === '2025')).toBe(true);
    expect(flags.some((f) => f.kind === 'noi-per-sf-decline' && f.period === '2025')).toBe(true);
  });

  it('flags a new expense category appearing', () => {
    const metrics: PeriodMetrics[] = [
      mk('2024', { revenue: 200000, opex: 100000, noiPerSf: 5, categories: { Taxes: 100000 } }),
      mk('2025', { revenue: 200000, opex: 105000, noiPerSf: 5, categories: { Taxes: 100000, Utilities: 5000 } }),
    ];
    const flags = detectAnomalies(metrics);
    const nc = flags.find((f) => f.kind === 'new-category' && f.period === '2025')!;
    expect(nc).toBeDefined();
    expect(nc.detail).toContain('Utilities');
    expect(nc.subkey).toBe('Utilities'); // category is the sub-identity (refute F1)
  });

  it('tags category-driven flags with the category as subkey; property-level kinds carry subkey="" (refute F1)', () => {
    // Insurance +60% AND Taxes +50% both spike in one property+period; opex +56% also trips
    // expense-growth (a property-level kind). The two spikes must carry DISTINCT subkeys so their
    // downstream alert ids do not collide; the property-level flag must carry subkey=''.
    const metrics: PeriodMetrics[] = [
      mk('2024', { revenue: 200000, opex: 80000, noiPerSf: 6, categories: { Insurance: 50000, Taxes: 30000 } }),
      mk('2025', { revenue: 200000, opex: 125000, noiPerSf: 6, categories: { Insurance: 80000, Taxes: 45000 } }),
    ];
    const flags = detectAnomalies(metrics);
    const spikes = flags.filter((f) => f.kind === 'category-spike' && f.period === '2025');
    expect(new Set(spikes.map((f) => f.subkey))).toEqual(new Set(['Insurance', 'Taxes']));
    expect(spikes.every((f) => f.detail.includes(f.subkey))).toBe(true);
    const exp = flags.find((f) => f.kind === 'expense-growth' && f.period === '2025')!;
    expect(exp.subkey).toBe('');
  });

  it('flags revenue decline and a category spike, scales severity, groups by property', () => {
    const metrics: PeriodMetrics[] = [
      // p1: revenue drops 10% (m=2 → moderate), Insurance spikes 60% (m=2.4 → moderate)
      mk('2024', { revenue: 200000, opex: 80000, noiPerSf: 6, categories: { Insurance: 50000, Taxes: 30000 } }),
      mk('2025', { revenue: 180000, opex: 80000, noiPerSf: 5.7, categories: { Insurance: 80000, Taxes: 30000 } }),
      // p2: clean — no consecutive-period anomaly
      mk('2024', { revenue: 100000, opex: 40000, noiPerSf: 3, categories: { Taxes: 40000 }, propertyId: 'p2' }),
      mk('2025', { revenue: 100000, opex: 40000, noiPerSf: 3, categories: { Taxes: 40000 }, propertyId: 'p2' }),
    ];
    const flags = detectAnomalies(metrics);
    const rev = flags.find((f) => f.kind === 'revenue-decline' && f.propertyId === 'p1')!;
    expect(rev.severity).toBe('moderate');
    const spike = flags.find((f) => f.kind === 'category-spike' && f.propertyId === 'p1')!;
    expect(spike.detail).toContain('Insurance');
    // p2 produced no flags
    expect(flags.some((f) => f.propertyId === 'p2')).toBe(false);
  });

  it('suppresses ALL flags across a full-year → YTD boundary (grain mismatch, spec §9)', () => {
    // 2025 full year vs 2026 YTD (~half a year): revenue/NOI roughly halve and a category
    // is "new" simply because the partial pull hasn't booked it. None of this is a signal.
    const metrics: PeriodMetrics[] = [
      mk('2025', { revenue: 200000, opex: 100000, noiPerSf: 5, categories: { Taxes: 100000 }, grainHint: 'year' }),
      mk('2026', {
        revenue: 100000, opex: 50000, noiPerSf: 2.5,
        categories: { Taxes: 50000, Utilities: 3000 }, grainHint: 'ytd',
      }),
    ];
    const flags = detectAnomalies(metrics);
    // Zero flags for the 2026 transition — no decline, no expense-growth, no spike, no new-category.
    expect(flags.filter((f) => f.period === '2026')).toHaveLength(0);
  });

  it('still flags within same-grain pairs even when a trailing YTD period exists', () => {
    // 2024→2025 (both 'year') has a real NOI decline; the trailing 2026 YTD must not erase it.
    const metrics: PeriodMetrics[] = [
      mk('2024', { revenue: 200000, opex: 80000, noiPerSf: 6, categories: { Taxes: 30000 }, grainHint: 'year' }),
      mk('2025', { revenue: 150000, opex: 90000, noiPerSf: 4, categories: { Taxes: 30000 }, grainHint: 'year' }),
      mk('2026', { revenue: 75000, opex: 45000, noiPerSf: 2, categories: { Taxes: 15000 }, grainHint: 'ytd' }),
    ];
    const flags = detectAnomalies(metrics);
    expect(flags.some((f) => f.kind === 'noi-decline' && f.period === '2025')).toBe(true);
    expect(flags.filter((f) => f.period === '2026')).toHaveLength(0);
  });

  it('does not flag a clean improving series and uses critical severity for extreme expense growth', () => {
    const metrics: PeriodMetrics[] = [
      mk('2023', { revenue: 200000, opex: 100000, noiPerSf: 5, categories: { Taxes: 100000 } }),
      mk('2024', { revenue: 220000, opex: 95000, noiPerSf: 6, categories: { Taxes: 95000 } }),
      // 2025: opex doubles (+100% = 6.7× the 15% threshold → critical)
      mk('2025', { revenue: 240000, opex: 190000, noiPerSf: 2, categories: { Taxes: 190000 } }),
    ];
    const flags = detectAnomalies(metrics);
    // no flags between 2023 and 2024 (improving)
    expect(flags.some((f) => f.period === '2024')).toBe(false);
    const exp = flags.find((f) => f.kind === 'expense-growth' && f.period === '2025')!;
    expect(exp.severity).toBe('critical');
  });
});
