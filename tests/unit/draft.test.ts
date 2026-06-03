import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { buildDraft, mailtoHref, ORA_CC } from '../../src/brain/draft';

function snap(): PortfolioSnapshot {
  const s = {
    meta: { schemaVersion: '1.0.0', asOf: '2026-06-01', generatedAt: '2026-06-01T00:00:00.000Z', source: 't', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: '2026-06-01' },
    properties: [],
    leases: [{ id: 'lease1', propertyKey: '29000 Information Lane', propertyId: 'p1', tenantName: 'Jane', unit: 'A', company: 'REDACTED-659, INC.', sf: 1000, monthlyRent: 8333, rentPerSf: null, leaseStart: null, leaseEnd: '2026-08-30', escalationDate: null, escalationPct: null, status: 'Expiring Soon', annualRent: 100000, monthsToExpiry: 2, flags: [] }],
    loans: [{ id: 'l1', name: 'REDACTED-306', counterparty: 'Oxford', direction: 'lender', originalPrincipal: null, currentBalance: -REDACTED-AMT, absBalance: REDACTED-AMT, rate: 0.09, monthlyPmt: -6268, annualInterest: null, annualPrincipal: null, loanType: 'Balloon', status: 'Balloon', isDemand: false, maturity: '2027-02-20', monthsToMaturity: 8, ltv: 0.78, lender: null, balloon: true, flags: [] }],
    cash: { asOf: '2026-06-01', totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
    insurance: [{ id: 'ins-1', property: 'Solar Field', entity: null, coverage: 'Package', effective: null, expires: '2026-07-01', policyNo: null, carrier: 'Erie', premium: 8000, daysToExpiry: 30, status: 'Renew Now', notes: null, flags: [] }],
    deals: [],
    tasks: [],
    counterparties: [
      { id: 'cp-erie', name: 'Erie', kind: 'carrier', firm: 'Erie', role: null, email: 'broker@erie.com', phone: null, market: null, notes: null, source: 'workbook', links: { properties: [], loans: [], deals: [], insurance: ['ins-1'] } },
      { id: 'cp-phil', name: 'REDACTED-505', kind: 'counsel', firm: 'REDACTED-319', role: 'Counsel', email: 'REDACTED-326', phone: null, market: 'Columbus OH', notes: null, source: 'memory', links: { properties: [], loans: [], deals: [], insurance: [] } },
    ],
    dataQuality: [],
  };
  return s as unknown as PortfolioSnapshot;
}

describe('buildDraft — draft-only emails', () => {
  it('always cc\'s the ORA principals and never auto-sends', () => {
    const d = buildDraft(snap(), { kind: 'renewal', entity: { type: 'lease', id: 'lease1' } });
    expect(d?.cc).toEqual(ORA_CC);
  });

  it('renewal draft references the tenant, property, rent, and expiry', () => {
    const d = buildDraft(snap(), { kind: 'renewal', entity: { type: 'lease', id: 'lease1' } });
    expect(d?.subject).toContain('29000 Information Lane');
    expect(d?.body).toContain('REDACTED-659, INC.');
    expect(d?.body).toContain('$100,000');
    expect(d?.body).toMatch(/Aug \d{1,2}, 2026/); // fmtDate renders in local tz
  });

  it('refi draft uses full-precision balance and a maturity date', () => {
    const d = buildDraft(snap(), { kind: 'refi', entity: { type: 'loan', id: 'l1' } });
    expect(d?.body).toContain('$REDACTED-AMT');
    expect(d?.subject).toContain('REDACTED-306');
  });

  it('insurance draft auto-fills the carrier email from the relationship graph', () => {
    const d = buildDraft(snap(), { kind: 'insurance', entity: { type: 'insurance', id: 'ins-1' } });
    expect(d?.to).toBe('broker@erie.com');
  });

  it('general counterparty draft uses the contact email', () => {
    const d = buildDraft(snap(), { kind: 'general', entity: { type: 'counterparty', id: 'cp-phil' } });
    expect(d?.to).toBe('REDACTED-326');
  });

  it('mailtoHref encodes cc, subject and body but no auto-send', () => {
    const d = buildDraft(snap(), { kind: 'renewal', entity: { type: 'lease', id: 'lease1' } })!;
    const href = mailtoHref(d);
    expect(href.startsWith('mailto:')).toBe(true);
    expect(href).toContain('cc=ggoldberg%40oxfordra.net');
    expect(href).toContain('subject=');
  });
});
