// @vitest-environment node
//
// Wave 2a / #464 composition: ONE definition of a candidate's CURRENT acquisition score.
//
// The reviewed Wave 2a branch (7cc3f1a2) read "current" as the newest acq_scores row by scored_at;
// main #464 read it through acq_candidates.current_score_id. A merge that mixes the two (or that sets
// the pointer on the insert path only) lets the capital BUY gate, /acq/intel, brain-report and the
// calibration outcome each serve a DIFFERENT row for the same deal. These tests pin that every reader
// picks the SAME acq_scores row id, that it is the row for the inputs scored last, and that the real
// /acq/intel SQL prepares and runs on a fully migrated database (a spliced query typechecks but throws
// at SQLite prepare time).
//
// In-memory only: better-sqlite3 ':memory:' + runMigrations from source. No warehouse file is opened.
import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { WarehouseDb } from '../../server/warehouse/db';
import { runMigrations } from '../../server/warehouse/migrate';
import { warehouseRoutes } from '../../server/warehouse/api';
import { buildBrainReport } from '../../server/warehouse/brain-report';
import { logAcqOutcome, persistAndLogScore } from '../../server/warehouse/acq-engine';
import { buildPortfolioAllocation } from '../../server/warehouse/capital-allocation';
import { CURRENT_SCORE_WITH_INPUTS_SQL, classifyLatestScore } from '../../server/warehouse/acq-score-freshness';
import { loadRatifiedRct, parseRuleset } from '../../server/warehouse/acquisition';
import { AcquisitionInput } from '@contracts/acquisition';

const RULESET = parseRuleset(
  JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')),
);
const RCT = loadRatifiedRct();

// leveredIrr null => the IRR floor is indeterminate, so EVERY row of this candidate is
// floor_indeterminate=1 and brain-report lists whichever row is current (it names the row id).
const BASE: Record<string, unknown> = {
  dealId: 'c1',
  price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6,
  multiStory: false, truckCourtFt: 120,
  constructionType: 'block-tilt-brick', yearBuilt: 2005, sfhaOnPad: false,
  allInBasis: 3_600_000,
  leveredIrr: null, unleveredIrr10yr: null, underwriteHorizonYrs: 5,
  clusterTier: 'owned-submarket', sellerMotivationScore: 0.8,
  isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5, valueAddScore: 0.5,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
};
const A = AcquisitionInput.parse({ ...BASE, stabilizedYoc: 0.07 });
const B = AcquisitionInput.parse({ ...BASE, stabilizedYoc: 0.12 });

function migratedDb(): WarehouseDb {
  const db = new Database(':memory:');
  runMigrations(db);
  db.prepare("INSERT INTO acq_candidates (id, source, status, address) VALUES ('c1', 'manual', 'active', '1 One Definition Way')").run();
  return db;
}

type ScoreRow = { id: number; inputs_version: string; composite: number; tier: string; verdict: string; floor_indeterminate: number };
const rowById = (db: WarehouseDb, id: number) =>
  db.prepare('SELECT id, inputs_version, composite, tier, verdict, floor_indeterminate FROM acq_scores WHERE id = ?').get(id) as ScoreRow;
const pointer = (db: WarehouseDb) =>
  (db.prepare("SELECT current_score_id AS id FROM acq_candidates WHERE id = 'c1'").get() as { id: number | null }).id;

/** The acq_scores id each reader serves for c1. */
async function readersRowIds(db: WarehouseDb): Promise<Record<string, number | null>> {
  const all = db.prepare('SELECT id, inputs_version, composite, tier, verdict FROM acq_scores').all() as ScoreRow[];

  // 1. Capital BUY gate (loadPipelineCandidates, via the public buildPortfolioAllocation). The pipeline
  //    entry carries composite / tier / verdict, which identify the row (preconditions keep them distinct).
  const alloc = await buildPortfolioAllocation(db, '2026-10-01');
  const p = alloc.pipeline.find((e) => e.candidateId === 'c1');
  const pipelineMatches = all.filter((r) => p && r.composite === p.composite && r.tier === p.tier && r.verdict === p.verdict);
  expect(pipelineMatches.length).toBeLessThanOrEqual(1);

  // 2. GET /acq/intel (includeKilled so the row is listed whatever its verdict). latestScore.inputsVersion
  //    is the persisted row's inputs_version (UNIQUE per candidate in acq_score_inputs).
  const res = await warehouseRoutes(() => db).request('/acq/intel?status=active&includeKilled=1');
  expect(res.status).toBe(200);
  const body = (await res.json()) as { rankedCandidates: Array<{ candidate: { id: string }; latestScore: { inputsVersion: string } | null }> };
  const intelIv = body.rankedCandidates.find((r) => r.candidate.id === 'c1')?.latestScore?.inputsVersion ?? null;
  const intelRow = all.find((r) => r.inputs_version === intelIv);

  // 3. brain-report floor-indeterminate question names "Acquisition score <id>".
  const q = buildBrainReport(db, '2026-10-01T00:00:00Z').openQuestions.find(
    (o) => o.kind === 'floor-indeterminate' && o.title.includes('1 One Definition Way'),
  );
  const brainId = q ? Number(/Acquisition score (\d+)/.exec(q.detail)?.[1]) : null;

  // 4. The shared per-candidate reader (classifyLatestScore / the re-score sweep / the BUY gate SQL).
  const shared = db.prepare(CURRENT_SCORE_WITH_INPUTS_SQL).get('c1') as { score_id: number } | undefined;

  return {
    pointer: pointer(db),
    capitalAllocation: pipelineMatches[0]?.id ?? null,
    acqIntel: intelRow?.id ?? null,
    brainReport: brainId,
    sharedReader: shared?.score_id ?? null,
  };
}

const allEqual = (ids: Record<string, number | null>, expected: number) => {
  for (const [reader, id] of Object.entries(ids)) expect({ reader, id }).toEqual({ reader, id: expected });
};

describe('T1 — one definition of the current score across every reader', () => {
  it('A -> B -> A (A reinstated): capital-allocation, /acq/intel, brain-report and the shared reader all serve A\'s row', async () => {
    const db = migratedDb();
    const r1 = await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    const r2 = await persistAndLogScore(db, 'c1', B, RULESET, RCT);
    const r3 = await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    expect([r1.persisted, r2.persisted, r3.persisted]).toEqual(['inserted', 'inserted', 'reinstated']);

    // Preconditions: two rows, distinguishable by (composite, tier, verdict), both floor-indeterminate.
    const rows = db.prepare('SELECT id, inputs_version, composite, tier, verdict, floor_indeterminate FROM acq_scores ORDER BY id').all() as ScoreRow[];
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.floor_indeterminate === 1)).toBe(true);
    expect([rows[0]!.composite, rows[0]!.tier, rows[0]!.verdict]).not.toEqual([rows[1]!.composite, rows[1]!.tier, rows[1]!.verdict]);

    const aRow = rows.find((r) => r.inputs_version === r3.score.inputsVersion)!;
    expect(aRow.inputs_version).toBe(r1.score.inputsVersion);
    allEqual(await readersRowIds(db), aRow.id);
    expect(classifyLatestScore(db, 'c1', null).score?.inputsVersion).toBe(aRow.inputs_version);
  });

  it('A superseded in place (stored output drifted), then B, then A reinstated: every reader serves A\'s rewritten row', async () => {
    const db = migratedDb();
    const r1 = await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    // Simulate a pre-engine-change stored output for A's key; the next persist of A must supersede it.
    db.prepare('UPDATE acq_scores SET composite = composite - 2.5 WHERE inputs_version = ?').run(r1.score.inputsVersion);
    expect((await persistAndLogScore(db, 'c1', A, RULESET, RCT)).persisted).toBe('superseded');
    await persistAndLogScore(db, 'c1', B, RULESET, RCT);
    expect((await persistAndLogScore(db, 'c1', A, RULESET, RCT)).persisted).toBe('reinstated');
    const aId = (db.prepare('SELECT id FROM acq_scores WHERE inputs_version = ?').get(r1.score.inputsVersion) as { id: number }).id;
    expect(rowById(db, aId).composite).toBe(r1.score.composite); // the rewritten (live) output
    allEqual(await readersRowIds(db), aId);
  });

  it('a raw pre-036 insert after A->B->A becomes current (037 trigger) and EVERY reader follows it, even though A is newer by scored_at', async () => {
    const db = migratedDb();
    await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    const rB = await persistAndLogScore(db, 'c1', B, RULESET, RCT);
    await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    db.prepare("INSERT INTO acq_score_inputs (candidate_id, inputs_version, input_json) VALUES ('c1', 'iv-legacy', '{}')").run();
    const si = (db.prepare("SELECT id FROM acq_score_inputs WHERE inputs_version = 'iv-legacy'").get() as { id: number }).id;
    // Old code: insert a row and never touch acq_candidates. Stamped one hour in the past, so a
    // newest-by-scored_at reader would still pick A while the pointer (trigger) is on the legacy row.
    const legacyJson = JSON.stringify({ ...rB.score, inputsVersion: 'iv-legacy', composite: 1 });
    db.prepare(
      `INSERT INTO acq_scores (candidate_id, score_input_id, inputs_version, composite, tier, verdict, floor_indeterminate, score_json, scored_at)
       VALUES ('c1', ?, 'iv-legacy', 1, 'T2', 'WATCH', 1, ?, datetime('now', '-1 hour'))`,
    ).run(si, legacyJson);
    const legacyId = (db.prepare("SELECT id FROM acq_scores WHERE inputs_version = 'iv-legacy'").get() as { id: number }).id;
    const newestByScoredAt = (db.prepare("SELECT id FROM acq_scores WHERE candidate_id = 'c1' ORDER BY scored_at DESC, id DESC LIMIT 1").get() as { id: number }).id;
    expect(newestByScoredAt).not.toBe(legacyId); // the two definitions disagree here — the point of the test
    allEqual(await readersRowIds(db), legacyId);
    // logAcqOutcome reads the same row: the legacy key has no calibration_verdict, so the outcome is
    // skipped as unbound for iv-legacy — never bound to A's verdict (the newest-by-scored_at row).
    logAcqOutcome(db, 'c1', 'passed');
    expect(db.prepare('SELECT COUNT(*) AS n FROM calibration_outcome').get()).toEqual({ n: 0 });
    const unbound = db.prepare("SELECT detail FROM data_quality_issues WHERE kind = 'acq-outcome-unbound'").all() as Array<{ detail: string }>;
    expect(unbound).toHaveLength(1);
    expect(unbound[0]!.detail).toContain('inputs_version=iv-legacy ');

    // Re-scoring A afterwards re-points every reader at A ('reinstated': A was newest by scored_at but
    // not current, so 'unchanged' would hide the change of the served score).
    const again = await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    expect(again.persisted).toBe('reinstated');
    const aId = (db.prepare('SELECT id FROM acq_scores WHERE inputs_version = ?').get(again.score.inputsVersion) as { id: number }).id;
    allEqual(await readersRowIds(db), aId);
  });

  it('logAcqOutcome binds to the CURRENT row\'s verdict (inputs_version of the pointer row), not the newest verdict id', async () => {
    const db = migratedDb();
    const rA = await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    const rB = await persistAndLogScore(db, 'c1', B, RULESET, RCT);
    await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    expect(rA.score.verdict).not.toBe(rB.score.verdict);
    logAcqOutcome(db, 'c1', 'passed');
    const bound = db.prepare(
      `SELECT v.inputs_version AS iv, v.predicted_band AS band FROM calibration_outcome o
       JOIN calibration_verdict v ON v.id = o.calibration_id WHERE o.is_resolution = 1`,
    ).all() as Array<{ iv: string; band: string }>;
    expect(bound).toEqual([{ iv: rA.score.inputsVersion, band: rA.score.verdict }]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM data_quality_issues WHERE kind LIKE 'acq-outcome-%'").get()).toEqual({ n: 0 });
  });
});

describe('T2 — the real reader SQL prepares and runs on a fully migrated :memory: database', () => {
  const routeVariants = [
    '/acq/intel',
    '/acq/intel?status=active',
    '/acq/intel?status=active&includeKilled=1',
    '/acq/intel?status=active&verdict=KILLED',
    '/acq/intel?status=active&verdict=WATCH&market=owned-submarket&limit=5',
    '/acq/candidates?status=active',
  ];

  it.each(routeVariants)('GET %s returns 200 on an empty migrated DB', async (url) => {
    const db = migratedDb();
    const res = await warehouseRoutes(() => db).request(url);
    expect(res.status).toBe(200);
  });

  it.each(routeVariants)('GET %s returns 200 with scored and unscored candidates', async (url) => {
    const db = migratedDb();
    db.prepare("INSERT INTO acq_candidates (id, source, status, market) VALUES ('c2', 'manual', 'active', 'owned-submarket')").run();
    await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    await persistAndLogScore(db, 'c1', B, RULESET, RCT);
    await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    const res = await warehouseRoutes(() => db).request(url);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body).not.toHaveProperty('error');
  });

  it('/acq/intel lists both candidates (scored current row + unscored) with the scored row\'s state', async () => {
    const db = migratedDb();
    db.prepare("INSERT INTO acq_candidates (id, source, status) VALUES ('c2', 'manual', 'active')").run();
    await persistAndLogScore(db, 'c1', B, RULESET, RCT);
    const res = await warehouseRoutes(() => db).request('/acq/intel?status=active&includeKilled=1');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rankedCandidates: Array<{ candidate: { id: string }; latestScore: unknown; scoreState: string }> };
    const byId = Object.fromEntries(body.rankedCandidates.map((r) => [r.candidate.id, r]));
    expect(Object.keys(byId).sort()).toEqual(['c1', 'c2']);
    expect(byId['c1']!.latestScore).not.toBeNull();
    expect(byId['c1']!.scoreState).not.toBe('unscored');
    expect(byId['c2']!.latestScore).toBeNull();
    expect(byId['c2']!.scoreState).toBe('unscored');
  });

  it('the shared current-score SQL, the BUY gate, brain-report and logAcqOutcome run without a swallowed SQL error', async () => {
    const db = migratedDb();
    await persistAndLogScore(db, 'c1', A, RULESET, RCT);
    expect(() => db.prepare(CURRENT_SCORE_WITH_INPUTS_SQL).get('c1')).not.toThrow();
    await expect(buildPortfolioAllocation(db, '2026-10-01')).resolves.toBeDefined();
    expect(() => buildBrainReport(db, '2026-10-01T00:00:00Z')).not.toThrow();
    logAcqOutcome(db, 'c1', 'acquired'); // fail-open: an SQL error would only surface as a DQ row
    expect(db.prepare("SELECT COUNT(*) AS n FROM data_quality_issues WHERE kind = 'acq-outcome-failed'").get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM calibration_outcome WHERE is_resolution = 1').get()).toEqual({ n: 1 });
  });
});
