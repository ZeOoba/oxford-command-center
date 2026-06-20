// server/warehouse/acq-ingest.ts
//
// Acquisition Intelligence Engine — parcel-screen batch importer (Phase 4, Step 4).
// Spec: docs/superpowers/specs/2026-06-20-phase-4-acquisition-intelligence-engine-firm-pri.md §Step 4.
//
// SPINE DISCIPLINE (critical invariant):
//   acq_* tables NEVER receive rows from ledger_entries or import_batches.
//   This module writes ONLY to acq_candidates + acq_source_batches (Spine C).
//   It NEVER creates ledger_entries rows, import_batches rows, or touches Spine B at all.
//
// Candidate ID format: parcel:<state-lower>:<county-slug>:<apn-slug>
//   - All slugging: lowercase, spaces → hyphens, non-alphanumeric-or-hyphen stripped.
//   - Example: parcel:oh:franklin:123-456-789
//
// Idempotency: INSERT OR IGNORE on candidate id. Re-ingesting the same parcel is a no-op
// (skipped count increments; the existing row is NOT updated — preserves analyst mutations).
import type { WarehouseDb } from './db';
import type { ParcelScreenImportRequest } from '../../src/contracts/acquisition';

/** Slug a free-text field to lowercase-hyphen-separated form. */
function slug(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9-]/g, '');
}

/** Build the stable candidate id from parcel coordinates. */
export function parcelCandidateId(state: string, county: string, apn: string): string {
  return `parcel:${slug(state)}:${slug(county)}:${slug(apn)}`;
}

export interface IngestParcelScreenResult {
  batchId: string;
  inserted: number;
  skipped: number;
}

/**
 * Ingest a county-parcel-screen workbook batch into acq_candidates + acq_source_batches.
 * Idempotent: INSERT OR IGNORE on the stable candidate id (same parcel re-imported is skipped,
 * preserving any analyst mutations made since the first import).
 * Does NOT auto-score — scoring is an explicit analyst action via POST /acq/score/:candidateId.
 *
 * SPINE ISOLATION: this function writes ONLY to acq_candidates + acq_source_batches.
 * It NEVER touches ledger_entries, import_batches, or any Spine B table.
 */
export function ingestParcelScreenBatch(
  db: WarehouseDb,
  req: ParcelScreenImportRequest,
): IngestParcelScreenResult {
  // Build a deterministic batch id from county + state + current date.
  const today = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  const batchId = `parcel-screen:${slug(req.county)}:${today}`;

  // Upsert the source batch row (INSERT OR IGNORE — same county/date is idempotent).
  db.prepare(`
    INSERT OR IGNORE INTO acq_source_batches (id, source, label, candidate_count)
    VALUES (?, 'parcel-screen', ?, ?)
  `).run(
    batchId,
    req.batchLabel,
    req.candidates.length,
  );

  const insertCandidate = db.prepare(`
    INSERT OR IGNORE INTO acq_candidates
      (id, source, source_batch_id, address, county, state, market,
       rentable_sf, year_built, owner_name, parcel_screen_score, status)
    VALUES (?, 'parcel-screen', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active')
  `);

  let inserted = 0;
  let skipped = 0;

  const run = db.transaction(() => {
    for (const c of req.candidates) {
      const candidateId = parcelCandidateId(req.state, req.county, c.apn);
      const r = insertCandidate.run(
        candidateId,
        batchId,
        c.address,
        req.county,
        req.state,
        c.market,
        c.rentableSf,
        c.yearBuilt,
        c.ownerName,
        c.parcelScreenScore,
      );
      if (r.changes > 0) inserted += 1;
      else skipped += 1;
    }
  });

  run();

  return { batchId, inserted, skipped };
}
