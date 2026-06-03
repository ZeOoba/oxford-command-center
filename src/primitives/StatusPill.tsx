import { motion } from 'framer-motion';
import { useBrain } from '@/data/brain-context';
import { relativeTime } from '@/lib/time';
import { isStill } from '@/lib/stillMode';
import type { BrainStatus } from '@contracts/index';

const MAP: Record<BrainStatus, { label: string; color: string }> = {
  fresh: { label: 'Live', color: 'var(--color-pos)' },
  refreshing: { label: 'Refreshing', color: 'var(--color-warn)' },
  error: { label: 'Offline', color: 'var(--color-neg)' },
  idle: { label: 'Connecting', color: 'var(--text-tertiary)' },
};

export function StatusPill() {
  const { state } = useBrain();
  const status = state?.status ?? 'idle';
  const { label, color } = MAP[status];
  const animate = (status === 'fresh' || status === 'refreshing') && !isStill();

  return (
    <div
      className="num inline-flex items-center gap-2 rounded-full px-2.5 py-1 text-2xs"
      style={{ border: '1px solid var(--border-subtle)', background: 'var(--surface-overlay)' }}
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
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full" style={{ background: color }} />
      </span>
      <span className="font-semibold uppercase" style={{ letterSpacing: '0.1em', color }}>
        {label}
      </span>
      {state?.lastUpdated && (
        <span style={{ color: 'var(--text-tertiary)' }}>· {relativeTime(state.lastUpdated)}</span>
      )}
    </div>
  );
}
