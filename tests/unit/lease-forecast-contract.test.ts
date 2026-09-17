// tests/unit/lease-forecast-contract.test.ts — Phase 3 W1 Step 2
// TDD: contract round-trip parse + rejection tests for all lease-forecast schemas.
import { describe, it, expect } from 'vitest';
import {
  ExpiryBucket,
  RenewalLikelihood,
  RenewalSignal,
  LeasingVelocity,
  RentForecastInput,
  RentForecastResult,
  MarketRentGap,
  ExpiryBucketSummary,
  LeaseForecastResponse,
  RentForecastResponse,
  LeaseForecastSummary,
} from '@contracts/lease-forecast';

// ── ExpiryBucket ─────────────────────────────────────────────────────────────
describe('ExpiryBucket', () => {
  it('parses all valid values', () => {
    const values = ['0-6m', '6-12m', '12-24m', '24m+', 'expired', 'unknown'] as const;
    for (const v of values) {
      expect(ExpiryBucket.parse(v)).toBe(v);
    }
  });
  it('throws on invalid value', () => {
    expect(() => ExpiryBucket.parse('bad')).toThrow();
  });
});

// ── RenewalLikelihood ─────────────────────────────────────────────────────────
describe('RenewalLikelihood', () => {
  it('parses all valid values', () => {
    const values = ['likely', 'uncertain', 'at-risk', 'lapsing'] as const;
    for (const v of values) {
      expect(RenewalLikelihood.parse(v)).toBe(v);
    }
  });
  it('throws on invalid value', () => {
    expect(() => RenewalLikelihood.parse('unknown')).toThrow();
  });
});

// ── RenewalSignal ─────────────────────────────────────────────────────────────
const validSignal = {
  leaseId: 'l1',
  tenantName: 'Acme',
  propertyId: 'p1',
  propertyKey: 'Prop One',
  annualRent: 24000,
  sf: 2000,
  leaseEnd: '2026-12-31',
  monthsToExpiry: 6,
  expiryBucket: '0-6m',
  tenureMonths: 36,
  renewalStage: 'LOI',
  arrearsUsd: 0,
  monthToMonth: false,
  likelihood: 'likely',
  rationale: 'LOI in hand',
} as const;

describe('RenewalSignal', () => {
  it('parses a valid signal', () => {
    const out = RenewalSignal.parse(validSignal);
    expect(out.leaseId).toBe('l1');
    expect(out.likelihood).toBe('likely');
  });
  it('requires leaseId', () => {
    expect(() => RenewalSignal.parse({ ...validSignal, leaseId: undefined })).toThrow();
  });
  it('requires non-negative annualRent', () => {
    expect(() => RenewalSignal.parse({ ...validSignal, annualRent: -1 })).toThrow();
  });
  it('allows null propertyId', () => {
    const out = RenewalSignal.parse({ ...validSignal, propertyId: null });
    expect(out.propertyId).toBeNull();
  });
  it('allows null leaseEnd', () => {
    const out = RenewalSignal.parse({ ...validSignal, leaseEnd: null });
    expect(out.leaseEnd).toBeNull();
  });
  it('allows null renewalStage', () => {
    const out = RenewalSignal.parse({ ...validSignal, renewalStage: null });
    expect(out.renewalStage).toBeNull();
  });
  it('rejects invalid renewalStage', () => {
    expect(() => RenewalSignal.parse({ ...validSignal, renewalStage: 'BadStage' })).toThrow();
  });
  it('rejects invalid expiryBucket', () => {
    expect(() => RenewalSignal.parse({ ...validSignal, expiryBucket: '99m' })).toThrow();
  });
  it('all required fields present in type', () => {
    const out = RenewalSignal.parse(validSignal);
    expect(out).toHaveProperty('leaseId');
    expect(out).toHaveProperty('likelihood');
    expect(out).toHaveProperty('rationale');
    expect(out).toHaveProperty('monthToMonth');
    expect(out).toHaveProperty('arrearsUsd');
  });
});

// ── LeasingVelocity ───────────────────────────────────────────────────────────
describe('LeasingVelocity', () => {
  it('parses with null medianDaysToLease', () => {
    const out = LeasingVelocity.parse({
      propertyId: 'p1',
      propertyName: 'Prop One',
      medianDaysToLease: null,
      leasingEventsN: 0,
      slowLeasing: false,
    });
    expect(out.medianDaysToLease).toBeNull();
  });
  it('parses with a numeric median', () => {
    const out = LeasingVelocity.parse({
      propertyId: 'p1',
      propertyName: 'Prop One',
      medianDaysToLease: 90,
      leasingEventsN: 2,
      slowLeasing: false,
    });
    expect(out.medianDaysToLease).toBe(90);
    expect(out.leasingEventsN).toBe(2);
  });
  it('rejects negative leasingEventsN', () => {
    expect(() => LeasingVelocity.parse({
      propertyId: 'p1', propertyName: 'X', medianDaysToLease: null, leasingEventsN: -1, slowLeasing: false,
    })).toThrow();
  });
});

// ── RentForecastInput ─────────────────────────────────────────────────────────
describe('RentForecastInput', () => {
  it('defaults horizonMonths to 12', () => {
    const out = RentForecastInput.parse({ scenario: 'renew_at_current' });
    expect(out.horizonMonths).toBe(12);
  });
  it('defaults vacancyPct to 0', () => {
    const out = RentForecastInput.parse({ scenario: 'vacancy_haircut' });
    expect(out.vacancyPct).toBe(0);
  });
  it('accepts horizonMonths 6', () => {
    const out = RentForecastInput.parse({ scenario: 'renew_at_current', horizonMonths: 6 });
    expect(out.horizonMonths).toBe(6);
  });
  it('accepts horizonMonths 24', () => {
    const out = RentForecastInput.parse({ scenario: 'renew_at_current', horizonMonths: 24 });
    expect(out.horizonMonths).toBe(24);
  });
  it('rejects invalid horizonMonths', () => {
    expect(() => RentForecastInput.parse({ scenario: 'renew_at_current', horizonMonths: 18 })).toThrow();
  });
  it('rejects vacancyPct > 1', () => {
    expect(() => RentForecastInput.parse({ scenario: 'vacancy_haircut', vacancyPct: 2 })).toThrow();
  });
  it('rejects vacancyPct < 0', () => {
    expect(() => RentForecastInput.parse({ scenario: 'vacancy_haircut', vacancyPct: -0.1 })).toThrow();
  });
});

// ── RentForecastResult ────────────────────────────────────────────────────────
const validResult = {
  scenario: 'renew_at_current' as const,
  horizonMonths: 12,
  inPlaceAnnualRent: 100000,
  projectedAnnualRent: 100000,
  deltaUsd: 0,
  noiImpactAnnualUsd: 0,
  expiringRentInHorizon: 20000,
  spine: 'A' as const,
  assumptions: ['No change scenario'],
};

describe('RentForecastResult', () => {
  it('parses a valid result', () => {
    const out = RentForecastResult.parse(validResult);
    expect(out.scenario).toBe('renew_at_current');
    expect(out.spine).toBe('A');
  });
  it('requires spine === A', () => {
    expect(() => RentForecastResult.parse({ ...validResult, spine: 'B' })).toThrow();
  });
  it('requires assumptions array', () => {
    expect(() => RentForecastResult.parse({ ...validResult, assumptions: undefined })).toThrow();
  });
  it('allows negative deltaUsd (downside scenario)', () => {
    const out = RentForecastResult.parse({ ...validResult, deltaUsd: -50000, noiImpactAnnualUsd: -50000, projectedAnnualRent: 50000 });
    expect(out.deltaUsd).toBe(-50000);
  });
  it('rejects negative inPlaceAnnualRent', () => {
    expect(() => RentForecastResult.parse({ ...validResult, inPlaceAnnualRent: -1 })).toThrow();
  });
});

// ── MarketRentGap ─────────────────────────────────────────────────────────────
describe('MarketRentGap', () => {
  it('parses with null market rent (absent case)', () => {
    const out = MarketRentGap.parse({
      leaseId: 'l1',
      tenantName: 'Acme',
      propertyKey: 'Prop One',
      currentRentPsf: 5.0,
      marketRentPsf: null,
      gapPsf: null,
      gapAnnualUsd: null,
      underMarket: false,
      provenance: 'absent',
    });
    expect(out.provenance).toBe('absent');
    expect(out.underMarket).toBe(false);
  });
  it('parses with valid market rent', () => {
    const out = MarketRentGap.parse({
      leaseId: 'l1',
      tenantName: 'Acme',
      propertyKey: 'Prop One',
      currentRentPsf: 5.0,
      marketRentPsf: 6.0,
      gapPsf: 1.0,
      gapAnnualUsd: 10000,
      underMarket: true,
      provenance: 'derived',
    });
    expect(out.underMarket).toBe(true);
    expect(out.gapPsf).toBe(1.0);
  });
  it('rejects invalid provenance', () => {
    expect(() => MarketRentGap.parse({
      leaseId: 'l1', tenantName: 'X', propertyKey: 'X',
      currentRentPsf: null, marketRentPsf: null, gapPsf: null,
      gapAnnualUsd: null, underMarket: false, provenance: 'unknown',
    })).toThrow();
  });
  it('accepts provenance derived-asking (lease-market asking-rent feed fallback)', () => {
    const out = MarketRentGap.parse({
      leaseId: 'l1',
      tenantName: 'Acme',
      propertyKey: 'Prop One',
      currentRentPsf: 7.5,
      marketRentPsf: 9.3,
      gapPsf: 1.8,
      gapAnnualUsd: 14400,
      underMarket: true,
      provenance: 'derived-asking',
    });
    expect(out.provenance).toBe('derived-asking');
  });
});

// ── ExpiryBucketSummary ───────────────────────────────────────────────────────
describe('ExpiryBucketSummary', () => {
  it('parses a valid bucket summary', () => {
    const out = ExpiryBucketSummary.parse({
      bucket: '0-6m',
      count: 3,
      annualRentAtRisk: 50000,
      pctOfTotal: 0.15,
    });
    expect(out.bucket).toBe('0-6m');
    expect(out.count).toBe(3);
  });
  it('rejects negative count', () => {
    expect(() => ExpiryBucketSummary.parse({
      bucket: '0-6m', count: -1, annualRentAtRisk: 0, pctOfTotal: 0,
    })).toThrow();
  });
});

// ── LeaseForecastResponse ─────────────────────────────────────────────────────
describe('LeaseForecastResponse', () => {
  it('parses empty arrays', () => {
    const out = LeaseForecastResponse.parse({
      asOf: '2026-06-21',
      signals: [],
      velocity: [],
      marketGaps: [],
      bucketTotals: [],
    });
    expect(out.asOf).toBe('2026-06-21');
    expect(out.signals).toHaveLength(0);
  });
});

// ── RentForecastResponse ──────────────────────────────────────────────────────
describe('RentForecastResponse', () => {
  it('parses valid response', () => {
    const out = RentForecastResponse.parse({
      asOf: '2026-06-21',
      results: [validResult],
    });
    expect(out.results).toHaveLength(1);
  });
});

// ── LeaseForecastSummary ──────────────────────────────────────────────────────
describe('LeaseForecastSummary', () => {
  it('parses a valid summary', () => {
    const out = LeaseForecastSummary.parse({
      asOf: '2026-06-21',
      renewalSignals: [validSignal],
      expiryBuckets: [],
      marketRentGaps: [],
      rentForecast: [validResult],
      totalAnnualRent: 100000,
    });
    expect(out.totalAnnualRent).toBe(100000);
  });
  it('requires all fields', () => {
    expect(() => LeaseForecastSummary.parse({ asOf: '2026-06-21' })).toThrow();
  });
});
