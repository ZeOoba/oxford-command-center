// src/modules/data/DataFeedStrip.tsx
//
// Feeds needing attention, on the Data page itself (2026-11-23 review). Before this the only place
// a stale AR export or an unloaded P&L ledger showed was the TopBar dot and the off-rail System
// Health page, so the destination that owns the data said nothing about it. Renders nothing when
// every feed is fresh, or when /api/health is unavailable (the static mirror).
import { Link } from 'react-router-dom';
import { useHealth, type FeedHealth } from '@/data/health';

function describe(f: FeedHealth): string {
  if (f.status === 'error') return `${f.label} read failed`;
  if (f.status === 'missing') return `${f.label}: none on record`;
  return `${f.label} ${f.ageDays}d (max ${f.maxAgeDays}d)`;
}

export function DataFeedStrip() {
  const { data } = useHealth();
  const attention = (data?.feeds ?? []).filter((f) => f.status !== 'fresh');
  if (attention.length === 0) return null;
  const severe = attention.some((f) => f.status === 'error' || f.status === 'missing');
  return (
    <div
      role="status"
      className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-2 text-xs"
      style={{ borderTop: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
    >
      <span className="font-medium" style={{ color: severe ? 'var(--text-neg)' : 'var(--text-warn)' }}>
        {attention.length} feed{attention.length === 1 ? '' : 's'} need attention
      </span>
      {attention.map((f) => (
        <span key={f.id} title={f.status === 'error' ? `${f.error ?? ''} · ${f.fix}` : f.fix}>{describe(f)}</span>
      ))}
      <Link to="/health" className="underline" style={{ color: 'var(--text-secondary)' }}>
        Fixes in System Health
      </Link>
    </div>
  );
}
