import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { buildEntityItems } from '../../src/brain/searchIndex';

/** Minimal snapshot exercising one entity of each searchable group. */
function makeSnap(): PortfolioSnapshot {
  const snap = {
    properties: [
      { id: 'p1', name: '1100 Rarig Ave', type: 'Flex', sf: 48000, noi: 511000, market: 'Columbus OH', lender: 'Symetra' },
    ],
    leases: [
      { id: 'l1', company: 'Eurosort, INC.', tenantName: 'Eurosort', propertyKey: '1100', propertyId: 'p1', unit: 'A', annualRent: 100000, status: 'Active' },
      { id: 'l2', company: null, tenantName: 'Acme', propertyKey: '2207', propertyId: 'p1', unit: null, annualRent: 50000, status: 'Expiring Soon' },
    ],
    loans: [
      { id: 'ln1', name: 'Restoration Church Trust', counterparty: 'Oxford Capital', direction: 'lender', absBalance: 980773, rate: 0.09, lender: null },
    ],
    deals: [
      { id: 'd1', name: 'Easton Logistics', shortName: 'Easton', stage: 'LOI/PSA', location: 'Easton MD' },
    ],
    insurance: [
      { id: 'ins1', property: '1100 Rarig Ave', coverage: 'Property', carrier: 'Travelers', status: 'Active' },
    ],
    cash: {
      entities: [{ id: 'fvc', entity: 'FVC', currentBalance: 4000000, pctOfPortfolio: 0.51 }],
    },
    counterparties: [
      {
        id: 'cp1',
        name: 'Symetra',
        kind: 'lender',
        firm: 'Symetra Financial',
        role: 'Relationship Manager',
        email: 'rm@symetra.com',
        links: { properties: ['p1'], loans: ['ln1'], deals: [], insurance: [] },
      },
    ],
  };
  return snap as unknown as PortfolioSnapshot;
}

describe('buildEntityItems', () => {
  it('emits one item per entity across every group', () => {
    const items = buildEntityItems(makeSnap());
    // 1 property + 2 leases + 1 loan + 1 deal + 1 insurance + 1 cash + 1 counterparty
    expect(items).toHaveLength(8);
    const groups = new Set(items.map((i) => i.group));
    expect(groups).toEqual(
      new Set(['Properties', 'Tenants', 'Loans', 'Deals', 'Insurance', 'Cash', 'Relationships']),
    );
  });

  it('carries the typed entity ref through for drill-through', () => {
    const items = buildEntityItems(makeSnap());
    const prop = items.find((i) => i.group === 'Properties')!;
    expect(prop.ref).toEqual({ type: 'property', id: 'p1' });
    const lease = items.find((i) => i.group === 'Tenants')!;
    expect(lease.ref).toEqual({ type: 'lease', id: 'l1' });
  });

  it('prefers the lease company name but indexes the tenant name in the search value', () => {
    const items = buildEntityItems(makeSnap());
    const named = items.find((i) => i.ref.id === 'l1')!;
    expect(named.title).toBe('Eurosort, INC.');
    expect(named.value).toContain('Eurosort');
    // Falls back to tenantName when company is null.
    const fallback = items.find((i) => i.ref.id === 'l2')!;
    expect(fallback.title).toBe('Acme');
  });

  it('builds a lowercase-friendly value string so cmdk can fuzzy-match by market/lender', () => {
    const prop = buildEntityItems(makeSnap()).find((i) => i.ref.id === 'p1')!;
    expect(prop.value).toContain('Columbus OH');
    expect(prop.value).toContain('Symetra');
  });

  it('labels a counterparty by kind and counts its links', () => {
    const cp = buildEntityItems(makeSnap()).find((i) => i.group === 'Relationships')!;
    expect(cp.title).toBe('Symetra');
    // KIND_LABEL maps 'lender' → 'Lender'; 2 links (1 property + 1 loan).
    expect(cp.subtitle).toContain('Lender');
    expect(cp.subtitle).toContain('2 links');
  });

  it('returns an empty list for an empty portfolio', () => {
    const empty = {
      properties: [], leases: [], loans: [], deals: [], insurance: [],
      cash: { entities: [] }, counterparties: [],
    } as unknown as PortfolioSnapshot;
    expect(buildEntityItems(empty)).toEqual([]);
  });

  it('is referentially stable: same input produces identical output (useMemo invariant)', () => {
    const snap = makeSnap();
    const result1 = buildEntityItems(snap);
    const result2 = buildEntityItems(snap);
    expect(result1).toEqual(result2);
    expect(result1[0]!.ref).toEqual(result2[0]!.ref);
  });
});
