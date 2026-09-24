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

  it('allocates % portfolio NOI pro-rata within each property (rent-share fallback for unlinked), normalized to sum to 100%', () => {
    // Allocated NOI: Acme L1 linked 100k*(70k/100k)=70k + L4 unlinked 50k*(140k/190k)=36.84k = 106.84k.
    // Beta 100k*(30k/100k)=30k. Gamma 40k*(40k/40k)=40k. Normalize by total allocated = 176.84k.
    const acmeAlloc = 70000 + 50000 * (140000 / 190000);
    const totalAlloc = acmeAlloc + 30000 + 40000;
    expect(acme.pctNoi).toBeCloseTo(acmeAlloc / totalAlloc, 4);
    expect(beta.pctNoi).toBeCloseTo(30000 / totalAlloc, 4);
    expect(gamma.pctNoi).toBeCloseTo(40000 / totalAlloc, 4);
  });

  it('normalizes % portfolio NOI so the column sums to 100% across tenants', () => {
    const total = cards.reduce((acc, c) => acc + c.pctNoi, 0);
    expect(total).toBeCloseTo(1, 6);
  });

  it('the residence is not in the portfolio-NOI denominator (investment basis, ratified 2026-09-23)', () => {
    // The unlinked-lease fallback weight is portfolioNoi / totalRent. A residence row with NOI (zero
    // in the live workbook, non-zero here to make the leak visible) must not inflate that weight —
    // the tenant % column is share of INVESTMENT NOI, the same basis as every KPI headline.
    const withResidence = {
      ...snap,
      properties: [...snap.properties, { id: 'RES', type: 'Residence', noi: 60000 }],
    } as unknown as PortfolioSnapshot;
    const cardsRes = tenantScorecards(withResidence);
    const acmeRes = cardsRes.find((c) => c.id === 'acme-llc')!;
    expect(acmeRes.pctNoi).toBeCloseTo(acme.pctNoi, 6);
    expect(cardsRes.find((c) => c.id === 'gamma-co')!.pctNoi).toBeCloseTo(gamma.pctNoi, 6);
    // Guard against a vacuous pass: on the all-rows basis Acme's unlinked lease would weigh
    // 50k·(200k/190k) instead of 50k·(140k/190k), which moves its share by >2 pts.
    const acmeAllRows = 70000 + 50000 * (200000 / 190000);
    const totalAllRows = acmeAllRows + 30000 + 40000;
    expect(Math.abs(acme.pctNoi - acmeAllRows / totalAllRows)).toBeGreaterThan(0.02);
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

  // Regression: tenantScorecards must anchor daysToExpiry on the passed referenceDate, NOT
  // s.meta.asOf (a frozen workbook-label constant) — the frozen-dateline defect (2026-07).
  it('honors an explicit referenceDate, overriding meta.asOf for daysToExpiry', () => {
    const atAsOf = tenantScorecards(snap).find((c) => c.id === 'acme-llc')!;
    // acme's nextExpiry is 2026-07-15; from ASOF (2026-06-04) that's ~41 days out.
    expect(atAsOf.daysToExpiry).toBeCloseTo(41, 0);

    const advanced = tenantScorecards(snap, '2026-07-10').find((c) => c.id === 'acme-llc')!;
    // From 2026-07-10, the same 2026-07-15 expiry is only ~5 days out — not ~41.
    expect(advanced.daysToExpiry).toBeCloseTo(5, 0);
  });
});
