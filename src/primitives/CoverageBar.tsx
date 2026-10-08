import { Button } from './Button';
import { fmtUsdCompact } from '@analytics/index';
import type { Coverage } from '@/lib/ranked-cap';

/**
 * Signal-discipline status line for a capped surface: how many signals are on screen, how much of the
 * quantified exposure they carry, and the control that releases the held-back remainder.
 */
export function CoverageBar({
  cov,
  expanded,
  onToggle,
}: {
  cov: Coverage;
  expanded: boolean;
  onToggle: () => void;
}) {
  const heldBack = cov.signalsTotal - cov.signalsShown; // signals, the same unit as the line above
  return (
    <div
      aria-label="Coverage"
      className="num flex flex-wrap items-center gap-x-4 gap-y-1 rounded-[var(--radius-md)] px-3 py-2 text-2xs"
      style={{ background: 'var(--surface-overlay)', border: '1px solid var(--border-subtle)', color: 'var(--text-secondary)' }}
    >
      <span>
        Showing <strong style={{ color: 'var(--text-primary)' }}>{cov.signalsShown} of {cov.signalsTotal} signals</strong>
      </span>
      {cov.pct !== null && (
        <span>
          <strong style={{ color: 'var(--text-primary)' }}>{fmtUsdCompact(cov.usdShown)}</strong> on screen · {cov.pct}% of{' '}
          {fmtUsdCompact(cov.usdTotal)} quantified
        </span>
      )}
      {cov.unquantified > 0 && <span style={{ color: 'var(--text-tertiary)' }}>{cov.unquantified} unquantified</span>}
      <span className="ml-auto flex items-center gap-2">
        {!expanded && heldBack > 0 && <span style={{ color: 'var(--text-tertiary)' }}>+{heldBack} held back</span>}
        <Button size="sm" variant="ghost" onPress={onToggle}>
          {expanded ? 'Show fewer' : 'View all'}
        </Button>
      </span>
    </div>
  );
}
