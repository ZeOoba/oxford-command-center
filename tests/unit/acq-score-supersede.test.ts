// @vitest-environment node
//
// tests/unit/acq-score-supersede.test.ts
//
// Audit 2026-10-13 Wave 2a:
//   X1 — inputs_version hashes inputs, not engine code, and UNIQUE(score_input_id) forbids a second
//        row for the same key. After an engine-logic change the old INSERT OR IGNORE silently kept
//        the stale output forever (the sweep could only REPORT it). persistAndLogScore now
//        supersedes that row in place, and says what it did ('inserted' | 'unchanged' |
//        'superseded' | 'reinstated').
//   X2 — the stored-vs-live comparison was composite / tier / verdict / floors only. It now also
//        covers every field the BUY gate and its open-items disclosure read; each field here is
//        changed ALONE to prove it is compared.
// Every score is written by the real production funnel on the ratified ruleset + RCT; a test that
// needs a pre-engine-change row UPDATEs the persisted row to that shape.
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { persistAndLogScore, logAcqOutcome } from '../../server/warehouse/acq-engine';
import { buildBrainReport } from '../../server/warehouse/brain-report';
import { warehouseRoutes } from '../../server/warehouse/api';
import { acquisitionDealCounts, calibrationLog, calibrationReport, computeInputsVersion, logVerdicts, resolveManualOutcome } from '../../server/warehouse/calibration';
import { parseRuleset, scoreAcquisition } from '../../server/warehouse/acquisition';
import { classifyLatestScore, liveScoringRegime } from '../../server/warehouse/acq-score-freshness';
import { AcquisitionInput } from '../../src/contracts/acquisition';
import { loadTestRct } from '../support/rct';

const RULESET = parseRuleset(JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')));
const RCT = loadTestRct();

const STRONG_RAW: Record<string, unknown> = {
  dealId: 'supersede-strong',
  price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6,
  multiStory: false, truckCourtFt: 120,
  constructionType: 'tilt-precast', yearBuilt: 2005, sfhaOnPad: false,
  groundLeased: false, envRemediationPctOfPrice: 0, use: { automotive: false, childRelated: false, childSafetyReviewed: false }, // other-use gate confirmed (audit 2026-11-08)
  allInBasis: 3_600_000, stabilizedYoc: 0.12, leveredIrr: 0.18, unleveredIrr10yr: 0.12, underwriteHorizonYrs: 5,
  clusterTier: 'owned-submarket', sellerMotivationScore: 0.8,
  isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5, valueAddScore: 0.5,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
};
const input = (o: Record<string, unknown> = {}) => AcquisitionInput.parse({ ...STRONG_RAW, ...o });

// Per-test temp warehouses are closed and removed (coordinator directive: no %TEMP% build-up).
const opened: Array<{ db: WarehouseDb; dir: string }> = [];
function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'acq-supersede-'));
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

function addCandidate(db: WarehouseDb, id: string): void {
  db.prepare(`INSERT INTO acq_candidates (id, source, status) VALUES (?, 'manual', 'active')`).run(id);
}
async function seed(db: WarehouseDb, id: string, o: Record<string, unknown> = {}) {
  addCandidate(db, id);
  return persistAndLogScore(db, id, input({ dealId: id, ...o }), RULESET, RCT);
}
function mutateLatest(db: WarehouseDb, id: string, set: string, ...params: unknown[]): void {
  db.prepare(`UPDATE acq_scores SET ${set} WHERE id = (SELECT id FROM acq_scores WHERE candidate_id = ? ORDER BY scored_at DESC, id DESC LIMIT 1)`)
    .run(...params, id);
}
const scoreRows = (db: WarehouseDb, id: string) =>
  db.prepare('SELECT id, composite, tier, verdict, score_json, scored_at FROM acq_scores WHERE candidate_id = ? ORDER BY id').all(id) as
    Array<{ id: number; composite: number; tier: string; verdict: string; score_json: string; scored_at: string }>;
const supersededIssues = (db: WarehouseDb) =>
  db.prepare(`SELECT detail FROM data_quality_issues WHERE kind = 'acq-score-superseded'`).all() as Array<{ detail: string }>;
const classify = (db: WarehouseDb, id: string) => classifyLatestScore(db, id, liveScoringRegime(db, RULESET, RCT));

describe('X1 — persistAndLogScore supersedes a stale output on an existing key', () => {
  it('a first persist is inserted', async () => {
    const db = freshDb();
    const r = await seed(db, 'c1');
    expect(r.persisted).toBe('inserted');
  });

  it('an identical re-persist is unchanged and writes nothing', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    const before = scoreRows(db, 'c1');
    const r = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
    expect(r.persisted).toBe('unchanged');
    expect(scoreRows(db, 'c1')).toEqual(before);
    expect(supersededIssues(db)).toHaveLength(0);
  });

  it('repro: a pre-engine-change row 2.5 composite points off is superseded in place with the live output', async () => {
    const db = freshDb();
    const first = await seed(db, 'c1');
    const live = first.score.composite;
    const stale = live - 2.5;
    mutateLatest(db, 'c1', `composite = ?, score_json = json_set(score_json, '$.composite', ?)`, stale, stale);
    expect(classify(db, 'c1').state).toBe('stale');

    const r = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
    expect(r.persisted).toBe('superseded');
    expect(r.score.composite).toBe(live);

    const rows = scoreRows(db, 'c1');
    expect(rows).toHaveLength(1); // rewritten in place — UNIQUE(score_input_id) allows only one
    expect(rows[0]!.composite).toBe(live);
    expect(JSON.parse(rows[0]!.score_json).composite).toBe(live);
    expect(classify(db, 'c1').state).toBe('current');

    const issues = supersededIssues(db);
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toMatch(/candidate=c1/);
    expect(issues[0]!.detail).toMatch(new RegExp(`composite column ${stale} vs live ${live}`));
  });

  it('a superseded tier/verdict is rewritten together (no T1 next to a stale PASS)', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    mutateLatest(db, 'c1', `tier = 'PASS', verdict = 'PASS', score_json = json_set(score_json, '$.tier', 'PASS', '$.verdict', 'PASS')`);
    const r = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
    expect(r.persisted).toBe('superseded');
    const [row] = scoreRows(db, 'c1');
    expect([row!.tier, row!.verdict]).toEqual(['T1', 'PURSUE']);
  });

  it('repro: ddKnown roof false vs absent share one key and are decision-identical — unchanged, never superseded', async () => {
    const absent = { flood: true, zoning: true, 'deferred-maintenance-capex': true };
    const explicitFalse = { ...absent, roof: false };
    // Precondition: the engine really reads them identically (roof is DD-critical unresolved either way).
    const sA = scoreAcquisition(input({ ddKnown: absent }), RULESET, { rct: RCT });
    const sF = scoreAcquisition(input({ ddKnown: explicitFalse }), RULESET, { rct: RCT });
    expect(sA.ddCriticalUnresolved).toEqual(sF.ddCriticalUnresolved);
    expect(sA.ddCriticalUnresolved.length).toBeGreaterThan(0);

    for (const [firstDd, secondDd] of [[absent, explicitFalse], [explicitFalse, absent]]) {
      const db = freshDb();
      const a = await seed(db, 'c1', { ddKnown: firstDd });
      const b = await persistAndLogScore(db, 'c1', input({ dealId: 'c1', ddKnown: secondDd }), RULESET, RCT);
      expect(b.score.inputsVersion).toBe(a.score.inputsVersion);
      expect(b.persisted).toBe('unchanged');
      expect(scoreRows(db, 'c1')).toHaveLength(1);
      expect(supersededIssues(db)).toHaveLength(0);
      expect(classify(db, 'c1').state).toBe('current');
    }
  });

  it('a stored score_json that no longer parses is superseded with the live output', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    mutateLatest(db, 'c1', `score_json = '{"tier":"T1"}'`);
    const r = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
    expect(r.persisted).toBe('superseded');
    expect(classify(db, 'c1').state).toBe('current');
  });

  it('reinstated: re-persisting an earlier input whose row is no longer the latest moves it back to latest', async () => {
    const db = freshDb();
    await seed(db, 'c1');                                                      // key A
    const b = await persistAndLogScore(db, 'c1', input({ dealId: 'c1', price: 3_400_000 }), RULESET, RCT); // key B, latest
    expect(b.persisted).toBe('inserted');
    // Same-second timestamps are the norm in a test; push A clearly older so the bump is observable.
    db.prepare(`UPDATE acq_scores SET scored_at = datetime('now', '-1 day') WHERE inputs_version <> ?`).run(b.score.inputsVersion);

    const again = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
    expect(again.persisted).toBe('reinstated');
    expect(scoreRows(db, 'c1')).toHaveLength(2);
    const latest = db.prepare('SELECT inputs_version AS v FROM acq_scores WHERE candidate_id = ? ORDER BY scored_at DESC, id DESC LIMIT 1')
      .get('c1') as { v: string };
    expect(latest.v).toBe(again.score.inputsVersion);
    expect(supersededIssues(db)).toHaveLength(0);
  });

  it('a superseded row becomes latest even against a same-second sibling with a higher id', async () => {
    const db = freshDb();
    const a = await seed(db, 'c1');
    await persistAndLogScore(db, 'c1', input({ dealId: 'c1', price: 3_400_000 }), RULESET, RCT); // higher id
    db.prepare(`UPDATE acq_scores SET scored_at = datetime('now')`).run(); // identical timestamps
    db.prepare(`UPDATE acq_scores SET composite = composite - 2.5 WHERE inputs_version = ?`).run(a.score.inputsVersion);

    const r = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
    expect(r.persisted).toBe('superseded');
    const latest = db.prepare('SELECT inputs_version AS v FROM acq_scores WHERE candidate_id = ? ORDER BY scored_at DESC, id DESC LIMIT 1')
      .get('c1') as { v: string };
    expect(latest.v).toBe(a.score.inputsVersion);
  });
});

describe('X2 — every BUY-relevant stored field is compared (each changed alone)', () => {
  // Fixture with a non-empty cap line, DD-critical list and floorIndeterminate=false, so each mutation
  // below moves exactly one field away from what the live engine produces.
  const cases: Array<{ name: string; set: string; reason: RegExp }> = [
    { name: 'cap-reason line (score_json reasons)', set: `score_json = json_set(score_json, '$.reasons', json_array('Composite 80/100 → T1.', 'Notes: an invented cap.'))`, reason: /cap reasons/ },
    { name: 'capped_at_t2 column', set: 'capped_at_t2 = 1 - capped_at_t2', reason: /capped_at_t2 column/ },
    { name: 'cappedAtT2 in score_json', set: `score_json = json_set(score_json, '$.cappedAtT2', json(CASE json_extract(score_json, '$.cappedAtT2') WHEN 1 THEN 'false' ELSE 'true' END))`, reason: /cappedAtT2 / },
    { name: 'ddCriticalUnresolved in score_json', set: `score_json = json_set(score_json, '$.ddCriticalUnresolved', json_array('flood'))`, reason: /ddCriticalUnresolved/ },
    { name: 'floor_indeterminate column', set: 'floor_indeterminate = 1 - floor_indeterminate', reason: /floor_indeterminate column/ },
    { name: 'floorIndeterminate in score_json', set: `score_json = json_set(score_json, '$.floorIndeterminate', json(CASE json_extract(score_json, '$.floorIndeterminate') WHEN 1 THEN 'false' ELSE 'true' END))`, reason: /floorIndeterminate / },
    { name: 'advisory_only column', set: 'advisory_only = 1', reason: /advisory_only column/ },
    { name: 'governor_dscr_cleared column', set: 'governor_dscr_cleared = 0', reason: /governor_dscr_cleared column/ },
    { name: 'governor_dscr_cleared column (NULL)', set: 'governor_dscr_cleared = NULL', reason: /governor_dscr_cleared column/ },
    // Refute W2a follow-up (a): LTV is indeterminate at screen time (live = NULL), so a stored 0 or 1 is drift.
    { name: 'governor_ltv_cleared column', set: 'governor_ltv_cleared = 0', reason: /governor_ltv_cleared column/ },
    // Refute W2a follow-up (b): the gate / floor pass flags and the per-gate results.
    { name: 'gates_passed column', set: 'gates_passed = 1 - gates_passed', reason: /gates_passed column/ },
    { name: 'floors_passed column', set: 'floors_passed = 1 - floors_passed', reason: /floors_passed column/ },
    { name: 'gates[] in score_json', set: `score_json = json_set(score_json, '$.gates[0].passed', json('false'))`, reason: /gates \(id\/passed\) differ/ },
    { name: 'gatesPassed in score_json', set: `score_json = json_set(score_json, '$.gatesPassed', json('false'))`, reason: /gatesPassed / },
  ];

  it('precondition: the clean fixture is current and DSCR-cleared', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    expect(classify(db, 'c1').state).toBe('current');
    const row = db.prepare('SELECT governor_dscr_cleared AS g FROM acq_scores').get() as { g: number | null };
    expect(row.g).toBe(1);
  });

  for (const c of cases) {
    it(`${c.name} alone makes the latest score stale, and a re-persist supersedes it`, async () => {
      const db = freshDb();
      await seed(db, 'c1');
      mutateLatest(db, 'c1', c.set);
      const cl = classify(db, 'c1');
      expect(cl.state).toBe('stale');
      expect(cl.staleReasons.join(' ')).toMatch(c.reason);

      const r = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
      expect(r.persisted).toBe('superseded');
      expect(classify(db, 'c1').state).toBe('current');
    });
  }

  it('a cap-line wording difference on a DD-capped deal is caught (real engine cap line)', async () => {
    const db = freshDb();
    const first = await seed(db, 'c1', { ddKnown: { flood: true, zoning: true, 'deferred-maintenance-capex': true } });
    const capLine = first.score.reasons.find((r) => /^(?:Capped T1 → T2|Notes): /.test(r));
    expect(capLine).toBeDefined();
    const reworded = first.score.reasons.map((r) => (r === capLine ? r.replace('DD-critical', 'DD critical') : r));
    mutateLatest(db, 'c1', `score_json = json_set(score_json, '$.reasons', json(?))`, JSON.stringify(reworded));
    const cl = classify(db, 'c1');
    expect(cl.state).toBe('stale');
    expect(cl.staleReasons.join(' ')).toMatch(/cap reasons/);
  });
});

// ── Refute pass on b989339 ───────────────────────────────────────────────────────────────────────
const latestRow = (db: WarehouseDb, id: string) =>
  db.prepare('SELECT inputs_version AS v, verdict, scored_at FROM acq_scores WHERE candidate_id = ? ORDER BY scored_at DESC, id DESC LIMIT 1')
    .get(id) as { v: string; verdict: string; scored_at: string };
/** Seconds the newest scored_at for a candidate sits ahead of the wall clock (negative = in the past). */
const leadSeconds = (db: WarehouseDb, id: string) =>
  (db.prepare(`SELECT (julianday(MAX(scored_at)) - julianday('now')) * 86400.0 AS d FROM acq_scores WHERE candidate_id = ?`).get(id) as { d: number }).d;

describe('DEFECT 1 — latest-row ordering is total for every writer (insert, supersede, reinstate)', () => {
  const A = { dealId: 'c1' };
  const B = { dealId: 'c1', price: 3_400_000 };
  const C = { dealId: 'c1', stabilizedYoc: 0.05 }; // fails the yield floor: KILLED

  it('repro: A, B, reinstate A, then a NEW insert C — C is the latest (not A)', async () => {
    const db = freshDb();
    addCandidate(db, 'c1');
    expect((await persistAndLogScore(db, 'c1', input(A), RULESET, RCT)).persisted).toBe('inserted');
    expect((await persistAndLogScore(db, 'c1', input(B), RULESET, RCT)).persisted).toBe('inserted');
    expect((await persistAndLogScore(db, 'c1', input(A), RULESET, RCT)).persisted).toBe('reinstated');
    const c = await persistAndLogScore(db, 'c1', input(C), RULESET, RCT);
    expect(c.persisted).toBe('inserted');
    expect(c.score.verdict).toBe('KILLED');
    expect(latestRow(db, 'c1').v).toBe(c.score.inputsVersion);
    expect(classify(db, 'c1').score?.verdict).toBe('KILLED');
  });

  it('ping-pong A/B x6 then insert C — C is the latest, and the clock lead does not drift', async () => {
    const db = freshDb();
    addCandidate(db, 'c1');
    await persistAndLogScore(db, 'c1', input(A), RULESET, RCT);
    await persistAndLogScore(db, 'c1', input(B), RULESET, RCT);
    for (let i = 0; i < 6; i++) {
      const which = i % 2 === 0 ? A : B;
      const r = await persistAndLogScore(db, 'c1', input(which), RULESET, RCT);
      expect(r.persisted).toBe('reinstated');
      expect(latestRow(db, 'c1').v).toBe(r.score.inputsVersion);
    }
    const c = await persistAndLogScore(db, 'c1', input(C), RULESET, RCT);
    expect(latestRow(db, 'c1').v).toBe(c.score.inputsVersion);
    // No drift: 9 writes must not push the newest timestamp seconds into the future.
    expect(leadSeconds(db, 'c1')).toBeLessThan(0.5);
  });

  it('no drift: a reinstate after long-past siblings is stamped at the wall clock', async () => {
    const db = freshDb();
    addCandidate(db, 'c1');
    await persistAndLogScore(db, 'c1', input(A), RULESET, RCT);
    await persistAndLogScore(db, 'c1', input(B), RULESET, RCT);
    db.prepare(`UPDATE acq_scores SET scored_at = datetime('now', '-1 day')`).run();
    db.prepare(`UPDATE acq_scores SET scored_at = datetime('now', '-1 hour') WHERE id = (SELECT MAX(id) FROM acq_scores)`).run();
    await persistAndLogScore(db, 'c1', input(A), RULESET, RCT);
    expect(Math.abs(leadSeconds(db, 'c1'))).toBeLessThan(0.5);
  });

  it('a sibling stamped in the future still loses to a later write (monotonic per candidate)', async () => {
    const db = freshDb();
    addCandidate(db, 'c1');
    await persistAndLogScore(db, 'c1', input(A), RULESET, RCT);
    db.prepare(`UPDATE acq_scores SET scored_at = datetime('now', '+1 hour')`).run();
    const b = await persistAndLogScore(db, 'c1', input(B), RULESET, RCT);
    expect(latestRow(db, 'c1').v).toBe(b.score.inputsVersion);
  });
});

describe("DEFECT 2 — logAcqOutcome binds to the LATEST acq_scores row's verdict", () => {
  it("A (PURSUE), B (KILLED), reinstate A, outcome → resolves against A's verdict", async () => {
    const db = freshDb();
    addCandidate(db, 'c1');
    const a = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
    const b = await persistAndLogScore(db, 'c1', input({ dealId: 'c1', stabilizedYoc: 0.05 }), RULESET, RCT);
    expect(a.score.verdict).toBe('PURSUE');
    expect(b.score.verdict).toBe('KILLED');
    expect(a.calibrationVerdictId).not.toBeNull();
    expect(b.calibrationVerdictId).not.toBe(a.calibrationVerdictId);
    const again = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
    expect(again.persisted).toBe('reinstated');

    logAcqOutcome(db, 'c1', 'acquired');
    const out = db.prepare('SELECT calibration_id AS cid, hit FROM calibration_outcome').all() as Array<{ cid: number; hit: number }>;
    expect(out).toEqual([{ cid: a.calibrationVerdictId, hit: 1 }]);
  });

  it('falls back to the newest calibration_verdict when the latest score row has no linked verdict', async () => {
    const db = freshDb();
    addCandidate(db, 'c1');
    const a = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
    db.prepare('UPDATE acq_scores SET calibration_verdict_id = NULL').run();
    logAcqOutcome(db, 'c1', 'passed');
    const out = db.prepare('SELECT calibration_id AS cid FROM calibration_outcome').all() as Array<{ cid: number }>;
    expect(out).toEqual([{ cid: a.calibrationVerdictId }]);
  });
});

describe('brain-report floor-indeterminate questions are deliberately freshness-agnostic', () => {
  it('a floor-indeterminate latest score made under a superseded governor regime is still listed', async () => {
    const db = freshDb();
    await seed(db, 'c1', { unleveredIrr10yr: null }); // IRR unknown: floor indeterminate
    db.prepare(
      `INSERT INTO capital_config
         (version, effective_from, dscr_floor, ltv_ceiling, disposition_cap_rate, hold_cap_rate,
          acq_irr, capex_irr, refi_trigger_bps, payout_pct, notes)
       VALUES (2, '2026-10-13', 1.30, 0.40, 0.065, 0.075, 0.12, 0.15, 150, 0.0, 'test: governor regime bump')`,
    ).run();
    expect(classify(db, 'c1').state).toBe('stale');
    const qs = buildBrainReport(db, '2026-10-14').openQuestions.filter((q) => q.kind === 'floor-indeterminate');
    expect(qs.map((q) => q.detail).join(' ')).toMatch(/candidate c1/);
  });
});

// ── Refute round 2 on 87412ee ────────────────────────────────────────────────────────────────────
const outcomes = (db: WarehouseDb) =>
  db.prepare('SELECT calibration_id AS cid, hit FROM calibration_outcome').all() as Array<{ cid: number; hit: number }>;
const dq = (db: WarehouseDb, kind: string) =>
  db.prepare('SELECT detail FROM data_quality_issues WHERE kind = ?').all(kind) as Array<{ detail: string }>;

describe('MEDIUM A — an outcome is never signed against a verdict band the served score contradicts', () => {
  it('same-year supersede PURSUE → KILLED, then passed: no mis-signed outcome, band-mismatch DQ row', async () => {
    const db = freshDb();
    addCandidate(db, 'c1');
    const killedInput = input({ dealId: 'c1', stabilizedYoc: 0.05 });
    const first = await persistAndLogScore(db, 'c1', killedInput, RULESET, RCT);
    expect(first.score.verdict).toBe('KILLED');
    // Simulate the pre-engine-change state: under the old engine this key scored T1 PURSUE, and
    // that is what was logged to calibration (same year, same key ⇒ logVerdicts dedups later).
    db.prepare(`UPDATE acq_scores SET tier = 'T1', verdict = 'PURSUE', score_json = json_set(score_json, '$.tier', 'T1', '$.verdict', 'PURSUE')`).run();
    db.prepare(`UPDATE calibration_verdict SET predicted_band = 'PURSUE', direction = 'up' WHERE id = ?`).run(first.calibrationVerdictId);

    const again = await persistAndLogScore(db, 'c1', killedInput, RULESET, RCT);
    expect(again.persisted).toBe('superseded');
    expect(again.score.verdict).toBe('KILLED');
    expect(again.calibrationVerdictId).toBe(first.calibrationVerdictId); // append-only: not relinked

    db.prepare(`UPDATE acq_candidates SET status = 'passed' WHERE id = 'c1'`).run();
    logAcqOutcome(db, 'c1', 'passed');
    expect(outcomes(db)).toEqual([]); // 'passed' vs PURSUE would have been a mis-signed miss
    const issues = dq(db, 'acq-outcome-band-mismatch');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toMatch(/candidate=c1/);
    expect(issues[0]!.detail).toMatch(new RegExp(`inputs_version=${again.score.inputsVersion}`));
    expect(issues[0]!.detail).toMatch(/PURSUE/);
    expect(issues[0]!.detail).toMatch(/KILLED/);
  });

  it('control: an agreeing band still resolves normally', async () => {
    const db = freshDb();
    const a = await seed(db, 'c1');
    logAcqOutcome(db, 'c1', 'acquired');
    expect(outcomes(db)).toEqual([{ cid: a.calibrationVerdictId, hit: 1 }]);
    expect(dq(db, 'acq-outcome-band-mismatch')).toEqual([]);
  });
});

describe('MEDIUM B — the NULL-link fallback never crosses inputs', () => {
  it('a verdict INSERT that aborts for input B does not let B\'s outcome bind to A\'s verdict', async () => {
    const db = freshDb();
    addCandidate(db, 'c1');
    const a = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
    expect(a.calibrationVerdictId).not.toBeNull();
    db.exec(`CREATE TRIGGER abort_cv BEFORE INSERT ON calibration_verdict BEGIN SELECT RAISE(ABORT, 'test: verdict insert aborted'); END;`);
    const b = await persistAndLogScore(db, 'c1', input({ dealId: 'c1', stabilizedYoc: 0.05 }), RULESET, RCT);
    expect(b.persisted).toBe('inserted');
    expect(b.calibrationVerdictId).toBeNull();
    db.exec('DROP TRIGGER abort_cv');

    logAcqOutcome(db, 'c1', 'passed');
    expect(outcomes(db)).toEqual([]);
    const issues = dq(db, 'acq-outcome-unbound');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.detail).toMatch(new RegExp(`inputs_version=${b.score.inputsVersion}`));
  });
});

describe('score_json.scoredAt is the engine-run time of the stored output (pinned choice)', () => {
  it('reinstate keeps the embedded scoredAt (output unchanged); supersede refreshes it with the new run', async () => {
    const db = freshDb();
    addCandidate(db, 'c1');
    const a = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
    await persistAndLogScore(db, 'c1', input({ dealId: 'c1', price: 3_400_000 }), RULESET, RCT);
    const embedded = (v: string) =>
      (db.prepare(`SELECT json_extract(score_json, '$.scoredAt') AS t FROM acq_scores WHERE inputs_version = ?`).get(v) as { t: string }).t;
    const original = embedded(a.score.inputsVersion);

    const r = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
    expect(r.persisted).toBe('reinstated');
    expect(embedded(a.score.inputsVersion)).toBe(original);

    db.prepare(`UPDATE acq_scores SET composite = composite - 2.5, score_json = json_set(score_json, '$.scoredAt', '2000-01-01T00:00:00.000Z') WHERE inputs_version = ?`)
      .run(a.score.inputsVersion);
    const s = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
    expect(s.persisted).toBe('superseded');
    expect(embedded(a.score.inputsVersion)).toBe(s.score.scoredAt);
    expect(s.score.scoredAt).not.toBe('2000-01-01T00:00:00.000Z');
  });
});

describe('/acq/intel ordering is total before LIMIT', () => {
  it('two candidates tied on verdict, composite and created_at are ordered by id', async () => {
    const db = freshDb();
    for (const id of ['cand-b', 'cand-a']) {
      db.prepare(`INSERT INTO acq_candidates (id, source, status, created_at) VALUES (?, 'manual', 'active', '2026-10-14 09:00:00')`).run(id);
      await persistAndLogScore(db, id, input({ dealId: 'tied' }), RULESET, RCT);
    }
    const app = warehouseRoutes(() => db);
    const one = (await (await app.request('/acq/intel?limit=1')).json()) as { rankedCandidates: Array<{ candidate: { id: string } }> };
    expect(one.rankedCandidates.map((r) => r.candidate.id)).toEqual(['cand-a']);
    const both = (await (await app.request('/acq/intel?limit=2')).json()) as { rankedCandidates: Array<{ candidate: { id: string } }> };
    expect(both.rankedCandidates.map((r) => r.candidate.id)).toEqual(['cand-a', 'cand-b']);
  });
});

// ── Refute round 3 on 0ae9dad ────────────────────────────────────────────────────────────────────
/** Same pre-engine-change setup as MEDIUM A: live KILLED, stored + logged as PURSUE, then superseded. */
async function bandFlipped(db: WarehouseDb): Promise<void> {
  addCandidate(db, 'c1');
  const killedInput = input({ dealId: 'c1', stabilizedYoc: 0.05 });
  const first = await persistAndLogScore(db, 'c1', killedInput, RULESET, RCT);
  db.prepare(`UPDATE acq_scores SET tier = 'T1', verdict = 'PURSUE', score_json = json_set(score_json, '$.tier', 'T1', '$.verdict', 'PURSUE')`).run();
  db.prepare(`UPDATE calibration_verdict SET predicted_band = 'PURSUE', direction = 'up' WHERE id = ?`).run(first.calibrationVerdictId);
  expect((await persistAndLogScore(db, 'c1', killedInput, RULESET, RCT)).persisted).toBe('superseded');
}
async function patchStatus(app: ReturnType<typeof warehouseRoutes>, id: string, status: string) {
  const res = await app.request(`/acq/candidates/${encodeURIComponent(id)}/status`, {
    method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status }),
  });
  expect(res.status).toBe(200);
}
const dqCount = (db: WarehouseDb, kind?: string) =>
  (db.prepare(`SELECT COUNT(*) AS n FROM data_quality_issues WHERE kind LIKE 'acq-outcome-%' AND (? IS NULL OR kind = ?)`)
    .get(kind ?? null, kind ?? null) as { n: number }).n;

describe('round 3 #1 — outcome skips are idempotent', () => {
  it("5x PATCH 'passed' on a band-mismatched candidate writes exactly one DQ row", async () => {
    const db = freshDb();
    await bandFlipped(db);
    const app = warehouseRoutes(() => db);
    for (let i = 0; i < 5; i++) await patchStatus(app, 'c1', 'passed');
    expect(dqCount(db, 'acq-outcome-band-mismatch')).toBe(1);
    expect(outcomes(db)).toEqual([]);
  });

  it("5x PATCH 'passed' on an unbound candidate writes exactly one DQ row", async () => {
    const db = freshDb();
    addCandidate(db, 'c1');
    await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
    db.exec(`CREATE TRIGGER abort_cv BEFORE INSERT ON calibration_verdict BEGIN SELECT RAISE(ABORT, 'test'); END;`);
    await persistAndLogScore(db, 'c1', input({ dealId: 'c1', stabilizedYoc: 0.05 }), RULESET, RCT);
    db.exec('DROP TRIGGER abort_cv');
    const app = warehouseRoutes(() => db);
    for (let i = 0; i < 5; i++) await patchStatus(app, 'c1', 'passed');
    expect(dqCount(db, 'acq-outcome-unbound')).toBe(1);
  });

  it('a resolved DQ row does not suppress a new one (dedupe is on OPEN rows only)', async () => {
    const db = freshDb();
    await bandFlipped(db);
    logAcqOutcome(db, 'c1', 'passed');
    db.prepare(`UPDATE data_quality_issues SET status = 'resolved' WHERE kind = 'acq-outcome-band-mismatch'`).run();
    logAcqOutcome(db, 'c1', 'passed');
    expect(dqCount(db, 'acq-outcome-band-mismatch')).toBe(2);
  });

  it('outcome already recorded, then a band flip, then PATCH: no new DQ row (already-resolved is a no-op)', async () => {
    const db = freshDb();
    addCandidate(db, 'c1');
    const killedInput = input({ dealId: 'c1', stabilizedYoc: 0.05 });
    const first = await persistAndLogScore(db, 'c1', killedInput, RULESET, RCT);
    const app = warehouseRoutes(() => db);
    await patchStatus(app, 'c1', 'passed');
    expect(outcomes(db)).toEqual([{ cid: first.calibrationVerdictId, hit: 1 }]);
    // Band flip on the same key after the outcome exists (simulated engine change → supersede).
    db.prepare(`UPDATE acq_scores SET verdict = 'PASS', tier = 'PASS'`).run();
    db.prepare(`UPDATE calibration_verdict SET predicted_band = 'PURSUE' WHERE id = ?`).run(first.calibrationVerdictId);
    const before = dqCount(db);
    await patchStatus(app, 'c1', 'passed');
    expect(dqCount(db)).toBe(before);
    expect(outcomes(db)).toHaveLength(1);
  });
});

describe('round 3 #2 — brain-report data-quality list is a total order', () => {
  it('rows sharing one created_at second are ordered newest id first', () => {
    const db = freshDb();
    const ins = db.prepare(`INSERT INTO data_quality_issues (kind, detail, severity, created_at) VALUES (?, ?, 'warn', '2026-10-14 09:00:00')`);
    for (let i = 1; i <= 3; i++) ins.run(`tie-${i}`, `detail ${i}`);
    const dqs = buildBrainReport(db, '2026-10-14').openQuestions.filter((q) => q.kind === 'data-quality' && q.title.startsWith('tie-'));
    expect(dqs.map((q) => q.title)).toEqual(['tie-3', 'tie-2', 'tie-1']);
  });
});

// ── Refute round 4 on b64ed5d — outcome idempotency is per DEAL, not per verdict ──────────────────
const blessed = (db: WarehouseDb) =>
  (db.prepare('SELECT COUNT(*) AS n FROM calibration_outcome WHERE is_resolution = 1').get() as { n: number }).n;
const openSkips = (db: WarehouseDb) =>
  db.prepare(`SELECT kind, status FROM data_quality_issues WHERE kind LIKE 'acq-outcome-%' ORDER BY id`).all() as Array<{ kind: string; status: string }>;

describe('round 4 #1 — one blessed outcome per deal', () => {
  it('(a) A, B, outcome, reinstate A, repeat PATCH: exactly one blessed row', async () => {
    const db = freshDb();
    addCandidate(db, 'c1');
    await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
    await persistAndLogScore(db, 'c1', input({ dealId: 'c1', price: 3_400_000 }), RULESET, RCT);
    const app = warehouseRoutes(() => db);
    await patchStatus(app, 'c1', 'passed');
    expect(blessed(db)).toBe(1);
    expect((await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT)).persisted).toBe('reinstated');
    await patchStatus(app, 'c1', 'passed');
    expect(blessed(db)).toBe(1);
    expect(openSkips(db)).toEqual([]); // a deal already resolved is a silent no-op, not a DQ event
  });

  it('(b) acquired, re-score under a new input (same year), passed: exactly one blessed row', async () => {
    const db = freshDb();
    const a = await seed(db, 'c1');
    logAcqOutcome(db, 'c1', 'acquired');
    const c = await persistAndLogScore(db, 'c1', input({ dealId: 'c1', stabilizedYoc: 0.05 }), RULESET, RCT);
    expect(c.calibrationVerdictId).not.toBe(a.calibrationVerdictId);
    logAcqOutcome(db, 'c1', 'passed');
    expect(blessed(db)).toBe(1);
    expect(outcomes(db)).toEqual([{ cid: a.calibrationVerdictId, hit: 1 }]);
  });

  it('(c) cross-year: acquired in year N, re-scored in year N+1 (new as_of_period verdict), passed: one blessed row', async () => {
    const db = freshDb();
    const year = new Date().getFullYear();
    const a = await seed(db, 'c1');
    logAcqOutcome(db, 'c1', 'acquired');
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date(`${year + 1}-03-01T12:00:00Z`));
      const again = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT); // same key, new year
      expect(again.calibrationVerdictId).not.toBe(a.calibrationVerdictId);
      const periods = db.prepare('SELECT as_of_period AS p FROM calibration_verdict ORDER BY id').all() as Array<{ p: string }>;
      expect(periods.map((r) => r.p)).toEqual([String(year), String(year + 1)]);
      logAcqOutcome(db, 'c1', 'passed');
    } finally {
      vi.useRealTimers();
    }
    expect(blessed(db)).toBe(1);
    expect(outcomes(db)).toEqual([{ cid: a.calibrationVerdictId, hit: 1 }]);
  });

  it('(d) the first resolution of a deal still records normally', async () => {
    const db = freshDb();
    const a = await seed(db, 'c1');
    logAcqOutcome(db, 'c1', 'passed');
    expect(outcomes(db)).toEqual([{ cid: a.calibrationVerdictId, hit: 0 }]);
  });

  it('manual resolution is NOT bound by the per-deal rule: an analyst can still correct a resolved deal', async () => {
    const db = freshDb();
    const a = await seed(db, 'c1');
    logAcqOutcome(db, 'c1', 'acquired');
    const r = resolveManualOutcome(db, {
      calibrationId: a.calibrationVerdictId,
      realizedBand: 'passed',
      outcomePeriod: String(new Date().getFullYear() + 1),
      hit: 0,
      actionTaken: 'acted-counter',
    });
    expect(r).toMatchObject({ ok: true, superseded: true });
    expect(blessed(db)).toBe(1);
    const row = db.prepare('SELECT realized_band AS b, resolved_by AS by FROM calibration_outcome WHERE is_resolution = 1').get() as { b: string; by: string };
    expect(row).toEqual({ b: 'passed', by: 'manual:gabriel' });
  });
});

describe('round 4 #2 — skip rows: closed on a successful bless; keyed by the attempted outcome', () => {
  it("a successful bless resolves the candidate's open band-mismatch / unbound rows", async () => {
    const db = freshDb();
    await bandFlipped(db);
    logAcqOutcome(db, 'c1', 'passed');
    expect(openSkips(db)).toEqual([{ kind: 'acq-outcome-band-mismatch', status: 'open' }]);
    // A clean re-score under a new input links an agreeing verdict; the next outcome blesses it.
    await persistAndLogScore(db, 'c1', input({ dealId: 'c1', price: 3_400_000 }), RULESET, RCT);
    logAcqOutcome(db, 'c1', 'passed');
    expect(blessed(db)).toBe(1);
    expect(openSkips(db)).toEqual([{ kind: 'acq-outcome-band-mismatch', status: 'resolved' }]);
  });

  it("a bless for candidate c1 does not close candidate c10's skip rows", async () => {
    const db = freshDb();
    db.prepare(`INSERT INTO data_quality_issues (kind, detail, severity) VALUES ('acq-outcome-unbound', 'candidate=c10 inputs_version=x outcome=passed : test', 'warn')`).run();
    await seed(db, 'c1');
    logAcqOutcome(db, 'c1', 'passed');
    expect(openSkips(db)).toEqual([{ kind: 'acq-outcome-unbound', status: 'open' }]);
  });

  it('a corrected status is not suppressed by an open row for the other status', async () => {
    const db = freshDb();
    await bandFlipped(db);
    logAcqOutcome(db, 'c1', 'passed');
    logAcqOutcome(db, 'c1', 'passed');
    expect(dqCount(db, 'acq-outcome-band-mismatch')).toBe(1);
    logAcqOutcome(db, 'c1', 'acquired');
    expect(dqCount(db, 'acq-outcome-band-mismatch')).toBe(2);
    const details = db.prepare(`SELECT detail FROM data_quality_issues WHERE kind = 'acq-outcome-band-mismatch' ORDER BY id`).all() as Array<{ detail: string }>;
    expect(details.map((d) => /outcome=(\w+)/.exec(d.detail)?.[1])).toEqual(['passed', 'acquired']);
  });
});

// ── Refute round 5 on 9c8a9dd6 — per-deal resolution on EVERY surface ───────────────────────────
const nextYear = () => String(new Date().getFullYear() + 1);
const manualPassed = (calibrationId: number) => ({
  calibrationId, realizedBand: 'passed', outcomePeriod: nextYear(), hit: 0, actionTaken: 'acted-counter' as const,
});
const blessedRows = (db: WarehouseDb) =>
  db.prepare(`SELECT calibration_id AS cid, realized_band AS band, hit, resolved_by AS by
              FROM calibration_outcome WHERE is_resolution = 1 ORDER BY calibration_id`).all();
/** A deal with two verdicts: A (older, PURSUE) and B (latest, PURSUE, different input). */
async function twoVerdictDeal(db: WarehouseDb): Promise<{ va: number; vb: number }> {
  addCandidate(db, 'c1');
  const a = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
  const b = await persistAndLogScore(db, 'c1', input({ dealId: 'c1', price: 3_400_000 }), RULESET, RCT);
  return { va: a.calibrationVerdictId!, vb: b.calibrationVerdictId! };
}
const acqReport = (db: WarehouseDb) => {
  const r = calibrationReport(db, { kind: 'acquisition-score' });
  const k = r.byKind.find((x) => x.verdictKind === 'acquisition-score');
  return { resolved: r.resolvedVerdicts, hitRate: k?.hitRate ?? null };
};

describe('round 5 #1 — one blessed outcome per deal regardless of surface or order', () => {
  it('auto (latest verdict B) then manual on sibling A: exactly one blessed row, on A', async () => {
    const db = freshDb();
    const { va } = await twoVerdictDeal(db);
    logAcqOutcome(db, 'c1', 'passed'); // blesses B (latest)
    const r = resolveManualOutcome(db, manualPassed(va));
    expect(r).toMatchObject({ ok: true, superseded: true });
    expect(blessedRows(db)).toEqual([{ cid: va, band: 'passed', hit: 0, by: 'manual:gabriel' }]);
  });

  it('BOTH orders end in the identical blessed state and calibration report', async () => {
    const db1 = freshDb();
    const v1 = await twoVerdictDeal(db1);
    logAcqOutcome(db1, 'c1', 'passed');
    expect(resolveManualOutcome(db1, manualPassed(v1.va)).ok).toBe(true);

    const db2 = freshDb();
    const v2 = await twoVerdictDeal(db2);
    expect(resolveManualOutcome(db2, manualPassed(v2.va)).ok).toBe(true);
    logAcqOutcome(db2, 'c1', 'passed'); // deal already resolved: no-op

    expect(v1).toEqual(v2);
    expect(blessedRows(db1)).toEqual(blessedRows(db2));
    expect(blessedRows(db1)).toHaveLength(1);
    expect(acqReport(db1)).toEqual(acqReport(db2));
    expect(acqReport(db1).resolved).toBe(1);
  });

  it('the open queue excludes a resolved deal\'s sibling verdicts', async () => {
    const db = freshDb();
    const { va, vb } = await twoVerdictDeal(db);
    const openIds = () => calibrationLog(db, { status: 'open', kind: 'acquisition-score' }).map((v) => v.id);
    expect(openIds().sort()).toEqual([va, vb].sort());
    logAcqOutcome(db, 'c1', 'passed');
    expect(openIds()).toEqual([]);
    // Round 6: the sibling is resolved BY DEAL (covered by B), so it moves to the resolved list.
    const resolvedRows = calibrationLog(db, { status: 'resolved', kind: 'acquisition-score' });
    expect(resolvedRows.map((v) => [v.id, v.resolvedByVerdictId])).toEqual([[vb, null], [va, vb]]);
  });

  it('same-verdict manual correction still supersedes in place', async () => {
    const db = freshDb();
    const { vb } = await twoVerdictDeal(db);
    logAcqOutcome(db, 'c1', 'acquired'); // blesses B as acquired
    const r = resolveManualOutcome(db, manualPassed(vb));
    expect(r).toMatchObject({ ok: true, superseded: true, duplicate: false });
    expect(blessedRows(db)).toEqual([{ cid: vb, band: 'passed', hit: 0, by: 'manual:gabriel' }]);
    expect(resolveManualOutcome(db, manualPassed(vb))).toMatchObject({ ok: true, duplicate: true });
  });

  it('property-subject manual resolution is unchanged: two verdicts of one property both stay blessed and listed', () => {
    const db = freshDb();
    const iv = computeInputsVersion(db);
    const base = {
      subjectKind: 'property' as const, subjectId: 'prop-1', verdictKind: 'capital-action' as const, verdictEngine: 'scores' as const,
      predictedBand: 'hold', predictedValue: null, predictedUnit: 'band' as const, confidence: 0.7,
      direction: 'flat' as const, reasons: ['test'], horizonPeriods: 1, inputsVersion: iv.inputsVersion, emittedBy: 'test',
    };
    expect(logVerdicts(db, [
      { ...base, verdictSubkind: '', asOfPeriod: '2024' },
      { ...base, verdictSubkind: '', asOfPeriod: '2025' },
    ]).written).toBe(2);
    const ids = (db.prepare(`SELECT id FROM calibration_verdict WHERE subject_id = 'prop-1' ORDER BY id`).all() as Array<{ id: number }>).map((r) => r.id);
    for (const id of ids) {
      expect(resolveManualOutcome(db, { calibrationId: id, realizedBand: 'hold', outcomePeriod: '2026', hit: 1 }).ok).toBe(true);
    }
    expect((db.prepare('SELECT COUNT(*) AS n FROM calibration_outcome WHERE is_resolution = 1').get() as { n: number }).n).toBe(2);
    expect(calibrationLog(db, { status: 'resolved', subject: 'prop-1' }).map((v) => v.id).sort()).toEqual(ids);
  });
});

describe('round 5 #2 — every resolution path closes the candidate\'s open skip rows', () => {
  it('bandFlipped → PATCH passed (open row) → manual resolve → row resolved', async () => {
    const db = freshDb();
    await bandFlipped(db);
    const app = warehouseRoutes(() => db);
    await patchStatus(app, 'c1', 'passed');
    expect(openSkips(db)).toEqual([{ kind: 'acq-outcome-band-mismatch', status: 'open' }]);
    const vid = (db.prepare('SELECT id FROM calibration_verdict').get() as { id: number }).id;
    expect(resolveManualOutcome(db, manualPassed(vid)).ok).toBe(true);
    expect(openSkips(db)).toEqual([{ kind: 'acq-outcome-band-mismatch', status: 'resolved' }]);
  });

  it('the dealResolved early return also closes a skip row left open', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    logAcqOutcome(db, 'c1', 'passed'); // resolved
    db.prepare(`INSERT INTO data_quality_issues (kind, detail, severity) VALUES ('acq-outcome-unbound', 'candidate=c1 inputs_version=x outcome=acquired : left open', 'warn')`).run();
    logAcqOutcome(db, 'c1', 'acquired');
    expect(openSkips(db)).toEqual([{ kind: 'acq-outcome-unbound', status: 'resolved' }]);
  });

  it('an old-format open skip row (no outcome in the key) does not suppress a new-format row', async () => {
    const db = freshDb();
    await bandFlipped(db);
    const iv = (db.prepare('SELECT inputs_version AS v FROM acq_scores').get() as { v: string }).v;
    db.prepare(`INSERT INTO data_quality_issues (kind, detail, severity) VALUES ('acq-outcome-band-mismatch', ?, 'warn')`)
      .run(`candidate=c1 inputs_version=${iv} calibration_verdict.id=1 outcome=passed: old format`);
    logAcqOutcome(db, 'c1', 'passed');
    expect(dqCount(db, 'acq-outcome-band-mismatch')).toBe(2);
  });
});

// ── Refute round 6 on d5aa8e83 — display consistency of the per-deal rule ───────────────────────
describe('round 6 #1 — calibrationLog partitions a re-keyed resolved deal (all = open + resolved)', () => {
  it('the sibling of a resolved deal reads resolved, covered by the blessed verdict', async () => {
    const db = freshDb();
    const { va, vb } = await twoVerdictDeal(db);
    logAcqOutcome(db, 'c1', 'passed'); // blesses B (latest)
    const all = calibrationLog(db, { kind: 'acquisition-score' });
    const open = calibrationLog(db, { kind: 'acquisition-score', status: 'open' });
    const resolved = calibrationLog(db, { kind: 'acquisition-score', status: 'resolved' });
    expect(open).toEqual([]);
    expect([...open, ...resolved].map((r) => r.id).sort()).toEqual(all.map((r) => r.id).sort());
    const sib = all.find((r) => r.id === va)!;
    expect(sib.resolved).toBe(true);
    expect(sib.resolvedByVerdictId).toBe(vb);
    expect(sib.hit).toBeNull(); // the outcome belongs to the covering verdict, not copied onto the sibling
    const own = all.find((r) => r.id === vb)!;
    expect(own.resolved).toBe(true);
    expect(own.resolvedByVerdictId).toBeNull();
  });

  it('an unresolved deal: both verdicts open, none covered', async () => {
    const db = freshDb();
    await twoVerdictDeal(db);
    const all = calibrationLog(db, { kind: 'acquisition-score' });
    expect(all.map((r) => [r.resolved, r.resolvedByVerdictId])).toEqual([[false, null], [false, null]]);
    expect(calibrationLog(db, { kind: 'acquisition-score', status: 'open' })).toHaveLength(2);
    expect(calibrationLog(db, { kind: 'acquisition-score', status: 'resolved' })).toHaveLength(0);
  });

  it('property verdicts are never covered by a sibling', () => {
    const db = freshDb();
    const iv = computeInputsVersion(db);
    const base = {
      subjectKind: 'property' as const, subjectId: 'prop-1', verdictKind: 'capital-action' as const, verdictEngine: 'scores' as const,
      predictedBand: 'hold', predictedValue: null, predictedUnit: 'band' as const, confidence: 0.7,
      direction: 'flat' as const, reasons: ['test'], horizonPeriods: 1, inputsVersion: iv.inputsVersion, emittedBy: 'test', verdictSubkind: '',
    };
    logVerdicts(db, [{ ...base, asOfPeriod: '2024' }, { ...base, asOfPeriod: '2025' }]);
    const first = (db.prepare(`SELECT MIN(id) AS id FROM calibration_verdict`).get() as { id: number }).id;
    expect(resolveManualOutcome(db, { calibrationId: first, realizedBand: 'hold', outcomePeriod: '2026', hit: 1 }).ok).toBe(true);
    const all = calibrationLog(db, { subject: 'prop-1' });
    expect(all.map((r) => [r.resolved, r.resolvedByVerdictId]).sort()).toEqual([[false, null], [true, null]]);
    expect(calibrationLog(db, { subject: 'prop-1', status: 'open' })).toHaveLength(1);
  });
});

describe('round 6 #2 — /acq/intel calibration summary counts deals alongside verdicts', () => {
  it('a re-keyed resolved deal: 2 verdicts, 1 deal, 1 resolved deal', async () => {
    const db = freshDb();
    await twoVerdictDeal(db);
    logAcqOutcome(db, 'c1', 'passed');
    const app = warehouseRoutes(() => db);
    const body = (await (await app.request('/acq/intel')).json()) as {
      calibrationSummary: { totalVerdicts: number; resolvedVerdicts: number; totalDeals: number; resolvedDeals: number };
    };
    expect(body.calibrationSummary).toMatchObject({ totalVerdicts: 2, resolvedVerdicts: 1, totalDeals: 1, resolvedDeals: 1 });
  });

  it('acquisitionDealCounts counts DISTINCT deals, resolved when any verdict is blessed', async () => {
    const db = freshDb();
    await twoVerdictDeal(db);
    await seed(db, 'c2');
    expect(acquisitionDealCounts(db)).toEqual({ totalDeals: 2, resolvedDeals: 0 });
    logAcqOutcome(db, 'c1', 'acquired');
    expect(acquisitionDealCounts(db)).toEqual({ totalDeals: 2, resolvedDeals: 1 });
  });
});

// ── #463 governorRegime stamp across every persist outcome (Option A merge with origin/main).
// The stamp is folded into the X1 transaction: inserted rows carry the live stamp; a superseded row
// gets the FRESH stamp with the fresh output; an unchanged / reinstated row never has an existing
// stamp overwritten and only has a MISSING stamp filled when its stored result equals the live one.
describe('#463 governorRegime stamp — inserted / superseded / unchanged / reinstated', () => {
  const stampOf = (db: WarehouseDb, inputsVersion: string): string | null =>
    (db.prepare(`SELECT json_extract(score_json, '$.governorRegime') AS r FROM acq_scores WHERE inputs_version = ?`)
      .get(inputsVersion) as { r: string | null }).r;
  const setStamp = (db: WarehouseDb, inputsVersion: string, stamp: string | null): void => {
    if (stamp === null) {
      db.prepare(`UPDATE acq_scores SET score_json = json_remove(score_json, '$.governorRegime') WHERE inputs_version = ?`).run(inputsVersion);
    } else {
      db.prepare(`UPDATE acq_scores SET score_json = json_set(score_json, '$.governorRegime', ?) WHERE inputs_version = ?`).run(stamp, inputsVersion);
    }
  };
  const LIVE = '1:1.25:0.4:0.085'; // governorFingerprint of the seeded capital_config v1
  const OLD = '0:1.25:0.4:0.085';

  it('inserted: the new row carries the live stamp and classifies current', async () => {
    const db = freshDb();
    const r = await seed(db, 'c1');
    expect(r.persisted).toBe('inserted');
    expect(stampOf(db, r.score.inputsVersion)).toBe(LIVE);
    expect(classify(db, 'c1').state).toBe('current');
  });

  it('superseded: a drifted row with a MISSING stamp is rewritten with the live output AND the fresh stamp', async () => {
    const db = freshDb();
    const first = await seed(db, 'c1');
    mutateLatest(db, 'c1', `composite = composite - 2.5, score_json = json_remove(json_set(score_json, '$.composite', composite - 2.5), '$.governorRegime')`);
    const r = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
    expect(r.persisted).toBe('superseded');
    expect(scoreRows(db, 'c1')[0]!.composite).toBe(first.score.composite);
    expect(stampOf(db, r.score.inputsVersion)).toBe(LIVE);
    expect(classify(db, 'c1').state).toBe('current');
  });

  it('superseded: a drifted row with an OLDER stamp gets the fresh stamp (the stamp follows the output it sits next to)', async () => {
    const db = freshDb();
    const first = await seed(db, 'c1');
    setStamp(db, first.score.inputsVersion, OLD);
    mutateLatest(db, 'c1', `composite = composite - 2.5, score_json = json_set(score_json, '$.composite', composite - 2.5)`);
    const r = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
    expect(r.persisted).toBe('superseded');
    expect(stampOf(db, r.score.inputsVersion)).toBe(LIVE);
  });

  it('unchanged: a MISSING stamp on a matching row is filled; the row reads current again', async () => {
    const db = freshDb();
    const first = await seed(db, 'c1');
    setStamp(db, first.score.inputsVersion, null);
    expect(classify(db, 'c1').state).toBe('stale');
    const r = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
    expect(r.persisted).toBe('unchanged');
    expect(stampOf(db, r.score.inputsVersion)).toBe(LIVE);
    expect(classify(db, 'c1').state).toBe('current');
  });

  it('unchanged: an EXISTING older stamp is never overwritten (the row stays stale for BUY)', async () => {
    const db = freshDb();
    const first = await seed(db, 'c1');
    setStamp(db, first.score.inputsVersion, OLD);
    const r = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
    expect(r.persisted).toBe('unchanged');
    expect(stampOf(db, r.score.inputsVersion)).toBe(OLD);
    expect(classify(db, 'c1').state).toBe('stale');
  });

  it('reinstated: an EXISTING stamp is kept; a MISSING stamp on the matching row is filled', async () => {
    for (const [prior, expected] of [[OLD, OLD], [null, LIVE]] as const) {
      const db = freshDb();
      const a = await seed(db, 'c1');                                                                       // key A
      const b = await persistAndLogScore(db, 'c1', input({ dealId: 'c1', price: 3_400_000 }), RULESET, RCT); // key B, latest
      db.prepare(`UPDATE acq_scores SET scored_at = datetime('now', '-1 day') WHERE inputs_version <> ?`).run(b.score.inputsVersion);
      setStamp(db, a.score.inputsVersion, prior);
      const again = await persistAndLogScore(db, 'c1', input({ dealId: 'c1' }), RULESET, RCT);
      expect(again.persisted).toBe('reinstated');
      expect(stampOf(db, a.score.inputsVersion)).toBe(expected);
      expect(stampOf(db, b.score.inputsVersion)).toBe(LIVE); // the other key's row is untouched
      expect(classify(db, 'c1').state).toBe(expected === LIVE ? 'current' : 'stale');
    }
  });

  it('the returned score never carries the stamp (AcquisitionScore is a contract; the stamp lives in score_json only)', async () => {
    const db = freshDb();
    const r = await seed(db, 'c1');
    expect((r.score as Record<string, unknown>)['governorRegime']).toBeUndefined();
  });
});
