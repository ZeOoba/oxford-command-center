// server/warehouse/acq-outcome-dq.ts
//
// The acquisition-outcome "skip" data-quality rows ('acq-outcome-band-mismatch' /
// 'acq-outcome-unbound', written by acq-engine.ts logAcqOutcome when it refuses to record an
// outcome) and their ONE close-out helper. Its own module so both acq-engine.ts (auto path) and
// calibration.ts (manual path, resolveManualOutcome) can call it without an import cycle
// (acq-engine already imports calibration).
import type { WarehouseDb } from './db';

export const ACQ_OUTCOME_SKIP_KINDS = ['acq-outcome-band-mismatch', 'acq-outcome-unbound'] as const;

/**
 * Mark a candidate's OPEN acquisition-outcome skip rows resolved — called whenever the deal is
 * resolved on any surface (the auto bless, logAcqOutcome's already-resolved early return, and a
 * manual deal resolution). Idempotent and cheap. Matches the `candidate=<id> ` detail prefix
 * (space-terminated so c1 never matches c10; substr, not LIKE, since ids may contain % or _).
 * Fail-open: observational machinery never blocks a resolution.
 */
export function closeAcqOutcomeSkips(db: WarehouseDb, candidateId: string): void {
  try {
    const key = `candidate=${candidateId} `;
    db.prepare(`
      UPDATE data_quality_issues SET status = 'resolved', resolved_at = datetime('now')
      WHERE kind IN (${ACQ_OUTCOME_SKIP_KINDS.map(() => '?').join(', ')}) AND status = 'open'
        AND substr(detail, 1, length(?)) = ?
    `).run(...ACQ_OUTCOME_SKIP_KINDS, key, key);
  } catch { /* swallow — observational machinery never blocks */ }
}
