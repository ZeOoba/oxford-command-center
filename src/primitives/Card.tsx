import type { ReactNode } from 'react';
import { cn } from '@/lib/cn';

interface CardProps {
  children: ReactNode;
  className?: string;
  /** Subtle gold top-edge accent for emphasis cards. */
  accent?: boolean;
  as?: 'div' | 'section' | 'article';
}

export function Card({ children, className, accent, as: Tag = 'div' }: CardProps) {
  return (
    <Tag
      className={cn('relative rounded-[var(--radius-lg)] p-0', className)}
      style={{
        background: 'var(--surface-raised)',
        border: '1px solid var(--border-subtle)',
        boxShadow: 'var(--shadow-card)',
      }}
    >
      {accent && (
        <span
          aria-hidden
          className="absolute inset-x-0 top-0 h-px rounded-t-[var(--radius-lg)]"
          style={{
            background:
              'linear-gradient(90deg, transparent, var(--accent) 35%, var(--accent) 65%, transparent)',
            opacity: 0.7,
          }}
        />
      )}
      {children}
    </Tag>
  );
}

export function CardHeader({
  title,
  trailing,
  className,
}: {
  title: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('flex items-center justify-between gap-3 px-4 pt-3.5 pb-3', className)}
      style={{ borderBottom: '1px solid var(--border-subtle)' }}
    >
      <h3
        className="num text-2xs font-semibold uppercase"
        style={{ letterSpacing: '0.14em', color: 'var(--text-secondary)' }}
      >
        {title}
      </h3>
      {trailing}
    </div>
  );
}
