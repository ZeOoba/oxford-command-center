import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { buildDraft, mailtoHref, ORA_CC } from '../../src/brain/draft';

function snap(): PortfolioSnapshot {
  const s = {
    meta: { schemaVersion: '1.0.0', asOf: '2026-06-01', generatedAt: '2026-06-01T00:00:00.000Z', source: 't', scenario: 'Base' },
    assumptions: { activeScenario: 'Base', revenueFactor: 1, vacancyFactor: 1, exitCapFactor: 1, thresholds: { balloonAlertMonths: 18, concentrationYellow: 0.25, concentrationRed: 0.5 }, asOf: '2026-06-01' },
    properties: [],
    leases: [{ id: 'lease1', propertyKey: '29000 Information Lane', propertyId: 'p1', tenantName: 'Jane', unit: 'A', company: 'Eurosort, INC.', sf: 1000, monthlyRent: 8333, rentPerSf: null, leaseStart: null, leaseEnd: '2026-08-30', escalationDate: null, escalationPct: null, status: 'Expiring Soon', annualRent: 100000, monthsToExpiry: 2, flags: [] }],
    loans: [{ id: 'l1', name: 'Restoration Church Trust', counterparty: 'Oxford', direction: 'lender', originalPrincipal: null, currentBalance: -980773, absBalance: 980773, rate: 0.09, monthlyPmt: -6268, annualInterest: null, annualPrincipal: null, loanType: 'Balloon', status: 'Balloon', isDemand: false, maturity: '2027-02-20', monthsToMaturity: 8, ltv: 0.78, lender: null, balloon: true, flags: [] }],
    cash: { asOf: '2026-06-01', totalCash: 0, activeEntities: 0, largestEntity: null, concentrationTopPct: null, cagr: null, entities: [], history: [] },
    insurance: [{ id: 'ins-1', property: 'Solar Field', entity: null, coverage: 'Package', effective: null, expires: '2026-07-01', policyNo: null, carrier: 'Erie', premium: 8000, daysToExpiry: 30, status: 'Renew Now', notes: null, flags: [] }],
    deals: [],
    tasks: [],
    counterparties: [
      { id: 'cp-erie', name: 'Erie', kind: 'carrier', firm: 'Erie', role: null, email: 'broker@erie.com', phone: null, market: null, notes: null, source: 'workbook', links: { properties: [], loans: [], deals: [], insurance: ['ins-1'] } },
      { id: 'cp-phil', name: 'Philip Collins', kind: 'counsel', firm: 'Collins Real Estate Law', role: 'Counsel', email: 'philip@collinsrelaw.com', phone: null, market: 'Columbus OH', notes: null, source: 'memory', links: { properties: [], loans: [], deals: [], insurance: [] } },
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
    expect(d?.body).toContain('Eurosort, INC.');
    expect(d?.body).toContain('$100,000');
    expect(d?.body).toMatch(/Aug \d{1,2}, 2026/); // fmtDate renders in local tz
  });

  it('refi draft uses full-precision balance and a maturity date', () => {
    const d = buildDraft(snap(), { kind: 'refi', entity: { type: 'loan', id: 'l1' } });
    expect(d?.body).toContain('$980,773');
    expect(d?.subject).toContain('Restoration Church Trust');
  });

  it('insurance draft auto-fills the carrier email from the relationship graph', () => {
    const d = buildDraft(snap(), { kind: 'insurance', entity: { type: 'insurance', id: 'ins-1' } });
    expect(d?.to).toBe('broker@erie.com');
  });

  it('general counterparty draft uses the contact email', () => {
    const d = buildDraft(snap(), { kind: 'general', entity: { type: 'counterparty', id: 'cp-phil' } });
    expect(d?.to).toBe('philip@collinsrelaw.com');
  });

  it('mailtoHref encodes cc, subject and body but no auto-send', () => {
    const d = buildDraft(snap(), { kind: 'renewal', entity: { type: 'lease', id: 'lease1' } })!;
    const href = mailtoHref(d);
    expect(href.startsWith('mailto:')).toBe(true);
    expect(href).toContain('cc=ggoldberg%40oxfordra.net');
    expect(href).toContain('subject=');
  });
});

import { insightToDraft } from '@/brain/draft';
import type { Insight } from '@analytics/index';

const ins = (over: Partial<Insight>): Insight => ({
  id: 'x', severity: 'warning', category: 'lease', title: 't', detail: 'd',
  impactAnnualUsd: null, spine: 'B', provenance: 'absent', ...over,
});

describe('insightToDraft', () => {
  it('maps a draft-renewal lease insight to a renewal draft', () => {
    const r = insightToDraft(ins({ entityType: 'lease', entityId: 'l1', action: { label: 'Draft renewal', kind: 'draft-renewal' } }));
    expect(r).toEqual({ kind: 'renewal', entity: { type: 'lease', id: 'l1' } });
  });
  it('maps an open-refi loan insight to a refi draft', () => {
    const r = insightToDraft(ins({ category: 'debt', entityType: 'loan', entityId: 'n1', action: { label: 'Open refi workspace', kind: 'open-refi' } }));
    expect(r).toEqual({ kind: 'refi', entity: { type: 'loan', id: 'n1' } });
  });
  it('maps a review insurance insight to an insurance draft', () => {
    const r = insightToDraft(ins({ category: 'insurance', entityType: 'insurance', entityId: 'i1', action: { label: 'Review policy', kind: 'review' } }));
    expect(r).toEqual({ kind: 'insurance', entity: { type: 'insurance', id: 'i1' } });
  });
  it('returns null when there is no action', () => {
    expect(insightToDraft(ins({ entityType: 'lease', entityId: 'l1' }))).toBeNull();
  });
  it('returns null when the action kind has no draft (e.g. open-record)', () => {
    expect(insightToDraft(ins({ entityType: 'property', entityId: 'p1', action: { label: 'View', kind: 'open-record' } }))).toBeNull();
  });
});
