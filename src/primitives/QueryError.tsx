// src/primitives/QueryError.tsx
//
// One error state for data that failed to load (2026-11-23 review, Tier 3). Before this, ~23
// surfaces printed the raw error.message (HTTP codes, SQL text, stack-ish strings) and the shell
// fallback blamed "the Brain Server (:8911)" for every failure. The headline now says WHAT failed in
// plain words; the raw text stays one click away under "Details" for diagnosis.
import { Button } from './Button';
import { describeError } from '@/lib/describe-error';

export function QueryError({
  error,
  what,
  onRetry,
  className = 'px-4 py-6',
}: {
  error: unknown;
  /** What failed to load, in the sentence "Couldn't load ___." e.g. "the debt ladder". */
  what: string;
  onRetry?: () => void;
  className?: string;
}) {
  const d = describeError(error, what);
  return (
    <div role="alert" className={`flex flex-col items-start gap-2 text-sm ${className}`}>
      <div style={{ color: d.kind === 'unavailable' ? 'var(--text-secondary)' : 'var(--text-neg)' }}>{d.headline}</div>
      {(d.detail || d.requestId) && (
        <details className="text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          <summary className="cursor-pointer">Details</summary>
          {d.detail && <div className="num mt-1 max-w-lg break-words">{d.detail}</div>}
          {d.requestId && <div className="num mt-1">Ref: {d.requestId}</div>}
        </details>
      )}
      {onRetry && (
        <Button variant="subtle" onPress={onRetry}>
          Retry
        </Button>
      )}
    </div>
  );
}
