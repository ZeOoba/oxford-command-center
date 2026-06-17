import { describe, it, expect } from 'vitest';
import type { AnomalyFlag } from '../../src/contracts/warehouse';
import { anomaliesToInsights } from '../../src/brain/anomaly-insights';

const flag = (o: Partial<AnomalyFlag>): AnomalyFlag => ({
  propertyId: '1100-rarig-ave-columbus-oh',
  period: '2025',
  kind: 'category-spike',
  severity: 'high',
  detail: 'Utilities spiked 42.0% (>20.0% threshold)',
  metricValue: 0.42,
  ...o,
});

describe('anomaliesToInsights — warehouse anomaly → alert Insight bridge', () => {
  it('maps anomaly severity to insight severity (critical→critical, high→warning, moderate→info)', () => {
    const out = anomaliesToInsights([
      flag({ severity: 'critical', kind: 'noi-decline' }),
      flag({ severity: 'high', kind: 'expense-growth' }),
      flag({ severity: 'moderate', kind: 'revenue-decline' }),
    ]);
    expect(out.map((i) => i.severity)).toEqual(['critical', 'warning', 'info']);
  });

  it('drops low-severity anomalies — they are noise in an actionable alert inbox', () => {
    const out = anomaliesToInsights([
      flag({ severity: 'low', kind: 'new-category' }),
      flag({ severity: 'high' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]!.severity).toBe('warning');
  });

  it('every emitted insight carries category=anomaly and links to its property', () => {
    const out = anomaliesToInsights([flag({})]);
    expect(out[0]!.category).toBe('anomaly');
    expect(out[0]!.entityType).toBe('property');
    expect(out[0]!.entityId).toBe('1100-rarig-ave-columbus-oh');
  });

  it('builds a stable, collision-free id from property+period+kind (dedup identity)', () => {
    const out = anomaliesToInsights([
      flag({ kind: 'expense-growth' }),
      flag({ kind: 'category-spike' }),
    ]);
    const ids = out.map((i) => i.id);
    expect(new Set(ids).size).toBe(2);
    expect(ids[0]).toBe('anomaly-1100-rarig-ave-columbus-oh-2025-expense-growth');
  });

  it('resolves a friendly property name when a nameById map is supplied', () => {
    const out = anomaliesToInsights(
      [flag({})],
      new Map([['1100-rarig-ave-columbus-oh', '1100 Rarig Ave']]),
    );
    expect(out[0]!.title).toContain('1100 Rarig Ave');
    expect(out[0]!.title).not.toContain('columbus-oh');
  });

  it('humanizes the slug into a readable title when no name map is supplied', () => {
    const out = anomaliesToInsights([flag({ propertyId: '9050-red-branch-rd-columbia-md' })]);
    expect(out[0]!.title).toContain('9050 Red Branch Rd Columbia Md');
  });

  it('carries the anomaly detail and period into the insight detail', () => {
    const out = anomaliesToInsights([flag({ detail: 'NOI declined -31.0% (past −20.0% threshold)', period: '2024' })]);
    expect(out[0]!.detail).toContain('NOI declined -31.0%');
    expect(out[0]!.detail).toContain('2024');
  });

  it('does not attach an email-draft action (anomalies are not counterparty correspondence)', () => {
    const out = anomaliesToInsights([flag({})]);
    expect(out[0]!.action).toBeUndefined();
  });

  it('returns [] for an empty input', () => {
    expect(anomaliesToInsights([])).toEqual([]);
  });

  it('uses kind-specific human labels in the title', () => {
    const kinds: AnomalyFlag['kind'][] = ['expense-growth', 'revenue-decline', 'noi-decline', 'noi-per-sf-decline', 'new-category', 'category-spike'];
    const out = anomaliesToInsights(kinds.map((kind) => flag({ kind, severity: 'high' })));
    // new-category is 'low' by construction in the engine, but if forced to high it still emits — assert each has a non-empty, kind-distinct label prefix
    const labels = out.map((i) => i.title.split(' — ')[0]);
    expect(new Set(labels).size).toBe(kinds.length);
    for (const l of labels) expect(l!.length).toBeGreaterThan(0);
  });
});
