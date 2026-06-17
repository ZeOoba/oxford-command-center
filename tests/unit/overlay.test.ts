import { describe, it, expect } from 'vitest';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { applyOverlay, nextStage, EMPTY_OVERLAY } from '../../server/overlay';

const base = {
  deals: [{ id: 'd1', name: 'FVC', stage: 'Candidate' }],
  tasks: [{ id: 't-wb', label: 'Workbook task', section: 'Ops' }],
} as unknown as PortfolioSnapshot;

describe('nextStage — pipeline advance path', () => {
  it('advances along the flow and stops at Closed', () => {
    expect(nextStage('Sourcing')).toBe('Candidate');
    expect(nextStage('Candidate')).toBe('LOI/PSA');
    expect(nextStage('Closing')).toBe('Closed');
    expect(nextStage('Closed')).toBeNull();
    expect(nextStage('Dead')).toBeNull(); // off-path stages don't advance
  });
});

describe('applyOverlay — write-back merge (workbook stays canonical)', () => {
  it('overrides a deal stage from the overlay', () => {
    const out = applyOverlay(base, { ...EMPTY_OVERLAY, dealStages: { d1: 'LOI/PSA' } });
    expect(out.deals[0]!.stage).toBe('LOI/PSA');
  });

  it('prepends overlay tasks ahead of workbook tasks', () => {
    const out = applyOverlay(base, { ...EMPTY_OVERLAY, tasks: [{ id: 'u1', label: 'User task', section: 'Added', role: null, type: null, dueDay: null, notes: null, status: 'pending', monthlyPmt: null }] });
    expect(out.tasks.map((t) => t.id)).toEqual(['u1', 't-wb']);
  });

  it('never mutates the base snapshot (workbook is read-only)', () => {
    applyOverlay(base, { ...EMPTY_OVERLAY, dealStages: { d1: 'Closed' } });
    expect(base.deals[0]!.stage).toBe('Candidate'); // unchanged
  });
});

describe('applyOverlay — renewalStages (Phase 2)', () => {
  const baseL = {
    deals: [],
    tasks: [],
    leases: [{ id: 'L1' }, { id: 'L2' }],
  } as unknown as PortfolioSnapshot;

  it('surfaces renewalStages onto the snapshot', () => {
    const out = applyOverlay(baseL, { ...EMPTY_OVERLAY, renewalStages: { L1: 'Outreach' } });
    expect(out.renewalStages).toEqual({ L1: 'Outreach' });
  });

  it('defaults to an empty record when the overlay has none', () => {
    const out = applyOverlay(baseL, EMPTY_OVERLAY);
    expect(out.renewalStages).toEqual({});
  });

  it('EMPTY_OVERLAY carries the new keys', () => {
    expect(EMPTY_OVERLAY.renewalStages).toEqual({});
  });
});

describe('applyOverlay — tenantNotes (Phase 2)', () => {
  const baseT = { deals: [], tasks: [], leases: [] } as unknown as PortfolioSnapshot;

  it('surfaces tenantNotes onto the snapshot', () => {
    const out = applyOverlay(baseT, { ...EMPTY_OVERLAY, tenantNotes: { 'acme-llc': 'Eric to follow up' } });
    expect(out.tenantNotes).toEqual({ 'acme-llc': 'Eric to follow up' });
  });

  it('defaults to an empty record and EMPTY_OVERLAY carries the key', () => {
    expect(applyOverlay(baseT, EMPTY_OVERLAY).tenantNotes).toEqual({});
    expect(EMPTY_OVERLAY.tenantNotes).toEqual({});
  });
});

describe('applyOverlay — dealComps (Phase 3)', () => {
  const baseD = { deals: [{ id: 'd1' }], tasks: [], leases: [] } as unknown as PortfolioSnapshot;
  const cs = { saleComps: [], rentComps: [], submarketStats: [], summary: null, sources: [], sourcedAt: '2026-06-05T00:00:00.000Z' };

  it('surfaces dealComps onto the snapshot', () => {
    const out = applyOverlay(baseD, { ...EMPTY_OVERLAY, dealComps: { d1: cs } });
    expect(out.dealComps.d1).toEqual(cs);
  });

  it('defaults to an empty record and EMPTY_OVERLAY carries the key', () => {
    expect(applyOverlay(baseD, EMPTY_OVERLAY).dealComps).toEqual({});
    expect(EMPTY_OVERLAY.dealComps).toEqual({});
  });
});

describe('applyOverlay — noiBudgets (Phase 3 ②)', () => {
  const baseP = { deals: [], tasks: [], leases: [], properties: [{ id: 'p1' }] } as unknown as PortfolioSnapshot;
  it('surfaces noiBudgets onto the snapshot', () => {
    const out = applyOverlay(baseP, { ...EMPTY_OVERLAY, noiBudgets: { p1: 250000 } });
    expect(out.noiBudgets).toEqual({ p1: 250000 });
  });
  it('defaults empty and EMPTY_OVERLAY carries the key', () => {
    expect(applyOverlay(baseP, EMPTY_OVERLAY).noiBudgets).toEqual({});
    expect(EMPTY_OVERLAY.noiBudgets).toEqual({});
  });
});

describe('applyOverlay — tenantArrears (audit Fix #2)', () => {
  const baseL = { deals: [], tasks: [], leases: [{ id: 'l1' }] } as unknown as PortfolioSnapshot;
  const ar = { d30: 1000, d60: 0, d90: 0, d90plus: 2000 };
  it('surfaces tenantArrears onto the snapshot', () => {
    const out = applyOverlay(baseL, { ...EMPTY_OVERLAY, tenantArrears: { l1: ar } });
    expect(out.tenantArrears).toEqual({ l1: ar });
  });
  it('defaults empty and EMPTY_OVERLAY carries the key', () => {
    expect(applyOverlay(baseL, EMPTY_OVERLAY).tenantArrears).toEqual({});
    expect(EMPTY_OVERLAY.tenantArrears).toEqual({});
  });
});
