// src/modules/data/acq-rescore-backlog.ts
//
// 2026-11-27 review: the re-score backlog made visible. logAcqOutcome (server/warehouse/acq-engine.ts)
// refuses to record a deal outcome when the bound calibration verdict's logged band disagrees with the
// served verdict, writing a data_quality_issues row of kind 'acq-outcome-band-mismatch' instead. After
// Ruling 5 every re-scored legacy KILLED row and every governor-demoted PASS now reading FLOOR-FLAGGED
// takes that path, so those deals stay OPEN until resolved by hand (resolveManualOutcome). Every
// resolution path closes the deal's open skip rows (closeAcqOutcomeSkips), so an OPEN band-mismatch row
// marks a deal still waiting. This counts those deals. Reporting only: outcome logic is unchanged.
import type { WarehouseIssue } from '@/modules/intel/hooks';

export const ACQ_BAND_MISMATCH_KIND = 'acq-outcome-band-mismatch';

/** The skip row's detail starts `candidate=<id> inputs_version=<iv> outcome=<o> ` (acq-engine.ts skipKey). */
const CANDIDATE_PREFIX = /^candidate=(.*?) inputs_version=/;

/**
 * Distinct deals with an OPEN 'acq-outcome-band-mismatch' row. One deal can carry several rows (a
 * corrected status or a new input is a new skip key), so rows are grouped by candidate id. A detail
 * that does not parse counts as its own deal (over-count, never a silent zero).
 */
export function countAcqRescoreBacklog(issues: readonly Pick<WarehouseIssue, 'kind' | 'detail' | 'status'>[]): number {
  const deals = new Set<string>();
  for (const i of issues) {
    if (i.kind !== ACQ_BAND_MISMATCH_KIND || i.status !== 'open') continue;
    const m = CANDIDATE_PREFIX.exec(i.detail);
    deals.add(m ? `id:${m[1]}` : `detail:${i.detail}`);
  }
  return deals.size;
}
