import { describe, it, expect } from 'vitest';
import { deriveCounterparties } from '../../server/workbook/counterparties';
import { SEED_PEOPLE } from '../../src/data/seed-counterparties';
import type { Loan } from '../../src/contracts/index';

// The scenario needs a seed PERSON whose firm is also a lender firm in the loan book. Taken from the
// seed itself (real locally, synthetic in CI: real firm data is never tracked, ruling 2026-11-10)
// rather than naming anyone here.
const PERSON = SEED_PEOPLE.find((p) => !!p.email && !!p.firm && p.firm !== p.name)!;
const FIRM = PERSON.firm!;

function loan(l: Partial<Loan>): Loan {
  return {
    id: 'l1',
    name: `${FIRM} Note`,
    counterparty: FIRM,
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
    lender: FIRM,
    balloon: true,
    flags: [],
    collateralProperty: null,
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

  it('the seed has a person whose firm doubles as a lender (the Defect 4 shape)', () => {
    expect(PERSON).toBeDefined();
  });

  it('the derived lender firm does NOT carry an individual\'s email', () => {
    const firm = cps.find((c) => c.kind === 'lender' && c.name === FIRM);
    expect(firm).toBeDefined();
    expect(firm!.email).toBeNull();
  });

  it('no derived firm shares a seed person\'s email (no cross-contamination)', () => {
    const personEmails = new Set(SEED_PEOPLE.map((p) => p.email).filter((e): e is string => !!e));
    const firms = cps.filter((c) => c.source === 'workbook');
    for (const f of firms) {
      expect(f.email === null || !personEmails.has(f.email)).toBe(true);
    }
  });

  it('the person keeps their own email', () => {
    const person = cps.find((c) => c.id === PERSON.id);
    expect(person?.email).toBe(PERSON.email);
  });
});
