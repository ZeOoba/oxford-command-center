// server/warehouse/brain-report.ts
//
// Lane L2d — Command Brain report engine (Phase 5a.2 read boundary).
//
// Pure(-ish) over an injected WarehouseDb: composes the EXISTING calibration report/pending
// queues, the resolved-outcome accuracy history, coverage-based confidence cohorts, and the
// honest "open questions" gap surface into one BrainReport envelope (src/contracts/brain-report.ts).
// Design goal (per the contract file's header comment): no invented accuracy, memory, or
// confidence — every figure derives from calibration/data-quality/acquisition data, or is absent
// (null / empty array), never fabricated.
//
// Reuses rather than re-derives:
//   - calibrationReport(db)  — overall hit rate + resolved total (./calibration.ts, ~L957).
//   - calibrationPending(db) — the due-but-unresolved verdict queue → watchedSignals (~L1179).
//   - wilson()               — the Wilson score interval, imported from server/insights/stats.ts
//                              (NOT server/warehouse/calibration.ts's private copy — that module's
//                              own `wilson` is unexported and Architect-owned; stats.ts documents
//                              its export as the same formula as calibration.ts's private copy —
//                              stats.ts additionally guards non-finite/out-of-range inputs, so it
//                              is not byte-for-byte identical, though the two are unreachable-
//                              equivalent in how this file calls it — i.e. the sanctioned reuse
//                              point. This file never reimplements the formula.
//   overallCi is derived from the exact INTEGER hits/scoreable totals already computed per-kind by
//   calibrationReport (summed here across byKind) — never from re-deriving a rate and rounding it,
//   which would risk a floating-point-induced hit/miss drift at the boundary.
import type { WarehouseDb } from './db';
import { calibrationReport, calibrationPending } from './calibration';
import type { CalibrationReport } from './calibration';
import { wilson, MIN_PAIRS } from '../insights/stats';
import { clamp } from './clamp';
import type {
  BrainReport,
  AccuracyPoint,
  ConfidenceRow,
  OpenQuestion,
  TrackRecordEntry,
  VersionEvent,
} from '../../src/contracts/brain-report';

// ── Named constants (no bare literals in the logic below) ───────────────────────────────────

/** Coverage-confidence curve: sampleN=20 resolved verdicts reaches the (capped) ceiling. Arbitrary
 *  but documented — NOT a claim of predictive skill (see BASIS_NOTE, which travels with every row). */
const COVERAGE_SAMPLE_DENOMINATOR = 20;
/** A sample count alone never means certainty — confidence is capped well short of 1. */
const COVERAGE_CONFIDENCE_CEILING = 0.95;
const COVERAGE_CONFIDENCE_FLOOR = 0;
const BASIS_NOTE = 'coverage-based, not predictive skill';

const TRACK_RECORD_CAP = 50;
const OPEN_QUESTION_GROUP_CAP = 10;
const VERSION_LOG_CAP = 20;

/** Insight-family dormancy status. MUST mirror L2c's family list exactly: CF is the only family
 *  with a live generator (server/insights/generators/cf-hurdle-drag.ts); DR/TE/TR/CR have none yet.
 *  Hardcoded rather than derived from a directory listing — a directory scan can't distinguish
 *  "no generator exists" from "a generator exists but isn't wired into rank.ts yet," and an honest
 *  open question needs the former, stronger claim. Descriptions match src/contracts/insights.ts's
 *  InsightFamilySchema doc comment (the canonical family definitions). */
const DORMANT_FAMILIES: ReadonlyArray<{ code: string; description: string }> = [
  { code: 'DR', description: 'data-driven regime shifts' },
  { code: 'TE', description: 'tenant-action effects' },
  { code: 'TR', description: 'track-record signals' },
  { code: 'CR', description: 'concentration risk' },
];

// ── accuracySeries ────────────────────────────────────────────────────────────────────────────

interface MonthlyOutcomeRow {
  month: string;
  hit: number | null;
}

/**
 * Group resolved (is_resolution=1) calibration_outcome rows by the calendar month of
 * `resolved_at` (005_calibration.sql — the outcome's own timestamp column, not the verdict's
 * as_of_period). Only months with at least one resolution appear — a month with zero resolutions
 * is a genuine gap in the array, not a synthesized zero (contract header comment).
 *
 * hitRate = hits / scoreableN, where scoreableN counts ONLY hit ∈ {0,1} rows — this mirrors
 * calibration.ts's own scoreable definition exactly (calibration.ts:934,1014-1018,1069), which is
 * also what this report's own overallHitRate (reused verbatim from calibrationReport) is computed
 * over. hit=null ("not-scoreable" — e.g. every resolved 'hold' verdict carries no directional bet)
 * is routine and must be excluded from BOTH the numerator and the denominator; counting it in the
 * denominator only (as resolvedN does) would silently understate hitRate against the report's own
 * headline number. Within a present month, scoreableN < MIN_PAIRS (5) forces hitRate to null — the
 * same low-n honesty gate server/insights/stats.ts applies to correlation reads. Gating on
 * resolvedN instead would let a month of mostly not-scoreable resolutions (e.g. 4 not-scoreable +
 * 1 scoreable, resolvedN=5) publish a rate computed on a single usable data point — exactly the
 * theatrical-accuracy failure mode this module exists to prevent. resolvedN is still reported
 * alongside scoreableN, purely as an informational total.
 */
function buildAccuracySeries(db: WarehouseDb): AccuracyPoint[] {
  const rows = db.prepare(`
    SELECT substr(resolved_at, 1, 7) AS month, hit
    FROM calibration_outcome
    WHERE is_resolution = 1
  `).all() as MonthlyOutcomeRow[];

  const byMonth = new Map<string, { resolvedN: number; scoreableN: number; hits: number }>();
  for (const r of rows) {
    const agg = byMonth.get(r.month) ?? { resolvedN: 0, scoreableN: 0, hits: 0 };
    agg.resolvedN += 1;
    if (r.hit === 0 || r.hit === 1) {
      agg.scoreableN += 1;
      if (r.hit === 1) agg.hits += 1;
    }
    byMonth.set(r.month, agg);
  }

  return [...byMonth.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([month, agg]) => ({
      month,
      resolvedN: agg.resolvedN,
      scoreableN: agg.scoreableN,
      hitRate: agg.scoreableN < MIN_PAIRS ? null : agg.hits / agg.scoreableN,
    }));
}

// ── overall hit rate + CI + recalibrations (reused, not re-derived) ─────────────────────────────

/**
 * Overall Wilson CI, built from the exact integer (hits, scoreable) totals already computed
 * per-kind by calibrationReport (summed here) — reconstructs the same aggregate calibrationReport
 * itself accumulates internally (its own overallHits/overallScoreable are not exposed on
 * CalibrationReport), then hands them to the SHARED wilson() export. Never re-derives a rate from
 * calibrationReport.overallHitRate (which would reintroduce float rounding at the boundary).
 */
function buildOverallCi(report: CalibrationReport): { lo: number; hi: number } | null {
  let hits = 0;
  let scoreable = 0;
  for (const k of report.byKind) {
    hits += k.hits;
    scoreable += k.scoreable;
  }
  if (scoreable === 0) return null;
  const { low, high } = wilson(hits, scoreable);
  if (low === null || high === null) return null;
  return { lo: low, hi: high };
}

/** COUNT(DISTINCT config_hash) − 1 over calibration_inputs_version, floored at 0. NOT the raw
 *  inputs_version row count — a row forks on every P&L import even with an unchanged config. */
function countRecalibrations(db: WarehouseDb): number {
  const row = db.prepare(
    'SELECT COUNT(DISTINCT config_hash) AS c FROM calibration_inputs_version',
  ).get() as { c: number };
  return Math.max(0, row.c - 1);
}

// ── trackRecord ──────────────────────────────────────────────────────────────────────────────

interface TrackRecordRawRow {
  verdictId: number;
  kind: string;
  subject: string;
  predictedBand: string | null;
  realizedBand: string | null;
  hit: number | null;
  resolvedAt: string | null;
  predictedValue: number | null;
  realizedValue: number | null;
}

/** Every resolved verdict (is_resolution=1) joined to its blessed outcome, newest first, capped.
 *  outcome is a pure function of hit: 1→'hit', 0→'miss', null→'not-scoreable' — no other states
 *  exist in the schema (005_calibration.sql's calibration_outcome.hit is 1/0/NULL only). */
function buildTrackRecord(db: WarehouseDb): TrackRecordEntry[] {
  const rows = db.prepare(`
    SELECT v.id AS verdictId, v.verdict_kind AS kind, v.subject_id AS subject,
           v.predicted_band AS predictedBand, o.realized_band AS realizedBand,
           o.hit AS hit, o.resolved_at AS resolvedAt,
           v.predicted_value AS predictedValue, o.realized_value AS realizedValue
    FROM calibration_outcome o
    JOIN calibration_verdict v ON v.id = o.calibration_id
    WHERE o.is_resolution = 1
    ORDER BY o.resolved_at DESC, v.id DESC
    LIMIT ?
  `).all(TRACK_RECORD_CAP) as TrackRecordRawRow[];

  return rows.map((r) => ({
    verdictId: String(r.verdictId),
    kind: r.kind,
    subject: r.subject,
    // predictedBand is non-nullable on the contract (unlike the DB column, which may be null for a
    // purely-numeric verdict) — coalesce, mirroring calibrationReport's own `?? '(none)'` pattern.
    predictedBand: r.predictedBand ?? '(none)',
    realizedBand: r.realizedBand,
    outcome: r.hit === 1 ? 'hit' : r.hit === 0 ? 'miss' : 'not-scoreable',
    resolvedAt: r.resolvedAt,
    predictedValue: r.predictedValue,
    realizedValue: r.realizedValue,
  }));
}

// ── confidenceByMarket / confidenceByManager (coverage, NOT predictive skill) ───────────────────

interface CohortSampleRow {
  key: string;
  sampleN: number;
}

function toConfidenceRow(r: CohortSampleRow): ConfidenceRow {
  return {
    key: r.key,
    label: r.key,
    sampleN: r.sampleN,
    coverageConfidence: clamp(
      r.sampleN / COVERAGE_SAMPLE_DENOMINATOR,
      COVERAGE_CONFIDENCE_FLOOR,
      COVERAGE_CONFIDENCE_CEILING,
    ),
    basisNote: BASIS_NOTE,
  };
}

/** sampleN = resolved-verdict counts for property subjects, grouped by property_master.market.
 *  A property whose market is unknown (NULL) is skipped entirely — never bucketed as "unknown". */
function buildConfidenceByMarket(db: WarehouseDb): ConfidenceRow[] {
  const rows = db.prepare(`
    SELECT pm.market AS key, COUNT(*) AS sampleN
    FROM calibration_outcome o
    JOIN calibration_verdict v ON v.id = o.calibration_id
    JOIN property_master pm ON pm.id = v.subject_id
    WHERE o.is_resolution = 1 AND v.subject_kind = 'property' AND pm.market IS NOT NULL
    GROUP BY pm.market
    ORDER BY sampleN DESC, pm.market ASC
  `).all() as CohortSampleRow[];
  return rows.map(toConfidenceRow);
}

/** Same as buildConfidenceByMarket, grouped by property_master.property_manager instead. */
function buildConfidenceByManager(db: WarehouseDb): ConfidenceRow[] {
  const rows = db.prepare(`
    SELECT pm.property_manager AS key, COUNT(*) AS sampleN
    FROM calibration_outcome o
    JOIN calibration_verdict v ON v.id = o.calibration_id
    JOIN property_master pm ON pm.id = v.subject_id
    WHERE o.is_resolution = 1 AND v.subject_kind = 'property' AND pm.property_manager IS NOT NULL
    GROUP BY pm.property_manager
    ORDER BY sampleN DESC, pm.property_manager ASC
  `).all() as CohortSampleRow[];
  return rows.map(toConfidenceRow);
}

// ── openQuestions ────────────────────────────────────────────────────────────────────────────

interface DqIssueRow {
  kind: string;
  detail: string;
  propertyId: string | null;
}

/** Open (status='open') data_quality_issues rows, newest first, capped. wouldClose is the issue's
 *  own `detail` text — data_quality_issues carries no separate remediation column, and the detail
 *  string is written (by the ingest/detect/mapping layer) to already describe what's wrong, which
 *  is the closest honest answer to "what would close this" available without inventing one. */
function buildDataQualityQuestions(db: WarehouseDb): OpenQuestion[] {
  const rows = db.prepare(`
    SELECT kind, detail, property_id AS propertyId
    FROM data_quality_issues
    WHERE status = 'open'
    ORDER BY created_at DESC, id DESC  -- total order before LIMIT (created_at has 1-second resolution)
    LIMIT ?
  `).all(OPEN_QUESTION_GROUP_CAP) as DqIssueRow[];

  return rows.map((r) => ({
    kind: 'data-quality' as const,
    title: r.propertyId ? `${r.kind} — ${r.propertyId}` : r.kind,
    detail: r.detail,
    wouldClose: r.detail,
  }));
}

/** One open question per dormant insight family (DR/TE/TR/CR) — always emitted, not queried,
 *  since dormancy is a fact about the codebase (no generator file), not warehouse data. */
function buildDormantGeneratorQuestions(): OpenQuestion[] {
  return DORMANT_FAMILIES.map((f) => ({
    kind: 'dormant-generator' as const,
    title: `${f.code} insight family is dormant`,
    detail:
      `No generator has been implemented yet for the ${f.code} (${f.description}) insight family; `
      + 'CF is the only live family today.',
    wouldClose: 'a generator + resolved outcomes for this family',
  }));
}

interface FloorIndeterminateRow {
  id: number;
  candidateId: string;
  address: string | null;
  county: string | null;
  state: string | null;
}

/** acq_scores rows whose floor evaluation could not be completed (floor_indeterminate=1), newest
 *  first, capped. wouldClose is the fixed, literal reason per the spec — the underwriting inputs
 *  gap, not a per-row derivation.
 *
 *  DELIBERATELY FRESHNESS-AGNOSTIC (refute pass on b989339, item c): this is an open question about
 *  missing underwriting INPUTS, which a ruleset / RCT / governor regime change does not supply, so a
 *  'stale' latest row still poses it. It must also not depend on loading the ratified ruleset + RCT
 *  (classifyPersistedScore's live regime) — the brain report has to render when that config is
 *  unavailable. Freshness gates the BUY verdict and the ranked list, not this question. Pinned by
 *  tests/unit/acq-score-supersede.test.ts. The row read is the candidate's CURRENT score
 *  (acq_candidates.current_score_id, #464) — the same row every other reader serves (acq-score-freshness
 *  CURRENT_SCORE_WITH_INPUTS_SQL; pinned by tests/unit/acq-current-score-one-definition.test.ts). */
function buildFloorIndeterminateQuestions(db: WarehouseDb): OpenQuestion[] {
  // Dedup to the candidate's CURRENT score (acq_candidates.current_score_id; refute finding): the I1 governor-fingerprint fix mints
  // a new acq_scores row per governor regime, so a re-scored candidate can leave an older
  // floor_indeterminate=1 row behind it — an un-deduped scan double-lists the SAME candidate,
  // which under OPEN_QUESTION_GROUP_CAP can evict a genuinely distinct candidate from the report.
  const rows = db.prepare(`
    SELECT s.id AS id, s.candidate_id AS candidateId,
           c.address AS address, c.county AS county, c.state AS state
    FROM acq_scores s
    JOIN acq_candidates c ON c.current_score_id = s.id
    WHERE s.floor_indeterminate = 1
    ORDER BY COALESCE(c.current_scored_at, s.scored_at) DESC, s.id DESC
    LIMIT ?
  `).all(OPEN_QUESTION_GROUP_CAP) as FloorIndeterminateRow[];

  return rows.map((r) => {
    const label = r.address ?? (r.county && r.state ? `${r.county}, ${r.state}` : r.candidateId);
    return {
      kind: 'floor-indeterminate' as const,
      title: `Floor indeterminate — ${label}`,
      detail:
        `Acquisition score ${r.id} for candidate ${r.candidateId} could not evaluate one or more `
        + 'underwriting floors.',
      wouldClose: 'the missing underwriting inputs',
    };
  });
}

// ── versionLog ───────────────────────────────────────────────────────────────────────────────

interface CalibrationConfigLogRow {
  at: string;
  configTable: string;
  paramKey: string;
  oldValue: string | null;
  newValue: string;
  rationale: string | null;
}

/** capital_config / intel_config parameter-change audit trail (003_capital_config.sql). */
function buildConfigChangeEvents(db: WarehouseDb): VersionEvent[] {
  const rows = db.prepare(`
    SELECT logged_at AS at, config_table AS configTable, param_key AS paramKey,
           old_value AS oldValue, new_value AS newValue, rationale
    FROM calibration_log
    ORDER BY logged_at DESC
  `).all() as CalibrationConfigLogRow[];

  return rows.map((r) => ({
    // toIsoZ is idempotent and a no-op for the current writer's ISO-Z DEFAULT — applied here too
    // (not just in buildInputsVersionEvents) so the single-format invariant sortVersionEvents
    // relies on is enforced structurally, not by every future calibration_log writer happening
    // to use that DEFAULT rather than the space-separated datetime('now') form.
    at: toIsoZ(r.at),
    kind: 'config-change' as const,
    detail:
      `${r.configTable}.${r.paramKey}: ${r.oldValue ?? '(unset)'} → ${r.newValue}`
      + (r.rationale ? ` — ${r.rationale}` : ''),
  }));
}

interface InputsVersionFirstSeenRow {
  configHash: string;
  firstSeen: string;
}

/** Normalize a raw calibration_inputs_version.created_at value — SQLite's `datetime('now')`
 *  default, e.g. "2026-07-06 03:58:55" (space-separated, no zone suffix) — into the exact
 *  ISO-8601-Z shape calibration_log.logged_at already uses (its DEFAULT is the explicit
 *  `strftime('%Y-%m-%dT%H:%M:%SZ', 'now')`, e.g. "2026-07-06T03:58:55Z"). Both are UTC,
 *  second-precision; SQLite just formats them differently by default — verified empirically
 *  (better-sqlite3, in-process): `datetime('now')` never emits 'T', `strftime(...,'Z')` always
 *  does. Without this normalization, a plain string sort of the two raw shapes is WRONG whenever
 *  a config-change and an inputs-version event fall on the same calendar day: ' ' (0x20) sorts
 *  before 'T' (0x54), so the space-separated string always compares "smaller" regardless of the
 *  time of day that follows it — an inputs-version event genuinely LATER in the day than a
 *  same-day config-change event would still sort as if it were earlier. Idempotent: a value that
 *  already contains 'T' (already normalized, or some future producer emits ISO-Z directly) is
 *  passed through unchanged. */
function toIsoZ(sqliteTimestamp: string): string {
  return sqliteTimestamp.includes('T') ? sqliteTimestamp : `${sqliteTimestamp.replace(' ', 'T')}Z`;
}

/** First-seen date of each DISTINCT config_hash in calibration_inputs_version — the moment a new
 *  weight regime started producing verdicts, independent of the raw (import-forking) row count. */
function buildInputsVersionEvents(db: WarehouseDb): VersionEvent[] {
  const rows = db.prepare(`
    SELECT config_hash AS configHash, MIN(created_at) AS firstSeen
    FROM calibration_inputs_version
    GROUP BY config_hash
    ORDER BY firstSeen DESC
  `).all() as InputsVersionFirstSeenRow[];

  return rows.map((r) => ({
    at: toIsoZ(r.firstSeen),
    kind: 'inputs-version' as const,
    detail: `Inputs version config_hash ${r.configHash} first seen`,
  }));
}

/** Merge + sort already-built VersionEvent lists newest-first, capped. Exported (not just
 *  internal) so ordering determinism/transitivity is directly unit-testable against hand-built
 *  event lists, independent of DB row insertion order.
 *
 *  A SINGLE comparison basis only: plain lexicographic `b.at.localeCompare(a.at)` on the raw `at`
 *  string, never Date.parse. The prior version mixed numeric `Date.parse` comparison (when both
 *  sides parsed) with a `localeCompare` string fallback (when either side failed to parse) IN THE
 *  SAME comparator — that is non-transitive in general (cmp(A,B) and cmp(B,C) can each use a
 *  different basis than cmp(A,C)), which breaks Array.sort's ordering guarantee and made the
 *  20-item cap silently keep/drop different entries depending on input order. Every `at` this
 *  function receives is normalized to one ISO-8601-Z shape by both producers (each routes its raw
 *  timestamp through toIsoZ, idempotent for the current ISO-Z writer) — same format, same
 *  (second) precision — so the primary key is a valid chronological order. A secondary tiebreak
 *  on (kind, detail) makes the FULL comparator a total order even when two events share an
 *  identical second (e.g. a multi-parameter governance ratification appends several
 *  calibration_log rows inside one transaction, all stamped with the same `logged_at`) — without
 *  it, which same-second event survives the CAP below would depend on the two source queries'
 *  unspecified SQL tie order among equal ORDER BY keys, not on this function's input. The result
 *  is independent of input order for every case, not just distinct timestamps. */
export function sortVersionEvents(events: readonly VersionEvent[]): VersionEvent[] {
  return [...events]
    .sort((a, b) => b.at.localeCompare(a.at) || a.kind.localeCompare(b.kind) || a.detail.localeCompare(b.detail))
    .slice(0, VERSION_LOG_CAP);
}

/** Merge config-change + inputs-version events, newest first, capped. See sortVersionEvents for
 *  the comparator itself. */
function buildVersionLog(db: WarehouseDb): VersionEvent[] {
  return sortVersionEvents([...buildConfigChangeEvents(db), ...buildInputsVersionEvents(db)]);
}

// ── entry point ──────────────────────────────────────────────────────────────────────────────

/** Most recent import_batches.imported_at among rows whose ledger_entries are actually SERVED
 *  (status='committed'), or null when nothing committed has been imported yet. This is the "data
 *  current as of" signal — distinct from buildBrainReport's `asOf` param, which is report-
 *  GENERATION time (see that field's contract-level doc).
 *
 * status-FILTERED (2026-08-24, PR #302 review finding): an import that landed but is
 * 'pending-review' (or 'duplicate'/'skipped'/'needs-adapter') sets its own ledger_entries.
 * is_active = 0 — its figures are NOT part of what's served (see ingest.ts). An unfiltered
 * MAX(imported_at) would let a pending-review import make dataAsOf look fresher than the actually-
 * served data, reproducing the exact staleness-masking failure mode this field exists to close. */
function latestImportedAt(db: WarehouseDb): string | null {
  const row = db
    .prepare("SELECT MAX(imported_at) AS latest FROM import_batches WHERE status = 'committed'")
    .get() as { latest: string | null } | undefined;
  return row?.latest ?? null;
}

/**
 * Build the composed Command Brain report. Correct on an empty warehouse: every count is 0, every
 * rate/CI is null, every array is [] — never throws, never fabricates a figure. `asOf` is supplied
 * by the caller (the route passes the request-time ISO timestamp) so this function stays a pure
 * read over `db` plus that one input.
 */
export function buildBrainReport(db: WarehouseDb, asOf: string): BrainReport {
  const report = calibrationReport(db);
  const pending = calibrationPending(db);

  const openQuestions: OpenQuestion[] = [
    ...buildDataQualityQuestions(db),
    ...buildDormantGeneratorQuestions(),
    ...buildFloorIndeterminateQuestions(db),
  ];

  return {
    asOf,
    dataAsOf: latestImportedAt(db),
    overallHitRate: report.overallHitRate,
    overallCi: buildOverallCi(report),
    resolvedTotal: report.resolvedVerdicts,
    watchedSignals: pending.length,
    recalibrations: countRecalibrations(db),
    accuracySeries: buildAccuracySeries(db),
    trackRecord: buildTrackRecord(db),
    confidenceByMarket: buildConfidenceByMarket(db),
    confidenceByManager: buildConfidenceByManager(db),
    openQuestions,
    versionLog: buildVersionLog(db),
    advisoryOnly: true,
  };
}
