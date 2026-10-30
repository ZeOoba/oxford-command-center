// tests/unit/property-page-model.test.ts
//
// Roadmap 2.2: the canonical /property/:id page model. Ledger series (P&L basis), the rollover
// ladder with the rent-gap column (manual → indicative feed → not yet sourced, ruling 2026-10-30)
// and the property's open alerts.
import { describe, expect, it } from 'vitest';
import type { Lease } from '@contracts/index';
import type { MarketRentGap } from '@contracts/lease-forecast';
import type { AlertViewItem } from '../../src/brain/alerts-view';
import {
  bucketOf,
  ledgerMonths,
  monthEndIso,
  pfEntityFor,
  propertyAlerts,
  propertyPageHref,
  propertyPagePath,
  rollingT12,
  rolloverLadder,
} from '../../src/modules/property/property-page-model';

const fig = (noi: number) => ({ noi, revenue: noi + 100, opex: 100, base_rent: noi + 50 });

function lease(over: Partial<Lease>): Lease {
  return {
    id: 'L1',
    propertyKey: '1100 Rarig',
    propertyId: 'p1',
    tenantName: 'Acme',
    unit: 'A',
    company: null,
    sf: 1000,
    monthlyRent: 1000,
    rentPerSf: 12,
    leaseStart: '2024-01-01',
    leaseEnd: '2027-01-31',
    escalationDate: null,
    escalationPct: null,
    status: 'Active',
    annualRent: 12000,
    monthsToExpiry: 15,
    flags: [],
    ...over,
  };
}

function gap(over: Partial<MarketRentGap>): MarketRentGap {
  return {
    leaseId: 'L1',
    tenantName: 'Acme',
    propertyKey: '1100 Rarig',
    currentRentPsf: 12,
    marketRentPsf: null,
    gapPsf: null,
    gapAnnualUsd: null,
    underMarket: false,
    provenance: 'absent',
    ...over,
  };
}

describe('propertyPagePath', () => {
  it('encodes the id', () => {
    expect(propertyPagePath('a b/c')).toBe('/property/a%20b%2Fc');
  });
});

describe('monthEndIso', () => {
  it('is the last day of the month (leap-aware)', () => {
    expect(monthEndIso('2026-06')).toBe('2026-06-30');
    expect(monthEndIso('2024-02')).toBe('2024-02-29');
    expect(monthEndIso('2025-12')).toBe('2025-12-31');
  });
});

describe('propertyPageHref', () => {
  it('keeps scenario/still, drops the page-local tab, view and p', () => {
    expect(propertyPageHref('p1', '?tab=trends&view=x&p=FVC&scenario=down&still=1')).toBe('/property/p1?scenario=down&still=1');
    expect(propertyPageHref('p1', '')).toBe('/property/p1');
  });
});

describe('pfEntityFor', () => {
  it('finds the PF entity whose canonical id is the property', () => {
    expect(pfEntityFor({ '1100 Rarig': { canonicalId: 'p1' }, FVC: { canonicalId: 'p2' } }, 'p2')).toBe('FVC');
  });
  it('is null when unmapped or no block', () => {
    expect(pfEntityFor({ X: { canonicalId: null } }, 'p1')).toBeNull();
    expect(pfEntityFor(undefined, 'p1')).toBeNull();
  });
});

describe('ledgerMonths', () => {
  it('sorts months and keeps the figures', () => {
    const m = ledgerMonths({ '2025-02': fig(2), '2025-01': fig(1) });
    expect(m.map((x) => x.month)).toEqual(['2025-01', '2025-02']);
    expect(m[1]).toEqual({ month: '2025-02', noi: 2, revenue: 102, opex: 100, baseRent: 52 });
  });
  it('is empty with no cube (annual-only entity)', () => {
    expect(ledgerMonths(undefined)).toEqual([]);
  });
});

describe('rollingT12', () => {
  const months = (n: number, start = 2024) =>
    Array.from({ length: n }, (_, i) => {
      const y = start + Math.floor(i / 12);
      const mo = String((i % 12) + 1).padStart(2, '0');
      return { month: `${y}-${mo}`, noi: 10, revenue: 0, opex: 0, baseRent: 0 };
    });

  it('sums each window of 12 consecutive months', () => {
    const r = rollingT12(months(14));
    expect(r).toHaveLength(3);
    expect(r[0]).toEqual({ month: '2024-12', value: 120 });
    expect(r[2]).toEqual({ month: '2025-02', value: 120 });
  });

  it('never bridges a missing month', () => {
    const m = months(14).filter((x) => x.month !== '2024-06');
    // Windows that include the June gap are dropped; none of 12 consecutive exist before 2025-06.
    expect(rollingT12(m)).toEqual([]);
  });

  it('is empty under 12 months', () => {
    expect(rollingT12(months(11))).toEqual([]);
  });
});

describe('bucketOf', () => {
  it.each([
    [-2, 'past'],
    [0, '0-12'],
    [12, '0-12'],
    [13, '13-24'],
    [24, '13-24'],
    [36, '25-36'],
    [37, '37+'],
    [null, 'no-date'],
  ] as const)('%s months → %s', (m, b) => {
    expect(bucketOf(m)).toBe(b);
  });
});

describe('rolloverLadder', () => {
  it('keeps only this property, drops vacant rows, sorts by expiry', () => {
    const rows = rolloverLadder(
      [
        lease({ id: 'L1', monthsToExpiry: 30 }),
        lease({ id: 'L2', monthsToExpiry: 3 }),
        lease({ id: 'L3', propertyId: 'other' }),
        lease({ id: 'L4', status: 'Vacant' }),
        lease({ id: 'L5', monthsToExpiry: null, leaseEnd: null }),
      ],
      'p1',
      [],
    );
    expect(rows.map((r) => r.leaseId)).toEqual(['L2', 'L1', 'L5']);
    expect(rows.map((r) => r.bucket)).toEqual(['0-12', '25-36', 'no-date']);
  });

  it('shows an expired-but-listed lease in the past bucket rather than hiding it', () => {
    const [r] = rolloverLadder([lease({ status: 'Expired', monthsToExpiry: -4 })], 'p1', []);
    expect(r!.bucket).toBe('past');
  });

  it('rent gap: manual, indicative feed, or not yet sourced — never invented', () => {
    const rows = rolloverLadder(
      [lease({ id: 'L1' }), lease({ id: 'L2' }), lease({ id: 'L3' })],
      'p1',
      [
        gap({ leaseId: 'L1', provenance: 'derived', marketRentPsf: 14, gapAnnualUsd: 2000 }),
        gap({ leaseId: 'L2', provenance: 'derived-asking', marketRentPsf: 13, gapAnnualUsd: 1000 }),
        gap({ leaseId: 'L3', provenance: 'absent' }),
      ],
    );
    expect(rows[0]!.market).toEqual({ kind: 'manual', psf: 14, gapAnnualUsd: 2000 });
    expect(rows[1]!.market).toEqual({ kind: 'indicative', psf: 13, gapAnnualUsd: 1000 });
    expect(rows[2]!.market).toEqual({ kind: 'not-sourced', psf: null, gapAnnualUsd: null });
  });

  it('a lease with no gap record reads not yet sourced', () => {
    const [r] = rolloverLadder([lease({})], 'p1', []);
    expect(r!.market.kind).toBe('not-sourced');
  });
});

describe('propertyAlerts', () => {
  const item = (id: string, entityType?: 'property' | 'lease' | 'loan', entityId?: string): AlertViewItem => ({
    insight: {
      id,
      severity: 'warning',
      category: 'lease',
      title: id,
      detail: '',
      entityType,
      entityId,
      impactAnnualUsd: null,
      spine: 'A',
      provenance: 'real',
    },
    read: false,
    snoozedUntil: null,
  });

  it('keeps alerts on the property or on one of its leases', () => {
    const out = propertyAlerts(
      [item('a', 'property', 'p1'), item('b', 'lease', 'L1'), item('c', 'lease', 'L9'), item('d', 'property', 'p2'), item('e')],
      'p1',
      new Set(['L1']),
    );
    expect(out.map((i) => i.insight.id)).toEqual(['a', 'b']);
  });
});
