import { describe, it, expect } from 'vitest';
import { deriveCounterparties } from '../../server/workbook/counterparties';
import { SEED_PEOPLE } from '../../src/data/seed-counterparties';
import type { Loan } from '../../src/contracts/index';

function loan(l: Partial<Loan>): Loan {
  return {
    id: 'l1',
    name: 'REDACTED-672 Note',
    counterparty: 'REDACTED-672',
    direction: 'borrower',
    originalPrincipal: null,
    currentBalance: REDACTED-AMT,
    absBalance: REDACTED-AMT,
    rate: 0.09,
    monthlyPmt: null,
    annualInterest: null,
    annualPrincipal: null,
    loanType: 'Balloon',
    status: 'Balloon',
    isDemand: false,
    maturity: '2027-02-20',
    monthsToMaturity: 8,
    ltv: null,
    lender: 'REDACTED-672',
    balloon: true,
    flags: [],
    ...l,
  };
}

describe('deriveCounterparties — person vs firm identity (Defect 4 regression)', () => {
  const cps = deriveCounterparties({
    properties: [],
    loans: [loan({})],
    insurance: [],
    deals: [],
  });

  it('the derived lender firm "REDACTED-672" does NOT carry an individual\'s email', () => {
    const REDACTED-672 = cps.find((c) => c.kind === 'lender' && c.name === 'REDACTED-672');
    expect(REDACTED-672).toBeDefined();
    expect(REDACTED-672!.email).toBeNull();
  });

  it('no derived firm shares a seed person\'s email (no cross-contamination)', () => {
    const personEmails = new Set(SEED_PEOPLE.map((p) => p.email).filter((e): e is string => !!e));
    const firms = cps.filter((c) => c.source === 'workbook');
    for (const f of firms) {
      expect(f.email === null || !personEmails.has(f.email)).toBe(true);
    }
  });

  it('the person keeps their own email', () => {
    const tamara = cps.find((c) => c.id === 'REDACTED-466');
    expect(tamara?.email).toBe('REDACTED-309');
  });
});
