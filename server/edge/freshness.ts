// server/edge/freshness.ts
//
// Freshness + stale rule (spec §8.2, F1). asOf is the EARLIER of meta.pulled and the file mtime
// date, so an OneDrive re-sync that bumps mtime can never make old data read as fresh. A future
// mtime or pulled date (clock skew) is treated as stale, with ageDays clamped to >= 0. All dates
// are compared as UTC calendar days.
//
// FAIL CLOSED: stale data is never presented as current. An unparseable meta.pulled (anything but
// a real YYYY-MM-DD calendar date) or a non-finite mtime forces stale:true; asOf falls back to the
// other (valid) date, or to today when neither is usable, so asOf is always a valid date string and
// ageDays is always a finite integer >= 0. A non-finite mtime reports fileMtime as 'unknown'
// (the contract types it as a plain string; Date#toISOString would throw).
import type { EdgeFreshness } from '../../src/contracts/edge';
import { EDGE_STALE_DAYS } from './config';

const DAY_MS = 86_400_000;

function isRealDate(s: unknown): s is string {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const t = Date.parse(`${s}T00:00:00Z`); // NaN for out-of-range input (toISOString would throw)
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === s;
}

export function edgeFreshness(metaPulled: string, mtimeMs: number, now: Date): EdgeFreshness {
  const mtimeOk = Number.isFinite(mtimeMs);
  const pulledOk = isRealDate(metaPulled);
  const fileMtime = mtimeOk ? new Date(mtimeMs).toISOString() : 'unknown';
  const mtimeDate = mtimeOk ? fileMtime.slice(0, 10) : null;
  const today = now.toISOString().slice(0, 10);

  let asOf: string;
  if (pulledOk && mtimeDate !== null) asOf = metaPulled < mtimeDate ? metaPulled : mtimeDate;
  else asOf = (pulledOk ? metaPulled : mtimeDate) ?? today;

  const rawAge = Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${asOf}T00:00:00Z`)) / DAY_MS);
  const ageDays = Number.isFinite(rawAge) ? Math.max(0, rawAge) : 0;
  const clockSkew = (mtimeOk && mtimeMs > now.getTime()) || (pulledOk && metaPulled > today);
  return {
    metaPulled,
    fileMtime,
    asOf,
    ageDays,
    staleAfterDays: EDGE_STALE_DAYS,
    stale: !pulledOk || !mtimeOk || !Number.isFinite(rawAge) || clockSkew || ageDays > EDGE_STALE_DAYS,
  };
}
