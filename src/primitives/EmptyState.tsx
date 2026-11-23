// src/primitives/EmptyState.tsx
//
// One empty state (2026-11-23 review, Tier 3): promoted from property-financials/components.tsx,
// which was the only named one while 18 files hand-wrote "No … yet" strings. A status region, so a
// screen reader announces it when a view resolves to nothing.
import type { ReactNode } from 'react';

export function EmptyState({
  title,
  children,
  className,
}: {
  title: string;
  children?: ReactNode;
  /** Module styling hook; Property Financials passes its own `pf-empty` class. */
  className?: string;
}) {
  return (
    <div className={className ?? 'flex flex-col items-center gap-1 px-4 py-10 text-center'} role="status">
      <h2 className={className ? undefined : 'text-sm font-semibold'} style={className ? undefined : { color: 'var(--text-secondary)' }}>
        {title}
      </h2>
      {children && (
        <div className={className ? undefined : 'text-2xs'} style={className ? undefined : { color: 'var(--text-tertiary)' }}>
          {children}
        </div>
      )}
    </div>
  );
}
