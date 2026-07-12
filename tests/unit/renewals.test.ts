import { describe, it, expect } from 'vitest';
import { RenewalStage, RENEWAL_STAGES, nextRenewalStage, RenewalStageInput } from '../../src/contracts/renewal';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { RENEWAL_WINDOW_DAYS, renewalBoard } from '../../src/brain/renewals';

describe('RenewalStage contract', () => {
  it('enumerates the five stages in pipeline order', () => {
    expect(RENEWAL_STAGES).toEqual(['Expiring', 'Outreach', 'Negotiating', 'LOI', 'Executed']);
  });

  it('parses a valid stage and rejects an unknown one', () => {
    expect(RenewalStage.parse('Outreach')).toBe('Outreach');
    expect(RenewalStage.safeParse('Nope').success).toBe(false);
  });

  it('advances along the flow and stops at Executed', () => {
    expect(nextRenewalStage('Expiring')).toBe('Outreach');
    expect(nextRenewalStage('LOI')).toBe('Executed');
    expect(nextRenewalStage('Executed')).toBeNull();
  });

  it('validates the action input', () => {
    expect(RenewalStageInput.safeParse({ leaseId: 'L1', stage: 'LOI' }).success).toBe(true);
    expect(RenewalStageInput.safeParse({ leaseId: '', stage: 'LOI' }).success).toBe(false);
    expect(RenewalStageInput.safeParse({ leaseId: 'L1', stage: 'X' }).success).toBe(false);
  });
});

const ASOF = '2026-06-04';
// renewalBoard anchors on `now`, not meta.asOf (see time-constants.ts todayEastern) — pin
// `now` to noon ET on the same date the fixture's day-count comments assume.
const NOW = new Date('2026-06-04T12:00:00-04:00').getTime();
const snap = {
  meta: { asOf: ASOF },
  renewalStages: { L4: 'Negotiating' as const },
  leases: [
    // in-window (60d) — defaults to Expiring
    { id: 'L1', company: 'Acme', tenantName: 'Acme', propertyKey: '100 A', unit: '1', annualRent: 100000, leaseEnd: '2026-08-03', status: 'Active' },
    // overdue holdover (-20d) — needs action now, included
    { id: 'L2', company: null, tenantName: 'Beta', propertyKey: '200 B', unit: null, annualRent: 50000, leaseEnd: '2026-05-15', status: 'Expired' },
    // far out (300d), no stage — excluded
    { id: 'L3', company: 'Gamma', tenantName: 'Gamma', propertyKey: '300 C', unit: '2', annualRent: 75000, leaseEnd: '2027-04-01', status: 'Active' },
    // far out (300d) BUT carries an explicit stage — included via stage
    { id: 'L4', company: 'Delta', tenantName: 'Delta', propertyKey: '400 D', unit: null, annualRent: 90000, leaseEnd: '2027-04-01', status: 'Active' },
    // vacant unit in-window — excluded (nothing to renew)
    { id: 'L5', company: null, tenantName: 'VACANT', propertyKey: '500 E', unit: '3', annualRent: 0, leaseEnd: '2026-07-01', status: 'Vacant' },
  ],
} as unknown as PortfolioSnapshot;

describe('renewalBoard', () => {
  it('exposes the 75-day window constant', () => {
    expect(RENEWAL_WINDOW_DAYS).toBe(75);
  });

  it('selects in-window leases (incl. overdue holdovers) and any lease carrying a stage', () => {
    const board = renewalBoard(snap, NOW);
    const all = Object.values(board).flat().map((c) => c.leaseId);
    expect(all).toContain('L1');
    expect(all).toContain('L2');
    expect(all).not.toContain('L3'); // far out, no stage
    expect(all).toContain('L4'); // far out but staged
    expect(all).not.toContain('L5'); // vacant
  });

  it('defaults unstaged in-window leases to the Expiring column and honors explicit stages', () => {
    const board = renewalBoard(snap, NOW);
    expect(board.Expiring.map((c) => c.leaseId).sort()).toEqual(['L1', 'L2']);
    expect(board.Negotiating.map((c) => c.leaseId)).toEqual(['L4']);
    expect(board.Outreach).toEqual([]);
  });

  it('orders each column by urgency (soonest/overdue first) and carries daysToExpiry', () => {
    const board = renewalBoard(snap, NOW);
    // L2 overdue (-20) sorts before L1 (60)
    expect(board.Expiring.map((c) => c.leaseId)).toEqual(['L2', 'L1']);
    expect(board.Expiring[0]!.daysToExpiry).toBeLessThan(0);
  });
});
