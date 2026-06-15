// scripts/calibration-snapshot.ts
//
// The scheduled-SNAPSHOT entry point for the Score-vs-Outcome Calibration Log (the 40-year feedback
// loop) — design §2.2 trigger 2, driven by the `ora-calibration-snapshot` task. It keeps the dated
// prediction stream fed on a regular cadence even in quarters with no new imports: a ~14-property firm
// imports irregularly, and outcome scoring needs a steady stream of dated predictions to grade.
//
// Each run does, IN ORDER (mirroring the on-commit emit hook in actions.ts, with the snapshot tag):
//   1. resolveDueOutcomes(db) — score any verdict whose horizon a strictly-later same-grain period now
//      covers (BEFORE logging, so a just-due outcome is resolved on this same run).
//   2. logVerdicts(...) — log the CURRENT verdicts (scores + anomalies) with emittedBy='snapshot:<taskId>',
//      idempotently (dedup_key UNIQUE → a no-new-information quarter writes nothing).
//
// FAIL-OPEN: runSnapshot NEVER throws to its caller — a scheduler must not crash on observational
// machinery. On any error it records a data_quality_issues row and returns {ok:false, errors>0}.
//
// OBSERVATIONAL ONLY: writes ONLY the calibration tables (calibration_verdict / calibration_outcome /
// calibration_inputs_version). It NEVER edits intel-config.ts, NEVER changes a health weight, and NEVER
// touches the DSCR 1.25 / LTV 0.40 governors (out of scope). A weight change is a separate, human-ratified
// edit — see the offline scripts/calibration-refit.ts, which only PROPOSES.
//
// Invoke: `npx tsx scripts/calibration-snapshot.ts [--task <taskId>] [--db <path>] [--json]`
import { join } from 'node:path';
import { openWarehouse } from '../server/warehouse/db';
import type { WarehouseDb } from '../server/warehouse/db';
import { detectAnomalies } from '../server/warehouse/anomalies';
import {
  computeInputsVersion,
  logVerdicts,
  resolveDueOutcomes,
  verdictsFromAnomalies,
  verdictsFromScores,
} from '../server/warehouse/calibration';
import { propertyPeriodMetrics } from '../server/warehouse/metrics';
import { scoreProperties } from '../server/warehouse/scores';

export interface SnapshotOptions {
  /** The scheduled-task id, used for the emittedBy tag (`snapshot:<taskId>`). */
  taskId: string;
  /** TEST ONLY: force the emit path to throw, to prove the fail-open guarantee. */
  forceEmitError?: string;
}

export interface SnapshotSummary {
  ok: boolean;
  /** Outcomes blessed by the resolver this run (is_resolution=1 rows written). */
  resolved: number;
  /** Verdicts examined by the resolver (unresolved, finite horizon). */
  scanned: number;
  /** Verdicts whose horizon is now covered by a later same-grain period. */
  due: number;
  /** New verdict rows logged by the snapshot (deduped — 0 when no new information). */
  verdictsWritten: number;
  /** Verdict rows skipped as duplicates (already logged at this inputs_version). */
  verdictsSkipped: number;
  /** Total failures across resolve + log (each also recorded to data_quality_issues; never thrown). */
  errors: number;
  /** The inputs_version this snapshot logged against (null if it could not be computed). */
  inputsVersion: string | null;
  /** A human one-liner for the completion log / email. */
  note: string;
}

/** Best-effort DQ record; swallows its own errors (observational machinery, mirrors calibration.ts). */
function recordFailure(db: WarehouseDb, detail: string): void {
  try {
    db.prepare(
      "INSERT INTO data_quality_issues (kind, detail, severity) VALUES ('calibration-snapshot-failed', ?, 'warn')",
    ).run(detail);
  } catch {
    /* swallow — nothing the snapshot does may block the warehouse */
  }
}

/**
 * Run one calibration snapshot against `db`. Pure-ish + FAIL-OPEN: it never throws; every failure is
 * counted and recorded. Returns a summary for the completion log / email. Step order (resolve THEN log)
 * is load-bearing: it scores a just-due outcome before re-snapshotting the current verdicts.
 */
export function runSnapshot(db: WarehouseDb, opts: SnapshotOptions): SnapshotSummary {
  const emittedBy = `snapshot:${opts.taskId}`;
  let resolved = 0;
  let scanned = 0;
  let due = 0;
  let verdictsWritten = 0;
  let verdictsSkipped = 0;
  let errors = 0;
  let inputsVersion: string | null = null;

  // STEP 1 — RESOLVE due outcomes first (resolveDueOutcomes is itself fail-open / never throws).
  try {
    const r = resolveDueOutcomes(db);
    resolved = r.resolved;
    scanned = r.scanned;
    due = r.due;
    errors += r.errors;
  } catch (e) {
    // Defensive: resolveDueOutcomes shouldn't throw, but the scheduler must survive even if it does.
    errors += 1;
    recordFailure(db, `resolve step: ${e instanceof Error ? e.message : String(e)}`);
  }

  // STEP 2 — LOG the current verdicts tagged snapshot:<taskId>, idempotently. Wrapped fail-open exactly
  // like the on-commit hook: a failure in computeInputsVersion / scoring records a DQ row and does not
  // propagate. forceEmitError is the test seam proving that guarantee.
  try {
    if (opts.forceEmitError) throw new Error(opts.forceEmitError);
    const iv = computeInputsVersion(db);
    inputsVersion = iv.inputsVersion;
    const metrics = propertyPeriodMetrics(db);
    const res = logVerdicts(db, [
      ...verdictsFromScores(scoreProperties(db, metrics), iv, emittedBy),
      ...verdictsFromAnomalies(detectAnomalies(metrics), iv, emittedBy),
    ]);
    verdictsWritten = res.written;
    verdictsSkipped = res.skipped;
    if (res.error) errors += 1; // logVerdicts records its own DQ row on failure
  } catch (e) {
    errors += 1;
    recordFailure(db, `snapshot emit: ${e instanceof Error ? e.message : String(e)}`);
  }

  const ok = errors === 0;
  const note = ok
    ? `snapshot ${opts.taskId}: ${verdictsWritten} new verdict(s) (+${verdictsSkipped} dedup), ${resolved} outcome(s) resolved`
    : `snapshot ${opts.taskId}: completed with ${errors} error(s) (see data_quality_issues) — ${verdictsWritten} written, ${resolved} resolved`;

  return { ok, resolved, scanned, due, verdictsWritten, verdictsSkipped, errors, inputsVersion, note };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────
function parseArgs(argv: string[]): { task: string; db?: string; json: boolean } {
  const out: { task: string; db?: string; json: boolean } = { task: 'ora-calibration-snapshot', json: false };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--task') out.task = argv[++i] ?? out.task;
    else if (argv[i] === '--db') out.db = argv[++i];
    else if (argv[i] === '--json') out.json = true;
  }
  return out;
}

/** The canonical live warehouse path the brain server uses (server/index.ts): env override, else
 *  <cwd>/data/warehouse/finance.sqlite. The snapshot MUST write the same DB the panel reads. */
function defaultDbPath(): string {
  return process.env.WAREHOUSE_DB ?? join(process.cwd(), 'data', 'warehouse', 'finance.sqlite');
}

function main(argv: string[]): number {
  const args = parseArgs(argv);
  const dbPath = args.db ?? defaultDbPath();
  let db: WarehouseDb;
  try {
    db = openWarehouse(dbPath);
  } catch (e) {
    // A cold/mirror env may lack the sqlite file — surface it but exit non-fatally (the task logs + emails).
    console.error(`cannot open warehouse at ${dbPath}: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
  const summary = runSnapshot(db, { taskId: args.task });
  if (args.json) console.log(JSON.stringify(summary, null, 2));
  else console.log(summary.note);
  // Exit 0 even on observational errors (the task's email/completion-log step owns escalation); reserve
  // non-zero strictly for "could not open the warehouse at all".
  return 0;
}

// Run the CLI only when invoked directly (importing for tests must NOT open a db or write anything).
if (process.argv[1]?.replace(/\\/g, '/').endsWith('scripts/calibration-snapshot.ts')) {
  process.exit(main(process.argv.slice(2)));
}
