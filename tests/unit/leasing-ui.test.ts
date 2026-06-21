import { describe, it, expect } from 'vitest';
import { LeaseForecastResponse } from '@contracts/lease-forecast';

describe('LeaseForecastResponse contract', () => {
  it('parses a valid forecast response', () => {
    const raw = {
      asOf: '2026-06-21',
      signals: [],
      velocity: [],
      marketGaps: [],
      bucketTotals: [
        { bucket: '0-6m', count: 0, expiringRent: 0, expiringSf: 0 },
        { bucket: '6-12m', count: 0, expiringRent: 0, expiringSf: 0 },
        { bucket: '12-24m', count: 0, expiringRent: 0, expiringSf: 0 },
        { bucket: '24m+', count: 0, expiringRent: 0, expiringSf: 0 },
        { bucket: 'expired', count: 0, expiringRent: 0, expiringSf: 0 },
        { bucket: 'unknown', count: 0, expiringRent: 0, expiringSf: 0 },
      ],
    };
    expect(LeaseForecastResponse.safeParse(raw).success).toBe(true);
  });

  it('rejects a response with missing required fields', () => {
    const raw = {
      asOf: '2026-06-21',
      signals: [],
      // missing velocity, marketGaps, bucketTotals
    };
    expect(LeaseForecastResponse.safeParse(raw).success).toBe(false);
  });

  it('rejects an invalid bucket name', () => {
    const raw = {
      asOf: '2026-06-21',
      signals: [],
      velocity: [],
      marketGaps: [],
      bucketTotals: [
        { bucket: 'bad-bucket', count: 0, expiringRent: 0, expiringSf: 0 },
      ],
    };
    expect(LeaseForecastResponse.safeParse(raw).success).toBe(false);
  });
});
