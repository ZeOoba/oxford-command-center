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
  // 2026-08-11 sweep: server/workbook/ was absent from the gate while parse.ts and
  // debt-service-crosscheck.ts both sit in the annualDebtService chain feeding debt-scoring.ts
  // (DSCR) and src/analytics/engine.ts. Three commits touching the DSCR denominator landed
  // without a gate-required refute trailer. This is the second occurrence of the scope-staleness
  // mode (2026-07-24 was the first, one directory over) — a NEW financial directory must not be
  // invisible by default.
  it('flags server/workbook/ — the workbook parser and debt-service cross-check feed DSCR', () => {
    expect(isFinancialSourcePath('server/workbook/parse.ts')).toBe(true);
    expect(isFinancialSourcePath('server/workbook/debt-service-crosscheck.ts')).toBe(true);
    expect(isFinancialSourcePath('server/workbook/counterparties.ts')).toBe(true);
    expect(isFinancialSourcePath('server\\workbook\\parse.ts')).toBe(true);
  });
  it('still ignores workbook tests and docs', () => {
    expect(isFinancialSourcePath('tests/unit/debt-service-crosscheck.test.ts')).toBe(false);
    expect(isFinancialSourcePath('server/workbook/debt-maturity.DESIGN.md')).toBe(false);
  });
  // 2026-08-12, THIRD occurrence of the scope-staleness mode. The Deal-ID join redesign rewrote
  // the seed<->Notion joiner — which decides which live price / cap rate / IRR / lender attaches
  // to which deal record, and which rows keep the fail-closed confidential default — and this gate
  // reported "no financial-decision source files changed" for the whole branch. Same shape as
  // src/contracts (2026-07-24) and server/workbook (2026-08-11): an enumeration that goes stale
  // silently. Fixed with a prefix, which fails closed as new files appear.
  it('flags server/sources/ — the deal joiner, the confidentiality gate, QuickBooks, tenants', () => {
    expect(isFinancialSourcePath('server/sources/notion-deals.ts')).toBe(true);
    expect(isFinancialSourcePath('server/sources/deal-name.ts')).toBe(true);
    expect(isFinancialSourcePath('server/sources/deal-declassification.ts')).toBe(true);
    expect(isFinancialSourcePath('server/sources/quickbooks.ts')).toBe(true);
    expect(isFinancialSourcePath('server/sources/notion-tenants.ts')).toBe(true);
    expect(isFinancialSourcePath('server\\sources\\notion-deals.ts')).toBe(true);
  });
  it('subtracts the transport/indexing plumbing under server/sources/', () => {
    expect(isFinancialSourcePath('server/sources/graph-auth.ts')).toBe(false);
    expect(isFinancialSourcePath('server/sources/m365-tasks.ts')).toBe(false);
    expect(isFinancialSourcePath('server/sources/documents.ts')).toBe(false);
    // …but a test beside them is still a test.
    expect(isFinancialSourcePath('server/sources/notion-deals.test.ts')).toBe(false);
  });
  it('flags the seed deal set and the RCT denominator table', () => {
    // seed-deals.ts is the source of truth for Deal.confidential AND the set published when Notion
    // is unreachable; replacement-cost.ts holds RCT v03, the ratified basis denominator.
    expect(isFinancialSourcePath('src/data/seed-deals.ts')).toBe(true);
    expect(isFinancialSourcePath('src/data/public-deals.ts')).toBe(true);
    expect(isFinancialSourcePath('src/brain/replacement-cost.ts')).toBe(true);
  });
  it('flags the deal + common contracts (deal economics, confidential flag, Market enum)', () => {
    expect(isFinancialSourcePath('src/contracts/deal.ts')).toBe(true);
    expect(isFinancialSourcePath('src/contracts/common.ts')).toBe(true);
  });
  it('ignores tests, docs, json, and non-financial source', () => {
    expect(isFinancialSourcePath('tests/unit/conditions.test.ts')).toBe(false);
    expect(isFinancialSourcePath('src/analytics/conditions.test.ts')).toBe(false);
    expect(isFinancialSourcePath('architecture/coding-standards.md')).toBe(false);
    expect(isFinancialSourcePath('architecture/status.json')).toBe(false);
    expect(isFinancialSourcePath('src/modules/principal/PrincipalModule.tsx')).toBe(false);
    expect(isFinancialSourcePath('src/lib/cn.ts')).toBe(false);
  });

  // 2026-07-24 (PR #233 follow-up): the LTV-bound episode proved a CONTRACT schema change can
  // carry direct governor blast radius — a bound briefly added to src/contracts/loan.ts's ltv
  // field made one bad workbook cell fail the entire portfolio snapshot, and the field feeds
  // computePortfolioAggregateLtv's Hard-Invariant-4 verdict. Yet no contracts file required a
  // refute trailer: the enforcement gate had the same file-enumeration blind spot the weekly
  // sweep's path list did. The four financial contracts are now classified as financial source.
  it('flags the financial contract schemas (loan/debt/warehouse/macro + capital pair)', () => {
    expect(isFinancialSourcePath('src/contracts/loan.ts')).toBe(true);
    expect(isFinancialSourcePath('src/contracts/debt.ts')).toBe(true);
    expect(isFinancialSourcePath('src/contracts/warehouse.ts')).toBe(true);
    expect(isFinancialSourcePath('src/contracts/macro.ts')).toBe(true);
    // Round-9 (fifth adversarial pass, all three lenses independently): capital.ts holds
    // HurdleRateConfig — the ratified hurdle-rate governor consumed by capital-allocation.ts and
    // calibration.ts — and capital-allocation.ts bounds the capstone scoring response. Both meet
    // the same inclusion criterion that added loan.ts; omitting them repeated the exact
    // enumeration blind spot this set exists to close.
    expect(isFinancialSourcePath('src/contracts/capital.ts')).toBe(true);
    expect(isFinancialSourcePath('src/contracts/capital-allocation.ts')).toBe(true);
  });

  it('still ignores non-financial contract schemas', () => {
    expect(isFinancialSourcePath('src/contracts/index.ts')).toBe(false);
    // common.ts moved to the financial set 2026-08-12 — see the case below. Deliberately narrow:
    // the barrel index stays out, so a re-export edit does not demand an attestation.
    expect(isFinancialSourcePath('src/contracts/lease.ts')).toBe(false);
    expect(isFinancialSourcePath('src/contracts/property.ts')).toBe(false);
  });

  // 2026-08-12: common.ts was explicitly pinned as NON-financial until this date. It holds the
  // Market enum, which keys RCT_V03 (the ratified replacement-cost denominator) and the cap-rate
  // benchmark table — so dropping or renaming a member silently unprices every deal in that market
  // rather than failing loudly. That meets this gate's stated inclusion criterion ("fields consumed
  // by governor/scoring math"). Accepted cost: the file also holds generic plumbing (Cell, slug,
  // DataQualityFlag), so unrelated edits there now need a trailer too. Fail closed on the enum
  // beats staying quiet on it.
  it('flags src/contracts/common.ts — the Market enum keys the RCT denominator', () => {
    expect(isFinancialSourcePath('src/contracts/common.ts')).toBe(true);
  });
});

describe('check-refute-required — delivery-only allowlist', () => {
  it('treats delivery-only warehouse routing files as non-financial', () => {
    expect(isFinancialSourcePath('server/warehouse/api.ts')).toBe(false);
    expect(isFinancialSourcePath('server/warehouse/debt-api.ts')).toBe(false);
    expect(isFinancialSourcePath('server/warehouse/actions.ts')).toBe(false);
    // Phase 3 W1: lease-forecast-api.ts is pure route-plumbing (no math)
    expect(isFinancialSourcePath('server/warehouse/lease-forecast-api.ts')).toBe(false);
    // Lease Market Intelligence P1 Task 14: lease-market-api.ts is pure route-plumbing (no math)
    expect(isFinancialSourcePath('server/warehouse/lease-market-api.ts')).toBe(false);
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
    expect(DELIVERY_ONLY_PATHS.size).toBe(11);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/api.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/debt-api.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/actions.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/lease-forecast-api.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/lease-market-api.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/capital-allocation-api.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/warehouse/property-onboarding.ts')).toBe(true);
    // server/sources/ subtractions, added with the prefix 2026-08-12: transport and indexing
    // plumbing that carries no deal or portfolio figures.
    expect(DELIVERY_ONLY_PATHS.has('server/sources/graph-auth.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/sources/m365-tasks.ts')).toBe(true);
    expect(DELIVERY_ONLY_PATHS.has('server/sources/documents.ts')).toBe(true);
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
