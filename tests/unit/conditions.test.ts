import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot, Property, Lease, Loan, InsurancePolicy, Deal } from '@contracts/index';
import { evaluateConditions, ALERT_THRESHOLDS } from '@analytics/index';
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
  status: null, isDemand: false, maturity: null, monthsToMaturity: null, ltv: null, lender: null, balloon: false, flags: [], ...o,
});
const policy = (o: Partial<InsurancePolicy>): InsurancePolicy => ({
  id: 'i1', property: 'Prop One', entity: null, coverage: 'Package', effective: null, expires: null, policyNo: null,
  carrier: 'Carrier', premium: 5000, daysToExpiry: null, status: 'Current', notes: null, flags: [], ...o,
});
const deal = (o: Partial<Deal>): Deal => ({
  id: 'd1', name: 'Deal One', shortName: null, location: null, market: null, sf: null, buildings: null, stage: 'Sourcing',
  estPrice: null, capRate: null, irr: null, equityMultiple: null, holdYrs: null, lender: null, status: null,
  nextAction: null, owner: null, targetCloseDate: null, confidential: false, estimatedFields: [], ...o,
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
});

describe('evaluateConditions — leases', () => {
  it('expiring < 60d is critical', () => {
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(59) })] }), opts);
    expect(out.find((i) => i.id === 'expiring-l1')?.severity).toBe('critical');
  });
  it('expiring 60–180d is warning', () => {
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(120) })] }), opts);
    expect(out.find((i) => i.id === 'expiring-l1')?.severity).toBe('warning');
  });
  it('expiring beyond 180d does not fire', () => {
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(181) })] }), opts);
    expect(out.some((i) => i.id === 'expiring-l1')).toBe(false);
  });
  it('lease at exactly 60d is warning (not critical)', () => {
    const out = evaluateConditions(snap({ leases: [lease({ leaseEnd: iso(60) })] }), opts);
    expect(out.find((i) => i.id === 'expiring-l1')?.severity).toBe('warning');
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
    expect(out.some((i) => i.id === 'expiring-l1')).toBe(true);
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
  it('pins the ratified DSCR/LTV governor-derived thresholds', () => {
    expect(ALERT_THRESHOLDS.dscrFloor).toBe(1.1);
    expect(ALERT_THRESHOLDS.dscrWatch).toBe(1.25);
    expect(ALERT_THRESHOLDS.ltvGovernor).toBe(0.4);
    expect(ALERT_THRESHOLDS.ltvCeiling).toBe(0.65);
  });
  it('the alert thresholds track the ratified capital governor — cannot silently drift (B3)', () => {
    // The "above governor" info tier MUST equal the ratified LTV governor; the DSCR watch MUST
    // equal the ratified DSCR floor (CLAUDE.md §4, capital-config.ts).
    expect(ALERT_THRESHOLDS.ltvGovernor).toBe(CAPITAL_CONFIG.ltvCeiling);
    expect(ALERT_THRESHOLDS.dscrWatch).toBe(CAPITAL_CONFIG.dscrFloor);
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
