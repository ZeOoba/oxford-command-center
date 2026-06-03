import { motion } from 'framer-motion';
import { cn } from '@/lib/cn';
import { isStill } from '@/lib/stillMode';

/** Shimmer skeleton — Framer-driven. Frozen in still mode for deterministic capture. */
export function Skeleton({ className, style }: { className?: string; style?: React.CSSProperties }) {
  return (
    <div
      className={cn('relative overflow-hidden rounded-[var(--radius-sm)]', className)}
      style={{ background: 'var(--surface-overlay)', ...style }}
    >
      {!isStill() && (
      <motion.div
        className="absolute inset-0"
        style={{
          background:
            'linear-gradient(90deg, transparent, color-mix(in oklab, var(--text-tertiary) 16%, transparent), transparent)',
        }}
        animate={{ x: ['-100%', '100%'] }}
        transition={{ duration: 1.4, repeat: Infinity, ease: 'easeInOut' }}
      />
      )}
    </div>
  );
}
