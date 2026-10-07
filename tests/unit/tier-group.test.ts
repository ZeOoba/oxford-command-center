import { describe, it, expect } from 'vitest';
import { groupByCause, signalCount } from '../../src/lib/tier-group';
import type { TierItem } from '../../src/primitives/TierBoard';

const lease = (id: string, tenant: string, usd: number | null): TierItem => ({
  id,
  title: `Expiring, no renewal signal — ${tenant}`,
  impactUsd: usd,
  impactKind: 'risk',
  category: 'lease',
  cause: 'lease-expiry',
});

const describeCause = (_cause: string, members: TierItem[]) => ({
  title: `${members.length} leases expiring with no renewal signal`,
});

describe('groupByCause', () => {
  it('rolls items sharing a cause into one row at or above the minimum size', () => {
    const items = [lease('a', 'Alpha', 58_000), lease('b', 'Beta', 48_000), lease('c', 'Gamma', 38_000)];
    const out = groupByCause(items, describeCause);
    expect(out).toHaveLength(1);
    expect(out[0]!.title).toBe('3 leases expiring with no renewal signal');
    expect(out[0]!.members?.map((m) => m.id)).toEqual(['a', 'b', 'c']);
  });

  it('sums member dollars and reports the member count as signals', () => {
    const out = groupByCause([lease('a', 'A', 10_000), lease('b', 'B', 5_000), lease('c', 'C', 1_000)], describeCause);
    expect(out[0]!.impactUsd).toBe(16_000);
    expect(signalCount(out[0]!)).toBe(3);
  });

  it('keeps a null total when no member is quantified (never fabricates $0)', () => {
    const items = ['a', 'b', 'c'].map((id) => lease(id, id, null));
    expect(groupByCause(items, describeCause)[0]!.impactUsd).toBeNull();
  });

  it('leaves a cause below the minimum size as individual rows', () => {
    const items = [lease('a', 'A', 1), lease('b', 'B', 2)];
    const out = groupByCause(items, describeCause);
    expect(out.map((i) => i.id)).toEqual(['b', 'a']);
    expect(out.every((i) => !i.members)).toBe(true);
  });

  it('never groups items that carry no cause', () => {
    const items: TierItem[] = [1, 2, 3, 4].map((n) => ({ id: `x${n}`, title: `T${n}`, impactUsd: n }));
    expect(groupByCause(items, describeCause)).toHaveLength(4);
  });

  it('re-ranks by dollars so a large group rises above a single smaller item', () => {
    const items: TierItem[] = [
      { id: 'solo', title: 'Solo', impactUsd: 40_000 },
      lease('a', 'A', 20_000),
      lease('b', 'B', 20_000),
      lease('c', 'C', 20_000),
    ];
    const out = groupByCause(items, describeCause);
    expect(out[0]!.members).toBeTruthy(); // $60K group outranks the $40K solo
    expect(out[1]!.id).toBe('solo');
    expect(out.map((i) => i.rank)).toEqual([1, 2]);
  });

  it('sorts unquantified rows last and keeps their relative order', () => {
    const items: TierItem[] = [
      { id: 'n1', title: 'N1', impactUsd: null },
      { id: 'q', title: 'Q', impactUsd: 5 },
      { id: 'n2', title: 'N2', impactUsd: null },
    ];
    expect(groupByCause(items, describeCause).map((i) => i.id)).toEqual(['q', 'n1', 'n2']);
  });
});

describe('signalCount', () => {
  it('is 1 for a plain item and the member count for a group', () => {
    expect(signalCount({ id: 'x', title: 'x' })).toBe(1);
    expect(signalCount({ id: 'g', title: 'g', members: [{ id: 'a', title: 'a' }, { id: 'b', title: 'b' }] })).toBe(2);
  });
});
