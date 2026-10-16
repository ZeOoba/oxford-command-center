// Refute round 6, G5: nothing pinned that scripts/bake-mirror.ts main() actually CALLS
// rosterScrubSnapshot: deleting that call left every test green, because the unit tests exercise
// the function directly. This runs main() itself end to end (workbook parse, macro and the
// reconciliation reader mocked; cwd is a temp dir, so public/ is written there, never in the repo) against
// a synthetic roster, and asserts a hyphen variant of a roster term planted in a task (which the
// name-based redactConfidential cannot see) never reaches the written public/snapshot.json, and that
// an unreadable roster refuses the bake with nothing written. Synthetic names only.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
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

import { main } from '../../scripts/bake-mirror';

const ENV_KEYS = ['CONFIDENTIAL_TERMS_PATH', 'CONFIDENTIAL_TERMS_ALLOW_PLACEHOLDER', 'MIRROR_INCLUDE_CONFIDENTIAL', 'BRIEF_ENABLED', 'BAKE_WAREHOUSE', 'WAREHOUSE_DB'] as const;
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
