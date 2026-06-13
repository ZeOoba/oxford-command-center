// server/warehouse/data-quality.ts — read-only warehouse data-quality probes used by the gate.
import type { WarehouseDb } from './db';

export interface BasisCoverage {
  /** committed imports considered. */
  committed: number;
  /** committed imports whose accounting basis failed to parse ('unknown' — a period-header miss). */
  unknown: number;
  /** file names of the unknown-basis committed imports (for an actionable gate failure). */
  unknownFiles: string[];
}

/**
 * Pure core of the basis-coverage gate: count committed imports whose accounting basis did not parse.
 *
 * Why it matters for scoring: scores.ts G3 benchmarks each property ONLY against same-basis peers and
 * treats 'unknown' as non-comparable — an unknown-basis property is benchmarked against NO peers, so
 * its NOI/SF benchmark position falls to neutral (rankProperties → quartile null → 50). This is a
 * per-IMPORT data-quality count (basis parse coverage), NOT a model of G3's per-property suppression
 * (which also depends on each property's latest-full-year period and same-basis peer count). The
 * causal direction is sound — fewer unknown-basis imports is strictly better basis discipline — so the
 * gate ratchets this count against regression rather than asserting a precise suppression tally.
 */
export function computeBasisCoverage(
  rows: ReadonlyArray<{ basis: string | null; fileName: string }>,
): BasisCoverage {
  const unknownFiles: string[] = [];
  for (const r of rows) {
    // Match the engine, which COALESCEs a missing basis to 'unknown' (metrics.ts).
    if ((r.basis ?? 'unknown') === 'unknown' || r.basis === '') unknownFiles.push(r.fileName);
  }
  return { committed: rows.length, unknown: unknownFiles.length, unknownFiles };
}

/** Basis coverage over the COMMITTED imports in a warehouse DB. Thin DB wrapper over computeBasisCoverage. */
export function basisCoverage(db: WarehouseDb): BasisCoverage {
  const rows = db.prepare(
    `SELECT basis, file_name AS fileName FROM import_batches WHERE status = 'committed' ORDER BY file_name`,
  ).all() as Array<{ basis: string | null; fileName: string }>;
  return computeBasisCoverage(rows);
}
