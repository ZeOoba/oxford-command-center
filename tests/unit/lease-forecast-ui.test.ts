// tests/unit/lease-forecast-ui.test.ts — Phase 3 W2
//
// Unit tests for the pure display helpers exported from src/modules/leasing/hooks.ts.
// No React, no DOM, no network — pure functions only (matching the debt-scorecard-hooks.test.ts
// pattern).  Tests are intentionally thin: we verify the data-transform contracts that the
// component relies on, not the rendering.
//
// Covered:
//   likelihoodTone   — RenewalLikelihood → BadgeTone
//   buildSignalMap   — RenewalSignal[] → Map<string, RenewalSignal> keyed by leaseId
//   buildGapMap      — MarketRentGap[] → Map<string, MarketRentGap> keyed by leaseId
//   bucketOrder      — the canonical expiry-bucket display order
//   gapChipLabel     — MarketRentGap → display string (↑/↓/—)
import { describe, it, expect } from 'vitest';
import {
  likelihoodTone,
  buildSignalMap,
  buildGapMap,
  BUCKET_DISPLAY_ORDER,
  gapChipLabel,
} from '../../src/modules/leasing/hooks';
import type { RenewalLikelihood } from '@contracts/lease-forecast';
import type { RenewalSignal, MarketRentGap } from '@contracts/lease-forecast';

// ── Fixtures ──────────────────────────────────────────────────────────────────

function mkSignal(leaseId: string, likelihood: RenewalLikelihood): RenewalSignal {
  return {
    leaseId,
    tenantName: 'Test Tenant',
    propertyId: 'prop-1',
    propertyKey: 'Test Prop',
    annualRent: 60_000,
    sf: 10_000,
    leaseEnd: '2027-06-01',
    monthsToExpiry: 12,
    expiryBucket: '12-24m',
    tenureMonths: 24,
    renewalStage: null,
    arrearsUsd: 0,
    monthToMonth: false,
    likelihood,
    rationale: 'test rationale',
  };
}

function mkGap(leaseId: string, overrides: Partial<MarketRentGap> = {}): MarketRentGap {
  return {
    leaseId,
    tenantName: 'Test Tenant',
    propertyKey: 'Test Prop',
    currentRentPsf: 5.0,
    marketRentPsf: 6.0,
    gapPsf: 1.0,
    gapAnnualUsd: 10_000,
    underMarket: true,
    provenance: 'derived',
    ...overrides,
  };
}

// ── likelihoodTone ────────────────────────────────────────────────────────────

describe('likelihoodTone', () => {
  const cases: Array<[RenewalLikelihood, string]> = [
    ['likely',    'green'],
    ['uncertain', 'neutral'],
    ['at-risk',   'amber'],
    ['lapsing',   'red'],
  ];

  it.each(cases)('%s → %s', (likelihood, expected) => {
    expect(likelihoodTone(likelihood)).toBe(expected);
  });
});

// ── buildSignalMap ────────────────────────────────────────────────────────────

describe('buildSignalMap', () => {
  it('returns an empty map for an empty array', () => {
    const m = buildSignalMap([]);
    expect(m.size).toBe(0);
  });

  it('keys the map by leaseId', () => {
    const s1 = mkSignal('lease-a', 'likely');
    const s2 = mkSignal('lease-b', 'uncertain');
    const m = buildSignalMap([s1, s2]);
    expect(m.size).toBe(2);
    expect(m.get('lease-a')).toBe(s1);
    expect(m.get('lease-b')).toBe(s2);
  });

  it('last-write wins on duplicate leaseId (defensive; data contract forbids duplicates)', () => {
    const s1 = mkSignal('dup', 'likely');
    const s2 = mkSignal('dup', 'at-risk');
    const m = buildSignalMap([s1, s2]);
    expect(m.size).toBe(1);
    expect(m.get('dup')?.likelihood).toBe('at-risk');
  });

  it('returns undefined for an unknown leaseId', () => {
    const m = buildSignalMap([mkSignal('x', 'likely')]);
    expect(m.get('does-not-exist')).toBeUndefined();
  });
});

// ── buildGapMap ───────────────────────────────────────────────────────────────

describe('buildGapMap', () => {
  it('returns an empty map for an empty array', () => {
    expect(buildGapMap([]).size).toBe(0);
  });

  it('keys the map by leaseId', () => {
    const g1 = mkGap('lease-1');
    const g2 = mkGap('lease-2', { provenance: 'absent', underMarket: false, gapPsf: null, gapAnnualUsd: null, marketRentPsf: null });
    const m = buildGapMap([g1, g2]);
    expect(m.get('lease-1')).toBe(g1);
    expect(m.get('lease-2')).toBe(g2);
  });

  it('absent-provenance entries are included (they produce — in the column)', () => {
    const g = mkGap('abc', { provenance: 'absent', underMarket: false, gapPsf: null, gapAnnualUsd: null, marketRentPsf: null });
    const m = buildGapMap([g]);
    expect(m.has('abc')).toBe(true);
  });
});

// ── BUCKET_DISPLAY_ORDER ──────────────────────────────────────────────────────

describe('BUCKET_DISPLAY_ORDER', () => {
  it('has exactly 4 active horizon buckets (expired and unknown are not shown as cards)', () => {
    expect(BUCKET_DISPLAY_ORDER).toHaveLength(4);
  });

  it('is ordered from soonest to latest', () => {
    expect(BUCKET_DISPLAY_ORDER[0]).toBe('0-6m');
    expect(BUCKET_DISPLAY_ORDER[1]).toBe('6-12m');
    expect(BUCKET_DISPLAY_ORDER[2]).toBe('12-24m');
    expect(BUCKET_DISPLAY_ORDER[3]).toBe('24m+');
  });
});

// ── gapChipLabel ──────────────────────────────────────────────────────────────

describe('gapChipLabel', () => {
  it('absent provenance → em-dash', () => {
    const g = mkGap('x', { provenance: 'absent', gapPsf: null, underMarket: false, marketRentPsf: null });
    expect(gapChipLabel(g)).toBe('—');
  });

  it('underMarket gap → ↓ with gap amount', () => {
    const g = mkGap('x', { underMarket: true, gapPsf: 1.50 });
    const label = gapChipLabel(g);
    expect(label).toContain('↓');
    expect(label).toContain('1.50');
  });

  it('above-market (negative gap) → ↑ with abs amount', () => {
    const g = mkGap('x', { underMarket: false, gapPsf: -1.25, currentRentPsf: 7.0, marketRentPsf: 5.75, provenance: 'derived' });
    const label = gapChipLabel(g);
    expect(label).toContain('↑');
    expect(label).toContain('1.25');
  });

  it('at-market (gapPsf ~0) and market present → ↑ (not under-market)', () => {
    const g = mkGap('x', { underMarket: false, gapPsf: 0, provenance: 'derived', marketRentPsf: 5.0, currentRentPsf: 5.0 });
    const label = gapChipLabel(g);
    // at or above market — should show ↑ (not under)
    expect(label).not.toContain('↓');
    expect(label).toContain('↑');
  });

  it('null gapPsf with non-absent provenance → em-dash (defensive)', () => {
    const g = mkGap('x', { gapPsf: null, provenance: 'real', underMarket: false });
    expect(gapChipLabel(g)).toBe('—');
  });
});
