// src/primitives/ActionError.tsx
//
// Inline error for a failed action (save, grade, file, decide), review round 2 (2026-11-24): the
// action-side twin of QueryError. Several surfaces printed the raw error.message as the whole message.
// The headline now says what did not happen; the raw server text stays one click away.
import { describeActionError } from '@/lib/describe-error';

export function ActionError({
  error,
  failed,
  className = '',
}: {
  error: unknown;
  /** The whole headline, e.g. "The mapping was not added." */
  failed: string;
  className?: string;
}) {
  const d = describeActionError(error, failed);
  return (
    <div role="alert" className={`text-2xs ${className}`} style={{ color: 'var(--text-neg)' }}>
      <span>{d.headline}</span>
      {(d.detail || d.requestId) && (
        <details className="mt-0.5" style={{ color: 'var(--text-tertiary)' }}>
          <summary className="cursor-pointer">Details</summary>
          {d.detail && <div className="num mt-1 max-w-lg break-words">{d.detail}</div>}
          {d.requestId && <div className="num mt-1">Ref: {d.requestId}</div>}
        </details>
      )}
    </div>
  );
}
