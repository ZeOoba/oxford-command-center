// Lease.annualRent is year-1 cash NET of abated months. Surfaces that mean "rent lost at expiry" /
// "rent at risk" / "what we quote the tenant" must read CONTRACT rent (monthlyRent x 12), and only for
// LIVE leases: a Vacant/Expired/Unknown row carries an ASKING or last rent in monthlyRent with a $0
// annualRent by design (parse.ts), and must never be resurrected as in-place rent.
import { describe, it, expect } from 'vitest';
import type { Lease, PortfolioSnapshot } from '../../src/contracts/index';
import { contractAnnualRent } from '../../src/analytics/lease-rent';
import { rentForecast } from '../../src/analytics/lease-forecast';
import { evaluateConditions } from '../../src/analytics/conditions';
import { portfolioCriticalDates } from '../../src/brain/critical-dates';
import { renewalBoard } from '../../src/brain/renewals';
import { criticalDates, revenueAtRisk, rolloverSchedule } from '../../src/analytics/engine';
import { isDeadLease } from '../../server/ar/lease-liveness';
import { RentForecastInput } from '../../src/contracts/lease-forecast';

const ASOF = '2026-10-06';

describe('contractAnnualRent', () => {
  it('live statuses use monthlyRent x 12', () => {
    expect(contractAnnualRent({ monthlyRent: 5300, annualRent: 58300, status: 'Active' })).toBe(63600);
    expect(contractAnnualRent({ monthlyRent: 5300, annualRent: 58300, status: 'Expiring Soon' })).toBe(63600);
  });
  it('a missing status is treated as live (callers that do not carry it)', () => {
    expect(contractAnnualRent({ monthlyRent: 5300, annualRent: 58300 })).toBe(63600);
  });
  it('Vacant / Expired / Unknown (at $0 annual) never resurrect an asking or last rent', () => {
    for (const status of ['Vacant', 'Expired', 'Unknown'] as const) {
      expect(contractAnnualRent({ monthlyRent: 2500, annualRent: 0, status })).toBe(0);
    }
  });
  it('an Unknown-status row with annualRent > 0 is live (e.g. Holdover/MTM text) and takes the contract basis; at annualRent 0 it stays 0', () => {
    expect(contractAnnualRent({ monthlyRent: 5300, annualRent: 58300, status: 'Unknown' })).toBe(63600);
    expect(contractAnnualRent({ monthlyRent: 5300, annualRent: 0, status: 'Unknown' })).toBe(0);
  });
  it('no monthlyRent (0 / undefined / NaN / negative) falls back to annualRent', () => {
    for (const monthlyRent of [0, undefined, NaN, -5] as const) {
      expect(contractAnnualRent({ monthlyRent: monthlyRent as number, annualRent: 60000, status: 'Active' })).toBe(60000);
    }
  });
});

describe('rentForecast ignores asking rent on non-live rows', () => {
  const mk = (o: Partial<Lease> & { id: string }): Lease => ({
    propertyKey: 'P', propertyId: 'p1', tenantName: 'T', unit: null, company: null, sf: 10000, monthlyRent: 0,
    rentPerSf: null, leaseStart: null, leaseEnd: '2031-09-30', escalationDate: null, escalationPct: null,
    status: 'Active', annualRent: 0, monthsToExpiry: 60, flags: [], ...o,
  });
  it('in-place = live contract rent only (Vacant asking / Expired last rent excluded)', () => {
    const leases = [
      mk({ id: 'live', monthlyRent: 5300, annualRent: 58300 }),
      mk({ id: 'vac', status: 'Vacant', monthlyRent: 2500, annualRent: 0, leaseEnd: null }),
      mk({ id: 'exp', status: 'Expired', monthlyRent: 4000, annualRent: 0 }),
      mk({ id: 'unk', status: 'Unknown', monthlyRent: 2500, annualRent: 0, leaseEnd: null }),
    ];
    const r = rentForecast(leases, ASOF, RentForecastInput.parse({ scenario: 'renew_at_current', horizonMonths: 12, vacancyPct: 0 }), {});
    expect(r.inPlaceAnnualRent).toBe(63600);
  });
});

describe('isDeadLease: monthlyRent only revives a LIVE-status zero-annual row', () => {
  it('Unknown + annualRent 0 + monthlyRent > 0 stays dead (ambiguous -> review, as Fix A decided)', () => {
    expect(isDeadLease({ status: 'Unknown', annualRent: 0, monthlyRent: 2500 })).toBe(true);
  });
  it('Active / Expiring Soon + annualRent 0 + monthlyRent > 0 is live (fully abated)', () => {
    expect(isDeadLease({ status: 'Active', annualRent: 0, monthlyRent: 5300 })).toBe(false);
    expect(isDeadLease({ status: 'Expiring Soon', annualRent: 0, monthlyRent: 5300 })).toBe(false);
  });
  it('a non-finite monthlyRent does not revive', () => {
    expect(isDeadLease({ status: 'Active', annualRent: 0, monthlyRent: NaN })).toBe(true);
  });
});

// Fully-abated live lease expiring in 45 days: annualRent 0, contract 63,600.
const snap = {
  meta: { asOf: ASOF },
  assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: ASOF },
  properties: [], loans: [], insurance: [], deals: [], tasks: [], counterparties: [], dataQuality: [],
  renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, quickbooks: null, tenantArrears: {}, marketRents: {}, acquisitionInputs: {},
  cash: { asOf: ASOF, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
  leases: [
    { id: 'ab', company: 'Spirit', tenantName: 'Spirit', propertyKey: '100 A', propertyId: 'p1', unit: '1', sf: 6160,
      status: 'Active', monthlyRent: 5300, annualRent: 0, leaseEnd: '2026-11-20', escalationDate: null, escalationPct: null,
      rentPerSf: null, leaseStart: null, monthsToExpiry: 1, flags: [] },
  ],
} as unknown as PortfolioSnapshot;

describe('expiry-exposure consumers read contract rent', () => {
  it('conditions: lease-expiry insight impact is contract rent, not $0', () => {
    const ins = evaluateConditions(snap, { now: Date.parse('2026-10-06T12:00:00.000Z') }).find((i) => i.id === 'expiring-ab' || i.id === 'lease-expiry-ab');
    expect(ins, 'expiry insight emitted').toBeDefined();
    expect(ins!.impactAnnualUsd).toBe(63600);
  });
  it('critical-dates: amount at stake at expiry is contract rent', () => {
    const ev = portfolioCriticalDates(snap, 90).find((e) => e.id === 'lease-expiry-ab');
    expect(ev?.amount).toBe(63600);
  });
  it('renewals card rent matches the tenant draft (contract)', () => {
    const board = renewalBoard(snap, ASOF);
    const card = Object.values(board).flat().find((c) => c.leaseId === 'ab');
    expect(card?.annualRent).toBe(63600);
  });
});

describe('L-5 rollover concentration is like-for-like (contract numerator over contract denominator)', () => {
  const mkSnap = (leases: unknown[]) => ({ ...(snap as unknown as Record<string, unknown>), leases }) as unknown as PortfolioSnapshot;
  const base = { company: 'X', tenantName: 'X', propertyKey: '100 A', propertyId: 'p1', unit: null, sf: 1000, status: 'Active',
    escalationDate: null, escalationPct: null, rentPerSf: null, leaseStart: null, flags: [] };
  it('an abated lease in the 0-6m bucket reports the contract bucket rent and the contract share', () => {
    // 0-6m: 120k contract (net 90k). Rest of portfolio: 480k contract = net. Share = 120/600 = 20% (net/mixed would be 90/570 = 15.8%).
    const leases = [
      { ...base, id: 'abated', monthlyRent: 10000, annualRent: 90000, leaseEnd: '2027-01-15', monthsToExpiry: 3 },
      { ...base, id: 'far', monthlyRent: 40000, annualRent: 480000, leaseEnd: '2031-01-15', monthsToExpiry: 51 },
    ];
    const ins = evaluateConditions(mkSnap(leases), { now: Date.parse('2026-10-06T12:00:00.000Z') }).find((i) => i.id === 'rollover-concentration-0-6m');
    expect(ins).toBeDefined();
    expect(ins!.impactAnnualUsd).toBe(120000);
    expect(ins!.detail).toContain('20.0%');
  });
});

describe('engine.ts rent-at-expiry surfaces agree with the contract-basis twins (refute wf_b8fc84af-5c6)', () => {
  const leases = (snap as unknown as { leases: Lease[] }).leases; // fully abated, expiring 2026-11-20: net 0, contract 63,600
  it('criticalDates amount equals brain portfolioCriticalDates for the same lease event', () => {
    const eng = criticalDates(leases, ASOF).find((d) => d.kind === 'Expiration');
    const brain = portfolioCriticalDates(snap, 90).find((e) => e.id === 'lease-expiry-ab');
    expect(eng?.annualRent).toBe(63600);
    expect(eng?.annualRent).toBe(brain?.amount);
  });
  it('revenueAtRisk within-90d rent is contract and its pct uses a contract denominator', () => {
    const r = revenueAtRisk(leases, ASOF);
    expect(r.within90dRent).toBe(63600);
    expect(r.pctOfRent).toBe(1);
  });
  it('rolloverSchedule expiringRent is contract (a fully abated expiring lease does not drop to $0)', () => {
    const total = rolloverSchedule(leases, ASOF).reduce((s, b) => s + b.expiringRent, 0);
    expect(total).toBe(63600);
  });
});
