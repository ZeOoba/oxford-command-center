import { describe, it, expect } from 'vitest';
import { extractAsOfDateFromFilename } from '../../server/ar/ar-aging';

describe('extractAsOfDateFromFilename', () => {
  it('extracts asOfDate from AR_Aging_YYYY-MM-DD.csv pattern', () => {
    const result = extractAsOfDateFromFilename('AR_Aging_2026-06-15.csv');
    expect(result).toEqual(new Date('2026-06-15'));
  });

  it('extracts asOfDate from a path with directory components', () => {
    const result = extractAsOfDateFromFilename('/exports/QB/AR_Aging_2026-01-31.csv');
    expect(result).toEqual(new Date('2026-01-31'));
  });

  it('returns null when filename has no date pattern', () => {
    const result = extractAsOfDateFromFilename('AR_Aging.csv');
    expect(result).toBeNull();
  });

  it('returns null for an arbitrary filename with no date', () => {
    const result = extractAsOfDateFromFilename('report.pdf');
    expect(result).toBeNull();
  });

  it('extracts asOfDate from filename with different prefix', () => {
    const result = extractAsOfDateFromFilename('ExportedAR_2025-12-31.csv');
    expect(result).toEqual(new Date('2025-12-31'));
  });

  it('returns null for impossible calendar dates (e.g. Feb 31)', () => {
    expect(extractAsOfDateFromFilename('AR_Aging_2026-02-31.csv')).toBeNull();
    expect(extractAsOfDateFromFilename('AR_Aging_2026-04-31.csv')).toBeNull();
  });

  // Real defect (found 2026-08-16 running Phase 0 Task 5's full dry run): every file in
  // Business/A.R. Reports/ — the actual PM delinquency exports this function exists to serve — uses
  // a dot-separated M.D.YYYY convention, not ISO. The function silently returned null for all of them,
  // which for the two xlsx formats with no in-file as-of date quarantines the ENTIRE file rather than
  // parsing it. This is additive: the existing ISO tests above are unchanged and still pass.
  describe('dot-separated M.D.YYYY convention (real PM delinquency exports)', () => {
    it('extracts asOfDate from the real Northwood filename', () => {
      const result = extractAsOfDateFromFilename('2203-2207 Northwood Delinquency 7.15.2026.xlsx');
      expect(result).toEqual(new Date('2026-07-15'));
    });

    it('extracts asOfDate from the real Info Lane filename, with a path prefix', () => {
      const result = extractAsOfDateFromFilename('/inbox/29000 Info Lane Delinquency 7.15.2026.xlsx');
      expect(result).toEqual(new Date('2026-07-15'));
    });

    it('handles a two-digit day', () => {
      expect(extractAsOfDateFromFilename('Delinquency 12.05.2026.xlsx')).toEqual(new Date('2026-12-05'));
    });

    it('handles a single-digit month and day', () => {
      expect(extractAsOfDateFromFilename('Delinquency 1.5.2026.xlsx')).toEqual(new Date('2026-01-05'));
    });

    it('returns null for an impossible calendar date in dot form', () => {
      expect(extractAsOfDateFromFilename('Delinquency 2.31.2026.xlsx')).toBeNull();
    });

    it('still prefers ISO when both conventions could theoretically appear', () => {
      const result = extractAsOfDateFromFilename('Delinquency 7.15.2026 2026-07-16.xlsx');
      expect(result).toEqual(new Date('2026-07-16'));
    });
  });
});
