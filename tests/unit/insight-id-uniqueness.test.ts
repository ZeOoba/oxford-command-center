// tests/unit/insight-id-uniqueness.test.ts
//
// Invariant (refute F1 class): an Insight.id is the read/snooze + React key, so two insights that
// share an id silently corrupt each other's state. The anomaly producer is the one that emits
// MULTIPLE same-kind flags per property+period (one category-spike per spiking category), so it is
// the path most prone to id collision. This pins the full engine→bridge pipeline: even when several
// same-kind anomalies co-occur, every synthesized alert id is unique.
import { describe, it, expect } from 'vitest';
import { detectAnomalies } from '../../server/warehouse/anomalies';
import { anomaliesToInsights } from '../../src/brain/anomaly-insights';
import type { PeriodMetrics } from '../../server/warehouse/metrics';

const mk = (
  period: string,
  opts: { revenue: number; opex: number; noiPerSf: number | null; categories: Record<string, number>; propertyId?: string },
): PeriodMetrics =>
  ({
    propertyId: opts.propertyId ?? 'p1',
    period,
    grainHint: null,
    revenue: opts.revenue,
    opex: opts.opex,
    noi: opts.revenue - opts.opex,
    noiPerSf: opts.noiPerSf,
    categories: opts.categories,
  }) as unknown as PeriodMetrics;

describe('insight id uniqueness — anomaly pipeline (refute F1 class)', () => {
  it('produces all-unique ids even when two expense categories spike in one property+period', () => {
    const metrics: PeriodMetrics[] = [
      mk('2024', { revenue: 200000, opex: 80000, noiPerSf: 6, categories: { Insurance: 50000, Taxes: 30000 } }),
      // Insurance +80% and Taxes +67% both spike; opex +62% trips expense-growth; NOI 120k→70k declines.
      mk('2025', { revenue: 200000, opex: 130000, noiPerSf: 6, categories: { Insurance: 90000, Taxes: 50000 } }),
    ];
    const flags = detectAnomalies(metrics);
    const spikes = flags.filter((f) => f.kind === 'category-spike' && f.period === '2025');
    expect(spikes.length).toBeGreaterThanOrEqual(2); // the multiplicity that used to collide

    const insights = anomaliesToInsights(flags);
    const ids = insights.map((i) => i.id);
    expect(ids.length).toBeGreaterThan(1);
    expect(new Set(ids).size).toBe(ids.length); // no collisions across the whole emitted set

    // The two surviving category-spike insights are specifically distinct.
    const spikeIds = insights.filter((i) => i.id.includes('-category-spike-')).map((i) => i.id);
    expect(new Set(spikeIds).size).toBe(spikeIds.length);
    expect(spikeIds.length).toBeGreaterThanOrEqual(2);
  });
});
