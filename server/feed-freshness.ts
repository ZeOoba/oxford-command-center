import { ALERT_THRESHOLDS } from '../src/analytics/conditions';

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
}

/** Per-feed staleness budget in days (2026-09-23 review found six feeds silently stale). */
export const FEED_MAX_AGE_DAYS: Record<FeedId, number> = {
  snapshot: 2,
  cashHistory: 40, // monthly rows, 10th of the month
  ar: ALERT_THRESHOLDS.arStalenessMaxDays,
  dailyBrief: 2,
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

export function assessFeeds(input: FeedInputs, now: number): FeedFreshness[] {
  return (Object.keys(META) as FeedId[]).map((id) => {
    const lastAt = input[id];
    const t = lastAt ? Date.parse(lastAt) : NaN;
    const ageDays = Number.isFinite(t) ? Math.floor((now - t) / DAY_MS) : null;
    const maxAgeDays = FEED_MAX_AGE_DAYS[id];
    const status: FeedStatus = ageDays === null ? 'missing' : ageDays > maxAgeDays ? 'stale' : 'fresh';
    return { id, label: META[id].label, lastAt, ageDays, maxAgeDays, status, fix: META[id].fix };
  });
}
