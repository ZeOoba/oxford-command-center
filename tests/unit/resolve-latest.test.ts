import { describe, it, expect } from 'vitest';
import { resolveLatestArrears, type DatedArrearsWrite } from '../../server/ar/resolve-latest';

const w = (leaseId: string, total: number, asOfDate: Date | null, sourceFile = 'f.pdf'): DatedArrearsWrite => ({
  leaseId,
  tenant: leaseId,
  arrears: { d30: total, d60: 0, d90: 0, d90plus: 0, asOfDate, sourceFile },
});

describe('resolveLatestArrears — cross-report supersede (never sum)', () => {
  it('passes a single row through unchanged', () => {
    const r = resolveLatestArrears([w('L1', 500, new Date('2026-07-31'))]);
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0]!.arrears.d30).toBe(500);
    expect(r.superseded).toEqual([]);
  });

  it('does NOT sum the same lease across two reports — keeps the latest as-of', () => {
    const june = w('L1', 5000, new Date('2026-06-30'), 'june.pdf');
    const july = w('L1', 5000, new Date('2026-07-31'), 'july.pdf');
    const r = resolveLatestArrears([june, july]);
    expect(r.resolved).toHaveLength(1);
    expect(r.resolved[0]!.arrears.d30).toBe(5000); // NOT 10000
    expect(r.resolved[0]!.arrears.sourceFile).toBe('july.pdf');
    expect(r.superseded).toEqual(['L1']);
  });

  it('keeps the latest regardless of scan order', () => {
    const r = resolveLatestArrears([w('L1', 1, new Date('2026-07-31'), 'july.pdf'), w('L1', 2, new Date('2026-06-30'), 'june.pdf')]);
    expect(r.resolved[0]!.arrears.sourceFile).toBe('july.pdf');
  });

  it('lets a dated report supersede an undated one regardless of order', () => {
    const r1 = resolveLatestArrears([w('L1', 1, null, 'undated.pdf'), w('L1', 2, new Date('2026-07-31'), 'dated.pdf')]);
    expect(r1.resolved[0]!.arrears.sourceFile).toBe('dated.pdf');
    const r2 = resolveLatestArrears([w('L1', 2, new Date('2026-07-31'), 'dated.pdf'), w('L1', 1, null, 'undated.pdf')]);
    expect(r2.resolved[0]!.arrears.sourceFile).toBe('dated.pdf');
  });

  it('keeps distinct leases separate and reports no supersede', () => {
    const r = resolveLatestArrears([w('L1', 100, new Date('2026-07-31')), w('L2', 200, new Date('2026-07-31'))]);
    expect(r.resolved.map((x) => x.leaseId).sort()).toEqual(['L1', 'L2']);
    expect(r.resolved.find((x) => x.leaseId === 'L1')!.arrears.d30).toBe(100);
    expect(r.superseded).toEqual([]);
  });
});
