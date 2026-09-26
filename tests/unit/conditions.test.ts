import { describe, it, expect, vi, afterEach } from 'vitest';
import type { PortfolioSnapshot, Property, Lease, Loan, InsurancePolicy, Deal } from '@contracts/index';
import { GOVERNOR_FALLBACK, GovernorSet } from '@contracts/index';
import { evaluateConditions, ALERT_THRESHOLDS, extractDgs5MarketRate } from '@analytics/index';
import type { MacroSnapshot } from '@contracts/index';
import { CAPITAL_CONFIG } from '../../server/warehouse/capital-config';

// ── Self-contained fixtures ─────────────────────────────────────────────────
const ASOF = '2026-06-04';
const NOW = Date.parse('2026-06-04T12:00:00.000Z');

function snap(over: Partial<PortfolioSnapshot> = {}): PortfolioSnapshot {
  const base = {
    meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: '2026-06-04T00:00:00.000Z', source: 't', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: ASOF },
    properties: [], leases: [], loans: [], deals: [], insurance: [], tasks: [], counterparties: [],
    renewalStages: {}, tenantNotes: {}, dealComps: {}, noiBudgets: {}, quickbooks: null, dataQuality: [],
    cash: { asOf: ASOF, totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
  };
  return { ...base, ...over } as unknown as PortfolioSnapshot;
}
function iso(daysFromAsOf: number): string {
  return new Date(Date.parse(ASOF) + daysFromAsOf * 86_400_000).toISOString().slice(0, 10);
}
const prop = (o: Partial<Property>): Property => ({
  id: 'p1', index: 1, name: 'Prop One', address: '1 Main', city: null, state: null, market: 'Columbus OH', type: 'Flex',
  sf: 1000, tenantCount: 1, occPct: 1, acqDate: null, estValue100: 0, oxfordOwnPct: 1, oxfordValue: 0, grossIncome: 0,
  expenses: 0, noi: 0, noiScenarioAdj: 0, debtService: 0, netCashFlow: 0, capRate: null, dscr: null, lender: null,
  loanBalance: 0, ltv: null, valuePerSf: null, rentPerSf: null, equityInvested: 0, cashOnCash: null, holdYrs: null,
  encumbered: false, flags: [], ...o,
});
const lease = (o: Partial<Lease>): Lease => ({
  id: 'l1', propertyKey: 'Prop One', propertyId: 'p1', tenantName: 'Tenant', unit: null, company: 'Acme Co', sf: 100,
  monthlyRent: 0, rentPerSf: null, leaseStart: null, leaseEnd: null, escalationDate: null, escalationPct: null,
  status: 'Active', annualRent: 12000, monthsToExpiry: null, flags: [], ...o,
});
const loan = (o: Partial<Loan>): Loan => ({
  id: 'n1', name: 'Loan One', counterparty: null, direction: 'borrower', originalPrincipal: null, currentBalance: -500000,
  absBalance: 500000, rate: null, monthlyPmt: null, annualInterest: null, annualPrincipal: null, loanType: null,
  status: null, isDemand: false, maturity: null, monthsToMaturity: null, ltv: null, lender: null, balloon: false, flags: [], collateralProperty: null, ...o,
});
const policy = (o: Partial<InsurancePolicy>): InsurancePolicy => ({
  id: 'i1', property: 'Prop One', entity: null, coverage: 'Package', effective: null, expires: null, policyNo: null,
  carrier: 'Carrier', premium: 5000, daysToExpiry: null, status: 'Current', notes: null,
  tiv: null, deductible: null, coverageLimit: null, flags: [], ...o,
});
const deal = (o: Partial<Deal>): Deal => ({
  id: 'd1', name: 'Deal One', shortName: null, location: null, market: null, sf: null, buildings: null, stage: 'Sourcing',
  estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null, lender: null, status: null,
  nextAction: null, owner: null, targetCloseDate: null, notionDealId: null, confidential: false, estimatedFields: [], ...o,
});
const opts = { now: NOW };

describe('evaluateConditions — debt', () => {
  it('balloon < 180d is critical', () => {
    const out = evaluateConditions(snap({ loans: [loan({ balloon: true, maturity: iso(120) })] }), opts);
    expect(out.find((i) => i.id === 'balloon-n1')?.severity).toBe('critical');
  });
  it('balloon 180–365d is warning', () => {
    const out = evaluateConditions(snap({ loans: [loan({ balloon: true, maturity: iso(200) })] }), opts);
    expect(out.find((i) => i.id === 'balloon-n1')?.severity).toBe('warning');
  });
  it('balloon beyond 365d does not fire', () => {
    const out = evaluateConditions(snap({ loans: [loan({ balloon: true, maturity: iso(400) })] }), opts);
    expect(out.some((i) => i.id === 'balloon-n1')).toBe(false);
  });
  it('balloon at exactly 180d is warning (not critical)', () => {
    const out = evaluateConditions(snap({ loans: [loan({ balloon: true, maturity: iso(180) })] }), opts);
    expect(out.find((i) => i.id === 'balloon-n1')?.severity).toBe('warning');
  });

  // ── Balloon direction awareness ───────────────────────────────────────────
  // A `lender`-direction loan is money ORA is OWED (contracts/loan.ts: "Lender = Oxford
  // receives"; currentBalance is negative = capital deployed). Telling the reader to
  // "prepare refinance or payoff" on an asset inverts the fact. Live case that motivated
  // this: REDACTED-306 — $979,772 @ 9%, balloon 2027-02-20, direction 'lender'
  // — shipped in the 2026-07-16 Daily Brief as a debt obligation.
  //
  // Convention follows the refi-spread precedent already in this file (test (f)):
  // ORA-obligation alerts fire for `borrower` only; `lender` and `internal` are excluded.
  it('balloon does NOT fire the debt/refi alert for a lender-direction loan (ORA is owed, not owing)', () => {
    const out = evaluateConditions(
      snap({ loans: [loan({ id: 'lend1', direction: 'lender', balloon: true, maturity: iso(120) })] }),
      opts,
    );
    expect(out.some((i) => i.id === 'balloon-lend1')).toBe(false);
  });

  it('balloon does NOT fire the debt/refi alert for an internal-direction loan (intercompany accrual)', () => {
    const out = evaluateConditions(
      snap({ loans: [loan({ id: 'int1', direction: 'internal', balloon: true, maturity: iso(120) })] }),
      opts,
    );
    expect(out.some((i) => i.id === 'balloon-int1')).toBe(false);
  });

  it('a maturing lender-direction note fires its own insight, distinct from the balloon one', () => {
    const out = evaluateConditions(
      snap({ loans: [loan({ id: 'lend2', name: 'REDACTED-306', direction: 'lender', balloon: true, maturity: iso(120), absBalance: 979_772 })] }),
      opts,
    );
    const note = out.find((i) => i.id === 'note-maturity-lend2');
    expect(note).toBeDefined();
    // 'debt' (family CF, a capital event), NOT 'collections' (family TE = tenant AR, and
    // non-negativity-enforced). A note borrower is not a tenant.
    expect(note!.category).toBe('debt');
    expect(note!.entityType).toBe('loan');
    expect(note!.entityId).toBe('lend2');
    expect(out.some((i) => i.id === 'balloon-lend2')).toBe(false);
  });

  // REGRESSION GUARD — the live row, with its REAL fields, not just its name.
  // The first cut of this test carried absBalance alone and left monthlyPmt/rate null, so
  // annualDebtService returned null, impactAnnualUsd was null, and the suite was green while
  // the real row produced -$REDACTED-AMT. A fixture must carry the data that breaks, not the
  // label of the thing that broke.
  it('the live REDACTED-306 row yields a POSITIVE impact (signed workbook pmt must not leak through)', () => {
    const out = evaluateConditions(
      snap({
        loans: [
          loan({
            id: 'rct',
            name: 'REDACTED-306',
            direction: 'lender',
            balloon: true,
            maturity: iso(120),
            absBalance: REDACTED-AMT,
            currentBalance: -REDACTED-AMT,
            monthlyPmt: -REDACTED-AMT, // workbook signs lender payments negative
            rate: 0.09,
          }),
        ],
      }),
      opts,
    );
    const note = out.find((i) => i.id === 'note-maturity-rct');
    expect(note).toBeDefined();
    expect(note!.provenance).toBe('derived');
    expect(note!.impactAnnualUsd).not.toBeNull();
    expect(note!.impactAnnualUsd!).toBeGreaterThan(0);
    // |−REDACTED-AMT × 12| × min(120/30/12, 1) = 66854.6 × 0.3333… = 22284.87
    expect(note!.impactAnnualUsd!).toBeCloseTo(22_284.87, 1);
  });

  it('a borrower balloon with a positive workbook pmt is numerically unchanged by the abs() hardening', () => {
    const out = evaluateConditions(
      snap({ loans: [loan({ id: 'bpos', direction: 'borrower', balloon: true, maturity: iso(120), monthlyPmt: REDACTED-AMT })] }),
      opts,
    );
    const b = out.find((i) => i.id === 'balloon-bpos');
    expect(b).toBeDefined();
    // |REDACTED-AMT × 12| × 0.3333… = REDACTED-AMT × 0.3333… = 65217.84 — identical to pre-hardening.
    expect(b!.impactAnnualUsd!).toBeCloseTo(65_217.84, 1);
  });

  it('a lender note never reaches critical severity, however close its maturity', () => {
    const out = evaluateConditions(
      snap({ loans: [loan({ id: 'lend5', direction: 'lender', balloon: true, maturity: iso(3) })] }),
      opts,
    );
    // brief/run.ts emails an individual alert per NEW critical id — inbound capital must
    // never trigger a CRITICAL-branded outbound email.
    expect(out.find((i) => i.id === 'note-maturity-lend5')?.severity).toBe('warning');
  });

  it('a maturing lender-direction note never tells the reader to refinance or pay it off', () => {
    const out = evaluateConditions(
      snap({ loans: [loan({ id: 'lend3', direction: 'lender', balloon: true, maturity: iso(120) })] }),
      opts,
    );
    const note = out.find((i) => i.id === 'note-maturity-lend3');
    expect(note).toBeDefined();
    expect(note!.detail.toLowerCase()).not.toContain('refinance');
    expect(note!.detail.toLowerCase()).not.toContain('payoff');
    expect(note!.action?.kind).not.toBe('open-refi');
  });

  it('a borrower-direction balloon is unchanged — still debt, still refi (regression guard)', () => {
    const out = evaluateConditions(
      snap({ loans: [loan({ id: 'borr1', direction: 'borrower', balloon: true, maturity: iso(120) })] }),
      opts,
    );
    const b = out.find((i) => i.id === 'balloon-borr1');
    expect(b).toBeDefined();
    expect(b!.category).toBe('debt');
    expect(b!.severity).toBe('critical');
    expect(b!.detail).toContain('Prepare refinance or payoff');
    expect(b!.action?.kind).toBe('open-refi');
    expect(out.some((i) => i.id === 'note-maturity-borr1')).toBe(false);
  });

  it('a lender note beyond the warning window does not fire either alert', () => {
    const out = evaluateConditions(
      snap({ loans: [loan({ id: 'lend4', direction: 'lender', balloon: true, maturity: iso(400) })] }),
      opts,
    );
    expect(out.some((i) => i.id === 'note-maturity-lend4')).toBe(false);
    expect(out.some((i) => i.id === 'balloon-lend4')).toBe(false);
  });
  it('balloon at exactly 365d still fires (warning)', () => {
    const out = evaluateConditions(snap({ loans: [loan({ balloon: true, maturity: iso(365) })] }), opts);
    expect(out.find((i) => i.id === 'balloon-n1')?.severity).toBe('warning');
  });
  it('balloon metric is full precision, not compact (Defect 6 regression guard)', () => {
    const out = evaluateConditions(snap({ loans: [loan({ balloon: true, maturity: iso(120), absBalance: 980000 })] }), opts);
    expect(out.find((i) => i.id === 'balloon-n1')?.metric).toBe('$980,000');
  });
  it('DSCR < 1.10 is a critical floor breach', () => {
    const out = evaluateConditions(snap({ properties: [prop({ dscr: 1.09 })] }), opts);
    expect(out.find((i) => i.id === 'dscr-floor-p1')?.severity).toBe('critical');
    expect(out.some((i) => i.id === 'dscr-p1')).toBe(false);
  });
  it('DSCR 1.10–1.25 is a covenant watch warning', () => {
    const out = evaluateConditions(snap({ properties: [prop({ dscr: 1.2 })] }), opts);
    expect(out.find((i) => i.id === 'dscr-p1')?.severity).toBe('warning');
  });
  it('DSCR at exactly 1.10 is a covenant watch warning, not a floor breach (L16 boundary)', () => {
    const out = evaluateConditions(snap({ properties: [prop({ dscr: 1.10 })] }), opts);
    expect(out.find((i) => i.id === 'dscr-p1')?.severity).toBe('warning');
    expect(out.some((i) => i.id === 'dscr-floor-p1')).toBe(false);
  });
  it('DSCR >= 1.25 does not fire', () => {
    const out = evaluateConditions(snap({ properties: [prop({ dscr: 1.25 })] }), opts);
    expect(out.some((i) => i.id.startsWith('dscr'))).toBe(false);
  });
  it('LTV > 65% is a warning', () => {
    const out = evaluateConditions(snap({ properties: [prop({ ltv: 0.66 })] }), opts);
    expect(out.find((i) => i.id === 'ltv-p1')?.severity).toBe('warning');
  });
  it('LTV at 65% does not fire the warning', () => {
    const out = evaluateConditions(snap({ properties: [prop({ ltv: 0.65 })] }), opts);
    expect(out.some((i) => i.id === 'ltv-p1')).toBe(false);
  });
  // B3 Option B — two-tier LTV: info above the 40% governor, warning above the 65% ceiling.
  it('LTV above the governor (40%) but <= ceiling is an info "above governor" signal', () => {
    const out = evaluateConditions(snap({ properties: [prop({ ltv: 0.5 })] }), opts);
    expect(out.find((i) => i.id === 'ltv-governor-p1')?.severity).toBe('info');
    expect(out.some((i) => i.id === 'ltv-p1')).toBe(false); // not the high-risk warning
  });
  it('LTV at/below the governor (40%) fires nothing', () => {
    expect(evaluateConditions(snap({ properties: [prop({ ltv: 0.4 })] }), opts).some((i) => i.id.startsWith('ltv'))).toBe(false);
    expect(evaluateConditions(snap({ properties: [prop({ ltv: 0.35 })] }), opts).some((i) => i.id.startsWith('ltv'))).toBe(false);
  });
  it('LTV above the ceiling (65%) is ONLY the warning, not also the info (tiered, no double-alert)', () => {
    const out = evaluateConditions(snap({ properties: [prop({ ltv: 0.7 })] }), opts);
    expect(out.find((i) => i.id === 'ltv-p1')?.severity).toBe('warning');
    expect(out.some((i) => i.id === 'ltv-governor-p1')).toBe(false);
  });
  it('per-property LTV above the 40% aggregate governor is worded as informational, not a breach', () => {
    const out = evaluateConditions(snap({ properties: [prop({ id: 'p1', name: '1100 Rarig', ltv: 0.457 })] }), opts);
    const i = out.find((x) => x.id === 'ltv-governor-p1')!;
    expect(i.severity).toBe('info');
    expect(i.title).toBe('Property LTV above aggregate governor — 1100 Rarig');
    expect(i.detail).toContain('governor applies to the portfolio aggregate');
  });
});

describe('evaluateConditions — leases', () => {
  it('expiring < 60d is critical', () => {
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(59) })] }), opts);
    expect(out.find((i) => i.id === 'lease-expiry-l1')?.severity).toBe('critical');
    expect(out.some((i) => i.id === 'expiring-l1')).toBe(false);
  });
  // Expiry-family ids for one lease: legacy (`expiring-`, `expired-`) and L-x (`lease-expiry-`, `lease-lapsed-`).
  // Every pair carries impactAnnualUsd = annualRent, so exactly ONE may survive per lease.
  const expiryFamilyIds = (out: ReturnType<typeof evaluateConditions>, leaseId = 'l1') =>
    out.filter((i) => i.entityId === leaseId && /^(expiring|expired|lease-expiry|lease-lapsed)-/.test(i.id)).map((i) => i.id);

  it('a lease ≤90d out with no renewal stage yields ONE expiry insight, not two', () => {
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(38), annualRent: 38000 })] }), opts);
    expect(expiryFamilyIds(out)).toEqual(['lease-expiry-l1']);
  });
  it('91–180d keeps the legacy warning (L-1 does not cover it)', () => {
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(120) })] }), opts);
    expect(out.find((i) => i.id === 'expiring-l1')?.severity).toBe('warning');
    expect(out.some((i) => i.id === 'lease-expiry-l1')).toBe(false);
  });
  it('boundary: iso(90) is L-1 only; iso(91) is the legacy warning only', () => {
    const at90 = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(90) })] }), opts);
    expect(expiryFamilyIds(at90)).toEqual(['lease-expiry-l1']);
    const at91 = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(91) })] }), opts);
    expect(expiryFamilyIds(at91)).toEqual(['expiring-l1']);
    expect(at91.find((i) => i.id === 'expiring-l1')?.severity).toBe('warning');
  });
  it('holdover (Expired + past leaseEnd, no Executed stage) yields ONE expiry insight: L-2, not also the legacy expired-', () => {
    const out = evaluateConditions(snap({ leases: [lease({ status: 'Expired', leaseEnd: iso(-40), annualRent: 14808 })] }), opts);
    expect(expiryFamilyIds(out)).toEqual(['lease-lapsed-l1']);
  });
  it('Expired status with a FUTURE leaseEnd (data contradiction) yields ONE expiry insight: L-1, not also expired-', () => {
    const out = evaluateConditions(snap({ leases: [lease({ status: 'Expired', leaseEnd: iso(30) })] }), opts);
    expect(expiryFamilyIds(out)).toEqual(['lease-expiry-l1']);
  });
  it('Expired + past leaseEnd + Executed stage: L-2 does not fire, so the legacy expired- survives (nothing to dedup against)', () => {
    const out = evaluateConditions(snap({ leases: [lease({ status: 'Expired', leaseEnd: iso(-40) })], renewalStages: { l1: 'Executed' } }), opts);
    expect(expiryFamilyIds(out)).toEqual(['expired-l1']);
  });
  it('expiring beyond 180d does not fire', () => {
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(181) })] }), opts);
    expect(out.some((i) => i.id === 'expiring-l1')).toBe(false);
  });
  it('lease at exactly 60d is the single L-1 critical (legacy 60d warning boundary is inside the deduped window)', () => {
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(60) })] }), opts);
    expect(out.find((i) => i.id === 'lease-expiry-l1')?.severity).toBe('critical');
    expect(out.some((i) => i.id === 'expiring-l1')).toBe(false);
  });
  it('lease at exactly 180d still fires (warning)', () => {
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(180) })] }), opts);
    expect(out.find((i) => i.id === 'expiring-l1')?.severity).toBe('warning');
  });
  it('suppresses expiring when a renewal stage past Expiring exists', () => {
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(30) })], renewalStages: { l1: 'Negotiating' } }), opts);
    expect(out.some((i) => i.id === 'expiring-l1')).toBe(false);
  });
  it('still fires expiring when stage is Expiring (no action yet)', () => {
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(30) })], renewalStages: { l1: 'Expiring' } }), opts);
    expect(out.some((i) => i.id === 'lease-expiry-l1')).toBe(true);
  });
  it('holdover (status Expired) is a warning', () => {
    const out = evaluateConditions(snap({ leases: [lease({ status: 'Expired' })] }), opts);
    expect(out.find((i) => i.id === 'expired-l1')?.severity).toBe('warning');
  });
  it('escalation date in the past is a warning reminder', () => {
    const out = evaluateConditions(snap({ leases: [lease({ escalationDate: iso(-5) })] }), opts);
    expect(out.find((i) => i.id === 'escalation-l1')?.severity).toBe('warning');
  });
  it('future escalation date does not fire', () => {
    const out = evaluateConditions(snap({ leases: [lease({ escalationDate: iso(30) })] }), opts);
    expect(out.some((i) => i.id === 'escalation-l1')).toBe(false);
  });
});

describe('evaluateConditions — collections / AR aging (Fix #2; refute F2 — true 60+ buckets)', () => {
  // Bucket contract (src/contracts/quickbooks.ts): d30=1–30, d60=31–60, d90=61–90, d90plus=90+.
  // CRITICAL fires ONLY on dollars genuinely 60+ days past due (d90 + d90plus). The d30/d60 dollars
  // (≤60 days late) are routine and fold into the under-60 material-balance WARNING tier. d60 is NO
  // longer escalated to critical (refute F2: the prior code lumped d60 into "60+", mislabeling a
  // 31–60-day-late tenant as a critical 60+ delinquency).
  it('61–90 days past due (d90) is critical', () => {
    const out = evaluateConditions(snap({
      leases: [lease({ id: 'l1' })],
      tenantArrears: { l1: { d30: 0, d60: 0, d90: 3000, d90plus: 0 } },
    }), opts);
    const i = out.find((x) => x.id === 'arrears-l1');
    expect(i?.severity).toBe('critical');
    expect(i?.category).toBe('collections');
    expect(i?.entityType).toBe('lease');
    expect(i?.detail).toContain('60+ days past due');
  });
  it('90+ days past due (d90plus) is critical', () => {
    const out = evaluateConditions(snap({
      leases: [lease({ id: 'l1' })],
      tenantArrears: { l1: { d30: 0, d60: 0, d90: 0, d90plus: 1200 } },
    }), opts);
    expect(out.find((x) => x.id === 'arrears-l1')?.severity).toBe('critical');
  });
  it('any 60+ dollars escalate the whole receivable to critical (mixed d60 + d90)', () => {
    const out = evaluateConditions(snap({
      leases: [lease({ id: 'l1' })],
      tenantArrears: { l1: { d30: 0, d60: 1000, d90: 200, d90plus: 0 } },
    }), opts);
    expect(out.find((x) => x.id === 'arrears-l1')?.severity).toBe('critical');
  });
  it('d60 (31–60 days) is NOT critical — folds into the under-60 warning when material', () => {
    const out = evaluateConditions(snap({
      leases: [lease({ id: 'l1' })],
      tenantArrears: { l1: { d30: 0, d60: 6000, d90: 0, d90plus: 0 } },
    }), opts);
    const i = out.find((x) => x.id === 'arrears-l1');
    expect(i?.severity).toBe('warning');
    expect(i?.detail).toContain('under 60 days');
  });
  it('a d60 balance below the material floor does not fire (no 60+ dollars)', () => {
    const out = evaluateConditions(snap({
      leases: [lease({ id: 'l1' })],
      tenantArrears: { l1: { d30: 0, d60: 50, d90: 0, d90plus: 0 } },
    }), opts);
    expect(out.some((x) => x.id === 'arrears-l1')).toBe(false);
  });
  it('material balance entirely under 60 days (d30) is a warning', () => {
    const out = evaluateConditions(snap({
      leases: [lease({ id: 'l1' })],
      tenantArrears: { l1: { d30: 6000, d60: 0, d90: 0, d90plus: 0 } },
    }), opts);
    expect(out.find((x) => x.id === 'arrears-l1')?.severity).toBe('warning');
  });
  it('small short-dated balance under the material floor does not fire', () => {
    const out = evaluateConditions(snap({
      leases: [lease({ id: 'l1' })],
      tenantArrears: { l1: { d30: 1000, d60: 0, d90: 0, d90plus: 0 } },
    }), opts);
    expect(out.some((x) => x.id === 'arrears-l1')).toBe(false);
  });
  it('a tiny 60+ balance fires critical even below the material floor', () => {
    const out = evaluateConditions(snap({
      leases: [lease({ id: 'l1' })],
      tenantArrears: { l1: { d30: 0, d60: 0, d90: 50, d90plus: 0 } },
    }), opts);
    expect(out.find((x) => x.id === 'arrears-l1')?.severity).toBe('critical');
  });
  it('no arrears record → no collections alert', () => {
    const out = evaluateConditions(snap({ leases: [lease({ id: 'l1' })] }), opts);
    expect(out.some((x) => x.id === 'arrears-l1')).toBe(false);
  });
  it('zero across all buckets does not fire', () => {
    const out = evaluateConditions(snap({
      leases: [lease({ id: 'l1' })],
      tenantArrears: { l1: { d30: 0, d60: 0, d90: 0, d90plus: 0 } },
    }), opts);
    expect(out.some((x) => x.id === 'arrears-l1')).toBe(false);
  });
  it('partial/Zod-bypassing overlay record still fires (no NaN drop of a real 60+ balance)', () => {
    // tenantArrears is overlay-sourced; even after the loadOverlay Zod re-parse this stays as
    // defense-in-depth for any path that reaches the rule unparsed. A partial record with omitted
    // buckets must coerce to 0, never produce NaN and silently suppress a genuine delinquency.
    // (refute F3: numeric-correctness — worst direction for a collections monitor)
    const out = evaluateConditions(snap({
      leases: [lease({ id: 'l1' })],
      tenantArrears: { l1: { d90: 3000 } } as unknown as PortfolioSnapshot['tenantArrears'],
    }), opts);
    const i = out.find((x) => x.id === 'arrears-l1');
    expect(i?.severity).toBe('critical');
  });
  it('a negative current-bucket credit does NOT suppress a real 60+ critical (refute edges)', () => {
    // A large AR credit/prepayment in d30 must not net total <= 0 and short-circuit the over-60 gate.
    const out = evaluateConditions(snap({
      leases: [lease({ id: 'l1' })],
      tenantArrears: { l1: { d30: -5000, d60: 0, d90: 3000, d90plus: 0 } } as unknown as PortfolioSnapshot['tenantArrears'],
    }), opts);
    expect(out.find((x) => x.id === 'arrears-l1')?.severity).toBe('critical');
  });
  it('a negative current-bucket credit does NOT net DOWN the displayed total', () => {
    const out = evaluateConditions(snap({
      leases: [lease({ id: 'l1' })],
      tenantArrears: { l1: { d30: -4000, d60: 0, d90: 5000, d90plus: 0 } } as unknown as PortfolioSnapshot['tenantArrears'],
    }), opts);
    const i = out.find((x) => x.id === 'arrears-l1');
    expect(i?.metric).toBe('$5,000');               // credit clamped to 0, not subtracted from total
    expect(i?.detail).toContain('$5,000 is 60+ days past due');
  });
});

describe('evaluateConditions — concentration, insurance, cash', () => {
  it('tenant > 15% of portfolio NOI is an info concentration alert', () => {
    const s = snap({
      properties: [prop({ id: 'p1', noi: 100000 })],
      leases: [
        lease({ id: 'l1', company: 'BigTenant', propertyId: 'p1', annualRent: 80000 }),
        lease({ id: 'l2', company: 'SmallTenant', propertyId: 'p1', annualRent: 20000 }),
      ],
    });
    const out = evaluateConditions(s, opts);
    expect(out.find((i) => i.category === 'concentration' && i.id.startsWith('concentration-'))?.severity).toBe('info');
  });
  it('lapsed policy is critical', () => {
    const out = evaluateConditions(snap({ insurance: [policy({ status: 'Expired' })] }), opts);
    expect(out.find((i) => i.id === 'ins-lapsed-i1')?.severity).toBe('critical');
  });
  it('policy renewing within 30d is a warning', () => {
    const out = evaluateConditions(snap({ insurance: [policy({ daysToExpiry: 20, expires: iso(20) })] }), opts);
    expect(out.find((i) => i.id === 'ins-i1')?.severity).toBe('warning');
  });
  // F6 (adversarial refute-financial-change finding, 2026-07-12) — expires and daysToExpiry are
  // independently-parsed workbook columns (parse.ts col 6 vs col 10); a row can have a populated
  // daysToExpiry with a blank/unparseable Expires cell. The F3 fix re-gated the whole renewing/
  // lapsed tail behind `p.expires !== null`, silently dropping the warning this exact fixture used
  // to fire pre-F3. Fall back to the workbook's own daysToExpiry column when there's no expires
  // date to compute a live day-count from.
  it('F6: policy renewing within 30d per the workbook daysToExpiry column still warns when expires is null', () => {
    const out = evaluateConditions(snap({ insurance: [policy({ daysToExpiry: 20, expires: null })] }), opts);
    const ins = out.find((i) => i.id === 'ins-i1');
    expect(ins).toBeDefined();
    expect(ins!.severity).toBe('warning');
    expect(ins!.detail).toContain('20d');
  });
  it('cash concentration > 30% is a warning', () => {
    const out = evaluateConditions(snap({ cash: { asOf: ASOF, totalCash: 100, activeEntities: 2, largestEntity: 'E1', concentrationTopPct: 0.31, cagr: null, entities: [], history: [] } }), opts);
    expect(out.find((i) => i.id === 'cash-concentration')?.severity).toBe('warning');
  });
  it('cash concentration at 30% does not fire', () => {
    const out = evaluateConditions(snap({ cash: { asOf: ASOF, totalCash: 100, activeEntities: 2, largestEntity: 'E1', concentrationTopPct: 0.3, cagr: null, entities: [], history: [] } }), opts);
    expect(out.some((i) => i.id === 'cash-concentration')).toBe(false);
  });
});

describe('evaluateConditions — data quality & deals', () => {
  it('a reconciliation flag fires a critical data alert', () => {
    const out = evaluateConditions(snap({ dataQuality: [{ entity: 'reconciliation', field: 'NOI total', issue: 'mismatch', severity: 'error' }] }), opts);
    expect(out.find((i) => i.id === 'reconcile-fail')?.severity).toBe('critical');
    expect(out.find((i) => i.id === 'reconcile-fail')?.category).toBe('data');
  });
  it('non-reconciliation flags do not fire the reconcile alert', () => {
    const out = evaluateConditions(snap({ dataQuality: [{ entity: 'p1', field: 'noi', issue: 'bad source', severity: 'warn' }] }), opts);
    expect(out.some((i) => i.id === 'reconcile-fail')).toBe(false);
  });
  it('workbook older than 48h is an info alert', () => {
    const stale = { ...snap(), meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: new Date(NOW - 49 * 3_600_000).toISOString(), source: 't', scenario: 'Base' } } as unknown as PortfolioSnapshot;
    const out = evaluateConditions(stale, opts);
    expect(out.find((i) => i.id === 'workbook-stale')?.severity).toBe('info');
  });
  it('workbook within 48h does not fire', () => {
    const fresh = { ...snap(), meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: new Date(NOW - 47 * 3_600_000).toISOString(), source: 't', scenario: 'Base' } } as unknown as PortfolioSnapshot;
    const out = evaluateConditions(fresh, opts);
    expect(out.some((i) => i.id === 'workbook-stale')).toBe(false);
  });
  it('LOI/PSA deadline within 14d is a warning', () => {
    const out = evaluateConditions(snap({ deals: [deal({ stage: 'LOI/PSA', targetCloseDate: iso(7) })] }), opts);
    expect(out.find((i) => i.id === 'loi-d1')?.severity).toBe('warning');
  });
  it('deal stage-move fires only when priorStages is supplied', () => {
    const withPrior = evaluateConditions(snap({ deals: [deal({ id: 'd1', stage: 'Closing' })] }), { now: NOW, priorStages: { d1: 'Due Diligence' } });
    expect(withPrior.find((i) => i.id === 'move-d1')?.category).toBe('deal');
    const noPrior = evaluateConditions(snap({ deals: [deal({ id: 'd1', stage: 'Closing' })] }), opts);
    expect(noPrior.some((i) => i.id === 'move-d1')).toBe(false);
  });
  it('sorts critical before warning before info', () => {
    const out = evaluateConditions(snap({
      properties: [prop({ id: 'p1', dscr: 1.05, ltv: 0.7 })],
      cash: { asOf: ASOF, totalCash: 100, activeEntities: 2, largestEntity: 'E1', concentrationTopPct: 0.4, cagr: null, entities: [], history: [] },
    }), opts);
    const ranks = out.map((i) => ({ critical: 0, warning: 1, info: 2 })[i.severity]);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
  });
});

describe('ALERT_THRESHOLDS', () => {
  it('exposes the canonical numbers', () => {
    expect(ALERT_THRESHOLDS.leaseCriticalDays).toBe(60);
    expect(ALERT_THRESHOLDS.leaseWarningDays).toBe(180);
    expect(ALERT_THRESHOLDS.cashConcentrationWarn).toBe(0.3);
  });
  it('pins the alert-specific (non-governor) thresholds; governor thresholds moved to the payload (I10)', () => {
    expect(ALERT_THRESHOLDS.dscrCriticalFloor).toBe(1.1);
    expect(ALERT_THRESHOLDS.refiLtvCeilingPerProperty).toBe(0.65);
    // dscrWatch / ltvGovernor no longer live here: the governor boundaries ride the snapshot
    // payload (s.governors, warehouse-fresh) with GOVERNOR_FALLBACK for legacy snapshots.
    expect('dscrWatch' in ALERT_THRESHOLDS).toBe(false);
    expect('ltvGovernor' in ALERT_THRESHOLDS).toBe(false);
  });
  it('the fallback governor set tracks the ratified capital governor — cannot silently drift (B3/I10)', () => {
    // GOVERNOR_FALLBACK guards only legacy payloads; it MUST equal the server's compile-time
    // ratified set (CLAUDE.md §4, capital-config.ts) — never edit one without the other.
    expect(GOVERNOR_FALLBACK.ltvCeiling).toBe(CAPITAL_CONFIG.ltvCeiling);
    expect(GOVERNOR_FALLBACK.dscrFloor).toBe(CAPITAL_CONFIG.dscrFloor);
    expect(GOVERNOR_FALLBACK.version).toBe(CAPITAL_CONFIG.version);
    expect(GOVERNOR_FALLBACK.effectiveFrom).toBe(CAPITAL_CONFIG.effectiveFrom);
    expect(GOVERNOR_FALLBACK.dscrFloor).toBe(1.25);
    expect(GOVERNOR_FALLBACK.ltvCeiling).toBe(0.4);
    // hurdleRatePct (item-8 capex-IRR calculator) drift-pinned the same way as dscrFloor/ltvCeiling.
    expect(GOVERNOR_FALLBACK.hurdleRatePct).toBe(CAPITAL_CONFIG.hurdleRatePct);
    expect(GOVERNOR_FALLBACK.hurdleRatePct).toBe(0.08);
    expect(GOVERNOR_FALLBACK.hurdleRateRatification).toBe(CAPITAL_CONFIG.hurdleRateRatification);
    expect(GOVERNOR_FALLBACK.hurdleRateRatification).toBe('ratified');
  });

  // -------------------------------------------------------------------------
  // Refute-pass finding: hurdleRatePct was added as a REQUIRED zod field. Since the whole
  // `governors` snapshot field is `.nullable().default(null).catch(null)`, a payload whose
  // governors object is missing just this ONE new field (an un-restarted old server, or a
  // baked mirror snapshot from before this field existed -- a real deploy-skew window) would fail
  // the ENTIRE GovernorSet parse and lose dscrFloor/ltvCeiling too, silently degrading DSCR/LTV
  // alerts to compile-time fallback. hurdleRatePct must default on its own so a skewed payload
  // still keeps its other (older, already-relied-upon) governor fields.
  // -------------------------------------------------------------------------
  it('a governors payload missing ONLY hurdleRatePct (deploy-skew shape) still parses -- dscrFloor/ltvCeiling are not lost', () => {
    const skewed = { dscrFloor: 1.30, ltvCeiling: 0.35, version: 2, effectiveFrom: '2026-08-01' };
    const parsed = GovernorSet.parse(skewed);
    expect(parsed.dscrFloor).toBe(1.30);
    expect(parsed.ltvCeiling).toBe(0.35);
    expect(parsed.hurdleRatePct).toBe(GOVERNOR_FALLBACK.hurdleRatePct); // defaults, doesn't reject
  });

  // -------------------------------------------------------------------------
  // Round-3 finding (S2): the skew test above pins GOVERNOR_FALLBACK/CAPITAL_CONFIG agreement, but
  // never pins the SCHEMA's own `.default('ratified')` independently -- flip that default to
  // 'proposed' and every existing assertion (all sourced from GOVERNOR_FALLBACK, a separately
  // hand-maintained constant, not the schema) would stay green while every skew/fallback-shaped
  // payload spuriously banners as non-binding. Parse a payload missing hurdleRateRatification and
  // assert the schema's own default value directly, with no GOVERNOR_FALLBACK indirection.
  // -------------------------------------------------------------------------
  it('the GovernorSet schema defaults hurdleRateRatification to "ratified" on its own (not via GOVERNOR_FALLBACK)', () => {
    const skewed = { dscrFloor: 1.30, ltvCeiling: 0.35, hurdleRatePct: 0.09, version: 2, effectiveFrom: '2026-08-01' };
    const parsed = GovernorSet.parse(skewed);
    expect(parsed.hurdleRateRatification).toBe('ratified');
  });
});

describe('evaluateConditions — payload-sourced governors (I10)', () => {
  const gov = (o: Partial<{ dscrFloor: number; ltvCeiling: number }> = {}) =>
    ({ dscrFloor: 1.25, ltvCeiling: 0.4, hurdleRatePct: 0.08, hurdleRateRatification: 'ratified' as const, version: 2, effectiveFrom: '2026-07-16', ...o });

  it('a tightened payload DSCR governor moves the watch boundary — no conditions.ts edit', () => {
    const s = snap({ properties: [prop({ dscr: 1.30 })], governors: gov({ dscrFloor: 1.35 }) });
    expect(evaluateConditions(s, opts).find((i) => i.id === 'dscr-p1')?.severity).toBe('warning');
  });

  it('the same property does not fire under the fallback governor (1.30 >= 1.25)', () => {
    const out = evaluateConditions(snap({ properties: [prop({ dscr: 1.30 })] }), opts);
    expect(out.find((i) => i.id === 'dscr-p1')).toBeUndefined();
  });

  it('a tightened payload LTV governor moves the info tier and its interpolated boundary text', () => {
    const s = snap({ properties: [prop({ ltv: 0.36 })], governors: gov({ ltvCeiling: 0.35 }) });
    const hit = evaluateConditions(s, opts).find((i) => i.id === 'ltv-governor-p1');
    expect(hit?.severity).toBe('info');
    expect(hit?.detail).toContain('35'); // boundary text derives from the payload, not a literal
  });

  it('fallback: ltv 0.36 within the 0.40 fallback governor — no info alert', () => {
    const out = evaluateConditions(snap({ properties: [prop({ ltv: 0.36 })] }), opts);
    expect(out.find((i) => i.id === 'ltv-governor-p1')).toBeUndefined();
  });
});

describe('evaluateConditions — insight id uniqueness invariant (refute F1 class)', () => {
  // Insight.id is the read/snooze + React key. Two insights sharing an id corrupt each other's
  // state (the F1 collision). evaluateConditions ids must be unique across every condition it fires
  // for a many-entity snapshot — a mechanical guard against any future rule reusing an id pattern.
  it('emits no duplicate ids across a multi-lease, multi-condition snapshot', () => {
    const out = evaluateConditions(snap({
      properties: [prop({ id: 'p1', noi: 100000 })],
      leases: [
        lease({ id: 'l1', propertyId: 'p1', leaseEnd: iso(30) }),
        lease({ id: 'l2', propertyId: 'p1', escalationDate: iso(-5) }),
      ],
      loans: [loan({ id: 'n1', balloon: true, maturity: iso(120) })],
      insurance: [policy({ id: 'i1', expires: iso(10), daysToExpiry: 10 })],
      tenantArrears: {
        l1: { d30: 0, d60: 0, d90: 8000, d90plus: 0 },
        l2: { d30: 0, d60: 0, d90: 0, d90plus: 9000 },
      },
    }), opts);
    const ids = out.map((i) => i.id);
    expect(ids.length).toBeGreaterThan(3);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── Phase 2 slice 1: balloon impactAnnualUsd enrichment + refi-spread signal ──────────────────
describe('evaluateConditions — debt proximity + refi spread', () => {
  // (a) Balloon with monthlyPmt=10000 → annualDS=120000. maturity iso(180) ≈ 6 months.
  //     factor = min(180/30/12, 1) = min(0.5, 1) = 0.5 → impactAnnualUsd ≈ 60000.
  //     Tolerance: days→months conversion is approximate (30-day month proxy), so we allow ±5%.
  it('(a) balloon with monthlyPmt derives impactAnnualUsd ≈ annualDS * min(monthsRemaining/12, 1)', () => {
    const l = loan({ balloon: true, maturity: iso(180), monthlyPmt: 10000, absBalance: 500000 });
    const out = evaluateConditions(snap({ loans: [l] }), opts);
    const insight = out.find((i) => i.id === 'balloon-n1');
    expect(insight).toBeDefined();
    expect(insight!.provenance).toBe('derived');
    // annualDS = 120000; factor ≈ 0.5 → impact ≈ 60000. Allow ±5%.
    expect(insight!.impactAnnualUsd).not.toBeNull();
    expect(insight!.impactAnnualUsd!).toBeGreaterThan(57000);
    expect(insight!.impactAnnualUsd!).toBeLessThan(63000);
  });

  // (b) All debt-service inputs null → impactAnnualUsd null, provenance 'absent' (unchanged behavior).
  it('(b) balloon with all debt-service fields null leaves impactAnnualUsd null, provenance absent', () => {
    const l = loan({
      balloon: true, maturity: iso(120),
      monthlyPmt: null, annualInterest: null, annualPrincipal: null, rate: null,
    });
    const out = evaluateConditions(snap({ loans: [l] }), opts);
    const insight = out.find((i) => i.id === 'balloon-n1');
    expect(insight).toBeDefined();
    expect(insight!.impactAnnualUsd).toBeNull();
    expect(insight!.provenance).toBe('absent');
  });

  // (c) live days/30 > 12 (F2 fix: the days-based run-date proxy, NOT the workbook's own
  //     monthsToMaturity column, drives the cap) → factor min(days/30/12, 1) = 1 → impact ==
  //     full annualDebtService. maturity iso(363) → days=363, days/30≈12.1 (>12) while staying
  //     within balloonWarningDays=365 so the alert still fires.
  it('(c) balloon within warning window, live days/30 > 12 caps factor at 1 → impact == full annualDS', () => {
    const annualDS = 96000; // monthlyPmt=8000
    const l = loan({
      balloon: true, maturity: iso(363), // within 365d warning window; days/30 ≈ 12.1 (>12)
      monthlyPmt: 8000,
    });
    const out = evaluateConditions(snap({ loans: [l] }), opts);
    const insight = out.find((i) => i.id === 'balloon-n1');
    expect(insight).toBeDefined();
    expect(insight!.impactAnnualUsd).not.toBeNull();
    // factor = min(12.1/12, 1) = 1 → full annualDS
    expect(insight!.impactAnnualUsd!).toBeCloseTo(annualDS, 0);
  });

  // (c2) F2 regression guard — a stale/frozen monthsToMaturity column (baked from an old
  //     workbook while the balloon insight's severity/day-count now runs off the live reference
  //     date) must NOT distort impactAnnualUsd or the displayed month count. maturity iso(300) →
  //     live days/30 = 10 months (factor 10/12, impact ≈ 80000); monthsToMaturity is deliberately
  //     set to a stale 3 (which would give factor 3/12, impact 24000 if wrongly preferred) to
  //     prove the live basis wins, not the frozen column.
  it('(c2) a stale monthsToMaturity column does not distort impactAnnualUsd or the detail month count', () => {
    const l = loan({
      balloon: true, maturity: iso(300), // live days/30 = 10 months
      monthlyPmt: 8000, // annualDS = 96000
      monthsToMaturity: 3, // stale workbook column — must be ignored
    });
    const out = evaluateConditions(snap({ loans: [l] }), opts);
    const insight = out.find((i) => i.id === 'balloon-n1');
    expect(insight).toBeDefined();
    // factor = min(10/12, 1) ≈ 0.833 → impact ≈ 80000, NOT the stale-column-derived 24000.
    expect(insight!.impactAnnualUsd!).toBeGreaterThan(78000);
    expect(insight!.impactAnnualUsd!).toBeLessThan(82000);
    expect(insight!.detail).toContain('10 mo');
    expect(insight!.detail).not.toContain('3 mo');
  });

  // (d) refi-spread fires for a borrower loan with rate > estimatedMarketRate + refiSpreadBps.
  //     rate=0.075, estimatedMarketRate=0.065, refiSpreadBps=0.005 → spread = 0.075 - 0.065 = 0.01
  //     impact = (0.075 - 0.065) * 1,000,000 = 10,000; severity info; provenance derived.
  it('(d) refi-spread fires for borrower loan with rate above market + spread threshold', () => {
    const l = loan({ id: 'r1', direction: 'borrower', rate: 0.075, absBalance: 1_000_000 });
    const out = evaluateConditions(snap({ loans: [l] }), opts);
    const insight = out.find((i) => i.id === 'refi-spread-r1');
    expect(insight).toBeDefined();
    expect(insight!.severity).toBe('info');
    expect(insight!.category).toBe('debt');
    expect(insight!.provenance).toBe('derived');
    expect(insight!.spine).toBe('B');
    // impact = (0.075 - 0.065) * 1,000,000 = 10,000
    expect(insight!.impactAnnualUsd).not.toBeNull();
    expect(insight!.impactAnnualUsd!).toBeCloseTo(10_000, 0);
  });

  // (e) refi-spread does NOT fire when rate = 0.068 (= estimatedMarketRate + refiSpreadBps = 0.070;
  //     0.068 < 0.070, so threshold not exceeded).
  it('(e) refi-spread does NOT fire when rate is at or below market + spread threshold', () => {
    const l = loan({ id: 'r2', direction: 'borrower', rate: 0.068, absBalance: 1_000_000 });
    const out = evaluateConditions(snap({ loans: [l] }), opts);
    expect(out.some((i) => i.id.startsWith('refi-spread-'))).toBe(false);
  });

  // (f) refi-spread does NOT fire for a lender/internal loan even with a high rate.
  it('(f) refi-spread does NOT fire for lender-direction loans (no ORA interest obligation)', () => {
    const lLender = loan({ id: 'r3', direction: 'lender', rate: 0.09, absBalance: 500_000 });
    const lInternal = loan({ id: 'r4', direction: 'internal', rate: 0.09, absBalance: 500_000 });
    const out = evaluateConditions(snap({ loans: [lLender, lInternal] }), opts);
    expect(out.some((i) => i.id.startsWith('refi-spread-'))).toBe(false);
  });
});

// ── Phase 1: dollar-ranked alert display ─────────────────────────────────────────────────────
describe('evaluateConditions — dollar ranking', () => {
  // Within a severity tier, insights sort by impactAnnualUsd DESC (nulls last).
  // Severity ordering remains primary — a critical with null impact beats a warning with $1M impact.

  it('within the same severity tier, higher impactAnnualUsd sorts first — even when low-dollar is inserted first', () => {
    // Two expiring leases (same severity = warning), different annualRent.
    // SmallTenant ($20K) is inserted FIRST so insertion order favours it,
    // but dollar-rank must put BigTenant ($50K) first instead.
    // 120d: the legacy `expiring-` warning survives only in the 91–180d window (≤90d is L-1's).
    const out = evaluateConditions(snap({
      leases: [
        lease({ id: 'l1', company: 'SmallTenant', leaseEnd: iso(120), annualRent: 20000 }),
        lease({ id: 'l2', company: 'BigTenant',   leaseEnd: iso(120), annualRent: 50000 }),
      ],
    }), opts);
    const l1idx = out.findIndex((i) => i.id === 'expiring-l1'); // $20K — inserted first
    const l2idx = out.findIndex((i) => i.id === 'expiring-l2'); // $50K — inserted second
    expect(l1idx).toBeGreaterThanOrEqual(0);
    expect(l2idx).toBeGreaterThanOrEqual(0);
    // Dollar ranking must put l2 ($50K) before l1 ($20K), overriding insertion order.
    expect(l2idx).toBeLessThan(l1idx);
  });

  it('within the same severity tier, a null-impact insight sorts after a numeric-impact insight — even when null is inserted first', () => {
    // balloon (null impact, warning) is inserted before lease (warning, $20K) in the loop.
    // Dollar ranking must put the lease (numeric) before the balloon (null).
    const out = evaluateConditions(snap({
      loans:  [loan({ id: 'n1', balloon: true, maturity: iso(200) })],
      leases: [lease({ id: 'l1', company: 'Tenant', leaseEnd: iso(120), annualRent: 20000 })], // 120d → legacy warning (≤90d is L-1's)
    }), opts);
    const balloonIdx = out.findIndex((i) => i.id === 'balloon-n1'); // null impact, warning — inserted first
    const leaseIdx   = out.findIndex((i) => i.id === 'expiring-l1'); // $20K impact, warning — inserted second
    expect(leaseIdx).toBeGreaterThanOrEqual(0);
    expect(balloonIdx).toBeGreaterThanOrEqual(0);
    expect(out[leaseIdx]!.severity).toBe('warning');
    expect(out[balloonIdx]!.severity).toBe('warning');
    expect(out[leaseIdx]!.impactAnnualUsd).toBeGreaterThan(0);
    expect(out[balloonIdx]!.impactAnnualUsd).toBeNull();
    // Dollar ranking must put lease (numeric) before balloon (null), overriding insertion order.
    expect(leaseIdx).toBeLessThan(balloonIdx);
  });

  it('severity ordering is still primary — critical with null impact precedes warning with $1M impact', () => {
    // critical: reconciliation failure (null impact) must come before any warning
    // warning: large expiring lease ($1M/yr)
    const out = evaluateConditions(snap({
      leases: [lease({ id: 'l1', company: 'BigTenant', leaseEnd: iso(120), annualRent: 1_000_000 })], // 120d → legacy warning (≤90d is L-1's)
      dataQuality: [{ entity: 'reconciliation', field: 'NOI total', issue: 'mismatch', severity: 'error' }],
    }), opts);
    const critIdx = out.findIndex((i) => i.id === 'reconcile-fail');
    const warnIdx = out.findIndex((i) => i.id === 'expiring-l1');
    expect(critIdx).toBeGreaterThanOrEqual(0);
    expect(warnIdx).toBeGreaterThanOrEqual(0);
    expect(out[critIdx]!.severity).toBe('critical');
    expect(out[warnIdx]!.severity).toBe('warning');
    expect(out[critIdx]!.impactAnnualUsd).toBeNull();
    expect(out[warnIdx]!.impactAnnualUsd).toBe(1_000_000);
    expect(critIdx).toBeLessThan(warnIdx);
  });

  it('two null-impact insights of the same severity preserve stable relative order', () => {
    // Two info-severity alerts both with null impact: ltv-governor and workbook-stale.
    // Neither must error or crash the sort.
    const stale = { ...snap({
      properties: [prop({ id: 'p1', ltv: 0.5 })],
    }), meta: { schemaVersion: '1.0.0', asOf: ASOF, generatedAt: new Date(NOW - 49 * 3_600_000).toISOString(), source: 't', scenario: 'Base' } } as unknown as PortfolioSnapshot;
    const out = evaluateConditions(stale, opts);
    const infoItems = out.filter((i) => i.severity === 'info');
    expect(infoItems.length).toBeGreaterThanOrEqual(2);
    infoItems.forEach((i) => expect(i.impactAnnualUsd).toBeNull());
  });

  // Adversarial-review follow-up (refute-financial-change wf_b8410252-041, determinism lens):
  // the F2 fix collapsed every past-due balloon's impactAnnualUsd to the same value (0 — the
  // monthsRemaining clamp), so two equally-critical past-due balloons now tie on both severity
  // AND impactAnnualUsd. Without a final tie-breaker their relative order depends on s.loans
  // iteration order (still deterministic given a fixed array, but not stable against a future
  // caller that reorders/merges loans differently). Lock in an id-based tie-breaker, matching
  // the pattern already used in capital-allocation.ts and insurance-conditions.ts.
  it('two tied (same severity, same impactAnnualUsd) insights sort by id, independent of insertion order', () => {
    const l1 = loan({ id: 'z-loan', balloon: true, maturity: iso(-30), monthlyPmt: 5000 }); // past-due → critical, impact 0
    const l2 = loan({ id: 'a-loan', balloon: true, maturity: iso(-30), monthlyPmt: 5000 }); // same — ties on severity + impact
    const outAsc = evaluateConditions(snap({ loans: [l1, l2] }), opts); // z-loan inserted first
    const outDesc = evaluateConditions(snap({ loans: [l2, l1] }), opts); // a-loan inserted first
    const idsAsc = outAsc.filter((i) => i.id.startsWith('balloon-')).map((i) => i.id);
    const idsDesc = outDesc.filter((i) => i.id.startsWith('balloon-')).map((i) => i.id);
    expect(idsAsc).toEqual(['balloon-a-loan', 'balloon-z-loan']);
    // Same output order regardless of which loan was inserted first — insertion order no
    // longer decides the tie.
    expect(idsDesc).toEqual(idsAsc);
  });
});

// ── M3: Cached DGS5 threading — no live HTTP from analytics path ──────────────────────────────
describe('evaluateConditions — M3: cachedMarketRate threading (DGS5)', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  // (M3-1) When a cachedMarketRate is provided, the refi-spread condition uses it instead of 0.065.
  // e.g. DGS5 = 4.00% + 200 bps industrialLenderSpread → effectiveMarketRate = 0.060
  // A loan at 0.070 with market at 0.060 + refiSpreadBps(0.005) → threshold 0.065:
  //   0.070 > 0.065 → fires. impact = (0.070 - 0.060) * 1,000,000 = 10,000
  it('(M3-1) cachedMarketRate supplied: refi-spread uses the live rate, not 0.065', () => {
    const l = loan({ id: 'm3a', direction: 'borrower', rate: 0.070, absBalance: 1_000_000 });
    const out = evaluateConditions(
      snap({ loans: [l] }),
      { ...opts, cachedMarketRate: 0.060 },
    );
    const insight = out.find((i) => i.id === 'refi-spread-m3a');
    expect(insight).toBeDefined();
    // impact = (0.070 - 0.060) * 1,000,000 = 10,000
    expect(insight!.impactAnnualUsd).toBeCloseTo(10_000, 0);
    // detail must reference the live rate (0.060 = 6.00%), not the fallback 0.065
    expect(insight!.detail).toContain('6.00%');
    expect(insight!.detail).not.toContain('6.50%');
  });

  // (M3-2) When cachedMarketRate is null/undefined, fall back to 0.065 and the refi alert still fires.
  // A loan at 0.075: 0.075 > 0.065 + 0.005 = 0.070 → fires with impact = (0.075 - 0.065) * 500,000 = 5,000
  it('(M3-2) null cachedMarketRate: falls back to 0.065 — refi alert does NOT drop silently', () => {
    const l = loan({ id: 'm3b', direction: 'borrower', rate: 0.075, absBalance: 500_000 });
    // No cachedMarketRate — must fall back to 0.065
    const out = evaluateConditions(snap({ loans: [l] }), opts);
    const insight = out.find((i) => i.id === 'refi-spread-m3b');
    expect(insight).toBeDefined();
    expect(insight!.impactAnnualUsd).toBeCloseTo(5_000, 0);
    // detail must reference the 0.065 fallback rate
    expect(insight!.detail).toContain('6.50%');
  });

  // (M3-2b) Explicit null cachedMarketRate still falls back to 0.065 — same assertion.
  it('(M3-2b) explicit cachedMarketRate: undefined → fallback 0.065, alert fires', () => {
    const l = loan({ id: 'm3c', direction: 'borrower', rate: 0.075, absBalance: 500_000 });
    const out = evaluateConditions(snap({ loans: [l] }), { ...opts, cachedMarketRate: undefined });
    const insight = out.find((i) => i.id === 'refi-spread-m3c');
    expect(insight).toBeDefined();
    expect(insight!.detail).toContain('6.50%');
  });

  // (M3-3) CRITICAL: No live HTTP — fetch and fetchFredMacro must never be called
  //         during evaluateConditions execution, regardless of opts.
  it('(M3-3) evaluateConditions NEVER calls fetch or fetchFredMacro — no live HTTP on the analytics path', () => {
    const fetchSpy = vi.spyOn(global, 'fetch');
    const l = loan({ id: 'm3d', direction: 'borrower', rate: 0.075, absBalance: 1_000_000 });
    // Run both with and without cachedMarketRate
    evaluateConditions(snap({ loans: [l] }), opts);
    evaluateConditions(snap({ loans: [l] }), { ...opts, cachedMarketRate: 0.050 });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  // (M3-4) cachedMarketRate changes the threshold — a loan that would NOT fire at 0.065
  //         DOES fire when the live rate is lower (market is cheaper now).
  // cachedMarketRate = 0.045. threshold = 0.045 + 0.005 = 0.050.
  // loan rate = 0.055 → 0.055 > 0.050 → fires. At 0.065 fallback: 0.055 < 0.070 → would NOT fire.
  it('(M3-4) a lower live rate lowers the threshold — loan that would miss at 0.065 fires at 0.045', () => {
    const l = loan({ id: 'm3e', direction: 'borrower', rate: 0.055, absBalance: 2_000_000 });
    // Without cachedMarketRate: 0.055 < 0.065+0.005=0.070 → does NOT fire
    const outFallback = evaluateConditions(snap({ loans: [l] }), opts);
    expect(outFallback.some((i) => i.id === 'refi-spread-m3e')).toBe(false);
    // With cachedMarketRate=0.045: 0.055 > 0.045+0.005=0.050 → DOES fire
    const outLive = evaluateConditions(
      snap({ loans: [l] }),
      { ...opts, cachedMarketRate: 0.045 },
    );
    const insight = outLive.find((i) => i.id === 'refi-spread-m3e');
    expect(insight).toBeDefined();
    expect(insight!.impactAnnualUsd).toBeCloseTo((0.055 - 0.045) * 2_000_000, 0);
  });
});

// ── M3: extractDgs5MarketRate — direct unit tests (refute finding: zero coverage on conversion) ─
describe('extractDgs5MarketRate', () => {
  // Helper to build a minimal MacroSnapshot with a single DGS5 indicator.
  function macroWith(dgs5Value: number | null): MacroSnapshot {
    return {
      asOf: '2026-06-22',
      source: 'mock',
      indicators: [
        { id: 'DGS5', label: '5Y Treasury', value: dgs5Value, unit: '%', change: null },
        { id: 'DGS10', label: '10Y Treasury', value: 4.47, unit: '%', change: null },
      ],
      tenYearHistory: [],
    };
  }
  function macroMissingDgs5(): MacroSnapshot {
    return { asOf: '2026-06-22', source: 'mock', indicators: [], tenYearHistory: [] };
  }

  it('converts percent to decimal and adds industrialLenderSpread', () => {
    // DGS5 = 4.18% → 0.0418 + 0.020 = 0.0618
    const result = extractDgs5MarketRate(macroWith(4.18));
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(0.0618, 4);
  });

  it('seeded DGS5 (4.18%) produces ≈ 6.18%, consistent with the 6.5% fallback', () => {
    // This pins the calibration: seeded rate (6.18%) < fallback (6.5%) by ≈ 32 bps.
    // A live seeded run should fire MORE refi alerts than the fallback, not fewer.
    const result = extractDgs5MarketRate(macroWith(4.18));
    expect(result!).toBeGreaterThan(0.059); // > 5.9%
    expect(result!).toBeLessThan(0.065);    // < 6.5% (the fallback)
  });

  it('returns null when DGS5 indicator is absent from the snapshot', () => {
    expect(extractDgs5MarketRate(macroMissingDgs5())).toBeNull();
  });

  it('returns null when DGS5 value is null (FRED outage / missing observation)', () => {
    expect(extractDgs5MarketRate(macroWith(null))).toBeNull();
  });

  it('rate = 0 is finite and accepted: returns 0/100 + spread = spread-only rate', () => {
    // A zero-rate DGS5 is unusual but valid (e.g., deflationary scenario).
    // Must return spread-only (0.020), NOT null — we must not silently discard a genuine rate.
    const result = extractDgs5MarketRate(macroWith(0));
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(ALERT_THRESHOLDS.industrialLenderSpread, 6);
  });

  it('percent-to-decimal conversion: 1% DGS5 → 0.01 decimal → 0.01 + 0.020 = 0.030', () => {
    // Direct assertion on the /100 arithmetic — guards a regression that drops the /100 divide
    // (which would produce 1 + 0.020 = 1.020, a 102% rate that silences every refi alert).
    const result = extractDgs5MarketRate(macroWith(1.0));
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(0.030, 6); // 0.010 + 0.020
  });

  it('high DGS5 (7.0%) → decimal 0.07 + 0.020 = 0.090 (raises threshold — fewer alerts)', () => {
    const result = extractDgs5MarketRate(macroWith(7.0));
    expect(result).not.toBeNull();
    expect(result!).toBeCloseTo(0.090, 6);
  });
});

// ── Insurance alert TITLE distinguishability (2026-08-11) ────────────────────
// Incident: on 2026-06-21 four properties each produced TWO "Policy expired — <property>"
// emails one second apart. They were NOT duplicates (send-log `bytes=` differed on every
// pair) — they were one alert per POLICY carrying a title that named only the PROPERTY, so
// two genuinely distinct lapsed policies were indistinguishable in the inbox. The alert
// subject is `[ORA Command Center] CRITICAL: ${title}` (server/brief/render.ts), so the
// title is the ONLY thing separating them. Ruling (Gabriel, 2026-08-11): keep one alert per
// policy — both are real things to fix — and disambiguate via the coverage.
describe('evaluateConditions — insurance alert titles disambiguate co-located policies', () => {
  const twoLapsedAtOneProperty = {
    insurance: [
      policy({ id: 'ins-fvc-pckg', property: 'Sepich Portfolio', coverage: 'Package (PCKG)', status: 'Expired' }),
      policy({ id: 'ins-fvc-bcl', property: 'Sepich Portfolio', coverage: 'Business Crime Liability (BCL)', status: 'Expired' }),
    ],
  };

  it('two lapsed policies at one property produce two DISTINCT titles', () => {
    const out = evaluateConditions(snap(twoLapsedAtOneProperty), opts);
    const titles = out.filter((i) => i.id.startsWith('ins-lapsed-')).map((i) => i.title);
    expect(titles).toHaveLength(2);
    expect(new Set(titles).size).toBe(2); // the whole point — no two identical subjects
  });

  it('each title still names the property AND now names the coverage', () => {
    const out = evaluateConditions(snap(twoLapsedAtOneProperty), opts);
    const pckg = out.find((i) => i.id === 'ins-lapsed-ins-fvc-pckg')!;
    const bcl = out.find((i) => i.id === 'ins-lapsed-ins-fvc-bcl')!;
    expect(pckg.title).toContain('Sepich Portfolio');
    expect(bcl.title).toContain('Sepich Portfolio');
    expect(pckg.title).toContain('Package (PCKG)');
    expect(bcl.title).toContain('Business Crime Liability (BCL)');
  });

  it('a policy with no coverage on file still yields a usable, non-empty title', () => {
    const out = evaluateConditions(
      snap({ insurance: [policy({ id: 'ins-x', property: 'Prop One', coverage: null, status: 'Cancelled' })] }),
      opts,
    );
    const ins = out.find((i) => i.id === 'ins-lapsed-ins-x')!;
    expect(ins.title).toContain('Prop One');
    expect(ins.title).not.toContain('null');
    // Discriminating assertion: the old title was exactly `Policy cancelled — Prop One`, which
    // also contained 'Prop One' and no 'null'. The coverage segment must actually be present.
    expect(ins.title).toContain('· Coverage');
  });

  it('the live-lapsed (F3) branch disambiguates the same way', () => {
    const out = evaluateConditions(
      snap({
        insurance: [
          policy({ id: 'ins-a-pckg', property: 'Prop One', coverage: 'Package (PCKG)', status: 'Current', expires: iso(-10) }),
          policy({ id: 'ins-a-bcl', property: 'Prop One', coverage: 'Business Crime Liability (BCL)', status: 'Current', expires: iso(-10) }),
        ],
      }),
      opts,
    );
    const titles = out.filter((i) => i.id.startsWith('ins-lapsed-live-')).map((i) => i.title);
    expect(titles).toHaveLength(2);
    expect(new Set(titles).size).toBe(2);
  });
});
