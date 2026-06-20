// server/warehouse/acq-engine.ts
//
// Acquisition Intelligence Engine — warehouse persistence + calibration logging.
// Spec: docs/superpowers/specs/2026-06-20-phase-4-acquisition-intelligence-engine-firm-pri.md §Step 3.
//
// FINANCIAL-DECISION CODE — CLAUDE.md Engineering OS: any change to governor logic here
// requires a MANDATORY adversarial refute pass before merge. See architecture/status.json
// review_detail for the current pending-refute status.
//
// Governor enforcement (Invariant 4):
//   DSCR proxy: stabilizedYoc / (ltvCeiling × SCREENING_DEBT_CONSTANT) ≥ dscrFloor
//   LTV proxy:  allInBasis / price ≤ ltvCeiling
//   Either governor FAILS (false) → verdict hard-demoted to 'PASS' regardless of composite.
//   Governor constants loaded via loadGovernors() — NEVER hardcoded inline (except the
//   screening proxy constant below, which is a screening heuristic, not a governor constant).
//
// SCREENING_DEBT_CONSTANT: 8.5% annual debt service constant (7.25% rate proxy on 30-yr
// amortizing @ 40% LTV). Gabriel G3 decision — pending formal ratification of
// `screeningDebtRate` in CAPITAL_CONFIG; NULL fallback applies until then.
//
// Imports governors exclusively via ./governors (never directly from capital-config) to
// satisfy the governance-check `acquisition_scorecard_governor_coupling` rule (Step 9).
import type { WarehouseDb } from './db';
import { loadGovernors } from './governors';
import { scoreAcquisition, computeInputsVersion, RATIFIED_RULESET_PATH, REPLACEMENT_COST_TABLE_PATH } from './acquisition';
import { logVerdicts } from './calibration';
import { CalibrationVerdictSchema } from '../../src/contracts/warehouse';
import type {
  AcquisitionInput,
  AcquisitionRuleset,
  AcquisitionScore,
  ReplacementCostTable,
} from '../../src/contracts/acquisition';

// Gabriel G3 pending: screening heuristic for DSCR proxy at screen time. NOT a capital-config
// governor constant — it is a screening heuristic stored here until Gabriel ratifies
// `screeningDebtRate` in CAPITAL_CONFIG. A future governance rule (Step 9) will
// assert this file loads governors via ./governors, not capital-config directly.
const SCREENING_DEBT_CONSTANT = 0.085; // 8.5% — 7.25% rate proxy, 30-yr amortizing, LTV=40%

export interface PersistAndLogScoreResult {
  score: AcquisitionScore;
  calibrationVerdictId: number | null;
}

/**
 * Score a candidate, evaluate governor thresholds, persist to acq_score_inputs + acq_scores,
 * log to calibration_verdict (fail-open — mirrors logVerdicts pattern).
 *
 * Returns the AcquisitionScore (with verdict reflecting governor demotion) + calibration verdict id.
 *
 * GOVERNOR ENFORCEMENT (Invariant 4):
 *   - DSCR proxy: stabilizedYoc / (ltvCeiling * SCREENING_DEBT_CONSTANT). Inputs absent → NULL.
 *   - LTV proxy: allInBasis / price. Either input absent → NULL.
 *   - Either governor FAILS → verdict hard-demoted to 'PASS' regardless of composite.
 *   - Composite is preserved (analysts can see the underlying score).
 *
 * IDEMPOTENT: a second call on identical (candidateId, input, ruleset, rct) is a no-op
 * (UNIQUE constraint on candidate_id, inputs_version in acq_score_inputs).
 *
 * FAIL-OPEN calibration: logVerdicts() never throws; a calibration failure records a
 * data_quality_issues row and returns {written:0} but does NOT fail the score persist.
 */
export async function persistAndLogScore(
  db: WarehouseDb,
  candidateId: string,
  input: AcquisitionInput,
  ruleset: AcquisitionRuleset,
  rct: ReplacementCostTable,
): Promise<PersistAndLogScoreResult> {
  // 1. Compute the score (pure — no side effects).
  const score = scoreAcquisition(input, ruleset, { rct });

  // 2. Compute the inputs_version dedup key.
  const inputsVersion = computeInputsVersion(input, ruleset, rct.rctVersion);

  // 3. Load governors at query time (never hardcoded — Invariant 4).
  const governors = loadGovernors(db);

  // 4. Evaluate governor booleans.
  // DSCR proxy: stabilizedYoc / (ltvCeiling * SCREENING_DEBT_CONSTANT) >= dscrFloor
  let governorDscrCleared: boolean | null = null;
  if (input.stabilizedYoc !== null && input.stabilizedYoc !== undefined) {
    const dscrProxy = input.stabilizedYoc / (governors.ltvCeiling * SCREENING_DEBT_CONSTANT);
    governorDscrCleared = dscrProxy >= governors.dscrFloor;
  }
  // LTV proxy: allInBasis / price <= ltvCeiling
  let governorLtvCleared: boolean | null = null;
  if (
    input.allInBasis !== null && input.allInBasis !== undefined &&
    input.price !== null && input.price !== undefined && input.price > 0
  ) {
    governorLtvCleared = (input.allInBasis / input.price) <= governors.ltvCeiling;
  }

  // 5. Governor demotion: if either governor FAILS (false), hard-override verdict to 'PASS'.
  // Guard: never upgrade KILLED → PASS. KILLED is a hard gate/floor rejection; PASS is a soft
  // "didn't score well". Demoting KILLED would misplace it in verdict-filtered ranked lists
  // (analysts querying verdict=KILLED would miss it; verdict=PASS would surface a gate reject).
  let finalVerdict = score.verdict;
  if ((governorDscrCleared === false || governorLtvCleared === false) && finalVerdict !== 'KILLED') {
    finalVerdict = 'PASS';
  }

  // 6. Advisory: use the engine's own advisoryOnly flag as the source of truth.
  // This guards against future engine conditions beyond ratification (e.g. RCT version).
  const advisoryOnly = score.advisoryOnly;

  // 7. INSERT OR IGNORE into acq_score_inputs (idempotent on UNIQUE(candidate_id, inputs_version)).
  db.prepare(`
    INSERT OR IGNORE INTO acq_score_inputs
      (candidate_id, inputs_version, input_json, ruleset_version, rct_version, scored_by)
    VALUES (?, ?, ?, ?, ?, 'api')
  `).run(
    candidateId,
    inputsVersion,
    JSON.stringify(input),
    ruleset.rulesetVersion,
    rct.rctVersion,
  );

  // Retrieve the score_input_id (whether just inserted or already present).
  const scoreInputRow = db.prepare(`
    SELECT id FROM acq_score_inputs WHERE candidate_id = ? AND inputs_version = ?
  `).get(candidateId, inputsVersion) as { id: number } | undefined;

  if (!scoreInputRow) {
    // Should never happen after the INSERT OR IGNORE above.
    throw new Error(`acq-engine: could not resolve score_input_id for candidate=${candidateId} inputs_version=${inputsVersion}`);
  }
  const scoreInputId = scoreInputRow.id;

  // 8. INSERT OR IGNORE into acq_scores (idempotent on UNIQUE(score_input_id)).
  db.prepare(`
    INSERT OR IGNORE INTO acq_scores (
      candidate_id, score_input_id, inputs_version,
      composite, tier, verdict, advisory_only,
      capped_at_t2, gates_passed, floors_passed, floor_indeterminate,
      governor_dscr_cleared, governor_ltv_cleared,
      score_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    candidateId,
    scoreInputId,
    inputsVersion,
    score.composite,
    score.tier,
    finalVerdict,
    advisoryOnly ? 1 : 0,
    score.cappedAtT2 ? 1 : 0,
    score.gatesPassed ? 1 : 0,
    score.floorsPassed ? 1 : 0,
    score.floorIndeterminate ? 1 : 0,
    governorDscrCleared === null ? null : (governorDscrCleared ? 1 : 0),
    governorLtvCleared === null ? null : (governorLtvCleared ? 1 : 0),
    JSON.stringify({ ...score, verdict: finalVerdict }),
  );
  // changes === 0 means this is an idempotent re-score — no-op is correct.

  // 9. Retrieve the acq_scores id for calibration FK update.
  const acqScoreRow = db.prepare(`
    SELECT id FROM acq_scores WHERE score_input_id = ?
  `).get(scoreInputId) as { id: number } | undefined;

  // 10. Build + log the calibration verdict (fail-open — never throws to caller).
  //
  // calibration_verdict.inputs_version is a FK to calibration_inputs_version.inputs_version.
  // For acquisition verdicts the inputs_version is derived from (input, ruleset, rctVersion) —
  // a different hash than the ledger-state hash used by the warehouse analytics engines.
  // We seed a row in calibration_inputs_version with synthetic fingerprint fields so the FK
  // constraint is satisfied. INSERT OR IGNORE makes this idempotent across re-scores.
  db.prepare(`
    INSERT OR IGNORE INTO calibration_inputs_version
      (inputs_version, ledger_fingerprint, config_hash, code_version, config_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    inputsVersion,
    `acq-input:${inputsVersion}`,                 // synthetic — no ledger state
    `acq-ruleset:${ruleset.rulesetVersion}`,       // synthetic — ruleset identity
    process.env.ORA_CODE_VERSION ?? process.env.GIT_SHA ?? 'dev',
    JSON.stringify({ source: 'acq-engine', rulesetVersion: ruleset.rulesetVersion, rctVersion: rct.rctVersion }),
  );

  let calibrationVerdictId: number | null = null;
  try {
    const direction: 'up' | 'flat' | 'down' =
      finalVerdict === 'PURSUE' ? 'up' : finalVerdict === 'WATCH' ? 'flat' : 'down';

    // AcquisitionScore.confidence is a string enum ('confirmed'|'estimated'|'derived').
    // CalibrationVerdictSchema.confidence is number | null. Map to a numeric proxy.
    const confidenceNum: number =
      score.confidence === 'confirmed' ? 1.0 :
      score.confidence === 'estimated' ? 0.75 : 0.5;

    const verdictRow = CalibrationVerdictSchema.parse({
      subjectKind: 'deal',
      subjectId: candidateId,
      verdictKind: 'acquisition-score',
      verdictSubkind: '',
      asOfPeriod: new Date().getFullYear().toString(),
      verdictEngine: 'acquisition',
      predictedBand: finalVerdict,
      predictedValue: score.composite,
      predictedUnit: 'score-0-100',
      confidence: confidenceNum,
      direction,
      horizonPeriods: 2,
      inputsVersion,
      emittedBy: 'acq-engine:persistAndLogScore',
    });

    const logResult = logVerdicts(db, [verdictRow]);

    // 11. If the calibration INSERT succeeded, fetch the new verdict id and back-fill FK.
    if (logResult.written > 0 && acqScoreRow) {
      // The inserted row matches our dedup_key — fetch it by dedup key fields.
      const cvRow = db.prepare(`
        SELECT id FROM calibration_verdict
        WHERE subject_kind = 'deal'
          AND subject_id = ?
          AND verdict_kind = 'acquisition-score'
          AND inputs_version = ?
        ORDER BY id DESC
        LIMIT 1
      `).get(candidateId, inputsVersion) as { id: number } | undefined;

      if (cvRow) {
        calibrationVerdictId = cvRow.id;
        db.prepare(`
          UPDATE acq_scores SET calibration_verdict_id = ? WHERE id = ?
        `).run(calibrationVerdictId, acqScoreRow.id);
      }
    } else if (logResult.written === 0 && acqScoreRow) {
      // Already logged (idempotent re-score) — fetch the existing verdict id.
      const cvRow = db.prepare(`
        SELECT id FROM calibration_verdict
        WHERE subject_kind = 'deal'
          AND subject_id = ?
          AND verdict_kind = 'acquisition-score'
          AND inputs_version = ?
        ORDER BY id DESC
        LIMIT 1
      `).get(candidateId, inputsVersion) as { id: number } | undefined;
      if (cvRow) calibrationVerdictId = cvRow.id;
    }
  } catch {
    // Calibration logging is fail-open — a failure here MUST NOT fail the score persist.
    // The acq_scores row is already written; calibration_verdict_id stays null.
  }

  return {
    score: { ...score, verdict: finalVerdict },
    calibrationVerdictId,
  };
}

// Re-export the loader functions for callers that need them (avoids re-importing acquisition.ts).
export { loadGovernors };
// Export the paths so the API layer can load rulesets consistently.
export { RATIFIED_RULESET_PATH, REPLACEMENT_COST_TABLE_PATH };
