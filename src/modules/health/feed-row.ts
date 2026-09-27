// src/modules/health/feed-row.ts
//
// System Health › Data Feeds row/badge presentation. A feed may carry a disclosure `note` (e.g. the AR
// feed's "7 leases with stale AR", ratified 2026-09-24): it leads the row value and turns an otherwise
// fresh row amber, so a fresh import with stragglers is visible without reading red.
import type { FeedHealth } from '@/lib/feed-health';

export function feedRowValue(f: FeedHealth): string {
  const base =
    f.status === 'fresh'
      ? `${f.ageDays}d old`
      : f.status === 'missing'
        ? `never — ${f.fix}`
        : `${f.ageDays}d old (max ${f.maxAgeDays}d) — ${f.fix}`;
  return f.note ? `${f.note} · ${base}` : base;
}

export function feedRowTone(f: FeedHealth): 'ok' | 'warn' | 'error' {
  if (f.status === 'missing') return 'error';
  if (f.status === 'stale' || f.note) return 'warn';
  return 'ok';
}

/** M5 (2026-09-23): missing outranks stale in the badge tone; a noted row counts as needing attention. */
export function feedsBadge(feeds: readonly FeedHealth[]): { tone: 'red' | 'amber' | 'green'; label: string } {
  const tones = feeds.map(feedRowTone);
  const n = tones.filter((t) => t !== 'ok').length;
  return { tone: tones.includes('error') ? 'red' : tones.includes('warn') ? 'amber' : 'green', label: `${n} need attention` };
}
