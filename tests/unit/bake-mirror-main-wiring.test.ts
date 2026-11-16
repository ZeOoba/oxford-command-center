// Refute round 6, G5: nothing pinned that scripts/bake-mirror.ts main() actually CALLS
// rosterScrubSnapshot: deleting that call left every test green, because the unit tests exercise
// the function directly. This runs main() itself end to end (workbook parse, macro and the
// reconciliation reader mocked; cwd is a temp dir, so public/ is written there, never in the repo) against
// a synthetic roster, and asserts a hyphen variant of a roster term planted in a task (which the
// name-based redactConfidential cannot see) never reaches the written public/snapshot.json, and that
// an unreadable roster refuses the bake with nothing written. Synthetic names only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PortfolioSnapshot } from '../../src/contracts/index';

const SNAPSHOT = {
  meta: { asOf: '2026-10-01', scenario: 'base' },
  properties: [{ id: 'p1', name: 'Public Flex Center' }],
  leases: [{ id: 'l1', tenant: 'Acme Tooling' }],
  loans: [], insurance: [], deals: [],
  counterparties: [],
  tasks: [
    { id: 't1', label: 'Send PSA redline - Kestrel-Ridge', notes: null },
    { id: 't2', label: 'Renew insurance', notes: null },
  ],
  tenantNotes: {}, dealComps: {}, acquisitionInputs: {}, renewalStages: {}, tenantArrears: {}, marketRents: {}, noiBudgets: {},
  dataQuality: [],
} as unknown as PortfolioSnapshot;

vi.mock('../../server/workbook/parse', () => ({
  parseWorkbook: vi.fn(async () => ({ snapshot: SNAPSHOT, dealsDegraded: null, m365Degraded: null })),
}));
vi.mock('../../server/macro/getMacro', () => ({ getMacro: vi.fn(async () => ({})) }));
vi.mock('../../server/reconcile-runtime', () => ({ checkSnapshot: vi.fn(() => []), hasReconciliationError: vi.fn(() => false) }));

import { main, isCarryForwardWarehouse, removeStaleBakeOutputs, WAREHOUSE_CARRY_FORWARD_MAX_AGE_MS } from '../../scripts/bake-mirror';
import { WAREHOUSE_MIRROR_SCHEMA_VERSION } from '../../src/lib/warehouse-mirror';

const ENV_KEYS = ['CONFIDENTIAL_TERMS_PATH', 'CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER', 'MIRROR_INCLUDE_CONFIDENTIAL', 'MIRROR_ACCESS_PREPROBE', 'BRIEF_ENABLED', 'BAKE_WAREHOUSE', 'WAREHOUSE_DB'] as const;
const saved: Record<string, string | undefined> = {};
let dir: string;
let cwd: string;
beforeEach(() => {
  cwd = process.cwd();
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  for (const k of ENV_KEYS) delete process.env[k];
  dir = mkdtempSync(join(tmpdir(), 'bake-main-'));
  process.chdir(dir);
  const p = join(dir, 't.json');
  writeFileSync(p, JSON.stringify({ syn: { label: 'Synthetic', active: true, always: ['Kestrel Ridge'] } }), 'utf8');
  process.env.CONFIDENTIAL_TERMS_PATH = p;
  process.env.WAREHOUSE_DB = join(dir, 'no-such.sqlite');
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  process.chdir(cwd);
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

const snapshotJson = (): string | undefined => {
  const p = join(dir, 'public', 'snapshot.json');
  return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
};

describe('bake-mirror main(): the roster scrub is wired in (redacted mode)', () => {
  it('a roster-term variant in a task never reaches public/snapshot.json', async () => {
    await main();
    const out = snapshotJson();
    expect(out).toBeDefined();
    expect(out!.toLowerCase()).not.toContain('kestrel');
    expect((JSON.parse(out!) as PortfolioSnapshot).tasks.map((t) => t.id)).toEqual(['t2']);
  });

  it('an unreadable roster refuses the bake: exit 1, nothing written', async () => {
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
    await expect(main()).rejects.toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    expect(snapshotJson()).toBeUndefined();
  });
});

// Audit wf_9bf74429-aaf findings 30 and 31.
describe('bake-mirror main(): bake mode and stale outputs', () => {
  const exitThrows = () =>
    vi.spyOn(process, 'exit').mockImplementation(((code?: number) => { throw new Error(`exit ${code}`); }) as never);
  const pubFile = (name: string) => join(dir, 'public', name);

  it('finding 31: FULL requested without the passed pre-deploy probe refuses, exit 1, nothing written', async () => {
    process.env.MIRROR_INCLUDE_CONFIDENTIAL = '1';
    const exit = exitThrows();
    await expect(main()).rejects.toThrow('exit 1');
    expect(exit).toHaveBeenCalledWith(1);
    expect(snapshotJson()).toBeUndefined();
  });

  it('finding 31: FULL with MIRROR_ACCESS_PREPROBE=passed bakes FULL (no roster scrub)', async () => {
    process.env.MIRROR_INCLUDE_CONFIDENTIAL = '1';
    process.env.MIRROR_ACCESS_PREPROBE = 'passed';
    await main();
    expect((JSON.parse(snapshotJson()!) as PortfolioSnapshot).tasks.map((t) => t.id)).toEqual(['t1', 't2']);
  });

  // 2026-11-13: the hourly FULL deploy (no -IncludeWarehouse) shipped a public/warehouse.json last
  // baked 2026-08-18 -- gitignored, so the build root's `git clean -fd` kept it, and vite copied it
  // into dist/. A FULL bake must not ship an output it did not regenerate either.
  it('FULL without BAKE_WAREHOUSE removes a stale public/warehouse.json and its copies', async () => {
    process.env.MIRROR_INCLUDE_CONFIDENTIAL = '1';
    process.env.MIRROR_ACCESS_PREPROBE = 'passed';
    mkdirSync(join(dir, 'public', 'old'), { recursive: true });
    const stale = ['warehouse.json', 'warehouse (1).json', 'old/snapshot.json'];
    for (const n of stale) writeFileSync(pubFile(n), '{"stale":true}');
    writeFileSync(pubFile('logo.svg'), '<svg/>');
    await main();
    for (const n of stale) expect(existsSync(pubFile(n)), n).toBe(false);
    expect(existsSync(pubFile('logo.svg'))).toBe(true);
    expect(existsSync(pubFile('snapshot.json'))).toBe(true);
  });

  // Refute wf_fc335a58-0a1: the documented cadence is a daily -IncludeWarehouse bake that the hourly
  // FULL runs carry forward, so a RECENT current-schema warehouse.json must survive an hourly run.
  const envelope = (bakedAt: string) =>
    JSON.stringify({ schemaVersion: WAREHOUSE_MIRROR_SCHEMA_VERSION, bakedAt, warehouseSource: 'live-server', endpoints: {} });
  const hoursAgo = (h: number) => new Date(Date.now() - h * 3600_000).toISOString();

  it('FULL without BAKE_WAREHOUSE keeps a recent current-schema warehouse.json (daily bake carried forward)', async () => {
    process.env.MIRROR_INCLUDE_CONFIDENTIAL = '1';
    process.env.MIRROR_ACCESS_PREPROBE = 'passed';
    mkdirSync(join(dir, 'public'), { recursive: true });
    const fresh = envelope(hoursAgo(3));
    writeFileSync(pubFile('warehouse.json'), fresh);
    await main();
    expect(readFileSync(pubFile('warehouse.json'), 'utf8')).toBe(fresh);
  });

  it('FULL without BAKE_WAREHOUSE removes one older than the carry-forward window, or with the wrong schema', async () => {
    process.env.MIRROR_INCLUDE_CONFIDENTIAL = '1';
    process.env.MIRROR_ACCESS_PREPROBE = 'passed';
    mkdirSync(join(dir, 'public'), { recursive: true });
    writeFileSync(pubFile('warehouse.json'), envelope(hoursAgo(27)));
    await main();
    expect(existsSync(pubFile('warehouse.json'))).toBe(false);
    writeFileSync(pubFile('warehouse.json'), JSON.stringify({ ...JSON.parse(envelope(hoursAgo(1))), schemaVersion: 'wh-v0' }));
    await main();
    expect(existsSync(pubFile('warehouse.json'))).toBe(false);
  });

  it('REDACTED removes even a recent warehouse.json (it may be a FULL bake)', async () => {
    mkdirSync(join(dir, 'public'), { recursive: true });
    writeFileSync(pubFile('warehouse.json'), envelope(hoursAgo(1)));
    await main();
    expect(existsSync(pubFile('warehouse.json'))).toBe(false);
  });

  it('isCarryForwardWarehouse: window edges, future stamps and unreadable files', () => {
    mkdirSync(join(dir, 'public'), { recursive: true });
    const f = pubFile('warehouse.json');
    const now = Date.parse('2026-11-13T12:00:00Z');
    const at = (iso: string) => { writeFileSync(f, envelope(iso)); return isCarryForwardWarehouse(f, now); };
    expect(at(new Date(now - WAREHOUSE_CARRY_FORWARD_MAX_AGE_MS).toISOString())).toBe(true);
    expect(at(new Date(now - WAREHOUSE_CARRY_FORWARD_MAX_AGE_MS - 1000).toISOString())).toBe(false);
    expect(at(new Date(now + 60 * 60 * 1000).toISOString())).toBe(false);
    writeFileSync(f, 'not json');
    expect(isCarryForwardWarehouse(f, now)).toBe(false);
    expect(isCarryForwardWarehouse(join(dir, 'missing.json'), now)).toBe(false);
  });

  // Unit-level (no real warehouse bake, which probes a local Brain Server and is slow under load):
  // a run that re-bakes the warehouse removes even a FRESH file up front, so a bake that then fails
  // or refuses can never ship the previous payload (refute wf_ec2162a9-34f).
  it('a FULL run that re-bakes the warehouse removes even a fresh warehouse.json before the bake', () => {
    mkdirSync(join(dir, 'public'), { recursive: true });
    writeFileSync(pubFile('warehouse.json'), envelope(hoursAgo(1)));
    expect(removeStaleBakeOutputs(join(dir, 'public'), { includeConfidential: true, bakeWarehouse: true })).toEqual(['warehouse.json']);
    expect(existsSync(pubFile('warehouse.json'))).toBe(false);
  });

  it('finding 30: a REDACTED bake removes a stale FULL public/warehouse.json it does not regenerate', async () => {
    mkdirSync(join(dir, 'public'), { recursive: true });
    writeFileSync(pubFile('warehouse.json'), '{"deals":[{"name":"Kestrel Ridge"}]}');
    await main();
    expect(existsSync(pubFile('warehouse.json'))).toBe(false);
    expect(snapshotJson()).toBeDefined();
  });

  it('finding 30: copies of baked outputs go too; snapshot.json/macro.json are rewritten, not deleted', async () => {
    mkdirSync(join(dir, 'public'), { recursive: true });
    // Refute wf_bfcf4714-b6d: copies in subfolders and `Copy of` names go too.
    mkdirSync(join(dir, 'public', 'old'), { recursive: true });
    const copies = ['warehouse (1).json', 'snapshot-old.json', 'macro.json~', 'Copy of warehouse.json', 'old/warehouse.json', 'old/snapshot.json'];
    for (const n of copies) writeFileSync(pubFile(n), '{}');
    writeFileSync(pubFile('logo.svg'), '<svg/>');
    writeFileSync(pubFile('_redirects'), '/* /index.html 200');
    await main();
    for (const n of copies) expect(existsSync(pubFile(n)), n).toBe(false);
    expect(existsSync(pubFile('logo.svg'))).toBe(true);
    expect(existsSync(pubFile('_redirects'))).toBe(true);
    expect(existsSync(pubFile('snapshot.json'))).toBe(true);
    expect(existsSync(pubFile('macro.json'))).toBe(true);
  });

  it('refute wf_ec2162a9-34f: a REDACTED --warehouse run that refuses still removes the FULL warehouse.json', async () => {
    mkdirSync(join(dir, 'public'), { recursive: true });
    writeFileSync(pubFile('warehouse.json'), '{"full":true}');
    process.env.BAKE_WAREHOUSE = '1';
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    exitThrows();
    await expect(main()).rejects.toThrow('exit 1');
    expect(existsSync(pubFile('warehouse.json'))).toBe(false);
  });

  it('finding 30: the stale file is removed even when the REDACTED bake then refuses', async () => {
    mkdirSync(join(dir, 'public'), { recursive: true });
    writeFileSync(pubFile('warehouse.json'), '{"full":true}');
    process.env.CONFIDENTIAL_TERMS_PATH = join(dir, 'missing.json');
    exitThrows();
    await expect(main()).rejects.toThrow('exit 1');
    expect(existsSync(pubFile('warehouse.json'))).toBe(false);
  });
});
