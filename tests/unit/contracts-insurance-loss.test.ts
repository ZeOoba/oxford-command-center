import { describe, expect, it } from 'vitest';
import { InsuranceLossReport, UnmatchedPolicyRef } from '../../src/contracts/insurance-loss';

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

// unmatchedPolicyRefs (2026-09-24): a data-quality list of loss events whose policy_ref names no
// policy at their property. `.default([])` is load-bearing — the client also parses a previously
// baked static mirror that never carried the field.
describe('InsuranceLossReport.unmatchedPolicyRefs', () => {
  const entry = {
    eventId: 'e1',
    propertyId: 'p',
    property: 'P',
    policyRef: ' mmf-TYPO 17962784 ',
    lossDate: '2026-07-04',
    cause: null,
    grossIncurred: 42000,
  };

  it('a report WITHOUT the field parses and defaults it to []', () => {
    expect('unmatchedPolicyRefs' in minimal).toBe(false);
    expect(InsuranceLossReport.parse(minimal).unmatchedPolicyRefs).toEqual([]);
  });

  it('a valid entry parses and round-trips the RAW ref untouched', () => {
    expect(UnmatchedPolicyRef.parse(entry)).toEqual(entry);
    expect(UnmatchedPolicyRef.parse({ ...entry, cause: 'wind' }).cause).toBe('wind');
    expect(InsuranceLossReport.parse({ ...minimal, unmatchedPolicyRefs: [entry] }).unmatchedPolicyRefs).toEqual([entry]);
  });

  it('accepts an empty eventId — the loss-event loaders admit id "" and the field is display-only, so it must never 500 the report', () => {
    expect(UnmatchedPolicyRef.parse({ ...entry, eventId: '' }).eventId).toBe('');
    expect(InsuranceLossReport.parse({ ...minimal, unmatchedPolicyRefs: [{ ...entry, eventId: '' }] }).unmatchedPolicyRefs).toHaveLength(1);
  });

  it('rejects an empty propertyId, an empty policyRef and a negative grossIncurred', () => {
    expect(() => UnmatchedPolicyRef.parse({ ...entry, propertyId: '' })).toThrow();
    expect(() => UnmatchedPolicyRef.parse({ ...entry, policyRef: '' })).toThrow();
    expect(() => UnmatchedPolicyRef.parse({ ...entry, grossIncurred: -1 })).toThrow();
    expect(() => InsuranceLossReport.parse({ ...minimal, unmatchedPolicyRefs: [{ ...entry, policyRef: '' }] })).toThrow();
  });
});
