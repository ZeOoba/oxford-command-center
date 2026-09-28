// @vitest-environment node
//
// tests/unit/acq-score-route.test.ts
//
// Characterization tests for POST /api/warehouse/acq/score/:candidateId (server/warehouse/api.ts).
// cc-audit-army 2026-09-28: the route had no test at all. Tests only; no production change.
//
// The module-level acqConfig() cache and the route's dynamic import('./acquisition') mean each case
// needs a FRESH api module: vi.resetModules() + vi.doMock (not the hoisted vi.mock, which would
// apply file-wide and break the happy path). Tmpdir warehouse; never writes under config/.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import type * as AcquisitionModule from '../../server/warehouse/acquisition';

const ACQ_MODULE = '../../server/warehouse/acquisition';

const VALID_INPUT = {
  dealId: 'route-test',
  price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6, multiStory: false, truckCourtFt: 120,
  constructionType: 'block-tilt-brick', yearBuilt: 2005,
  sfhaOnPad: false,
  allInBasis: 1_200_000, stabilizedYoc: 0.12, leveredIrr: 0.18, underwriteHorizonYrs: 5,
  clusterTier: 'owned-submarket',
  sellerMotivationScore: 0.8,
  isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5,
  valueAddScore: 0.5,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
};

function freshDb(): WarehouseDb {
  return openWarehouse(join(mkdtempSync(join(tmpdir(), 'acq-score-route-')), 'test.sqlite'));
}

function seedCandidate(db: WarehouseDb, id = 'manual:route-1'): string {
  db.prepare("INSERT INTO acq_candidates (id, source) VALUES (?, 'manual')").run(id);
  return id;
}

/** Fresh api module (fresh acqConfig cache). mode controls the ./acquisition loaders. */
async function loadApp(
  db: WarehouseDb,
  mode: 'real' | 'ratified-missing-no-fallback' | 'ratified-missing-fallback-present',
) {
  vi.resetModules();
  if (mode !== 'real') {
    vi.doMock(ACQ_MODULE, async () => {
      const actual = await vi.importActual<typeof AcquisitionModule>(ACQ_MODULE);
      const missing = () => { throw new Error('ENOENT: simulated missing ratified config'); };
      return {
        ...actual,
        loadRatifiedRuleset: missing,
        loadRatifiedRct: missing,
        // The route's fallback branch: absent file => throws; present => stand-in for the proposed
        // ruleset (the real ratified one, which is enough to prove a score would be persisted).
        loadRuleset: mode === 'ratified-missing-fallback-present'
          ? () => actual.loadRatifiedRuleset()
          : missing,
        loadReplacementCostTable: () => actual.loadRatifiedRct(),
      };
    });
  }
  const { warehouseRoutes } = await import('../../server/warehouse/api');
  return warehouseRoutes(() => db);
}

async function postScore(app: Awaited<ReturnType<typeof loadApp>>, id: string, body: unknown) {
  return app.request(`/acq/score/${encodeURIComponent(id)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
}

const count = (db: WarehouseDb, table: string): number =>
  (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeEach(() => vi.resetModules());
afterEach(() => { vi.doUnmock(ACQ_MODULE); vi.resetModules(); });

describe('POST /acq/score/:candidateId', () => {
  it('404s an unknown candidate BEFORE parsing the body (an invalid body still 404s)', async () => {
    const db = freshDb();
    const app = await loadApp(db, 'real');
    const res = await postScore(app, 'nope', 'not json at all');
    expect(res.status).toBe(404);
    expect(count(db, 'acq_scores')).toBe(0);
  });

  it('400s an invalid AcquisitionInput for an existing candidate and persists nothing', async () => {
    const db = freshDb();
    const id = seedCandidate(db);
    const app = await loadApp(db, 'real');
    const res = await postScore(app, id, { ...VALID_INPUT, price: 'not-a-number', productType: 'castle' });
    expect(res.status).toBe(400);
    expect(count(db, 'acq_scores')).toBe(0);
    expect(count(db, 'acq_score_inputs')).toBe(0);
  });

  // Characterization, not endorsement: the schema makes almost every field optional/nullable
  // (unknown => the engine fails closed inside scoring), so a near-empty input is VALID, is scored,
  // and is persisted + logged to calibration like any other. Pinned so a change is deliberate.
  it('accepts a near-empty input (only dealId): scored, persisted and logged, not a 400', async () => {
    const db = freshDb();
    const id = seedCandidate(db);
    const app = await loadApp(db, 'real');
    const res = await postScore(app, id, { dealId: 'x' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { score: { verdict: string } };
    expect(['PURSUE', 'WATCH', 'PASS', 'KILLED']).toContain(body.score.verdict);
    expect(body.score.verdict).not.toBe('PURSUE');
    expect(count(db, 'acq_scores')).toBe(1);
  });

  it('400s an unparseable body as an invalid input (empty object fallback)', async () => {
    const db = freshDb();
    const id = seedCandidate(db);
    const app = await loadApp(db, 'real');
    const res = await postScore(app, id, '{ not json');
    expect(res.status).toBe(400);
  });

  it('200 happy path on the RATIFIED config: one non-advisory score, one calibration verdict, ids linked', async () => {
    const db = freshDb();
    const id = seedCandidate(db);
    const app = await loadApp(db, 'real');
    const res = await postScore(app, id, VALID_INPUT);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { score: { advisoryOnly: boolean; verdict: string }; calibrationVerdictId: number | null };
    expect(body.score.advisoryOnly).toBe(false);

    const rows = db.prepare('SELECT advisory_only, verdict, calibration_verdict_id FROM acq_scores WHERE candidate_id = ?').all(id) as Array<{
      advisory_only: number; verdict: string; calibration_verdict_id: number | null;
    }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.advisory_only).toBe(0);
    expect(rows[0]!.verdict).toBe(body.score.verdict);
    expect(count(db, 'calibration_verdict')).toBeGreaterThanOrEqual(1);
    expect(body.calibrationVerdictId).not.toBeNull();
    expect(rows[0]!.calibration_verdict_id).toBe(body.calibrationVerdictId);
  });

  it('is idempotent: re-scoring identical input adds no second score row', async () => {
    const db = freshDb();
    const id = seedCandidate(db);
    const app = await loadApp(db, 'real');
    expect((await postScore(app, id, VALID_INPUT)).status).toBe(200);
    expect((await postScore(app, id, VALID_INPUT)).status).toBe(200);
    expect(count(db, 'acq_scores')).toBe(1);
  });

  it('503s and persists NOTHING when the ratified config cannot load and no fallback file exists', async () => {
    const db = freshDb();
    const id = seedCandidate(db);
    const app = await loadApp(db, 'ratified-missing-no-fallback');
    const res = await postScore(app, id, VALID_INPUT);
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; detail?: string };
    expect(body.error).toBe('acquisition engine unavailable');
    expect(body.detail).toBeUndefined(); // raw errors can carry filesystem paths: logged, never returned
    expect(count(db, 'acq_scores')).toBe(0);
    expect(count(db, 'calibration_verdict')).toBe(0);
  });

  it('500s (scoring failed) when persistence throws, without leaking a partial score row', async () => {
    const db = freshDb();
    const id = seedCandidate(db);
    const app = await loadApp(db, 'real');
    db.exec('DROP TABLE acq_score_inputs'); // force persistAndLogScore to throw
    const res = await postScore(app, id, VALID_INPUT);
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string; detail?: string };
    expect(body.error).toBe('scoring failed');
    expect(body.detail).toBeUndefined();
  });

  // Was the pinned KNOWN DEFECT (cc-audit-army acq-score-proposed-fallback): with the ratified config
  // unavailable the route fell back to a non-ratified ruleset and still persisted the score and logged
  // it to calibration. Now fails closed exactly like /acquisition/score.
  it("503s and persists nothing when the ratified config is unavailable, EVEN IF a fallback ruleset would load", async () => {
    const db = freshDb();
    const id = seedCandidate(db);
    const app = await loadApp(db, 'ratified-missing-fallback-present');
    const res = await postScore(app, id, VALID_INPUT);
    expect(res.status).toBe(503);
    expect(count(db, 'acq_scores')).toBe(0);
    expect(count(db, 'calibration_verdict')).toBe(0);
  });

  it('does NOT cache a config failure: the next request succeeds once the config loads again', async () => {
    const db = freshDb();
    const id = seedCandidate(db);
    vi.resetModules();
    let calls = 0;
    vi.doMock(ACQ_MODULE, async () => {
      const actual = await vi.importActual<typeof AcquisitionModule>(ACQ_MODULE);
      return {
        ...actual,
        loadRatifiedRuleset: () => {
          calls += 1;
          if (calls === 1) throw new Error('EBUSY: transient OneDrive lock');
          return actual.loadRatifiedRuleset();
        },
      };
    });
    const { warehouseRoutes } = await import('../../server/warehouse/api');
    const app = warehouseRoutes(() => db);
    expect((await postScore(app, id, VALID_INPUT)).status).toBe(503);
    expect((await postScore(app, id, VALID_INPUT)).status).toBe(200);
    expect(count(db, 'acq_scores')).toBe(1);
  });
});

describe('POST /acquisition/score (sibling, stateless) — same fail-closed contract', () => {
  it('503s with a generic body (no raw error detail) when the ratified config is unavailable', async () => {
    const db = freshDb();
    const app = await loadApp(db, 'ratified-missing-no-fallback');
    const res = await app.request('/acquisition/score', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(VALID_INPUT),
    });
    expect(res.status).toBe(503);
    const body = (await res.json()) as { error: string; detail?: string };
    expect(body.error).toBe('acquisition engine unavailable');
    expect(body.detail).toBeUndefined();
  });
});
