// tests/unit/debt-scorecard-hooks.test.ts
//
// Phase 2 Step 6 — Unit tests for the pure display helpers in src/modules/debt/hooks.ts.
//
// Tests:
//   signalTone  — each DebtSignal maps to the correct badge tone
//   signalLabel — each DebtSignal maps to the correct display label
//   bandTone    — each DebtScoreBand maps to the correct badge tone
//   bucketTone  — each MaturityLadderEntry bucket maps to the correct tone
//   groupByBucket — correctly partitions ladder entries into the four buckets
//   bucketBalance — sums currentBalance for a group of entries
//
// No React hooks, no DOM, no network — pure functions only.
import { describe, it, expect } from 'vitest';
import {
  signalTone,
  signalLabel,
  bandTone,
  bucketTone,
  groupByBucket,
  bucketBalance,
} from '../../src/modules/debt/hooks';
import type { DebtSignal, DebtScoreBand, MaturityLadderEntry } from '../../src/modules/debt/hooks';

// ── Fixture helpers ───────────────────────────────────────────────────────────────────────

function makeEntry(
  overrides: Partial<MaturityLadderEntry> & Pick<MaturityLadderEntry, 'bucket'>,
): MaturityLadderEntry {
  return {
    propertyId: 'prop-test',
    propertyName: 'Test Property',
    loanId: `loan-${Math.random()}`,
    loanName: 'Test Loan',
    currentBalance: 500_000,
    maturityDate: '2028-01-01',
    monthsToMaturity: 24,
    balloon: false,
    isDemand: false,
    signal: 'hold',
    ...overrides,
  };
}

// ── signalTone ────────────────────────────────────────────────────────────────────────────

describe('signalTone', () => {
  const cases: Array<[DebtSignal, string]> = [
    ['refi',           'blue'],
    ['cash-out',       'green'],
    ['hold',           'neutral'],
    ['governor-block', 'red'],
    ['no-debt',        'neutral'],
  ];

  it.each(cases)('%s → %s', (signal, expected) => {
    expect(signalTone(signal)).toBe(expected);
  });
});

// ── signalLabel ───────────────────────────────────────────────────────────────────────────

describe('signalLabel', () => {
  it('refi → "Refi"', () => expect(signalLabel('refi')).toBe('Refi'));
  it('cash-out → "Cash-Out"', () => expect(signalLabel('cash-out')).toBe('Cash-Out'));
  it('hold → "Hold"', () => expect(signalLabel('hold')).toBe('Hold'));
  it('governor-block → "Gov Block"', () => expect(signalLabel('governor-block')).toBe('Gov Block'));
  it('no-debt → "No Debt"', () => expect(signalLabel('no-debt')).toBe('No Debt'));
});

// ── bandTone ──────────────────────────────────────────────────────────────────────────────

describe('bandTone', () => {
  const cases: Array<[DebtScoreBand, string]> = [
    ['strong',   'green'],
    ['adequate', 'neutral'],
    ['watch',    'amber'],
    ['critical', 'red'],
  ];

  it.each(cases)('%s → %s', (band, expected) => {
    expect(bandTone(band)).toBe(expected);
  });
});

// ── bucketTone ────────────────────────────────────────────────────────────────────────────

describe('bucketTone', () => {
  it('0-12 → red (imminent)', () => expect(bucketTone('0-12')).toBe('red'));
  it('13-24 → amber (near-term)', () => expect(bucketTone('13-24')).toBe('amber'));
  it('25-36 → neutral (medium)', () => expect(bucketTone('25-36')).toBe('neutral'));
  it('37+ → green (long-dated)', () => expect(bucketTone('37+')).toBe('green'));
});

// ── groupByBucket ─────────────────────────────────────────────────────────────────────────

describe('groupByBucket', () => {
  it('returns all four buckets even when some are empty', () => {
    const result = groupByBucket([]);
    expect(result.has('0-12')).toBe(true);
    expect(result.has('13-24')).toBe(true);
    expect(result.has('25-36')).toBe(true);
    expect(result.has('37+')).toBe(true);
    expect(result.get('0-12')).toHaveLength(0);
    expect(result.get('37+')).toHaveLength(0);
  });

  it('assigns entries to the correct buckets', () => {
    const e1 = makeEntry({ bucket: '0-12', loanId: 'a' });
    const e2 = makeEntry({ bucket: '13-24', loanId: 'b' });
    const e3 = makeEntry({ bucket: '25-36', loanId: 'c' });
    const e4 = makeEntry({ bucket: '37+', loanId: 'd' });
    const e5 = makeEntry({ bucket: '0-12', loanId: 'e' });

    const result = groupByBucket([e1, e2, e3, e4, e5]);
    expect(result.get('0-12')).toHaveLength(2);
    expect(result.get('13-24')).toHaveLength(1);
    expect(result.get('25-36')).toHaveLength(1);
    expect(result.get('37+')).toHaveLength(1);
  });

  it('preserves insertion order within each bucket', () => {
    const e1 = makeEntry({ bucket: '0-12', loanId: 'first' });
    const e2 = makeEntry({ bucket: '0-12', loanId: 'second' });
    const e3 = makeEntry({ bucket: '0-12', loanId: 'third' });

    const result = groupByBucket([e1, e2, e3]);
    const bucket = result.get('0-12') ?? [];
    expect(bucket[0]?.loanId).toBe('first');
    expect(bucket[1]?.loanId).toBe('second');
    expect(bucket[2]?.loanId).toBe('third');
  });

  it('mixed ladder: all four buckets with varying counts', () => {
    const entries: MaturityLadderEntry[] = [
      makeEntry({ bucket: '0-12', loanId: 'a', currentBalance: 100_000 }),
      makeEntry({ bucket: '0-12', loanId: 'b', currentBalance: 200_000 }),
      makeEntry({ bucket: '37+',  loanId: 'c', currentBalance: 300_000 }),
    ];
    const result = groupByBucket(entries);
    expect(result.get('0-12')).toHaveLength(2);
    expect(result.get('13-24')).toHaveLength(0);
    expect(result.get('25-36')).toHaveLength(0);
    expect(result.get('37+')).toHaveLength(1);
  });
});

// ── bucketBalance ─────────────────────────────────────────────────────────────────────────

describe('bucketBalance', () => {
  it('returns 0 for an empty array', () => {
    expect(bucketBalance([])).toBe(0);
  });

  it('sums currentBalance for a single entry', () => {
    const e = makeEntry({ bucket: '0-12', currentBalance: 750_000 });
    expect(bucketBalance([e])).toBe(750_000);
  });

  it('sums currentBalance for multiple entries', () => {
    const entries: MaturityLadderEntry[] = [
      makeEntry({ bucket: '0-12', currentBalance: 100_000 }),
      makeEntry({ bucket: '0-12', currentBalance: 200_000 }),
      makeEntry({ bucket: '0-12', currentBalance: 50_000 }),
    ];
    expect(bucketBalance(entries)).toBe(350_000);
  });

  it('handles large balances without overflow (JS number precision)', () => {
    const entries: MaturityLadderEntry[] = [
      makeEntry({ bucket: '37+', currentBalance: 5_000_000 }),
      makeEntry({ bucket: '37+', currentBalance: 3_500_000 }),
    ];
    expect(bucketBalance(entries)).toBe(8_500_000);
  });
});
