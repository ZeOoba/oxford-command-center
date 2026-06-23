import { describe, it, expect, vi } from 'vitest';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { AcquisitionInput } from '../../src/contracts/acquisition';
import { applyOverlay, loadOverlay, saveOverlay, nextStage, EMPTY_OVERLAY } from '../../server/overlay';

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

describe('loadOverlay — structured-map validation (closes the whole-overlay bypass)', () => {
  function loadFull(overlay: Record<string, unknown>) {
    const dir = mkdtempSync(join(tmpdir(), 'ora-overlay-'));
    const path = join(dir, 'overlay.json');
    writeFileSync(path, JSON.stringify(overlay), 'utf8');
    const prev = process.env.OVERLAY_PATH;
    process.env.OVERLAY_PATH = path;
    try {
      return loadOverlay();
    } finally {
      if (prev === undefined) delete process.env.OVERLAY_PATH;
      else process.env.OVERLAY_PATH = prev;
    }
  }
  const validTask = { id: 'u1', label: 'User task', section: 'Added', role: null, type: null, dueDay: null, notes: null, status: 'pending', monthlyPmt: null };
  const validComps = { saleComps: [], rentComps: [], submarketStats: [], summary: null, sources: [], sourcedAt: '2026-06-05T00:00:00.000Z' };

  it('coerces noiBudgets through the shared money coercer (negative/string/junk → safe number)', () => {
    expect(loadFull({ noiBudgets: { p1: -5, p2: '12,500', p3: 250000, p4: 'oops' } }).noiBudgets)
      .toEqual({ p1: 0, p2: 12500, p3: 250000, p4: 0 });
  });
  it('keeps a valid task and drops+warns an invalid one (no silent drop)', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const o = loadFull({ tasks: [validTask, { not: 'a task' }] });
    expect(o.tasks.map((t) => t.id)).toEqual(['u1']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it('keeps a valid dealComps entry and drops+warns an invalid one', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const o = loadFull({ dealComps: { d1: validComps, bad: { not: 'comps' } } });
    expect(Object.keys(o.dealComps)).toEqual(['d1']);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it('string-filters a free-text map (a non-string dealStages value is dropped)', () => {
    expect(loadFull({ dealStages: { d1: 'LOI/PSA', d2: 42 } }).dealStages).toEqual({ d1: 'LOI/PSA' });
  });
});

// ── acquisitionInputs persistence round-trip ──────────────────────────────────────────────────
//
// Validates the POST /api/actions/acquisition-input → saveOverlay → loadOverlay → applyOverlay
// path that persists Acquisition Workbench inputs across page reloads (item-4 verification).
//
// Finding: the server route, brain write-back, overlay schema, loadOverlay parser, applyOverlay
// merge, and AcquisitionsModule savedInput prop are all correctly wired. These tests document
// and lock in that correctness.

describe('applyOverlay — acquisitionInputs (item-4: Workbench persistence)', () => {
  const baseAcq = { deals: [{ id: 'd1' }], tasks: [], leases: [] } as unknown as PortfolioSnapshot;
  const input = AcquisitionInput.parse({ dealId: 'd1', clusterTier: 'entry', stabilizedYoc: 0.09 });

  it('surfaces acquisitionInputs onto the snapshot', () => {
    const out = applyOverlay(baseAcq, { ...EMPTY_OVERLAY, acquisitionInputs: { d1: input } });
    expect(out.acquisitionInputs.d1).toMatchObject({ dealId: 'd1', clusterTier: 'entry' });
    expect(out.acquisitionInputs.d1!.stabilizedYoc).toBeCloseTo(0.09, 9);
  });

  it('defaults to an empty record and EMPTY_OVERLAY carries the key', () => {
    const out = applyOverlay(baseAcq, EMPTY_OVERLAY);
    expect(out.acquisitionInputs).toEqual({});
    expect(EMPTY_OVERLAY.acquisitionInputs).toEqual({});
  });
});

describe('saveOverlay + loadOverlay — acquisitionInputs round-trip (item-4)', () => {
  // Write a valid AcquisitionInput into an isolated overlay file, read it back, and confirm the
  // Zod-validated field survives intact — the same path POST /api/actions/acquisition-input takes.
  // Must await fn before restoring OVERLAY_PATH: a non-awaited async fn would let the finally
  // reset the env var mid-flight, so saveOverlay's awaited writeFile would target the real
  // data/overlay.json instead of the temp path (passes locally where data/ exists, fails in CI).
  async function withTmpOverlay<T>(fn: (path: string) => T | Promise<T>): Promise<T> {
    const dir = mkdtempSync(join(tmpdir(), 'ora-acq-overlay-'));
    const path = join(dir, 'overlay.json');
    const prev = process.env.OVERLAY_PATH;
    process.env.OVERLAY_PATH = path;
    try {
      return await fn(path);
    } finally {
      if (prev === undefined) delete process.env.OVERLAY_PATH;
      else process.env.OVERLAY_PATH = prev;
    }
  }

  it('persists a valid AcquisitionInput and reloads it with all fields intact', async () => {
    const input = AcquisitionInput.parse({
      dealId: 'd-persist', clusterTier: 'owned-submarket', stabilizedYoc: 0.11,
      price: 4_200_000, totalSf: 35_000,
      ddKnown: { flood: true, zoning: true },
    });

    await withTmpOverlay(async (path) => {
      // seed an empty overlay so saveOverlay has a file to merge into
      writeFileSync(path, JSON.stringify({}));
      const saved = await saveOverlay({ ...EMPTY_OVERLAY, acquisitionInputs: { 'd-persist': input } });
      expect(saved).toBe(true);

      const reloaded = loadOverlay();
      const entry = reloaded.acquisitionInputs['d-persist'];
      expect(entry).toBeDefined();
      expect(entry!.dealId).toBe('d-persist');
      expect(entry!.clusterTier).toBe('owned-submarket');
      expect(entry!.stabilizedYoc).toBeCloseTo(0.11, 9);
      expect(entry!.price).toBe(4_200_000);
      expect(entry!.ddKnown.flood).toBe(true);
      expect(entry!.ddKnown.zoning).toBe(true);
    });
  });

  it('drops an invalid acquisitionInputs entry and warns (loadOverlay validRecord guard)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await withTmpOverlay((path) => {
      writeFileSync(path, JSON.stringify({
        acquisitionInputs: {
          'd-valid': AcquisitionInput.parse({ dealId: 'd-valid', clusterTier: 'entry' }),
          'd-bad': { not: 'a valid input' },
        },
      }));
      const o = loadOverlay();
      expect(Object.keys(o.acquisitionInputs)).toEqual(['d-valid']);
      expect(o.acquisitionInputs['d-valid']!.dealId).toBe('d-valid');
      expect(warn).toHaveBeenCalled();
    });
    warn.mockRestore();
  });
});
