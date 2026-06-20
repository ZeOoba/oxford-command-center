import { describe, it, expect } from 'vitest';
import { matchTenantToLease, normalizeTokens, type LeaseLite } from '../../server/ar/match-tenant';

const leases: LeaseLite[] = [
  { id: 'l-acme', tenantName: 'Acme Industrial', company: 'Acme Industrial, LLC' },
  { id: 'l-bbt', tenantName: 'Building Bridges Therapy Svcs', company: null },
  { id: 'l-foxwell', tenantName: 'Louis W. Foxwell', company: null },
  { id: 'l-hobart', tenantName: 'Hobart Service', company: 'Hobart Service a division of ITW Food Equipment Group, LLC' },
  { id: 'l-zeta', tenantName: 'Zeta Logistics', company: null },
];

describe('normalizeTokens', () => {
  it('strips entity suffixes and punctuation', () => {
    expect(normalizeTokens('Acme Industrial, LLC')).toEqual(['acme', 'industrial']);
    expect(normalizeTokens('Hobart Service, Inc.')).toEqual(['hobart', 'service']);
  });
  it('reorders "Last, First" person names', () => {
    expect(normalizeTokens('FOXWELL, LOUIS W.')).toEqual(['louis', 'w', 'foxwell']);
  });
  it('drops an entity suffix that follows a comma (not a person reorder)', () => {
    expect(normalizeTokens('Curtis Elliott Designs, LTD')).toEqual(['curtis', 'elliott', 'designs']);
  });
});

describe('matchTenantToLease', () => {
  it('exact match (modulo entity suffix) → exact confidence', () => {
    const m = matchTenantToLease('Acme Industrial', leases);
    expect(m.leaseId).toBe('l-acme');
    expect(m.confidence).toBe('exact');
  });

  it('matches against the company field, not just tenantName', () => {
    const m = matchTenantToLease('ITW Food Equipment Group', leases);
    expect(m.leaseId).toBe('l-hobart'); // overlaps the company string
    expect(['high', 'low']).toContain(m.confidence);
  });

  it('a wrapped/truncated report name that is a subset still matches high', () => {
    // PDF extraction dropped "Svcs" — the report name is a subset of the rent-roll name.
    const m = matchTenantToLease('Building Bridges Therapy', leases);
    expect(m.leaseId).toBe('l-bbt');
    expect(m.confidence).toBe('high');
    expect(m.score).toBe(1); // subset → 1.0 via smaller-set overlap
  });

  it('reordered person name matches', () => {
    const m = matchTenantToLease('Foxwell, Louis W.', leases);
    expect(m.leaseId).toBe('l-foxwell');
    expect(['exact', 'high']).toContain(m.confidence);
  });

  it('no plausible match → none + null leaseId (human must map)', () => {
    const m = matchTenantToLease('Completely Different Tenant XYZ', leases);
    expect(m.leaseId).toBeNull();
    expect(m.confidence).toBe('none');
  });

  it('a single shared token among multi-token names stays below the floor (no false high)', () => {
    // "Zeta Holdings" shares only "zeta" with "Zeta Logistics" → 0.5 overlap → low, not high.
    const m = matchTenantToLease('Zeta Holdings', leases);
    expect(m.confidence).toBe('low');
  });

  it('flags ambiguity when two leases tie at the top score', () => {
    const dup: LeaseLite[] = [
      { id: 'l-1', tenantName: 'Summit Storage', company: null },
      { id: 'l-2', tenantName: 'Summit Storage', company: null },
    ];
    const m = matchTenantToLease('Summit Storage', dup);
    expect(m.ambiguous).toBe(true);
  });

  it('empty / junk report name → none, never throws', () => {
    expect(matchTenantToLease('', leases).confidence).toBe('none');
    expect(matchTenantToLease('   ,  ', leases).confidence).toBe('none');
  });
});
