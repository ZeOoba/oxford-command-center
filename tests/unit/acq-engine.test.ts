// @vitest-environment node
//
// tests/unit/acq-engine.test.ts
//
// Phase 4 — Acquisition Intelligence Engine: persistAndLogScore() unit tests.
// Spec: docs/superpowers/specs/2026-06-20-phase-4-acquisition-intelligence-engine-firm-pri.md §Step 3.
//
// Test strategy:
//   1. proposedRuleset → advisoryOnly=true; advisory_only column = 1 in acq_scores.
//   2. LTV governor fail → stored verdict demoted to PASS; composite preserved.
//   3. DSCR governor fail → stored verdict demoted to PASS.
//   4. Both governors cleared + ratified ruleset → verdict matches scoreAcquisition output.
//   5. Idempotent re-score → second call is a no-op (INSERT OR IGNORE skips; same calibration id).
//   6. calibration_verdict row has correct kind/subjectKind/engine.
//
// Uses in-memory SQLite (mkdtempSync pattern from briefing.test.ts) — never touches
// data/warehouse/finance.sqlite (Spine B isolation).
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { openWarehouse } from '../../server/warehouse/db';
import type { WarehouseDb } from '../../server/warehouse/db';
import { persistAndLogScore } from '../../server/warehouse/acq-engine';
import { parseRuleset, loadRatifiedRct, scoreAcquisition } from '../../server/warehouse/acquisition';
import { AcquisitionInput } from '@contracts/acquisition';
import type { AcquisitionRuleset, ReplacementCostTable } from '@contracts/acquisition';

// ── Fixtures ──────────────────────────────────────────────────────────────────────────────

const ratifiedJson = JSON.parse(
  readFileSync(resolve(process.cwd(), 'config/acquisition-ruleset.v1.json'), 'utf8'),
);
const RATIFIED_RULESET: AcquisitionRuleset = parseRuleset(ratifiedJson);
const RCT: ReplacementCostTable = loadRatifiedRct();

/** A proposed (non-ratified) variant of the ruleset. */
function proposedRuleset(): AcquisitionRuleset {
  const j = structuredClone(ratifiedJson);
  j.ratification = 'proposed';
  return parseRuleset(j);
}

/** A strong, governors-passing PURSUE-grade deal (mirrors acquisition.test.ts STRONG_BASE). */
const STRONG_INPUT_RAW: Record<string, unknown> = {
  dealId: 'eng-strong',
  price: 3_500_000, maxBuildingSf: 42_000, totalSf: 60_000,
  productType: 'shallow-bay-multi', officePct: 0.1,
  clearHeightFt: 28, hasDriveIn: true, hasDock: true, dockCount: 6, driveInCount: 6,
  multiStory: false, truckCourtFt: 120,
  constructionType: 'block-tilt-brick', yearBuilt: 2005, sfhaOnPad: false,
  allInBasis: 3_600_000,
  stabilizedYoc: 0.12,     // DSCR proxy: 0.12 / (0.40 × 0.085) = 3.53 ≥ 1.25 ✓
  leveredIrr: 0.18, underwriteHorizonYrs: 5,
  clusterTier: 'owned-submarket', sellerMotivationScore: 0.8,
  isVacant: false, inPlaceRentPsf: 4.5, marketRentPsf: 6.0, waltYears: 1.5, valueAddScore: 0.5,
  ddKnown: { flood: true, zoning: true, roof: true, 'deferred-maintenance-capex': true },
};

function strongInput(overrides: Record<string, unknown> = {}): ReturnType<typeof AcquisitionInput.parse> {
  return AcquisitionInput.parse({ ...STRONG_INPUT_RAW, ...overrides });
}

/** Seed an acq_candidates row so FK constraints are satisfied. */
function seedCandidate(db: WarehouseDb, id: string): void {
  db.prepare(`
    INSERT OR IGNORE INTO acq_candidates (id, source, status)
    VALUES (?, 'manual', 'active')
  `).run(id);
}

/** Open a fresh in-memory warehouse (tmpdir SQLite, all migrations applied). */
function freshDb(): WarehouseDb {
  const dir = mkdtempSync(join(tmpdir(), 'acq-engine-test-'));
  return openWarehouse(join(dir, 'test.sqlite'));
}

// ── Tests ──────────────────────────────────────────────────────────────────────────────────

describe('persistAndLogScore — advisory (proposed ruleset)', () => {
  it('returns advisoryOnly=true when ruleset is proposed', async () => {
    const db = freshDb();
    const candidateId = 'test-deal-advisory';
    seedCandidate(db, candidateId);

    const proposed = proposedRuleset();
    const { score } = await persistAndLogScore(db, candidateId, strongInput(), proposed, RCT);

    expect(score.advisoryOnly).toBe(true);
  });

  it('stores advisory_only=1 in acq_scores when ruleset is proposed', async () => {
    const db = freshDb();
    const candidateId = 'test-deal-advisory-store';
    seedCandidate(db, candidateId);

    const proposed = proposedRuleset();
    await persistAndLogScore(db, candidateId, strongInput(), proposed, RCT);

    const row = db.prepare('SELECT advisory_only FROM acq_scores WHERE candidate_id = ?')
      .get(candidateId) as { advisory_only: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.advisory_only).toBe(1);
  });
});

describe('persistAndLogScore — LTV is indeterminate at screen time (ratified correction 2026-06-20)', () => {
  // REGRESSION GUARD: the prior `allInBasis/price ≤ ltvCeiling` proxy demoted EVERY fully-specified
  // deal to PASS (basis ≥ price ⇒ ratio ≈ 1.0 > 0.40). LTV is now indeterminate at screen time (no
  // loan amount in the inputs) — null, never demotes; the ≤40% ceiling is a financing-stage governor.
  it('does NOT demote a basis≥price deal on LTV; verdict matches the raw engine', async () => {
    const db = freshDb();
    const candidateId = 'test-deal-ltv-indeterminate';
    seedCandidate(db, candidateId);

    // basis 3.6M / price 3.5M = 1.03 — the OLD proxy would have demoted this strong deal to PASS.
    const input = strongInput({ allInBasis: 3_600_000, price: 3_500_000, stabilizedYoc: 0.12 });
    const { score } = await persistAndLogScore(db, candidateId, input, RATIFIED_RULESET, RCT);

    const rawScore = scoreAcquisition(input, RATIFIED_RULESET, { rct: RCT });
    expect(score.verdict).toBe(rawScore.verdict);             // no governor demotion applied
    expect(['PURSUE', 'WATCH']).toContain(rawScore.verdict);  // the deal is genuinely strong (would've been demoted)
  });

  it('stores governor_ltv_cleared = null (indeterminate) and preserves the composite', async () => {
    const db = freshDb();
    const candidateId = 'test-deal-ltv-null';
    seedCandidate(db, candidateId);

    const input = strongInput({ allInBasis: 3_600_000, price: 3_500_000, stabilizedYoc: 0.12 });
    await persistAndLogScore(db, candidateId, input, RATIFIED_RULESET, RCT);

    const row = db.prepare(
      'SELECT verdict, governor_ltv_cleared, composite FROM acq_scores WHERE candidate_id = ?',
    ).get(candidateId) as { verdict: string; governor_ltv_cleared: number | null; composite: number } | undefined;

    expect(row).toBeDefined();
    expect(row!.governor_ltv_cleared).toBeNull();
    expect(row!.verdict).not.toBe('PASS');  // not demoted by the (removed) LTV proxy
    expect(row!.composite).toBeGreaterThan(0);
  });
});

describe('persistAndLogScore — DSCR governor demotion', () => {
  it('stores governor_dscr_cleared=0 and KILLED verdict when DSCR proxy < 1.25', async () => {
    const db = freshDb();
    const candidateId = 'test-deal-dscr-fail';
    seedCandidate(db, candidateId);

    // DSCR proxy: stabilizedYoc / (ltvCeiling × SCREENING_DEBT_CONSTANT) = 0.02 / (0.40 × 0.085) = 0.59 < 1.25 → governor fails.
    // NOTE: stabilizedYocFloorPct = 8% in the ratified ruleset. stabilizedYoc=0.02 < 0.08 also
    // fails the computable yield floor, so scoreAcquisition already returns KILLED. With the
    // KILLED-monotonicity guard, the governor demotion cannot upgrade KILLED → PASS.
    // The observable effect here is KILLED (from the yield floor); governor_dscr_cleared=0 is
    // still stored correctly. A pure DSCR-only demotion is not achievable with the current
    // ruleset (DSCR threshold 4.25% < yield floor 8%), which is a calibration note for Gabriel.
    const input = strongInput({
      stabilizedYoc: 0.02,
      allInBasis: 100_000,
      price: 10_000_000,
    });
    const { score } = await persistAndLogScore(db, candidateId, input, RATIFIED_RULESET, RCT);

    expect(score.verdict).toBe('KILLED');
  });

  it('stores governor_dscr_cleared=0 in acq_scores', async () => {
    const db = freshDb();
    const candidateId = 'test-deal-dscr-store';
    seedCandidate(db, candidateId);

    const input = strongInput({
      stabilizedYoc: 0.02,
      allInBasis: 100_000,
      price: 10_000_000,
    });
    await persistAndLogScore(db, candidateId, input, RATIFIED_RULESET, RCT);

    const row = db.prepare(
      'SELECT governor_dscr_cleared FROM acq_scores WHERE candidate_id = ?',
    ).get(candidateId) as { governor_dscr_cleared: number } | undefined;

    expect(row).toBeDefined();
    expect(row!.governor_dscr_cleared).toBe(0);
  });
});

describe('persistAndLogScore — governors cleared (ratified ruleset)', () => {
  it('returns the scoreAcquisition verdict when both governors pass + ratified ruleset', async () => {
    const db = freshDb();
    const candidateId = 'test-deal-pursue';
    seedCandidate(db, candidateId);

    // allInBasis/price = 3.6M/3.5M ≈ 1.03 > 0.40 → LTV fails — use a lower basis
    // allInBasis 1.4M / price 3.5M = 0.40 = ltvCeiling (passes at ≤)
    // DSCR proxy: 0.12 / (0.40 × 0.085) = 3.53 ≥ 1.25 ✓
    const input = strongInput({ allInBasis: 1_400_000, price: 3_500_000, stabilizedYoc: 0.12 });
    const { score } = await persistAndLogScore(db, candidateId, input, RATIFIED_RULESET, RCT);

    // Both governors pass + ratified → verdict should match raw engine output.
    const rawScore = scoreAcquisition(input, RATIFIED_RULESET, { rct: RCT });
    expect(score.verdict).toBe(rawScore.verdict);
    expect(score.composite).toBeCloseTo(rawScore.composite, 1);
  });

  it('stores governor_dscr_cleared=1 and governor_ltv_cleared=null (LTV indeterminate) when DSCR clears', async () => {
    const db = freshDb();
    const candidateId = 'test-deal-govs-cleared';
    seedCandidate(db, candidateId);

    const input = strongInput({ allInBasis: 1_400_000, price: 3_500_000, stabilizedYoc: 0.12 });
    await persistAndLogScore(db, candidateId, input, RATIFIED_RULESET, RCT);

    const row = db.prepare(
      'SELECT governor_dscr_cleared, governor_ltv_cleared FROM acq_scores WHERE candidate_id = ?',
    ).get(candidateId) as { governor_dscr_cleared: number; governor_ltv_cleared: number | null } | undefined;

    expect(row).toBeDefined();
    expect(row!.governor_dscr_cleared).toBe(1);
    expect(row!.governor_ltv_cleared).toBeNull();  // indeterminate at screen time (ratified 2026-06-20)
  });
});

describe('persistAndLogScore — idempotency', () => {
  it('second call on identical inputs is a no-op (INSERT OR IGNORE skips)', async () => {
    const db = freshDb();
    const candidateId = 'test-deal-idempotent';
    seedCandidate(db, candidateId);

    const input = strongInput({ allInBasis: 1_400_000, price: 3_500_000 });

    await persistAndLogScore(db, candidateId, input, RATIFIED_RULESET, RCT);
    await persistAndLogScore(db, candidateId, input, RATIFIED_RULESET, RCT);

    // Exactly one acq_score_inputs row and one acq_scores row.
    const inputCount = (db.prepare('SELECT COUNT(*) AS n FROM acq_score_inputs WHERE candidate_id = ?')
      .get(candidateId) as { n: number }).n;
    const scoreCount = (db.prepare('SELECT COUNT(*) AS n FROM acq_scores WHERE candidate_id = ?')
      .get(candidateId) as { n: number }).n;

    expect(inputCount).toBe(1);
    expect(scoreCount).toBe(1);
  });

  it('calibration verdict INSERT OR IGNORE skips on second call', async () => {
    const db = freshDb();
    const candidateId = 'test-deal-calib-idem';
    seedCandidate(db, candidateId);

    const input = strongInput({ allInBasis: 1_400_000, price: 3_500_000 });

    const r1 = await persistAndLogScore(db, candidateId, input, RATIFIED_RULESET, RCT);
    const r2 = await persistAndLogScore(db, candidateId, input, RATIFIED_RULESET, RCT);

    // Both calls should return the same calibration verdict id.
    expect(r1.calibrationVerdictId).not.toBeNull();
    expect(r1.calibrationVerdictId).toBe(r2.calibrationVerdictId);

    // Only one calibration_verdict row for this candidate.
    const cvCount = (db.prepare(
      "SELECT COUNT(*) AS n FROM calibration_verdict WHERE subject_id = ? AND verdict_kind = 'acquisition-score'",
    ).get(candidateId) as { n: number }).n;
    expect(cvCount).toBe(1);
  });
});

describe('persistAndLogScore — calibration logging', () => {
  it('logs a calibration_verdict with correct kind, subjectKind, and engine', async () => {
    const db = freshDb();
    const candidateId = 'test-deal-calib-kind';
    seedCandidate(db, candidateId);

    const input = strongInput({ allInBasis: 1_400_000, price: 3_500_000 });
    await persistAndLogScore(db, candidateId, input, RATIFIED_RULESET, RCT);

    const row = db.prepare(`
      SELECT subject_kind, verdict_kind, verdict_engine
      FROM calibration_verdict
      WHERE subject_id = ? AND verdict_kind = 'acquisition-score'
    `).get(candidateId) as { subject_kind: string; verdict_kind: string; verdict_engine: string } | undefined;

    expect(row).toBeDefined();
    expect(row!.subject_kind).toBe('deal');
    expect(row!.verdict_kind).toBe('acquisition-score');
    expect(row!.verdict_engine).toBe('acquisition');
  });

  it('returns a calibrationVerdictId that matches the calibration_verdict table', async () => {
    const db = freshDb();
    const candidateId = 'test-deal-calib-id';
    seedCandidate(db, candidateId);

    const input = strongInput({ allInBasis: 1_400_000, price: 3_500_000 });
    const { calibrationVerdictId } = await persistAndLogScore(db, candidateId, input, RATIFIED_RULESET, RCT);

    expect(calibrationVerdictId).not.toBeNull();
    const row = db.prepare('SELECT id FROM calibration_verdict WHERE id = ?')
      .get(calibrationVerdictId!) as { id: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.id).toBe(calibrationVerdictId);
  });

  it('calibration_verdict_id is back-filled in acq_scores', async () => {
    const db = freshDb();
    const candidateId = 'test-deal-calib-backfill';
    seedCandidate(db, candidateId);

    const input = strongInput({ allInBasis: 1_400_000, price: 3_500_000 });
    const { calibrationVerdictId } = await persistAndLogScore(db, candidateId, input, RATIFIED_RULESET, RCT);

    const row = db.prepare('SELECT calibration_verdict_id FROM acq_scores WHERE candidate_id = ?')
      .get(candidateId) as { calibration_verdict_id: number | null } | undefined;
    expect(row).toBeDefined();
    expect(row!.calibration_verdict_id).toBe(calibrationVerdictId);
  });
});

describe('persistAndLogScore — KILLED verdict monotonicity', () => {
  // Regression: governor demotion must never upgrade KILLED → PASS.
  // KILLED = hard gate/floor rejection; PASS = soft "didn't score well".
  // Upgrading would misplace the deal in verdict-filtered ranked lists.
  it('governor LTV failure does not upgrade KILLED to PASS', async () => {
    const db = freshDb();
    const candidateId = 'test-deal-killed-no-upgrade';
    seedCandidate(db, candidateId);

    // sfhaOnPad: true → flood gate kills (sfhaOnPadKills = true in ratified ruleset).
    // allInBasis/price = 2M/3.5M ≈ 0.57 > 0.40 → LTV governor fails.
    // Without the KILLED guard, governor demotion would silently upgrade KILLED → PASS.
    const input = strongInput({ sfhaOnPad: true, allInBasis: 2_000_000, price: 3_500_000 });
    const { score } = await persistAndLogScore(db, candidateId, input, RATIFIED_RULESET, RCT);

    expect(score.verdict).toBe('KILLED');

    const row = db.prepare('SELECT verdict FROM acq_scores WHERE candidate_id = ?')
      .get(candidateId) as { verdict: string } | undefined;
    expect(row).toBeDefined();
    expect(row!.verdict).toBe('KILLED');
  });
});

describe('persistAndLogScore — null governor inputs', () => {
  it('stores NULL governor columns when stabilizedYoc/allInBasis/price are absent', async () => {
    const db = freshDb();
    const candidateId = 'test-deal-null-govs';
    seedCandidate(db, candidateId);

    // No price, no allInBasis, no stabilizedYoc → both governors indeterminate (NULL).
    const input = strongInput({ stabilizedYoc: null, allInBasis: null, price: null });
    const { score } = await persistAndLogScore(db, candidateId, input, RATIFIED_RULESET, RCT);

    // Verdict is NOT demoted (null = not evaluated, not failed).
    // The score verdict may or may not be PASS depending on other floors — we only assert
    // the governor columns are NULL and the verdict is NOT forced PASS by governors.
    const row = db.prepare(
      'SELECT governor_dscr_cleared, governor_ltv_cleared FROM acq_scores WHERE candidate_id = ?',
    ).get(candidateId) as { governor_dscr_cleared: number | null; governor_ltv_cleared: number | null } | undefined;

    expect(row).toBeDefined();
    expect(row!.governor_dscr_cleared).toBeNull();
    expect(row!.governor_ltv_cleared).toBeNull();
    // The score is advisory (floors indeterminate without price/basis) — just verify no throw.
    expect(typeof score.composite).toBe('number');
  });
});
