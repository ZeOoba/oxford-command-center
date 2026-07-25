// tests/unit/lease-snapshot-drift-check.test.ts
//
// Regression cover for the 2026-07-24 re-baseline incident. PR #232 changed lease ids from
// row-position (`banwick-2802-105`) to tenant-identity (`banwick-2802-fully-equipped-...`), so
// EVERY id changed at once. The drift check diffed by id only, so its report read
// "137 removed / 138 new" and said nothing about the five leases whose leaseEnd ACTUALLY moved
// underneath that churn -- two of which had silently gone into holdover on 2026-06-30 while the
// snapshot still showed 8-10 months of remaining term.
//
// computeDrift() pairs id-unmatched leases by BUSINESS key (propertyKey + unit + tenant) so a
// re-key is reported as a re-key, and real value changes surface instead of being buried.
//
// Importing this module must NOT parse the live workbook or exit the test process -- see the
// entrypoint guard at the bottom of the script under test (same pattern as
// scripts/migrate-lease-overlay-ids.ts).
import { describe, expect, it } from 'vitest';
import { businessKey, computeDrift, type DriftLeaseView } from '../../scripts/lease-snapshot-drift-check';

/** Minimal lease factory -- only the fields computeDrift actually reads. */
function lease(over: Partial<DriftLeaseView> & { id: string }): DriftLeaseView {
  return {
    propertyKey: 'banwick',
    tenantName: 'Some Tenant',
    company: null,
    unit: '2802',
    leaseEnd: '2027-04-30',
    annualRent: 120_000,
    ...over,
  };
}

describe('businessKey', () => {
  it('keys on propertyKey + unit + company, normalized for case and whitespace', () => {
    const a = lease({ id: 'x-1', propertyKey: 'Banwick', unit: '2802', company: 'Acme  LLC' });
    const b = lease({ id: 'x-2', propertyKey: '  banwick ', unit: ' 2802', company: 'acme llc' });
    expect(businessKey(a)).toBe(businessKey(b));
  });

  it('falls back to tenantName when company is null', () => {
    const withCompany = lease({ id: 'x-1', company: 'Acme LLC', tenantName: 'Jane Doe' });
    const withoutCompany = lease({ id: 'x-2', company: null, tenantName: 'Acme LLC' });
    expect(businessKey(withCompany)).toBe(businessKey(withoutCompany));
  });

  it('tolerates a null unit (single-tenant buildings carry no unit)', () => {
    expect(businessKey(lease({ id: 'x-1', unit: null, company: 'Acme LLC' }))).not.toBeNull();
  });

  it('distinguishes two different units at the same property', () => {
    const u1 = lease({ id: 'x-1', unit: '2802', company: 'Acme LLC' });
    const u2 = lease({ id: 'x-2', unit: '2804', company: 'Acme LLC' });
    expect(businessKey(u1)).not.toBe(businessKey(u2));
  });

  it('returns null when the tenant component is empty -- an unusable key must never pair', () => {
    expect(businessKey(lease({ id: 'x-1', company: '   ', tenantName: '' }))).toBeNull();
  });
});

describe('computeDrift — re-key detection (the incident case)', () => {
  it('reports a pure re-key as re-keyed, not as one removal plus one addition', () => {
    const previous = [lease({ id: 'banwick-2802-105', company: 'Acme LLC' })];
    const current = [lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC' })];

    const drift = computeDrift(previous, current);

    expect(drift.rekeyed).toHaveLength(1);
    expect(drift.rekeyed[0]!.previous.id).toBe('banwick-2802-105');
    expect(drift.rekeyed[0]!.current.id).toBe('banwick-2802-acme-llc');
    expect(drift.rekeyed[0]!.leaseEndChanged).toBe(false);
    expect(drift.genuinelyNew).toHaveLength(0);
    expect(drift.genuinelyRemoved).toHaveLength(0);
  });

  it('surfaces a leaseEnd change hidden underneath a re-key -- the holdover that went unnoticed', () => {
    const previous = [
      lease({ id: 'banwick-2802-105', company: 'Fully Equipped Cleaning', leaseEnd: '2027-04-30' }),
    ];
    const current = [
      lease({ id: 'banwick-2802-fully-equipped-cleaning', company: 'Fully Equipped Cleaning', leaseEnd: '2026-06-30' }),
    ];

    const drift = computeDrift(previous, current);

    expect(drift.rekeyed).toHaveLength(1);
    expect(drift.rekeyed[0]!.leaseEndChanged).toBe(true);
    expect(drift.rekeyed[0]!.previous.leaseEnd).toBe('2027-04-30');
    expect(drift.rekeyed[0]!.current.leaseEnd).toBe('2026-06-30');
  });

  it('separates a genuinely new lease from the re-keyed cohort', () => {
    const previous = [lease({ id: 'banwick-2802-105', company: 'Acme LLC' })];
    const current = [
      lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC' }),
      lease({ id: 'banwick-2804-new-tenant-llc', unit: '2804', company: 'New Tenant LLC' }),
    ];

    const drift = computeDrift(previous, current);

    expect(drift.rekeyed).toHaveLength(1);
    expect(drift.genuinelyNew.map((l) => l.id)).toEqual(['banwick-2804-new-tenant-llc']);
    expect(drift.genuinelyRemoved).toHaveLength(0);
  });

  it('separates a genuinely removed lease from the re-keyed cohort', () => {
    const previous = [
      lease({ id: 'banwick-2802-105', company: 'Acme LLC' }),
      lease({ id: 'banwick-2804-106', unit: '2804', company: 'Departed LLC' }),
    ];
    const current = [lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC' })];

    const drift = computeDrift(previous, current);

    expect(drift.rekeyed).toHaveLength(1);
    expect(drift.genuinelyRemoved.map((l) => l.id)).toEqual(['banwick-2804-106']);
    expect(drift.genuinelyNew).toHaveLength(0);
  });
});

describe('computeDrift — ambiguity is never silently paired', () => {
  it('refuses to pair when a business key is duplicated in the CURRENT set', () => {
    const previous = [lease({ id: 'banwick-2802-105', company: 'Acme LLC' })];
    // Two current leases collapse to the same business key -- pairing either one would be a guess.
    const current = [
      lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC' }),
      lease({ id: 'banwick-2802-acme-llc-2', company: 'Acme LLC' }),
    ];

    const drift = computeDrift(previous, current);

    expect(drift.rekeyed).toHaveLength(0);
    expect(drift.ambiguous).toHaveLength(1);
    expect(drift.ambiguous[0]!.currentCount).toBe(2);
    // Falls through to the conservative reading rather than inventing a pairing.
    expect(drift.genuinelyRemoved.map((l) => l.id)).toEqual(['banwick-2802-105']);
    expect(drift.genuinelyNew).toHaveLength(2);
  });

  it('refuses to pair when a business key is duplicated in the PREVIOUS set', () => {
    const previous = [
      lease({ id: 'banwick-2802-105', company: 'Acme LLC' }),
      lease({ id: 'banwick-2802-106', company: 'Acme LLC' }),
    ];
    const current = [lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC' })];

    const drift = computeDrift(previous, current);

    expect(drift.rekeyed).toHaveLength(0);
    expect(drift.ambiguous).toHaveLength(1);
    expect(drift.ambiguous[0]!.previousCount).toBe(2);
    expect(drift.genuinelyNew.map((l) => l.id)).toEqual(['banwick-2802-acme-llc']);
  });

  it('never pairs on an unusable (empty-tenant) business key', () => {
    const previous = [lease({ id: 'banwick-2802-105', company: '', tenantName: '' })];
    const current = [lease({ id: 'banwick-2802-x', company: '', tenantName: '' })];

    const drift = computeDrift(previous, current);

    expect(drift.rekeyed).toHaveLength(0);
    expect(drift.genuinelyNew).toHaveLength(1);
    expect(drift.genuinelyRemoved).toHaveLength(1);
  });
});

describe('computeDrift — existing id-based behavior is preserved', () => {
  it('an id-matched lease is never considered for business-key pairing', () => {
    // Same id on both sides: already matched, must not also appear as a re-key.
    const previous = [lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC', leaseEnd: '2027-04-30' })];
    const current = [lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC', leaseEnd: '2026-06-30' })];

    const drift = computeDrift(previous, current);

    expect(drift.rekeyed).toHaveLength(0);
    expect(drift.genuinelyNew).toHaveLength(0);
    expect(drift.genuinelyRemoved).toHaveLength(0);
    // Still reported through the pre-existing id-matched date-change path.
    expect(drift.changedDates.map((l) => l.id)).toEqual(['banwick-2802-acme-llc']);
  });

  it('preserves the raw id-based removedIds/newIds that the anomaly floor is computed from', () => {
    // The >25% removal floor MUST keep seeing the raw id-level removal count. Business-key pairing
    // is a REPORTING layer -- if it silently fed the floor, an id-scheme change would stop tripping
    // it, which is exactly the safety property the floor exists to provide.
    const previous = [lease({ id: 'banwick-2802-105', company: 'Acme LLC' })];
    const current = [lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC' })];

    const drift = computeDrift(previous, current);

    expect(drift.removedIds.map((l) => l.id)).toEqual(['banwick-2802-105']);
    expect(drift.newIds.map((l) => l.id)).toEqual(['banwick-2802-acme-llc']);
  });

  it('reports no drift at all when nothing changed', () => {
    const leases = [lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC' })];

    const drift = computeDrift(leases, leases);

    expect(drift.newIds).toHaveLength(0);
    expect(drift.removedIds).toHaveLength(0);
    expect(drift.changedDates).toHaveLength(0);
    expect(drift.rekeyed).toHaveLength(0);
    expect(drift.genuinelyNew).toHaveLength(0);
    expect(drift.genuinelyRemoved).toHaveLength(0);
    expect(drift.ambiguous).toHaveLength(0);
  });
});

describe('computeDrift — full-set uniqueness, not just the unmatched subset', () => {
  it('does not pair when the key is unique among unmatched leases but duplicated in the full set', () => {
    // 'acme llc' at banwick/2802 appears twice in current -- once id-matched, once not. Pairing the
    // unmatched one against the unmatched previous lease would attach the wrong record, so the
    // uniqueness test deliberately counts over the FULL sets rather than the unmatched subset.
    const previous = [
      lease({ id: 'banwick-2802-105', company: 'Acme LLC' }),
      lease({ id: 'shared-id', company: 'Acme LLC' }),
    ];
    const current = [
      lease({ id: 'banwick-2802-acme-llc', company: 'Acme LLC' }),
      lease({ id: 'shared-id', company: 'Acme LLC' }),
    ];

    const drift = computeDrift(previous, current);

    expect(drift.rekeyed).toHaveLength(0);
    expect(drift.ambiguous).toHaveLength(1);
  });
});
