import { describe, expect, it } from 'vitest';
import {
  AFFILIATE_LENDER_NAMES,
  namesAffiliateLender,
  isAffiliateNoteProperty,
  isAffiliateBorrowerLoan,
  investmentLoanBalance,
  investmentLtv,
  propertyLtvLabel,
  affiliateNotesClause,
  DEBT_BASIS_FIELD,
  isDebtBasisFlag,
} from '../../src/analytics/debt-basis';

// Every lender / counterparty string below is copied verbatim from data/snapshots/portfolio.json
// (asOf 2026-09-13) so the predicate is proven against the live workbook's actual spellings.
describe('namesAffiliateLender — explicit Oxford lending-entity list, whole phrase, case-insensitive', () => {
  it('ships exactly the ratified list (Q1)', () => {
    expect(AFFILIATE_LENDER_NAMES).toEqual(['Oxford Capital']);
  });
  it.each([
    ['Oxford Capital', true], // 1100 Rarig Property NOI row lender
    ['oxford capital', true],
    ['LAST Non / Oxford Capital — Oxford 50% share', true], // "3883 from Oxford (50%)" borrower lender
    ['1100 Rarig Ave, LLC (Oxford Capital) — Oxford 50% share', true], // lender-direction note (name matches; direction rule excludes it)
    ['Oxford  Capital', true], // internal whitespace collapsed
    ['Oxford\u00a0Capital', true], // NBSP collapsed
    ['Oxford\nCapital', true], // newline collapsed
    ['Oxford Capital Partners LLC (Park National Bank)', false], // the firm's own styling borrowing from a bank = third party
    ['OXFORD CAPITAL PARTNERS (Symetra)', false],
    ['Oxford Capital Partners', false],
    ['Oxford / Symetra Life Insurance (Loan #10258)', false], // 29000 Information Lane — third party
    ['Muirkirk Properties (NorthMarq/Symetra) — Oxford 50% share', false], // 9050 Red Branch — third party
    ['Fairground Village Center LLC (Symetra Life Insurance)', false],
    ['3540 Fifth Ave, LLC (Park National Bank)', false],
    ['Oxford Capitalist Fund', false], // no partial-word match after
    ['NotOxford Capital', false], // no partial-word match before
    ['Symetra', false],
    ['', false],
  ])('%s → %s', (text, expected) => {
    expect(namesAffiliateLender(text)).toBe(expected);
  });
  it('null / undefined → false', () => {
    expect(namesAffiliateLender(null)).toBe(false);
    expect(namesAffiliateLender(undefined)).toBe(false);
  });
});

describe('isAffiliateNoteProperty — property row whose outstanding loan is owed to an Oxford lender', () => {
  it('live 1100 Rarig row → true', () => {
    expect(isAffiliateNoteProperty({ lender: 'Oxford Capital', loanBalance: 1_095_582 })).toBe(true);
  });
  it('affiliate lender name but nothing outstanding → false (no note to exclude)', () => {
    expect(isAffiliateNoteProperty({ lender: 'Oxford Capital', loanBalance: 0 })).toBe(false);
  });
  it('a negative affiliate balance is still an affiliate note', () => {
    expect(isAffiliateNoteProperty({ lender: 'Oxford Capital', loanBalance: -12_500 })).toBe(true);
  });
  it('non-finite balance → false', () => {
    expect(isAffiliateNoteProperty({ lender: 'Oxford Capital', loanBalance: Number.NaN })).toBe(false);
    expect(isAffiliateNoteProperty({ lender: 'Oxford Capital', loanBalance: Number.POSITIVE_INFINITY })).toBe(false);
  });
  it('third-party lender → false', () => {
    expect(isAffiliateNoteProperty({ lender: 'Symetra', loanBalance: 3_707_567.24 })).toBe(false);
  });
  it('no lender → false', () => {
    expect(isAffiliateNoteProperty({ lender: null, loanBalance: 0 })).toBe(false);
    expect(isAffiliateNoteProperty({})).toBe(false);
  });
});

describe('isAffiliateBorrowerLoan — borrower direction only', () => {
  const live3883 = {
    direction: 'borrower',
    lender: 'LAST Non / Oxford Capital — Oxford 50% share',
    counterparty: 'LAST Non / Oxford Capital — Oxford 50% share',
  };
  it('live "3883 from Oxford (50%)" → true', () => {
    expect(isAffiliateBorrowerLoan(live3883)).toBe(true);
  });
  it('matches on counterparty when lender is blank', () => {
    expect(isAffiliateBorrowerLoan({ ...live3883, lender: null })).toBe(true);
  });
  it('a LENDER-direction note naming Oxford Capital is capital deployed, never an affiliate debt → false', () => {
    expect(isAffiliateBorrowerLoan({ direction: 'lender', lender: null, counterparty: '1100 Rarig Ave, LLC (Oxford Capital) — Oxford 50% share' })).toBe(false);
  });
  it('internal-direction accrual → false (already outside External Debt)', () => {
    expect(isAffiliateBorrowerLoan({ direction: 'internal', lender: null, counterparty: 'Oxford (to Muirkirk)' })).toBe(false);
  });
  it('third-party borrower → false', () => {
    const easton = 'Oxford / Symetra Life Insurance (Loan #10258)';
    expect(isAffiliateBorrowerLoan({ direction: 'borrower', lender: easton, counterparty: easton })).toBe(false);
  });
});

describe('investment-basis helpers', () => {
  const rarig = { lender: 'Oxford Capital', loanBalance: 1_095_582, ltv: 0.4613521862071406 };
  const easton = { lender: 'Symetra', loanBalance: 2_760_611.91, ltv: 0.38957229544549016 };
  it('investmentLoanBalance zeroes an affiliate note and passes third-party debt through', () => {
    expect(investmentLoanBalance(rarig)).toBe(0);
    expect(investmentLoanBalance(easton)).toBe(2_760_611.91);
    expect(investmentLoanBalance({ lender: null, loanBalance: null })).toBe(0);
  });
  it('investmentLtv is null for an affiliate note, raw ltv otherwise', () => {
    expect(investmentLtv(rarig)).toBeNull();
    expect(investmentLtv(easton)).toBe(0.38957229544549016);
  });
  it('propertyLtvLabel names the exclusion instead of printing a number', () => {
    expect(propertyLtvLabel(rarig)).toBe('affiliate note');
    expect(propertyLtvLabel(easton)).toBe('39.0%');
    expect(propertyLtvLabel({ lender: null, loanBalance: 0, ltv: null })).toBe('—');
  });
  it('affiliateNotesClause formats a disclosure clause, or nothing', () => {
    expect(affiliateNotesClause(1_095_582)).toBe('+$1.10M affiliate notes');
    expect(affiliateNotesClause(385_218)).toBe('+$385K affiliate notes');
    expect(affiliateNotesClause(0)).toBe('');
    expect(affiliateNotesClause(null)).toBe('');
    expect(affiliateNotesClause(undefined)).toBe('');
  });
});

describe('isDebtBasisFlag — anchored on the debt.basis field family (round-1 lesson b)', () => {
  it.each([
    [{ entity: 'debt', field: 'debt.basis' }, true],
    [{ entity: 'debt', field: 'debt.basis.property.p1' }, true],
    [{ entity: 'debt', field: 'debt.basis.loan.n1' }, true],
    [{ entity: 'debt', field: 'debt.basisx' }, false],
    [{ entity: 'debt', field: 'xdebt.basis' }, false],
    [{ entity: 'reconciliation', field: 'debt.basis' }, false],
    [{ entity: 'lease', field: 'lease.l1.leaseEnd' }, false],
  ])('%o → %s', (flag, expected) => {
    expect(isDebtBasisFlag(flag)).toBe(expected);
  });
  it('exports the field root', () => {
    expect(DEBT_BASIS_FIELD).toBe('debt.basis');
  });
});
