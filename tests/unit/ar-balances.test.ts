import { describe, it, expect } from 'vitest';
import { deriveArBalances } from '../../server/ar/derive-ar-balances';
import type { Lease } from '../../src/contracts/lease';
import type { TenantArrears } from '../../src/contracts/quickbooks';
import type { Property } from '../../src/contracts/property';
import type { DataQualityFlag } from '../../src/contracts/common';

/** Minimal Property fixture — deriveArBalances only reads id/address via resolvePropertyId. */
const mkProp = (id: string, address: string): Property => ({ id, address } as unknown as Property);

/** Minimal valid Lease for join tests — only identity fields matter to the projection. */
function lease(over: Partial<Lease> & { id: string }): Lease {
  return {
    id: over.id,
    propertyKey: over.propertyKey ?? 'P',
    propertyId: over.propertyId ?? null,
    tenantName: over.tenantName ?? 'Tenant',
    unit: over.unit ?? null,
    company: over.company ?? null,
    sf: 0,
    monthlyRent: 0,
    rentPerSf: null,
    leaseStart: null,
    leaseEnd: null,
    escalationDate: null,
    escalationPct: null,
    status: 'Active',
    annualRent: 0,
    monthsToExpiry: null,
    flags: [],
  };
}

const arr = (over: Partial<TenantArrears> = {}): TenantArrears => ({
  d30: 0, d60: 0, d90: 0, d90plus: 0, ...over,
});

describe('deriveArBalances', () => {
  it('returns [] when there are no arrears', () => {
    expect(deriveArBalances([lease({ id: 'L1' })], {})).toEqual([]);
  });

  it('joins a lease identity onto its arrears and sums total', () => {
    const leases = [lease({ id: 'L1', tenantName: 'Al Mamun', company: 'M&N', unit: 'M', propertyKey: '1100 Rarig', propertyId: 'prop-rarig' })];
    const out = deriveArBalances(leases, { L1: arr({ d30: 100, d60: 50, d90: 25, d90plus: 25 }) });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      leaseId: 'L1', tenantName: 'Al Mamun', company: 'M&N', unit: 'M',
      propertyKey: '1100 Rarig', propertyId: 'prop-rarig',
      d30: 100, d60: 50, d90: 25, d90plus: 25, total: 200,
    });
  });

  it('sorts worst-delinquency-first (total desc), tenantName asc as tie-break', () => {
    const leases = [
      lease({ id: 'A', tenantName: 'Zed' }),
      lease({ id: 'B', tenantName: 'Ann' }),
      lease({ id: 'C', tenantName: 'Bob' }),
    ];
    const out = deriveArBalances(leases, {
      A: arr({ d30: 10 }),        // total 10
      B: arr({ d90plus: 500 }),   // total 500 (worst)
      C: arr({ d30: 10 }),        // total 10, ties A -> Bob before Zed
    });
    expect(out.map((r) => r.leaseId)).toEqual(['B', 'C', 'A']);
  });

  it('skips orphan arrears whose leaseId has no matching lease', () => {
    const out = deriveArBalances([lease({ id: 'L1' })], {
      L1: arr({ d30: 100 }),
      GHOST: arr({ d90plus: 999 }),
    });
    expect(out.map((r) => r.leaseId)).toEqual(['L1']);
  });

  it('keeps an all-zero record (checked-current is distinct from no-data) with total 0', () => {
    const out = deriveArBalances([lease({ id: 'L1' })], { L1: arr() });
    expect(out).toHaveLength(1);
    expect(out[0]!.total).toBe(0);
  });

  it('tolerates a nullish leases array (applyOverlay may pass a base without leases)', () => {
    // @ts-expect-error — deliberately exercising the runtime guard with an undefined leases arg
    expect(deriveArBalances(undefined, { L1: arr({ d30: 100 }) })).toEqual([]);
  });

  it('passes through asOfDate and sourceFile', () => {
    const d = new Date('2026-07-20T00:00:00.000Z');
    const out = deriveArBalances([lease({ id: 'L1' })], {
      L1: arr({ d30: 5, asOfDate: d, sourceFile: 'yardi-2026-07-20.pdf' }),
    });
    expect(out[0]!.asOfDate).toEqual(d);
    expect(out[0]!.sourceFile).toBe('yardi-2026-07-20.pdf');
  });

  describe('propertyId cross-check (2026-08-17 — Columbus/Baltimore AR misattribution fix)', () => {
    it('without a properties arg, trusts lease.propertyId as before (backward compatible)', () => {
      const leases = [lease({ id: 'L1', propertyKey: '3034 Westerville Road', propertyId: 'wrong-id' })];
      const out = deriveArBalances(leases, { L1: arr({ d30: 100 }) });
      expect(out[0]!.propertyId).toBe('wrong-id');
    });

    it('with a properties arg, corrects a propertyId that disagrees with the freshly-resolved id and flags it', () => {
      const leases = [lease({
        id: 'REDACTED-074',
        propertyKey: '3034 Westerville Road',
        propertyId: '1900-n-broadway-baltimore-md', // the real, confirmed-wrong stored value
      })];
      const properties = [
        mkProp('1900-n-broadway-baltimore-md', '1900 N Broadway, Baltimore MD'),
        mkProp('3034-westerville-rd-columbus-oh', '3034 Westerville Rd, Columbus OH'),
      ];
      const flags: DataQualityFlag[] = [];
      const out = deriveArBalances(leases, { 'REDACTED-074': arr({ d30: REDACTED-AMT }) }, properties, flags);
      expect(out[0]!.propertyId).toBe('3034-westerville-rd-columbus-oh');
      expect(flags).toHaveLength(1);
      expect(flags[0]).toMatchObject({ entity: 'REDACTED-074', field: 'propertyId', severity: 'error' });
    });

    it('does not flag when the stored propertyId already agrees with the resolved one', () => {
      const leases = [lease({ id: 'L1', propertyKey: '3034 Westerville Road', propertyId: '3034-westerville-rd-columbus-oh' })];
      const properties = [mkProp('3034-westerville-rd-columbus-oh', '3034 Westerville Rd, Columbus OH')];
      const flags: DataQualityFlag[] = [];
      const out = deriveArBalances(leases, { L1: arr({ d30: 100 }) }, properties, flags);
      expect(out[0]!.propertyId).toBe('3034-westerville-rd-columbus-oh');
      expect(flags).toHaveLength(0);
    });

    it('does not flag when the resolver itself cannot resolve anything (keeps the stored value rather than nulling it)', () => {
      const leases = [lease({ id: 'L1', propertyKey: 'Some Unmatched Address', propertyId: 'stored-id' })];
      const properties = [mkProp('other-id', '100 Other St, Nowhere OH')];
      const flags: DataQualityFlag[] = [];
      const out = deriveArBalances(leases, { L1: arr({ d30: 100 }) }, properties, flags);
      expect(out[0]!.propertyId).toBe('stored-id');
      expect(flags).toHaveLength(0);
    });
  });
});
