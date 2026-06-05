import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { portfolioCriticalDates, criticalDateKpis } from '../../src/brain/critical-dates';
import { ALERT_THRESHOLDS } from '@analytics/index';

const ASOF = '2026-06-04';

// Minimal snapshot — only the fields the aggregator reads. Cast through unknown.
const snap = {
  meta: { asOf: ASOF },
  leases: [
    // expiring in ~50 days
    { id: 'L1', company: 'Acme', tenantName: 'Acme LLC', propertyKey: '100 A', unit: '1', annualRent: 120000, leaseEnd: '2026-07-24', escalationDate: null },
    // overdue holdover (expired 30 days ago) — kept
    { id: 'L2', company: null, tenantName: 'Beta', propertyKey: '200 B', unit: null, annualRent: 60000, leaseEnd: '2026-05-05', escalationDate: null },
    // escalation in ~100 days — kept; expiry far out (800d) — dropped
    { id: 'L3', company: 'Gamma', tenantName: 'Gamma', propertyKey: '300 C', unit: '2', annualRent: 90000, leaseEnd: '2028-08-12', escalationDate: '2026-09-12' },
  ],
  loans: [
    // maturity in ~120 days
    { id: 'LN1', name: 'Rarig note', maturity: '2026-10-02', absBalance: 980000, isDemand: false },
    // demand — no maturity date — dropped
    { id: 'LN2', name: 'Demand', maturity: null, absBalance: 50000, isDemand: true },
  ],
  insurance: [
    // renews in ~40 days
    { id: 'INS1', property: '100 A', coverage: 'Property', expires: '2026-07-14', premium: 12000 },
    // expired 10 days ago — kept (overdue)
    { id: 'INS2', property: '200 B', coverage: 'GL', expires: '2026-05-25', premium: 8000 },
  ],
} as unknown as PortfolioSnapshot;

describe('portfolioCriticalDates', () => {
  it('aggregates all four event types within a 12-month horizon, dropping far/past-only items', () => {
    const events = portfolioCriticalDates(snap, 12);
    const ids = events.map((e) => e.id);
    expect(ids).toContain('lease-expiry-L1');
    expect(ids).toContain('lease-expiry-L2'); // overdue holdover kept
    expect(ids).toContain('escalation-L3');
    expect(ids).not.toContain('lease-expiry-L3'); // 800d out — beyond horizon
    expect(ids).toContain('loan-maturity-LN1');
    expect(ids).not.toContain('loan-maturity-LN2'); // demand loan, no date
    expect(ids).toContain('insurance-renewal-INS1');
    expect(ids).toContain('insurance-renewal-INS2'); // overdue policy kept
  });

  it('sorts by date ascending and tags a YYYY-MM month key', () => {
    const events = portfolioCriticalDates(snap, 12);
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.daysToDate).toBeGreaterThanOrEqual(events[i - 1]!.daysToDate);
    }
    const ln = events.find((e) => e.id === 'loan-maturity-LN1');
    expect(ln!.monthKey).toBe('2026-10');
    expect(ln!.type).toBe('loan-maturity');
    expect(ln!.entityType).toBe('loan');
    expect(ln!.entityId).toBe('LN1');
  });

  it('honors a tighter horizon (90 days ≈ 3 months)', () => {
    const events = portfolioCriticalDates(snap, 3);
    const ids = events.map((e) => e.id);
    expect(ids).toContain('lease-expiry-L1'); // 50d in
    expect(ids).not.toContain('escalation-L3'); // ~100d out — beyond 3mo
    expect(ids).not.toContain('loan-maturity-LN1'); // ~120d out — beyond 3mo
  });

  it('computes urgency tiers from daysToDate', () => {
    const events = portfolioCriticalDates(snap, 12);
    expect(events.find((e) => e.id === 'lease-expiry-L1')!.urgency).toBe('critical'); // 50d < 60
    expect(events.find((e) => e.id === 'lease-expiry-L2')!.urgency).toBe('critical'); // overdue < 60
    expect(events.find((e) => e.id === 'escalation-L3')!.urgency).toBe('warning'); // ~100d in [60,180)
  });
});

describe('criticalDateKpis', () => {
  it('counts critical (<60d incl. overdue), warning (60–180d), this-quarter (<90d), and next-12mo total', () => {
    const events = portfolioCriticalDates(snap, 12);
    const k = criticalDateKpis(events);
    // critical: L1(50), L2(-30 overdue), INS1(40), INS2(-10 overdue) = 4
    expect(k.critical).toBe(4);
    // warning: esc-L3(~100), loan-LN1(~120) = 2
    expect(k.warning).toBe(2);
    // this-quarter (<90d incl overdue): L1, L2, INS1, INS2 = 4
    expect(k.thisQuarter).toBe(4);
    expect(k.next12mo).toBe(events.length);
  });
});

describe('calendar urgency is single-sourced from ALERT_THRESHOLDS', () => {
  it('uses the lease alert cutoffs (60 / 180)', () => {
    expect(ALERT_THRESHOLDS.leaseCriticalDays).toBe(60);
    expect(ALERT_THRESHOLDS.leaseWarningDays).toBe(180);
  });
});
