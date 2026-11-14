// @vitest-environment node
//
// tests/unit/capital-allocation-real-loader.test.ts
//
// The portfolio BUY gate (buildPortfolioAllocation -> loadPipelineCandidates) with the REAL, UNSEAMED RCT loader.
// tests/setup.ts redirects the production no-argument loadRatifiedRct() to the synthetic stand-in, so the rest of the
// suite never exercises the gate's fail-closed branch with the loader production runs. Here the acquisition module is
// re-registered as the ACTUAL module (no syntheticRctLoader), like acq-score-route's 'real-unseamed' mode. The default
// path config/replacement-cost.v3.json holds the seeded synthetic stand-in in tests and CI, which the production
// loader must refuse (synthetic marker; the pin is checked after it), so the live regime is unavailable and no
// candidate, however strong, may BUY. A candidate that IS buyable under a working regime is seeded so the test is
// discriminating: the control below proves it BUYs when the regime loads.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MockInstance } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { persistAndLogScore } from '../../server/warehouse/acq-engine';
import { parseRuleset } from '../../server/warehouse/acquisition';
import type * as AcquisitionModule from '../../server/warehouse/acquisition';
import type * as MetricsModule from '../../server/warehouse/metrics';
import { AcquisitionInput } from '../../src/contracts/acquisition';
import type { AcquisitionRuleset, ReplacementCostTable } from '../../src/contracts/acquisition';
import { loadTestRct } from '../support/rct';

// Self-contained factories (no beforeEach mockResolvedValue): vi.resetModules re-runs them, so a handle captured at
// the top of the file would point at a stale mock instance.
vi.mock('../../server/macro/getMacro', () => ({ getMacro: vi.fn(async () => null) }));
vi.mock('../../server/warehouse/scores', () => ({ scoreProperties: vi.fn(() => []) }));
vi.mock('../../server/warehouse/debt-scoring', async () => {
  const { readDebtBookTrust } = await import('../../server/warehouse/debt-trust');
  return {
    scoreDebtPositions: vi.fn(() => []),
    scoreDebtPositionsWithTrust: vi.fn((db: unknown) => ({ scores: [], bookTrust: readDebtBookTrust(db as WarehouseDb) })),
  };
});
vi.mock('../../server/warehouse/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof MetricsModule>();
  return { ...actual, propertyPeriodMetrics: vi.fn(() => []) };
});

const ACQ_MODULE = '../../server/warehouse/acquisition';

const RULESET: AcquisitionRuleset = parseRuleset(
  JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')),
);
const RCT: ReplacementCostTable = loadTestRct();

/** The strong, governor-clearing T1 PURSUE deal of capital-allocation.buy-gate.test.ts (copied, not imported). */
const STRONG_RAW: Record<string, unknown> = {
  dealId: 'real-loader-strong',
  price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6,
  multiStory: false, truckCourtFt: 120,
  constructionType: 'tilt-precast', yearBuilt: 2005, sfhaOnPad: false,
  groundLeased: false, envRemediationPctOfPrice: 0, use: { automotive: false, childRelated: false, childSafetyReviewed: false },
  allInBasis: 4_472_480, stabilizedYoc: 0.12, leveredIrr: 0.18, unleveredIrr10yr: 0.12, underwriteHorizonYrs: 5,
  clusterTier: 'owned-submarket', sellerMotivationScore: 0.8,
  isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5, valueAddScore: 0.5,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
};

const CANDIDATE = 'cand-real-loader';
const REGIME_WARNING = '[capital-allocation] live acquisition regime unavailable';

let tmpDir: string | null = null;
let db: WarehouseDb | null = null;
let warnSpy: MockInstance<typeof console.warn> | null = null;

/** mkdtemp warehouse with one active candidate whose REAL score (production funnel) is buyable under a live regime. */
async function seededDb(): Promise<WarehouseDb> {
  tmpDir = mkdtempSync(join(tmpdir(), 'cap-alloc-real-loader-'));
  db = openWarehouse(join(tmpDir, 'test.sqlite'));
  db.prepare(`INSERT INTO acq_candidates (id, source, market, status) VALUES (?, 'manual', 'owned-submarket', 'active')`).run(CANDIDATE);
  await persistAndLogScore(db, CANDIDATE, AcquisitionInput.parse({ ...STRONG_RAW, dealId: CANDIDATE }), RULESET, RCT);
  return db;
}

/** A FRESH capital-allocation module whose acquisition import is the given registration. */
async function allocate(target: WarehouseDb, mode: 'real-unseamed' | 'seamed') {
  vi.resetModules();
  if (mode === 'real-unseamed') {
    // The ACTUAL module: capital-allocation's no-argument loadRatifiedRct() reads the default path in the production
    // posture (synthetic refused, pin checked).
    vi.doMock(ACQ_MODULE, async () => vi.importActual<typeof AcquisitionModule>(ACQ_MODULE));
  } else {
    // Control: the suite-wide seam re-applied (afterEach's doUnmock drops it), so the regime loads on the stand-in.
    vi.doMock(ACQ_MODULE, async () => {
      const actual = await vi.importActual<typeof AcquisitionModule>(ACQ_MODULE);
      const { syntheticRctLoader } = await import('../support/rct-loader');
      return { ...actual, loadRatifiedRct: syntheticRctLoader(actual.loadRatifiedRct) };
    });
  }
  const { buildPortfolioAllocation } = await import('../../server/warehouse/capital-allocation');
  const result = await buildPortfolioAllocation(target, '2026-11-13');
  return { result, buyVerdicts: result.verdicts.filter((v) => v.action === 'buy') };
}

const regimeWarnings = (): unknown[][] =>
  (warnSpy?.mock.calls ?? []).filter((args) => typeof args[0] === 'string' && args[0].startsWith(REGIME_WARNING));

beforeEach(() => {
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  warnSpy?.mockRestore();
  warnSpy = null;
  db?.close();
  db = null;
  if (tmpDir !== null) rmSync(tmpDir, { recursive: true, force: true });
  tmpDir = null;
  vi.doUnmock(ACQ_MODULE);
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe('BUY gate with the REAL (unseamed) RCT loader — fail closed', () => {
  it('control: with the regime live (seamed stand-in), the seeded candidate IS buyable', async () => {
    const { result, buyVerdicts } = await allocate(await seededDb(), 'seamed');
    expect(buyVerdicts.map((v) => v.propertyId)).toEqual([`pipeline:${CANDIDATE}`]);
    expect(result.buyGate?.regimeUnavailable).toBe(false);
    expect(regimeWarnings()).toHaveLength(0);
  });

  async function expectRealLoaderFailsClosed(): Promise<void> {
    const { result, buyVerdicts } = await allocate(await seededDb(), 'real-unseamed');
    expect(buyVerdicts).toHaveLength(0);
    expect(result.buyGate?.regimeUnavailable).toBe(true);
    expect(result.buyGate?.suppressedNote).toMatch(/no candidate can pass the BUY gate/);
    const c = result.pipeline.find((p) => p.candidateId === CANDIDATE);
    expect(c).toBeDefined();
    expect(c!.buyEligible).toBe(false);
    expect(regimeWarnings()).toHaveLength(1);
  }

  it('RCT_PIN_KEY unset: the stand-in at the default path is refused, no BUY, regime unavailable, warning fires', async () => {
    vi.stubEnv('RCT_PIN_KEY', undefined);
    await expectRealLoaderFailsClosed();
  });

  it('RCT_PIN_KEY set (invented 40-char key): still refused, no BUY, regime unavailable, warning fires', async () => {
    vi.stubEnv('RCT_PIN_KEY', 'test-pin-key-capalloc-0123456789abcdefgh');
    await expectRealLoaderFailsClosed();
  });
});
