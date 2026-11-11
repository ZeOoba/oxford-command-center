import { describe, it, expect } from 'vitest';
import { mergeByLease } from '../../server/ar/merge-buckets';

describe('mergeByLease', () => {
  it('passes through a single row unchanged', () => {
    const result = mergeByLease([
      { leaseId: 'l-1', arrears: { d30: 100, d60: 0, d90: 0, d90plus: 0 }, tenant: 'Acme Co' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      leaseId: 'l-1',
      arrears: { d30: 100, d60: 0, d90: 0, d90plus: 0 },
      tenant: 'Acme Co',
      multiUnit: false,
    });
  });

  it('sums all four buckets when two rows share the same leaseId (multi-unit tenant)', () => {
    const result = mergeByLease([
      { leaseId: 'l-north', arrears: { d30: 0, d60: 0, d90: 1000, d90plus: 0 }, tenant: 'Northstar Unit 1A' },
      { leaseId: 'l-north', arrears: { d30: 0, d60: 0, d90: 0, d90plus: 5000 }, tenant: 'Northstar Unit 2A' },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]!.arrears).toEqual({ d30: 0, d60: 0, d90: 1000, d90plus: 5000 });
    expect(result[0]!.multiUnit).toBe(true);
    expect(result[0]!.tenant).toContain('Northstar Unit 1A');
    expect(result[0]!.tenant).toContain('Northstar Unit 2A');
  });

  it('keeps distinct leaseIds as separate rows', () => {
    const result = mergeByLease([
      { leaseId: 'l-a', arrears: { d30: 200, d60: 0, d90: 0, d90plus: 0 }, tenant: 'Alpha Tenant' },
      { leaseId: 'l-b', arrears: { d30: 0, d60: 500, d90: 0, d90plus: 0 }, tenant: 'Bravo Tenant' },
    ]);
    expect(result).toHaveLength(2);
    expect(result.find((r) => r.leaseId === 'l-a')!.arrears.d30).toBe(200);
    expect(result.find((r) => r.leaseId === 'l-b')!.arrears.d60).toBe(500);
  });

  it('preserves first-occurrence insertion order', () => {
    const result = mergeByLease([
      { leaseId: 'l-c', arrears: { d30: 1, d60: 0, d90: 0, d90plus: 0 }, tenant: 'Charlie' },
      { leaseId: 'l-a', arrears: { d30: 2, d60: 0, d90: 0, d90plus: 0 }, tenant: 'Alpha' },
      { leaseId: 'l-c', arrears: { d30: 3, d60: 0, d90: 0, d90plus: 0 }, tenant: 'Charlie Unit 2' },
    ]);
    expect(result[0]!.leaseId).toBe('l-c');
    expect(result[0]!.arrears.d30).toBe(4); // 1+3 summed
    expect(result[1]!.leaseId).toBe('l-a');
  });

  it('returns empty array for empty input', () => {
    expect(mergeByLease([])).toEqual([]);
  });

  // Real defect (2026-09-06 adversarial review, MEDIUM): a plain running float sum across
  // multi-unit rows is sensitive to summation order (0.1+0.2 non-associativity) — the same
  // three unit-rows summed in a different order can land on a different last-ulp float, which
  // resolve-latest.ts's `===` bucket comparison then reads as two DISAGREEING reports.
  it('sums to the same cent-precise total regardless of row order (float-drift regression)', () => {
    const rowsForward = [
      { leaseId: 'l-multi', arrears: { d30: 234.56, d60: 0, d90: 0, d90plus: 0 }, tenant: 'Unit A' },
      { leaseId: 'l-multi', arrears: { d30: 400, d60: 0, d90: 0, d90plus: 0 }, tenant: 'Unit B' },
      { leaseId: 'l-multi', arrears: { d30: 100.3, d60: 0, d90: 0, d90plus: 0 }, tenant: 'Unit C' },
    ];
    // The order-dependence is real for these inputs (asserted so a future edit cannot silently lose it).
    expect(234.56 + 400 + 100.3).not.toBe(100.3 + 400 + 234.56);
    const rowsReversed = [...rowsForward].reverse();
    const fwd = mergeByLease(rowsForward)[0]!.arrears.d30;
    const rev = mergeByLease(rowsReversed)[0]!.arrears.d30;
    expect(fwd).toBe(rev);
    expect(fwd).toBe(734.86); // exact cent value, not 734.8599999999999
  });
});
