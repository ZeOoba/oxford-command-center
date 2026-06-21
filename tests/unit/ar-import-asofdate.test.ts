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
});
