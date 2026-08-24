// tests/unit/contracts-brain-report.test.ts
//
// TDD boundary tests for src/contracts/brain-report.ts (Phase 5 — Command Brain).
import { describe, expect, it } from 'vitest';
import {
  FeedbackDecision,
  FeedbackInput,
  AccuracyPoint,
  ConfidenceRow,
  OpenQuestion,
  VersionEvent,
  TrackRecordEntry,
  BrainReport,
} from '@contracts/brain-report';

// ── FeedbackDecision / FeedbackInput ──────────────────────────────────────────

describe('FeedbackDecision', () => {
  const valid = {
    id: 'fb-1',
    subjectKind: 'insight' as const,
    subjectId: 'cf-hurdle-drag::prop-westbelt-a',
    decision: 'accept' as const,
    decidedAt: '2026-07-06T12:00:00Z',
    note: null,
  };

  it('parses a valid feedback decision', () => {
    expect(FeedbackDecision.parse(valid).decision).toBe('accept');
  });

  it('accepts a null note', () => {
    expect(FeedbackDecision.parse(valid).note).toBeNull();
  });

  it('rejects an invalid subjectKind', () => {
    expect(() => FeedbackDecision.parse({ ...valid, subjectKind: 'briefing' })).toThrow();
  });

  it('rejects an invalid decision', () => {
    expect(() => FeedbackDecision.parse({ ...valid, decision: 'snooze' })).toThrow();
  });
});

describe('FeedbackInput', () => {
  it('parses a minimal valid input (note omitted)', () => {
    const result = FeedbackInput.parse({
      subjectKind: 'alert',
      subjectId: 'alert-42',
      decision: 'dismiss',
    });
    expect(result.subjectKind).toBe('alert');
  });

  it('parses with an explicit null note', () => {
    const result = FeedbackInput.parse({
      subjectKind: 'allocation',
      subjectId: 'prop-westbelt-a',
      decision: 'accept',
      note: null,
    });
    expect(result.note).toBeNull();
  });

  it('rejects a missing subjectId', () => {
    expect(() =>
      FeedbackInput.parse({ subjectKind: 'insight', decision: 'accept' }),
    ).toThrow();
  });
});

// ── AccuracyPoint ──────────────────────────────────────────────────────────

describe('AccuracyPoint', () => {
  it('parses a point with resolvedN >= 5 carrying a real hitRate', () => {
    const result = AccuracyPoint.parse({ month: '2026-06', resolvedN: 12, hitRate: 0.75 });
    expect(result.hitRate).toBeCloseTo(0.75);
  });

  it('parses a low-n month as a gap (hitRate: null) — honesty gate', () => {
    const result = AccuracyPoint.parse({ month: '2026-05', resolvedN: 2, hitRate: null });
    expect(result.hitRate).toBeNull();
    expect(result.resolvedN).toBe(2);
  });

  it('rejects a malformed month token', () => {
    expect(() => AccuracyPoint.parse({ month: '2026-13', resolvedN: 6, hitRate: 0.5 })).toThrow();
    expect(() => AccuracyPoint.parse({ month: '26-06', resolvedN: 6, hitRate: 0.5 })).toThrow();
  });

  it('rejects a negative resolvedN', () => {
    expect(() => AccuracyPoint.parse({ month: '2026-06', resolvedN: -1, hitRate: null })).toThrow();
  });
});

// ── ConfidenceRow ────────────────────────────────────────────────────────────

describe('ConfidenceRow', () => {
  const valid = {
    key: 'Columbus OH',
    label: 'Columbus OH',
    sampleN: 9,
    coverageConfidence: 0.6,
    basisNote: 'coverage-based, not predictive skill',
  };

  it('parses a valid confidence row', () => {
    expect(ConfidenceRow.parse(valid).coverageConfidence).toBeCloseTo(0.6);
  });

  it('rejects coverageConfidence above 1', () => {
    expect(() => ConfidenceRow.parse({ ...valid, coverageConfidence: 1.5 })).toThrow();
  });

  it('rejects coverageConfidence below 0', () => {
    expect(() => ConfidenceRow.parse({ ...valid, coverageConfidence: -0.1 })).toThrow();
  });

  it('rejects a negative sampleN', () => {
    expect(() => ConfidenceRow.parse({ ...valid, sampleN: -1 })).toThrow();
  });
});

// ── OpenQuestion / VersionEvent ────────────────────────────────────────────

describe('OpenQuestion', () => {
  it('parses a valid open question', () => {
    const result = OpenQuestion.parse({
      kind: 'dormant-generator',
      title: 'dr-regime-shift is dormant',
      detail: 'Only 3 qualifying samples observed; threshold is 10.',
      wouldClose: 'Ten resolved regime-shift verdicts.',
    });
    expect(result.kind).toBe('dormant-generator');
  });

  it('rejects an invalid kind', () => {
    expect(() =>
      OpenQuestion.parse({
        kind: 'stale-data',
        title: 't',
        detail: 'd',
        wouldClose: 'w',
      }),
    ).toThrow();
  });
});

describe('VersionEvent', () => {
  it('parses a valid version event', () => {
    const result = VersionEvent.parse({
      at: '2026-06-14T00:00:00Z',
      kind: 'config-change',
      detail: 'INTEL_CONFIG weights ratified (Option B, NOI-centric).',
    });
    expect(result.kind).toBe('config-change');
  });

  it('rejects an invalid kind', () => {
    expect(() =>
      VersionEvent.parse({ at: '2026-06-14T00:00:00Z', kind: 'schema-migration', detail: 'd' }),
    ).toThrow();
  });
});

// ── TrackRecordEntry ─────────────────────────────────────────────────────────

describe('TrackRecordEntry', () => {
  const valid = {
    verdictId: '42',
    kind: 'health-band',
    subject: '1100 Rarig Ave',
    predictedBand: 'good',
    realizedBand: 'good',
    outcome: 'hit' as const,
    resolvedAt: '2026-06-01',
    predictedValue: 78,
    realizedValue: 81,
  };

  it('parses a hit', () => {
    expect(TrackRecordEntry.parse(valid).outcome).toBe('hit');
  });

  it('parses a not-scoreable entry with null realized/resolved fields', () => {
    const result = TrackRecordEntry.parse({
      ...valid,
      outcome: 'not-scoreable',
      realizedBand: null,
      resolvedAt: null,
      realizedValue: null,
    });
    expect(result.outcome).toBe('not-scoreable');
    expect(result.realizedBand).toBeNull();
  });

  it("rejects an outcome of 'partial' (no such state in the schema)", () => {
    expect(() => TrackRecordEntry.parse({ ...valid, outcome: 'partial' })).toThrow();
  });
});

// ── BrainReport envelope ───────────────────────────────────────────────────────

describe('BrainReport', () => {
  const minimalValid = {
    asOf: '2026-07-06',
    dataAsOf: '2026-07-05T18:00:00.000Z',
    overallHitRate: 0.68,
    overallCi: { lo: 0.55, hi: 0.79 },
    resolvedTotal: 40,
    watchedSignals: 12,
    recalibrations: 2,
    accuracySeries: [],
    trackRecord: [],
    confidenceByMarket: [],
    confidenceByManager: [],
    openQuestions: [],
    versionLog: [],
    advisoryOnly: true as const,
  };

  it('round-trips a full report', () => {
    const result = BrainReport.parse(minimalValid);
    expect(result.resolvedTotal).toBe(40);
    expect(result.advisoryOnly).toBe(true);
  });

  it('renders empty-state (empty feedback/calibration tables) without error', () => {
    const result = BrainReport.parse({
      ...minimalValid,
      overallHitRate: null,
      overallCi: null,
      resolvedTotal: 0,
      watchedSignals: 0,
      recalibrations: 0,
    });
    expect(result.overallHitRate).toBeNull();
    expect(result.overallCi).toBeNull();
  });

  it('rejects a missing advisoryOnly flag', () => {
    const { advisoryOnly: _omit, ...noFlag } = minimalValid as Record<string, unknown>;
    expect(() => BrainReport.parse(noFlag)).toThrow();
  });

  it('rejects advisoryOnly: false', () => {
    expect(() => BrainReport.parse({ ...minimalValid, advisoryOnly: false })).toThrow();
  });

  it('accepts a null dataAsOf (a warehouse with no imports yet)', () => {
    const result = BrainReport.parse({ ...minimalValid, dataAsOf: null });
    expect(result.dataAsOf).toBeNull();
  });

  it('rejects a missing dataAsOf', () => {
    const { dataAsOf: _omit, ...noDataAsOf } = minimalValid as Record<string, unknown>;
    expect(() => BrainReport.parse(noDataAsOf)).toThrow();
  });
});
