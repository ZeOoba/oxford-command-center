import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { tenantSlug, tenantScorecards } from '../../src/brain/tenants';

const ASOF = '2026-06-04';
// Property P1: NOI 100k, two tenants (Acme 70k rent linked, Beta 30k rent linked) → fully linked.
// Property P2: NOI 40k, one tenant (Gamma 40k rent linked).
// Acme also has an UNLINKED lease (propertyId null) of 50k rent → fallback allocation.
const snap = {
  meta: { asOf: ASOF },
  renewalStages: { L2: 'LOI' as const },
  tenantNotes: { 'acme-llc': 'Eric to follow up' },
  properties: [
    { id: 'P1', noi: 100000 },
    { id: 'P2', noi: 40000 },
  ],
  leases: [
    { id: 'L1', company: 'Acme LLC', tenantName: 'Acme LLC', propertyKey: '100 A', unit: '1', propertyId: 'P1', sf: 1000, annualRent: 70000, leaseEnd: '2026-09-01', status: 'Active' },
    { id: 'L2', company: 'Beta Inc', tenantName: 'Beta Inc', propertyKey: '100 A', unit: '2', propertyId: 'P1', sf: 500, annualRent: 30000, leaseEnd: '2026-12-01', status: 'Active' },
    { id: 'L3', company: 'Gamma Co', tenantName: 'Gamma Co', propertyKey: '200 B', unit: null, propertyId: 'P2', sf: 800, annualRent: 40000, leaseEnd: '2027-01-01', status: 'Active' },
    { id: 'L4', company: 'Acme LLC', tenantName: 'Acme LLC', propertyKey: '300 C', unit: '5', propertyId: null, sf: 600, annualRent: 50000, leaseEnd: '2026-07-15', status: 'Active' },
  ],
} as unknown as PortfolioSnapshot;

describe('tenantSlug', () => {
  it('produces a stable lowercase slug', () => {
    expect(tenantSlug('Acme LLC')).toBe('acme-llc');
    expect(tenantSlug('Beta, Inc.')).toBe('beta-inc');
  });
});

describe('tenantScorecards', () => {
  const cards = tenantScorecards(snap);
  const acme = cards.find((c) => c.id === 'acme-llc')!;
  const beta = cards.find((c) => c.id === 'beta-inc')!;
  const gamma = cards.find((c) => c.id === 'gamma-co')!;

  it('rolls leases up per tenant (rent, sf, properties, leaseCount)', () => {
    expect(acme.annualRent).toBe(120000); // 70k + 50k
    expect(acme.sf).toBe(1600);
    expect(acme.leaseCount).toBe(2);
    expect(acme.properties.sort()).toEqual(['100 A', '300 C']);
  });

  it('allocates % portfolio NOI pro-rata within each property, with rent-share fallback for unlinked leases', () => {
    // portfolio NOI = 140k. Margin = 140k / 190k total rent ≈ 0.7368.
    // Acme linked L1 = 100k * (70k/100k) = 70k. Acme unlinked L4 = 50k * 0.7368 = 36.84k. → 106.84k / 140k.
    expect(acme.pctNoi).toBeCloseTo((70000 + 50000 * (140000 / 190000)) / 140000, 4);
    // Beta linked = 100k * (30k/100k) = 30k → 30k/140k.
    expect(beta.pctNoi).toBeCloseTo(30000 / 140000, 4);
    // Gamma linked = 40k * (40k/40k) = 40k → 40k/140k.
    expect(gamma.pctNoi).toBeCloseTo(40000 / 140000, 4);
  });

  it('reports the soonest expiry and its days-to-expiry per tenant', () => {
    expect(acme.nextExpiry).toBe('2026-07-15'); // L4 sooner than L1
    expect(acme.daysToExpiry).toBeGreaterThan(0);
  });

  it('surfaces the most-advanced renewal stage and joins notes; health is null pre-QB', () => {
    expect(beta.renewalStage).toBe('LOI');
    expect(acme.renewalStage).toBeNull();
    expect(acme.notes).toBe('Eric to follow up');
    expect(beta.notes).toBe('');
    expect(acme.health).toBeNull();
  });

  it('sorts tenants by annual rent descending', () => {
    expect(cards.map((c) => c.id)).toEqual(['acme-llc', 'gamma-co', 'beta-inc']);
  });
});
