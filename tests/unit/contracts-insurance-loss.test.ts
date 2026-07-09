import { describe, expect, it } from 'vitest';
import { InsuranceLossReport } from '../../src/contracts/insurance-loss';

const minimal = {
  asOf: '2026-07-09',
  lossDataSource: 'placeholder',
  decPageDataSource: 'placeholder',
  droppedFixtureRows: 0,
  eal: [{ propertyId: 'p', property: 'P', eventsN: 1, grossIncurredTotal: 10, observationYears: 3, ealAnnual: 3.33, indeterminate: false, prov: { source: 'loss-runs.placeholder.json', confidence: 'estimated' } }],
  deductibleReviews: [],
  selfInsure: { retainedUsd: 0, transferredUsd: 0, overLimitUsd: 0, premiumAnnualTotal: 0, portfolioEalAnnual: null, observationYears: 3 },
  rebidPipeline: [],
  basisNote: 'placeholder',
  advisoryOnly: true,
} as const;

describe('InsuranceLossReport contract', () => {
  it('round-trips a valid report', () => {
    expect(InsuranceLossReport.parse(minimal)).toBeTruthy();
  });
  it('rejects advisoryOnly false and negative EAL', () => {
    expect(() => InsuranceLossReport.parse({ ...minimal, advisoryOnly: false })).toThrow();
    expect(() => InsuranceLossReport.parse({ ...minimal, eal: [{ ...minimal.eal[0], grossIncurredTotal: -1 }] })).toThrow();
  });
});
