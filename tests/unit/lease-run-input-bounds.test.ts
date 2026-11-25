// Review round 3 (2026-11-24; ranges approved by Gabriel in-turn): the lease-run assumption WRITE is
// bounded, a blank editor box is never saved as 0, and the stored shape keeps its original bounds so
// an earlier override always still loads.
import { describe, expect, it } from 'vitest';
import { LEASE_RUN_INPUT_BOUNDS, LeaseRunAssumptions, LeaseRunAssumptionsInput } from '../../src/contracts/lease-run';
import { checkAssumptionDraft } from '../../src/modules/intel/lease-run-draft';
import { DEFAULT_LEASE_RUN_ASSUMPTIONS } from '../../server/warehouse/lease-run';

describe('LeaseRunAssumptionsInput bounds', () => {
  it('the spec defaults sit inside every write range', () => {
    for (const [k, b] of Object.entries(LEASE_RUN_INPUT_BOUNDS)) {
      const v = DEFAULT_LEASE_RUN_ASSUMPTIONS[k as keyof typeof DEFAULT_LEASE_RUN_ASSUMPTIONS];
      expect(v, k).toBeGreaterThanOrEqual(b.min);
      expect(v, k).toBeLessThanOrEqual(b.max);
    }
  });

  it.each([
    ['renewalMarketGrowthPct', 0.16],
    ['renewalMarketGrowthPct', -0.11],
    ['indicativeCapRate', 0.01],
    ['indicativeCapRate', 0.21],
    ['roofStructuralReservePsf', 5.01],
    ['roofStructuralReservePsf', -0.01],
    ['managementFeePct', 1.01],
    ['vacancyCreditLossPct', -0.01],
    ['indicativeCapRate', Number.POSITIVE_INFINITY],
  ])('rejects %s = %s', (k, v) => {
    expect(LeaseRunAssumptionsInput.safeParse({ propertyId: 'p1', [k]: v }).success).toBe(false);
  });

  it.each([
    ['renewalMarketGrowthPct', -0.1],
    ['renewalMarketGrowthPct', 0.15],
    ['indicativeCapRate', 0.02],
    ['indicativeCapRate', 0.2],
    ['roofStructuralReservePsf', 0],
    ['roofStructuralReservePsf', 5],
    ['vacancyCreditLossPct', 0],
  ])('accepts %s = %s (inclusive edge)', (k, v) => {
    expect(LeaseRunAssumptionsInput.safeParse({ propertyId: 'p1', [k]: v }).success).toBe(true);
  });

  it('the stored shape is unchanged: an earlier out-of-range override still parses', () => {
    const stored = { ...DEFAULT_LEASE_RUN_ASSUMPTIONS, renewalMarketGrowthPct: 0.4, indicativeCapRate: 0.3, roofStructuralReservePsf: 9 };
    expect(LeaseRunAssumptions.safeParse(stored).success).toBe(true);
  });
});

describe('checkAssumptionDraft (editor)', () => {
  it.each(['', '   '])('a blank draft %j is refused, never saved as 0', (d) => {
    expect(checkAssumptionDraft('vacancyCreditLossPct', d)).toEqual({ ok: false, message: 'Enter a value. A blank box is not saved as 0.' });
  });

  it('non-numeric is refused', () => {
    expect(checkAssumptionDraft('managementFeePct', 'abc')).toMatchObject({ ok: false, message: 'Enter a number.' });
  });

  it('percent fields convert from percent points and are range-checked with a plain message', () => {
    expect(checkAssumptionDraft('renewalMarketGrowthPct', '3')).toEqual({ ok: true, value: 0.03 });
    expect(checkAssumptionDraft('renewalMarketGrowthPct', '20')).toEqual({ ok: false, message: 'Enter a value between -10% and 15%.' });
    expect(checkAssumptionDraft('indicativeCapRate', '1')).toEqual({ ok: false, message: 'Enter a value between 2% and 20%.' });
  });

  it('the roof reserve is $/SF, not percent', () => {
    expect(checkAssumptionDraft('roofStructuralReservePsf', '0.15')).toEqual({ ok: true, value: 0.15 });
    expect(checkAssumptionDraft('roofStructuralReservePsf', '6')).toEqual({ ok: false, message: 'Enter a value between $0.00/SF and $5.00/SF.' });
  });

  it('an explicit 0 is still allowed where the range allows it', () => {
    expect(checkAssumptionDraft('vacancyCreditLossPct', '0')).toEqual({ ok: true, value: 0 });
  });
});
