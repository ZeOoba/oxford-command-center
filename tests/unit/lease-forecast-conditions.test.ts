// tests/unit/lease-forecast-conditions.test.ts — Phase 3 W1 Step 4
// TDD: L-1 through L-5 alert conditions in evaluateConditions.
// Named cases C-1 through C-7 from spec §9.
import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot, Property, Lease, Loan, InsurancePolicy, Deal } from '@contracts/index';
import { evaluateConditions } from '@analytics/index';

// ── Fixtures (mirror conditions.test.ts pattern) ─────────────────────────────
const ASOF = '2026-06-21';
const NOW = Date.parse('2026-06-21T12:00:00.000Z');

function snap(over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  const base = {
    meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: '2026-06-21T00:00:00.000Z', source: 't', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: ASOF },
    properties: [] as Property[], leases: [] as Lease[], loans: [] as Loan[], deals: [] as Deal[], insurance: [] as InsurancePolicy[], tasks: [], counterparties: [],
    renewalStages: {} as Record<string, string>, tenantNotes: {}, dealComps: {}, noiBudgets: {}, quickbooks: null, dataQuality: [],
    tenantArrears: {},
    marketRents: {} as Record<string, number>,
    acquisitionInputs: {},
    cash: { asOf: ASOF, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
  };
  return { ...base, ...over } as unknown as PortfolioSnapshot;
}

function iso(daysFromAsOf: number): string {
  return new Date(Date.parse(ASOF) + daysFromAsOf * 86_400_000).toISOString().slice(0, 10);
}

function mkLease(o: Partial<Lease> & { id: string }): Lease {
  return {
    propertyKey: 'Prop One',
    propertyId: 'p1',
    tenantName: 'Tenant',
    unit: null,
    company: 'Acme',
    sf: 10000,
    monthlyRent: 1000,
    rentPerSf: 1.2,
    leaseStart: '2022-06-21',
    leaseEnd: iso(365),
    escalationDate: null,
    escalationPct: null,
    status: 'Active',
    annualRent: 12000,
    monthsToExpiry: 12,
    flags: [],
    ...o,
  };
}

const opts = { now: NOW };

// ── C-1: L-1 Expiring no renewal signal ──────────────────────────────────────
describe('C-1: L-1 — expiring ≤90d, no stage → critical', () => {
  it('≤90d expiry, no stage → exactly one L-1, critical, impactAnnualUsd=annualRent, spine:A, category:lease', () => {
    const l = mkLease({ id: 'l1', leaseEnd: iso(60), monthsToExpiry: 2, annualRent: 24000 });
    const out = evaluateConditions(snap({ leases: [l] }), opts);
    const ins = out.filter((i) => i.id === `lease-expiry-l1`);
    expect(ins).toHaveLength(1);
    const i = ins[0]!;
    expect(i.severity).toBe('critical');
    expect(i.category).toBe('lease');
    expect(i.spine).toBe('A');
    expect(i.provenance).toBe('real');
    expect(i.impactAnnualUsd).toBe(24000);
    expect(i.entityType).toBe('lease');
    expect(i.entityId).toBe('l1');
  });

  it('exactly 90d (3 months) expiry, no stage → fires L-1', () => {
    const l = mkLease({ id: 'l1', leaseEnd: iso(90), monthsToExpiry: 3, annualRent: 18000 });
    const out = evaluateConditions(snap({ leases: [l] }), opts);
    expect(out.some((i) => i.id === 'lease-expiry-l1')).toBe(true);
  });

  it('91d expiry → does NOT fire L-1 (outside the ≤90d window)', () => {
    const l = mkLease({ id: 'l1', leaseEnd: iso(91), monthsToExpiry: 3.05, annualRent: 18000 });
    const out = evaluateConditions(snap({ leases: [l] }), opts);
    expect(out.some((i) => i.id === 'lease-expiry-l1')).toBe(false);
  });
});

// ── C-2: L-1 suppressed when stage is LOI ────────────────────────────────────
describe('C-2: L-1 — suppressed when stage is LOI', () => {
  it('≤90d expiry but stage LOI → no L-1', () => {
    const l = mkLease({ id: 'l1', leaseEnd: iso(30), monthsToExpiry: 1, annualRent: 12000 });
    const out = evaluateConditions(snap({ leases: [l], renewalStages: { l1: 'LOI' } }), opts);
    expect(out.some((i) => i.id === 'lease-expiry-l1')).toBe(false);
  });
  it('≤90d expiry but stage Executed → no L-1', () => {
    const l = mkLease({ id: 'l1', leaseEnd: iso(45), monthsToExpiry: 1.5, annualRent: 12000 });
    const out = evaluateConditions(snap({ leases: [l], renewalStages: { l1: 'Executed' } }), opts);
    expect(out.some((i) => i.id === 'lease-expiry-l1')).toBe(false);
  });
  it('stage Expiring still fires L-1 (Expiring = no action taken)', () => {
    const l = mkLease({ id: 'l1', leaseEnd: iso(30), monthsToExpiry: 1, annualRent: 12000 });
    const out = evaluateConditions(snap({ leases: [l], renewalStages: { l1: 'Expiring' } }), opts);
    expect(out.some((i) => i.id === 'lease-expiry-l1')).toBe(true);
  });
});

// ── C-3: L-2 lapsed/holdover (past + stage ≠ Executed) ──────────────────────
describe('C-3: L-2 — leaseEnd past, stage ≠ Executed → warning, not L-1', () => {
  it('leaseEnd in past, no stage → L-2 warning, not L-1', () => {
    const l = mkLease({
      id: 'l1',
      leaseEnd: iso(-30), // 30 days in the past
      monthsToExpiry: -1,
      annualRent: 18000,
      status: 'Active',
    });
    const out = evaluateConditions(snap({ leases: [l] }), opts);
    // L-2 fires (lapsed/holdover)
    const l2 = out.find((i) => i.id === 'lease-lapsed-l1');
    expect(l2).toBeDefined();
    expect(l2!.severity).toBe('warning');
    expect(l2!.spine).toBe('A');
    // L-1 does NOT fire (leaseEnd is in the past, not future ≤90d)
    expect(out.some((i) => i.id === 'lease-expiry-l1')).toBe(false);
  });

  it('leaseEnd in past, stage Negotiating → L-2 (not Executed)', () => {
    const l = mkLease({ id: 'l1', leaseEnd: iso(-10), monthsToExpiry: -0.3, annualRent: 12000, status: 'Active' });
    const out = evaluateConditions(snap({ leases: [l], renewalStages: { l1: 'Negotiating' } }), opts);
    expect(out.some((i) => i.id === 'lease-lapsed-l1')).toBe(true);
  });

  it('leaseEnd in past, stage Executed → NO L-2 (renewal done)', () => {
    const l = mkLease({ id: 'l1', leaseEnd: iso(-10), monthsToExpiry: -0.3, annualRent: 12000, status: 'Active' });
    const out = evaluateConditions(snap({ leases: [l], renewalStages: { l1: 'Executed' } }), opts);
    expect(out.some((i) => i.id === 'lease-lapsed-l1')).toBe(false);
  });
});

// ── C-4: L-4 under-market lease ──────────────────────────────────────────────
describe('C-4: L-4 — under-market ≥10% → info, impactAnnualUsd = gapAnnualUsd', () => {
  it('under-market ≥10% → L-4 info, impactAnnualUsd = gapAnnualUsd (positive)', () => {
    // sf=10000, currentPSF=5.0, marketPSF=6.0 → gap=1.0, gapPct=16.7%, gapAnnual=10000
    const l = mkLease({
      id: 'l1',
      sf: 10000,
      rentPerSf: 5.0,
      annualRent: 50000,
      leaseEnd: iso(365),
      monthsToExpiry: 12,
    });
    const out = evaluateConditions(snap({ leases: [l], marketRents: { 'Prop One': 6.0 } }), opts);
    const ins = out.find((i) => i.id === 'lease-undermarket-l1');
    expect(ins).toBeDefined();
    expect(ins!.severity).toBe('info');
    expect(ins!.spine).toBe('A');
    expect(ins!.provenance).toBe('derived');
    expect(ins!.impactAnnualUsd).toBeCloseTo(10000); // positive upside
  });

  it('under-market at exactly 10% threshold → fires', () => {
    // sf=10000, current=5.0, market=5.556 → gap/market ≈ 10%
    const l = mkLease({
      id: 'l1',
      sf: 10000,
      rentPerSf: 5.0,
      annualRent: 50000,
    });
    // market 5.556 → gap = 0.556, gapPct = 0.556/5.556 ≈ 10.0%
    const out = evaluateConditions(snap({ leases: [l], marketRents: { 'Prop One': 5.556 } }), opts);
    expect(out.some((i) => i.id === 'lease-undermarket-l1')).toBe(true);
  });

  it('under-market but gap < 10% → no L-4', () => {
    // sf=10000, current=5.5, market=6.0 → gap=0.5, gapPct=0.5/6.0≈8.3%
    const l = mkLease({ id: 'l1', sf: 10000, rentPerSf: 5.5, annualRent: 55000 });
    const out = evaluateConditions(snap({ leases: [l], marketRents: { 'Prop One': 6.0 } }), opts);
    expect(out.some((i) => i.id === 'lease-undermarket-l1')).toBe(false);
  });
});

// ── C-5: L-4 suppressed when no market rent ──────────────────────────────────
describe('C-5: L-4 — suppressed when no market rent in overlay', () => {
  it('no market rent in overlay → no L-4', () => {
    const l = mkLease({ id: 'l1', sf: 10000, rentPerSf: 4.0, annualRent: 40000 });
    const out = evaluateConditions(snap({ leases: [l], marketRents: {} }), opts);
    expect(out.some((i) => i.id === 'lease-undermarket-l1')).toBe(false);
  });
});

// ── C-6: L-5 concentrated rollover ───────────────────────────────────────────
describe('C-6: L-5 — one bucket ≥15% of total annual rent → warning', () => {
  it('0-6m bucket ≥15% of total → L-5 warning, impactAnnualUsd = bucket rent', () => {
    // Total rent: 100000. l1 expiring in 3m: 20000 = 20% → fires
    const l1 = mkLease({ id: 'l1', leaseEnd: iso(90), monthsToExpiry: 3, annualRent: 20000 });
    const l2 = mkLease({ id: 'l2', leaseEnd: iso(365), monthsToExpiry: 12, annualRent: 80000 });
    const out = evaluateConditions(snap({ leases: [l1, l2] }), opts);
    const ins = out.find((i) => i.id === 'rollover-concentration-0-6m');
    expect(ins).toBeDefined();
    expect(ins!.severity).toBe('warning');
    expect(ins!.spine).toBe('A');
    expect(ins!.provenance).toBe('derived');
    expect(ins!.impactAnnualUsd).toBe(20000);
  });

  it('6-12m bucket ≥15% of total → L-5 warning', () => {
    const l1 = mkLease({ id: 'l1', leaseEnd: iso(270), monthsToExpiry: 9, annualRent: 20000 });
    const l2 = mkLease({ id: 'l2', leaseEnd: iso(730), monthsToExpiry: 24, annualRent: 80000 });
    const out = evaluateConditions(snap({ leases: [l1, l2] }), opts);
    expect(out.some((i) => i.id === 'rollover-concentration-6-12m')).toBe(true);
  });

  it('0-6m bucket < 15% → no L-5', () => {
    // l1 = 10000, l2 = 100000 → 9% < 15%
    const l1 = mkLease({ id: 'l1', leaseEnd: iso(60), monthsToExpiry: 2, annualRent: 10000 });
    const l2 = mkLease({ id: 'l2', leaseEnd: iso(365), monthsToExpiry: 12, annualRent: 100000 });
    const out = evaluateConditions(snap({ leases: [l1, l2] }), opts);
    expect(out.some((i) => i.id === 'rollover-concentration-0-6m')).toBe(false);
  });

  it('only one L-5 per triggering bucket (dedup)', () => {
    // Two leases in the same bucket, together ≥15% — should produce exactly one L-5 for that bucket
    const l1 = mkLease({ id: 'l1', leaseEnd: iso(60), monthsToExpiry: 2, annualRent: 12000 });
    const l2 = mkLease({ id: 'l2', leaseEnd: iso(45), monthsToExpiry: 1.5, annualRent: 10000 });
    const l3 = mkLease({ id: 'l3', leaseEnd: iso(400), monthsToExpiry: 13, annualRent: 78000 });
    const out = evaluateConditions(snap({ leases: [l1, l2, l3] }), opts);
    const l5s = out.filter((i) => i.id === 'rollover-concentration-0-6m');
    expect(l5s).toHaveLength(1);
  });
});

// ── C-7: Golden — full fixture, all L-1..L-5 shapes valid ───────────────────
describe('C-7: golden — full fixture, insight shapes valid', () => {
  it('all emitted insights have impactAnnualUsd, spine, provenance, category set', () => {
    // Include leases that trigger L-1, L-2, L-4, and L-5
    const lExpiring = mkLease({ id: 'l1', leaseEnd: iso(45), monthsToExpiry: 1.5, annualRent: 24000 });
    const lLapsed = mkLease({ id: 'l2', leaseEnd: iso(-10), monthsToExpiry: -0.3, annualRent: 12000, status: 'Active' });
    const lUndermarket = mkLease({ id: 'l3', leaseEnd: iso(365), monthsToExpiry: 12, annualRent: 50000, sf: 10000, rentPerSf: 5.0 });
    const lConcentration = mkLease({ id: 'l4', leaseEnd: iso(90), monthsToExpiry: 3, annualRent: 30000 });
    const lBase = mkLease({ id: 'l5', leaseEnd: iso(730), monthsToExpiry: 24, annualRent: 100000 });

    const out = evaluateConditions(snap({
      leases: [lExpiring, lLapsed, lUndermarket, lConcentration, lBase],
      marketRents: { 'Prop One': 7.0 }, // market above in-place for l3
    }), opts);

    // Every insight must have required fields
    for (const i of out) {
      expect(typeof i.impactAnnualUsd === 'number' || i.impactAnnualUsd === null).toBe(true);
      expect(['A', 'B']).toContain(i.spine);
      expect(['real', 'derived', 'absent']).toContain(i.provenance);
      expect(typeof i.category).toBe('string');
    }

    // L-1 fired (lExpiring)
    expect(out.some((i) => i.id === 'lease-expiry-l1')).toBe(true);
    // L-2 fired (lLapsed)
    expect(out.some((i) => i.id === 'lease-lapsed-l2')).toBe(true);
    // L-4 fired (lUndermarket, market=$7 > in-place=$5 → gap 28.6%)
    expect(out.some((i) => i.id === 'lease-undermarket-l3')).toBe(true);
    // L-5 should fire (lConcentration + lExpiring both in 0-6m bucket: 24000+30000=54000 of 216000=25%)
    expect(out.some((i) => i.id.startsWith('rollover-concentration'))).toBe(true);
  });
});

// ── L-3: Month-to-month exposure ─────────────────────────────────────────────
describe('L-3: monthToMonth (leaseEnd past, status Active) → info', () => {
  it('leaseEnd in past + status Active → L-3 info', () => {
    const l = mkLease({ id: 'l1', leaseEnd: iso(-30), monthsToExpiry: -1, annualRent: 18000, status: 'Active' });
    const out = evaluateConditions(snap({ leases: [l] }), opts);
    const ins = out.find((i) => i.id === 'lease-mtm-l1');
    expect(ins).toBeDefined();
    expect(ins!.severity).toBe('info');
    expect(ins!.spine).toBe('A');
    expect(ins!.provenance).toBe('derived');
    expect(ins!.impactAnnualUsd).toBe(18000);
  });

  it('leaseEnd in past + status Expired → NO L-3 (it is Expired, not MTM)', () => {
    const l = mkLease({ id: 'l1', leaseEnd: iso(-30), monthsToExpiry: -1, annualRent: 18000, status: 'Expired' });
    const out = evaluateConditions(snap({ leases: [l] }), opts);
    expect(out.some((i) => i.id === 'lease-mtm-l1')).toBe(false);
  });
});
