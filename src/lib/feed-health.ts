// src/lib/feed-health.ts
//
// Per-feed freshness shape from GET /api/health's `feeds[]` (fresh/stale/missing/error per feed).
// 'error' means the read itself failed, which is kept apart from 'missing' (2026-11-23 review).
// Lives in src/lib (not src/data) so src/lib/healthSignal.ts — a pure function module — never
// depends on src/data (the app's query-hook layer). src/data/health.ts imports these types from
// here and re-exports them for its own consumers, keeping the dependency direction lib -> data,
// never the reverse.
export type FeedStatus = 'fresh' | 'stale' | 'missing' | 'error';

export interface FeedHealth {
  id: string;
  label: string;
  lastAt: string | null;
  ageDays: number | null;
  maxAgeDays: number;
  status: FeedStatus;
  fix: string;
  /** Present only when status is 'error'. */
  error?: string;
}
