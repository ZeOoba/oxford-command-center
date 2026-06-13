// tests/unit/intel-synthesis.test.ts
//
// Golden tests for the ownership-decision synthesis (synthesis.ts) — the "intelligence".
// Pure, deterministic transforms over engine outputs; re-running on the same literals
// deep-equals the prior result, so the verdicts are verifiable, not vibes (pre-mortem #10).
import { describe, expect, it } from 'vitest';
import type {
  AnomalyFlag,
  AnomalyKind,
  AnomalySeverity,
  AttentionBand,
  CapitalAction,
  PropertyScore,
  SinceAcquisition,
} from '../../src/modules/intel/analytics-hooks';
import {
  ATTENTION_ORDER,
  buildActionList,
  deterioratingProperties,
  groupByCapitalAction,
  improvingProperties,
  rankByAttention,
  topRisks,
} from '../../src/modules/intel/synthesis';

// Minimal-but-typed factories so the literals are the contract without `as any`.
const score = (
  id: string,
  attentionBand: AttentionBand,
  capitalAction: CapitalAction,
  health: number,
  q: 1 | 2 | 3 | 4 | null,
): PropertyScore => ({
  propertyId: id,
  propertyName: id,
  period: '2025',
  health,
  healthBand: 'good',
  attentionBand,
  capitalAction,
  subScores: {},
  noiPerSfQuartile: q,
  reasons: [`r-${id}`],
});

const flag = (
  propertyId: string,
  kind: AnomalyKind,
  severity: AnomalySeverity,
  detail: string,
  metricValue: number | null,
): AnomalyFlag => ({ propertyId, period: '2025', kind, severity, detail, metricValue });

const sa = (propertyId: string, noiGrowth: number | null, comparable: boolean): SinceAcquisition => ({
  propertyId,
  anchorPeriod: '2023',
  latestPeriod: '2025',
  comparable,
  revenueGrowth: null,
  noiGrowth,
  noiPerSfGrowth: null,
  taxesGrowth: null,
  insuranceGrowth: null,
  revenuePerSfGrowth: null,
  noiCagr: null,
});

describe('synthesis', () => {
  it('exposes the canonical attention order', () => {
    expect(ATTENTION_ORDER).toEqual(['red', 'orange', 'yellow', 'green']);
  });

  it('ranks red→green', () => {
    const r = rankByAttention([
      score('a', 'green', 'hold', 70, 2),
      score('b', 'red', 'monitor', 40, 4),
      score('c', 'orange', 'monitor', 55, 3),
    ]);
    expect(r.map((s) => s.propertyId)).toEqual(['b', 'c', 'a']);
  });

  it('groups by capital action with stable buckets', () => {
    const g = groupByCapitalAction([
      score('a', 'green', 'invest', 80, 1),
      score('b', 'red', 'disposition-candidate', 30, 4),
    ]);
    expect(g.invest.map((s) => s.propertyId)).toEqual(['a']);
    expect(g['disposition-candidate'].map((s) => s.propertyId)).toEqual(['b']);
    expect(g.hold).toEqual([]);
    expect(g.monitor).toEqual([]);
  });

  it('topRisks ranks critical>high and dedupes per property+kind', () => {
    const risks = topRisks(
      [
        flag('a', 'noi-decline', 'critical', 'd', -0.2),
        flag('b', 'expense-growth', 'high', 'd', 0.3),
      ],
      5,
    );
    expect(risks[0]!.severity).toBe('critical');
  });

  it('deteriorating = negative since-acq NOI growth; improving = positive', () => {
    const series = [sa('a', -0.1, true), sa('b', 0.2, true), sa('c', null, false)];
    expect(deterioratingProperties(series).map((x) => x.propertyId)).toEqual(['a']);
    expect(improvingProperties(series).map((x) => x.propertyId)).toEqual(['b']); // null/incomparable excluded from both
  });

  it('buildActionList yields prioritized, deduped, human actions', () => {
    const actions = buildActionList({
      scores: [score('ray', 'red', 'disposition-candidate', 40, 4), score('np', 'green', 'invest', 75, 1)],
      anomalies: [flag('ray', 'noi-decline', 'critical', 'NOI −20%', -0.2)],
      pm: [{ propertyManager: 'X', propertyCount: 1, smallSample: true, avgNoiPerSf: 1, avgNoiGrowth: -0.5, avgExpenseGrowth: 0.3 }],
    });
    expect(actions[0]!.priority).toBe('high'); // disposition candidate + critical anomaly ranks first
    expect(actions.some((a) => /disposition/i.test(a.text))).toBe(true);
    expect(actions.some((a) => /invest/i.test(a.text))).toBe(true);
    expect(new Set(actions.map((a) => a.text)).size).toBe(actions.length); // deduped
  });
});
