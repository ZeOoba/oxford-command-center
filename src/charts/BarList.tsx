import { motion } from 'framer-motion';
import { colorAt } from './theme';

export interface BarListItem {
  label: string;
  value: number;
  display: string;
  /** Optional row action — when present the row becomes a focusable button (e.g. the
   *  Benchmarks ranking jumps to that property's intelligence page). */
  href?: () => void;
}

/** Proportional horizontal bars for category breakdowns (rent rolls, top tenants).
 *  A row carrying `href` renders as a native <button> (click + keyboard activable); rows
 *  without `href` stay non-interactive markup — backward-compatible with every existing
 *  caller (portfolio / overview / debt / acquisitions / per-property expense breakdowns). */
export function BarList({ items, colorFor }: { items: BarListItem[]; colorFor?: (i: number) => string }) {
  const max = Math.max(...items.map((i) => i.value), 1);
  return (
    <div className="flex flex-col gap-1.5">
      {items.map((it, i) => {
        const color = colorFor ? colorFor(i) : colorAt(i);
        const pct = (it.value / max) * 100;
        const bar = (
          <>
            <motion.div
              className="absolute inset-y-0 left-0 rounded-[var(--radius-xs)]"
              style={{ background: `color-mix(in oklab, ${color} 24%, transparent)`, borderLeft: `2px solid ${color}` }}
              initial={{ width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.55, ease: [0.16, 1, 0.3, 1], delay: i * 0.03 }}
            />
            <div className="relative z-10 flex w-full items-center justify-between px-2.5">
              <span className="truncate text-xs" style={{ color: 'var(--text-primary)' }}>
                {it.label}
              </span>
              <span className="num ml-3 shrink-0 text-2xs font-semibold" style={{ color: 'var(--text-secondary)' }}>
                {it.display}
              </span>
            </div>
          </>
        );
        if (it.href) {
          const onPress = it.href;
          return (
            <button
              key={it.label}
              type="button"
              onClick={onPress}
              className="group relative flex w-full items-center rounded-[var(--radius-xs)] text-left transition-colors hover:brightness-110"
              style={{ height: 30, cursor: 'pointer' }}
            >
              {bar}
            </button>
          );
        }
        return (
          <div key={it.label} className="group relative flex items-center" style={{ height: 30 }}>
            {bar}
          </div>
        );
      })}
    </div>
  );
}
