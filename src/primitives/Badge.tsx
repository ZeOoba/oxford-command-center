import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

export type BadgeTone = 'neutral' | 'gold' | 'green' | 'amber' | 'red' | 'blue' | 'purple';

const TONES: Record<BadgeTone, { bg: string; fg: string; bd: string }> = {
  neutral: { bg: 'color-mix(in oklab, var(--text-tertiary) 14%, transparent)', fg: 'var(--text-secondary)', bd: 'var(--border-strong)' },
  gold: { bg: 'color-mix(in oklab, var(--accent) 16%, transparent)', fg: 'var(--accent)', bd: 'color-mix(in oklab, var(--accent) 45%, transparent)' },
  green: { bg: 'var(--color-pos-soft)', fg: 'var(--color-pos)', bd: 'color-mix(in oklab, var(--color-pos) 40%, transparent)' },
  amber: { bg: 'var(--color-warn-soft)', fg: 'var(--color-warn)', bd: 'color-mix(in oklab, var(--color-warn) 40%, transparent)' },
  red: { bg: 'var(--color-neg-soft)', fg: 'var(--color-neg)', bd: 'color-mix(in oklab, var(--color-neg) 40%, transparent)' },
  blue: { bg: 'color-mix(in oklab, var(--color-info) 16%, transparent)', fg: 'var(--color-info)', bd: 'color-mix(in oklab, var(--color-info) 40%, transparent)' },
  purple: { bg: 'color-mix(in oklab, var(--color-accent2) 16%, transparent)', fg: 'var(--color-accent2)', bd: 'color-mix(in oklab, var(--color-accent2) 40%, transparent)' },
};

export function Badge({
  children,
  tone = 'neutral',
  className,
  dot,
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
  dot?: boolean;
}) {
  const t = TONES[tone];
  return (
    <span
      className={cn('num inline-flex items-center gap-1.5 rounded-[var(--radius-xs)] px-2 py-0.5 text-2xs font-semibold whitespace-nowrap', className)}
      style={{ background: t.bg, color: t.fg, border: `1px solid ${t.bd}`, letterSpacing: '0.02em' }}
    >
      {dot && <span className="h-1.5 w-1.5 rounded-full" style={{ background: t.fg }} />}
      {children}
    </span>
  );
}
