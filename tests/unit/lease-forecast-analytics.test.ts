// tests/unit/lease-forecast-analytics.test.ts — Phase 3 W1 Step 3
// TDD: analytics engine test cases L-A1 through L-A9 from spec §9.
import { describe, it, expect } from 'vitest';
import type { Lease } from '@contracts/index';
import {
  bucketExpiry,
  renewalSignals,
  marketRentGaps,
  rentForecast,
} from '@analytics/lease-forecast';
import { RentForecastInput } from '@contracts/lease-forecast';

// ── Fixtures ─────────────────────────────────────────────────────────────────
const ASOF = '2026-06-21';
const ALERT_ARREARS_MATERIAL = 5000; // mirrors ALERT_THRESHOLDS.arrearsMaterialUsd

function mkLease(o: Partial<Lease> & { id: string }): Lease {
  return {
    propertyKey: 'Prop One',
    propertyId: 'p1',
    tenantName: 'Tenant',
    unit: null,
    company: null,
    sf: 10000,
    monthlyRent: 0,
    rentPerSf: 5.0,
    leaseStart: '2023-06-21',
    leaseEnd: '2027-06-21',
    escalationDate: null,
    escalationPct: null,
    status: 'Active',
    annualRent: 60000,
    monthsToExpiry: 24,
    flags: [],
    ...o,
  };
}

function isoOffset(asOf: string, months: number): string {
  const d = new Date(asOf);
  d.setMonth(d.getMonth() + months);
  return d.toISOString().slice(0, 10);
}

// ── L-A1: bucketExpiry ────────────────────────────────────────────────────────
describe('L-A1: bucketExpiry', () => {
  it('3 months → 0-6m', () => {
    expect(bucketExpiry(3, '2026-09-21')).toBe('0-6m');
  });
  it('0 months → 0-6m', () => {
    expect(bucketExpiry(0, ASOF)).toBe('0-6m');
  });
  it('6 months exactly → 6-12m (exclusive lower bound)', () => {
    // 6 is > 6? No — per spec: 0-6 means 0..6, so 6 should be in 6-12m.
    // The spec says "0–6 → '0-6m', 6–12 → '6-12m'" — we interpret 6 exclusive:
    // bucketExpiry(6) should be 6-12m since 6 is the boundary start of the next bucket.
    expect(bucketExpiry(6, '2026-12-21')).toBe('6-12m');
  });
  it('9 months → 6-12m', () => {
    expect(bucketExpiry(9, '2027-03-21')).toBe('6-12m');
  });
  it('12 months → 12-24m', () => {
    expect(bucketExpiry(12, '2027-06-21')).toBe('12-24m');
  });
  it('18 months → 12-24m', () => {
    expect(bucketExpiry(18, '2027-12-21')).toBe('12-24m');
  });
  it('30 months → 24m+', () => {
    expect(bucketExpiry(30, '2028-12-21')).toBe('24m+');
  });
  it('null monthsToExpiry → unknown', () => {
    expect(bucketExpiry(null, null)).toBe('unknown');
  });
  it('negative monthsToExpiry → expired', () => {
    expect(bucketExpiry(-1, '2026-05-21')).toBe('expired');
  });
  it('NaN monthsToExpiry → unknown', () => {
    expect(bucketExpiry(NaN, null)).toBe('unknown');
  });
  it('24 months → 24m+', () => {
    // 24 is the boundary — spec says ">24" for 24m+, so 24 itself is 12-24m
    expect(bucketExpiry(24, '2028-06-21')).toBe('12-24m');
  });
  it('25 months → 24m+', () => {
    expect(bucketExpiry(25, '2028-07-21')).toBe('24m+');
  });
  // Regression: calendar-month truncation — differenceInCalendarMonths returns 0 for a lease
  // that expired earlier this calendar month AND one expiring later this month. Without the asOf
  // guard both would be classified '0-6m' instead of 'expired'.
  it('expired earlier this calendar month (monthsToExpiry=0 truncation) → expired when asOf provided', () => {
    expect(bucketExpiry(0, '2026-06-01', '2026-06-21')).toBe('expired');
  });
  it('expires later this calendar month (monthsToExpiry=0) → 0-6m when asOf provided', () => {
    expect(bucketExpiry(0, '2026-06-30', '2026-06-21')).toBe('0-6m');
  });
  it('without asOf: monthsToExpiry=0 still returns 0-6m (backward-compat; no date info)', () => {
    expect(bucketExpiry(0, null)).toBe('0-6m');
  });
});

// ── L-A2: renewalSignals — tenure ≥ 36m + no arrears + ≤ 12m → likely ────────
describe('L-A2: renewalSignals — likely by tenure', () => {
  it('tenure ≥36m, no arrears, ≤12m expiry → likely', () => {
    const lease = mkLease({
      id: 'l1',
      leaseStart: '2022-06-21',    // 36+ months before asOf
      leaseEnd: isoOffset(ASOF, 9), // 9 months to expiry
      monthsToExpiry: 9,
      annualRent: 60000,
      sf: 10000,
      status: 'Active',
    });
    const signals = renewalSignals([lease], ASOF, {}, {});
    const s = signals.find((x) => x.leaseId === 'l1')!;
    expect(s).toBeDefined();
    expect(s.likelihood).toBe('likely');
    expect(s.tenureMonths).toBeGreaterThanOrEqual(36);
    expect(s.arrearsUsd).toBe(0);
  });
});

// ── L-A3: stage LOI overrides everything → likely ────────────────────────────
describe('L-A3: renewalSignals — LOI stage overrides → likely', () => {
  it('stage LOI → likely regardless of other fields', () => {
    const lease = mkLease({
      id: 'l2',
      leaseStart: '2025-01-01', // recent start — less tenure
      leaseEnd: isoOffset(ASOF, 2), // expiring soon
      monthsToExpiry: 2,
      status: 'Active',
      annualRent: 24000,
    });
    const signals = renewalSignals([lease], ASOF, { l2: 'LOI' }, { l2: { d30: 0, d60: 0, d90: 2000, d90plus: 0 } });
    const s = signals.find((x) => x.leaseId === 'l2')!;
    expect(s.likelihood).toBe('likely');
    expect(s.renewalStage).toBe('LOI');
  });
  it('stage Executed → likely', () => {
    const lease = mkLease({ id: 'l3', monthsToExpiry: 1, leaseEnd: isoOffset(ASOF, 1) });
    const signals = renewalSignals([lease], ASOF, { l3: 'Executed' }, {});
    const s = signals.find((x) => x.leaseId === 'l3')!;
    expect(s.likelihood).toBe('likely');
  });
});

// ── L-A4: holdover (leaseEnd past, status ≠ Expired) → monthToMonth + lapsing ──
describe('L-A4: renewalSignals — holdover', () => {
  it('leaseEnd past + status Active (holdover) → monthToMonth:true, lapsing', () => {
    const lease = mkLease({
      id: 'l4',
      leaseEnd: isoOffset(ASOF, -3), // 3 months in the past
      monthsToExpiry: -3,
      status: 'Active', // not Expired — holdover
      annualRent: 30000,
    });
    const signals = renewalSignals([lease], ASOF, {}, {});
    const s = signals.find((x) => x.leaseId === 'l4')!;
    expect(s.monthToMonth).toBe(true);
    expect(s.likelihood).toBe('lapsing');
  });
  it('monthToMonth = true (overlaid) → lapsing', () => {
    // If status is expired it doesn't override to lapsing
    const lease = mkLease({
      id: 'l5',
      leaseEnd: isoOffset(ASOF, -1),
      monthsToExpiry: -1,
      status: 'Active',
    });
    const signals = renewalSignals([lease], ASOF, {}, {});
    const s = signals.find((x) => x.leaseId === 'l5')!;
    expect(s.monthToMonth).toBe(true);
    expect(s.likelihood).toBe('lapsing');
  });
});

// ── L-A5: arrears ≥ material + ≤ 12m → at-risk ──────────────────────────────
describe('L-A5: renewalSignals — at-risk by arrears', () => {
  it('arrears ≥ 5000 + ≤12m expiry → at-risk', () => {
    const lease = mkLease({
      id: 'l6',
      leaseEnd: isoOffset(ASOF, 8),
      monthsToExpiry: 8,
      leaseStart: '2025-01-01', // short tenure
      annualRent: 36000,
      status: 'Active',
    });
    const arrears = { l6: { d30: ALERT_ARREARS_MATERIAL + 100, d60: 0, d90: 0, d90plus: 0 } };
    const signals = renewalSignals([lease], ASOF, {}, arrears);
    const s = signals.find((x) => x.leaseId === 'l6')!;
    expect(s.likelihood).toBe('at-risk');
    expect(s.arrearsUsd).toBeGreaterThanOrEqual(ALERT_ARREARS_MATERIAL);
  });
  it('arrears ≥ 5000 but > 12m to expiry → not at-risk for that reason', () => {
    const lease = mkLease({
      id: 'l7',
      leaseEnd: isoOffset(ASOF, 18),
      monthsToExpiry: 18,
      leaseStart: '2025-01-01',
      annualRent: 36000,
      status: 'Active',
    });
    const arrears = { l7: { d30: ALERT_ARREARS_MATERIAL + 100, d60: 0, d90: 0, d90plus: 0 } };
    const signals = renewalSignals([lease], ASOF, {}, arrears);
    const s = signals.find((x) => x.leaseId === 'l7')!;
    // Should be uncertain — not at-risk (arrears rule only triggers ≤ 12m)
    expect(s.likelihood).toBe('uncertain');
  });
});

// ── L-A6: marketRentGaps — basic upside calculation ──────────────────────────
describe('L-A6: marketRentGaps — upside calculation', () => {
  it('current 5.00, market 6.00, sf 10k → gapPsf 1.00, gapAnnualUsd 10000, underMarket true', () => {
    const lease = mkLease({
      id: 'l1',
      sf: 10000,
      rentPerSf: 5.0,
      annualRent: 50000,
    });
    const gaps = marketRentGaps([lease], { 'Prop One': 6.0 });
    expect(gaps).toHaveLength(1);
    const g = gaps[0]!;
    expect(g.gapPsf).toBeCloseTo(1.0);
    expect(g.gapAnnualUsd).toBeCloseTo(10000);
    expect(g.underMarket).toBe(true);
    expect(g.provenance).toBe('derived');
  });
  it('current above market → underMarket false (downside, not under-market)', () => {
    const lease = mkLease({
      id: 'l1',
      sf: 10000,
      rentPerSf: 7.0,
      annualRent: 70000,
    });
    const gaps = marketRentGaps([lease], { 'Prop One': 6.0 });
    const g = gaps[0]!;
    expect(g.underMarket).toBe(false);
    expect(g.gapPsf).toBeCloseTo(-1.0); // market - current is negative
  });
});

// ── L-A7: marketRentGaps — no market rent → absent, no crash ─────────────────
describe('L-A7: marketRentGaps — absent market rent', () => {
  it('no market rent for the lease/property → provenance absent, underMarket false, null gaps', () => {
    const lease = mkLease({ id: 'l1', sf: 10000, rentPerSf: 5.0 });
    const gaps = marketRentGaps([lease], {});
    // When no market rent, skip or return absent
    if (gaps.length > 0) {
      const g = gaps[0]!;
      expect(g.provenance).toBe('absent');
      expect(g.underMarket).toBe(false);
      expect(g.gapPsf).toBeNull();
      expect(g.gapAnnualUsd).toBeNull();
    } else {
      // Skipped entirely is also acceptable
      expect(gaps).toHaveLength(0);
    }
  });
  it('does not throw when marketRents is empty', () => {
    const lease = mkLease({ id: 'l1' });
    expect(() => marketRentGaps([lease], {})).not.toThrow();
  });
});

// ── L-A8: rentForecast — all three scenarios ──────────────────────────────────
describe('L-A8: rentForecast — three scenarios', () => {
  const leaseExpiring = mkLease({
    id: 'l1',
    monthsToExpiry: 6,
    leaseEnd: isoOffset(ASOF, 6),
    annualRent: 50000,  // sf(10000) * rentPerSf(5.0) * 12 months = 50000 (consistent)
    sf: 10000,
    rentPerSf: 5.0,
    status: 'Active',
  });
  const leaseNotExpiring = mkLease({
    id: 'l2',
    monthsToExpiry: 30,
    leaseEnd: isoOffset(ASOF, 30),
    annualRent: 40000,
    sf: 8000,
    rentPerSf: null,
    status: 'Active',
  });
  const leases = [leaseExpiring, leaseNotExpiring];
  const marketRents = { 'Prop One': 7.0 }; // market $7/SF vs in-place $5/SF on expiring

  it('renew_at_current: delta = 0, projectedAnnualRent = inPlace', () => {
    const input = RentForecastInput.parse({ scenario: 'renew_at_current', horizonMonths: 12 });
    const result = rentForecast(leases, ASOF, input, marketRents);
    expect(result.scenario).toBe('renew_at_current');
    expect(result.deltaUsd).toBe(0);
    expect(result.projectedAnnualRent).toBe(result.inPlaceAnnualRent);
    expect(result.noiImpactAnnualUsd).toBe(0);
    expect(result.assumptions.length).toBeGreaterThan(0);
    expect(result.spine).toBe('A');
  });

  it('renew_at_market: delta = sum of (market - current) * sf for in-horizon expiring leases', () => {
    const input = RentForecastInput.parse({ scenario: 'renew_at_market', horizonMonths: 12 });
    const result = rentForecast(leases, ASOF, input, marketRents);
    // l1 expires in 6m (within 12m horizon), sf=10000, market=7
    // marketAnnual = 7*10000=70000; currentAnnual=50000; delta = 70000-50000 = 20000
    expect(result.scenario).toBe('renew_at_market');
    expect(result.deltaUsd).toBeCloseTo(20000);
    expect(result.noiImpactAnnualUsd).toBeCloseTo(20000); // NNN 1:1
    expect(result.assumptions.length).toBeGreaterThan(0);
  });

  it('vacancy_haircut: 20% haircut → noiImpact = -0.2 * expiringRentInHorizon', () => {
    const input = RentForecastInput.parse({ scenario: 'vacancy_haircut', horizonMonths: 12, vacancyPct: 0.2 });
    const result = rentForecast(leases, ASOF, input, marketRents);
    // expiringRentInHorizon = 50000 (l1 expires in 6m, annualRent=50000)
    // totalInPlace = 50000+40000=90000; haircut = 50000*0.2 = 10000
    expect(result.scenario).toBe('vacancy_haircut');
    expect(result.expiringRentInHorizon).toBeCloseTo(50000);
    expect(result.noiImpactAnnualUsd).toBeCloseTo(-10000);
    expect(result.projectedAnnualRent).toBeCloseTo(90000 - 10000);
    expect(result.assumptions.length).toBeGreaterThan(0);
  });

  it('no leases expiring in horizon → expiringRentInHorizon = 0', () => {
    const input = RentForecastInput.parse({ scenario: 'vacancy_haircut', horizonMonths: 6, vacancyPct: 0.5 });
    // Only l2 with 30m to expiry — nothing expires in 6m horizon (l1 expires exactly at 6m: included)
    const resultNoExpiring = rentForecast([leaseNotExpiring], ASOF, input, marketRents);
    expect(resultNoExpiring.expiringRentInHorizon).toBeCloseTo(0);
    expect(resultNoExpiring.noiImpactAnnualUsd).toBeCloseTo(0);
  });
});

// ── L-A9: defensive — non-finite arrears → 0, no throw ───────────────────────
describe('L-A9: renewalSignals — defensive coercion', () => {
  it('non-finite arrears value in overlay → coerced to 0, no throw', () => {
    const lease = mkLease({
      id: 'l8',
      leaseEnd: isoOffset(ASOF, 4),
      monthsToExpiry: 4,
      status: 'Active',
    });
    // Passing NaN, undefined, and string values in arrears buckets
    const badArrears = { l8: { d30: NaN, d60: undefined as unknown as number, d90: 'bad' as unknown as number, d90plus: Infinity } };
    expect(() => renewalSignals([lease], ASOF, {}, badArrears)).not.toThrow();
    const signals = renewalSignals([lease], ASOF, {}, badArrears);
    const s = signals.find((x) => x.leaseId === 'l8')!;
    expect(s.arrearsUsd).toBe(0); // all bad values → coerced to 0
  });

  it('null/undefined stage in renewalStages → treated as absent, no crash', () => {
    const lease = mkLease({ id: 'l9', monthsToExpiry: 3, leaseEnd: isoOffset(ASOF, 3) });
    const badStages = { l9: null as unknown as string };
    expect(() => renewalSignals([lease], ASOF, badStages, {})).not.toThrow();
  });
});

// ── Regression: calendar-month truncation in rentForecast ────────────────────
// Verifies that a lease which expired earlier in the current calendar month (leaseEnd < asOf,
// but differenceInCalendarMonths returns 0) is NOT counted in expiringRentInHorizon.
describe('rentForecast — expired-this-month regression (calendar truncation)', () => {
  it('expired lease (leaseEnd earlier this month, monthsToExpiry=0) excluded from expiringRentInHorizon', () => {
    // leaseEnd = June 1 (20 days ago); asOf = June 21 — workbook would emit monthsToExpiry=0
    const expiredThisMonth = mkLease({
      id: 'trunc-regress',
      leaseEnd: '2026-06-01',   // already past
      monthsToExpiry: 0,        // calendar-month truncation: same month → 0, not negative
      annualRent: 200000,
      status: 'Active',         // holdover — not yet re-keyed in rent roll
    });
    const input = RentForecastInput.parse({ scenario: 'vacancy_haircut', horizonMonths: 6, vacancyPct: 0.5 });
    const result = rentForecast([expiredThisMonth], ASOF, input, {});
    // The expired-this-month lease must NOT appear in expiringRentInHorizon — it already expired.
    expect(result.expiringRentInHorizon).toBeCloseTo(0);
    expect(result.noiImpactAnnualUsd).toBeCloseTo(0);
  });

  it('future lease expiring later this same calendar month (leaseEnd > asOf, monthsToExpiry=0) IS included', () => {
    const expiringLaterThisMonth = mkLease({
      id: 'trunc-regress-future',
      leaseEnd: '2026-06-30',   // 9 days in the future
      monthsToExpiry: 0,        // calendar-month truncation: same month → 0
      annualRent: 100000,
      status: 'Active',
    });
    const input = RentForecastInput.parse({ scenario: 'vacancy_haircut', horizonMonths: 6, vacancyPct: 1.0 });
    const result = rentForecast([expiringLaterThisMonth], ASOF, input, {});
    // This lease expires in the future → it SHOULD be in expiringRentInHorizon
    expect(result.expiringRentInHorizon).toBeCloseTo(100000);
    expect(result.noiImpactAnnualUsd).toBeCloseTo(-100000);
  });
});
