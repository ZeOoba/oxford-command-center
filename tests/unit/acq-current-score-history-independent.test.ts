// @vitest-environment node
//
// Regression: the "current" acq score must be history-independent.
// Refute wf_f5f45202-de8 (PR #456): persistAndLogScore dedups on inputs_version, so A→B→A writes no
// new row and a latest-by-scored_at reader kept returning B while the engine returned A to the caller.
// The same final inputs must give the same pipeline tier whether the history is [A] or [A,B,A].
import Database from 'better-sqlite3';
import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { warehouseRoutes } from '../../server/warehouse/api';
import { buildBrainReport } from '../../server/warehouse/brain-report';
import { resolveManualOutcome } from '../../server/warehouse/calibration';
import { persistAndLogScore, logAcqOutcome } from '../../server/warehouse/acq-engine';
import { buildPortfolioAllocation } from '../../server/warehouse/capital-allocation';
import { parseRuleset, loadRatifiedRct } from '../../server/warehouse/acquisition';
import { AcquisitionInput } from '@contracts/acquisition';

const RULESET = parseRuleset(
  JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')),
);
const RCT = loadRatifiedRct();

const BASE: Record<string, unknown> = {
  dealId: 'c1',
  price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6,
  multiStory: false, truckCourtFt: 120,
  constructionType: 'block-tilt-brick', yearBuilt: 2005, sfhaOnPad: false,
  allInBasis: 3_600_000,
  leveredIrr: 0.18, underwriteHorizonYrs: 5,
  clusterTier: 'owned-submarket', sellerMotivationScore: 0.8,
  isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5, valueAddScore: 0.5,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
};
const A = AcquisitionInput.parse({ ...BASE, stabilizedYoc: 0.03 }); // DSCR proxy fails → demoted
const B = AcquisitionInput.parse({ ...BASE, stabilizedYoc: 0.12 }); // clears

function freshDb(): WarehouseDb {
  const db = openWarehouse(join(mkdtempSync(join(tmpdir(), 'acq-current-')), 't.sqlite'));
  db.prepare("INSERT INTO acq_candidates (id, source, status) VALUES ('c1', 'manual', 'active')").run();
  return db;
}

async function pipelineTier(db: WarehouseDb, history: AcquisitionInput[]): Promise<string | null> {
  for (const input of history) persistAndLogScore(db, 'c1', input, RULESET, RCT);
  const alloc = await buildPortfolioAllocation(db, '2026-10-01');
  return alloc.pipeline.find((p) => p.candidateId === 'c1')?.tier ?? null;
}

describe('current acq score is history-independent', () => {
  it('capital-allocation pipeline tier for final inputs A is identical for [A] and [A,B,A]', async () => {
    const direct = await pipelineTier(freshDb(), [A]);
    const roundTrip = await pipelineTier(freshDb(), [A, B, A]);
    expect(roundTrip).toBe(direct);
  });

  it('current_score_id follows the inputs most recently scored, incl. the idempotent no-op path', () => {
    const db = freshDb();
    const pointer = () =>
      (db.prepare("SELECT current_score_id AS id FROM acq_candidates WHERE id = 'c1'").get() as { id: number | null }).id;
    expect(pointer()).toBeNull(); // never scored
    persistAndLogScore(db, 'c1', A, RULESET, RCT);
    const idA = pointer();
    persistAndLogScore(db, 'c1', B, RULESET, RCT);
    const idB = pointer();
    expect(idB).not.toBe(idA);
    persistAndLogScore(db, 'c1', A, RULESET, RCT); // no new acq_scores row
    expect(pointer()).toBe(idA);
    expect((db.prepare('SELECT COUNT(*) AS n FROM acq_scores').get() as { n: number }).n).toBe(2);
  });

  it('GET /acq/intel after A->B->A returns A (the engine verdict), not B', async () => {
    const db = freshDb();
    const verdicts: string[] = [];
    for (const i of [A, B, A]) verdicts.push((await persistAndLogScore(db, 'c1', i, RULESET, RCT)).score.verdict);
    expect(verdicts[0]).not.toBe(verdicts[1]); // A and B must differ or this proves nothing
    const res = await warehouseRoutes(() => db).request('/acq/intel?status=active');
    const body = (await res.json()) as { rankedCandidates: Array<{ latestScore: { verdict: string } | null }> };
    expect(body.rankedCandidates[0]!.latestScore!.verdict).toBe(verdicts[2]);
  });

  it('brain-report floor-indeterminate follows the pointer, not the newest row', () => {
    const db = freshDb();
    db.prepare("UPDATE acq_candidates SET address = '1 Pointer Rd' WHERE id = 'c1'").run();
    const ids: number[] = [];
    for (const [iv, fi] of [['iv-older', 1], ['iv-newer', 0]] as const) {
      db.prepare("INSERT INTO acq_score_inputs (candidate_id, inputs_version, input_json) VALUES ('c1', ?, '{}')").run(iv);
      const si = (db.prepare('SELECT id FROM acq_score_inputs WHERE inputs_version = ?').get(iv) as { id: number }).id;
      db.prepare(
        `INSERT INTO acq_scores (candidate_id, score_input_id, inputs_version, composite, tier, verdict, floor_indeterminate, score_json)
         VALUES ('c1', ?, ?, 50, 'T2', 'WATCH', ?, '{}')`,
      ).run(si, iv, fi);
      ids.push((db.prepare('SELECT id FROM acq_scores WHERE score_input_id = ?').get(si) as { id: number }).id);
    }
    const listed = () =>
      buildBrainReport(db, '2026-07-06T00:00:00Z').openQuestions.some(
        (q) => q.kind === 'floor-indeterminate' && q.title.includes('1 Pointer Rd'),
      );
    db.prepare("UPDATE acq_candidates SET current_score_id = ? WHERE id = 'c1'").run(ids[0]);
    expect(listed()).toBe(true); // current = the floor-indeterminate row although a newer row exists
    db.prepare("UPDATE acq_candidates SET current_score_id = ? WHERE id = 'c1'").run(ids[1]);
    expect(listed()).toBe(false);
  });

  it("logAcqOutcome after A->B->A resolves against A's verdict, identical to history [A]", async () => {
    const outcome = async (history: AcquisitionInput[]) => {
      const db = freshDb();
      for (const i of history) await persistAndLogScore(db, 'c1', i, RULESET, RCT);
      logAcqOutcome(db, 'c1', 'acquired');
      return db
        .prepare(
          `SELECT o.hit AS hit, v.predicted_band AS band FROM calibration_outcome o
           JOIN calibration_verdict v ON v.id = o.calibration_id WHERE o.is_resolution = 1`,
        )
        .get() as { hit: number; band: string };
    };
    const direct = await outcome([A]);
    const roundTrip = await outcome([A, B, A]);
    expect(roundTrip).toEqual(direct);
    expect(roundTrip.hit).toBe(0); // acquired a demoted/KILLED deal = miss
  });

  it('a deal gets ONE blessed lifecycle outcome even when the pointer moves back to earlier inputs (refute wf_ba4886b3-1a9)', async () => {
    const blessed = (db: WarehouseDb) =>
      db.prepare("SELECT COUNT(*) AS n FROM calibration_outcome WHERE is_resolution = 1").get() as { n: number };
    const score = async (db: WarehouseDb, i: AcquisitionInput) => {
      await persistAndLogScore(db, 'c1', i, RULESET, RCT);
    };

    // Reversal: A, B, acquired (on B), A again, passed -> still exactly one row.
    const rev = freshDb();
    await score(rev, A);
    await score(rev, B);
    logAcqOutcome(rev, 'c1', 'acquired');
    await score(rev, A);
    logAcqOutcome(rev, 'c1', 'passed');
    expect(blessed(rev).n).toBe(1);

    // Repeat with no reversal: A, B, A, acquired (on A), B again, acquired -> still one row.
    const rep = freshDb();
    await score(rep, A);
    await score(rep, B);
    await score(rep, A);
    logAcqOutcome(rep, 'c1', 'acquired');
    await score(rep, B);
    logAcqOutcome(rep, 'c1', 'acquired');
    expect(blessed(rep).n).toBe(1);
  });

  it('a manual resolution is authoritative: neither a correction of the lifecycle row nor a manual row on the older verdict lets a status PATCH bless a second outcome (wf_96d87140-319)', async () => {
    const blessed = (db: WarehouseDb) =>
      (db.prepare('SELECT COUNT(*) AS n FROM calibration_outcome WHERE is_resolution = 1').get() as { n: number }).n;
    const verdictOf = (db: WarehouseDb, iv: string) =>
      (db.prepare("SELECT id FROM calibration_verdict WHERE inputs_version = ? AND verdict_kind = 'acquisition-score'")
        .get(iv) as { id: number }).id;
    // inputs_version of the candidate's CURRENT score (call right after scoring the inputs you want).
    const currentIv = (db: WarehouseDb) =>
      (db.prepare(
        "SELECT s.inputs_version AS iv FROM acq_candidates c JOIN acq_scores s ON s.id = c.current_score_id WHERE c.id = 'c1'",
      ).get() as { iv: string }).iv;
    const nextYear = String(new Date().getFullYear() + 1);

    // S1: A, B, acquired (lifecycle on B), analyst corrects B, A re-scored, passed -> one blessed row.
    const s1 = freshDb();
    await persistAndLogScore(s1, 'c1', A, RULESET, RCT);
    await persistAndLogScore(s1, 'c1', B, RULESET, RCT);
    const vB = verdictOf(s1, currentIv(s1)); // pointer is on B here
    logAcqOutcome(s1, 'c1', 'acquired');
    const r = resolveManualOutcome(s1, { calibrationId: vB, realizedBand: 'passed', hit: 0, outcomePeriod: nextYear });
    expect(r.ok).toBe(true);
    await persistAndLogScore(s1, 'c1', A, RULESET, RCT);
    logAcqOutcome(s1, 'c1', 'passed');
    expect(blessed(s1)).toBe(1);

    // S2: manual ruling on B first, pointer back on A, acquired -> still one blessed row (the manual one).
    const s2 = freshDb();
    await persistAndLogScore(s2, 'c1', A, RULESET, RCT);
    await persistAndLogScore(s2, 'c1', B, RULESET, RCT);
    const rm = resolveManualOutcome(s2, {
      calibrationId: verdictOf(s2, currentIv(s2)), realizedBand: 'passed', hit: 0, outcomePeriod: nextYear,
    });
    expect(rm.ok).toBe(true);
    await persistAndLogScore(s2, 'c1', A, RULESET, RCT);
    logAcqOutcome(s2, 'c1', 'acquired');
    expect(blessed(s2)).toBe(1);
  });

  it('rolling deploy: a raw acq_scores insert (pre-036 code path) makes that row current, not a stale old pointer', async () => {
    const db = freshDb();
    await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    const row = (iv: string) =>
      db.prepare(
        `INSERT INTO acq_score_inputs (candidate_id, inputs_version, input_json) VALUES ('c1', ?, '{}')`,
      ).run(iv);
    row('iv-legacy');
    const si = (db.prepare("SELECT id FROM acq_score_inputs WHERE inputs_version = 'iv-legacy'").get() as { id: number }).id;
    // Exactly what old code does: insert the score row and never touch acq_candidates.
    db.prepare(
      `INSERT INTO acq_scores (candidate_id, score_input_id, inputs_version, composite, tier, verdict, score_json)
       VALUES ('c1', ?, 'iv-legacy', 1, 'T2', 'WATCH', '{}')`,
    ).run(si);
    const cur = db
      .prepare("SELECT s.inputs_version AS iv FROM acq_candidates c JOIN acq_scores s ON s.id = c.current_score_id WHERE c.id = 'c1'")
      .get() as { iv: string };
    expect(cur.iv).toBe('iv-legacy');
  });

  it('current_scored_at moves on EVERY scoring call, incl. the no-op re-score; /acq/intel scoredAt follows it', async () => {
    const db = freshDb();
    const stamp = () =>
      (db.prepare("SELECT current_scored_at AS t FROM acq_candidates WHERE id = 'c1'").get() as { t: string | null }).t;
    await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    await persistAndLogScore(db, 'c1', B, RULESET, RCT);
    db.prepare("UPDATE acq_candidates SET current_scored_at = '2000-01-01 00:00:00' WHERE id = 'c1'").run();
    await persistAndLogScore(db, 'c1', A, RULESET, RCT); // no new acq_scores row
    expect(stamp()! > '2000-01-01 00:00:00').toBe(true);
    const firstScored = (db.prepare('SELECT MIN(scored_at) AS t FROM acq_scores').get() as { t: string }).t;
    db.prepare("UPDATE acq_candidates SET current_scored_at = '2099-01-01 00:00:00' WHERE id = 'c1'").run();
    const res = await warehouseRoutes(() => db).request('/acq/intel?status=active');
    const body = (await res.json()) as { rankedCandidates: Array<{ scoredAt: string | null }> };
    expect(body.rankedCandidates[0]!.scoredAt).toBe('2099-01-01 00:00:00'); // not acq_scores.scored_at
    expect(firstScored).not.toBe('2099-01-01 00:00:00');
  });

  it('migration 036 backfills current_score_id from the latest (scored_at, id) row; unscored stays NULL', () => {
    const dir = resolve(process.cwd(), 'server/warehouse/migrations');
    const files = readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
    const idx = files.indexOf('036_acq_current_score_id.sql');
    expect(idx).toBeGreaterThan(0);
    const db = new Database(':memory:');
    // 031 alters the runner's bookkeeping table, which runMigrations creates first.
    db.exec(
      "CREATE TABLE _migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL DEFAULT (datetime('now')))",
    );
    for (const f of files.slice(0, idx)) db.exec(readFileSync(join(dir, f), 'utf8'));
    db.prepare("INSERT INTO acq_candidates (id, source) VALUES ('x','manual'), ('y','manual'), ('z','manual')").run();
    let n = 0;
    const score = (cand: string, at: string) => {
      n += 1;
      db.prepare("INSERT INTO acq_score_inputs (candidate_id, inputs_version, input_json) VALUES (?, ?, '{}')").run(cand, `iv${n}`);
      const si = (db.prepare('SELECT id FROM acq_score_inputs WHERE inputs_version = ?').get(`iv${n}`) as { id: number }).id;
      db.prepare(
        `INSERT INTO acq_scores (candidate_id, score_input_id, inputs_version, composite, tier, verdict, score_json, scored_at)
         VALUES (?, ?, ?, 1, 'T2', 'WATCH', '{}', ?)`,
      ).run(cand, si, `iv${n}`, at);
      return (db.prepare('SELECT id FROM acq_scores WHERE score_input_id = ?').get(si) as { id: number }).id;
    };
    const xNewer = score('x', '2026-06-02T00:00:00'); // newer scored_at, LOWER id
    score('x', '2026-06-01T00:00:00');
    score('y', '2026-06-01T00:00:00');
    const yTie = score('y', '2026-06-01T00:00:00'); // same second: higher id wins
    db.exec(readFileSync(join(dir, files[idx]!), 'utf8'));
    const cur = (id: string) =>
      (db.prepare('SELECT current_score_id AS v FROM acq_candidates WHERE id = ?').get(id) as { v: number | null }).v;
    expect(cur('x')).toBe(xNewer);
    expect(cur('y')).toBe(yTie);
    expect(cur('z')).toBeNull();
    // 037 lands on a database that has ALREADY applied 036 as pushed (migrations are tracked by filename,
    // so 036 must never be edited after it ships) and adds current_scored_at + the rolling-deploy trigger.
    const idx37 = files.indexOf('037_acq_current_scored_at.sql');
    expect(idx37).toBe(idx + 1);
    db.exec(readFileSync(join(dir, files[idx37]!), 'utf8'));
    const at = (id: string) =>
      (db.prepare('SELECT current_scored_at AS v FROM acq_candidates WHERE id = ?').get(id) as { v: string | null }).v;
    expect(at('x')).toBe('2026-06-02T00:00:00');
    expect(at('z')).toBeNull();
  });
});
