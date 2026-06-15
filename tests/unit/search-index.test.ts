import { describe, it, expect } from 'vitest';
import { buildEntityItems } from '../../src/brain/searchIndex';
import type { PortfolioSnapshot } from '../../src/contracts/index';

function emptySnap(overrides: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  return {
    meta: { schemaVersion: '1.0.0', asOf: '2026-06-15', generatedAt: '2026-06-15T00:00:00Z', source: 't', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: '2026-06-15' },
    properties: [], leases: [], loans: [], deals: [], insurance: [], tasks: [], counterparties: [], dataQuality: [],
    cash: { asOf: '2026-06-15', totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
    ...overrides,
  } as unknown as PortfolioSnapshot;
}

describe('buildEntityItems', () => {
  it('returns empty array for an empty snapshot', () => {
    expect(buildEntityItems(emptySnap())).toEqual([]);
  });

  it('maps each property to a Properties group item', () => {
    const snap = emptySnap({
      properties: [{ id: 'p1', name: '1100 Rarig Ave', type: 'flex', sf: 21000, market: 'Columbus', noi: 95000, lender: 'First Merchants' }] as never,
    });
    const items = buildEntityItems(snap);
    expect(items).toHaveLength(1);
    expect(items[0]!.group).toBe('Properties');
    expect(items[0]!.ref).toEqual({ type: 'property', id: 'p1' });
    expect(items[0]!.title).toBe('1100 Rarig Ave');
    expect(items[0]!.value).toContain('Columbus');
  });

  it('maps each deal to a Deals group item', () => {
    const snap = emptySnap({
      deals: [{ id: 'd1', name: '450 Westfield', shortName: 'Westfield', stage: 'Candidate', location: 'Indianapolis, IN', sf: null, estPrice: null, capRate: null, irr: null, nextAction: null, confidential: false }] as never,
    });
    const items = buildEntityItems(snap);
    expect(items).toHaveLength(1);
    expect(items[0]!.group).toBe('Deals');
    expect(items[0]!.ref).toEqual({ type: 'deal', id: 'd1' });
    expect(items[0]!.value).toContain('Westfield');
  });

  it('is referentially stable: same input produces identical output (useMemo invariant)', () => {
    const snap = emptySnap({
      properties: [{ id: 'p1', name: 'Test Property', type: 'flex', sf: 10000, market: 'Columbus', noi: 80000 }] as never,
    });
    const result1 = buildEntityItems(snap);
    const result2 = buildEntityItems(snap);
    expect(result1).toEqual(result2);
    expect(result1[0]!.ref).toEqual(result2[0]!.ref);
  });

  it('includes all entity types in the output (properties + deals both present)', () => {
    const snap = emptySnap({
      properties: [{ id: 'p1', name: 'Prop A', type: 'flex', sf: 5000, market: 'Columbus', noi: 50000 }] as never,
      deals: [{ id: 'd1', name: 'Deal B', shortName: 'B', stage: 'LOI', location: null, sf: null, estPrice: null, capRate: null, irr: null, nextAction: null, confidential: false }] as never,
    });
    const items = buildEntityItems(snap);
    expect(items).toHaveLength(2);
    const groups = items.map((i) => i.group);
    expect(groups).toContain('Properties');
    expect(groups).toContain('Deals');
  });
});
