import { describe, it, expect } from 'vitest';
import {
  Property,
  Lease,
  Loan,
  InsurancePolicy,
  MacroIndicator,
  MacroSnapshot,
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
      lender: 'Firm 03',
      loanBalance: REDACTED-AMT,
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

  it('parses a real Lease row (a masonry tenant, 1100 Rarig)', () => {
    const r = Lease.parse({
      id: 'rarig-l',
      propertyKey: '1100 Rarig',
      propertyId: '1100-rarig-ave',
      tenantName: 'Person 009',
      unit: 'L',
      company: 'Tenant 028 LLC',
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

  it('parses a real Loan row (Note Party 02 balloon)', () => {
    const r = Loan.parse({
      id: 'note-party-02',
      name: 'Note Party 02',
      counterparty: 'Note Party 02 (Oxford Capital)',
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
      policyNo: 'POL-0020',
      carrier: 'Carrier 01',
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

  it('accepts a MacroIndicator with value=null (FRED single-series outage, e.g. DGS10 missing observation)', () => {
    // Root-cause fix follow-up to PFI Phase 1b: fred.ts previously coalesced a missing observation
    // to 0, lying to the non-nullable contract. The contract is now value: z.number().nullable(),
    // so a real "we don't have a 10Y reading right now" can travel the full path (FRED parse → spine
    // tools → ai/agent.ts summarizeMacro → MarketModule UI) without the 0 sentinel.
    const r = MacroIndicator.parse({
      id: 'DGS10',
      label: '10Y Treasury',
      value: null,
      unit: '%',
      change: null,
    });
    expect(r.value).toBeNull();
  });

  it('accepts a MacroSnapshot whose indicators carry null values (end-to-end transport boundary)', () => {
    const s = MacroSnapshot.parse({
      asOf: '2026-06-01',
      source: 'fred',
      indicators: [
        { id: 'DGS10', label: '10Y Treasury', value: null, unit: '%', change: null },
        { id: 'DGS2', label: '2Y Treasury', value: 4.05, unit: '%', change: null },
      ],
      tenYearHistory: [{ date: '2025-06-01', value: 4.38 }],
    });
    expect(s.indicators[0]!.value).toBeNull();
    expect(s.indicators[1]!.value).toBe(4.05);
  });

  it('REJECTS a MacroIndicator whose value is NaN or ±Infinity (z.number().finite() enforces the producer-side filter at parse)', () => {
    // Adversarial refute-pass finding (PFI Phase 1c-prelim): bare `z.number()` accepts NaN by
    // default. With the value=null cure, dropping `!Number.isFinite()` from the agent guard would
    // let a NaN/Infinity from a future direct-construction producer reach the model unguarded.
    // `.finite()` at the contract boundary mirrors fred.ts:22's `Number.isFinite` filter — the
    // invariant is enforced at the schema layer so downstream consumers don't have to defend
    // against shapes the parser already rejected.
    expect(() =>
      MacroIndicator.parse({ id: 'DGS10', label: '10Y', value: NaN, unit: '%', change: null }),
    ).toThrow();
    expect(() =>
      MacroIndicator.parse({ id: 'DGS10', label: '10Y', value: Infinity, unit: '%', change: null }),
    ).toThrow();
    expect(() =>
      MacroIndicator.parse({ id: 'DGS10', label: '10Y', value: -Infinity, unit: '%', change: null }),
    ).toThrow();
  });

  // Loan.ltv is UNBOUNDED at the base schema (2026-07-24 follow-up to the governor-LTV
  // integrity sweep; round-5 correction — see the full reasoning on the field's own doc comment
  // in src/contracts/loan.ts). Round 4 briefly bounded it here directly, but a SECOND
  // independent adversarial review proved this base schema is validated by
  // server/workbook/parse.ts's whole-portfolio PortfolioSnapshot.parse() — every writer goes
  // through it, not just POST /snapshot — so a magnitude bound here would make a single bad ltv
  // cell fail the ENTIRE snapshot parse, breaking this repo's DataQualityFlag-not-hard-throw
  // convention. The bound now lives narrowly at the POST /snapshot boundary only (see
  // debt-api.test.ts's "POST /snapshot — payload validation" describe block for its coverage).
  describe('Loan.ltv — unbounded at the base schema (bound lives at the POST /snapshot boundary only)', () => {
    const baseLoan = {
      id: 'loan-x', name: 'Test Loan', counterparty: null, direction: 'borrower' as const,
      originalPrincipal: null, currentBalance: 500_000, absBalance: 500_000, rate: 0.06,
      monthlyPmt: null, annualInterest: null, annualPrincipal: null, loanType: null,
      status: null, isDemand: false, maturity: null, monthsToMaturity: null,
      lender: null, balloon: false,
    };

    it('accepts the full realistic range observed across this repo (0.01–0.99)', () => {
      expect(Loan.parse({ ...baseLoan, ltv: 0.01 }).ltv).toBe(0.01);
      expect(Loan.parse({ ...baseLoan, ltv: 0.99 }).ltv).toBe(0.99);
      expect(Loan.parse({ ...baseLoan, ltv: null }).ltv).toBeNull();
      expect(Loan.parse({ ...baseLoan, ltv: 0 }).ltv).toBe(0);
    });

    // Regression pin (round 5): a bound WAS briefly added directly to this base schema in round
    // 4 and had to be reverted — these values must never start throwing here again, since that
    // would mean the bound leaked back onto the whole-portfolio parse path. The actual sign-error
    // / magnitude-error rejection is covered at the POST /snapshot boundary (debt-api.test.ts).
    it('regression: does NOT reject a negative ltv or an order-of-magnitude value at this base schema', () => {
      expect(Loan.parse({ ...baseLoan, ltv: -0.5 }).ltv).toBe(-0.5);
      expect(Loan.parse({ ...baseLoan, ltv: 55 }).ltv).toBe(55);
      expect(Loan.parse({ ...baseLoan, ltv: 5.5 }).ltv).toBe(5.5);
    });

    // KNOWN OPEN GAP, deliberately pinned rather than left as silent absence of coverage: NO
    // schema anywhere in this codebase catches a too-LOW ltv, which is the direction that
    // actually causes a false governor clearance (see loan.ts's doc comment). A column-drift bug
    // that makes ltv read an interest-rate cell (typically 0.03-0.09) passes straight through
    // every write path. If this test ever starts failing because someone closed the gap, that's
    // a deliberate contract change — update this test to match, don't just delete it.
    it('KNOWN GAP: still accepts an implausibly low ltv (e.g. a misread rate-cell value)', () => {
      expect(Loan.parse({ ...baseLoan, ltv: 0.065 }).ltv).toBe(0.065);
      expect(Loan.parse({ ...baseLoan, ltv: 0.001 }).ltv).toBe(0.001);
    });
  });
});
