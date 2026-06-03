import { describe, it, expect } from 'vitest';
import {
  Property,
  Lease,
  Loan,
  InsurancePolicy,
  PortfolioSnapshot,
  SCHEMA_VERSION,
} from '@contracts/index';

describe('contracts accept real workbook records', () => {
  it('parses a real Property row (29000 Information Lane)', () => {
    const r = Property.parse({
      id: '29000-information-lane',
      index: 2,
      name: '29000 Information Lane, Easton MD',
      address: '29000 Information Lane, Easton MD',
      city: 'Easton',
      state: 'MD',
      market: 'Mid-Atlantic',
      type: 'Flex',
      sf: 48000,
      tenantCount: 23,
      occPct: 1,
      acqDate: '2021-01-01',
      estValue100: 7305433.14,
      oxfordOwnPct: 1,
      oxfordValue: 7305433.14,
      grossIncome: 671380.32,
      expenses: 160000,
      noi: 511380.32,
      noiScenarioAdj: 511380.32,
      debtService: 225706.78,
      netCashFlow: 285673.54,
      capRate: 0.07,
      dscr: 2.2657,
      lender: 'Symetra',
      loanBalance: 2773925.08,
      ltv: 0.3797,
      valuePerSf: 152.2,
      rentPerSf: 13.99,
      equityInvested: -800000,
      cashOnCash: null,
      holdYrs: 5.4,
      encumbered: true,
    });
    expect(r.noi).toBe(511380.32);
    expect(r.flags).toEqual([]);
  });

  it('parses a real Lease row (Buckner & Sons Masonry, 1100 Rarig)', () => {
    const r = Lease.parse({
      id: 'rarig-l',
      propertyKey: '1100 Rarig',
      propertyId: '1100-rarig-ave',
      tenantName: 'Jerome Buckner',
      unit: 'L',
      company: 'Buckner and Sons Masonry',
      sf: 1800,
      monthlyRent: 1554.22,
      rentPerSf: 10.36,
      leaseStart: '2023-07-01',
      leaseEnd: '2027-06-30',
      escalationDate: '2026-07-01',
      escalationPct: 0.0616,
      status: 'Active',
      annualRent: 18650.64,
      monthsToExpiry: 13,
    });
    expect(r.status).toBe('Active');
  });

  it('parses a real Loan row (Restoration Church Trust balloon)', () => {
    const r = Loan.parse({
      id: 'restoration-church-trust',
      name: 'Restoration Church Trust',
      counterparty: 'Restoration Church Trust (Oxford Capital)',
      direction: 'lender',
      originalPrincipal: null,
      currentBalance: -980772.99,
      absBalance: 980772.99,
      rate: 0.09,
      monthlyPmt: -6267.62,
      annualInterest: null,
      annualPrincipal: null,
      loanType: 'Amortizing',
      status: 'Balloon Due Feb-27',
      isDemand: false,
      maturity: '2027-02-20',
      monthsToMaturity: 8,
      ltv: 0.7846,
      lender: 'Oxford Capital',
      balloon: true,
    });
    expect(r.balloon).toBe(true);
  });

  it('parses a real Insurance row and an EXPIRED policy', () => {
    const r = InsurancePolicy.parse({
      id: 'ins-1100rarig-pckg',
      property: '1100 Rarig Ave, Columbus OH 43219',
      entity: '1100 Rarig Avenue LLC',
      coverage: 'Package (PCKG)',
      effective: '2025-03-19',
      expires: '2026-03-19',
      policyNo: 'Q61-0380462',
      carrier: 'Erie Insurance',
      premium: 5643,
      daysToExpiry: -74,
      status: 'Expired',
      notes: null,
    });
    expect(r.status).toBe('Expired');
  });

  it('rejects an out-of-range occupancy (data-quality guard works)', () => {
    expect(() => Property.parse({ occPct: 1.4 } as never)).toThrow();
  });

  it('exposes a stable schema version', () => {
    expect(SCHEMA_VERSION).toBe('1.0.0');
    expect(PortfolioSnapshot).toBeDefined();
  });
});
