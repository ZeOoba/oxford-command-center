import { describe, it, expect } from 'vitest';
import { isFinancialSourcePath, hasRefuteApproval, DELIVERY_ONLY_PATHS } from '../../scripts/check-refute-required';

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

describe('check-refute-required — delivery-only allowlist', () => {
  it('treats delivery-only warehouse routing files as non-financial', () => {
    expect(isFinancialSourcePath('server/warehouse/api.ts')).toBe(false);
    expect(isFinancialSourcePath('server/warehouse/debt-api.ts')).toBe(false);
    expect(isFinancialSourcePath('server/warehouse/actions.ts')).toBe(false);
    // Phase 3 W1: lease-forecast-api.ts is pure route-plumbing (no math)
    expect(isFinancialSourcePath('server/warehouse/lease-forecast-api.ts')).toBe(false);
    // Windows separators normalize before set lookup
    expect(isFinancialSourcePath('server\\warehouse\\api.ts')).toBe(false);
  });
  it('still flags non-allowlisted warehouse files', () => {
    expect(isFinancialSourcePath('server/warehouse/scores.ts')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/debt-scoring.ts')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/acq-engine.ts')).toBe(true);
    expect(isFinancialSourcePath('server/warehouse/queries.ts')).toBe(true);
    // lease-velocity.ts holds financial math — must NOT be in delivery-only
    expect(isFinancialSourcePath('server/warehouse/lease-velocity.ts')).toBe(true);
  });
  it('exposes the delivery-only allowlist with the expected membership', () => {
    expect(DELIVERY_ONLY_PATHS.size).toBe(7);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/api.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/debt-api.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/actions.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/lease-forecast-api.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/capital-allocation-api.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/property-onboarding.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/ic-memo.ts')).toBe(true);
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
