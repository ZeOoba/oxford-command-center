import { describe, it, expect } from 'vitest';
import { isoOrNull, inferMarket, inferType, statusFromSymbol, isTaskBannerRow } from '../../server/workbook/parse';
import type { DataQualityFlag } from '@contracts/index';

describe('isoOrNull — date guard (the bug that crashed extraction)', () => {
  it('passes a valid Date through as ISO', () => {
    const flags: DataQualityFlag[] = [];
    expect(isoOrNull(new Date(Date.UTC(2026, 5, 1)), flags, 'x', 'd')).toBe('2026-06-01');
    expect(flags).toHaveLength(0);
  });
  it('quarantines an implausible year and flags it (the 2341/1902 garbage)', () => {
    const flags: DataQualityFlag[] = [];
    expect(isoOrNull(new Date(Date.UTC(2341, 8, 25)), flags, 'loan', 'maturity')).toBeNull();
    expect(flags[0]?.field).toBe('maturity');
    expect(flags[0]?.issue).toMatch(/implausible/);
  });
  it('returns null for an Invalid Date object (NaN time) without throwing', () => {
    const flags: DataQualityFlag[] = [];
    expect(isoOrNull(new Date('not-a-date'), flags, 'x', 'd')).toBeNull();
  });
  it('returns null for empty / non-date input', () => {
    const flags: DataQualityFlag[] = [];
    expect(isoOrNull(null, flags, 'x', 'd')).toBeNull();
    expect(isoOrNull('', flags, 'x', 'd')).toBeNull();
  });
});

describe('inferMarket', () => {
  it('maps real addresses to markets', () => {
    expect(inferMarket('29000 Information Lane, Easton MD')).toBe('Mid-Atlantic');
    expect(inferMarket('3540 E. 5th Ave, Columbus OH')).toBe('Columbus OH');
    expect(inferMarket('9620 E State Route 350, Raytown MO')).toBe('Kansas City MO');
    expect(inferMarket('5333 Secor Rd, Toledo OH')).toBe('Toledo OH');
    expect(inferMarket('2146 Enterprise, Twinsburg OH')).toBe('Cleveland MSA');
  });
});

describe('inferType', () => {
  it('normalizes property types', () => {
    expect(inferType('Flex')).toBe('Flex');
    expect(inferType('Retail')).toBe('Retail');
    expect(inferType('Residence')).toBe('Residence');
    expect(inferType('weird')).toBe('Other');
    expect(inferType(null)).toBe('Other');
  });
});

describe('statusFromSymbol — Monthly Checklist symbols', () => {
  it('maps each symbol', () => {
    expect(statusFromSymbol('✅')).toBe('done');
    expect(statusFromSymbol('⚠')).toBe('overdue');
    expect(statusFromSymbol('R')).toBe('renewal');
    expect(statusFromSymbol('☐')).toBe('pending');
    expect(statusFromSymbol('—')).toBe('na');
    expect(statusFromSymbol('')).toBe('unknown');
  });
});

describe('isTaskBannerRow — reject Monthly Checklist banner rows (Defect 9 regression)', () => {
  const ALERT = '⚠ BALLOON ALERT: Restoration Church Trust — $980,773 balloon due February 2027 (8 months) — Prepare refinance or payoff strategy';
  it('rejects the smeared balloon-alert banner', () => {
    // The real failure mode: the alert text bled across label, section AND type.
    expect(isTaskBannerRow(ALERT, ALERT, ALERT)).toBe(true);
  });
  it('rejects an ALL-CAPS summary banner', () => {
    const s = 'MONTHLY CASH FLOW SUMMARY  (Average per month, USD)';
    expect(isTaskBannerRow(s, s, s)).toBe(true);
  });
  it('rejects any row whose label leads with an alert/status glyph', () => {
    expect(isTaskBannerRow('⚠ something', 'Debt', 'Loan')).toBe(true);
  });
  it('keeps a genuine task row', () => {
    expect(isTaskBannerRow('3540 E. 5th Ave — escrow review', 'Property Ops', 'Recurring')).toBe(false);
  });
});
