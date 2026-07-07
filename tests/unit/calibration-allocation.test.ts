// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { verdictsFromAllocations } from '../../server/warehouse/calibration';
import type { AllocationVerdict } from '../../src/contracts/capital';
import type { InputsVersion } from '../../src/contracts/warehouse';

const IV: InputsVersion = {
  inputsVersion: 'a'.repeat(16),
  ledgerFingerprint: 'fp',
  configHash: 'ch',
  codeVersion: 'dev',
  configJson: '{}',
};

function makeVerdict(overrides: Partial<AllocationVerdict> = {}): AllocationVerdict {
  return {
    propertyId: 'prop-test',
    propertyName: 'Test Property',
    period: '2025',
    action: 'hold',
    expectedReturnPct: null,
    returnAboveHurdle: null,
    riskBand: 'moderate',
    timelineMonths: 0,
    horizonPeriods: 0,
    confidence01: 0.6,
    confidenceTier: 'estimated',
    advisoryOnly: true,
    reasons: ['Test reason'],
    inputs: {
      healthBand: 'good',
      attentionBand: 'yellow',
      capitalAction: 'hold',
      debtSignal: 'hold',
      debtScoreBand: 'adequate',
      dscr: 1.4,
      dscrHeadroom: 0.15,
      ltv: 0.30,
      noiPerSf: null,
      forecastPresent: false,
    },
    dataQuality: [],
    ...overrides,
  };
}

describe('verdictsFromAllocations', () => {
  it('CAL-1: maps hold verdict — verdictKind=capital-action-v2, direction=flat, horizonPeriods=null when 0', () => {
    const result = verdictsFromAllocations([makeVerdict()], IV, 'test');
    expect(result).toHaveLength(1);
    const cv = result[0]!;
    expect(cv.verdictKind).toBe('capital-action-v2');
    expect(cv.verdictEngine).toBe('capital-allocation');
    expect(cv.predictedBand).toBe('hold');
    expect(cv.direction).toBe('flat');
    expect(cv.horizonPeriods).toBeNull();  // 0 → null (schema requires positive or null)
    expect(cv.confidence).toBeCloseTo(0.6, 5);
    expect(cv.subjectId).toBe('prop-test');
  });

  it('CAL-2: sell → direction=down; horizonPeriods=3 passes through when > 0', () => {
    const result = verdictsFromAllocations(
      [makeVerdict({ action: 'sell', horizonPeriods: 3, confidence01: 0.5 })],
      IV,
      'test',
    );
    expect(result[0]!.direction).toBe('down');
    expect(result[0]!.predictedBand).toBe('sell');
    expect(result[0]!.horizonPeriods).toBe(3);
  });

  it('CAL-3: empty input → empty output', () => {
    const result = verdictsFromAllocations([], IV, 'test');
    expect(result).toHaveLength(0);
  });

  it('CAL-4: C-3 buy verdict (synthetic pipeline: propertyId) is tagged subjectKind=deal, NOT property', () => {
    // A buy verdict's propertyId is `pipeline:${candidateId}` — never a real property_master row.
    // Tagging it subjectKind='property' would permanently pollute the calibration log with a
    // subject_id resolveDueOutcomes can never match against propertyPeriodMetrics(), and it can
    // never resolve. 'deal' is an existing reserved SubjectKind that resolveDueOutcomes already
    // excludes (see calibration.ts's "Reserved subject kinds ... have no warehouse-derivable
    // outcome yet" comment) — reuse it instead of fabricating a fake property.
    const result = verdictsFromAllocations(
      [makeVerdict({ action: 'buy', propertyId: 'pipeline:cand-1', expectedReturnPct: null })],
      IV,
      'test',
    );
    expect(result[0]!.subjectKind).toBe('deal');
    expect(result[0]!.subjectId).toBe('pipeline:cand-1');
  });

  it('CAL-5: non-buy verdicts remain subjectKind=property (no regression)', () => {
    const result = verdictsFromAllocations([makeVerdict({ action: 'hold' })], IV, 'test');
    expect(result[0]!.subjectKind).toBe('property');
  });
});
