import { AlertTriangle } from 'lucide-react';
import { useBrain } from '@/data/brain-context';
import { computeFreshness } from '@/lib/freshness';

/**
 * Amber banner shown only when the data is a stale static bake (older than
 * STALENESS_HOURS). Honest freshness: never hide that the mirror is out of date.
 */
export function StaleBanner() {
  const { state } = useBrain();
  const f = computeFreshness(state);
  if (!f.isStale) return null;

  return (
    <div
      className="flex items-center gap-2 px-5 py-2 text-xs"
      role="status"
      style={{
        background: 'color-mix(in oklab, var(--color-warn) 14%, transparent)',
        borderBottom: '1px solid color-mix(in oklab, var(--color-warn) 40%, transparent)',
        color: 'var(--color-warn)',
      }}
    >
      <AlertTriangle size={14} />
      <span style={{ fontWeight: 600 }}>Showing a static snapshot {f.detail ? `(${f.detail})` : ''}.</span>
      <span style={{ color: 'var(--text-secondary)' }}>
        The live workbook may have changed — rebake the mirror to refresh.
      </span>
    </div>
  );
}
