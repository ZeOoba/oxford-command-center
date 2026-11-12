// tests/unit/leasing-unbucketed.test.ts
//
// Pure display helpers behind the Leasing page's "not in a bucket" footnote, the month-to-month rent-roll
// label and the market-rent suggestions. The four rollover cards only cover 0-6m..24m+; the forecast's
// 'expired' and 'unknown' buckets were silently absent, so the cards summed to 135 of 140 leases.
import { describe, it, expect } from 'vitest';
import {
  summarizeUnbucketed,
  unbucketedFootnote,
  isMonthToMonth,
  suggestMarketRents,
} from '../../src/modules/leasing/hooks';
import type { MarketRentGap, RenewalSignal } from '../../src/contracts/lease-forecast';

const sig = (over: Partial<RenewalSignal> & Pick<RenewalSignal, 'leaseId' | 'expiryBucket'>): RenewalSignal =>
  ({
    tenantName: over.leaseId,
    propertyId: 'p',
    propertyKey: 'P',
    annualRent: 0,
    sf: 0,
    leaseEnd: null,
    monthsToExpiry: null,
    tenureMonths: null,
    renewalStage: null,
    arrearsUsd: 0,
    monthToMonth: false,
    likelihood: 'uncertain',
    rationale: '',
    ...over,
  }) as RenewalSignal;

describe('summarizeUnbucketed', () => {
  it('splits past-end leases into month-to-month vs expired, and counts no-end-date leases', () => {
    const s = summarizeUnbucketed([
      sig({ leaseId: 'a', expiryBucket: 'expired', monthToMonth: true, annualRent: 7_215.4 }),
      sig({ leaseId: 'b', expiryBucket: 'expired', monthToMonth: true, annualRent: 3_960 }),
      sig({ leaseId: 'c', expiryBucket: 'expired', monthToMonth: false, annualRent: 0 }),
      sig({ leaseId: 'd', expiryBucket: 'unknown', annualRent: 600 }),
      sig({ leaseId: 'e', expiryBucket: '0-6m', annualRent: 99_000 }),
    ]);
    expect(s.total).toBe(4);
    expect(s.mtm).toEqual({ count: 2, rent: 7_215.4 + 3_960 });
    expect(s.expired).toEqual({ count: 1, rent: 0 });
    expect(s.noEnd).toEqual({ count: 1, rent: 600 });
  });

  it('is empty when every lease sits in a bucket', () => {
    const s = summarizeUnbucketed([sig({ leaseId: 'e', expiryBucket: '24m+', annualRent: 1 })]);
    expect(s.total).toBe(0);
    expect(unbucketedFootnote(s)).toBeNull();
  });
});

describe('unbucketedFootnote', () => {
  it('names each non-empty group with its rent, omitting empty groups', () => {
    const text = unbucketedFootnote({
      total: 5,
      mtm: { count: 2, rent: 11_872.4 },
      expired: { count: 2, rent: 0 },
      noEnd: { count: 1, rent: 600 },
    });
    expect(text).toBe(
      '5 leases not in a bucket: 2 month-to-month past end date ($12K/yr), 2 expired ($0/yr), 1 with no end date ($600/yr).',
    );
    expect(
      unbucketedFootnote({ total: 1, mtm: { count: 1, rent: 5_000 }, expired: { count: 0, rent: 0 }, noEnd: { count: 0, rent: 0 } }),
    ).toBe('1 lease not in a bucket: 1 month-to-month past end date ($5K/yr).');
  });
});

describe('isMonthToMonth', () => {
  const asOf = '2026-10-27';
  it('is true for a non-Expired lease whose end date has passed', () => {
    expect(isMonthToMonth({ status: 'Active', leaseEnd: '2024-09-01' }, asOf)).toBe(true);
  });
  it('is false for an Expired-status lease, a future lease, today, or no end date', () => {
    expect(isMonthToMonth({ status: 'Expired', leaseEnd: '2026-06-30' }, asOf)).toBe(false);
    expect(isMonthToMonth({ status: 'Active', leaseEnd: '2027-01-01' }, asOf)).toBe(false);
    expect(isMonthToMonth({ status: 'Active', leaseEnd: '2026-10-27' }, asOf)).toBe(false);
    expect(isMonthToMonth({ status: 'Active', leaseEnd: null }, asOf)).toBe(false);
    expect(isMonthToMonth({ status: 'Active', leaseEnd: '2024-09-01' }, '')).toBe(false);
  });
});

describe('suggestMarketRents', () => {
  const gap = (over: Partial<MarketRentGap>): MarketRentGap => ({
    leaseId: 'l',
    tenantName: 't',
    propertyKey: '1100 Rarig',
    currentRentPsf: 8,
    marketRentPsf: 9.5,
    gapPsf: 1.5,
    gapAnnualUsd: 1_500,
    underMarket: true,
    provenance: 'derived-asking',
    ...over,
  });

  it('suggests one entry per property from feed-derived asking rents only', () => {
    const out = suggestMarketRents(
      [
        gap({ leaseId: 'a' }),
        gap({ leaseId: 'b' }), // same property: deduped
        gap({ leaseId: 'c', propertyKey: 'Banwick', marketRentPsf: 7, provenance: 'real' }), // human-entered: not a suggestion
        gap({ leaseId: 'd', propertyKey: 'Zettler', marketRentPsf: null, provenance: 'absent' }),
      ],
      {},
    );
    expect(out).toEqual([{ key: '1100 Rarig', psf: 9.5 }]);
  });

  it('skips properties that already have a confirmed market rent', () => {
    expect(suggestMarketRents([gap({})], { '1100 Rarig': 10 })).toEqual([]);
  });
});
