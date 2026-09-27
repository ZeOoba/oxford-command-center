import { ALERT_THRESHOLDS, isArStale } from '../src/analytics/conditions';

export type FeedId = 'snapshot' | 'cashHistory' | 'ar' | 'dailyBrief' | 'leaseMarket' | 'docIndex';
export type FeedStatus = 'fresh' | 'stale' | 'missing';
export type FeedInputs = Record<FeedId, string | null>;

export interface FeedFreshness {
  id: FeedId;
  label: string;
  lastAt: string | null;
  ageDays: number | null;
  maxAgeDays: number;
  status: FeedStatus;
  fix: string;
  /** Optional disclosure shown before the age, e.g. "7 leases with stale AR". */
  note?: string;
}

/** Per-feed staleness budget in days (2026-09-23 review found six feeds silently stale). */
export const FEED_MAX_AGE_DAYS: Record<FeedId, number> = {
  snapshot: 2,
  cashHistory: 40, // monthly rows, 10th of the month
  ar: ALERT_THRESHOLDS.arStalenessMaxDays,
  dailyBrief: 1.5, // matches the client's BRIEF_STALE_HOURS = 36 (src/lib/freshness.ts) — I-3, 2026-09-23 review
  leaseMarket: 14,
  docIndex: 30,
};

const META: Record<FeedId, { label: string; fix: string }> = {
  snapshot: { label: 'Workbook snapshot', fix: 'Check the Brain Server workbook watcher / OneDrive sync' },
  cashHistory: { label: 'Cash history (monthly rows)', fix: 'Add the missing monthly rows to Cash Data in the Master Workbook' },
  ar: { label: 'AR aging (QuickBooks)', fix: 'Run the QuickBooks AR export + ar-import-headless' },
  dailyBrief: { label: 'Daily brief', fix: 'Check the scheduled snapshot-refresh / brief task on the CC fleet' },
  leaseMarket: { label: 'Lease market compute', fix: 'npm run lease-market:ingest && npm run lease-market:compute' },
  docIndex: { label: 'Document index (Ask)', fix: 'npm run index:docs' },
};

const DAY_MS = 86_400_000;

export function assessFeeds(input: FeedInputs, now: number, notes: Partial<Record<FeedId, string>> = {}): FeedFreshness[] {
  return (Object.keys(META) as FeedId[]).map((id) => {
    const lastAt = input[id];
    const t = lastAt ? Date.parse(lastAt) : NaN;
    const ok = Number.isFinite(t);
    const ageMs = ok ? now - t : null;
    // Display keeps whole-day granularity; status decides on exact elapsed ms so a sub-day
    // budget (dailyBrief = 1.5 days = 36h) doesn't get rounded away by Math.floor (I-3, 2026-09-23
    // review — the card badge and this row disagreed on when the daily brief goes stale).
    const ageDays = ok ? Math.floor(ageMs! / DAY_MS) : null;
    const maxAgeDays = FEED_MAX_AGE_DAYS[id];
    const status: FeedStatus = ageMs === null ? 'missing' : ageMs > maxAgeDays * DAY_MS ? 'stale' : 'fresh';
    const note = notes[id];
    return { id, label: META[id].label, lastAt, ageDays, maxAgeDays, status, fix: META[id].fix, ...(note ? { note } : {}) };
  });
}

/**
 * AR feed input (ratified 2026-09-24). Feed age = the NEWEST stamped AR import — "when did an import
 * last land" — instead of the oldest record, which kept the row red for weeks after a fresh import
 * because a handful of leases were simply absent from it. Those per-lease records still matter
 * (collections gating withholds exactly their alerts), so they are counted with the SAME definition
 * the gate uses (isArStale, src/analytics/conditions.ts) and surfaced as a note on the row.
 * Records with no asOfDate FIELD are pre-Track-B/manual: neither dated nor stale (isArStale → false).
 * Accepts Date or ISO string (in-memory Zod-coerced snapshot vs a JSON-loaded one).
 */
export function arFeedInput(
  arrears: Readonly<Record<string, { asOfDate?: Date | string | null }>>,
  now: number,
): { lastAt: string | null; staleLeaseCount: number; note: string | undefined } {
  let newest: number | null = null;
  let stale = 0;
  for (const r of Object.values(arrears)) {
    if (!('asOfDate' in r)) continue;
    const t = r.asOfDate ? new Date(r.asOfDate).getTime() : NaN;
    if (Number.isFinite(t) && (newest === null || t > newest)) newest = t;
    if (isArStale(r as { asOfDate?: Date | null }, now)) stale += 1;
  }
  return {
    lastAt: newest === null ? null : new Date(newest).toISOString(),
    staleLeaseCount: stale,
    note: stale > 0 ? `${stale} lease${stale === 1 ? '' : 's'} with stale AR` : undefined,
  };
}
