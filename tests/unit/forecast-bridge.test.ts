// tests/unit/forecast-bridge.test.ts
//
// Rent-bridge waterfall inputs derived from a RentForecastResult (Task 27). The bridge is a pure
// re-expression of fields the engine already returns — it must CLOSE EXACTLY (start + Σdrivers = end)
// on every real result shape, including nothing-expiring and negative-delta scenarios.
import { describe, expect, it } from 'vitest';
import type { RentForecastResult } from '../../src/contracts/lease-forecast';
import { forecastBridge } from '../../src/modules/leasing/forecast-bridge';

const closes = (b: ReturnType<typeof forecastBridge>): boolean =>
  b.startValue + b.drivers.reduce((s, d) => s + d.delta, 0) === b.endValue;

const result = (over: Partial<RentForecastResult>): RentForecastResult => ({
  scenario: 'renew_at_market',
  horizonMonths: 24,
  inPlaceAnnualRent: 5_000_000,
  projectedAnnualRent: 5_120_000,
  deltaUsd: 120_000,
  noiImpactAnnualUsd: 120_000,
  expiringRentInHorizon: 1_130_000,
  spine: 'A',
  assumptions: [],
  ...over,
});

describe('forecastBridge', () => {
  it('in-place − rent rolling off + re-leased rent = projected (closes exactly)', () => {
    const b = forecastBridge({ inPlaceAnnualRent: 5_000_000, projectedAnnualRent: 5_120_000, deltaUsd: 120_000, expiringRentInHorizon: 1_130_000 } as never);
    // I-4: category labels must be <= 12 chars (Waterfall's truncation cut) — 'Rent rolling
    // off' (17) and 'Re-leased / renewed' (20) both exceeded it and got cut mid-word.
    expect(b.drivers).toEqual([
      { category: 'Rolling off', delta: -1_130_000 },
      { category: 'Re-leased', delta: 1_250_000 },
    ]);
    expect(b.drivers.every((d) => d.category.length <= 12)).toBe(true);
    expect(b.startValue + b.drivers.reduce((s, d) => s + d.delta, 0)).toBe(b.endValue);
  });

  it('carries the endpoints through unchanged', () => {
    const b = forecastBridge(result({}));
    expect(b.startValue).toBe(5_000_000);
    expect(b.endValue).toBe(5_120_000);
  });

  it('closes when nothing expires in the horizon (renew_at_current: both drivers are a clean 0, not -0)', () => {
    const b = forecastBridge(result({ scenario: 'renew_at_current', projectedAnnualRent: 5_000_000, deltaUsd: 0, noiImpactAnnualUsd: 0, expiringRentInHorizon: 0 }));
    expect(b.drivers).toEqual([
      { category: 'Rolling off', delta: 0 },
      { category: 'Re-leased', delta: 0 },
    ]);
    expect(Object.is(b.drivers[0]!.delta, -0)).toBe(false);
    expect(Object.is(b.drivers[1]!.delta, -0)).toBe(false);
    expect(closes(b)).toBe(true);
  });

  it('closes on a negative delta (vacancy haircut: re-leased rent is less than what rolled off)', () => {
    const b = forecastBridge(result({ scenario: 'vacancy_haircut', projectedAnnualRent: 4_887_000, deltaUsd: -113_000, noiImpactAnnualUsd: -113_000 }));
    expect(b.drivers).toEqual([
      { category: 'Rolling off', delta: -1_130_000 },
      { category: 'Re-leased', delta: 1_017_000 },
    ]);
    expect(closes(b)).toBe(true);
  });

  it('closes even if deltaUsd disagrees with the endpoints (defensive)', () => {
    // renew_at_market returns projectedAnnualRent = max(0, projected) but deltaUsd from the unclamped
    // value; the bridge must still land on the displayed projected figure.
    const b = forecastBridge(result({ inPlaceAnnualRent: 100_000, projectedAnnualRent: 0, deltaUsd: -150_000, noiImpactAnnualUsd: -150_000, expiringRentInHorizon: 100_000 }));
    expect(closes(b)).toBe(true);
    expect(b.endValue).toBe(0);
  });

  it('does not mutate its input', () => {
    const r = result({});
    const snapshot = structuredClone(r);
    forecastBridge(r);
    expect(r).toEqual(snapshot);
  });
});
