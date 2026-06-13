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

export interface BasisDriftRow {
  fileName: string;
  /** accounting basis in the LIVE (served) warehouse; null = the file is absent from live. */
  live: string | null;
  /** accounting basis a FRESH rebuild from the same source files produces; null = absent from fresh. */
  fresh: string | null;
}

/**
 * Pure comparator. Given the committed file_name→basis maps of the live warehouse and a fresh
 * rebuild, return one row per file whose basis diverges (including presence mismatches in either
 * direction), sorted by file name. An empty array means the served warehouse matches current code.
 */
export function basisDrift(
  live: ReadonlyMap<string, string>,
  fresh: ReadonlyMap<string, string>,
): BasisDriftRow[] {
  const rows: BasisDriftRow[] = [];
  const files = new Set<string>([...live.keys(), ...fresh.keys()]);
  for (const fileName of files) {
    const l = live.get(fileName) ?? null;
    const f = fresh.get(fileName) ?? null;
    if (l !== f) rows.push({ fileName, live: l, fresh: f });
  }
  return rows.sort((a, b) => a.fileName.localeCompare(b.fileName));
}

/**
 * committed file_name→basis map for a warehouse DB. Empty/NULL basis is coalesced to 'unknown' to
 * match the engine (metrics.ts) and computeBasisCoverage — so a stored '' never reads as a phantom
 * drift against a fresh 'unknown'.
 */
export function committedBasisMap(db: WarehouseDb): Map<string, string> {
  const rows = db.prepare(
    "SELECT file_name AS f, COALESCE(NULLIF(basis, ''), 'unknown') AS b FROM import_batches WHERE status = 'committed'",
  ).all() as Array<{ f: string; b: string }>;
  return new Map(rows.map((r) => [r.f, r.b]));
}
