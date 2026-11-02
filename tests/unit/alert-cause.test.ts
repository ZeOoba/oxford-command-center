// Signal discipline: causeOf() maps an alert to the root cause it is a symptom of. These tests run the
// REAL condition generators and assert the mapping against their output, so an id rename in
// conditions.ts fails here instead of silently un-grouping an alert.
import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot, Lease, InsurancePolicy } from '@contracts/index';
import { evaluateConditions } from '@analytics/index';
import { causeOf, isPinnedAlert } from '../../src/brain/alert-cause';

const ASOF = '2026-06-21';
const NOW = Date.parse('2026-06-21T12:00:00.000Z');
const iso = (d: number) => new Date(Date.parse(ASOF) + d * 86_400_000).toISOString().slice(0, 10);

function snap(over: Partial<PortfolioSnapshot>): PortfolioSnapshot {
  const base = {
    meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: '2026-06-21T00:00:00.000Z', source: 't', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: ASOF },
    properties: [], leases: [], loans: [], deals: [], insurance: [], tasks: [], counterparties: [],
    renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, quickbooks: null, dataQuality: [],
    tenantArrears: {}, marketRents: {}, acquisitionInputs: {},
    cash: { asOf: ASOF, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
  };
  return { ...base, ...over } as unknown as PortfolioSnapshot;
}

const lease = (o: Partial<Lease> & { id: string }): Lease =>
  ({
    propertyKey: 'Prop One', propertyId: 'p1', tenantName: 'Tenant', unit: null, company: 'Acme', sf: 1000,
    monthlyRent: 1000, rentPerSf: 1.2, leaseStart: '2022-06-21', leaseEnd: iso(365), escalationDate: null,
    escalationPct: null, status: 'Active', annualRent: 12000, monthsToExpiry: 12, flags: [], ...o,
  }) as Lease;

const policy = (o: Partial<InsurancePolicy> & { id: string }): InsurancePolicy =>
  ({
    property: '1100 Rarig Ave', entity: null, coverage: 'Package', effective: null, expires: iso(-10), policyNo: null,
    carrier: 'Erie', premium: 5000, daysToExpiry: -10, status: 'Expired', notes: null, flags: [],
    tiv: null, deductible: null, ...o,
  }) as unknown as InsurancePolicy;

describe('insight cause tags', () => {
  it('L-1 expiring-no-signal leases share one cause', () => {
    const out = evaluateConditions(
      snap({ leases: [lease({ id: 'a', leaseEnd: iso(30) }), lease({ id: 'b', leaseEnd: iso(50) })] }),
      { now: NOW },
    );
    const l1 = out.filter((i) => i.id.startsWith('lease-expiry-'));
    expect(l1).toHaveLength(2);
    expect(new Set(l1.map((i) => causeOf(i)))).toEqual(new Set(['lease-expiry-no-signal']));
  });

  it('L-2 lapsed/holdover leases carry their own cause', () => {
    const out = evaluateConditions(snap({ leases: [lease({ id: 'a', leaseEnd: iso(-40), monthsToExpiry: -1 })] }), { now: NOW });
    const l2 = out.filter((i) => i.id === 'lease-lapsed-a');
    expect(l2).toHaveLength(1);
    expect(causeOf(l2[0]!)).toBe('lease-lapsed');
  });

  it('expired and cancelled policies share one insurance-lapsed cause', () => {
    const out = evaluateConditions(
      snap({ insurance: [policy({ id: 'x', status: 'Expired' }), policy({ id: 'y', status: 'Cancelled' })] }),
      { now: NOW },
    );
    const lapsed = out.filter((i) => i.id.startsWith('ins-lapsed-'));
    expect(lapsed).toHaveLength(2);
    expect(new Set(lapsed.map((i) => causeOf(i)))).toEqual(new Set(['insurance-lapsed']));
  });

  it('does not invent a cause for a one-off condition', () => {
    const out = evaluateConditions(snap({ leases: [lease({ id: 'a', leaseEnd: iso(30) })] }), { now: NOW });
    expect(causeOf({ id: 'conc-top-tenant' })).toBeUndefined();
    expect(out.length).toBeGreaterThan(0);
  });

  it('tags soon-expiring, expired, escalation and month-to-month leases', () => {
    const out = evaluateConditions(
      snap({
        leases: [
          lease({ id: 'soon', leaseEnd: iso(150), monthsToExpiry: 5 }),
          lease({ id: 'exp', status: 'Expired', leaseEnd: iso(-200), monthsToExpiry: -7 }),
          lease({ id: 'esc', escalationDate: iso(-20) }),
          lease({ id: 'mtm', leaseEnd: iso(-60), monthsToExpiry: -2 }),
        ],
      }),
      { now: NOW },
    );
    const byId = (id: string) => out.find((i) => i.id === id);
    expect(causeOf(byId('expiring-soon')!)).toBe('lease-expiring-soon');
    // The expiry-family dedup keeps one insight per lease: an Expired holdover surfaces as lease-lapsed-*.
    expect(causeOf(byId('lease-lapsed-exp')!)).toBe('lease-lapsed');
    expect(causeOf(byId('escalation-esc')!)).toBe('escalation-passed');
    expect(causeOf(byId('lease-mtm-mtm')!)).toBe('lease-mtm');
  });

  it('maps ids the dedup normally suppresses or that need extra inputs (formats pinned here)', () => {
    expect(causeOf({ id: 'lease-undermarket-abc' })).toBe('lease-undermarket');
    expect(causeOf({ id: 'expired-abc' })).toBe('lease-expired');
  });

  it('tags the unquantified safety alerts (DSCR floor/covenant, LTV ceiling, reconcile failure) and pins them', () => {
    expect(causeOf({ id: 'dscr-floor-p1' })).toBe('dscr-floor');
    expect(causeOf({ id: 'dscr-p1' })).toBe('dscr-covenant');
    expect(causeOf({ id: 'ltv-p1' })).toBe('ltv-ceiling');
    expect(causeOf({ id: 'reconcile-fail' })).toBe('reconcile-fail');
    for (const id of ['dscr-floor-p1', 'dscr-p1', 'ltv-p1', 'reconcile-fail']) expect(isPinnedAlert({ id }, false)).toBe(true);
  });

  it('does not pin informational or hygiene alerts', () => {
    expect(causeOf({ id: 'ltv-governor-p1' })).toBeUndefined(); // informational governor deviation, not a breach
    for (const id of ['ltv-governor-p1', 'workbook-stale', 'ar-stale']) expect(isPinnedAlert({ id }, false)).toBe(false);
  });

  it('pins a real reconcile-fail alert from the generator', () => {
    const out = evaluateConditions(
      snap({ dataQuality: [{ severity: 'error', entity: 'reconciliation', field: 'totalSf', message: 'x' }] as never }),
      { now: NOW },
    );
    const rf = out.find((i) => i.id === 'reconcile-fail');
    expect(rf).toBeDefined();
    expect(causeOf(rf!)).toBe('reconcile-fail');
  });

  it('pins lapsed coverage (both lapse ids) until it is read; renewal warnings are never pinned', () => {
    expect(isPinnedAlert({ id: 'ins-lapsed-x' }, false)).toBe(true);
    expect(isPinnedAlert({ id: 'ins-lapsed-live-x' }, false)).toBe(true);
    expect(isPinnedAlert({ id: 'ins-lapsed-x' }, true)).toBe(false); // acknowledged: stops claiming #1
    expect(isPinnedAlert({ id: 'ins-x' }, false)).toBe(false); // renewing-soon warning
    expect(isPinnedAlert({ id: 'lease-expiry-x' }, false)).toBe(false);
  });
});

describe('describeAlertCause — LTV ceiling label', () => {
  it('builds the ceiling from the per-property threshold constant, not a hard-coded figure', async () => {
    const { describeAlertCause } = await import('../../src/modules/alerts/cause-labels');
    const { ALERT_THRESHOLDS } = await import('../../src/analytics/conditions');
    const { fmtPct } = await import('../../src/analytics/format');
    const title = describeAlertCause('ltv-ceiling', [{ id: 'a' }, { id: 'b' }] as never).title;
    expect(title).toBe(`2 properties above the ${fmtPct(ALERT_THRESHOLDS.refiLtvCeilingPerProperty, 0)} LTV ceiling`);
    expect(title).toBe('2 properties above the 65% LTV ceiling');
  });
});
