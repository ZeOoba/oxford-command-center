import type { ReactNode } from 'react';
import { Tooltip, TooltipTrigger, Focusable, OverlayArrow } from 'react-aria-components';
import type { Provenance as ProvenanceData } from '@contracts/index';
import { cn } from '@/lib/cn';

const LABEL: Record<ProvenanceData['confidence'], string> = {
  confirmed: 'Confirmed',
  estimated: 'Estimated',
  derived: 'Derived',
};

/**
 * Wraps a number with its data lineage. Solid underline = confirmed,
 * dotted = derived/estimated. Hover/focus reveals the source + formula.
 */
export function Provenance({ prov, children }: { prov: ProvenanceData; children: ReactNode }) {
  const dotted = prov.confidence !== 'confirmed';
  return (
    <TooltipTrigger delay={250} closeDelay={80}>
      <Focusable>
        <span
          role="button"
          tabIndex={0}
          className={cn('cursor-help', dotted ? 'prov-estimated' : 'prov-confirmed')}
        >
          {children}
        </span>
      </Focusable>
      <Tooltip
        offset={8}
        className="z-50 max-w-[280px] rounded-[var(--radius-md)] px-3 py-2 text-xs shadow-xl"
        style={{
          background: 'var(--surface-overlay)',
          border: '1px solid var(--border-strong)',
          color: 'var(--text-secondary)',
        }}
      >
        <OverlayArrow>
          <svg width={10} height={10} viewBox="0 0 10 10" style={{ display: 'block' }}>
            <path d="M0 0 L5 5 L10 0" fill="var(--surface-overlay)" stroke="var(--border-strong)" />
          </svg>
        </OverlayArrow>
        <div
          className="num mb-1 text-2xs font-semibold uppercase"
          style={{
            letterSpacing: '0.1em',
            color: prov.confidence === 'confirmed' ? 'var(--color-pos)' : 'var(--color-warn)',
          }}
        >
          {LABEL[prov.confidence]}
        </div>
        <div style={{ color: 'var(--text-primary)' }}>{prov.source}</div>
        {prov.formula && (
          <div className="num mt-1 text-2xs" style={{ color: 'var(--text-tertiary)' }}>
            ƒ = {prov.formula}
          </div>
        )}
      </Tooltip>
    </TooltipTrigger>
  );
}
