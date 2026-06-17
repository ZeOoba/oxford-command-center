import { describe, it, expect } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { applyOverlay, loadOverlay, nextStage, EMPTY_OVERLAY } from '../../server/overlay';

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

describe('loadOverlay — tenantArrears per-bucket salvage (refute F3 / edges)', () => {
  // overlay.json is the user-/export-editable QB-AR path that bypasses Zod on the live path. The
  // load must SALVAGE per bucket — never drop a record (and a co-occurring real 60+ balance) for one
  // bad/negative/string bucket — coercing each to a non-negative number.
  function loadArrears(tenantArrears: unknown) {
    const dir = mkdtempSync(join(tmpdir(), 'ora-overlay-'));
    const path = join(dir, 'overlay.json');
    writeFileSync(path, JSON.stringify({ tenantArrears }), 'utf8');
    const prev = process.env.OVERLAY_PATH;
    process.env.OVERLAY_PATH = path;
    try {
      return loadOverlay().tenantArrears;
    } finally {
      if (prev === undefined) delete process.env.OVERLAY_PATH;
      else process.env.OVERLAY_PATH = prev;
    }
  }

  it('defaults missing buckets to 0 (partial record survives)', () => {
    expect(loadArrears({ l1: { d90: 3000 } }).l1).toEqual({ d30: 0, d60: 0, d90: 3000, d90plus: 0 });
  });
  it('salvages a negative current-bucket credit alongside a real 60+ balance (does NOT drop the record)', () => {
    // A QB AR aging export shows a negative current bucket for an unapplied credit/prepayment; the
    // co-occurring $5,000 61–90-day delinquency must survive (the pre-fix safeParse dropped it).
    expect(loadArrears({ l1: { d30: -100, d60: 0, d90: 5000, d90plus: 0 } }).l1)
      .toEqual({ d30: 0, d60: 0, d90: 5000, d90plus: 0 });
  });
  it('coerces a numeric-string bucket from a CSV/QB export', () => {
    expect(loadArrears({ l1: { d90: '4000' } }).l1).toEqual({ d30: 0, d60: 0, d90: 4000, d90plus: 0 });
  });
  it('salvages currency/comma/accounting-formatted strings (the real QB/Excel export format)', () => {
    // The default format real AR-aging exports produce — must NOT silently zero a real balance.
    expect(loadArrears({ l1: { d90plus: '12,500' } }).l1).toEqual({ d30: 0, d60: 0, d90: 0, d90plus: 12500 });
    expect(loadArrears({ l2: { d90: '$4,000' } }).l2).toEqual({ d30: 0, d60: 0, d90: 4000, d90plus: 0 });
    expect(loadArrears({ l3: { d30: '1,200.00' } }).l3).toEqual({ d30: 1200, d60: 0, d90: 0, d90plus: 0 });
    // Accounting-parens credit → 0, while the co-occurring real 60+ balance survives.
    expect(loadArrears({ l4: { d30: '(500)', d90: 8000 } }).l4).toEqual({ d30: 0, d60: 0, d90: 8000, d90plus: 0 });
  });
  it('zeroes a non-numeric bucket but keeps the real balance in the same record', () => {
    expect(loadArrears({ l1: { d30: 'n/a', d90plus: 8000 } }).l1).toEqual({ d30: 0, d60: 0, d90: 0, d90plus: 8000 });
  });
  it('skips a non-object record value but keeps the valid siblings', () => {
    const out = loadArrears({ l1: 5, l2: { d90: 1000 } });
    expect(out.l1).toBeUndefined();
    expect(out.l2).toEqual({ d30: 0, d60: 0, d90: 1000, d90plus: 0 });
  });
});
