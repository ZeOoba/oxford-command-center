// tests/unit/brain-overlay-sync.test.ts
//
// Roadmap 2026-10-30 item 1.5. Brain used to load overlay.json once and save its whole in-memory
// copy on every write-back, erasing writes by any other writer (the headless AR sweep,
// setLeaseRunAssumptions, a manual edit). Write-backs are now async: each is a queued
// read-modify-write against the file as it is on disk (mutateOverlay), the route awaits it, and a
// failed save rejects with memory unchanged. These run the REAL overlay module against a temp file;
// every case below was reproduced as data loss against one of three earlier designs.
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DealStage, RenewalStage, Task } from '../../src/contracts/index';
import type { brain as BrainSingleton } from '../../server/brain';
import type * as ReconcileRuntimeModule from '../../server/reconcile-runtime';
import type * as OverlayModule from '../../server/overlay';
import type * as RenameRetryModule from '../../server/lib/rename-retry';
import type * as NodeFs from 'node:fs';
import type * as NodeFsPromises from 'node:fs/promises';

const h = vi.hoisted(() => ({
  base: null as Record<string, unknown> | null,
  /** Fail the next N reads of overlay.json with EBUSY (a Windows AV/indexer lock). */
  failOverlayReads: 0,
  /** Fail the next N overlay renames (an exhausted transient-lock retry). */
  failRenames: 0,
  /** Run once while a write-back's temp file is being written: between its read and its rename. */
  duringWrite: [] as Array<() => void>,
}));

// Vitest 4: a node builtin mock must patch `default` too, or server modules' named imports stay real.
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof NodeFs>();
  const readFileSync = ((path: unknown, ...rest: unknown[]) => {
    if (typeof path === 'string' && path.endsWith('overlay.json') && h.failOverlayReads > 0) {
      h.failOverlayReads--;
      throw Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    }
    return (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
  }) as typeof real.readFileSync;
  return { ...real, readFileSync, default: { ...real, readFileSync } };
});
vi.mock('node:fs/promises', async (importOriginal) => {
  const real = await importOriginal<typeof NodeFsPromises>();
  const writeFile = (async (path: unknown, ...rest: unknown[]) => {
    if (typeof path === 'string' && path.includes('overlay.json.tmp-')) h.duringWrite.shift()?.();
    return (real.writeFile as (...a: unknown[]) => Promise<void>)(path, ...rest);
  }) as typeof real.writeFile;
  return { ...real, writeFile, default: { ...real, writeFile } };
});
vi.mock('../../server/lib/rename-retry', async (importOriginal) => {
  const real = await importOriginal<typeof RenameRetryModule>();
  return {
    ...real,
    renameWithRetry: (async (...args: Parameters<typeof real.renameWithRetry>) => {
      if (h.failRenames > 0) {
        h.failRenames--;
        throw Object.assign(new Error('EPERM: rename retries exhausted'), { code: 'EPERM' });
      }
      return real.renameWithRetry(...args);
    }) as typeof real.renameWithRetry,
  };
});

vi.mock('../../server/config', () => ({
  workbookPath: () => '/nonexistent/oxford-test-workbook.xlsx',
  SNAPSHOT_PATH: '/nonexistent/oxford-overlay-sync-test/portfolio.json',
  serverPort: () => 8911,
  WORKBOOK_AS_OF: '2026-06-01',
  referenceDate: () => '2026-10-30',
}));
vi.mock('../../server/workbook/parse', () => ({
  parseWorkbook: vi.fn(async () => ({ snapshot: h.base, flags: [], dealsDegraded: null, m365Degraded: null })),
}));
vi.mock('../../server/reconcile-runtime', async (importOriginal) => ({
  ...(await importOriginal<typeof ReconcileRuntimeModule>()),
  checkSnapshot: vi.fn(() => []),
}));
vi.mock('../../server/sources/quickbooks', () => ({
  resolveQuickbooks: vi.fn(() => ({ quickbooks: null, preservedFrom: null })),
}));
vi.mock('../../src/brain/tenants', () => ({ tenantScorecards: vi.fn(() => [{ id: 't1' }, { id: 't2' }]) }));
vi.mock('chokidar', () => ({ watch: vi.fn(() => ({ on: vi.fn() })) }));

const dir = join(tmpdir(), `oxford-overlay-sync-${process.pid}`);
const overlayFile = join(dir, 'overlay.json');
// A non-empty enrichment domain so the file reads like a real, populated overlay.
const START = { dealStages: {}, tasks: [], renewalStages: {}, tenantNotes: { seed: 'kept' }, dealComps: {}, noiBudgets: {}, tenantArrears: {}, acquisitionInputs: {}, leaseRunAssumptions: {}, marketRents: {} };
const onDisk = () => JSON.parse(readFileSync(overlayFile, 'utf8')) as OverlayModule.Overlay;
/** Another process publishing overlay.json the way every real writer does: temp file + rename. */
function externalPublish(content: unknown): void {
  const tmp = `${overlayFile}.ext-${Math.random()}`;
  writeFileSync(tmp, typeof content === 'string' ? content : JSON.stringify(content, null, 2));
  renameSync(tmp, overlayFile);
}
const task = (id: string): Task => ({ id, label: `task ${id}`, section: 'Manual', role: null, type: 'Manual', dueDay: null, notes: null, status: 'pending', monthlyPmt: null });
const servedStage = (id: string) => brain.getSnapshot()!.deals.find((d) => d.id === id)!.stage;

let brain: typeof BrainSingleton;
let overlay: typeof OverlayModule;

beforeEach(async () => {
  h.failOverlayReads = 0;
  h.failRenames = 0;
  h.duringWrite = [];
  delete process.env.ALLOW_EMPTY_OVERLAY;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  writeFileSync(overlayFile, JSON.stringify(START, null, 2));
  process.env.OVERLAY_PATH = overlayFile;
  h.base = {
    deals: Array.from({ length: 12 }, (_, i) => ({ id: `d${i}`, stage: 'Sourcing' })),
    leases: [{ id: 'l1', propertyKey: 'k1' }],
    properties: [{ id: 'p1' }],
    dataQuality: [],
    tasks: [],
  };
  vi.resetModules();
  ({ brain } = await import('../../server/brain'));
  overlay = await import('../../server/overlay');
  await brain.refresh();
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env.OVERLAY_PATH;
  delete process.env.ALLOW_EMPTY_OVERLAY;
});

describe('an unusable overlay file is never used as an empty write base', () => {
  it.each([
    ['null', 'null', false],
    ['{}', '{}', false],
    ['{} with ALLOW_EMPTY_OVERLAY=1', '{}', true],
    ['every domain present but empty', JSON.stringify({ ...START, tenantNotes: {} }), false],
    ['unparseable JSON', '{"tenantNotes": {', false],
    ['an array', '[]', false],
  ])('%s: the write-back rejects, the file is untouched and memory is unchanged', async (_label, text, allowEmpty) => {
    if (allowEmpty) process.env.ALLOW_EMPTY_OVERLAY = '1';
    externalPublish(text);
    await expect(brain.setDealStage('d1', 'Closing' as DealStage)).rejects.toThrow();
    expect(readFileSync(overlayFile, 'utf8')).toBe(text);
    expect(servedStage('d1')).toBe('Sourcing');
  });

  it('a file deleted after the server saw data in it is not recreated empty', async () => {
    rmSync(overlayFile);
    await expect(brain.setDealStage('d1', 'Closing' as DealStage)).rejects.toThrow(/disappeared/);
    expect(() => readFileSync(overlayFile, 'utf8')).toThrow();
  });

  it('C10: an in-process read (loadOverlay — a lease-run GET, the briefing) does not re-arm a truncated file', async () => {
    externalPublish('{}');
    overlay.loadOverlay();
    await expect(brain.setDealStage('d1', 'Closing' as DealStage)).rejects.toThrow(/empty/);
    expect(readFileSync(overlayFile, 'utf8')).toBe('{}');
    expect(brain.getSnapshot()!.tenantNotes).toEqual({ seed: 'kept' }); // Brain's last good copy kept
  });

  it.each([
    ['one invalid entry in a valid domain', { ...START, tenantNotes: { seed: 'kept', bad: 42 } }],
    ['an unknown top-level key', { ...START, extraTop: { x: 1 } }],
    ['one invalid task among valid ones', { ...START, tasks: [task('ok1'), { id: 'broken' }] }],
  ])('C14: %s is refused, never silently erased by the save', async (_label, content) => {
    externalPublish(content);
    const before = readFileSync(overlayFile, 'utf8');
    await expect(brain.setDealStage('d1', 'Closing' as DealStage)).rejects.toThrow(/would drop/);
    expect(readFileSync(overlayFile, 'utf8')).toBe(before);
  });

  it('a domain the loader would drop rejects instead of being saved away', async () => {
    externalPublish({ ...START, dealComps: { d1: { bogus: true } } });
    await expect(brain.setDealStage('d1', 'Closing' as DealStage)).rejects.toThrow(/do NOT survive/);
    expect(onDisk().dealComps).toEqual({ d1: { bogus: true } });
  });

  it('a genuinely new install (no file, nothing seen) bootstraps on the first write-back', async () => {
    rmSync(overlayFile);
    vi.resetModules();
    ({ brain } = await import('../../server/brain'));
    await brain.refresh();
    expect(await brain.setDealStage('d1', 'Closing' as DealStage)).toBe(true);
    expect(onDisk().dealStages).toEqual({ d1: 'Closing' });
  });

  it('a note this server itself deleted to empty does not lock later writes out', async () => {
    externalPublish({ ...START, tenantNotes: { t1: 'only note' } });
    expect(await brain.setTenantNote('t1', 'only note')).toBe(true);
    expect(await brain.setTenantNote('t1', '')).toBe(true); // overlay is now wholly empty, by our own hand
    expect(await brain.setDealStage('d1', 'Closing' as DealStage)).toBe(true);
    expect(onDisk().dealStages).toEqual({ d1: 'Closing' });
  });
});

describe('a read lock (EBUSY) fails the write instead of emptying the overlay', () => {
  it('rejects, leaves the file intact, and the next write lands on the real content', async () => {
    h.failOverlayReads = 1;
    await expect(brain.setDealStage('d1', 'Closing' as DealStage)).rejects.toThrow(/EBUSY/);
    expect(onDisk()).toEqual(START);
    expect(servedStage('d1')).toBe('Sourcing');

    expect(await brain.setDealStage('d2', 'Closing' as DealStage)).toBe(true);
    expect(onDisk().tenantNotes).toEqual({ seed: 'kept' });
    expect(onDisk().dealStages).toEqual({ d2: 'Closing' });
  });
});

describe('writes by other writers survive', () => {
  it('an external write made before a write-back survives it, and memory picks it up', async () => {
    externalPublish({ ...START, tenantNotes: { seed: 'kept', t2: 'AR sweep' } });
    await brain.setDealStage('d1', 'Closing' as DealStage);
    expect(onDisk().tenantNotes).toEqual({ seed: 'kept', t2: 'AR sweep' });
    expect(onDisk().dealStages).toEqual({ d1: 'Closing' });
    expect(brain.getSnapshot()!.tenantNotes).toEqual({ seed: 'kept', t2: 'AR sweep' });
  });

  it('an external write landing between the read and the rename is re-read, not overwritten', async () => {
    h.duringWrite.push(() => externalPublish({ ...START, tenantNotes: { seed: 'kept', t2: 'AR sweep' } }));
    await brain.setDealStage('d1', 'Closing' as DealStage);
    expect(onDisk().tenantNotes).toEqual({ seed: 'kept', t2: 'AR sweep' });
    expect(onDisk().dealStages).toEqual({ d1: 'Closing' });
  });

  it('an external write landing while a write-back waits in the queue survives it', async () => {
    h.duringWrite.push(() => externalPublish({ ...START, tenantNotes: { seed: 'kept', t2: 'AR sweep' } }));
    const first = brain.setDealStage('d0', 'Closing' as DealStage);
    const second = brain.setDealStage('d1', 'Closing' as DealStage); // queued behind the first
    await Promise.all([first, second]);
    expect(onDisk().tenantNotes).toEqual({ seed: 'kept', t2: 'AR sweep' });
    expect(onDisk().dealStages).toEqual({ d0: 'Closing', d1: 'Closing' });
  });

  it('a writer that never stops changing the file gets a rejection, not a lost write', async () => {
    for (let i = 0; i < overlay.MUTATE_MAX_ATTEMPTS; i++) {
      h.duringWrite.push(() => externalPublish({ ...START, tenantNotes: { seed: 'kept', [`x${i}`]: 'busy' } }));
    }
    await expect(brain.setDealStage('d1', 'Closing' as DealStage)).rejects.toThrow(/kept changing/);
    expect(onDisk().tenantNotes).toHaveProperty(`x${overlay.MUTATE_MAX_ATTEMPTS - 1}`);
    expect(onDisk().dealStages).toEqual({});
    expect(servedStage('d1')).toBe('Sourcing');
  });

  it('setLeaseRunAssumptions interleaved with Brain write-backs loses neither', async () => {
    await Promise.all([
      brain.setDealStage('d0', 'Closing' as DealStage),
      overlay.setLeaseRunAssumptions('p1', { downtimeMonths: 6 } as never),
      brain.setRenewalStage('l1', 'Negotiating' as RenewalStage),
      overlay.setLeaseRunAssumptions('p2', { downtimeMonths: 3 } as never),
      brain.setNoiBudget('p1', 1000),
    ]);
    const o = onDisk();
    expect(o.dealStages).toEqual({ d0: 'Closing' });
    expect(o.renewalStages).toEqual({ l1: 'Negotiating' });
    expect(o.noiBudgets).toEqual({ p1: 1000 });
    expect(o.leaseRunAssumptions).toEqual({ p1: { downtimeMonths: 6 }, p2: { downtimeMonths: 3 } });
    // ...and a later Brain write-back does not erase the assumptions either.
    await brain.setDealStage('d1', 'Closing' as DealStage);
    expect(onDisk().leaseRunAssumptions).toEqual({ p1: { downtimeMonths: 6 }, p2: { downtimeMonths: 3 } });
  });

  it('setLeaseRunAssumptions rejects rather than writing over an unusable file', async () => {
    externalPublish('null');
    await expect(overlay.setLeaseRunAssumptions('p1', { downtimeMonths: 6 } as never)).rejects.toThrow(/Failed to persist/);
    expect(readFileSync(overlayFile, 'utf8')).toBe('null');
  });
});

describe('concurrent write-backs', () => {
  it('12 concurrent write-backs to different keys all land', async () => {
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => brain.setDealStage(`d${i}`, 'Closing' as DealStage)));
    expect(results.every(Boolean)).toBe(true);
    expect(Object.keys(onDisk().dealStages).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `d${i}`).sort());
    for (let i = 0; i < 12; i++) expect(servedStage(`d${i}`)).toBe('Closing');
  });

  it('12 concurrent write-backs to the SAME key land in call order (last call wins, on disk and in memory)', async () => {
    await Promise.all(Array.from({ length: 12 }, (_, i) => brain.setNoiBudget('p1', (i + 1) * 100)));
    expect(onDisk().noiBudgets).toEqual({ p1: 1200 });
    expect(brain.getSnapshot()!.noiBudgets).toEqual({ p1: 1200 });
  });
});

describe('a failed save is reported and never replayed', () => {
  it('A then B on one key, B rename fails: B rejects, disk and memory stay A', async () => {
    await brain.setDealStage('d1', 'Closing' as DealStage);
    h.failRenames = 1;
    await expect(brain.setDealStage('d1', 'Due Diligence' as DealStage)).rejects.toThrow(/EPERM/);
    expect(onDisk().dealStages).toEqual({ d1: 'Closing' });
    expect(servedStage('d1')).toBe('Closing');
  });

  it('A then B on one key, A rename fails: B lands and A is never re-applied over it', async () => {
    h.failRenames = 1;
    const a = brain.setDealStage('d1', 'Closing' as DealStage);
    const b = brain.setDealStage('d1', 'Due Diligence' as DealStage);
    await expect(a).rejects.toThrow(/EPERM/);
    await expect(b).resolves.toBe(true);
    await brain.setDealStage('d2', 'Closing' as DealStage); // a later, unrelated write
    expect(onDisk().dealStages).toEqual({ d1: 'Due Diligence', d2: 'Closing' });
    expect(servedStage('d1')).toBe('Due Diligence');
  });

  it('a deleted tenant note never resurrects, through a failed write or a later success', async () => {
    await brain.setTenantNote('t1', 'call re: roof');
    await brain.setTenantNote('t1', '');
    expect(onDisk().tenantNotes).toEqual({ seed: 'kept' });
    h.failRenames = 1;
    await expect(brain.setDealStage('d1', 'Closing' as DealStage)).rejects.toThrow();
    await brain.setDealStage('d2', 'Closing' as DealStage);
    expect(onDisk().tenantNotes).toEqual({ seed: 'kept' });
    expect(brain.getSnapshot()!.tenantNotes).toEqual({ seed: 'kept' });
  });

  it('a note deleted by another writer is not resurrected by this server’s stale memory', async () => {
    await brain.setTenantNote('t1', 'call re: roof');
    externalPublish({ ...START }); // another writer removes t1
    await brain.setDealStage('d1', 'Closing' as DealStage);
    expect(onDisk().tenantNotes).toEqual({ seed: 'kept' });
  });

  it('addTask never duplicates: not on a contended re-read, not after a failed attempt', async () => {
    h.duringWrite.push(() => externalPublish({ ...START, tenantNotes: { seed: 'kept', t2: 'AR sweep' } }));
    await brain.addTask(task('tk1'));
    h.failRenames = 1;
    await expect(brain.addTask(task('tk2'))).rejects.toThrow();
    await brain.addTask(task('tk3'));
    expect(onDisk().tasks.map((t) => t.id)).toEqual(['tk3', 'tk1']);
    expect(brain.getSnapshot()!.tasks.filter((t) => t.id.startsWith('tk')).map((t) => t.id)).toEqual(['tk3', 'tk1']);
  });

  it('no temp file is left behind by a failed or contended write', async () => {
    h.failRenames = 1;
    await expect(brain.setDealStage('d1', 'Closing' as DealStage)).rejects.toThrow();
    h.duringWrite.push(() => externalPublish({ ...START }));
    await brain.setDealStage('d2', 'Closing' as DealStage);
    const { readdirSync } = await vi.importActual<typeof NodeFs>('node:fs');
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});

describe('a write the loader could not read back is never published', () => {
  it('N1: a malformed task is refused, and later writes are not locked out', async () => {
    await expect(brain.addTask({ ...task('bad'), notes: 5 as never })).rejects.toThrow(/would not read back/);
    expect(onDisk()).toEqual(START);
    expect(await brain.setDealStage('d1', 'Closing' as DealStage)).toBe(true);
    await expect(overlay.setLeaseRunAssumptions('p1', { downtimeMonths: 6 } as never)).resolves.toBeDefined();
    expect(onDisk().dealStages).toEqual({ d1: 'Closing' });
  });
});

describe('a throwing mutation does not wedge the shared queue', () => {
  it('rejects that call only; later write-backs and saves still land', async () => {
    const boom = overlay.mutateOverlay(() => {
      throw new Error('mutation blew up');
    });
    const after = brain.setDealStage('d1', 'Closing' as DealStage);
    await expect(boom).rejects.toThrow('mutation blew up');
    await expect(after).resolves.toBe(true);
    expect(onDisk().dealStages).toEqual({ d1: 'Closing' });
    expect(await overlay.saveOverlay({ ...overlay.EMPTY_OVERLAY, ...onDisk(), noiBudgets: { p1: 5 } })).toBe(true);
  });
});
