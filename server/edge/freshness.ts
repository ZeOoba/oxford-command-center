// server/edge/freshness.ts
//
// Freshness + stale rule (spec §8.2, F1). asOf is the EARLIER of meta.pulled and the file mtime
// date, so an OneDrive re-sync that bumps mtime can never make old data read as fresh. A future
// mtime or pulled date (clock skew) is treated as stale, with ageDays clamped to >= 0. All dates
// are compared as UTC calendar days.
import type { EdgeFreshness } from '../../src/contracts/edge';
import { EDGE_STALE_DAYS } from './config';

const DAY_MS = 86_400_000;

export function edgeFreshness(metaPulled: string, mtimeMs: number, now: Date): EdgeFreshness {
  const fileMtime = new Date(mtimeMs).toISOString();
  const mtimeDate = fileMtime.slice(0, 10);
  const today = now.toISOString().slice(0, 10);
  const asOf = metaPulled < mtimeDate ? metaPulled : mtimeDate;
  const rawAge = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / DAY_MS);
  const ageDays = Math.max(0, rawAge);
  const clockSkew = mtimeMs > now.getTime() || metaPulled > today;
  return {
    metaPulled,
    fileMtime,
    asOf,
    ageDays,
    staleAfterDays: EDGE_STALE_DAYS,
    stale: clockSkew || ageDays > EDGE_STALE_DAYS,
  };
}
