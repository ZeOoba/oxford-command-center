import { describe, it, expect } from 'vitest';
import { describeAlertCause } from '../../src/modules/alerts/cause-labels';

const m = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `m${i}`, title: `t${i}` }));

describe('describeAlertCause', () => {
  it('names the lease-expiry cause with its member count', () => {
    expect(describeAlertCause('lease-expiry-no-signal', m(8)).title).toBe('8 leases expiring ≤90d with no renewal signal');
  });
  it('names the holdover and insurance causes', () => {
    expect(describeAlertCause('lease-lapsed', m(4)).title).toBe(
      '4 leases past end date with no executed renewal (month-to-month or holdover)',
    );
    expect(describeAlertCause('insurance-lapsed', m(12)).title).toBe('12 insurance policies expired or cancelled');
  });
  it('names the remaining lease causes', () => {
    expect(describeAlertCause('lease-expiring-soon', m(9)).title).toBe('9 leases expiring within 180d');
    expect(describeAlertCause('lease-mtm', m(3)).title).toBe('3 month-to-month tenants with no fixed end');
    expect(describeAlertCause('escalation-passed', m(5)).title).toBe('5 rent escalations past due');
  });
  it('falls back for an unknown cause rather than throwing', () => {
    expect(describeAlertCause('something-new', m(3)).title).toBe('3 related alerts');
  });
});
