import { describe, expect, it } from 'vitest';
import { isInsuranceAnalysisEmpty, isTaxAnalysisEmpty, isLeaseMarketEmpty } from '../../src/lib/warehouse-empty';

describe('warehouse-empty predicates', () => {
  it('insurance: empty iff no policies', () => {
    expect(isInsuranceAnalysisEmpty({ policiesN: 0 })).toBe(true);
    expect(isInsuranceAnalysisEmpty({ policiesN: 3 })).toBe(false);
  });
  it('taxes: empty iff no assessments/appeals/opportunities AND no ledger tax', () => {
    expect(isTaxAnalysisEmpty({ assessments: [], appeals: [], opportunities: [], ledgerTaxAnnualUsd: null })).toBe(true);
    expect(isTaxAnalysisEmpty({ assessments: [], appeals: [], opportunities: [], ledgerTaxAnnualUsd: 120_000 })).toBe(false);
    expect(isTaxAnalysisEmpty({ assessments: [{}] as never, appeals: [], opportunities: [], ledgerTaxAnnualUsd: null })).toBe(false);
  });
  it('lease market: empty iff no active spaces AND nothing ever landed', () => {
    const f = (lastLandingDate: string | null) => ({ marketId: 'columbus', label: 'Columbus', enabled: true, lastLandingDate, lastCompleteDate: null, lastCompleteness: null, partialReason: null, stale: false });
    const k = (activeSpaces: number) => ({ marketsFresh: 0, marketsEnabled: 1, activeSpaces, newInLatest: 0, priceCutsInLatest: 0, stale: 0, radarCandidates: 0 });
    expect(isLeaseMarketEmpty({ kpis: k(0), freshness: [f(null)] })).toBe(true);
    expect(isLeaseMarketEmpty({ kpis: k(0), freshness: [f('2026-09-01')] })).toBe(false); // ingested, compute pending — existing notice covers it
    expect(isLeaseMarketEmpty({ kpis: k(13), freshness: [f(null)] })).toBe(false);
  });
});
