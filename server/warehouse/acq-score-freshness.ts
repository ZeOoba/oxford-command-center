// server/warehouse/acq-score-freshness.ts
//
// Audit 2026-10-13 G3 — scoring-regime freshness for persisted acquisition scores.
//
// Every latest-score reader (GET /acq/intel, the capital BUY gate) used to take the newest acq_scores
// row with no ruleset / RCT / governor check, so a score made under a superseded regime (pre-RCT-bump,
// pre-governor-ratification) kept ranking and could drive the portfolio BUY verdict; and a score_json
// that no longer parsed under the live AcquisitionScore contract silently became latestScore = null.
//
// classifyLatestScore gives each candidate an EXPLICIT state:
//   'current'     — persisted under the live ruleset version, live RCT version AND live governor
//                   regime (re-derived by recomputing the governor-fingerprinted inputs_version from
//                   the stored input_json — the same key persistAndLogScore writes), and parseable,
//                   AND its score_json.governorRegime stamp equals the LIVE capital_config version's
//                   governorFingerprint (#463; version-keyed, so any capital_config write stales it).
//   'stale'       — any regime component differs (or the live regime is unavailable: unverifiable
//                   freshness fails closed). The score may still be readable; it must not drive BUY.
//   'unparseable' — regime matches but score_json or input_json does not parse under the live
//                   contract. Never silently null: the reason is carried.
//   'unscored'    — no score row.
//
// rescoreStaleCandidates is the version-change sweep: it re-runs persistAndLogScore (the single
// production funnel — ratification asserts, governor proxy, calibration log) from each stale latest
// row's stored input_json. It is NOT scheduled; call it after a ruleset / RCT / governor change.
//
// FINANCIAL-DECISION CODE (feeds the capital BUY gate) — refute pass required before merge.
import type { WarehouseDb } from './db';
import { loadGovernors } from './governors';
import { governorFingerprint, persistAndLogScore } from './acq-engine';
import { assertProductionRct, assertProductionRuleset, computeInputsVersion, scoreAcquisition } from './acquisition';
import { applyGovernorProxyToScore } from './acq-governor-proxy';
import { storedVsLiveDiffs } from './acq-score-compare';
import type { LiveEngineOutput } from './acq-score-compare';
import { AcquisitionInput, AcquisitionScore } from '../../src/contracts/acquisition';
import type { AcquisitionRuleset, ReplacementCostTable } from '../../src/contracts/acquisition';

export type ScoreState = 'current' | 'stale' | 'unparseable' | 'unscored';

/** The live scoring regime a persisted score must match to be 'current'. */
export interface LiveScoringRegime {
  ruleset: AcquisitionRuleset;
  rctVersion: string;
  /**
   * Every governor fingerprint (governorFingerprint(), the inputs_version component) of a
   * capital_config version whose SCORING-RELEVANT values — dscrFloor and ltvCeiling, with the
   * current SCREENING_DEBT_CONSTANT baked into the fingerprint — equal the live ones (refute H2).
   * The persisted dedup key leads with capital_config.version, so comparing against the LIVE
   * fingerprint alone made ANY capital_config write (e.g. dispositionCapRate) stale every score and
   * silently strip every BUY. A score whose key matches ANY same-valued version was produced by
   * exactly the governor values scoring reads today. The dedup key itself is unchanged.
   */
  governorFingerprints: ReadonlySet<string>;
  /**
   * governorFingerprint() of the LIVE capital_config version (#463, merged under Option A
   * "strictest wins"). A score is 'current' only if its score_json.governorRegime stamp equals this
   * EXACT value — version-keyed, so ANY capital_config write (even an unrelated field, even a
   * values-identical reversion) makes every older score stale until it is re-scored. This is
   * checked IN ADDITION to the value-based governorFingerprints key match above; it never relaxes it.
   */
  currentGovernorRegime: string;
  /** The live RCT + governor values, for the engine re-derivation check (refute round 3 V1). */
  rct: ReplacementCostTable;
  governors: { dscrFloor: number; ltvCeiling: number };
  /** X3: per-regime (= per-request) memo of the engine re-run, keyed on the stored input_json. */
  engineCache: Map<string, LiveEngineOutput | Error>;
  /** Observability for the X3 call-count guard: engine re-runs actually executed under this regime. */
  stats: { engineRuns: number };
}

export function liveScoringRegime(
  db: WarehouseDb,
  ruleset: AcquisitionRuleset,
  rct: ReplacementCostTable,
): LiveScoringRegime {
  const liveGov = loadGovernors(db); // throws CapitalConfigMissingError on an empty table (fail closed)
  const versions = db
    .prepare('SELECT version, dscr_floor AS dscrFloor, ltv_ceiling AS ltvCeiling FROM capital_config')
    .all() as Array<{ version: number; dscrFloor: number; ltvCeiling: number }>;
  const governorFingerprints = new Set<string>();
  for (const v of versions) {
    if (v.dscrFloor === liveGov.dscrFloor && v.ltvCeiling === liveGov.ltvCeiling) {
      governorFingerprints.add(governorFingerprint({ ...liveGov, version: v.version }));
    }
  }
  return {
    ruleset,
    rctVersion: rct.rctVersion,
    governorFingerprints,
    currentGovernorRegime: governorFingerprint(liveGov),
    rct,
    governors: { dscrFloor: liveGov.dscrFloor, ltvCeiling: liveGov.ltvCeiling },
    engineCache: new Map(),
    stats: { engineRuns: 0 },
  };
}

/**
 * Refute round 3 V1: inputs_version hashes input + ruleset + RCT + governor fingerprint — NOT engine
 * code — so a row persisted before an engine-logic change that moved the output without a ruleset
 * bump (e.g. #414: null officePct now earns half product-fit credit) still matched its key. Re-run
 * the engine deterministically on the stored input with the live ruleset / RCT, apply the SAME
 * governor proxy persistAndLogScore applies (post-proxy comparison), and require every
 * decision-relevant output (acq-score-compare.ts storedVsLiveDiffs — X2 widened it to the cap
 * reasons, cappedAtT2, ddCriticalUnresolved, floorIndeterminate, advisory_only and
 * governor_dscr_cleared) to equal what is stored. Returns a mismatch description, or null when the
 * stored output is reproduced. A throwing re-run fails closed.
 *
 * X3: the re-run is memoized on the regime object (one regime is built per request), keyed on the
 * stored input_json, so the engine runs at most once per distinct stored input per request.
 */
export function liveEngineOutput(input: AcquisitionInput, inputKey: string, live: LiveScoringRegime): LiveEngineOutput | Error {
  const cached = live.engineCache.get(inputKey);
  if (cached !== undefined) return cached;
  let out: LiveEngineOutput | Error;
  try {
    live.stats.engineRuns++;
    const raw = scoreAcquisition(input, live.ruleset, { rct: live.rct });
    const { score: governed, governorDscrCleared, governorLtvCleared } = applyGovernorProxyToScore(raw, input, live.governors);
    out = { governed, governorDscrCleared, governorLtvCleared };
  } catch (e) {
    out = e instanceof Error ? e : new Error(String(e));
  }
  live.engineCache.set(inputKey, out);
  return out;
}

function engineOutputMismatch(
  row: PersistedScoreRow,
  score: AcquisitionScore,
  input: AcquisitionInput,
  live: LiveScoringRegime,
): string | null {
  const out = liveEngineOutput(input, row.input_json ?? '', live);
  if (out instanceof Error) return `engine re-run failed (${out.message})`;
  const diffs = storedVsLiveDiffs(row, score, out);
  return diffs.length === 0 ? null : diffs.join('; ');
}

/** The persisted columns classification needs (current acq_scores row -- acq_candidates.current_score_id -- joined to its acq_score_inputs row). */
export interface PersistedScoreRow {
  inputs_version: string | null;
  score_json: string | null;
  ruleset_version: string | null;
  rct_version: string | null;
  input_json: string | null;
  /** Denormalized acq_scores.tier / verdict columns (optional: callers that predate H3 omit them). */
  tier?: string | null;
  verdict?: string | null;
  /** Denormalized acq_scores.composite (optional: older callers omit it; score_json is then used). */
  composite?: number | null;
  /** Denormalized flag columns compared by storedVsLiveDiffs (X2). Optional: omitted = not checked. */
  advisory_only?: number | null;
  capped_at_t2?: number | null;
  floor_indeterminate?: number | null;
  governor_dscr_cleared?: number | null;
  governor_ltv_cleared?: number | null;
  gates_passed?: number | null;
  floors_passed?: number | null;
}

/** The only tier/verdict pairs the engine + governor proxy can produce (acquisition.ts verdict
 *  precedence; applyGovernorProxyToScore demotes BOTH to PASS). */
const COHERENT_TIER_FOR_VERDICT: Readonly<Record<string, string>> = {
  PURSUE: 'T1', WATCH: 'T2', PASS: 'PASS', KILLED: 'KILLED',
};
function incoherentPair(tier: string | null | undefined, verdict: string | null | undefined): string | null {
  if (tier === undefined || verdict === undefined || tier === null || verdict === null) return null;
  return COHERENT_TIER_FOR_VERDICT[verdict] === tier ? null : `tier ${tier} with verdict ${verdict}`;
}

export interface ScoreClassification {
  state: ScoreState;
  /** Why the row is not 'current' (empty when current/unscored). */
  staleReasons: string[];
  /** The parsed score, when score_json parses under the live contract (even if stale). */
  score: AcquisitionScore | null;
}

function parseJson<T>(json: string | null, schema: { safeParse: (v: unknown) => { success: true; data: T } | { success: false } }): T | null {
  if (json === null) return null;
  try {
    const r = schema.safeParse(JSON.parse(json));
    return r.success ? r.data : null;
  } catch {
    return null;
  }
}

/**
 * The score_json.governorRegime stamp acq-engine writes (#463), or null when the blob is missing,
 * not JSON, or carries no string stamp. Read from the raw JSON on purpose: AcquisitionScore (the
 * contract) does not carry the stamp, so the schema parse strips it.
 */
export function governorRegimeStampOf(scoreJson: string | null): string | null {
  if (scoreJson === null) return null;
  try {
    const parsed = JSON.parse(scoreJson) as { governorRegime?: unknown } | null;
    return parsed !== null && typeof parsed === 'object' && typeof parsed.governorRegime === 'string'
      ? parsed.governorRegime
      : null;
  } catch {
    return null;
  }
}

/** Pure classification of one persisted latest-score row against the live regime. */
export function classifyPersistedScore(row: PersistedScoreRow | undefined, live: LiveScoringRegime | null): ScoreClassification {
  if (!row) return { state: 'unscored', staleReasons: [], score: null };
  const score = parseJson(row.score_json, AcquisitionScore);
  if (live === null) {
    return { state: 'stale', staleReasons: ['live scoring regime unavailable — freshness unverifiable'], score };
  }

  const reasons: string[] = [];
  if (row.ruleset_version !== live.ruleset.rulesetVersion) {
    reasons.push(`scored under ruleset ${row.ruleset_version ?? 'unknown'}; live is ${live.ruleset.rulesetVersion}`);
  }
  if (row.rct_version !== live.rctVersion) {
    reasons.push(`scored under RCT ${row.rct_version ?? 'unknown'}; live is ${live.rctVersion}`);
  }
  // Refute H3: a pre-fix row stored tier T1/T2 next to a governor-demoted PASS (INSERT OR IGNORE
  // never rewrites it). Incoherent pairs are stale — they must be re-scored, never read as current.
  const pairIssue = incoherentPair(row.tier, row.verdict) ?? (score ? incoherentPair(score.tier, score.verdict) : null);
  if (pairIssue !== null) {
    reasons.push(`incoherent persisted ${pairIssue} (pre-fix governor demotion shape) — re-score required`);
  }
  if (reasons.length > 0) return { state: 'stale', staleReasons: reasons, score };

  if (score === null) {
    return { state: 'unparseable', staleReasons: ['score_json does not parse as the live AcquisitionScore contract'], score: null };
  }
  // #463 governor-regime stamp (Option A merge): a PARSEABLE persisted blob must carry the LIVE
  // regime's exact fingerprint. Missing / malformed / older stamp ⇒ stale, so /acq/intel can never
  // read 'current' for a row the capital BUY gate withholds for regime staleness. Checked after the
  // parse so an unparseable blob keeps its explicit 'unparseable' state (it is never 'current' either).
  const stamp = governorRegimeStampOf(row.score_json);
  if (stamp !== live.currentGovernorRegime) {
    return {
      state: 'stale',
      staleReasons: [
        `governorRegime stamp ${stamp === null ? 'missing' : stamp} does not match the live governor regime ` +
          `${live.currentGovernorRegime} (capital_config changed since this score) — re-score required`,
      ],
      score,
    };
  }
  const input = parseJson(row.input_json, AcquisitionInput);
  if (input === null) {
    return { state: 'unparseable', staleReasons: ['stored input_json does not parse as the live AcquisitionInput contract — governor regime unverifiable'], score };
  }
  // The persisted dedup key folds (input, ruleset, rctVersion, governor fingerprint). Recomputing it
  // under each same-valued governor version tests "was THIS row scored with the live ruleset, RCT
  // and the governor VALUES scoring reads today" (refute H2: values, not version number).
  let matches = false;
  for (const fp of live.governorFingerprints) {
    if (computeInputsVersion(input, live.ruleset, live.rctVersion, fp) === row.inputs_version) { matches = true; break; }
  }
  if (!matches) {
    return {
      state: 'stale',
      staleReasons: ['scored under different governor values (DSCR floor / LTV ceiling / screening debt constant) than the live capital_config'],
      score,
    };
  }
  const mismatch = engineOutputMismatch(row, score, input, live);
  if (mismatch !== null) {
    return { state: 'stale', staleReasons: [`engine output differs from stored score: ${mismatch}`], score };
  }
  return { state: 'current', staleReasons: [], score };
}

/**
 * SQL: a candidate's CURRENT score row + its input snapshot — the ONE per-candidate reader shared by
 * classifyLatestScore, the re-score sweep and the capital BUY gate (capital-allocation.ts
 * loadPipelineCandidates). Param: candidate id.
 *
 * "Current" is acq_candidates.current_score_id (#464, migrations 036/037), NOT the newest row by
 * scored_at: persistAndLogScore sets the pointer on every exit (insert, no-op, supersede, reinstate)
 * and keeps scored_at ordering consistent with it; migration 037's AFTER INSERT trigger points a raw
 * insert (pre-036 code) at the new row. /acq/intel (api.ts), brain-report and logAcqOutcome join the
 * same pointer, so every reader serves the same acq_scores row (pinned by
 * tests/unit/acq-current-score-one-definition.test.ts). In the Wave 2a / #464 composition the BUY gate
 * deliberately agrees with the pointer: BUY is decided on the score every other surface shows.
 */
export const CURRENT_SCORE_WITH_INPUTS_SQL = `
  SELECT s.id AS score_id, s.candidate_id, s.inputs_version, s.score_json, s.tier, s.verdict, s.composite,
         s.advisory_only, s.capped_at_t2, s.floor_indeterminate, s.governor_dscr_cleared,
         s.governor_ltv_cleared, s.gates_passed, s.floors_passed,
         i.ruleset_version, i.rct_version, i.input_json
  FROM acq_candidates c
  JOIN acq_scores s ON s.id = c.current_score_id
  LEFT JOIN acq_score_inputs i ON i.id = s.score_input_id
  WHERE c.id = ?`;

export function classifyLatestScore(db: WarehouseDb, candidateId: string, live: LiveScoringRegime | null): ScoreClassification {
  const row = db.prepare(CURRENT_SCORE_WITH_INPUTS_SQL).get(candidateId) as PersistedScoreRow | undefined;
  return classifyPersistedScore(row, live);
}

export interface RescoreSweepResult {
  examined: number;
  rescored: number;
  alreadyCurrent: number;
  unscored: number;
  unrescorable: Array<{ candidateId: string; reason: string }>;
}

/**
 * Re-score every candidate (default: status 'active') whose latest score is not 'current' under the
 * live regime, from that row's stored input_json, through persistAndLogScore. Never throws per
 * candidate: an un-re-scorable row (unparseable input, or a re-score that did not yield a current
 * latest row) is reported. Throws up front only if the supplied ruleset/RCT fail the production
 * ratification asserts.
 */
export async function rescoreStaleCandidates(
  db: WarehouseDb,
  ruleset: AcquisitionRuleset,
  rct: ReplacementCostTable,
  opts: { statuses?: ReadonlyArray<'active' | 'archived' | 'acquired' | 'passed'> } = {},
): Promise<RescoreSweepResult> {
  // Fail closed BEFORE touching any row: a sweep may only re-derive scores from the ratified config.
  assertProductionRuleset(ruleset);
  assertProductionRct(rct);
  const statuses = opts.statuses ?? ['active'];
  const ids = (db
    .prepare(`SELECT id FROM acq_candidates WHERE status IN (${statuses.map(() => '?').join(',')}) ORDER BY id`)
    .all(...statuses) as Array<{ id: string }>).map((r) => r.id);

  const live = liveScoringRegime(db, ruleset, rct);
  const result: RescoreSweepResult = { examined: ids.length, rescored: 0, alreadyCurrent: 0, unscored: 0, unrescorable: [] };
  const stmt = db.prepare(CURRENT_SCORE_WITH_INPUTS_SQL);
  for (const id of ids) {
    const row = stmt.get(id) as PersistedScoreRow | undefined;
    const c = classifyPersistedScore(row, live);
    if (c.state === 'unscored') { result.unscored++; continue; }
    if (c.state === 'current') { result.alreadyCurrent++; continue; }
    const input = parseJson(row?.input_json ?? null, AcquisitionInput);
    if (input === null) {
      result.unrescorable.push({ candidateId: id, reason: 'stored input_json does not parse as AcquisitionInput' });
      continue;
    }
    try {
      await persistAndLogScore(db, id, input, ruleset, rct);
      // Verify, never assume: INSERT OR IGNORE no-ops when the live key already exists as an OLDER
      // row (e.g. a ruleset reversion), leaving the stale row as the latest. Report that honestly.
      const after = classifyPersistedScore(stmt.get(id) as PersistedScoreRow | undefined, live);
      if (after.state === 'current') result.rescored++;
      else result.unrescorable.push({ candidateId: id, reason: `re-score did not produce a current latest row (${after.state}: ${after.staleReasons.join('; ')})` });
    } catch (e) {
      result.unrescorable.push({ candidateId: id, reason: e instanceof Error ? e.message : String(e) });
    }
  }
  return result;
}
