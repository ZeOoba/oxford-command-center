// server/warehouse/acq-engine.ts
//
// Acquisition Intelligence Engine — warehouse persistence + calibration logging.
// Spec: docs/superpowers/specs/2026-06-20-phase-4-acquisition-intelligence-engine-firm-pri.md §Step 3.
//
// FINANCIAL-DECISION CODE — CLAUDE.md Engineering OS: any change to governor logic here
// requires a MANDATORY adversarial refute pass before merge. See architecture/status.json
// review_detail for the current pending-refute status.
//
// Governor enforcement (Invariant 4) — delegated to the SHARED, edge-portable proxy module
// acq-governor-proxy.ts so the ranked path, the ad-hoc /acquisition/score route, and the edge
// Pages Function apply IDENTICAL demotion:
//   DSCR proxy: stabilizedYoc / (ltvCeiling × SCREENING_DEBT_CONSTANT) ≥ dscrFloor.
//   LTV proxy:  INDETERMINATE at screen time (no loan amount in the inputs) → null, never demotes.
//               The ≤40% LTV ceiling is a FINANCING-stage governor; no pipeline-candidate code path
//               enforces a per-deal LTV today (see acq-governor-proxy.ts header — the capital_config
//               CHECK bounds only the governor value). Gabriel-ratified correction 2026-06-20 — replaces the
//               prior `allInBasis/price ≤ ltvCeiling` formula, which demoted every fully-specified
//               deal to PASS (basis ≥ price ⇒ ratio ≈ 1.0 > 0.40).
//   A FAILED governor hard-demotes the verdict to 'PASS'; KILLED is never upgraded.
//
// Governor VALUES loaded via loadGovernors() (never hardcoded) — satisfies the governance-check
// `acquisition_scorecard_governor_coupling` rule (Step 9). The ratified SCREENING_DEBT_CONSTANT
// lives in acq-governor-proxy.ts (a screening heuristic, not a capital_config governor constant).
import type { WarehouseDb } from './db';
import { loadGovernors } from './governors';
import { applyGovernorProxyToScore, governorFingerprint } from './acq-governor-proxy';
import { storedVsLiveDiffs } from './acq-score-compare';
import type { StoredScoreColumns } from './acq-score-compare';
import { AcquisitionScore as AcquisitionScoreSchema } from '../../src/contracts/acquisition';
import {
  scoreAcquisition,
  computeInputsVersion,
  assertProductionRuleset,
  assertProductionRct,
  RATIFIED_RULESET_PATH,
  REPLACEMENT_COST_TABLE_PATH,
} from './acquisition';
import { logVerdicts } from './calibration';
import { closeAcqOutcomeSkips } from './acq-outcome-dq';
import { CalibrationVerdictSchema, CalibrationOutcomeSchema } from '../../src/contracts/warehouse';
import type {
  AcquisitionInput,
  AcquisitionRuleset,
  AcquisitionScore,
  ReplacementCostTable,
} from '../../src/contracts/acquisition';

/**
 * What the persist did to acq_scores (audit 2026-10-13 X1):
 *   'inserted'   — a new row for a new dedup key.
 *   'unchanged'  — the key existed, its stored output equals the live engine's, and it is already
 *                  the candidate's latest row AND its current-score pointer (#464).
 *   'superseded' — the key existed but its stored output differs from the live engine's (an
 *                  engine-logic change under an unchanged ruleset/RCT/governor key): the row was
 *                  rewritten in place with the live output and a new scored_at, and the supersession
 *                  was recorded in data_quality_issues.
 *   'reinstated' — the key existed with the live output but a NEWER row (another key) was the
 *                  latest, or another row was current — e.g. a ruleset/governor reversion: scored_at
 *                  was moved forward (when needed) and the pointer re-set, so every reader serves
 *                  this, the live, score.
 * Every outcome leaves acq_candidates.current_score_id on this key's row (#464; see step 8 below).
 */
export type PersistOutcome = 'inserted' | 'unchanged' | 'superseded' | 'reinstated';

/**
 * The ONE latest-row ordering for acq_scores (refute pass on b989339, DEFECT 1). Since the #464
 * composition, READERS no longer infer "current" from this order: every reader joins on
 * acq_candidates.current_score_id (acq-score-freshness CURRENT_SCORE_WITH_INPUTS_SQL, which feeds the
 * capital BUY gate and the re-score sweep; the api.ts /acq/intel join; brain-report; logAcqOutcome
 * below). The order is still what reconcileExistingScore uses to decide supersede vs reinstate, and
 * persistAndLogScore keeps it consistent with the pointer (the row it points at is also the newest).
 * For that to be a TOTAL, timing-independent order per candidate, EVERY writer of a row's
 * scored_at — insert, supersede and reinstate — stamps it with this expression: millisecond wall
 * clock, or 1 ms past the newest OTHER row of the same candidate when that one is not older (same
 * millisecond, a clock step back, or a future-stamped legacy row). The bump is only as large as
 * needed — it never accumulates whole seconds — so a write is always strictly the candidate's
 * newest row and sits at most a few ms ahead of the wall clock.
 *
 * Mixed formats are safe: rows written by the 007 DEFAULT (`datetime('now')`, whole seconds) and
 * these (`…SS.fff`) compare lexicographically exactly as their instants order, because a
 * whole-second string is a prefix of, and so sorts before, every millisecond string in that second.
 * No column / migration is added (migrations are architect-owned).
 * Params: (candidateId, own acq_scores.id or -1 for an insert).
 */
const NEXT_SCORED_AT_SQL = `(SELECT MAX(strftime('%Y-%m-%d %H:%M:%f', 'now'),
    COALESCE(strftime('%Y-%m-%d %H:%M:%f', MAX(o.scored_at), '+0.001 seconds'), ''))
  FROM acq_scores o WHERE o.candidate_id = ? AND o.id <> ?)`;

/** ORDER BY for "latest acq_scores row of a candidate" — must match every reader (see above). */
const LATEST_SCORE_ORDER = 'scored_at DESC, id DESC';

export interface PersistAndLogScoreResult {
  score: AcquisitionScore;
  calibrationVerdictId: number | null;
  persisted: PersistOutcome;
}

/**
 * The governor-regime component of the persisted dedup key (I1): a DSCR/LTV governor edit must
 * mint a NEW inputs_version so INSERT OR IGNORE re-derives the verdict instead of silently keeping
 * one made under the old regime. SCREENING_DEBT_CONSTANT is part of the DSCR-proxy formula, so a
 * (ratified) change to it re-keys too. Format pinned — changing it re-keys every candidate once.
 *
 * Leads with the monotonic capital_config `version` (refute fix): capital_config is append-only,
 * so hashing only VALUES let a reversion (v1 dscrFloor 1.25 -> v2 1.30 -> v3 back to 1.25) collide
 * back onto v1's key. INSERT OR IGNORE then no-opped, and every latest-by-scored_at reader
 * (api.ts, capital-allocation.ts, brain-report.ts) permanently served the abandoned v2 verdict
 * while this function kept returning the correct v3 one. Version-leading means EVERY regime —
 * even a values-identical reversion — mints its own row and becomes the new latest.
 */
export { governorFingerprint };

/**
 * Score a candidate, evaluate governor thresholds, persist to acq_score_inputs + acq_scores,
 * log to calibration_verdict (fail-open — mirrors logVerdicts pattern).
 *
 * Returns the AcquisitionScore (with verdict reflecting governor demotion) + calibration verdict id.
 *
 * GOVERNOR ENFORCEMENT (Invariant 4) — via the shared applyGovernorProxy (acq-governor-proxy.ts):
 *   - DSCR proxy: stabilizedYoc / (ltvCeiling * SCREENING_DEBT_CONSTANT). Absent → NULL (no demotion).
 *   - LTV proxy: INDETERMINATE at screen time → NULL (enforced at financing; see module header).
 *   - A FAILED governor hard-demotes verdict to 'PASS' (never upgrades KILLED).
 *   - Composite is preserved (analysts can see the underlying score).
 *
 * IDEMPOTENT: a second call on identical (candidateId, input, ruleset, rct) is a no-op
 * (UNIQUE constraint on candidate_id, inputs_version in acq_score_inputs) — PROVIDED the stored
 * output still equals the live engine's. The key hashes inputs, not engine code, so after an
 * engine-logic change the same key can carry a stale output; UNIQUE(score_input_id) forbids a
 * second row, so the existing row is SUPERSEDED in place (X1, see PersistOutcome). This is the one
 * sanctioned mutation of an acq_scores row (007's "never mutated after insert" predates it).
 * Accepted limit: the calibration_verdict already logged for that key is NOT rewritten (the
 * calibration record is append-only) and acq_scores.calibration_verdict_id keeps pointing at it; the
 * 'acq-score-superseded' data_quality_issues row names the key. If the supersede changed the verdict
 * band, logAcqOutcome refuses to resolve against that stale band ('acq-outcome-band-mismatch') rather
 * than writing a mis-signed hit/action — that deal's outcome is then absent from calibration.
 * The check is on the exact band, so SAME-DIRECTION flips (PURSUE <-> WATCH, PASS <-> KILLED) are
 * skipped too, although hit/action would have come out identical — deliberate (refute round 3 #3):
 * the comparison stays a plain band equality rather than a re-derivation of the hit rule. Every
 * skipped deal is excluded from the calibration n (no blessed outcome), and its verdict stays OPEN —
 * listed by calibrationLog({ status: 'open' }), the surface for manual resolution via
 * resolveManualOutcome — still showing the stale logged band. (calibrationPending, the horizon-due
 * queue, covers property subjects only, so it never lists deal verdicts either way.)
 *
 * Double resolution — CLOSED ON EVERY SURFACE (refute rounds 4 + 5): any re-key gives a deal a NEW
 * verdict — a new input in the SAME year as much as the same key in a later year (logVerdicts dedups
 * on as_of_period + inputs_version). The rule is ONE blessed outcome per deal (subject_kind='deal',
 * verdict_kind='acquisition-score'), enforced on all three write/read surfaces:
 *   - logAcqOutcome (auto): returns early if ANY verdict of the deal is already resolved.
 *   - resolveManualOutcome (manual override): demotes any OTHER verdict's blessed row of the same deal
 *     (is_resolution=0, preserved) and blesses the requested one in one transaction; same-verdict
 *     correction is unchanged. So auto-then-manual and manual-then-auto end with the same single
 *     blessed row (the manual one); the first order also keeps the demoted auto row for audit.
 *   - calibrationLog: a deal verdict is resolved when ANY verdict of the deal is blessed. A sibling
 *     reads resolved:true with resolvedByVerdictId naming the covering verdict, and the open /
 *     resolved filters use the same rule (open + resolved = all), so the queue never offers a
 *     second resolution. The /acq/intel summary adds totalDeals / resolvedDeals (distinct deals)
 *     beside the unchanged verdict-level totalVerdicts / resolvedVerdicts.
 * Every resolution path closes the candidate's open acq-outcome-* skip rows (closeAcqOutcomeSkips).
 *
 * Known gaps (recorded, not fixed):
 *   - Pre-stack data: a deal that ALREADY carries two or more blessed acquisition-score outcomes
 *     (written before this rule) is not reconciled — it still counts twice in calibrationReport and
 *     both verdicts read resolved. A one-off data fix is a separate decision. Detect with:
 *       SELECT v.subject_id, COUNT(*) AS blessed
 *       FROM calibration_outcome o JOIN calibration_verdict v ON v.id = o.calibration_id
 *       WHERE o.is_resolution = 1 AND v.subject_kind = 'deal' AND v.verdict_kind = 'acquisition-score'
 *       GROUP BY v.subject_id HAVING COUNT(*) > 1;
 *   - The HubSpot / Notion candidate syncs set status to acquired / passed without calling
 *     logAcqOutcome, so those resolutions never reach calibration.
 *
 * score_json.scoredAt is the ENGINE-RUN time of the stored output (refute round 2, low 2): a
 * supersede writes a new run so it is refreshed; a reinstate keeps it, because the output is the
 * same run's. The scored_at COLUMN is the ordering stamp (NEXT_SCORED_AT_SQL) that decides supersede /
 * reinstate. The SERVED stamp is #464's acq_candidates.current_scored_at ("last re-asserted": moved on
 * every call, incl. the no-op) — /acq/intel scoredAt and the brain-report order use
 * COALESCE(current_scored_at, scored_at); no reader takes the embedded value.
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
  // 0. FAIL CLOSED (Invariant 4): a persisted score feeds the ranked pipeline, the capital BUY verdict
  //    (capital-allocation.ts now also refuses advisory_only rows — defense in depth) and the 40-year calibration
  //    record, so it may only be produced from the RATIFIED ruleset + RCT. Throws before any write.
  //    This is the single persistence funnel, so it does not rely on every caller having checked.
  assertProductionRuleset(ruleset);
  assertProductionRct(rct);

  // 1. Compute the score (pure — no side effects).
  const score = scoreAcquisition(input, ruleset, { rct });

  // 2. Load governors at query time (never hardcoded — Invariant 4). Loaded BEFORE the dedup key
  //    so the governor regime is part of the persisted score's identity (I1).
  const governors = loadGovernors(db);

  // 3. Compute the inputs_version dedup key — governor-fingerprinted, so a capital_config edit
  //    re-derives persisted verdicts instead of INSERT-OR-IGNORE keeping a stale one.
  const inputsVersion = computeInputsVersion(input, ruleset, rct.rctVersion, governorFingerprint(governors));

  // 3b. Apply the SHARED governor proxy — the SAME demotion the ad-hoc /acquisition/score route
  //     and the edge Pages Function apply, so all three surfaces agree. LTV is indeterminate at
  //     screen time (null, never demotes); DSCR proxy + KILLED-monotonicity unchanged.
  //     Score-level wrapper (audit 2026-10-13 G1): a demotion moves tier WITH the verdict, so the
  //     persisted tier column and score_json can never read T1/T2 next to a governor-demoted PASS.
  const { score: governedScore, governorDscrCleared, governorLtvCleared } =
    applyGovernorProxyToScore(score, input, governors);
  const finalVerdict = governedScore.verdict;

  // 6. Advisory: use the engine's own advisoryOnly flag as the source of truth.
  // This guards against future engine conditions beyond ratification (e.g. RCT version).
  const advisoryOnly = score.advisoryOnly;

  // 6b. The persisted/returned score blob must carry the SAME inputs_version as the row's key
  // columns (refute finding: the engine's self-computed hash is un-fingerprinted, so score_json
  // and API responses would otherwise embed a hash that matches no DB key).
  const persistedScore: AcquisitionScore = { ...governedScore, inputsVersion };
  // 6c. Stamp the governor regime this verdict was derived under into the persisted blob ONLY (not the
  // returned score — AcquisitionScore is a contract). The capital BUY gate compares it to the CURRENT
  // regime and treats an older/missing stamp as BUY-ineligible until re-scored (refute wf_f5f45202-de8:
  // a capital_config change otherwise leaves a verdict made under looser governors emitting BUY).
  const governorRegime = governorFingerprint(governors);
  const persistedBlob = { ...persistedScore, governorRegime };

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

  // 8. INSERT OR IGNORE into acq_scores (idempotent on UNIQUE(score_input_id)), then reconcile an
  //    existing row — ONE transaction, so the scored_at ordering rule (NEXT_SCORED_AT_SQL) reads and
  //    writes the candidate's rows atomically. A new row is inserted WITH the governorRegime stamp
  //    (#463); reconcileExistingScore applies #463's stamp rules on the existing-key paths.
  //
  //    Composition with #464 (acq_candidates.current_score_id, migrations 036/037), Wave 2a rebuild:
  //    the CURRENT-SCORE POINTER is set on EVERY exit of this transaction — inserted, unchanged
  //    (idempotent no-op), superseded in place and reinstated. It is not left to migration 037's
  //    AFTER INSERT trigger: X1's supersede and reinstate are UPDATEs of an existing row (UNIQUE
  //    (score_input_id) forbids a second one), and the no-op path writes nothing, so the trigger fires
  //    on the insert path only. The pointer — not scored_at ordering — is the ONE definition of a
  //    candidate's current score for every reader (BUY gate, /acq/intel, brain-report, logAcqOutcome,
  //    and through the BUY gate the IC memo); scored_at ordering is used only inside
  //    reconcileExistingScore to decide supersede / reinstate. #464's separate insertScore +
  //    stampMissingRegime block is NOT kept: it wrote the UNGOVERNED composite/tier, and its stamp
  //    backfill is covered (same WHERE guard, governed values) by reconcileExistingScore's
  //    unchanged/reinstated path — pinned by tests/unit/acq-score-supersede.test.ts (#463 stamp block)
  //    and tests/unit/acq-current-score-pointer-exits.test.ts.
  const setCurrent = db.prepare(`
    UPDATE acq_candidates
       SET current_score_id = (SELECT id FROM acq_scores WHERE score_input_id = ?),
           current_scored_at = datetime('now')
     WHERE id = ?
  `);
  const persisted = db.transaction((): PersistOutcome => {
    const inserted = db.prepare(`
      INSERT OR IGNORE INTO acq_scores (
        candidate_id, score_input_id, inputs_version,
        composite, tier, verdict, advisory_only,
        capped_at_t2, gates_passed, floors_passed, floor_indeterminate,
        governor_dscr_cleared, governor_ltv_cleared,
        score_json, scored_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ${NEXT_SCORED_AT_SQL})
    `).run(
      candidateId,
      scoreInputId,
      inputsVersion,
      governedScore.composite,
      governedScore.tier,
      finalVerdict,
      advisoryOnly ? 1 : 0,
      score.cappedAtT2 ? 1 : 0,
      score.gatesPassed ? 1 : 0,
      score.floorsPassed ? 1 : 0,
      score.floorIndeterminate ? 1 : 0,
      governorDscrCleared === null ? null : (governorDscrCleared ? 1 : 0),
      governorLtvCleared === null ? null : (governorLtvCleared ? 1 : 0),
      JSON.stringify(persistedBlob),
      candidateId, -1,
    );
    // changes === 0: the key already exists. A no-op is correct ONLY if that row still carries the
    // live output and is the current row — otherwise supersede / reinstate it (X1).
    const outcome: PersistOutcome = inserted.changes > 0
      ? 'inserted'
      : reconcileExistingScore(db, candidateId, scoreInputId, inputsVersion, {
          governed: persistedScore,
          governorDscrCleared,
          governorLtvCleared,
          governorRegime,
        });
    // 8b. CURRENT-SCORE POINTER (#464) — every exit, same transaction: no window with a stale pointer.
    setCurrent.run(scoreInputId, candidateId);
    return outcome;
  })();

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
  // Never log an ADVISORY score as a calibration prediction: the calibration record is only ever built
  // from ratified verdicts. Defensive only: the assertions at the top of this function force
  // advisoryOnly=false today, so this guards against a future engine condition, not a current one.
  if (!advisoryOnly) try {
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
    score: persistedScore,
    calibrationVerdictId,
    persisted,
  };
}

/**
 * X1 — an existing acq_scores row for this dedup key: rewrite it with the live output when it
 * differs (superseded), move it to latest when another key is newer (reinstated), else no-op.
 *
 * governorRegime stamp (#463, folded in here so every existing-key path is in the same transaction):
 *   - superseded: the row is rewritten with the live output, so it gets the FRESH stamp — the stamp
 *     always describes the output it sits next to.
 *   - unchanged / reinstated: an EXISTING stamp is never overwritten (an older stamp keeps the row
 *     BUY-withheld). A MISSING stamp is filled only when the stored composite, tier, verdict and both
 *     governor flags equal the live result (#463's backfill rule, kept verbatim as the UPDATE's WHERE
 *     guard). A drifted row never reaches this branch — any such difference is a storedVsLiveDiffs
 *     diff and supersedes instead — so a drifted output is never certified with a stamp.
 */
function reconcileExistingScore(
  db: WarehouseDb,
  candidateId: string,
  scoreInputId: number,
  inputsVersion: string,
  live: {
    governed: AcquisitionScore;
    governorDscrCleared: boolean | null;
    governorLtvCleared: boolean | null;
    /** governorFingerprint() of the regime the live output was derived under. */
    governorRegime: string;
  },
): PersistOutcome {
  const row = db.prepare(`
    SELECT id, composite, tier, verdict, advisory_only, capped_at_t2, floor_indeterminate,
           governor_dscr_cleared, governor_ltv_cleared, gates_passed, floors_passed, score_json
    FROM acq_scores WHERE score_input_id = ?
  `).get(scoreInputId) as (StoredScoreColumns & { id: number; score_json: string }) | undefined;
  if (!row) throw new Error(`acq-engine: acq_scores row vanished for score_input_id=${scoreInputId}`);

  let stored: AcquisitionScore | null = null;
  try {
    const p = AcquisitionScoreSchema.safeParse(JSON.parse(row.score_json));
    stored = p.success ? p.data : null;
  } catch { stored = null; }
  const diffs = stored === null
    ? ['stored score_json does not parse under the live AcquisitionScore contract']
    : storedVsLiveDiffs(row, stored, live);

  // Strictly the candidate's newest row, by the same rule every insert uses (NEXT_SCORED_AT_SQL).
  const bumpScoredAt = `scored_at = ${NEXT_SCORED_AT_SQL}`;

  if (diffs.length > 0) {
    const g = live.governed;
    db.prepare(`
      UPDATE acq_scores SET
        composite = ?, tier = ?, verdict = ?, advisory_only = ?,
        capped_at_t2 = ?, gates_passed = ?, floors_passed = ?, floor_indeterminate = ?,
        governor_dscr_cleared = ?, governor_ltv_cleared = ?, score_json = ?,
        ${bumpScoredAt}
      WHERE id = ?
    `).run(
      g.composite, g.tier, g.verdict, g.advisoryOnly ? 1 : 0,
      g.cappedAtT2 ? 1 : 0, g.gatesPassed ? 1 : 0, g.floorsPassed ? 1 : 0, g.floorIndeterminate ? 1 : 0,
      live.governorDscrCleared === null ? null : (live.governorDscrCleared ? 1 : 0),
      live.governorLtvCleared === null ? null : (live.governorLtvCleared ? 1 : 0),
      JSON.stringify({ ...g, governorRegime: live.governorRegime }),
      candidateId, row.id,
      row.id,
    );
    db.prepare(
      "INSERT INTO data_quality_issues (kind, detail, severity) VALUES ('acq-score-superseded', ?, 'warn')",
    ).run(
      `candidate=${candidateId} inputs_version=${inputsVersion} acq_scores.id=${row.id}: stored output re-derived ` +
      `by the live engine (${diffs.join('; ')}). The calibration_verdict logged for this key is not rewritten.`,
    );
    return 'superseded';
  }

  // Unchanged / reinstated: backfill a MISSING governorRegime stamp only (#463). The WHERE clause is
  // #463's guard unchanged — json_valid (a corrupt blob cannot abort the re-score), stamp IS NULL
  // (never overwrite), and stored composite/tier/verdict/governor flags equal the live result.
  const g = live.governed;
  db.prepare(`
    UPDATE acq_scores SET score_json = json_set(score_json, '$.governorRegime', ?)
    WHERE id = ?
      AND json_valid(score_json)
      AND json_extract(score_json, '$.governorRegime') IS NULL
      AND composite = ? AND tier = ? AND verdict = ?
      AND governor_dscr_cleared IS ? AND governor_ltv_cleared IS ?
  `).run(
    live.governorRegime,
    row.id,
    g.composite,
    g.tier,
    g.verdict,
    live.governorDscrCleared === null ? null : (live.governorDscrCleared ? 1 : 0),
    live.governorLtvCleared === null ? null : (live.governorLtvCleared ? 1 : 0),
  );

  // 'unchanged' only when this row is BOTH the newest by scored_at AND already the current-score
  // pointer (#464). A row that is newest by scored_at but not current (e.g. a raw legacy insert made
  // another row current through migration 037's trigger) is reinstated: the caller re-points the
  // pointer at it, so reporting 'unchanged' would hide a change of the served score.
  const latest = db.prepare(
    `SELECT id FROM acq_scores WHERE candidate_id = ? ORDER BY ${LATEST_SCORE_ORDER} LIMIT 1`,
  ).get(candidateId) as { id: number };
  const pointer = db.prepare('SELECT current_score_id AS id FROM acq_candidates WHERE id = ?')
    .get(candidateId) as { id: number | null } | undefined;
  if (latest.id === row.id && pointer?.id === row.id) return 'unchanged';
  if (latest.id !== row.id) {
    db.prepare(`UPDATE acq_scores SET ${bumpScoredAt} WHERE id = ?`).run(candidateId, row.id, row.id);
  }
  return 'reinstated';
}

// Re-export the loader functions for callers that need them (avoids re-importing acquisition.ts).
export { loadGovernors };
// Export the paths so the API layer can load rulesets consistently.
export { RATIFIED_RULESET_PATH, REPLACEMENT_COST_TABLE_PATH };

function hasBlessedOutcome(db: WarehouseDb, calibrationId: number): boolean {
  return db.prepare('SELECT 1 FROM calibration_outcome WHERE calibration_id = ? AND is_resolution = 1 LIMIT 1')
    .get(calibrationId) !== undefined;
}

/**
 * A skipped outcome is a data-quality event, never a silent no-op (fail-open like the rest).
 * Deduped (refute round 3 #1; pattern: insurance-analysis.ts bad-date flags): no insert while an
 * OPEN row of the same kind exists whose detail starts with `key`. The key is
 * `candidate=<id> inputs_version=<iv> outcome=<acquired|passed> ` (round 4 #2 added the attempted
 * outcome, so a corrected status is a new event). Prefix matched with substr, not LIKE, because
 * candidate ids may contain `%` / `_`. A resolved row does not suppress a new one.
 * Old-format rows (written before round 4, detail `candidate=… inputs_version=… calibration_verdict.id=…`
 * or `… outcome=passed: …` with no space-terminated outcome segment) never match the new key, so an
 * old-format open row simply does not suppress a new one — at most one extra row per candidate/key,
 * and it is still closed by closeAcqOutcomeSkips (candidate prefix) when the deal resolves.
 */
function recordOutcomeSkip(
  db: WarehouseDb,
  kind: 'acq-outcome-unbound' | 'acq-outcome-band-mismatch',
  key: string,
  detail: string,
): void {
  try {
    const open = db.prepare(
      `SELECT 1 FROM data_quality_issues
       WHERE kind = ? AND status = 'open' AND substr(detail, 1, length(?)) = ? LIMIT 1`,
    ).get(kind, key, key);
    if (open) return;
    db.prepare("INSERT INTO data_quality_issues (kind, detail, severity) VALUES (?, ?, 'warn')").run(kind, detail);
  } catch { /* swallow — observational machinery never blocks */ }
}

/**
 * Log a calibration OUTCOME for a candidate when its deal lifecycle resolves (acquired | passed).
 *
 * Links to the calibration_verdict of the candidate's CURRENT score — the acq_scores row named by
 * acq_candidates.current_score_id (#464) — through that row's calibration_verdict_id, falling back to
 * the newest acquisition-score calibration_verdict FOR THE SAME inputs_version when the row has none
 * (never across inputs), and writes ONE
 * blessed (is_resolution=1) calibration_outcome row. FAIL-OPEN: never throws to the caller.
 * If the candidate has no acquisition-score verdict (never scored), this is a no-op.
 *
 * Hit semantics (intent-outcome — decision-action alignment, NOT realized-NOI predictive accuracy):
 *   'acquired': closed → PURSUE/WATCH verdict vindicated (hit=1); PASS/KILLED = miss (hit=0).
 *   'passed':   walked → PASS/KILLED verdict vindicated (hit=1); PURSUE/WATCH = miss (hit=0).
 *   WATCH is treated as a buy-signal verdict (same as PURSUE) — Gabriel G3 decision (2026-06-20).
 *
 * FENCE: intent-outcomes are isolated by verdict_kind='acquisition-score' (the distinct kind bucket
 *   prevents cross-kind overallHitRate mixing). resolution_basis='deal-lifecycle-event' is metadata
 *   for future partitioning — calibrationReport() does NOT yet read it (Lens-1.1 advisory).
 *
 * STATUS REVERSAL: if a candidate's status is corrected (acquired→passed), the first blessed
 *   outcome row is NOT superseded (idempotency no-op). For corrections use resolveManualOutcome().
 *   ONE lifecycle outcome per DEAL: a deal re-pursued after 'passed' (re-scored, later acquired) keeps only
 *   its first outcome — record the re-pursuit via resolveManualOutcome (refute wf_8d7273d2-bfb).
 *   outcomePeriod may equal as_of_period (same-year deals) — deal-lifecycle events are exempt from
 *   the resolveManualOutcome strictly-later guard; horizonActual=0 marks same-period resolutions.
 *
 * IDEMPOTENT PER DEAL: if ANY acquisition-score verdict of this candidate already has a blessed
 * resolution, or any deal-lifecycle-event outcome row even once demoted (#464), does nothing (no
 * outcome, no DQ row; open skip rows are closed) — refute round 4 #1. Corrections go through
 * resolveManualOutcome, which overrides at DEAL level: it demotes any sibling verdict's blessed row
 * (is_resolution=0, preserved) and blesses the requested verdict in one transaction.
 * A successful bless resolves the candidate's open acq-outcome-* skip rows.
 * SKIPS (data_quality_issues, no outcome row): 'acq-outcome-unbound' when no verdict exists for the
 * served row's input; 'acq-outcome-band-mismatch' when the bound verdict's predicted_band differs
 * from the served verdict (a same-year supersede — see PersistAndLogScoreResult accepted limit).
 * FINANCIAL-DECISION CODE — any change to hit logic requires adversarial refute (CLAUDE.md §EOS).
 */
export function logAcqOutcome(
  db: WarehouseDb,
  candidateId: string,
  outcome: 'acquired' | 'passed',
): void {
  try {
    // ONE blessed outcome per DEAL (refute round 4 #1; #464 refute wf_8d7273d2-bfb): if ANY
    // acquisition-score verdict of this candidate — any inputs_version, any as_of_period — already
    // carries an is_resolution=1 outcome, OR any deal-lifecycle-event row even once demoted
    // (is_resolution=0 after a resolveManualOutcome correction — #464's stricter predicate, kept: a
    // correction must not re-open the deal to a fresh auto-outcome), the deal is resolved. Return
    // before any binding, band check or write (no outcome, no DQ row). This closes the same-year
    // re-key case (new input => new verdict), the cross-year case (same key, new as_of_period => new
    // verdict) and the pointer moving back to earlier inputs (A->B->A). Corrections go through
    // resolveManualOutcome, the analyst override at DEAL level.
    const dealResolved = db.prepare(`
      SELECT 1 FROM calibration_outcome o
      JOIN calibration_verdict v ON v.id = o.calibration_id
      WHERE v.subject_kind = 'deal' AND v.subject_id = ? AND v.verdict_kind = 'acquisition-score'
        AND (o.is_resolution = 1 OR o.resolution_basis = 'deal-lifecycle-event')
      LIMIT 1
    `).get(candidateId);
    if (dealResolved) { closeAcqOutcomeSkips(db, candidateId); return; }

    // Bind to the verdict of the candidate's CURRENT score row (acq_candidates.current_score_id, #464 —
    // the same row the BUY gate, /acq/intel and brain-report read). Not the newest calibration_verdict
    // by id: logVerdicts is INSERT OR IGNORE on its dedup key, so after a reinstate (A->B->A) the newest
    // verdict id belongs to the superseded input B (refute pass on b989339, DEFECT 2).
    type VerdictRow = { id: number; predicted_band: string | null; as_of_period: string; inputs_version: string };
    const currentScore = db.prepare(
      `SELECT s.calibration_verdict_id AS vid, s.inputs_version AS iv, s.verdict AS verdict
       FROM acq_candidates c JOIN acq_scores s ON s.id = c.current_score_id
       WHERE c.id = ?`,
    ).get(candidateId) as { vid: number | null; iv: string; verdict: string } | undefined;

    let verdict: VerdictRow | undefined;
    if (currentScore === undefined) {
      // No current score (never scored): legacy behaviour (newest acquisition-score verdict, if any).
      verdict = db.prepare(`
        SELECT id, predicted_band, as_of_period, inputs_version FROM calibration_verdict
        WHERE subject_kind = 'deal' AND subject_id = ? AND verdict_kind = 'acquisition-score'
        ORDER BY id DESC LIMIT 1
      `).get(candidateId) as VerdictRow | undefined;
    } else {
      verdict = currentScore.vid != null
        ? db.prepare(`
            SELECT id, predicted_band, as_of_period, inputs_version FROM calibration_verdict
            WHERE id = ? AND subject_kind = 'deal' AND subject_id = ? AND verdict_kind = 'acquisition-score'
          `).get(currentScore.vid, candidateId) as VerdictRow | undefined
        : undefined;
      // Fallback for an unlinked row (refute round 2, MEDIUM B): only a verdict for the SAME input
      // (inputs_version) as the current row — newest by id within it. Never cross inputs.
      verdict ??= db.prepare(`
        SELECT id, predicted_band, as_of_period, inputs_version FROM calibration_verdict
        WHERE subject_kind = 'deal' AND subject_id = ? AND verdict_kind = 'acquisition-score'
          AND inputs_version = ?
        ORDER BY id DESC LIMIT 1
      `).get(candidateId, currentScore.iv) as VerdictRow | undefined;
      // Dedupe key carries the attempted outcome (round 4 #2): a corrected status is a new event.
      const skipKey = `candidate=${candidateId} inputs_version=${currentScore.iv} outcome=${outcome} `;
      if (!verdict) {
        recordOutcomeSkip(db, 'acq-outcome-unbound', skipKey,
          `${skipKey}: no calibration_verdict ` +
          'for the served score\'s input; outcome not recorded (never bound across inputs).');
        return;
      }
      // Refute round 3 #1: an already-recorded outcome is a no-op BEFORE any skip check — otherwise a
      // later band flip makes a repeat PATCH write a row falsely saying "outcome not recorded".
      if (hasBlessedOutcome(db, verdict.id)) return;
      // Refute round 2, MEDIUM A: a same-year supersede leaves the append-only verdict on the OLD band
      // (logVerdicts dedups on as_of_period + inputs_version). Scoring hit/action against a band the
      // served decision contradicts would mis-sign the calibration record — skip and say so.
      if (verdict.predicted_band !== currentScore.verdict) {
        recordOutcomeSkip(db, 'acq-outcome-band-mismatch', skipKey,
          `${skipKey}calibration_verdict.id=${verdict.id}: ` +
          `logged band ${verdict.predicted_band ?? 'null'} disagrees with served verdict ${currentScore.verdict}; outcome not recorded.`);
        return;
      }
    }
    if (!verdict) return; // never scored → no-op

    if (hasBlessedOutcome(db, verdict.id)) return; // idempotent — one blessed resolution per verdict

    const predicted = verdict.predicted_band;
    const pursued = predicted === 'PURSUE' || predicted === 'WATCH';
    const hit: 0 | 1 =
      outcome === 'acquired'
        ? (pursued ? 1 : 0)  // acquired a PURSUE/WATCH = vindicated; acquired despite PASS/KILLED = miss
        : (pursued ? 0 : 1); // passed on a PURSUE/WATCH = miss; passed a PASS/KILLED = vindicated

    const outcomeYear = new Date().getFullYear();
    const asOfYear = Number.parseInt(verdict.as_of_period, 10);
    const horizonActual = Number.isFinite(asOfYear) ? Math.max(0, outcomeYear - asOfYear) : 0;
    const outcomePeriod = String(outcomeYear);

    // actionTaken derived from verdict-alignment (not from outcome alone — see adversarial review 2026-06-20):
    //   aligned = action agreed with the verdict's directional bet; counter = action opposed it.
    const row = CalibrationOutcomeSchema.parse({
      calibrationId: verdict.id,
      realizedBand: outcome,
      realizedValue: null,
      realizedUnit: 'band',
      outcomePeriod,
      horizonActual,
      hit,
      absError: null,
      brierComponent: null,
      actionTaken: hit === 1 ? 'acted-aligned' : 'acted-counter',
      actionDetail: `deal lifecycle → ${outcome}`,
      treatmentNote: null,
      resolvedBy: 'auto:deal-lifecycle',
      resolutionBasis: 'deal-lifecycle-event',
      isResolution: true,
      inputsVersion: null,
    });

    db.prepare(`
      INSERT INTO calibration_outcome
        (calibration_id, realized_band, realized_value, realized_unit, outcome_period, horizon_actual,
         hit, abs_error, brier_component, action_taken, action_detail, treatment_note,
         resolved_by, resolution_basis, is_resolution, inputs_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)
    `).run(
      row.calibrationId, row.realizedBand, row.realizedValue, row.realizedUnit, row.outcomePeriod,
      row.horizonActual, row.hit, row.absError, row.brierComponent, row.actionTaken, row.actionDetail,
      row.treatmentNote, row.resolvedBy, row.resolutionBasis, row.inputsVersion,
    );
    // Round 4 #2: the deal is now resolved, so its open "outcome not recorded" rows are stale.
    closeAcqOutcomeSkips(db, candidateId);
  } catch (e) {
    // Fail-open — mirror logVerdicts. Never throw to the PATCH handler.
    try {
      db.prepare(
        "INSERT INTO data_quality_issues (kind, detail, severity) VALUES ('acq-outcome-failed', ?, 'warn')",
      ).run(e instanceof Error ? e.message : String(e));
    } catch { /* swallow — observational machinery never blocks */ }
  }
}
