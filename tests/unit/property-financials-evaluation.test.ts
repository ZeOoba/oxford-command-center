// tests/unit/property-financials-evaluation.test.ts — T6 of
// docs/superpowers/plans/2026-10-05-property-financials-module.md. The Evaluation scorecard's single
// config: THRESHOLDS drives BOTH the RAG status and the generated threshold / definition text, so a
// threshold edit cannot leave the description stale. evaluationResults carries the n/m reason.
import { describe, expect, it } from 'vitest';
import { PF_MONTHLY_ENTITY_IDS, type PfMonthlyProperty } from '@contracts/property-financials';
import { evaluationInputs, evaluationResults } from '@analytics/property-financials/metrics';
import {
  EVALUATION_TEST_IDS,
  THRESHOLDS,
  formatThresholdValue,
  ragStatus,
  thresholdDefinition,
  thresholdText,
  type EvaluationTestId,
  type EvaluationThreshold,
} from '@analytics/property-financials/thresholds';
import { loadDataset } from './property-financials-helpers';

const D = loadDataset();
const monthly = (id: (typeof PF_MONTHLY_ENTITY_IDS)[number]) => D.properties[id] as PfMonthlyProperty;

describe('generated threshold text', () => {
  it('reproduces the reference artifact strings exactly for the shipped config', () => {
    const expected: Record<EvaluationTestId, string> = {
      noiMargin: 'Green ≥ 65%, amber 50-65%, red < 50%',
      opexExTaxRatio: 'Green ≤ 20%, amber 20-30%, red > 30%',
      recoveryRatio: 'Green ≥ 85%, amber 50-85%, red < 50%',
      mgmtFeePct: 'Green ≤ 4.0%, amber 4.0-5.0%, red > 5.0%',
      contraRevenue: 'Green ≤ 1.5%, amber 1.5-3.5%, red > 3.5%',
      rentRunRateGrowth: 'Green ≥ +3%, amber 0-3%, red < 0%',
      utilityGrowth: 'Green ≤ +5%, amber +5-15%, red > +15%',
      repairsGrowth: 'Green ≤ +10%, amber +10-30%, red > +30%',
    };
    for (const id of EVALUATION_TEST_IDS) expect(thresholdText(THRESHOLDS[id]), id).toBe(expected[id]);
  });

  it('the growth tests state their prior-base guard in the definition, generated from minPriorBase', () => {
    expect(thresholdDefinition(THRESHOLDS.utilityGrowth)).toBe('Jan-Sep 2026 vs 2025; n/m when either period is partial or the prior-period base is $1,000 or less');
    expect(thresholdDefinition(THRESHOLDS.noiMargin)).toBe('TTM NOI / revenue');
    expect(thresholdDefinition({ ...THRESHOLDS.repairsGrowth, minPriorBase: 2500 })).toMatch(/\$2,500 or less/);
  });

  it('a boundary finer than the display format keeps its precision (never misstates itself)', () => {
    expect(thresholdText({ ...THRESHOLDS.noiMargin, green: 0.652 })).toBe('Green ≥ 65.2%, amber 50-65.2%, red < 50%');
    expect(thresholdText({ ...THRESHOLDS.mgmtFeePct, green: 0.0375 })).toBe('Green ≤ 3.75%, amber 3.75-5.0%, red > 5.0%');
  });

  it('a negative bound reads as a range with "to", not a double hyphen', () => {
    expect(thresholdText({ ...THRESHOLDS.rentRunRateGrowth, amber: -0.02 })).toBe('Green ≥ +3%, amber -2 to 3%, red < -2%');
  });

  it('formats a cell value by the test format', () => {
    expect(formatThresholdValue(THRESHOLDS.noiMargin, REDACTED-AMT)).toBe('66%');
    expect(formatThresholdValue(THRESHOLDS.mgmtFeePct, 0.0447)).toBe('4.5%');
    expect(formatThresholdValue(THRESHOLDS.rentRunRateGrowth, 0.0586)).toBe('+5.9%');
    expect(formatThresholdValue(THRESHOLDS.utilityGrowth, -0.123)).toBe('-12%');
  });

  it('a value that would print as a boundary it sits on the wrong side of gets one more digit', () => {
    // 9620 State 350 TTM management fee REDACTED-AMT: red (> 5.0%), so it must not read "5.0%".
    expect(formatThresholdValue(THRESHOLDS.mgmtFeePct, REDACTED-AMT)).toBe('5.01%');
    expect(formatThresholdValue(THRESHOLDS.mgmtFeePct, 0.05)).toBe('5.0%');
    expect(formatThresholdValue(THRESHOLDS.noiMargin, 0.6496)).toBe('64.96%');
    expect(formatThresholdValue(THRESHOLDS.noiMargin, 0.6504)).toBe('65%');
  });
});

describe('evaluationResults (value + n/m reason)', () => {
  it('values equal evaluationInputs for every PM property', () => {
    for (const id of PF_MONTHLY_ENTITY_IDS) {
      const r = evaluationResults(monthly(id), D.monthly[id]);
      const v = evaluationInputs(monthly(id), D.monthly[id]);
      for (const t of EVALUATION_TEST_IDS) expect(r[t].value, `${id}/${t}`).toBe(v[t]);
    }
  });

  it('every n/m carries a reason', () => {
    const l = evaluationResults(monthly('3883 Livingston'), D.monthly['3883 Livingston']);
    expect(l.rentRunRateGrowth.value).toBeNull();
    expect(l.rentRunRateGrowth.reason).toMatch(/Jul-Sep/);
    for (const id of PF_MONTHLY_ENTITY_IDS) {
      const r = evaluationResults(monthly(id), D.monthly[id]);
      for (const t of EVALUATION_TEST_IDS) if (r[t].value === null) expect(r[t].reason, `${id}/${t}`).toBeTruthy();
    }
  });

  it('a partial period never produces a YoY, even when the prior base clears the floor (rule 1 before the $1,000 guard)', () => {
    const liv = monthly('3883 Livingston');
    expect(liv.periods.YTD25.n_months).toBe(3);
    expect(liv.periods.YTD25.opex_by.Utilities).toBeGreaterThan(1000);
    expect(liv.periods.YTD25.opex_by['Repairs & maintenance']).toBeGreaterThan(1000);
    const r = evaluationResults(liv, D.monthly['3883 Livingston']);
    expect(r.utilityGrowth).toEqual({ value: null, reason: 'YTD25: partial period: 3 of 9 months' });
    expect(r.repairsGrowth).toEqual({ value: null, reason: 'YTD25: partial period: 3 of 9 months' });
    expect(ragStatus('utilityGrowth', r.utilityGrowth.value)).toBe('n');
    expect(ragStatus('repairsGrowth', r.repairsGrowth.value)).toBe('n');
    // A partial CURRENT side refuses too, and the partial reason wins over the floor reason.
    const cur = { ...liv, periods: { ...liv.periods, YTD26: { ...liv.periods.YTD26, n_months: 4 }, YTD25: { ...liv.periods.YTD25, n_months: 9 } } };
    const c = evaluationResults(cur, D.monthly['3883 Livingston']);
    expect(c.utilityGrowth).toEqual({ value: null, reason: 'YTD26: partial period: 4 of 9 months' });
    const both = { ...liv, periods: { ...liv.periods, YTD25: { ...liv.periods.YTD25, n_months: 3, opex_by: { ...liv.periods.YTD25.opex_by, Utilities: 500 } } } };
    expect(evaluationResults(both, D.monthly['3883 Livingston']).utilityGrowth.reason).toMatch(/partial period/);
    // Every complete Jan-Sep pair still produces the growth figure (the floor is the only other refusal).
    for (const id of PF_MONTHLY_ENTITY_IDS) {
      const p = monthly(id);
      if (p.periods.YTD25.n_months !== 9 || p.periods.YTD26.n_months !== 9) continue;
      const u = evaluationResults(p, D.monthly[id]).utilityGrowth;
      if (p.periods.YTD25.opex_by.Utilities > 1000) expect(u.value, `${id}/utilityGrowth`).toBeCloseTo(p.periods.YTD26.opex_by.Utilities / p.periods.YTD25.opex_by.Utilities - 1, 10);
    }
  });

  it('the growth guard reads minPriorBase from the thresholds passed in', () => {
    const r = monthly('1100 Rarig');
    const prior = r.periods.YTD25.opex_by.Utilities;
    expect(prior).toBeGreaterThan(1000);
    const raised = { ...THRESHOLDS, utilityGrowth: { ...THRESHOLDS.utilityGrowth, minPriorBase: prior + 1 } };
    const res = evaluationResults(r, D.monthly['1100 Rarig'], raised).utilityGrowth;
    expect(res.value).toBeNull();
    expect(res.reason).toMatch(/prior-period base/);
  });
});

describe('pinned statuses (literal, computed from UNROUNDED figures)', () => {
  // The reference artifact read the dataset's 2-dp rounded ratios; the module computes from the raw
  // figures (as the Scorecard table does). These three cells therefore differ from the artifact.
  it('the three cells where exact math departs from the artifact', () => {
    const st = (id: (typeof PF_MONTHLY_ENTITY_IDS)[number], t: EvaluationTestId) => ragStatus(t, evaluationResults(monthly(id), D.monthly[id])[t].value);
    expect(st('3540 E 5th', 'rentRunRateGrowth')).toBe('r'); // -0.10%; artifact amber on a rounded 0
    expect(st('3883 Livingston', 'mgmtFeePct')).toBe('a'); // 4.47%; artifact green on a rounded 4%
    expect(st('9620 State 350', 'mgmtFeePct')).toBe('r'); // 5.01%; artifact amber on a rounded 5%
  });

  it('a sample of cells that match the artifact', () => {
    const st = (id: (typeof PF_MONTHLY_ENTITY_IDS)[number], t: EvaluationTestId) => ragStatus(t, evaluationResults(monthly(id), D.monthly[id])[t].value);
    expect(st('1100 Rarig', 'noiMargin')).toBe('g');
    expect(st('1900 Broadway', 'noiMargin')).toBe('a');
    expect(st('9620 State 350', 'noiMargin')).toBe('r');
    expect(st('FVC', 'recoveryRatio')).toBe('r');
    expect(st('3540 E 5th', 'recoveryRatio')).toBe('g');
    expect(st('9050 Red Branch', 'recoveryRatio')).toBe('g');
    expect(st('29000 Info Lane', 'rentRunRateGrowth')).toBe('g');
    expect(st('3883 Livingston', 'rentRunRateGrowth')).toBe('n');
  });
});

describe('mutating a cloned config flips exactly the right cells AND rewrites the text', () => {
  it('mgmt fee green 4.0% -> 3.5%: cells in (3.5%, 4.0%] go green -> amber; the threshold text updates', () => {
    const clone: Record<EvaluationTestId, EvaluationThreshold> = structuredClone(THRESHOLDS) as Record<EvaluationTestId, EvaluationThreshold>;
    clone.mgmtFeePct = { ...clone.mgmtFeePct, green: 0.035 };
    expect(thresholdText(clone.mgmtFeePct)).toBe('Green ≤ 3.5%, amber 3.5-5.0%, red > 5.0%');
    expect(thresholdText(THRESHOLDS.mgmtFeePct)).toBe('Green ≤ 4.0%, amber 4.0-5.0%, red > 5.0%');
    let flipped = 0;
    for (const id of PF_MONTHLY_ENTITY_IDS) {
      const res = evaluationResults(monthly(id), D.monthly[id], clone);
      for (const t of EVALUATION_TEST_IDS) {
        const before = ragStatus(t, res[t].value, THRESHOLDS);
        const after = ragStatus(t, res[t].value, clone);
        const v = res[t].value;
        const shouldFlip = t === 'mgmtFeePct' && v !== null && v > 0.035 && v <= 0.04;
        expect(after !== before, `${id}/${t}`).toBe(shouldFlip);
        if (shouldFlip) {
          expect([before, after]).toEqual(['g', 'a']);
          flipped++;
        }
      }
    }
    expect(flipped).toBeGreaterThan(0);
  });
});
