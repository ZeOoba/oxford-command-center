// tests/unit/calibration-format.test.ts
// Pure display helpers for the calibration panel. The load-bearing property: EVERY formatter is
// null/NaN/empty safe, because the panel's NORMAL state (until outcomes accrue) is empty data —
// null rates, 0-of-0 scoreable counts, missing Wilson bounds. None may render NaN or crash.
import { describe, expect, it } from 'vitest';
import {
  fmtRate, fmtInterval, fmtSigned, fmtHit, hitTone, kindTone, reportIsEmpty, verdictLabel,
} from '../../src/modules/calibration/format';
import type { CalibrationLogRow, CalibrationReportResponse } from '../../src/contracts/warehouse';

describe('fmtRate — null/NaN safe (the empty-data path)', () => {
  it('null → em-dash, never NaN or 0%', () => {
    expect(fmtRate(null)).toBe('—');
    expect(fmtRate(undefined)).toBe('—');
    expect(fmtRate(Number.NaN)).toBe('—');
  });
  it('a real rate renders as a rounded percent', () => {
    expect(fmtRate(0.5)).toBe('50%');
    expect(fmtRate(0)).toBe('0%'); // a genuine 0 (0 hits of N scoreable) is NOT the same as null
    expect(fmtRate(1)).toBe('100%');
  });
});

describe('fmtInterval / fmtSigned / fmtHit', () => {
  it('a missing Wilson bound → em-dash', () => {
    expect(fmtInterval(null, null)).toBe('—');
    expect(fmtInterval(0.2, null)).toBe('—');
    expect(fmtInterval(0.2, 0.8)).toBe('20–80%');
  });
  it('fmtSigned: null safe; positive gets a +', () => {
    expect(fmtSigned(null)).toBe('—');
    expect(fmtSigned(Number.NaN)).toBe('—');
    expect(fmtSigned(0.03)).toBe('+0.03');
    expect(fmtSigned(-0.04)).toBe('-0.04');
  });
  it('fmtHit maps 1/0/null', () => {
    expect(fmtHit(1)).toBe('hit');
    expect(fmtHit(0)).toBe('miss');
    expect(fmtHit(null)).toBe('—');
  });
});

describe('reportIsEmpty — the panel empty-state gate', () => {
  it('undefined / zero-scoreable → empty', () => {
    expect(reportIsEmpty(undefined)).toBe(true);
    expect(reportIsEmpty({ scoreableVerdicts: 0 } as CalibrationReportResponse)).toBe(true);
    expect(reportIsEmpty({ scoreableVerdicts: 3 } as CalibrationReportResponse)).toBe(false);
  });
});

describe('tones + label', () => {
  it('hitTone / kindTone return stable badge tones', () => {
    expect(hitTone(1, true)).toBe('green');
    expect(hitTone(0, true)).toBe('red');
    expect(hitTone(null, false)).toBe('neutral');
    expect(kindTone('anomaly')).toBe('red');
    expect(kindTone('refi-score')).toBe('neutral');
  });
  it('verdictLabel composes subject/kind/band/period', () => {
    const row = {
      subjectId: '1100-rarig', verdictKind: 'capital-action', verdictSubkind: '',
      predictedBand: 'disposition-candidate', asOfPeriod: '2024',
    } as CalibrationLogRow;
    expect(verdictLabel(row)).toBe('1100-rarig · capital-action → disposition-candidate @ 2024');
  });
});
