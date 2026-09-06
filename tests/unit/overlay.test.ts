import { describe, it, expect, vi, afterAll } from 'vitest';
import { writeFileSync, mkdtempSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PortfolioSnapshot } from '../../src/contracts/index';
import { AcquisitionInput } from '../../src/contracts/acquisition';
import { applyOverlay, loadOverlay, saveOverlay, nextStage, EMPTY_OVERLAY, evaluateOverlayPrecondition } from '../../server/overlay';

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

  // refute 2026-07-22 (arBalances/headless-feed PR): this loader used to silently DROP asOfDate and
  // sourceFile on every load, which erased the AR feed's provenance on the very next overlay save and
  // defeated conditions.ts's staleness gate (`'asOfDate' in r` — presence, not just non-null value,
  // marks a Track-B-stamped record vs a legacy/manual one that never had the key at all).
  it('round-trips a valid asOfDate + sourceFile', () => {
    const out = loadArrears({ l1: { d90plus: 5000, asOfDate: '2026-07-15T00:00:00.000Z', sourceFile: 'AR_2026-07-15.pdf' } });
    expect(out.l1!.asOfDate).toEqual(new Date('2026-07-15T00:00:00.000Z'));
    expect(out.l1!.sourceFile).toBe('AR_2026-07-15.pdf');
  });
  it('does NOT add an asOfDate/sourceFile key when the raw record never had one (legacy/manual record)', () => {
    const out = loadArrears({ l1: { d90plus: 5000 } });
    expect('asOfDate' in out.l1!).toBe(false);
    expect('sourceFile' in out.l1!).toBe(false);
  });
  it('coerces an unparseable asOfDate to null but KEEPS the key present (still a stamped record)', () => {
    const out = loadArrears({ l1: { d90plus: 5000, asOfDate: 'not-a-date' } });
    expect('asOfDate' in out.l1!).toBe(true);
    expect(out.l1!.asOfDate).toBeNull();
  });
  it('coerces a non-string sourceFile to null', () => {
    const out = loadArrears({ l1: { d90plus: 5000, sourceFile: 12345 } });
    expect(out.l1!.sourceFile).toBeNull();
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

// ---- evaluateOverlayPrecondition -------------------------------------------------------------
// Regression cover for the 2026-09-05 incident: the ora-cc-snapshot-refresh worktree-isolation
// procedure (spec v1.7, 2026-09-02) copies only .env into the fresh worktree, and `git worktree
// add` brings tracked files only -- so gitignored data/overlay.json was ABSENT. The three CLI
// writers each guarded the overlay with `if (existsSync(path)) { ...validate... }`, which defends
// against a PRESENT-but-corrupt overlay and does nothing at all when the file is MISSING. Execution
// fell through to loadOverlay() -> EMPTY_OVERLAY -> applyOverlay(), which zeroed arBalances (44->0),
// tenantArrears (44->0), dealComps (2->0) and renewalStages (1->0) in the written snapshot -- and
// the script exited 0 reporting a clean run. Only the snapshot task's own section-shrink guard
// caught it, at commit time.
//
// The refusal now lives in ONE shared evaluator instead of three copy-pasted blocks whose comments
// asked future editors to "keep both in sync" -- that duplication is what let the missing-file case
// go unnoticed in all three at once.
describe('evaluateOverlayPrecondition — refuses on a missing overlay, not just a corrupt one', () => {
  const dir = mkdtempSync(join(tmpdir(), 'overlay-precondition-'));
  // tests/setup.ts reasons carefully about not leaking one temp dir per test FILE; clean up ours.
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('refuses when the overlay file is ABSENT (the 2026-09-05 worktree-isolation case)', () => {
    const missing = join(dir, 'does-not-exist.json');
    const result = evaluateOverlayPrecondition(missing);
    expect(result.refuse).toBe(true);
    if (!result.refuse) throw new Error('expected refusal');
    expect(result.reason).toContain(missing);
    // The operator must be able to tell "absent" from "corrupt" without reading the source.
    expect(result.reason).toMatch(/not found|missing|absent/i);
  });

  // Refute 2026-09-06, found by all five lenses: the message prescribed ALLOW_EMPTY_OVERLAY=1 as
  // the remedy for a MISSING file, but the missing branch never consults it — a dead remedy, and
  // the previous version of this test pinned the contradiction by asserting only on the string.
  // The bootstrap is now explicitly TWO acts, and this asserts the behavior, not the wording.
  it('does NOT let ALLOW_EMPTY_OVERLAY=1 bypass a MISSING overlay file', () => {
    const prev = process.env.ALLOW_EMPTY_OVERLAY;
    process.env.ALLOW_EMPTY_OVERLAY = '1';
    try {
      expect(evaluateOverlayPrecondition(join(dir, 'nope.json')).refuse).toBe(true);
      expect(evaluateOverlayPrecondition(join(dir, 'nope.json'), { expectEnriched: true }).refuse).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.ALLOW_EMPTY_OVERLAY;
      else process.env.ALLOW_EMPTY_OVERLAY = prev;
    }
  });

  it('states the real two-act bootstrap in the missing-file reason', () => {
    const result = evaluateOverlayPrecondition(join(dir, 'nope.json'));
    if (!result.refuse) throw new Error('expected refusal');
    expect(result.reason).toMatch(/create the file containing \{\} AND set ALLOW_EMPTY_OVERLAY=1/);
  });

  it('allows a well-formed overlay object', () => {
    const good = join(dir, 'good.json');
    writeFileSync(good, JSON.stringify({ dealStages: {}, tasks: [] }));
    expect(evaluateOverlayPrecondition(good).refuse).toBe(false);
  });

  it('allows {} for a NON-snapshot caller (ar-import bootstrapping a first sweep)', () => {
    const empty = join(dir, 'empty.json');
    writeFileSync(empty, '{}');
    expect(evaluateOverlayPrecondition(empty).refuse).toBe(false);
  });

  it('REFUSES a present-but-empty overlay for a snapshot writer (expectEnriched)', () => {
    const empty = join(dir, 'empty-enriched.json');
    writeFileSync(empty, '{}');
    const result = evaluateOverlayPrecondition(empty, { expectEnriched: true });
    expect(result.refuse).toBe(true);
    if (!result.refuse) throw new Error('expected refusal');
    expect(result.reason).toMatch(/NO enrichment data/);
  });

  it('REFUSES an overlay whose domains are all present but empty (the first-saveOverlay case)', () => {
    const p = join(dir, 'all-empty-domains.json');
    writeFileSync(p, JSON.stringify({ dealStages: {}, tasks: [], tenantArrears: {}, dealComps: {} }));
    expect(evaluateOverlayPrecondition(p, { expectEnriched: true }).refuse).toBe(true);
  });

  it('ALLOWS an overlay with real enrichment in any single domain', () => {
    const p = join(dir, 'has-arrears.json');
    writeFileSync(p, JSON.stringify({ dealStages: {}, tasks: [], tenantArrears: { 'x-1': { d30: 100 } } }));
    expect(evaluateOverlayPrecondition(p, { expectEnriched: true }).refuse).toBe(false);
  });

  it('ALLOW_EMPTY_OVERLAY=1 opens the deliberate bootstrap path for a snapshot writer', () => {
    const empty = join(dir, 'empty-allowed.json');
    writeFileSync(empty, '{}');
    const prev = process.env.ALLOW_EMPTY_OVERLAY;
    process.env.ALLOW_EMPTY_OVERLAY = '1';
    try {
      expect(evaluateOverlayPrecondition(empty, { expectEnriched: true }).refuse).toBe(false);
    } finally {
      if (prev === undefined) delete process.env.ALLOW_EMPTY_OVERLAY;
      else process.env.ALLOW_EMPTY_OVERLAY = prev;
    }
  });

  // Refute 2026-09-06 (4 of 5 lenses): hasNoEnrichment judged the RAW parse while loadOverlay
  // applies per-entry Zod/coercion, so these shapes passed the guard and still merged as
  // EMPTY_OVERLAY — the same silent zeroing, reached through the loader instead of a missing file.
  // Each was reproduced in-process by a refuter before this test existed.
  it.each([
    ['dealComps entries that fail CompSet', '{"dealComps":{"d1":{"bogus":true}}}'],
    ['renewalStages values that fail RenewalStage', '{"renewalStages":{"l1":"NotAStage"}}'],
    ['tenantArrears entries that are not objects', '{"tenantArrears":{"x-1":"oops","x-2":5}}'],
    ['tasks as an object rather than an array', '{"tasks":{"a":1}}'],
  ])('refuses %s — raw-populated but dropped by the loader', (_label, body) => {
    const p = join(dir, `dropped-${_label.replace(/\W/g, '')}.json`);
    writeFileSync(p, body);
    const result = evaluateOverlayPrecondition(p);
    expect(result.refuse).toBe(true);
    if (!result.refuse) throw new Error('expected refusal');
    expect(result.reason).toMatch(/do NOT survive validation/);
  });

  it('refuses a loader-dropped domain even WITHOUT expectEnriched (ar-import would cement it)', () => {
    const p = join(dir, 'dropped-no-expect.json');
    writeFileSync(p, '{"tenantArrears":{"x-1":"oops"},"dealStages":{"d1":"Closing"}}');
    // dealStages survives, so this is NOT an empty overlay — but tenantArrears is silently lost,
    // and ar-import-headless's saveOverlay() would write that loss back as canonical.
    expect(evaluateOverlayPrecondition(p).refuse).toBe(true);
  });

  it('treats a non-null SCALAR domain as empty, not as enrichment', () => {
    const p = join(dir, 'scalar-domain.json');
    writeFileSync(p, '{"tenantArrears":0}');
    // Pre-2026-09-06 the fall-through returned false ("populated"), so this passed expectEnriched
    // and then loaded as {} — junk that reads as data is exactly the silent-zeroing shape.
    expect(evaluateOverlayPrecondition(p, { expectEnriched: true }).refuse).toBe(true);
  });

  it('ALLOWS a real overlay whose entries all survive the loader', () => {
    const p = join(dir, 'genuinely-good.json');
    writeFileSync(p, JSON.stringify({
      dealStages: { d1: 'Closing' },
      tenantArrears: { 'x-1': { d30: 100, d60: 0, d90: 0, d90plus: 0 } },
    }));
    expect(evaluateOverlayPrecondition(p, { expectEnriched: true }).refuse).toBe(false);
  });

  it('refuses a BOM-prefixed overlay — loadOverlay cannot read it either, so accepting would zero', () => {
    const bom = join(dir, 'bom.json');
    writeFileSync(bom, '﻿{"tenantArrears":{"x":{"d30":1}}}');
    // Deliberately NOT stripping the BOM here: loadOverlay() uses the same JSON.parse and would
    // fall back to EMPTY_OVERLAY, so "accepting" this file is the silent-zeroing path.
    expect(evaluateOverlayPrecondition(bom).refuse).toBe(true);
  });

  it('refuses a zero-byte overlay and a directory at the path', () => {
    const zero = join(dir, 'zero.json');
    writeFileSync(zero, '');
    expect(evaluateOverlayPrecondition(zero).refuse).toBe(true);
    const asDir = join(dir, 'a-directory.json');
    mkdirSync(asDir, { recursive: true });
    expect(evaluateOverlayPrecondition(asDir).refuse).toBe(true);
  });

  it('still refuses unparseable JSON (pre-existing guard, preserved)', () => {
    const corrupt = join(dir, 'corrupt.json');
    writeFileSync(corrupt, '{ not valid json');
    const result = evaluateOverlayPrecondition(corrupt);
    expect(result.refuse).toBe(true);
    if (!result.refuse) throw new Error('expected refusal');
    expect(result.reason).toMatch(/corrupt|unparseable/i);
  });

  it.each([
    ['null', 'null'],
    ['an array', '[]'],
    ['a number', '0'],
    ['a string', '"overlay"'],
  ])('still refuses valid JSON that is %s, not an object (pre-existing guard, preserved)', (_label, body) => {
    const p = join(dir, `shape-${_label.replace(/\W/g, '')}.json`);
    writeFileSync(p, body);
    const result = evaluateOverlayPrecondition(p);
    expect(result.refuse).toBe(true);
    if (!result.refuse) throw new Error('expected refusal');
    expect(result.reason).toMatch(/not a valid overlay object/i);
  });
});

// ---- call-site guard SHAPE ---------------------------------------------------------------------
// I5, 2026-09-05 independent review: every other test here exercises the pure predicate, but the
// predicate was never the bug. The defect was the SHAPE of the call-site guard --
// `if (existsSync(rawOverlayPath)) { ...validate... }` -- which by construction cannot fire when the
// file is absent. A future editor could revert any single call site to that wrapper and every
// behavioral test above would still pass. These assertions pin the shape itself.
//
// Source-level rather than behavioral on purpose: the two snapshot writers call process.exit() deep
// inside a main() that first parses the live Master Workbook (absent in CI), so genuinely executing
// them here is not possible. This is the cheapest thing that actually fails on a regression.
describe('overlay guard — call-site shape (regression cover for the guard, not the predicate)', () => {
  const repoRoot = join(__dirname, '..', '..');
  const WRITERS = [
    'scripts/extract-workbook.ts',
    'scripts/lease-snapshot-drift-check.ts',
    'scripts/ar-import-headless.ts',
    'scripts/migrate-lease-overlay-ids.ts',
  ] as const;

  it.each(WRITERS)('%s routes the overlay through the shared evaluator', (rel) => {
    const src = readFileSync(join(repoRoot, rel), 'utf8');
    expect(src).toContain('evaluateOverlayPrecondition(rawOverlayPath');
    expect(src).toMatch(/overlayCheck\.refuse/);
  });

  it.each(WRITERS)('%s no longer wraps the overlay guard in an existsSync() that skips a missing file', (rel) => {
    const src = readFileSync(join(repoRoot, rel), 'utf8');
    expect(src).not.toMatch(/if\s*\(\s*existsSync\(\s*rawOverlayPath\s*\)\s*\)/);
  });

  // Only the writers that MERGE an overlay onto a snapshot may demand enrichment. ar-import and
  // migrate legitimately run against an empty overlay, so opting them in would break a first sweep.
  it.each(['scripts/extract-workbook.ts', 'scripts/lease-snapshot-drift-check.ts'] as const)(
    '%s opts into expectEnriched (it merges onto a snapshot)',
    (rel) => {
      expect(readFileSync(join(repoRoot, rel), 'utf8')).toContain('expectEnriched: true');
    },
  );

  it.each(['scripts/ar-import-headless.ts', 'scripts/migrate-lease-overlay-ids.ts'] as const)(
    '%s does NOT opt into expectEnriched (an empty overlay is legitimate there)',
    (rel) => {
      // Assert on the CALL, not the word: both files explain in prose why they opt out.
      expect(readFileSync(join(repoRoot, rel), 'utf8')).not.toMatch(/expectEnriched:\s*true/);
    },
  );

  // I6: importing a CLI script must never run main(). tests/setup.ts points OVERLAY_PATH at a
  // sandbox path that is never created, so an unguarded main() would now hit the overlay refusal
  // and process.exit() the vitest worker.
  it.each(WRITERS)('%s guards its entrypoint on process.argv[1]', (rel) => {
    const src = readFileSync(join(repoRoot, rel), 'utf8');
    expect(src).toMatch(/process\.argv\[1\]\?\.replace/);
  });
});
