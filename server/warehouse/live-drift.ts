// server/warehouse/live-drift.ts
//
// Live-vs-fresh drift detection for the financial warehouse. The acceptance gate
// (scripts/warehouse-verify.ts) scores a FRESH temp warehouse rebuilt from the source files, so it
// stays green even when the persistent data/warehouse/finance.sqlite that the app actually serves is
// STALE relative to current code. That blind spot is real: ingest dedups on file content hash
// (raw-store.ts), so `warehouse:backfill` returns 'duplicate' and never re-derives an existing import
// — a parser improvement (e.g. reading the QB Desktop print-header basis, or the AppFolio report-type)
// leaves the served basis stale until a manual archive + rebuild. This module compares the two and
// surfaces every divergence so the gate can fail closed on it.
import type { WarehouseDb } from './db';

/** Value type for committedBasisMap: both the accounting basis and the human-readable file name. */
export interface BasisEntry {
  basis: string;
  fileName: string;
}

export interface BasisDriftRow {
  /** The unique file_hash key (SHA of file content). */
  fileHash: string;
  /** Human-readable file_name for display and triage. */
  fileName: string;
  /** accounting basis in the LIVE (served) warehouse; null = the file is absent from live. */
  live: string | null;
  /** accounting basis a FRESH rebuild from the same source files produces; null = absent from fresh. */
  fresh: string | null;
}

/**
 * Pure comparator. Given the committed file_hash→BasisEntry maps of the live warehouse and a fresh
 * rebuild, return one row per file whose basis diverges (including presence mismatches in either
 * direction), sorted by file name. An empty array means the served warehouse matches current code.
 */
export function basisDrift(
  live: ReadonlyMap<string, BasisEntry>,
  fresh: ReadonlyMap<string, BasisEntry>,
): BasisDriftRow[] {
  const rows: BasisDriftRow[] = [];
  const hashes = new Set<string>([...live.keys(), ...fresh.keys()]);
  for (const fileHash of hashes) {
    const lEntry = live.get(fileHash);
    const fEntry = fresh.get(fileHash);
    const l = lEntry?.basis ?? null;
    const f = fEntry?.basis ?? null;
    if (l !== f) {
      const fileName = (lEntry ?? fEntry)!.fileName;
      rows.push({ fileHash, fileName, live: l, fresh: f });
    }
  }
  // Secondary key on the unique fileHash: when two drifting files share a fileName (the very
  // duplicate-name case L6 keys the map on file_hash to survive), fileName alone ties and row
  // order would follow Set iteration order — fileHash makes the gate output deterministic.
  return rows.sort((a, b) => a.fileName.localeCompare(b.fileName) || a.fileHash.localeCompare(b.fileHash));
}

/**
 * Committed file_hash→BasisEntry map for a warehouse DB. Keyed on file_hash (unique per content,
 * NOT file_name) so renamed files or duplicate file_name rows don't overwrite each other in the Map.
 * fileName is carried alongside for human-readable error output. Empty/NULL basis is coalesced to
 * 'unknown' to match the engine (metrics.ts) and computeBasisCoverage.
 */
export function committedBasisMap(db: WarehouseDb): Map<string, BasisEntry> {
  const rows = db.prepare(
    "SELECT file_hash AS fh, file_name AS fn, COALESCE(NULLIF(basis, ''), 'unknown') AS b FROM import_batches WHERE status = 'committed'",
  ).all() as Array<{ fh: string; fn: string; b: string }>;
  return new Map(rows.map((r) => [r.fh, { basis: r.b, fileName: r.fn }]));
}
