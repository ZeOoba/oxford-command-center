import { describe, expect, it } from 'vitest';
import { allocationCapPoints, saleCompPoints } from '../../src/modules/capital/cap-rate-scatter';

describe('cap-rate scatter builders', () => {
  it('sale comps: $/SF vs cap, skipping rows missing either', () => {
    expect(saleCompPoints([
      { address: 'A', market: null, sf: 1, price: 1, pricePerSf: 74, capRate: 0.07, date: null, source: 's' },
      { address: 'B', market: null, sf: 1, price: 1, pricePerSf: 71, capRate: null, date: null, source: 's' },
    ])).toEqual([{ id: 'A-0', x: 74, y: 0.07, label: 'A' }]);
  });
  it('allocation: implied cap vs gap, tone by sign', () => {
    const pts = allocationCapPoints([
      { propertyId: 'p1', propertyName: 'Fishel', impliedCapRate: 0.055, capRateGap: -0.0275 },
      { propertyId: 'p2', propertyName: null, impliedCapRate: 0.08, capRateGap: 0.01 },
      { propertyId: 'p3', propertyName: 'X', impliedCapRate: null, capRateGap: null },
    ] as never);
    expect(pts).toEqual([
      { id: 'p1', x: 0.055, y: -0.0275, label: 'Fishel', tone: 'neg' },
      { id: 'p2', x: 0.08, y: 0.01, label: 'p2', tone: 'pos' },
    ]);
  });
});
