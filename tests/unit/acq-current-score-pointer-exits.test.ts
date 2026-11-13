// @vitest-environment node
//
// Wave 2a / #464 composition (T3): persistAndLogScore leaves acq_candidates.current_score_id on the
// row for the inputs it was just called with on EVERY exit — 'inserted', 'unchanged' (idempotent
// no-op), 'superseded' (X1 in-place rewrite) and 'reinstated'. Only 'inserted' fires migration 037's
// AFTER INSERT trigger; the other three are UPDATEs or no writes at all, so each test first moves the
// pointer AWAY from the target row and asserts the persist itself puts it back.
//
// Also proves the stamp backfill that #464's dropped insertScore/stampMissingRegime block performed is
// covered by reconcileExistingScore (governed values, same WHERE guard), with the pointer set.
//
// In-memory only: better-sqlite3 ':memory:' + runMigrations from source.
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WarehouseDb } from '../../server/warehouse/db';
import { runMigrations } from '../../server/warehouse/migrate';
import { governorFingerprint, loadGovernors, persistAndLogScore } from '../../server/warehouse/acq-engine';
import { parseRuleset } from '../../server/warehouse/acquisition';
import { AcquisitionInput } from '@contracts/acquisition';
import { loadTestRct } from '../support/rct';

const RULESET = parseRuleset(
  JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')),
);
const RCT = loadTestRct();

const BASE: Record<string, unknown> = {
  dealId: 'c1',
  price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6,
  multiStory: false, truckCourtFt: 120,
  constructionType: 'tilt-precast', yearBuilt: 2005, sfhaOnPad: false,
  allInBasis: 3_600_000,
  leveredIrr: 0.18, unleveredIrr10yr: 0.12, underwriteHorizonYrs: 5,
  clusterTier: 'owned-submarket', sellerMotivationScore: 0.8,
  isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5, valueAddScore: 0.5,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
};
const A = AcquisitionInput.parse({ ...BASE, stabilizedYoc: 0.12 });
const B = AcquisitionInput.parse({ ...BASE, stabilizedYoc: 0.10 });

function migratedDb(): WarehouseDb {
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO acq_candidates (id, source, status) VALUES ('c1', 'manual', 'active')").run();
  return db;
}
const pointer = (db: WarehouseDb) =>
  (db.prepare("SELECT current_score_id AS id, current_scored_at AS at FROM acq_candidates WHERE id = 'c1'").get() as { id: number | null; at: string | null });
const rowIdFor = (db: WarehouseDb, iv: string) =>
  (db.prepare('SELECT id FROM acq_scores WHERE inputs_version = ?').get(iv) as { id: number }).id;
/** Move the pointer to a sentinel the persist must overwrite (NULL is a valid "never scored" state). */
const clobber = (db: WarehouseDb) =>
  db.prepare("UPDATE acq_candidates SET current_score_id = NULL, current_scored_at = '2000-01-01 00:00:00' WHERE id = 'c1'").run();

describe('T3 — current_score_id is set on every persistAndLogScore exit', () => {
  it('inserted: the new row is current', async () => {
    const db = migratedDb();
    const r = await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    expect(r.persisted).toBe('inserted');
    expect(pointer(db).id).toBe(rowIdFor(db, r.score.inputsVersion));
  });

  it('unchanged (idempotent no-op): the pointer is restored and current_scored_at re-asserted, no new row', async () => {
    const db = migratedDb();
    const r1 = await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    clobber(db);
    const before = db.prepare('SELECT COUNT(*) AS n FROM acq_scores').get();
    const r2 = await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    // The row is newest by scored_at but was not current, so the persist re-points (reported as
    // 'reinstated'). A second call with the pointer already in place is the true no-op.
    expect(r2.persisted).toBe('reinstated');
    const r3 = await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    expect(r3.persisted).toBe('unchanged');
    expect(db.prepare('SELECT COUNT(*) AS n FROM acq_scores').get()).toEqual(before);
    expect(pointer(db).id).toBe(rowIdFor(db, r1.score.inputsVersion));
    expect(pointer(db).at! > '2000-01-01 00:00:00').toBe(true);
  });

  it('unchanged with the pointer already right still re-asserts current_scored_at (#464 "last re-asserted")', async () => {
    const db = migratedDb();
    const r1 = await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    db.prepare("UPDATE acq_candidates SET current_scored_at = '2000-01-01 00:00:00' WHERE id = 'c1'").run();
    expect((await persistAndLogScore(db, 'c1', A, RULESET, RCT)).persisted).toBe('unchanged');
    expect(pointer(db).id).toBe(rowIdFor(db, r1.score.inputsVersion));
    expect(pointer(db).at! > '2000-01-01 00:00:00').toBe(true);
  });

  it('superseded in place: an UPDATE fires no trigger, the persist itself re-points', async () => {
    const db = migratedDb();
    const r1 = await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    const id = rowIdFor(db, r1.score.inputsVersion);
    db.prepare('UPDATE acq_scores SET composite = composite - 2.5 WHERE id = ?').run(id);
    clobber(db);
    const r2 = await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    expect(r2.persisted).toBe('superseded');
    expect(rowIdFor(db, r2.score.inputsVersion)).toBe(id); // same row, rewritten
    expect(pointer(db).id).toBe(id);
    expect(pointer(db).at! > '2000-01-01 00:00:00').toBe(true);
  });

  it('reinstated (A -> B -> A): the pointer moves back to A\'s existing row', async () => {
    const db = migratedDb();
    const rA = await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    const rB = await persistAndLogScore(db, 'c1', B, RULESET, RCT);
    expect(pointer(db).id).toBe(rowIdFor(db, rB.score.inputsVersion));
    const r3 = await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    expect(r3.persisted).toBe('reinstated');
    expect(pointer(db).id).toBe(rowIdFor(db, rA.score.inputsVersion));
    expect(db.prepare('SELECT COUNT(*) AS n FROM acq_scores').get()).toEqual({ n: 2 });
  });

  it('the pointer row is also the newest by scored_at after every exit (the two orders never disagree for persisted scores)', async () => {
    const db = migratedDb();
    const newest = () => (db.prepare("SELECT id FROM acq_scores WHERE candidate_id = 'c1' ORDER BY scored_at DESC, id DESC LIMIT 1").get() as { id: number }).id;
    for (const input of [A, B, A, A, B, A]) {
      await persistAndLogScore(db, 'c1', input, RULESET, RCT);
      expect(pointer(db).id).toBe(newest());
    }
  });
});

describe('T3c — the pointer is scoped to its own candidate (multi-candidate, interleaved)', () => {
  // Refute wf_5f8797d8-88c: an un-scoped assignment (newest acq_scores row in the table) survived every
  // single-candidate test. Interleave two candidates so a cross-candidate pointer is visible.
  it('c1 and c2 keep pointers to their OWN rows through insert / unchanged / supersede-free / reinstate', async () => {
    const db = migratedDb();
    db.prepare("INSERT INTO acq_candidates (id, source, status) VALUES ('c2', 'manual', 'active')").run();
    const ptr = (id: string) =>
      db.prepare(`SELECT c.current_score_id AS sid, s.candidate_id AS owner, s.inputs_version AS iv
                    FROM acq_candidates c LEFT JOIN acq_scores s ON s.id = c.current_score_id WHERE c.id = ?`)
        .get(id) as { sid: number | null; owner: string | null; iv: string | null };
    const A2 = AcquisitionInput.parse({ ...BASE, dealId: 'c2', stabilizedYoc: 0.12 });

    const a1 = await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    const a2 = await persistAndLogScore(db, 'c2', A2, RULESET, RCT);
    expect(ptr('c1')).toMatchObject({ owner: 'c1', iv: a1.score.inputsVersion });
    expect(ptr('c2')).toMatchObject({ owner: 'c2', iv: a2.score.inputsVersion });
    const c2Before = ptr('c2');

    // c2 holds the newest row in the table; every c1 exit below must still point at a c1 row.
    const again = await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    expect(again.persisted).toBe('unchanged');
    expect(ptr('c1')).toMatchObject({ owner: 'c1', iv: a1.score.inputsVersion });

    const b1 = await persistAndLogScore(db, 'c1', B, RULESET, RCT);
    expect(b1.persisted).toBe('inserted');
    expect(ptr('c1')).toMatchObject({ owner: 'c1', iv: b1.score.inputsVersion });

    const back = await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    expect(back.persisted).toBe('reinstated');
    expect(ptr('c1')).toMatchObject({ owner: 'c1', iv: a1.score.inputsVersion });

    expect(ptr('c2')).toEqual(c2Before);
  });
});

describe('T3b — #464\'s dropped stampMissingRegime is covered by reconcileExistingScore', () => {
  it('a legacy row with NO governorRegime stamp and a matching (governed) output is stamped on re-score, and is current', async () => {
    const db = migratedDb();
    const r1 = await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    const id = rowIdFor(db, r1.score.inputsVersion);
    db.prepare("UPDATE acq_scores SET score_json = json_remove(score_json, '$.governorRegime') WHERE id = ?").run(id);
    clobber(db);
    await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    const stamp = (db.prepare("SELECT json_extract(score_json, '$.governorRegime') AS g FROM acq_scores WHERE id = ?").get(id) as { g: string | null }).g;
    expect(stamp).toBe(governorFingerprint(loadGovernors(db)));
    expect(pointer(db).id).toBe(id);
  });

  it('an EXISTING (older) stamp is never overwritten on the no-op path (BUY stays withheld until re-keyed)', async () => {
    const db = migratedDb();
    const r1 = await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    const id = rowIdFor(db, r1.score.inputsVersion);
    db.prepare("UPDATE acq_scores SET score_json = json_set(score_json, '$.governorRegime', 'older-regime') WHERE id = ?").run(id);
    expect((await persistAndLogScore(db, 'c1', A, RULESET, RCT)).persisted).toBe('unchanged');
    const stamp = (db.prepare("SELECT json_extract(score_json, '$.governorRegime') AS g FROM acq_scores WHERE id = ?").get(id) as { g: string | null }).g;
    expect(stamp).toBe('older-regime');
    expect(pointer(db).id).toBe(id);
  });
});
