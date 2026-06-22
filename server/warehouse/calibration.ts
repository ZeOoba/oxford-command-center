// server/warehouse/calibration.ts
// Score-vs-Outcome Calibration Log — Phase 1 (the 40-year feedback loop).
// Spec: docs/superpowers/specs/2026-06-13-calibration-log-design.md §1, §2, §7.
//
// Pure-ish module: computes the reproducibility key (inputs_version), maps the
// warehouse's existing verdicts (PropertyScore / AnomalyFlag) into calibration
// rows, and persists them idempotently. Design invariants enforced here:
//   • Append-only — verdicts are INSERT OR IGNORE'd, never UPDATEd/DELETEd.
//   • Deterministic — logging is a pure function of (verdict, inputs_version);
//     the dedup_key UNIQUE makes a re-run a no-op.
//   • Fail-open — logVerdicts NEVER throws to the caller; on any error it records
//     a data_quality_issues row and returns {written:0,skipped:0,error}. This is
//     observational machinery and must never become a governor.
// Reads INTEL_CONFIG read-only (never writes intel-config.ts). Touches no governor.
import { createHash } from 'node:crypto';
import type { WarehouseDb } from './db';
import type { AnomalyFlag } from './anomalies';
import type { AllocationVerdict } from '../../src/contracts/capital';
import { INTEL_CONFIG } from './intel-config';
import type { AnomalySeverity, HealthBand } from './intel-config';
import { scoreProperties } from './scores';
import type { PropertyScore } from './scores';
import { propertyPeriodMetrics } from './metrics';
import type { PeriodMetrics } from './metrics';
import {
  CalibrationVerdictSchema,
  CalibrationOutcomeSchema,
  CalibrationResolveRequestSchema,
  type CalibrationVerdict,
  type CalibrationOutcome,
  type CalibrationResolveRequest,
  type CalibrationLogRow,
  type InputsVersion,
} from '../../src/contracts/warehouse';
import { clamp } from './clamp';

// ── canonical JSON + hash (mirrors server/warehouse/acquisition.ts) ───────────────────────
function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify((v as Record<string, unknown>)[k])}`).join(',')}}`;
}
function sha16(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 16);
}

/** Engine code version: git short SHA injected at build, else 'dev' (spec §1.1 item 3). */
function codeVersion(): string {
  return process.env.ORA_CODE_VERSION ?? process.env.GIT_SHA ?? 'dev';
}

interface LedgerFingerprintRow {
  maxImport: number | null;
  activeCount: number | null;
  maxRowid: number | null;
}

interface MappingStateRow {
  maxRowid: number | null;
  mappingCount: number | null;
}

interface ClassProjectionRow {
  id: number;
  classification: string;
  normalized_category: string;
}

interface MappingProjectionRow {
  id: number;
  classification: string;
  normalized_category: string;
  match_kind: string;
}

/**
 * A deterministic digest of the active ledger's (classification, normalized_category) projection
 * plus the account_mappings state. This is what makes a RECLASSIFICATION move the inputs_version:
 * addMappingOverride() UPDATEs classification/normalized_category on active ledger rows WITHOUT
 * changing row count or ids, so the coarse max-import|count|max-rowid fingerprint above is blind to
 * it — yet those two columns drive propertyPeriodMetrics → scores → the verdict. Folding an
 * ordered hash of the projection (and the mappings table) into the fingerprint forces a fork
 * whenever a reclassification changes what the engine actually scored. Ordered by id for stable,
 * deterministic output (SQLite group_concat ordering is unspecified, so we order + hash in JS).
 */
function classificationDigest(db: WarehouseDb): string {
  // Active ledger projection: only the columns that feed the score (classification + normalized
  // category), ordered deterministically. A reclassification changes a row's tuple → changes the hash.
  const ledgerRows = db.prepare(`
    SELECT id, classification, normalized_category
    FROM ledger_entries WHERE is_active = 1 ORDER BY id
  `).all() as ClassProjectionRow[];
  const ledgerProjection = ledgerRows.map((r) => `${r.id}:${r.classification}:${r.normalized_category}`).join('|');

  // account_mappings state: a manual override that beats a seed (changing future re-resolution) and
  // the rederive it triggers are both captured by the ledger projection above, but hashing the
  // mappings table too means a mapping change is reflected even before/independent of a rederive.
  const mappingRows = db.prepare(`
    SELECT id, classification, normalized_category, match_kind
    FROM account_mappings ORDER BY id
  `).all() as MappingProjectionRow[];
  const mappingProjection = mappingRows.map((r) => `${r.id}:${r.classification}:${r.normalized_category}:${r.match_kind}`).join('|');

  // Cheap monotonic header (max rowid | count) so the digest also moves on pure inserts.
  const ms = db.prepare(`
    SELECT MAX(rowid) AS maxRowid, COUNT(*) AS mappingCount FROM account_mappings
  `).get() as MappingStateRow;
  const mappingHeader = `${ms.maxRowid ?? 0}|${ms.mappingCount ?? 0}`;

  return sha16(`${mappingHeader}#${sha16(ledgerProjection)}#${sha16(mappingProjection)}`);
}

/**
 * Deterministic content hash over the active-ledger state + config + code version (spec §1.1).
 * Upserts the resulting row into calibration_inputs_version via INSERT OR IGNORE (idempotent).
 *
 * `configOverride` exists ONLY for tests: it perturbs the hashed config so a config change can be
 * proven to fork the version without mutating the real INTEL_CONFIG (which is read-only here).
 * Production always passes nothing → the live INTEL_CONFIG is hashed and stored verbatim.
 */
export function computeInputsVersion(db: WarehouseDb, configOverride?: Record<string, unknown>): InputsVersion {
  // Ledger fingerprint: max active import id | count of active rows | max active rowid, PLUS a
  // digest of the active (classification, normalized_category) projection + the account_mappings
  // state. The coarse triple captures inserts/supersedes (new rows/ids); the digest captures an
  // in-place RECLASSIFICATION (a mapping override that UPDATEs active rows without changing count or
  // ids) — which moves the verdict and therefore MUST move the version (D1). Deterministic ordering.
  const fp = db.prepare(`
    SELECT
      (SELECT MAX(import_id) FROM ledger_entries WHERE is_active = 1) AS maxImport,
      (SELECT COUNT(*)       FROM ledger_entries WHERE is_active = 1) AS activeCount,
      (SELECT MAX(rowid)     FROM ledger_entries WHERE is_active = 1) AS maxRowid
  `).get() as LedgerFingerprintRow;
  const classDigest = classificationDigest(db);
  const ledgerFingerprint = `${fp.maxImport ?? 0}|${fp.activeCount ?? 0}|${fp.maxRowid ?? 0}|${classDigest}`;

  // The config that produced the verdict. Stored verbatim (config_json) so a future analyst can
  // read the literal weights without git archaeology; hashed (config_hash) so a weight change forks
  // the version. The test override is folded in as an extra discriminator (never in production).
  const configObject = configOverride ? { ...INTEL_CONFIG, __override: configOverride } : INTEL_CONFIG;
  const configJson = stableStringify(configObject);
  const configHash = sha16(configJson);
  const code = codeVersion();

  const inputsVersion = sha16(stableStringify({ ledgerFingerprint, configHash, code }));

  const iv: InputsVersion = {
    inputsVersion,
    ledgerFingerprint,
    configHash,
    codeVersion: code,
    configJson,
  };

  // Append-only upsert: the same content always re-hashes to the same key, so re-runs no-op.
  db.prepare(`
    INSERT OR IGNORE INTO calibration_inputs_version
      (inputs_version, ledger_fingerprint, config_hash, code_version, config_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(iv.inputsVersion, iv.ledgerFingerprint, iv.configHash, iv.codeVersion, iv.configJson);

  return iv;
}

// ── confidence proxy (spec §2.3) ──────────────────────────────────────────────────────────

/** Band confidence = normalized distance from the nearest health-band boundary, clamped to [0.5,0.95]. */
function bandConfidence(health: number): number {
  const { excellent, good, watch } = INTEL_CONFIG.healthBands;
  const boundaries = [excellent, good, watch];
  let nearest = Infinity;
  for (const b of boundaries) nearest = Math.min(nearest, Math.abs(health - b));
  // Half-width of the widest interior band as the normalizer (deterministic, config-derived).
  const halfWidth = Math.max((excellent - good) / 2, (good - watch) / 2, 1);
  return clamp(nearest / halfWidth, 0.5, 0.95);
}

/** Anomaly confidence = severityMultiple (move / threshold, recovered from severity tier) → [0.5,0.95]. */
function anomalyConfidence(severity: AnomalySeverity): number {
  // Map the discrete severity tier to a representative multiple, then to [0.5,0.95].
  const m = INTEL_CONFIG.anomaly.severityMultiples;
  const mult: Record<AnomalySeverity, number> = {
    low: 1,
    moderate: m.moderate,
    high: m.high,
    critical: m.critical,
  };
  // Linear map: multiple 1 → 0.5, multiple `critical` (4×) → 0.95.
  const lo = 1;
  const hi = m.critical;
  const frac = hi > lo ? (mult[severity] - lo) / (hi - lo) : 0;
  return clamp(0.5 + frac * (0.95 - 0.5), 0.5, 0.95);
}

function bandToAttention(band: PropertyScore['attentionBand']): 'up' | 'down' | 'flat' {
  // Attention is a risk read, not a directional NOI claim; map to flat (no directional bet).
  return band === 'green' ? 'up' : band === 'red' || band === 'orange' ? 'down' : 'flat';
}

function noiDirection(score: PropertyScore): 'up' | 'down' | 'flat' | 'n/a' {
  // Recover the directional NOI claim from the health reasons is brittle; instead read the
  // capital action / attention as the directional bet for capital-action verdicts.
  if (score.capitalAction === 'invest') return 'up';
  if (score.capitalAction === 'disposition-candidate') return 'down';
  return 'flat';
}

// ── verdict builders (spec §7 item 2) ──────────────────────────────────────────────────────

/** Spec §2.3 small-cohort threshold: cap confidence when the same-basis benchmark cohort has
 *  fewer than this many members (mirrors benchmarks.ts `smallSample = propertyCount < 3`). */
const SMALL_COHORT_N = 3;
const SMALL_COHORT_CONFIDENCE_CAP = 0.6;

/**
 * Map each PropertyScore → up to three CalibrationVerdict rows (health-band, attention,
 * capital-action). Deterministic in (scores, iv): no clock, no randomness, stable field order.
 * Small-cohort penalty (§2.3): when the property's same-basis NOI/SF benchmark cohort is small
 * (n < 3 — the benchmarks `smallSample` flag, which an n=2 cohort trips even though it still yields
 * a real quartile) OR the quartile is null (singleton/unknown-basis), the recorded confidence is
 * capped at 0.6 — the engine recording its own uncertainty (D4). This caps only the recorded
 * confidence proxy; it never touches a score VALUE.
 */
export function verdictsFromScores(
  scores: PropertyScore[],
  iv: InputsVersion,
  emittedBy: string,
): CalibrationVerdict[] {
  const out: CalibrationVerdict[] = [];
  for (const s of scores) {
    // §2.3: cohort n<3 (smallSample) OR an unrankable cohort (null quartile) → low-confidence.
    const lowCohort = s.benchmarkCohortSize < SMALL_COHORT_N || s.noiPerSfQuartile === null;
    const cap = (c: number): number => (lowCohort ? Math.min(c, SMALL_COHORT_CONFIDENCE_CAP) : c);
    const conf = cap(bandConfidence(s.health));

    // health-band — carries the numeric health score + its band.
    out.push(
      CalibrationVerdictSchema.parse({
        subjectKind: 'property',
        subjectId: s.propertyId,
        verdictKind: 'health-band',
        verdictEngine: 'scores',
        predictedBand: s.healthBand satisfies HealthBand as string,
        predictedValue: s.health,
        predictedUnit: 'score-0-100',
        confidence: conf,
        direction: noiDirection(s),
        reasons: s.reasons,
        asOfPeriod: s.period,
        horizonPeriods: 1,
        inputsVersion: iv.inputsVersion,
        emittedBy,
      }),
    );

    // attention — categorical only (band, no numeric value).
    out.push(
      CalibrationVerdictSchema.parse({
        subjectKind: 'property',
        subjectId: s.propertyId,
        verdictKind: 'attention',
        verdictEngine: 'scores',
        predictedBand: s.attentionBand,
        predictedValue: null,
        predictedUnit: 'band',
        confidence: conf,
        direction: bandToAttention(s.attentionBand),
        reasons: s.reasons,
        asOfPeriod: s.period,
        horizonPeriods: 1,
        inputsVersion: iv.inputsVersion,
        emittedBy,
      }),
    );

    // capital-action — categorical; natural horizon 1–3yr (record the lower bound, 1).
    out.push(
      CalibrationVerdictSchema.parse({
        subjectKind: 'property',
        subjectId: s.propertyId,
        verdictKind: 'capital-action',
        verdictEngine: 'scores',
        predictedBand: s.capitalAction,
        predictedValue: null,
        predictedUnit: 'band',
        confidence: conf,
        direction: noiDirection(s),
        reasons: s.reasons,
        asOfPeriod: s.period,
        horizonPeriods: 1,
        inputsVersion: iv.inputsVersion,
        emittedBy,
      }),
    );
  }
  return out;
}

/** Map each AnomalyFlag → one CalibrationVerdict row (verdict_kind 'anomaly'). Deterministic. */
export function verdictsFromAnomalies(
  flags: AnomalyFlag[],
  iv: InputsVersion,
  emittedBy: string,
): CalibrationVerdict[] {
  const out: CalibrationVerdict[] = [];
  for (const f of flags) {
    out.push(
      CalibrationVerdictSchema.parse({
        subjectKind: 'property',
        subjectId: f.propertyId,
        verdictKind: 'anomaly',
        // Sub-identity = the anomaly kind PLUS its subkey (the spiking/new category for
        // category-spike/new-category), so several distinct anomalies for one (property, period,
        // inputs_version) get distinct dedup_keys instead of colliding to one (D3). kind alone was
        // insufficient: the engine emits one category-spike PER category, so Taxes and Utilities
        // spikes share a kind — the same collision class as the alert-id fix (refute F1).
        verdictSubkind: f.subkey ? `${f.kind}:${f.subkey}` : f.kind,
        verdictEngine: 'anomalies',
        predictedBand: `${f.severity}:${f.kind}`,
        predictedValue: f.metricValue,
        predictedUnit: 'pct-change',
        confidence: anomalyConfidence(f.severity),
        // An anomaly describes a move that already happened; metricValue sign gives its direction.
        direction: f.metricValue === null ? 'n/a' : f.metricValue < 0 ? 'down' : 'up',
        reasons: [f.detail],
        asOfPeriod: f.period,
        horizonPeriods: 1,
        inputsVersion: iv.inputsVersion,
        emittedBy,
      }),
    );
  }
  return out;
}

// ── persistence (spec §7 item 2: logVerdicts) ──────────────────────────────────────────────
export interface LogVerdictsResult {
  written: number;
  skipped: number;
  error?: string;
}

/** For tests only: inject a synthetic failure to prove the fail-open path. */
export interface LogVerdictsOptions {
  forceError?: string;
}

/** Percent-encode the `|` field delimiter (and `%` itself) so a field value containing one cannot
 *  shift dedup_key field boundaries and alias a structurally-different verdict. A value with no `|`
 *  is returned byte-identical, so existing persisted dedup_keys are unchanged (zero ledger churn).
 *  Defensive: the enum/controlled fields never contain `|` today; this future-proofs the free-text
 *  subjectId / verdictSubkind (a category name flows into the latter). */
const encKey = (s: string): string => s.replace(/%/g, '%25').replace(/\|/g, '%7C');
function dedupKey(v: CalibrationVerdict): string {
  // verdictSubkind discriminates several anomalies sharing verdictKind='anomaly' for one
  // (subject, period, inputs_version); it is '' for the singleton scores kinds (D3).
  return [v.subjectKind, v.subjectId, v.verdictKind, v.verdictSubkind, v.asOfPeriod, v.inputsVersion]
    .map(encKey)
    .join('|');
}

/**
 * Validate + persist a verdict set in ONE transaction, idempotently (INSERT OR IGNORE on the
 * dedup_key UNIQUE). Returns {written, skipped}. NEVER throws to the caller: on ANY error it
 * rolls back, records a data_quality_issues row (kind='calibration-emit-failed'), and returns
 * {written:0, skipped:0, error}. This is the fail-open guarantee — calibration logging must never
 * block a commit, a score read, or a snapshot.
 */
export function logVerdicts(
  db: WarehouseDb,
  verdicts: CalibrationVerdict[],
  opts: LogVerdictsOptions = {},
): LogVerdictsResult {
  try {
    if (opts.forceError) throw new Error(opts.forceError);

    const ins = db.prepare(`
      INSERT OR IGNORE INTO calibration_verdict (
        subject_kind, subject_id, verdict_kind, verdict_subkind, verdict_engine,
        predicted_band, predicted_value, predicted_unit, confidence, direction, reasons_json,
        as_of_period, horizon_periods, inputs_version, emitted_by, dedup_key
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    let written = 0;
    let skipped = 0;
    const run = db.transaction((rows: CalibrationVerdict[]) => {
      for (const raw of rows) {
        // Re-validate at the persistence boundary (the builders already parse, but a caller could
        // hand-roll a verdict). A parse failure throws → caught below → fail-open.
        const v = CalibrationVerdictSchema.parse(raw);
        const r = ins.run(
          v.subjectKind, v.subjectId, v.verdictKind, v.verdictSubkind, v.verdictEngine,
          v.predictedBand, v.predictedValue, v.predictedUnit, v.confidence, v.direction,
          JSON.stringify(v.reasons),
          v.asOfPeriod, v.horizonPeriods, v.inputsVersion, v.emittedBy, dedupKey(v),
        );
        if (r.changes > 0) written += 1;
        else skipped += 1;
      }
    });
    run(verdicts);
    return { written, skipped };
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e);
    // Fail-open: record the failure, swallow it. Best-effort DQ write — if even this throws, we
    // still return the error rather than propagating (the commit path must survive regardless).
    try {
      db.prepare(
        "INSERT INTO data_quality_issues (kind, detail, severity) VALUES ('calibration-emit-failed', ?, 'warn')",
      ).run(detail);
    } catch {
      /* swallow — the calibration log is observational; nothing it does may block the warehouse. */
    }
    return { written: 0, skipped: 0, error: detail };
  }
}

// ════════════════════════════════════════════════════════════════════════════════════════════
// Phase 2 — the RESOLVER + the REPORT (spec §3, §4). Both are pure reads over the warehouse:
// the resolver writes ONLY calibration_outcome rows (never mutates a verdict — append-only); the
// report writes nothing. Both degrade gracefully on an empty / no-outcome-data warehouse — the
// central Phase-2 caveat: real outcome data does not exist yet (it needs ≥1 horizon elapsed), so
// zero unresolved / zero due is a NORMAL no-op that returns a zeroed result, never an error and
// never a divide-by-zero.
// ════════════════════════════════════════════════════════════════════════════════════════════

// ── §3 the resolver ─────────────────────────────────────────────────────────────────────────

export interface ResolveOutcomesResult {
  scanned: number; // verdicts examined (unresolved, with a finite horizon)
  due: number; // verdicts whose horizon is now covered by a same-grain later period
  resolved: number; // outcome rows blessed (is_resolution = 1)
  skippedNoData: number; // due-by-period but the realized metric was not derivable (pending)
  errors: number; // per-verdict failures (logged to data_quality_issues; never thrown)
}

const EMPTY_RESOLVE: ResolveOutcomesResult = { scanned: 0, due: 0, resolved: 0, skippedNoData: 0, errors: 0 };

interface OpenVerdictRow {
  id: number;
  subject_kind: string;
  subject_id: string;
  verdict_kind: string;
  verdict_subkind: string;
  predicted_band: string | null;
  predicted_value: number | null;
  predicted_unit: string | null;
  confidence: number | null;
  direction: string | null;
  as_of_period: string;
  horizon_periods: number | null;
}

/** A property's full-year (same-grain) metrics keyed by period 'YYYY', for outcome lookups. */
function fullYearMetricsByProperty(metrics: PeriodMetrics[]): Map<string, Map<string, PeriodMetrics>> {
  const out = new Map<string, Map<string, PeriodMetrics>>();
  for (const m of metrics) {
    // GRAIN DISCIPLINE (§3.1): only same-grain FULL-YEAR periods may resolve a full-year verdict. A
    // YTD partial is never a valid outcome period (a 12-mo-vs-partial comparison manufactures a
    // spurious ≈−50% move — the exact trap growth.ts/anomalies.ts already guard). Drop non-year grains.
    if (m.grainHint !== 'year') continue;
    const byPeriod = out.get(m.propertyId) ?? new Map<string, PeriodMetrics>();
    byPeriod.set(m.period, m);
    out.set(m.propertyId, byPeriod);
  }
  return out;
}

/** % change vs a prior base; null when the base is missing or <= 0 (mirrors growth.ts pctChange). */
function pctChange(prev: number | null, cur: number | null): number | null {
  if (prev === null || cur === null) return null;
  return prev > 0 ? (cur - prev) / prev : null;
}

/** Re-band a realized health score with the SAME band cutoffs the engine used (deterministic). */
function bandHealth(health: number): HealthBand {
  const { excellent, good, watch } = INTEL_CONFIG.healthBands;
  return health >= excellent ? 'excellent' : health >= good ? 'good' : health >= watch ? 'watch' : 'concern';
}

interface ScoredOutcome {
  realizedBand: string | null;
  realizedValue: number | null;
  realizedUnit: CalibrationOutcome['realizedUnit'];
  hit: 0 | 1 | null;
  absError: number | null;
  resolutionBasis: string;
}

/**
 * Score ONE due verdict against the realized same-grain outcome period (§3.1). Pure: returns the
 * outcome fields, or null when the realized metric is not derivable (→ caller leaves it pending).
 * `outcomeNoiGrowth` is the realized same-grain NOI growth at the outcome period (null when the prior
 * base is non-positive); `realizedHealth` is the re-scored health at the outcome period when available.
 */
function scoreVerdict(
  v: OpenVerdictRow,
  outcomeNoiGrowth: number | null,
  realizedHealth: number | null,
): ScoredOutcome | null {
  switch (v.verdict_kind) {
    case 'health-band':
    case 'forecast': {
      // Numeric verdict: realized = the re-scored health at the outcome period. hit = realized band
      // matches predicted band. abs_error = |realized − predicted| in the predicted unit.
      if (realizedHealth === null) return null;
      const realizedBand = bandHealth(realizedHealth);
      const hit: 0 | 1 | null = v.predicted_band === null ? null : realizedBand === v.predicted_band ? 1 : 0;
      const absError = v.predicted_value === null ? null : Math.abs(realizedHealth - v.predicted_value);
      return { realizedBand, realizedValue: realizedHealth, realizedUnit: 'score-0-100', hit, absError, resolutionBasis: 'realized-noi-trend' };
    }
    case 'capital-action': {
      // disposition-candidate/monitor hit when realized NOI did NOT grow (≤0); invest hit when it grew.
      // Other actions (hold) carry no directional bet → not scoreable (hit null) but record the trend.
      if (outcomeNoiGrowth === null) return null;
      let hit: 0 | 1 | null;
      if (v.predicted_band === 'invest') hit = outcomeNoiGrowth > 0 ? 1 : 0;
      else if (v.predicted_band === 'disposition-candidate' || v.predicted_band === 'monitor') hit = outcomeNoiGrowth <= 0 ? 1 : 0;
      else hit = null; // 'hold' — no directional claim
      return { realizedBand: outcomeNoiGrowth > 0 ? 'noi-grew' : 'noi-flat-or-declined', realizedValue: outcomeNoiGrowth, realizedUnit: 'pct-change', hit, absError: null, resolutionBasis: 'realized-noi-trend' };
    }
    case 'attention': {
      // red/orange predicted distress → hit when distress materialized (realized NOI declined).
      // green/yellow predicted calm → hit when it did NOT decline. Symmetric, directional.
      if (outcomeNoiGrowth === null) return null;
      const declined = outcomeNoiGrowth < 0;
      let hit: 0 | 1 | null;
      if (v.predicted_band === 'red' || v.predicted_band === 'orange') hit = declined ? 1 : 0;
      else if (v.predicted_band === 'green' || v.predicted_band === 'yellow') hit = declined ? 0 : 1;
      else hit = null;
      return { realizedBand: declined ? 'declined' : 'held', realizedValue: outcomeNoiGrowth, realizedUnit: 'pct-change', hit, absError: null, resolutionBasis: 'realized-noi-trend' };
    }
    case 'anomaly': {
      // Concurrent flag: its "outcome" is a persistence check — did the flagged distress recur/worsen
      // next period (true positive) or revert (likely noise)? A negative metricValue (decline) that
      // persists (realized NOI also fell) = hit; a revert (NOI grew back) = miss.
      if (outcomeNoiGrowth === null) return null;
      const recurred = outcomeNoiGrowth < 0;
      const hit: 0 | 1 = recurred ? 1 : 0;
      return { realizedBand: recurred ? 'persisted' : 'reverted', realizedValue: outcomeNoiGrowth, realizedUnit: 'pct-change', hit, absError: null, resolutionBasis: 'realized-noi-trend' };
    }
    default:
      // refi-score / acquisition-score: reserved kinds with no warehouse-derivable outcome yet.
      return null;
  }
}

/**
 * Resolve due calibration verdicts against ACTUAL later outcomes (spec §3.1). For every verdict that
 *   (a) has a finite horizon and no is_resolution=1 outcome yet, and
 *   (b) whose as_of_period + horizon_periods is now covered by a strictly-later SAME-GRAIN (full-year)
 *       period for that subject,
 * insert a blessed (is_resolution=1) calibration_outcome scoring the verdict against the realized
 * NOI trend / re-banded health at that outcome period.
 *
 * GRACEFUL DEGRADATION (the central Phase-2 caveat): a brand-new warehouse with zero verdicts, or
 * verdicts whose horizon has not yet elapsed (no later same-grain period), is a NORMAL no-op — it
 * returns the zeroed result, writes nothing, and NEVER throws or divides by zero. This is what lets
 * the resolver ship today, before any outcome data exists.
 *
 * Append-only: never UPDATEs/DELETEs a verdict; the partial unique index (one is_resolution=1 per
 * verdict) makes a second run on already-resolved verdicts a no-op (idempotent). Per-verdict failures
 * are counted + recorded to data_quality_issues, never thrown (fail-open, mirroring logVerdicts).
 */
export function resolveDueOutcomes(db: WarehouseDb): ResolveOutcomesResult {
  let metrics: PeriodMetrics[];
  let openVerdicts: OpenVerdictRow[];
  try {
    metrics = propertyPeriodMetrics(db);
    // Only PROPERTY-subject verdicts with a finite horizon and NO blessed resolution are candidates.
    // Reserved subject kinds (portfolio/tenant/loan/deal/pm) have no warehouse-derivable outcome yet.
    openVerdicts = db.prepare(`
      SELECT v.id, v.subject_kind, v.subject_id, v.verdict_kind, v.verdict_subkind,
             v.predicted_band, v.predicted_value, v.predicted_unit, v.confidence, v.direction,
             v.as_of_period, v.horizon_periods
      FROM calibration_verdict v
      WHERE v.subject_kind = 'property'
        AND v.horizon_periods IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM calibration_outcome o
          WHERE o.calibration_id = v.id AND o.is_resolution = 1
        )
      ORDER BY v.id
    `).all() as OpenVerdictRow[];
  } catch (e) {
    recordResolveFailure(db, `resolveDueOutcomes setup: ${e instanceof Error ? e.message : String(e)}`);
    return { ...EMPTY_RESOLVE, errors: 1 };
  }

  if (openVerdicts.length === 0) return { ...EMPTY_RESOLVE };

  const fyByProperty = fullYearMetricsByProperty(metrics);
  // Re-score the warehouse ONCE so health-band/forecast outcomes can re-band the realized health at
  // each property's latest full-year period. Deterministic; reading a strictly-later realized period
  // is not lookahead — the outcome genuinely occurred later (the verdict row itself is never touched).
  let realizedScores: PropertyScore[] = [];
  try {
    realizedScores = scoreProperties(db, metrics);
  } catch {
    // A scoring failure must not sink the whole resolver — numeric kinds simply stay pending.
    realizedScores = [];
  }
  const realizedHealthByProperty = new Map<string, { period: string; health: number }>();
  for (const s of realizedScores) realizedHealthByProperty.set(s.propertyId, { period: s.period, health: s.health });

  const insertOutcome = db.prepare(`
    INSERT INTO calibration_outcome
      (calibration_id, realized_band, realized_value, realized_unit, outcome_period, horizon_actual,
       hit, abs_error, action_taken, resolved_by, resolution_basis, is_resolution)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'unknown', ?, ?, 1)
  `);

  const result: ResolveOutcomesResult = { ...EMPTY_RESOLVE };

  for (const v of openVerdicts) {
    result.scanned += 1;
    try {
      const horizon = v.horizon_periods!; // finite per the WHERE clause
      const fy = fyByProperty.get(v.subject_id);
      if (!fy) {
        result.skippedNoData += 1;
        continue;
      }
      // The earliest full-year period that is strictly later AND ≥ horizon out from as_of_period.
      // as_of_period is a full-year token here (the scores engine only emits on a full-year period);
      // a YTD/'YYYY-MM' as_of never matches a full-year outcome key, so it self-excludes (grain safe).
      const asOfYear = parseFullYear(v.as_of_period);
      if (asOfYear === null) {
        // Non-full-year as_of (e.g. a YTD verdict) has no same-grain full-year resolution path yet.
        result.skippedNoData += 1;
        continue;
      }
      const targetYear = asOfYear + horizon;
      // Find the earliest available full-year outcome period at or after the target horizon year.
      let outcomePeriod: string | null = null;
      for (let y = targetYear; y <= asOfYear + horizon + MAX_HORIZON_SLACK; y++) {
        if (fy.has(String(y))) { outcomePeriod = String(y); break; }
      }
      if (outcomePeriod === null) {
        // Horizon not yet covered by a same-grain period → PENDING (not an error, not a miss).
        continue;
      }
      result.due += 1;

      // Realized same-grain NOI growth at the outcome period vs its immediate prior full-year period.
      const outcomeMetric = fy.get(outcomePeriod)!;
      const priorYear = String(Number(outcomePeriod) - 1);
      const priorMetric = fy.get(priorYear) ?? null;
      const outcomeNoiGrowth = pctChange(priorMetric?.noi ?? null, outcomeMetric.noi);

      // Realized health at the outcome period (only when the engine scored that very period — it scores
      // each property's latest full-year period; if that equals the outcome period we can re-band).
      const rh = realizedHealthByProperty.get(v.subject_id);
      const realizedHealth = rh && rh.period === outcomePeriod ? rh.health : null;

      const scored = scoreVerdict(v, outcomeNoiGrowth, realizedHealth);
      if (scored === null) {
        result.skippedNoData += 1;
        continue;
      }

      const horizonActual = Number(outcomePeriod) - asOfYear;
      // Validate at the persistence boundary (mirrors logVerdicts) — a malformed outcome stays pending.
      CalibrationOutcomeSchema.parse({
        calibrationId: v.id,
        realizedBand: scored.realizedBand,
        realizedValue: scored.realizedValue,
        realizedUnit: scored.realizedUnit,
        outcomePeriod,
        horizonActual,
        hit: scored.hit,
        absError: scored.absError,
        brierComponent: null,
        actionTaken: 'unknown',
        actionDetail: null,
        treatmentNote: null,
        resolvedBy: 'auto:next-period',
        resolutionBasis: scored.resolutionBasis,
        isResolution: true,
        inputsVersion: null,
      });

      insertOutcome.run(
        v.id, scored.realizedBand, scored.realizedValue, scored.realizedUnit, outcomePeriod,
        horizonActual, scored.hit, scored.absError, 'auto:next-period', scored.resolutionBasis,
      );
      result.resolved += 1;
    } catch (e) {
      // Per-verdict fail-open: count + record, never throw. One bad verdict can't sink the run.
      result.errors += 1;
      recordResolveFailure(db, `resolve verdict ${v.id}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  return result;
}

/** Look up to this many years past the intended horizon for the first available same-grain period
 *  (a firm imports irregularly; a 2024 1yr verdict may first see a comparable full year in 2026). */
const MAX_HORIZON_SLACK = 5;

/** Parse a 'YYYY' full-year period token to a number, or null for any non-full-year token. */
function parseFullYear(period: string): number | null {
  return /^\d{4}$/.test(period) ? Number(period) : null;
}

/** Best-effort DQ record for a resolver failure; swallows its own errors (observational machinery). */
function recordResolveFailure(db: WarehouseDb, detail: string): void {
  try {
    db.prepare(
      "INSERT INTO data_quality_issues (kind, detail, severity) VALUES ('calibration-resolve-failed', ?, 'warn')",
    ).run(detail);
  } catch {
    /* swallow — calibration is observational; nothing it does may block the warehouse */
  }
}

// ── §3.2 MANUAL resolution (the UI/ops write path) ───────────────────────────────────────────
// An analyst records the realized outcome of a pending verdict, or blesses/overrides an existing
// (auto or manual) resolution. This is the ONLY calibration WRITE the UI performs. Unlike the
// observational, fail-OPEN auto-resolver and logger, a manual write is a deliberate user action, so
// it FAILS CLOSED with a typed {ok:false,error} rather than silently swallowing — the UI must show the
// user exactly why a save was rejected. It still touches calibration_outcome ONLY (append-only; the
// verdict row is never mutated), never data/overlay.json, never a governor.

export type ResolveManualResult =
  | { ok: true; outcomeId: number; superseded: boolean; duplicate: boolean }
  | { ok: false; error: string };

/** True iff two period tokens share grain (both 'YYYY' full-year, or both 'YYYY-MM' month). The grain
 *  discipline guard: a full-year verdict may only be resolved against a full-year outcome period — a
 *  YTD-vs-full-year comparison manufactures the spurious ≈−50% move the whole warehouse guards against. */
function sameGrain(a: string, b: string): boolean {
  const yearA = /^\d{4}$/.test(a);
  const yearB = /^\d{4}$/.test(b);
  return yearA === yearB;
}

/** Strictly-later period comparison on the canonical 'YYYY' / 'YYYY-MM' tokens (lexicographic order
 *  is chronological for these zero-padded tokens). */
function isStrictlyLater(asOf: string, outcome: string): boolean {
  return outcome.localeCompare(asOf) > 0;
}

/**
 * Record a MANUAL resolution for one verdict (spec §3.2). Append-only + supersede + idempotent, all in
 * ONE transaction so the partial unique index (`idx_outcome_resolution`, one is_resolution=1 per
 * verdict) can never be violated and a concurrent reader never sees zero-or-two blessed rows:
 *   1. Zod-validate the body (rejects a no-signal resolution → fail closed).
 *   2. Verify the verdict exists (rejects an orphan → fail closed).
 *   3. GRAIN GUARD: the outcome period must be the SAME GRAIN as, and STRICTLY LATER than, the verdict's
 *      as_of period (rejects a YTD-vs-full-year or non-future outcome → fail closed).
 *   4. IDEMPOTENT: if the current blessed (is_resolution=1) row is byte-identical to this submission,
 *      it is a no-op (duplicate:true) — a double-submit never writes twice or supersedes itself.
 *   5. SUPERSEDE: any differing blessed row flips is_resolution=0 (preserved — append-only), then the
 *      new is_resolution=1 row is inserted.
 * The verdict row itself is NEVER read-modified-written — only calibration_outcome is touched.
 */
export function resolveManualOutcome(db: WarehouseDb, body: unknown): ResolveManualResult {
  const parsed = CalibrationResolveRequestSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues.map((i) => i.message).join('; ') };
  }
  const input: CalibrationResolveRequest = parsed.data;

  try {
    const verdict = db
      .prepare('SELECT id, as_of_period FROM calibration_verdict WHERE id = ?')
      .get(input.calibrationId) as { id: number; as_of_period: string } | undefined;
    if (!verdict) {
      return { ok: false, error: `verdict ${input.calibrationId} not found` };
    }

    // GRAIN + horizon guard (warehouse §9). Both checks are on canonical period tokens.
    if (!sameGrain(verdict.as_of_period, input.outcomePeriod)) {
      return {
        ok: false,
        error: `grain mismatch: a verdict at ${verdict.as_of_period} cannot be resolved against a different-grain outcome period ${input.outcomePeriod} (same-grain full-year/month only)`,
      };
    }
    if (!isStrictlyLater(verdict.as_of_period, input.outcomePeriod)) {
      return {
        ok: false,
        error: `outcome period ${input.outcomePeriod} must be strictly later than the verdict period ${verdict.as_of_period} (an outcome is a future realized state)`,
      };
    }

    // Validate the persisted shape at the boundary (mirrors logVerdicts/resolveDueOutcomes). horizonActual
    // is the elapsed gap; for full-year tokens that is the year delta, otherwise null (month grain — the
    // resolver doesn't yet score month-grain horizons, but a manual hit/band is still recorded).
    const asOfYear = parseFullYear(verdict.as_of_period);
    const outcomeYear = parseFullYear(input.outcomePeriod);
    const horizonActual = asOfYear !== null && outcomeYear !== null ? outcomeYear - asOfYear : null;
    CalibrationOutcomeSchema.parse({
      calibrationId: input.calibrationId,
      realizedBand: input.realizedBand,
      realizedValue: input.realizedValue,
      realizedUnit: input.realizedUnit,
      outcomePeriod: input.outcomePeriod,
      horizonActual,
      hit: input.hit,
      absError: null,
      brierComponent: null,
      actionTaken: input.actionTaken,
      actionDetail: input.actionDetail,
      treatmentNote: input.treatmentNote,
      resolvedBy: input.resolvedBy,
      resolutionBasis: input.resolutionBasis,
      isResolution: true,
      inputsVersion: null,
    });

    const tx = db.transaction((): { outcomeId: number; superseded: boolean; duplicate: boolean } => {
      const current = db
        .prepare(
          `SELECT id, realized_band, realized_value, realized_unit, outcome_period, hit,
                  action_taken, action_detail, treatment_note, resolved_by, resolution_basis
           FROM calibration_outcome WHERE calibration_id = ? AND is_resolution = 1`,
        )
        .get(input.calibrationId) as
        | {
            id: number;
            realized_band: string | null;
            realized_value: number | null;
            realized_unit: string | null;
            outcome_period: string;
            hit: number | null;
            action_taken: string;
            action_detail: string | null;
            treatment_note: string | null;
            resolved_by: string;
            resolution_basis: string;
          }
        | undefined;

      // IDEMPOTENT: a byte-identical re-submit is a no-op (no duplicate row, no self-supersede).
      if (
        current
        && current.realized_band === input.realizedBand
        && current.realized_value === input.realizedValue
        && current.realized_unit === input.realizedUnit
        && current.outcome_period === input.outcomePeriod
        && current.hit === input.hit
        && current.action_taken === input.actionTaken
        && current.action_detail === input.actionDetail
        && current.treatment_note === input.treatmentNote
        && current.resolved_by === input.resolvedBy
        && current.resolution_basis === input.resolutionBasis
      ) {
        return { outcomeId: current.id, superseded: false, duplicate: true };
      }

      // SUPERSEDE: demote the prior blessed row (preserved — append-only) BEFORE inserting the new one,
      // so the partial unique index never sees two is_resolution=1 rows at once.
      const superseded = current !== undefined;
      if (superseded) {
        db.prepare('UPDATE calibration_outcome SET is_resolution = 0 WHERE id = ?').run(current!.id);
      }
      const info = db
        .prepare(
          `INSERT INTO calibration_outcome
             (calibration_id, realized_band, realized_value, realized_unit, outcome_period, horizon_actual,
              hit, abs_error, brier_component, action_taken, action_detail, treatment_note,
              resolved_by, resolution_basis, is_resolution)
           VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?, ?, ?, 1)`,
        )
        .run(
          input.calibrationId, input.realizedBand, input.realizedValue, input.realizedUnit,
          input.outcomePeriod, horizonActual, input.hit, input.actionTaken, input.actionDetail,
          input.treatmentNote, input.resolvedBy, input.resolutionBasis,
        );
      return { outcomeId: Number(info.lastInsertRowid), superseded, duplicate: false };
    });

    const r = tx();
    return { ok: true, ...r };
  } catch (e) {
    // Manual writes FAIL CLOSED (unlike the observational auto path): surface the error to the UI.
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

// ── §4 the report ───────────────────────────────────────────────────────────────────────────

export interface CalibrationReportFilter {
  from?: string; // inclusive as_of_period lower bound ('YYYY')
  to?: string; // inclusive as_of_period upper bound ('YYYY')
  kind?: string; // restrict to one verdict_kind
}

export interface BandRate {
  band: string;
  scoreable: number;
  hits: number;
  hitRate: number | null;
}

export interface KindReport {
  verdictKind: string;
  total: number; // verdicts of this kind in range
  resolved: number; // with a blessed resolution
  scoreable: number; // resolved AND hit ∈ {0,1}
  hits: number;
  hitRate: number | null; // hits / scoreable; null when scoreable = 0 (never NaN)
  wilsonLow: number | null; // 95% Wilson interval (null when scoreable = 0)
  wilsonHigh: number | null;
  directionalScoreable: number; // resolved with a directional bet (direction up/down) + scoreable
  directionalHits: number;
  directionalAccuracy: number | null;
  meanSignedError: number | null; // bias: mean(predicted − realized) over numeric kinds; null if none
  byBand: BandRate[]; // hit-rate per predicted_band (§4.1: per-band, not just aggregate)
}

export interface CalibrationReport {
  from: string | null;
  to: string | null;
  kind: string | null;
  totalVerdicts: number;
  resolvedVerdicts: number;
  scoreableVerdicts: number;
  overallHitRate: number | null; // null when nothing scoreable (never NaN / never 0/0)
  treatmentAdjustedHitRate: number | null; // §4.1: over action_taken='none' rows ONLY (clean tests)
  treatmentAdjustedScoreable: number;
  byKind: KindReport[];
  dataMaturityNote: string; // §6: first ~5 years are data-accumulation, not actionable calibration
}

interface ResolvedRow {
  verdict_kind: string;
  predicted_band: string | null;
  predicted_value: number | null;
  direction: string | null;
  hit: number | null;
  realized_value: number | null;
  action_taken: string | null;
}

/** Hit-rate over a (hits, scoreable) pair; null when scoreable = 0 (the divide-by-zero guard). */
function rate(hits: number, scoreable: number): number | null {
  return scoreable === 0 ? null : hits / scoreable;
}

/** 95% Wilson score interval for a binomial proportion; null when n = 0. Reported with EVERY rate
 *  because at N≈14 a bare point estimate is statistically hollow (spec §6). z = 1.96. */
function wilson(hits: number, n: number): { low: number | null; high: number | null } {
  if (n === 0) return { low: null, high: null };
  const z = 1.96;
  const phat = hits / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const centre = (phat + z2 / (2 * n)) / denom;
  const margin = (z * Math.sqrt((phat * (1 - phat) + z2 / (4 * n)) / n)) / denom;
  return { low: Math.max(0, centre - margin), high: Math.min(1, centre + margin) };
}

/**
 * Aggregate resolved calibration outcomes into the §4 report shape. Pure read — mutates nothing.
 * CORRECT ON AN EMPTY DATASET: zero verdicts → totalVerdicts 0, every rate null (never NaN), byKind
 * []. A scoreable count of 0 always yields a null hit-rate, never 0/0. The treatment-adjusted rate
 * (§4.1) is computed over action_taken='none' rows alone — the only clean tests of predictive validity.
 */
export function calibrationReport(db: WarehouseDb, filter: CalibrationReportFilter = {}): CalibrationReport {
  const from = filter.from ?? null;
  const to = filter.to ?? null;
  const kind = filter.kind ?? null;

  const where: string[] = [];
  const params: Array<string | number> = [];
  if (from !== null) { where.push('v.as_of_period >= ?'); params.push(from); }
  if (to !== null) { where.push('v.as_of_period <= ?'); params.push(to); }
  if (kind !== null) { where.push('v.verdict_kind = ?'); params.push(kind); }
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';

  // Per-kind verdict counts (all verdicts in range, resolved or not).
  const totalByKind = new Map<string, number>();
  let totalVerdicts = 0;
  for (const r of db.prepare(`
    SELECT verdict_kind AS k, COUNT(*) AS c FROM calibration_verdict v ${whereSql} GROUP BY verdict_kind
  `).all(...params) as Array<{ k: string; c: number }>) {
    totalByKind.set(r.k, r.c);
    totalVerdicts += r.c;
  }

  // Blessed resolutions joined to their verdicts (in range).
  const resolved = db.prepare(`
    SELECT v.verdict_kind, v.predicted_band, v.predicted_value, v.direction,
           o.hit, o.realized_value, o.action_taken
    FROM calibration_outcome o JOIN calibration_verdict v ON v.id = o.calibration_id
    ${whereSql ? whereSql.replace('WHERE', 'WHERE o.is_resolution = 1 AND') : 'WHERE o.is_resolution = 1'}
    ORDER BY v.verdict_kind
  `).all(...params) as ResolvedRow[];

  // Group resolved rows by kind.
  const byKindRows = new Map<string, ResolvedRow[]>();
  for (const r of resolved) {
    const arr = byKindRows.get(r.verdict_kind) ?? [];
    arr.push(r);
    byKindRows.set(r.verdict_kind, arr);
  }

  let overallHits = 0;
  let overallScoreable = 0;
  let treatHits = 0;
  let treatScoreable = 0;

  // Stable kind order: union of kinds with verdicts and kinds with resolutions.
  const kinds = [...new Set([...totalByKind.keys(), ...byKindRows.keys()])].sort();
  const byKind: KindReport[] = [];
  for (const k of kinds) {
    const rows = byKindRows.get(k) ?? [];
    let hits = 0;
    let scoreable = 0;
    let dirHits = 0;
    let dirScoreable = 0;
    let signedSum = 0;
    let signedN = 0;
    const bandAgg = new Map<string, { hits: number; scoreable: number }>();
    for (const r of rows) {
      if (r.hit === 0 || r.hit === 1) {
        scoreable += 1;
        hits += r.hit;
        overallScoreable += 1;
        overallHits += r.hit;
        const band = r.predicted_band ?? '(none)';
        const b = bandAgg.get(band) ?? { hits: 0, scoreable: 0 };
        b.scoreable += 1;
        b.hits += r.hit;
        bandAgg.set(band, b);
        // Treatment-adjusted: only the clean natural experiments (action_taken='none') count (§4.1, §5).
        if (r.action_taken === 'none') {
          treatScoreable += 1;
          treatHits += r.hit;
        }
        // Directional accuracy: verdicts carrying a real directional bet (up/down).
        if (r.direction === 'up' || r.direction === 'down') {
          dirScoreable += 1;
          dirHits += r.hit;
        }
      }
      // Bias (mean signed error) over numeric verdicts that have both a prediction and a realized value.
      if (r.predicted_value !== null && r.realized_value !== null) {
        signedSum += r.predicted_value - r.realized_value;
        signedN += 1;
      }
    }
    const byBand: BandRate[] = [...bandAgg.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([band, agg]) => ({ band, scoreable: agg.scoreable, hits: agg.hits, hitRate: rate(agg.hits, agg.scoreable) }));
    const w = wilson(hits, scoreable);
    byKind.push({
      verdictKind: k,
      total: totalByKind.get(k) ?? 0,
      resolved: rows.length,
      scoreable,
      hits,
      hitRate: rate(hits, scoreable),
      wilsonLow: w.low,
      wilsonHigh: w.high,
      directionalScoreable: dirScoreable,
      directionalHits: dirHits,
      directionalAccuracy: rate(dirHits, dirScoreable),
      meanSignedError: signedN === 0 ? null : signedSum / signedN,
      byBand,
    });
  }

  return {
    from,
    to,
    kind,
    totalVerdicts,
    resolvedVerdicts: resolved.length,
    scoreableVerdicts: overallScoreable,
    overallHitRate: rate(overallHits, overallScoreable),
    treatmentAdjustedHitRate: rate(treatHits, treatScoreable),
    treatmentAdjustedScoreable: treatScoreable,
    byKind,
    dataMaturityNote:
      'The first ~5 years are data-accumulation, not actionable calibration: at a ~14-property firm any '
      + 'single-period hit-rate is statistically hollow (Wilson intervals reported alongside every rate). '
      + 'Value compounds over time (decades of quarterly verdicts), not across the cross-section.',
  };
}

// ── §3.2 read views — the verdict log + the pending (due-but-unresolved) queue ───────────────

export interface CalibrationLogFilter {
  subject?: string; // subject_id
  kind?: string; // verdict_kind
  status?: 'open' | 'resolved'; // open = no blessed resolution; resolved = has one
  limit?: number; // row cap (default 500, max 2000) — bounds the read for a UI table
}

interface LogJoinRow {
  id: number;
  subject_kind: string;
  subject_id: string;
  verdict_kind: string;
  verdict_subkind: string;
  verdict_engine: string;
  predicted_band: string | null;
  predicted_value: number | null;
  predicted_unit: string | null;
  confidence: number | null;
  direction: string | null;
  as_of_period: string;
  horizon_periods: number | null;
  inputs_version: string;
  emitted_by: string;
  emitted_at: string;
  realized_band: string | null;
  realized_value: number | null;
  outcome_period: string | null;
  hit: number | null;
  resolved_by: string | null;
}

const LOG_LIMIT_DEFAULT = 500;
const LOG_LIMIT_MAX = 2000;

function toLogRow(r: LogJoinRow): CalibrationLogRow {
  const resolved = r.outcome_period !== null; // the LEFT JOIN only attached an is_resolution=1 outcome
  return {
    id: r.id,
    subjectKind: r.subject_kind as CalibrationLogRow['subjectKind'],
    subjectId: r.subject_id,
    verdictKind: r.verdict_kind as CalibrationLogRow['verdictKind'],
    verdictSubkind: r.verdict_subkind,
    verdictEngine: r.verdict_engine as CalibrationLogRow['verdictEngine'],
    predictedBand: r.predicted_band,
    predictedValue: r.predicted_value,
    predictedUnit: r.predicted_unit,
    confidence: r.confidence,
    direction: r.direction,
    asOfPeriod: r.as_of_period,
    horizonPeriods: r.horizon_periods,
    inputsVersion: r.inputs_version,
    emittedBy: r.emitted_by,
    emittedAt: r.emitted_at,
    resolved,
    realizedBand: r.realized_band,
    realizedValue: r.realized_value,
    outcomePeriod: r.outcome_period,
    hit: r.hit === 0 || r.hit === 1 ? r.hit : null,
    resolvedBy: r.resolved_by,
  };
}

/**
 * The verdict log: every calibration_verdict (filterable by subject / kind / open|resolved), LEFT
 * JOINed to its single blessed (is_resolution=1) outcome. Read-only; deterministic order (newest
 * verdict first). On an empty warehouse it returns [] — never throws.
 */
export function calibrationLog(db: WarehouseDb, filter: CalibrationLogFilter = {}): CalibrationLogRow[] {
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (filter.subject) { where.push('v.subject_id = ?'); params.push(filter.subject); }
  if (filter.kind) { where.push('v.verdict_kind = ?'); params.push(filter.kind); }
  if (filter.status === 'resolved') where.push('o.id IS NOT NULL');
  else if (filter.status === 'open') where.push('o.id IS NULL');
  const whereSql = where.length > 0 ? `WHERE ${where.join(' AND ')}` : '';
  const limit = Math.min(Math.max(1, filter.limit ?? LOG_LIMIT_DEFAULT), LOG_LIMIT_MAX);

  const rows = db.prepare(`
    SELECT v.id, v.subject_kind, v.subject_id, v.verdict_kind, v.verdict_subkind, v.verdict_engine,
           v.predicted_band, v.predicted_value, v.predicted_unit, v.confidence, v.direction,
           v.as_of_period, v.horizon_periods, v.inputs_version, v.emitted_by, v.emitted_at,
           o.realized_band, o.realized_value, o.outcome_period, o.hit, o.resolved_by
    FROM calibration_verdict v
    LEFT JOIN calibration_outcome o ON o.calibration_id = v.id AND o.is_resolution = 1
    ${whereSql}
    ORDER BY v.id DESC
    LIMIT ?
  `).all(...params, limit) as LogJoinRow[];
  return rows.map(toLogRow);
}

/**
 * The pending queue (§3.2): verdicts whose horizon is DUE (covered by a strictly-later same-grain
 * full-year period) but which carry no blessed resolution yet. This is exactly the set
 * resolveDueOutcomes would score on its next run — the analyst-review surface. Read-only; on an empty
 * warehouse, or when no horizon has elapsed, it returns [] (never throws / never divides by zero).
 */
export function calibrationPending(db: WarehouseDb): CalibrationLogRow[] {
  const metrics = propertyPeriodMetrics(db);
  const fyByProperty = fullYearMetricsByProperty(metrics);
  const open = calibrationLog(db, { status: 'open', limit: LOG_LIMIT_MAX });
  const due: CalibrationLogRow[] = [];
  for (const v of open) {
    if (v.subjectKind !== 'property' || v.horizonPeriods === null) continue;
    const asOfYear = parseFullYear(v.asOfPeriod);
    if (asOfYear === null) continue;
    const fy = fyByProperty.get(v.subjectId);
    if (!fy) continue;
    const targetYear = asOfYear + v.horizonPeriods;
    let covered = false;
    for (let y = targetYear; y <= asOfYear + v.horizonPeriods + MAX_HORIZON_SLACK; y++) {
      if (fy.has(String(y))) { covered = true; break; }
    }
    if (covered) due.push(v);
  }
  return due;
}

// ── Phase 5: capital-allocation verdict mapping ──────────────────────────────────────────────

function allocationDirection(action: AllocationVerdict['action']): 'up' | 'down' | 'flat' | 'n/a' {
  if (action === 'sell') return 'down';
  if (action === 'buy' || action === 'improve') return 'up';
  if (action === 'refinance' || action === 'hold') return 'flat';
  return 'n/a';
}

/**
 * Map each AllocationVerdict → one CalibrationVerdict row (verdict_kind 'capital-action-v2').
 * Deterministic in (verdicts, iv): no clock, no randomness.
 * horizonPeriods: 0 (Phase 5 Phase-3-absent path) maps to null (unknown horizon per schema).
 */
export function verdictsFromAllocations(
  verdicts: AllocationVerdict[],
  iv: InputsVersion,
  emittedBy: string,
): CalibrationVerdict[] {
  return verdicts.map(v =>
    CalibrationVerdictSchema.parse({
      subjectKind: 'property',
      subjectId: v.propertyId,
      verdictKind: 'capital-action-v2',
      verdictSubkind: '',
      verdictEngine: 'capital-allocation',
      predictedBand: v.action,
      predictedValue: v.expectedReturnPct,
      predictedUnit: 'band',
      confidence: v.confidence01,
      direction: allocationDirection(v.action),
      reasons: v.reasons,
      asOfPeriod: v.period,
      horizonPeriods: v.horizonPeriods > 0 ? v.horizonPeriods : null,
      inputsVersion: iv.inputsVersion,
      emittedBy,
    }),
  );
}
