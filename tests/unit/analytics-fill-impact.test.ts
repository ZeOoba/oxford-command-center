import { describe, it, expect } from 'vitest';
import type { Insight } from '@analytics/types';
import { fillImpact } from '@analytics/conditions';
import type { PortfolioSnapshot } from '@contracts/index';

function baseInsight(overrides: Partial<Insight> = {}): Insight {
  return {
    id: 'test-1',
    severity: 'warning',
    category: 'collections',
    title: 'Test',
    detail: 'Test detail',
    impactAnnualUsd: null,
    spine: 'B',
    provenance: 'absent',
    ...overrides,
  };
}

const emptySnapshot = {
  leases: [],
  loans: [],
  properties: [],
  insurance: [],
  deals: [],
  meta: { asOf: '2026-01-01', generatedAt: new Date().toISOString(), source: 'test' },
  renewalStages: {},
  tenantNotes: {},
  marketComps: {},
  acquisitionInputs: {},
  noiBudgets: {},
  tenantArrears: {},
  cash: { concentrationTopPct: null, largestEntity: null },
  dataQuality: [],
} as unknown as PortfolioSnapshot;

describe('fillImpact', () => {
  it('returns a new object (does not mutate input)', () => {
    const insight = baseInsight();
    const result = fillImpact(insight, emptySnapshot);
    expect(result).not.toBe(insight);
  });

  it('collections category gets spine A + dollar amount from arrears context', () => {
    const arrearLeaseId = 'lease-abc';
    const snapshot = {
      ...emptySnapshot,
      tenantArrears: {
        [arrearLeaseId]: { d30: 0, d60: 0, d90: 3000, d90plus: 2000 },
      },
    } as unknown as PortfolioSnapshot;

    const insight = baseInsight({
      id: `arrears-${arrearLeaseId}`,
      category: 'collections',
      severity: 'critical',
      entityId: arrearLeaseId,
      entityType: 'lease',
    });

    const result = fillImpact(insight, snapshot);
    expect(result.spine).toBe('A');
    expect(result.impactAnnualUsd).toBeGreaterThan(0);
    expect(result.provenance).toBe('real');
  });

  it('insurance (capex/compliance) category gets spine B', () => {
    const insight = baseInsight({ category: 'insurance', severity: 'critical' });
    const result = fillImpact(insight, emptySnapshot);
    expect(result.spine).toBe('B');
  });

  it('unknown category type gets null impact and spine B', () => {
    const insight = baseInsight({ category: 'data' });
    const result = fillImpact(insight, emptySnapshot);
    expect(result.spine).toBe('B');
    expect(result.impactAnnualUsd).toBeNull();
  });

  it('occupancy category gets spine A', () => {
    const insight = baseInsight({ category: 'occupancy' } as Partial<Insight>);
    const result = fillImpact(insight, emptySnapshot);
    expect(result.spine).toBe('A');
  });

  it('lease category gets spine A with annualRent from matching lease', () => {
    const leaseId = 'lease-xyz';
    const snapshot = {
      ...emptySnapshot,
      leases: [
        {
          id: leaseId,
          annualRent: 48000,
          company: 'ACME',
          tenantName: 'ACME',
          propertyKey: 'P1',
          unit: null,
          status: 'Active',
          leaseEnd: '2026-09-01',
          escalationDate: null,
        },
      ],
    } as unknown as PortfolioSnapshot;

    const insight = baseInsight({
      category: 'lease',
      entityId: leaseId,
      entityType: 'lease',
    });

    const result = fillImpact(insight, snapshot);
    expect(result.spine).toBe('A');
    expect(result.impactAnnualUsd).toBe(48000);
    expect(result.provenance).toBe('real');
  });

  it('debt category gets spine B', () => {
    const insight = baseInsight({ category: 'debt' });
    const result = fillImpact(insight, emptySnapshot);
    expect(result.spine).toBe('B');
  });

  it('concentration category gets spine A', () => {
    const insight = baseInsight({ category: 'concentration' });
    const result = fillImpact(insight, emptySnapshot);
    expect(result.spine).toBe('A');
  });
});
