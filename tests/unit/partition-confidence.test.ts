import { describe, it, expect } from 'vitest';
import { partitionArRows } from '../../server/ar/partition-confidence';
import { cacheKey } from '../../server/ar/mapping-cache';
import type { LeaseLite } from '../../server/ar/match-tenant';
import type { ArAgingRow } from '../../server/ar/ar-aging';

const lease = (id: string, tenantName: string, company: string | null = null): LeaseLite => ({ id, tenantName, company });

const row = (tenant: string, over: Partial<ArAgingRow> = {}): ArAgingRow => ({
  tenant,
  property: over.property ?? null,
  d30: over.d30 ?? 0,
  d60: over.d60 ?? 0,
  d90: over.d90 ?? 0,
  d90plus: over.d90plus ?? 0,
});

describe('partitionArRows — headless auto-write policy', () => {
  it('auto-writes an exact match (≥2 tokens) but does NOT cache it as a confirmed mapping', () => {
    // Real defect (2026-09-06 adversarial review, MEDIUM): an unattended auto-accept used to be
    // persisted into the mapping cache via `learned`, and the NEXT sweep's cache-hit path trusts
    // any cache entry as "a previously human-CONFIRMED decision" (this file's own module doc) --
    // which was never true for an auto-accept nobody reviewed. Freezing it also meant a later
    // roster change (e.g. a second lease later matching the same normalized name) could never
    // trigger re-evaluation: the cache hit short-circuits straight past matchTenantToLease and its
    // ambiguity/exact-dominance checks. Auto-accepts must re-derive fresh every sweep instead.
    const leases = [lease('L1', 'Acme Tool')];
    const p = partitionArRows([row('Acme Tool, LLC', { d30: 100 })], leases);
    expect(p.write).toHaveLength(1);
    expect(p.write[0]).toMatchObject({ leaseId: 'L1', arrears: { d30: 100 } });
    expect(p.review).toEqual([]);
    expect(p.learned).toEqual({});
  });

  it('auto-writes a high-confidence match with ≥2 report tokens', () => {
    const leases = [lease('L1', 'Building Bridges Therapy Svcs')];
    const p = partitionArRows([row('Building Bridges', { d60: 50 })], leases);
    expect(p.write.map((w) => w.leaseId)).toEqual(['L1']);
    expect(p.review).toEqual([]);
  });

  it('sends a single-token high match to review (never auto-written)', () => {
    const leases = [lease('L1', 'Summit Logistics')];
    const p = partitionArRows([row('Summit', { d30: 25 })], leases);
    expect(p.write).toEqual([]);
    expect(p.review).toHaveLength(1);
    expect(p.review[0]!.reason).toMatch(/single-token high/);
    expect(p.learned).toEqual({});
  });

  it('sends a low-confidence match to review', () => {
    const leases = [lease('L1', 'Acme Tools Inc')];
    const p = partitionArRows([row('Acme Widgets Co', { d90: 10 })], leases);
    expect(p.write).toEqual([]);
    expect(p.review[0]!.reason).toMatch(/low confidence/);
    expect(p.review[0]!.confidence).toBe('low');
  });

  it('sends a no-match row to review with a null proposal', () => {
    const p = partitionArRows([row('Zzz Nomatch Corp', { d90plus: 999 })], [lease('L1', 'Acme Tool')]);
    expect(p.write).toEqual([]);
    expect(p.review[0]).toMatchObject({ proposedLeaseId: null, reason: expect.stringMatching(/no match/) });
  });

  it('sends an ambiguous ≥2-token tie to review (never auto-written)', () => {
    const leases = [lease('L1', 'Delta Force LLC'), lease('L2', 'Delta Force Inc')];
    const p = partitionArRows([row('Delta Force', { d30: 40 })], leases);
    expect(p.write).toEqual([]);
    expect(p.review[0]!.ambiguous).toBe(true);
    expect(p.review[0]!.reason).toMatch(/ambiguous tie/);
  });

  it('trusts a cached mapping — writes it without re-matching, and does not re-learn it', () => {
    const leases = [lease('L1', 'Acme Tool')];
    const cache = { [cacheKey('Totally Unmatchable Name')]: 'L1' };
    const p = partitionArRows([row('Totally Unmatchable Name', { d30: 77 })], leases, cache);
    expect(p.write).toMatchObject([{ leaseId: 'L1', arrears: { d30: 77 } }]);
    expect(p.review).toEqual([]);
    expect(p.learned).toEqual({}); // already cached → not re-learned
  });

  it('routes a cached mapping to review when the leaseId no longer exists (vacated tenant, refute 2026-07-22)', () => {
    // The lease was removed from the roster (tenant vacated owing money) but the AR export still
    // lists them and the cache still points at the dead id — must NOT silently write to nowhere.
    const cache = { [cacheKey('Acme Fabrication')]: 'lease-0042-REMOVED' };
    const p = partitionArRows([row('Acme Fabrication', { d90plus: 9800 })], [lease('L1', 'Some Other Tenant')], cache);
    expect(p.write).toEqual([]);
    expect(p.review).toHaveLength(1);
    expect(p.review[0]!.proposedLeaseId).toBe('lease-0042-REMOVED');
    expect(p.review[0]!.reason).toMatch(/no longer exists/);
  });

  it('trusts a cached mapping to a lease EXCLUDED from `leases` when validLeaseIds says it still exists (2026-08-24, PR #302 review)', () => {
    // The 2026-08-24 integrity sweep started excluding Expired leases from the caller's `leases`
    // array so a FRESH match can't auto-attribute to a dead lease -- but a PREVIOUSLY human-
    // CONFIRMED cache mapping to an Expired lease is a different, already-trusted decision. Without
    // the separate validLeaseIds roster, this would wrongly reject a live, confirmed mapping as
    // "lease removed/vacated" -- exactly the bug PR #302's own review caught (2 real cache entries,
    // $9,596.90 + $13,019.92, were about to freeze this way).
    const cache = { [cacheKey('Granite Tops More')]: 'expired-lease-still-owed' };
    const filteredLeases = [lease('L1', 'Some Other Tenant')]; // Expired lease already excluded here
    const fullRosterIds = new Set(['L1', 'expired-lease-still-owed']); // but it's still a real lease id
    const p = partitionArRows([row('Granite Tops More', { d90plus: 9596.9 })], filteredLeases, cache, fullRosterIds);
    expect(p.write).toMatchObject([{ leaseId: 'expired-lease-still-owed', arrears: { d90plus: 9596.9 } }]);
    expect(p.review).toEqual([]);
  });

  it('still rejects a cached mapping absent from validLeaseIds even though it is absent from `leases` too', () => {
    const cache = { [cacheKey('Acme Fabrication')]: 'lease-0042-REMOVED' };
    const filteredLeases = [lease('L1', 'Some Other Tenant')];
    const fullRosterIds = new Set(['L1']); // the removed lease is gone from BOTH rosters
    const p = partitionArRows([row('Acme Fabrication', { d90plus: 9800 })], filteredLeases, cache, fullRosterIds);
    expect(p.write).toEqual([]);
    expect(p.review[0]!.reason).toMatch(/no longer exists/);
  });

  it('honors a cached SKIP — counts it skipped, never writes or reviews', () => {
    const cache = { [cacheKey('Old Vacated Tenant')]: 'SKIP' };
    const p = partitionArRows([row('Old Vacated Tenant', { d90plus: 500 })], [lease('L1', 'Acme Tool')], cache);
    expect(p.skipped).toBe(1);
    expect(p.write).toEqual([]);
    expect(p.review).toEqual([]);
  });

  it('merges multi-unit rows for the same lease (sums buckets)', () => {
    const leases = [lease('L1', 'Acme Tool')];
    const p = partitionArRows(
      [row('Acme Tool', { d30: 100 }), row('Acme Tool', { d30: 50, d60: 25 })],
      leases,
    );
    expect(p.write).toHaveLength(1);
    expect(p.write[0]!.arrears).toEqual({ d30: 150, d60: 25, d90: 0, d90plus: 0 });
    expect(p.write[0]!.multiUnit).toBe(true);
  });
});
