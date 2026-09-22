import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot, Lease, TenantArrears } from '@contracts/index';
import { evaluateConditions } from '@analytics/index';

const ASOF = '2026-06-20';
const NOW = Date.parse('2026-06-20T12:00:00.000Z');
const opts = { now: NOW };

function snap(over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  const base = {
    meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: '2026-06-20T00:00:00.000Z', source: 't', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: ASOF },
    properties: [], leases: [], loans: [], deals: [], insurance: [], tasks: [], counterparties: [],
    renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, quickbooks: null, dataQuality: [],
    tenantArrears: {},
    acquisitionInputs: {},
    cash: { asOf: ASOF, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
  };
  return { ...base, ...over } as unknown as PortfolioSnapshot;
}

const baseLease: Lease = {
  id: 'l1', propertyKey: 'Prop A', propertyId: 'p1', tenantName: 'Tenant A', unit: null, company: 'Acme Co',
  sf: 1000, monthlyRent: 1000, rentPerSf: null, leaseStart: null, leaseEnd: null, escalationDate: null,
  escalationPct: null, status: 'Active', annualRent: 12000, monthsToExpiry: null, flags: [],
};

function arrearsWithAsOf(asOfDate: Date | null | undefined): TenantArrears {
  // undefined = field omitted entirely (legacy/pre-Track-B record, bypasses staleness gate).
  // null or Date = field present (Track-B-stamped record, subject to staleness check).
  if (asOfDate === undefined) {
    return { d30: 8000, d60: 0, d90: 0, d90plus: 0, sourceFile: null };
  }
  return { d30: 8000, d60: 0, d90: 0, d90plus: 0, asOfDate, sourceFile: null };
}

describe('evaluateConditions — stale-ar degradation', () => {
  it('null asOfDate → stale-ar info insight, no arrears severity alert', () => {
    const out = evaluateConditions(snap({
      leases: [baseLease],
      tenantArrears: { l1: arrearsWithAsOf(null) },
    }), opts);
    expect(out.some((i) => i.id === 'arrears-l1')).toBe(false);
    const stale = out.find((i) => i.id === 'ar-stale');
    expect(stale).toBeDefined();
    expect(stale?.severity).toBe('info');
    expect(stale?.category).toBe('data');
    expect(stale?.detail).toMatch(/no import on record/i);
  });

  it('asOfDate 36 days ago → stale-ar info insight, no arrears severity alert', () => {
    const staleDate = new Date(NOW - 36 * 86_400_000);
    const out = evaluateConditions(snap({
      leases: [baseLease],
      tenantArrears: { l1: arrearsWithAsOf(staleDate) },
    }), opts);
    expect(out.some((i) => i.id === 'arrears-l1')).toBe(false);
    const stale = out.find((i) => i.id === 'ar-stale');
    expect(stale).toBeDefined();
    expect(stale?.severity).toBe('info');
    expect(stale?.detail).toMatch(/36 days ago/i);
  });

  it('asOfDate 34 days ago → live condition fires normally (warning for material under-60 balance)', () => {
    const freshDate = new Date(NOW - 34 * 86_400_000);
    const out = evaluateConditions(snap({
      leases: [baseLease],
      tenantArrears: { l1: arrearsWithAsOf(freshDate) },
    }), opts);
    expect(out.some((i) => i.id === 'ar-stale')).toBe(false);
    const arrears = out.find((i) => i.id === 'arrears-l1');
    expect(arrears).toBeDefined();
    expect(arrears?.severity).toBe('warning');
  });

  it('asOfDate today → live condition fires normally', () => {
    const todayDate = new Date(NOW);
    const out = evaluateConditions(snap({
      leases: [baseLease],
      tenantArrears: { l1: arrearsWithAsOf(todayDate) },
    }), opts);
    expect(out.some((i) => i.id === 'ar-stale')).toBe(false);
    const arrears = out.find((i) => i.id === 'arrears-l1');
    expect(arrears).toBeDefined();
    expect(arrears?.severity).toBe('warning');
  });

  it('asOfDate exactly 35 days ago → still live (boundary: stale starts at >35)', () => {
    const borderDate = new Date(NOW - 35 * 86_400_000);
    const out = evaluateConditions(snap({
      leases: [baseLease],
      tenantArrears: { l1: arrearsWithAsOf(borderDate) },
    }), opts);
    expect(out.some((i) => i.id === 'ar-stale')).toBe(false);
    expect(out.find((i) => i.id === 'arrears-l1')).toBeDefined();
  });

  it('no tenantArrears records at all → no stale-ar insight (absence of data is not staleness)', () => {
    const out = evaluateConditions(snap({ leases: [baseLease] }), opts);
    expect(out.some((i) => i.id === 'ar-stale')).toBe(false);
    expect(out.some((i) => i.id === 'arrears-l1')).toBe(false);
  });

  it('stale-ar fires once even with multiple leases all having stale asOfDate', () => {
    const staleDate = new Date(NOW - 40 * 86_400_000);
    const lease2: Lease = { ...baseLease, id: 'l2' };
    const out = evaluateConditions(snap({
      leases: [baseLease, lease2],
      tenantArrears: {
        l1: arrearsWithAsOf(staleDate),
        l2: arrearsWithAsOf(staleDate),
      },
    }), opts);
    const staleInsights = out.filter((i) => i.id === 'ar-stale');
    expect(staleInsights).toHaveLength(1);
    expect(staleInsights[0]?.detail).toMatch(/2 of 2/);
  });
});

// ── Per-lease staleness (2026-09-22) ─────────────────────────────────────────
// The gate used to be ALL-OR-NOTHING: one stale record set a single skipArEval boolean that
// suppressed every lease's collections alert in the portfolio. Under the widened dead-lease guard
// (PR #357) a zero-rent-but-Active lease with a real balance can no longer auto-refresh, so its
// record WILL cross arStalenessMaxDays — and, under the old gate, would blind every other lease's
// fresh 60+ critical. Staleness must be judged per record, for the lease it belongs to, only.
describe('evaluateConditions — stale-ar is judged PER LEASE, never portfolio-wide', () => {
  const fresh = new Date(NOW - 1 * 86_400_000);
  const stale = new Date(NOW - 40 * 86_400_000);
  const lease2: Lease = { ...baseLease, id: 'l2', tenantName: 'Tenant B', company: 'Beta LLC', propertyKey: 'Prop B' };
  // A fresh, currently-accruing 60+ delinquency — the alert that must never be suppressed.
  const freshCritical: TenantArrears = { d30: 0, d60: 0, d90: 3000, d90plus: 0, asOfDate: fresh, sourceFile: null };

  it('one stale record elsewhere in the portfolio does NOT suppress a fresh lease\'s 60+ critical', () => {
    const out = evaluateConditions(snap({
      leases: [baseLease, lease2],
      tenantArrears: { l1: freshCritical, l2: arrearsWithAsOf(stale) },
    }), opts);
    const l1 = out.find((i) => i.id === 'arrears-l1');
    expect(l1).toBeDefined();
    expect(l1?.severity).toBe('critical');
    // The stale lease itself is skipped — no severity alert built on stale buckets.
    expect(out.some((i) => i.id === 'arrears-l2')).toBe(false);
    // The aggregate notice still fires, exactly once.
    expect(out.filter((i) => i.id === 'ar-stale')).toHaveLength(1);
  });

  it('regression: a fresh lease\'s alert is byte-identical with or without a stale sibling', () => {
    const alone = evaluateConditions(snap({
      leases: [baseLease],
      tenantArrears: { l1: freshCritical },
    }), opts).find((i) => i.id === 'arrears-l1');
    const withStaleSibling = evaluateConditions(snap({
      leases: [baseLease, lease2],
      tenantArrears: { l1: freshCritical, l2: arrearsWithAsOf(stale) },
    }), opts).find((i) => i.id === 'arrears-l1');
    expect(alone).toBeDefined();
    expect(withStaleSibling).toEqual(alone);
  });

  it('a fresh material under-60 warning also survives a stale sibling (same severity, same message)', () => {
    const alone = evaluateConditions(snap({
      leases: [baseLease],
      tenantArrears: { l1: arrearsWithAsOf(fresh) },
    }), opts).find((i) => i.id === 'arrears-l1');
    const withStaleSibling = evaluateConditions(snap({
      leases: [baseLease, lease2],
      tenantArrears: { l1: arrearsWithAsOf(fresh), l2: arrearsWithAsOf(stale) },
    }), opts).find((i) => i.id === 'arrears-l1');
    expect(alone?.severity).toBe('warning');
    expect(withStaleSibling).toEqual(alone);
  });

  it('a null-asOfDate record suppresses only its own lease', () => {
    const out = evaluateConditions(snap({
      leases: [baseLease, lease2],
      tenantArrears: { l1: freshCritical, l2: arrearsWithAsOf(null) },
    }), opts);
    expect(out.find((i) => i.id === 'arrears-l1')?.severity).toBe('critical');
    expect(out.some((i) => i.id === 'arrears-l2')).toBe(false);
    expect(out.find((i) => i.id === 'ar-stale')?.detail).toMatch(/no import on record/i);
  });

  it('a legacy (unstamped) record still evaluates normally next to a stale stamped one', () => {
    const out = evaluateConditions(snap({
      leases: [baseLease, lease2],
      tenantArrears: { l1: arrearsWithAsOf(undefined), l2: arrearsWithAsOf(stale) },
    }), opts);
    expect(out.find((i) => i.id === 'arrears-l1')?.severity).toBe('warning');
    expect(out.some((i) => i.id === 'arrears-l2')).toBe(false);
  });

  it('a lease with NO record produces nothing, even when another lease\'s record is stale', () => {
    const out = evaluateConditions(snap({
      leases: [baseLease, lease2],
      tenantArrears: { l2: arrearsWithAsOf(stale) },
    }), opts);
    expect(out.some((i) => i.id === 'arrears-l1')).toBe(false);
    expect(out.some((i) => i.id === 'arrears-l2')).toBe(false);
    expect(out.filter((i) => i.id === 'ar-stale')).toHaveLength(1);
  });

  it('the aggregate ar-stale notice reports the stale count, worst age and affected leases — not a blackout', () => {
    const out = evaluateConditions(snap({
      leases: [baseLease, lease2],
      tenantArrears: { l1: freshCritical, l2: arrearsWithAsOf(stale) },
    }), opts);
    const notice = out.find((i) => i.id === 'ar-stale');
    expect(notice?.severity).toBe('info');
    expect(notice?.category).toBe('data');
    expect(notice?.metric).toBe('1/2');
    expect(notice?.detail).toMatch(/1 of 2/);
    expect(notice?.detail).toMatch(/40 days ago/);
    expect(notice?.detail).toContain('Beta LLC');
    expect(notice?.detail).not.toContain('Acme Co');
    expect(notice?.title).not.toMatch(/inactive/i);
  });

  it('no ar-stale notice when every stamped record is fresh', () => {
    const out = evaluateConditions(snap({
      leases: [baseLease, lease2],
      tenantArrears: { l1: freshCritical, l2: arrearsWithAsOf(fresh) },
    }), opts);
    expect(out.some((i) => i.id === 'ar-stale')).toBe(false);
    expect(out.find((i) => i.id === 'arrears-l1')?.severity).toBe('critical');
    expect(out.find((i) => i.id === 'arrears-l2')?.severity).toBe('warning');
  });
});
