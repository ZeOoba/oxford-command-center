import { describe, it, expect } from 'vitest';
import { isDeadLease } from '../../server/ar/lease-liveness';

// The shared "is this lease a live fresh-match candidate?" predicate for the AR feed (2026-09-14
// weekly financial-code sweep). Before it existed, loadLeasesFromSnapshot and resolveByUnit each
// carried their own `status !== 'Expired'` check -- which let an Active lease carrying $0 rent
// (a roster placeholder, not a billing tenant) and a 'Vacant' record both pass as live candidates
// and absorb an unattended auto-write. Real rows: Tenant 072 LLC (29000 Information Lane
// #202, Active, $0) and Example Gymnastics (2207 Northwood A15, Active, $0, $1,824.01 AR).
describe('isDeadLease', () => {
  it('Expired -> dead (the original 2026-08-24 rule, unchanged)', () => {
    expect(isDeadLease({ status: 'Expired', annualRent: 4788 })).toBe(true);
  });

  it('Vacant -> dead (a vacancy placeholder is never a billing tenant)', () => {
    expect(isDeadLease({ status: 'Vacant', annualRent: 0 })).toBe(true);
    expect(isDeadLease({ status: 'Vacant', annualRent: 12000 })).toBe(true);
  });

  it('Active with annualRent === 0 -> dead (Tenant 072 LLC / Example Gymnastics real cases)', () => {
    expect(isDeadLease({ status: 'Active', annualRent: 0 })).toBe(true);
  });

  it('Active / Expiring Soon / Unknown with positive rent -> live (unchanged behaviour)', () => {
    expect(isDeadLease({ status: 'Active', annualRent: 25500 })).toBe(false);
    expect(isDeadLease({ status: 'Expiring Soon', annualRent: 13992 })).toBe(false);
    expect(isDeadLease({ status: 'Unknown', annualRent: 100 })).toBe(false);
  });

  it('an UNKNOWN rent (null / undefined) is NOT zero rent -- never widens the dead set on missing data', () => {
    // A loader that does not project annualRent (or a snapshot row missing it) must get the
    // pre-existing status-only behaviour, not have every lease silently declared dead.
    expect(isDeadLease({ status: 'Active', annualRent: null })).toBe(false);
    expect(isDeadLease({ status: 'Active' })).toBe(false);
    expect(isDeadLease({})).toBe(false);
  });

  it('a missing status with positive rent is live; a missing status with zero rent is dead', () => {
    expect(isDeadLease({ status: null, annualRent: 900 })).toBe(false);
    expect(isDeadLease({ status: undefined, annualRent: 0 })).toBe(true);
  });

  // annualRent is year-1 cash NET of abated months (parse.ts, 2026-10-06): a fully abated live lease
  // (Abated Months = 12) reads annualRent 0 while monthlyRent is still the contract rate.
  it('Active, annualRent 0 but monthlyRent > 0 (fully abated) -> LIVE, not a $0 placeholder', () => {
    expect(isDeadLease({ status: 'Active', annualRent: 0, monthlyRent: 5300 })).toBe(false);
  });

  it('Active, annualRent 0 and monthlyRent 0 / null / absent -> still dead (placeholder rows)', () => {
    expect(isDeadLease({ status: 'Active', annualRent: 0, monthlyRent: 0 })).toBe(true);
    expect(isDeadLease({ status: 'Active', annualRent: 0, monthlyRent: null })).toBe(true);
    expect(isDeadLease({ status: 'Active', annualRent: 0 })).toBe(true);
  });

  it('monthlyRent never revives an Expired / Vacant lease', () => {
    expect(isDeadLease({ status: 'Expired', annualRent: 0, monthlyRent: 5300 })).toBe(true);
    expect(isDeadLease({ status: 'Vacant', annualRent: 0, monthlyRent: 5300 })).toBe(true);
  });
});
