// @vitest-environment node
//
// tests/unit/acq-score-engine-rerun.test.ts
//
// Audit 2026-10-13 Wave 2a X3:
//   1. The freshness check re-runs the engine on each latest score's stored input. That re-run is
//      memoized on the per-request LiveScoringRegime, so the engine runs at most once per distinct
//      stored input per allocate / intel call (and the re-score sweep does not re-run it again to
//      verify what it just wrote). Counted by wrapping the real scoreAcquisition.
//   2. capital-allocation.ts rewrites engine cap reasons for BUY display by EXACT engine string
//      (OPEN_ITEM_DISPLAY). An engine wording change would silently orphan the mapping; this pins
//      every key to a string the real engine emits.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WarehouseDb } from '../../server/warehouse/db';
import type * as AcquisitionModule from '../../server/warehouse/acquisition';

const engineCalls = vi.hoisted(() => ({ n: 0 }));
vi.mock('../../server/warehouse/acquisition', async (importOriginal) => {
  const actual = await importOriginal<typeof AcquisitionModule>();
  return {
    ...actual,
    scoreAcquisition: (...args: Parameters<typeof actual.scoreAcquisition>) => {
      engineCalls.n++;
      return actual.scoreAcquisition(...args);
    },
  };
});
vi.mock('../../server/macro/getMacro', () => ({ getMacro: vi.fn() }));
vi.mock('../../server/warehouse/scores', () => ({ scoreProperties: vi.fn() }));
vi.mock('../../server/warehouse/debt-scoring', async () => {
  const { readDebtBookTrust } = await import('../../server/warehouse/debt-trust');
  return {
    scoreDebtPositions: vi.fn(() => []),
    scoreDebtPositionsWithTrust: vi.fn((db: unknown) => ({ scores: [], bookTrust: readDebtBookTrust(db as WarehouseDb) })),
  };
});
import type * as MetricsModule from '../../server/warehouse/metrics';
vi.mock('../../server/warehouse/metrics', async (importOriginal) => {
  const actual = await importOriginal<typeof MetricsModule>();
  return { ...actual, propertyPeriodMetrics: vi.fn(() => []) };
});

import { openWarehouse } from '../../server/warehouse/db';
import { getMacro } from '../../server/macro/getMacro';
import { scoreProperties } from '../../server/warehouse/scores';
import { persistAndLogScore } from '../../server/warehouse/acq-engine';
import { parseRuleset, loadRatifiedRct, scoreAcquisition } from '../../server/warehouse/acquisition';
import { classifyLatestScore, liveScoringRegime, rescoreStaleCandidates } from '../../server/warehouse/acq-score-freshness';
import { capReasonLine } from '../../server/warehouse/acq-score-compare';
import { buildPortfolioAllocation, OPEN_ITEM_DISPLAY } from '../../server/warehouse/capital-allocation';
import { warehouseRoutes } from '../../server/warehouse/api';
import { AcquisitionInput } from '../../src/contracts/acquisition';

const RULESET = parseRuleset(JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')));
const RCT = loadRatifiedRct();

const STRONG_RAW: Record<string, unknown> = {
  dealId: 'rerun-strong',
  price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6,
  multiStory: false, truckCourtFt: 120,
  constructionType: 'block-tilt-brick', yearBuilt: 2005, sfhaOnPad: false,
  allInBasis: 3_600_000, stabilizedYoc: 0.12, leveredIrr: 0.18, underwriteHorizonYrs: 5,
  clusterTier: 'owned-submarket', sellerMotivationScore: 0.8,
  isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5, valueAddScore: 0.5,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
};
const input = (o: Record<string, unknown> = {}) => AcquisitionInput.parse({ ...STRONG_RAW, ...o });

const opened: Array<{ db: WarehouseDb; dir: string }> = [];
function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'acq-rerun-'));
  const db = openWarehouse(join(dir, 'test.sqlite'));
  opened.push({ db, dir });
  return db;
}
afterEach(() => {
  for (const { db, dir } of opened.splice(0)) {
    try { db.close(); } catch { /* already closed */ }
    rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  }
});

async function seed(db: WarehouseDb, id: string, o: Record<string, unknown> = { dealId: id }): Promise<void> {
  db.prepare(`INSERT INTO acq_candidates (id, source, market, status) VALUES (?, 'manual', 'owned-submarket', 'active')`).run(id);
  await persistAndLogScore(db, id, input(o), RULESET, RCT);
}

beforeEach(() => {
  vi.mocked(getMacro).mockResolvedValue(null as never);
  vi.mocked(scoreProperties).mockReturnValue([]);
});

describe('X3 — engine re-run is memoized per request', () => {
  it('classifying the same row twice under one regime runs the engine once', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    const live = liveScoringRegime(db, RULESET, RCT);
    engineCalls.n = 0;
    expect(classifyLatestScore(db, 'c1', live).state).toBe('current');
    expect(classifyLatestScore(db, 'c1', live).state).toBe('current');
    expect(engineCalls.n).toBe(1);
    expect(live.stats.engineRuns).toBe(1);
  });

  it('buildPortfolioAllocation runs the engine once per scored candidate (distinct inputs)', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    await seed(db, 'c2');
    await seed(db, 'c3');
    engineCalls.n = 0;
    await buildPortfolioAllocation(db, '2026-10-13');
    expect(engineCalls.n).toBe(3);
  });

  it('candidates sharing an identical stored input share one engine run', async () => {
    const db = freshDb();
    await seed(db, 'c1', { dealId: 'shared' });
    await seed(db, 'c2', { dealId: 'shared' });
    engineCalls.n = 0;
    await buildPortfolioAllocation(db, '2026-10-13');
    expect(engineCalls.n).toBe(1);
  });

  it('GET /acq/intel runs the engine once per scored candidate', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    await seed(db, 'c2');
    const app = warehouseRoutes(() => db);
    engineCalls.n = 0;
    const res = await app.request('/acq/intel');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rankedCandidates: Array<{ scoreState: string }> };
    expect(body.rankedCandidates.map((r) => r.scoreState)).toEqual(['current', 'current']);
    expect(engineCalls.n).toBe(2);
  });

  it('the re-score sweep verifies its own write without a further engine run', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    db.prepare(`UPDATE acq_scores SET composite = composite - 2.5, score_json = json_set(score_json, '$.composite', json_extract(score_json, '$.composite') - 2.5)`).run();
    engineCalls.n = 0;
    const r = await rescoreStaleCandidates(db, RULESET, RCT);
    expect(r.rescored).toBe(1);
    // 1 for the stale classification + 1 inside persistAndLogScore; the post-write check is a cache hit.
    expect(engineCalls.n).toBe(2);
  });
});

describe('X3 — BUY open-item display keys are pinned to real engine strings', () => {
  it('every OPEN_ITEM_DISPLAY key is a cap-reason item the engine actually emits', () => {
    // clusterTier unknown leaves a Stage-0 gate input unconfirmed (acquisition.ts gateIndeterminate).
    const s = scoreAcquisition(input({ clusterTier: null }), RULESET, { rct: RCT });
    const line = capReasonLine(s);
    expect(line).not.toBeNull();
    const items = line!.replace(/^(?:Capped T1 → T2|Notes): /, '').replace(/\.$/, '').split('; ');
    const keys = Object.keys(OPEN_ITEM_DISPLAY);
    expect(keys.length).toBeGreaterThan(0);
    for (const k of keys) expect(items).toContain(k);
  });
});
