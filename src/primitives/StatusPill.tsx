import { motion } from 'framer-motion';
import { useBrain } from '@/data/brain-context';
import { isStill } from '@/lib/stillMode';
import { computeFreshness, type Freshness } from '@/lib/freshness';
import { useNow } from '@/lib/useNow';

const DOT_COLOR: Record<Freshness['kind'], string> = {
  live: 'var(--color-pos)',
  static: 'var(--color-info)',
  stale: 'var(--color-warn)',
  refreshing: 'var(--color-warn)',
  offline: 'var(--color-neg)',
  connecting: 'var(--text-tertiary)',
};

const TEXT_COLOR: Record<Freshness['kind'], string> = {
  live: 'var(--text-pos)',
  static: 'var(--text-info)',
  stale: 'var(--text-warn)',
  refreshing: 'var(--text-warn)',
  offline: 'var(--text-neg)',
  connecting: 'var(--text-tertiary)',
};

// Whether the detail ("baked 6h ago" / "updated 12s ago") stays inline at EVERY width. A bake age on
// a static/stale mirror, or an offline state, is actionable — the reader needs it without hovering.
// A healthy live/refreshing/connecting feed's detail is reassurance, so below 2xl it compacts to
// screen-reader-only (never display:none, which left the 1280–1535px laptop band with a bare
// "LIVE"/"STALE" and the age in a tooltip on a non-focusable div — 2026-09-23 review I-3).
const DETAIL_ALWAYS_INLINE: Record<Freshness['kind'], boolean> = {
  live: false,
  refreshing: false,
  connecting: false,
  static: true,
  stale: true,
  offline: true,
};

export function StatusPill() {
  const { state } = useBrain();
  const f = computeFreshness(state, useNow());
  const dotColor = DOT_COLOR[f.kind];
  const textColor = TEXT_COLOR[f.kind];
  // Only a genuine live/refreshing feed pulses. A static bake never animates as "live".
  const animate = (f.kind === 'live' || f.kind === 'refreshing') && !isStill();

  return (
    <div
      className="num inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-2xs"
      style={{ border: '1px solid var(--border-subtle)', background: 'var(--surface-overlay)' }}
      title={f.detail ?? undefined}
    >
      <span className="relative flex h-1.5 w-1.5">
        {animate && (
          <motion.span
            className="absolute inline-flex h-1.5 w-1.5 rounded-full"
            style={{ background: dotColor }}
            animate={{ scale: [1, 2.6], opacity: [0.55, 0] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut' }}
          />
        )}
        <span
          className="relative inline-flex h-1.5 w-1.5 rounded-full"
          style={{ background: dotColor, boxShadow: animate ? `0 0 8px ${dotColor}` : undefined }}
        />
      </span>
      <span className="font-semibold uppercase" style={{ letterSpacing: '0.1em', color: textColor }}>
        {f.label}
      </span>
      {f.detail && (
        <span
          className={DETAIL_ALWAYS_INLINE[f.kind] ? 'inline' : 'sr-only 2xl:not-sr-only 2xl:inline'}
          style={{ color: 'var(--text-tertiary)' }}
        >
          · {f.detail}
        </span>
      )}
    </div>
  );
}
