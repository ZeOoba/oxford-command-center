import { describe, it, expect } from 'vitest';
import { isFinancialSourcePath, hasRefuteApproval } from '../../scripts/check-refute-required';

describe('check-refute-required — financial-source classification', () => {
  it('flags financial-decision source (incl. Windows separators)', () => {
    expect(isFinancialSourcePath('src/analytics/conditions.ts')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/scores.ts')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/calibration.ts')).toBe(true);
    expect(isFinancialSourcePath('server/overlay.ts')).toBe(true);
    expect(isFinancialSourcePath('src/brain/anomaly-insights.ts')).toBe(true);
    expect(isFinancialSourcePath('server\\warehouse\\anomalies.ts')).toBe(true);
  });
  it('ignores tests, docs, json, and non-financial source', () => {
    expect(isFinancialSourcePath('tests/unit/conditions.test.ts')).toBe(false);
    expect(isFinancialSourcePath('src/analytics/conditions.test.ts')).toBe(false);
    expect(isFinancialSourcePath('architecture/coding-standards.md')).toBe(false);
    expect(isFinancialSourcePath('architecture/status.json')).toBe(false);
    expect(isFinancialSourcePath('src/modules/principal/PrincipalModule.tsx')).toBe(false);
    expect(isFinancialSourcePath('src/lib/cn.ts')).toBe(false);
  });
});

describe('check-refute-required — trailer detection', () => {
  it('detects Refute-Reviewed / Refute-Skip anywhere in the blob (case-insensitive)', () => {
    expect(hasRefuteApproval('fix: x\n\nRefute-Reviewed: wf_abc123')).toBe(true);
    expect(hasRefuteApproval('chore\n\nRefute-Skip: docs-only adjustment')).toBe(true);
    expect(hasRefuteApproval('refute-reviewed: wf_x')).toBe(true);
  });
  it('returns false when no attestation trailer is present', () => {
    expect(hasRefuteApproval('fix: something\n\nCo-Authored-By: someone')).toBe(false);
    expect(hasRefuteApproval('')).toBe(false);
  });
});
