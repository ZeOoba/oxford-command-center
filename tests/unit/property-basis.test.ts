import { describe, expect, it } from 'vitest';
import type { Property } from '../../src/contracts/index';
import { isInvestmentProperty } from '../../src/analytics/property-basis';

const p = (o: Partial<Property>) => ({ id: 'x', name: 'x', type: 'Flex', ...o }) as Property;

describe('isInvestmentProperty — the one residence-exclusion predicate (ratified 2026-09-23)', () => {
  it('every income-producing type is an investment property (the solar row is typed among these — it stays in)', () => {
    for (const type of ['Flex', 'Industrial', 'Retail', 'Other'] as Property['type'][]) {
      expect(isInvestmentProperty(p({ type }))).toBe(true);
    }
  });

  it('the residence is not', () => {
    expect(isInvestmentProperty(p({ id: '9510-persimmon-tree-rd-potomac-md', type: 'Residence' }))).toBe(false);
  });

  it('accepts the occupancy view shape (optional type) — a row with no type is treated as investment', () => {
    // Same row shape as server/warehouse/occupancy.ts's OccupancySnapshotView.properties.
    const rows: { id: string; occPct: number; type?: string }[] = [
      { id: '1100-rarig-ave-columbus-oh', occPct: 0.95 },
      { id: '9510-persimmon-tree-rd-potomac-md', occPct: 0, type: 'Residence' },
    ];
    expect(rows.filter(isInvestmentProperty).map((r) => r.id)).toEqual(['1100-rarig-ave-columbus-oh']);
  });

  it('works as a bare Array.filter callback', () => {
    const rows = [p({ id: 'a' }), p({ id: 'res', type: 'Residence' }), p({ id: 'b', type: 'Industrial' })];
    expect(rows.filter(isInvestmentProperty).map((x) => x.id)).toEqual(['a', 'b']);
  });
});
