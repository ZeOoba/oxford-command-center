// @vitest-environment node
//
// tests/unit/acq-score-freshness.test.ts
//
// Audit 2026-10-13 G3 — stale-regime acquisition scores. Readers took the newest acq_scores row with
// no ruleset / RCT / governor version check, so a score made under a superseded regime kept ranking
// and driving BUY, and a score_json that no longer parsed under the live contract silently became
// latestScore = null. classifyPersistedScore makes the state explicit; rescoreStaleCandidates is the
// (unscheduled) sweep a version bump calls to re-derive every stale latest score.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { persistAndLogScore } from '../../server/warehouse/acq-engine';
import { parseRuleset, loadRatifiedRct } from '../../server/warehouse/acquisition';
import {
  classifyLatestScore,
  liveScoringRegime,
  rescoreStaleCandidates,
} from '../../server/warehouse/acq-score-freshness';
import { AcquisitionInput } from '../../src/contracts/acquisition';

const RULESET = parseRuleset(JSON.parse(readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8')));
const RCT = loadRatifiedRct();

const STRONG = AcquisitionInput.parse({
  dealId: 'fresh-strong',
  price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6,
  multiStory: false, truckCourtFt: 120,
  constructionType: 'block-tilt-brick', yearBuilt: 2005, sfhaOnPad: false,
  groundLeased: false, envRemediationPctOfPrice: 0, use: { automotive: false, childRelated: false, childSafetyReviewed: false }, // other-use gate confirmed (audit 2026-11-08)
  allInBasis: 3_600_000, stabilizedYoc: 0.12, leveredIrr: 0.18, unleveredIrr10yr: 0.12, underwriteHorizonYrs: 5,
  clusterTier: 'owned-submarket', sellerMotivationScore: 0.8,
  isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5, valueAddScore: 0.5,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
});

function freshDb(): WarehouseDb {
  return openWarehouse(join(mkdtempSync(join(tmpdir(), 'acq-fresh-')), 'test.sqlite'));
}

async function seed(db: WarehouseDb, id: string): Promise<void> {
  db.prepare(`INSERT INTO acq_candidates (id, source, status) VALUES (?, 'manual', 'active')`).run(id);
  await persistAndLogScore(db, id, { ...STRONG, dealId: id }, RULESET, RCT);
}

function bumpGovernor(db: WarehouseDb, version = 2): void {
  db.prepare(
    `INSERT INTO capital_config
       (version, effective_from, dscr_floor, ltv_ceiling, disposition_cap_rate, hold_cap_rate,
        acq_irr, capex_irr, refi_trigger_bps, payout_pct, notes)
     VALUES (?, '2026-10-13', 1.30, 0.40, 0.065, 0.075, 0.12, 0.15, 150, 0.0, 'test: governor regime bump')`,
  ).run(version);
}

const latestInputsId = (db: WarehouseDb, id: string) =>
  (db.prepare('SELECT score_input_id AS sid FROM acq_scores WHERE candidate_id = ? ORDER BY scored_at DESC, id DESC LIMIT 1').get(id) as { sid: number }).sid;

describe('classifyLatestScore', () => {
  it('a score persisted under the live ruleset + RCT + governors is current', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    const c = classifyLatestScore(db, 'c1', liveScoringRegime(db, RULESET, RCT));
    expect(c.state).toBe('current');
    expect(c.staleReasons).toEqual([]);
    expect(c.score?.verdict).toBe('PURSUE');
  });

  it('a candidate with no score row is unscored', () => {
    const db = freshDb();
    db.prepare(`INSERT INTO acq_candidates (id, source, status) VALUES ('c0', 'manual', 'active')`).run();
    expect(classifyLatestScore(db, 'c0', liveScoringRegime(db, RULESET, RCT)).state).toBe('unscored');
  });

  it('a governor regime change (capital_config version bump) makes the old score stale', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    bumpGovernor(db);
    const c = classifyLatestScore(db, 'c1', liveScoringRegime(db, RULESET, RCT));
    expect(c.state).toBe('stale');
    expect(c.staleReasons.join(' ')).toMatch(/governor/i);
  });

  it('a superseded ruleset version is stale', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    db.prepare(`UPDATE acq_score_inputs SET ruleset_version = '1.0.0' WHERE id = ?`).run(latestInputsId(db, 'c1'));
    const c = classifyLatestScore(db, 'c1', liveScoringRegime(db, RULESET, RCT));
    expect(c.state).toBe('stale');
    expect(c.staleReasons.join(' ')).toMatch(/ruleset 1\.0\.0/);
  });

  it('a superseded RCT version is stale', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    db.prepare(`UPDATE acq_score_inputs SET rct_version = 'replacement-cost.v1' WHERE id = ?`).run(latestInputsId(db, 'c1'));
    const c = classifyLatestScore(db, 'c1', liveScoringRegime(db, RULESET, RCT));
    expect(c.state).toBe('stale');
    expect(c.staleReasons.join(' ')).toMatch(/replacement-cost\.v1/);
  });

  it('a score_json that does not parse under the live contract is an explicit unparseable state, not a silent null', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    db.prepare(`UPDATE acq_scores SET score_json = '{"tier":"T1"}' WHERE candidate_id = 'c1'`).run();
    const c = classifyLatestScore(db, 'c1', liveScoringRegime(db, RULESET, RCT));
    expect(c.state).toBe('unparseable');
    expect(c.score).toBeNull();
    expect(c.staleReasons.length).toBeGreaterThan(0);
  });

  it('with no live regime (config unavailable) every scored row is stale — freshness unverifiable fails closed', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    const c = classifyLatestScore(db, 'c1', null);
    expect(c.state).toBe('stale');
  });
});

describe('rescoreStaleCandidates — version-change sweep (not scheduled)', () => {
  it('re-scores stale latest scores from their stored input_json and leaves current ones alone', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    await seed(db, 'c2');
    bumpGovernor(db);

    const r1 = await rescoreStaleCandidates(db, RULESET, RCT);
    expect(r1.examined).toBe(2);
    expect(r1.rescored).toBe(2);
    expect(r1.alreadyCurrent).toBe(0);
    expect(r1.unrescorable).toEqual([]);
    const live = liveScoringRegime(db, RULESET, RCT);
    expect(classifyLatestScore(db, 'c1', live).state).toBe('current');
    expect(classifyLatestScore(db, 'c2', live).state).toBe('current');

    const r2 = await rescoreStaleCandidates(db, RULESET, RCT);
    expect(r2.rescored).toBe(0);
    expect(r2.alreadyCurrent).toBe(2);
  });

  it('a re-score reproduces the original scoring values (no drift)', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    const before = classifyLatestScore(db, 'c1', liveScoringRegime(db, RULESET, RCT)).score!;
    bumpGovernor(db);
    await rescoreStaleCandidates(db, RULESET, RCT);
    const after = classifyLatestScore(db, 'c1', liveScoringRegime(db, RULESET, RCT)).score!;
    expect(after.composite).toBe(before.composite);
    expect(after.tier).toBe(before.tier);
    expect(after.verdict).toBe(before.verdict);
    expect(after.floors).toEqual(before.floors);
  });

  it('reports (never throws on) a stale row whose stored input_json cannot be re-scored', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    db.prepare(`UPDATE acq_score_inputs SET input_json = '{}' WHERE candidate_id = 'c1'`).run();
    bumpGovernor(db);
    const r = await rescoreStaleCandidates(db, RULESET, RCT);
    expect(r.rescored).toBe(0);
    expect(r.unrescorable.map((u) => u.candidateId)).toEqual(['c1']);
  });

  it('only sweeps active candidates by default', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    db.prepare(`UPDATE acq_candidates SET status = 'archived' WHERE id = 'c1'`).run();
    bumpGovernor(db);
    const r = await rescoreStaleCandidates(db, RULESET, RCT);
    expect(r.examined).toBe(0);
  });
});

// Option A merge with #463 (Gabriel, 2026-10-15: strictest wins). The value-based key match (refute
// H2) is unchanged, but 'current' now ALSO requires the exact live governorRegime stamp, which is
// version-keyed: a values-identical reversion is a new regime and must be re-scored (#463's stated
// rule). Formerly this test asserted 'current' for the v1 score under v3.
describe('classifyLatestScore — values-keyed key match AND version-keyed regime stamp (refute H2 + #463)', () => {
  it('a values-identical reversion (v1 1.25 → v2 1.30 → v3 1.25) leaves a v1 score STALE until re-scored; the re-score is current', async () => {
    const db = freshDb();
    await seed(db, 'c1');           // scored under v1 (1.25)
    bumpGovernor(db, 2);             // v2: 1.30
    db.prepare(
      `INSERT INTO capital_config
         (version, effective_from, dscr_floor, ltv_ceiling, disposition_cap_rate, hold_cap_rate,
          acq_irr, capex_irr, refi_trigger_bps, payout_pct, notes)
       VALUES (3, '2026-10-14', 1.25, 0.40, 0.065, 0.075, 0.12, 0.15, 150, 0.0, 'test: revert values')`,
    ).run();
    const before = classifyLatestScore(db, 'c1', liveScoringRegime(db, RULESET, RCT));
    expect(before.state).toBe('stale');
    expect(before.staleReasons.join(' ')).toMatch(/governorRegime stamp 1:1\.25:0\.4:0\.085 does not match the live governor regime 3:1\.25:0\.4:0\.085/);
    await persistAndLogScore(db, 'c1', { ...STRONG, dealId: 'c1' }, RULESET, RCT); // re-score under v3
    expect(classifyLatestScore(db, 'c1', liveScoringRegime(db, RULESET, RCT)).state).toBe('current');
  });

  it('a MISSING governorRegime stamp on an otherwise-current row is stale, never current', async () => {
    const db = freshDb();
    await seed(db, 'c3');
    expect(classifyLatestScore(db, 'c3', liveScoringRegime(db, RULESET, RCT)).state).toBe('current'); // control
    db.prepare(`UPDATE acq_scores SET score_json = json_remove(score_json, '$.governorRegime') WHERE candidate_id = 'c3'`).run();
    const c = classifyLatestScore(db, 'c3', liveScoringRegime(db, RULESET, RCT));
    expect(c.state).toBe('stale');
    expect(c.staleReasons.join(' ')).toMatch(/governorRegime stamp missing/);
  });

  it('a score made under the interim (different-valued) regime is stale once values revert', async () => {
    const db = freshDb();
    db.prepare(`INSERT INTO acq_candidates (id, source, status) VALUES ('c2', 'manual', 'active')`).run();
    bumpGovernor(db, 2);             // v2: 1.30 live while scoring
    await persistAndLogScore(db, 'c2', { ...STRONG, dealId: 'c2' }, RULESET, RCT);
    db.prepare(
      `INSERT INTO capital_config
         (version, effective_from, dscr_floor, ltv_ceiling, disposition_cap_rate, hold_cap_rate,
          acq_irr, capex_irr, refi_trigger_bps, payout_pct, notes)
       VALUES (3, '2026-10-14', 1.25, 0.40, 0.065, 0.075, 0.12, 0.15, 150, 0.0, 'test: revert values')`,
    ).run();
    expect(classifyLatestScore(db, 'c2', liveScoringRegime(db, RULESET, RCT)).state).toBe('stale');
  });
});

describe('classifyLatestScore — tier/verdict-incoherent legacy rows (refute H3)', () => {
  it("a pre-fix row with tier T1 next to a governor-demoted PASS verdict is stale, not current", async () => {
    const db = freshDb();
    await seed(db, 'c1');
    db.prepare(`UPDATE acq_scores SET verdict = 'PASS' WHERE candidate_id = 'c1'`).run(); // tier stays T1
    const c = classifyLatestScore(db, 'c1', liveScoringRegime(db, RULESET, RCT));
    expect(c.state).toBe('stale');
    expect(c.staleReasons.join(' ')).toMatch(/tier T1.*verdict PASS/);
  });

  it('a KILLED verdict next to tier T2 is stale', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    db.prepare(`UPDATE acq_scores SET verdict = 'KILLED', tier = 'T2' WHERE candidate_id = 'c1'`).run();
    expect(classifyLatestScore(db, 'c1', liveScoringRegime(db, RULESET, RCT)).state).toBe('stale');
  });
});

// ── Refute round 3 V1: freshness must also cover ENGINE-LOGIC changes. computeInputsVersion hashes
// input + ruleset + RCT + governor fingerprint, not engine code, so a row persisted before an engine
// change that moved the composite (without a ruleset bump) used to classify 'current'.
describe('classifyLatestScore — engine output re-derivation (refute round 3 V1)', () => {
  it('a stored composite that the live engine no longer reproduces is stale', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    db.prepare(`UPDATE acq_scores SET composite = 71.6, score_json = json_set(score_json, '$.composite', 71.6) WHERE candidate_id = 'c1'`).run();
    const c = classifyLatestScore(db, 'c1', liveScoringRegime(db, RULESET, RCT));
    expect(c.state).toBe('stale');
    expect(c.staleReasons.join(' ')).toMatch(/engine output differs from stored score/);
  });

  it('a stored floor actual the live engine no longer reproduces is stale', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    db.prepare(`UPDATE acq_scores SET score_json = json_set(score_json, '$.floors[0].actual', 0.99) WHERE candidate_id = 'c1'`).run();
    expect(classifyLatestScore(db, 'c1', liveScoringRegime(db, RULESET, RCT)).state).toBe('stale');
  });

  it('a clean row (including a governor-demoted one, compared post-proxy) stays current', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    expect(classifyLatestScore(db, 'c1', liveScoringRegime(db, RULESET, RCT)).state).toBe('current');
    // Invalid governor set ⇒ the proxy demotes to PASS/PASS on persist; the re-run must apply the
    // SAME demotion or this row would read stale.
    db.prepare(
      `INSERT INTO capital_config
         (version, effective_from, dscr_floor, ltv_ceiling, disposition_cap_rate, hold_cap_rate,
          acq_irr, capex_irr, refi_trigger_bps, payout_pct, notes)
       VALUES (2, '2026-10-13', 1.25, 0, 0.065, 0.075, 0.12, 0.15, 150, 0.0, 'test: invalid governor set')`,
    ).run();
    db.prepare(`INSERT INTO acq_candidates (id, source, status) VALUES ('c2', 'manual', 'active')`).run();
    await persistAndLogScore(db, 'c2', { ...STRONG, dealId: 'c2' }, RULESET, RCT);
    const c2 = classifyLatestScore(db, 'c2', liveScoringRegime(db, RULESET, RCT));
    expect(c2.score?.verdict).toBe('PASS');
    expect(c2.state).toBe('current');
  });

  it('rescoreStaleCandidates re-derives an engine-output mismatch on the SAME key (audit X1: superseded in place)', async () => {
    const db = freshDb();
    await seed(db, 'c1');
    // Simulate a pre-engine-change row: same key, different stored output. UNIQUE(score_input_id)
    // forbids a second row, so persistAndLogScore must supersede this one — the sweep re-scores it.
    db.prepare(`UPDATE acq_scores SET composite = 71.6, score_json = json_set(score_json, '$.composite', 71.6) WHERE candidate_id = 'c1'`).run();
    const r = await rescoreStaleCandidates(db, RULESET, RCT);
    expect(r.alreadyCurrent).toBe(0);
    expect(r.unrescorable).toEqual([]);
    expect(r.rescored).toBe(1);
    expect(classifyLatestScore(db, 'c1', liveScoringRegime(db, RULESET, RCT)).state).toBe('current');
    expect((db.prepare('SELECT COUNT(*) AS n FROM acq_scores').get() as { n: number }).n).toBe(1);
  });
});
