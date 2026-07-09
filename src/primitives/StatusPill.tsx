import { motion } from 'framer-motion';
import { useBrain } from '@/data/brain-context';
import { isStill } from '@/lib/stillMode';
import { computeFreshness, type Freshness } from '@/lib/freshness';
import { useNow } from '@/lib/useNow';

const COLOR: Record<Freshness['kind'], string> = {
  live: 'var(--color-pos)',
  static: 'var(--color-info)',
  stale: 'var(--color-warn)',
  refreshing: 'var(--color-warn)',
  offline: 'var(--color-neg)',
  connecting: 'var(--text-tertiary)',
};

export function StatusPill() {
  const { state } = useBrain();
  const f = computeFreshness(state, useNow());
  const color = COLOR[f.kind];
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
            style={{ background: color }}
            animate={{ scale: [1, 2.6], opacity: [0.55, 0] }}
            transition={{ duration: 1.8, repeat: Infinity, ease: 'easeOut' }}
          />
        )}
        <span
          className="relative inline-flex h-1.5 w-1.5 rounded-full"
          style={{ background: color, boxShadow: animate ? `0 0 8px ${color}` : undefined }}
        />
      </span>
      <span className="font-semibold uppercase" style={{ letterSpacing: '0.1em', color }}>
        {f.label}
      </span>
      {f.detail && <span style={{ color: 'var(--text-tertiary)' }}>· {f.detail}</span>}
    </div>
  );
}
