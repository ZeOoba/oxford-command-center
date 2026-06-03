import { describe, it, expect } from 'vitest';
import { deriveCounterparties } from '../../server/workbook/counterparties';
import { SEED_PEOPLE } from '../../src/data/seed-counterparties';
import type { Loan } from '../../src/contracts/index';

function loan(l: Partial<Loan>): Loan {
  return {
    id: 'l1',
    name: 'Symetra Note',
    counterparty: 'Symetra',
    direction: 'borrower',
    originalPrincipal: null,
    currentBalance: 980773,
    absBalance: 980773,
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
    lender: 'Symetra',
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

  it('the derived lender firm "Symetra" does NOT carry an individual\'s email', () => {
    const symetra = cps.find((c) => c.kind === 'lender' && c.name === 'Symetra');
    expect(symetra).toBeDefined();
    expect(symetra!.email).toBeNull();
  });

  it('no derived firm shares a seed person\'s email (no cross-contamination)', () => {
    const personEmails = new Set(SEED_PEOPLE.map((p) => p.email).filter((e): e is string => !!e));
    const firms = cps.filter((c) => c.source === 'workbook');
    for (const f of firms) {
      expect(f.email === null || !personEmails.has(f.email)).toBe(true);
    }
  });

  it('the person keeps their own email', () => {
    const tamara = cps.find((c) => c.id === 'cp-tamara-lucas');
    expect(tamara?.email).toBe('tamara.lucas@symetra.com');
  });
});
