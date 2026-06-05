import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot, Property, Lease, Loan } from '@contracts/index';
import {
  portfolioKpis,
  walt,
  tenantHHI,
  topTenants,
  rolloverSchedule,
  criticalDates,
  debtSummary,
  marketAllocation,
  generateInsights,
  applyScenario,
  buildAnalytics,
} from '@analytics/index';

function prop(p: Partial<Property>): Property {
  return {
    id: 'p',
    index: 1,
    name: 'P',
    address: 'P',
    city: null,
    state: null,
    market: 'Columbus OH',
    type: 'Flex',
    sf: 0,
    tenantCount: 0,
    occPct: 1,
    acqDate: null,
    estValue100: 0,
    oxfordOwnPct: 1,
    oxfordValue: 0,
    grossIncome: 0,
    expenses: 0,
    noi: 0,
    noiScenarioAdj: 0,
    debtService: 0,
    netCashFlow: 0,
    capRate: null,
    dscr: null,
    lender: null,
    loanBalance: 0,
    ltv: null,
    valuePerSf: null,
    rentPerSf: null,
    equityInvested: 0,
    cashOnCash: null,
    holdYrs: null,
    encumbered: false,
    flags: [],
    ...p,
  };
}
function lease(l: Partial<Lease>): Lease {
  return {
    id: Math.random().toString(36).slice(2),
    propertyKey: 'P',
    propertyId: 'p',
    tenantName: 'T',
    unit: null,
    company: 'Co',
    sf: 0,
    monthlyRent: 0,
    rentPerSf: null,
    leaseStart: null,
    leaseEnd: null,
    escalationDate: null,
    escalationPct: null,
    status: 'Active',
    annualRent: 0,
    monthsToExpiry: null,
    flags: [],
    ...l,
  };
}
function loan(l: Partial<Loan>): Loan {
  return {
    id: Math.random().toString(36).slice(2),
    name: 'L',
    counterparty: null,
    direction: 'borrower',
    originalPrincipal: null,
    currentBalance: 0,
    absBalance: 0,
    rate: null,
    monthlyPmt: null,
    annualInterest: null,
    annualPrincipal: null,
    loanType: null,
    status: null,
    isDemand: false,
    maturity: null,
    monthsToMaturity: null,
    ltv: null,
    lender: null,
    balloon: false,
    flags: [],
    ...l,
  };
}
function snap(s: Partial<PortfolioSnapshot>): PortfolioSnapshot {
  return {
    meta: {
      schemaVersion: '1.0.0',
      asOf: '2026-01-01',
      generatedAt: '2026-01-01T00:00:00.000Z',
      source: 'test',
      scenario: 'Base',
    },
    assumptions: {
      activeScenario: 'Base',
      revenueFactor: 1,
      vacancyFactor: 1,
      exitCapFactor: 1,
      thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 },
      asOf: '2026-01-01',
    },
    properties: [],
    leases: [],
    loans: [],
    cash: {
      asOf: '2026-01-01',
      totalCash: 0,
      activeEntities: 0,
      largestEntity: null,
      concentrationTopPct: null,
      cagr: null,
      entities: [],
      history: [],
    },
    insurance: [],
    deals: [],
    tasks: [],
    counterparties: [],
    renewalStages: {},
    tenantNotes: {},
    dealComps: {},
    noiBudgets: {},
    quickbooks: null,
    dataQuality: [],
    ...s,
  };
}

describe('portfolioKpis', () => {
  const s = snap({
    properties: [
      prop({ id: 'a', sf: 100, occPct: 1, noi: 100, oxfordValue: 1000, loanBalance: 400, equityInvested: 200, tenantCount: 2 }),
      prop({ id: 'b', sf: 100, occPct: 0.5, noi: 50, oxfordValue: 1000, loanBalance: 0, equityInvested: 200, tenantCount: 1 }),
    ],
  });
  const k = portfolioKpis(s);
  it('sums SF, NOI, value and weights occupancy', () => {
    expect(k.totalSf.value).toBe(200);
    expect(k.noi.value).toBe(150);
    expect(k.value.value).toBe(2000);
    expect(k.occupancy.value).toBeCloseTo(0.75, 6);
    expect(k.tenantCount.value).toBe(3);
  });
  it('derives LTV and weighted cap rate with derived provenance', () => {
    expect(k.ltv.value).toBeCloseTo(0.2, 6);
    expect(k.weightedCapRate.value).toBeCloseTo(0.075, 6);
    expect(k.ltv.prov.confidence).toBe('derived');
    expect(k.noi.prov.confidence).toBe('confirmed');
  });
});

describe('walt', () => {
  it('computes ~2yr remaining term, rent-weighted, excluding expired', () => {
    const leases = [
      lease({ annualRent: 100, leaseEnd: '2028-01-01', status: 'Active' }),
      lease({ annualRent: 0, leaseEnd: '2020-01-01', status: 'Expired' }),
    ];
    expect(walt(leases, '2026-01-01')).toBeCloseTo(2.0, 1);
  });
});

describe('tenantHHI', () => {
  it('is 10000 for a monopoly and ~5000 for two equal tenants', () => {
    expect(tenantHHI([lease({ company: 'A', annualRent: 100 })])).toBeCloseTo(10000, 0);
    expect(
      tenantHHI([lease({ company: 'A', annualRent: 50 }), lease({ company: 'B', annualRent: 50 })]),
    ).toBeCloseTo(5000, 0);
  });
});

describe('topTenants', () => {
  it('aggregates leases by company and ranks by rent with share', () => {
    const t = topTenants([
      lease({ company: 'Big', annualRent: 300, sf: 30 }),
      lease({ company: 'Big', annualRent: 100, sf: 10 }),
      lease({ company: 'Small', annualRent: 100, sf: 10 }),
    ]);
    expect(t[0]!.company).toBe('Big');
    expect(t[0]!.annualRent).toBe(400);
    expect(t[0]!.leases).toBe(2);
    expect(t[0]!.share).toBeCloseTo(400 / 500, 6);
  });
});

describe('rolloverSchedule', () => {
  it('buckets current year by half then future years', () => {
    const r = rolloverSchedule(
      [
        lease({ leaseEnd: '2026-03-31', sf: 10, annualRent: 100 }),
        lease({ leaseEnd: '2026-09-30', sf: 20, annualRent: 200 }),
        lease({ leaseEnd: '2027-05-01', sf: 30, annualRent: 300 }),
      ],
      '2026-01-01',
    );
    const periods = r.map((b) => b.period);
    expect(periods).toContain('2026 H1');
    expect(periods).toContain('2026 H2');
    expect(periods).toContain('2027');
  });
  it('buckets leases beyond the horizon into a catch-all instead of dropping them', () => {
    const r = rolloverSchedule([lease({ leaseEnd: '2035-01-01', sf: 50, annualRent: 500 })], '2026-01-01');
    const tail = r.find((b) => b.period === '2030+');
    expect(tail?.expiringRent).toBe(500);
    // catch-all sorts last
    expect(r[r.length - 1]!.period).toBe('2030+');
  });
});

describe('criticalDates', () => {
  it('emits notice deadline, expiration and escalation rows, sorted by urgency', () => {
    const cds = criticalDates(
      [lease({ id: 'l1', company: 'Acme', leaseEnd: '2026-06-01', escalationDate: '2026-03-01', annualRent: 100 })],
      '2026-01-01',
    );
    const kinds = cds.map((c) => c.kind);
    expect(kinds).toContain('Expiration');
    expect(kinds).toContain('Notice Deadline');
    expect(kinds).toContain('Escalation');
    for (let i = 1; i < cds.length; i++) {
      expect(cds[i]!.daysToDate).toBeGreaterThanOrEqual(cds[i - 1]!.daysToDate);
    }
    expect(cds.find((c) => c.kind === 'Notice Deadline')?.noticeWindowDays).toBe(90);
  });
  it('keeps overdue expirations (holdover) as negative days but drops past escalations/notice', () => {
    const cds = criticalDates(
      [lease({ id: 'l2', leaseEnd: '2025-11-01', escalationDate: '2025-01-01', annualRent: 50 })],
      '2026-01-01',
    );
    expect(cds.some((c) => c.kind === 'Expiration' && c.daysToDate < 0)).toBe(true);
    expect(cds.some((c) => c.kind === 'Escalation')).toBe(false);
    expect(cds.some((c) => c.kind === 'Notice Deadline')).toBe(false);
  });
  it('excludes events beyond the horizon', () => {
    expect(criticalDates([lease({ leaseEnd: '2030-01-01', annualRent: 10 })], '2026-01-01', { horizonDays: 365 })).toHaveLength(0);
  });
});

describe('debtSummary', () => {
  it('totals external debt, weighted rate, and a maturity ladder', () => {
    const d = debtSummary([
      loan({ direction: 'borrower', absBalance: 400, rate: 0.05, monthlyPmt: 2, maturity: '2031-06-05' }),
      loan({ direction: 'lender', absBalance: 100, rate: 0.09, maturity: '2027-02-20', balloon: true }),
      loan({ direction: 'internal', absBalance: 50, isDemand: true }),
    ]);
    expect(d.externalDebt).toBe(400);
    expect(d.lenderDeployed).toBe(100);
    expect(d.internalOutstanding).toBe(50);
    expect(d.annualDebtService).toBe(24);
    expect(d.weightedAvgRate).toBeCloseTo(0.05, 6);
    expect(d.ladder.find((b) => b.period === '2027')?.hasBalloon).toBe(true);
  });
});

describe('marketAllocation', () => {
  it('allocates NOI by market and sums to 100%', () => {
    const m = marketAllocation(
      [prop({ market: 'Columbus OH', noi: 75 }), prop({ market: 'Mid-Atlantic', noi: 25 })],
      'noi',
    );
    expect(m[0]!.market).toBe('Columbus OH');
    expect(m.reduce((a, b) => a + b.pct, 0)).toBeCloseTo(1, 6);
  });
});

describe('buildAnalytics — Value by Market shows value, not NOI (Defect 3 regression)', () => {
  // Markets are ordered differently by value vs NOI, so a mix-up is detectable.
  const s = snap({
    properties: [
      prop({ id: 'a', market: 'Columbus OH', noi: 100, oxfordValue: 1000 }),
      prop({ id: 'b', market: 'Mid-Atlantic', noi: 50, oxfordValue: 3000 }),
    ],
  });
  const a = buildAnalytics(s);
  it('exposes marketByValue summing to Σ Oxford value', () => {
    expect(a.marketByValue.reduce((x, m) => x + m.value, 0)).toBe(4000);
  });
  it('marketByValue is a distinct series from marketByNoi (different leader)', () => {
    expect(a.marketByValue[0]!.market).toBe('Mid-Atlantic'); // highest value
    expect(a.marketByNoi[0]!.market).toBe('Columbus OH'); // highest NOI
  });
});

describe('applyScenario', () => {
  const base = snap({ properties: [prop({ id: 'a', noi: 100, occPct: 0.9, capRate: 0.07, oxfordValue: 1000 })] });
  it('Base is identity', () => {
    expect(applyScenario(base, 'Base')).toBe(base);
  });
  it('Upside lifts NOI 10%, tightens cap 5%, lowers vacancy', () => {
    const up = applyScenario(base, 'Upside');
    expect(up.properties[0]!.noi).toBeCloseTo(110, 6);
    expect(up.properties[0]!.capRate).toBeCloseTo(0.07 * 0.95, 6);
    expect(up.properties[0]!.occPct).toBeGreaterThan(0.9);
  });
  it('Downside cuts NOI 10% and flags KPIs derived', () => {
    const down = applyScenario(base, 'Downside');
    expect(down.properties[0]!.noi).toBeCloseTo(90, 6);
    expect(portfolioKpis(base, 'Downside').noi.prov.confidence).toBe('derived');
    expect(portfolioKpis(base, 'Base').noi.prov.confidence).toBe('confirmed');
  });
});

describe('generateInsights', () => {
  it('flags balloons in-window, expired leases, and cancelled insurance', () => {
    const s = snap({
      loans: [loan({ name: 'Restoration', balloon: true, monthsToMaturity: 8, absBalance: 980000, maturity: '2027-02-20' })],
      leases: [lease({ company: 'HoldoverCo', status: 'Expired', annualRent: 10000 })],
      insurance: [
        {
          id: 'x',
          property: 'Solar',
          entity: null,
          coverage: 'Package',
          effective: null,
          expires: null,
          policyNo: null,
          carrier: null,
          premium: 8776,
          daysToExpiry: -22,
          status: 'Cancelled',
          notes: null,
          flags: [],
        },
      ],
    });
    const ins = generateInsights(s);
    expect(ins.some((i) => i.category === 'debt' && i.severity === 'critical')).toBe(true);
    // Defect 6: balloon figure is full precision ($980,000), never compact ($980K), so it
    // matches the loan drawer's Current Balance and never reads as two different numbers.
    const balloon = ins.find((i) => i.category === 'debt');
    expect(balloon?.metric).toBe('$980,000');
    expect(ins.some((i) => i.category === 'lease' && /expired/i.test(i.title))).toBe(true);
    expect(ins.some((i) => i.category === 'insurance' && i.severity === 'critical')).toBe(true);
    // critical sorts before info
    expect(ins[0]!.severity).toBe('critical');
  });
});
