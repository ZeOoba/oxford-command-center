import { describe, it, expect } from 'vitest';
import { deriveArBalances } from '../../server/ar/derive-ar-balances';
import type { Lease } from '../../src/contracts/lease';
import type { TenantArrears } from '../../src/contracts/quickbooks';

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
});
