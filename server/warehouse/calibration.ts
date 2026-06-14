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
import { INTEL_CONFIG } from './intel-config';
import type { AnomalySeverity, HealthBand } from './intel-config';
import type { PropertyScore } from './scores';
import {
  CalibrationVerdictSchema,
  type CalibrationVerdict,
  type InputsVersion,
} from '../../src/contracts/warehouse';

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
const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

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
        // Sub-identity = the anomaly kind, so several distinct anomalies for one (property, period,
        // inputs_version) get distinct dedup_keys instead of colliding to one (D3).
        verdictSubkind: f.kind,
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

function dedupKey(v: CalibrationVerdict): string {
  // verdictSubkind discriminates several anomalies sharing verdictKind='anomaly' for one
  // (subject, period, inputs_version); it is '' for the singleton scores kinds (D3).
  return `${v.subjectKind}|${v.subjectId}|${v.verdictKind}|${v.verdictSubkind}|${v.asOfPeriod}|${v.inputsVersion}`;
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
