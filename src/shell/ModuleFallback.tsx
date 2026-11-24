import { Skeleton } from '@/primitives/Skeleton';
import { Button } from '@/primitives/Button';
import { describeError } from '@/lib/describe-error';

export function ModuleLoading() {
  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} style={{ height: 96 }} />
        ))}
      </div>
      <Skeleton style={{ height: 320 }} />
    </div>
  );
}

/** The portfolio snapshot failed to load. It used to say "Can't reach the Brain Server (:8911)" for
 *  EVERY failure, schema and 500 errors included (2026-11-23 review); the headline now follows the
 *  error, and the raw text sits behind a disclosure. */
export function ModuleError({ onRetry, error }: { onRetry: () => void; error?: unknown }) {
  const d = describeError(error, 'the portfolio snapshot');
  return (
    <div role="alert" className="grid place-items-center gap-3 py-24 text-center">
      <div className="text-sm font-semibold" style={{ color: 'var(--text-neg)' }}>
        {d.headline}
      </div>
      {d.detail && (
        <details className="num max-w-lg text-2xs" style={{ color: 'var(--text-tertiary)' }}>
          <summary className="cursor-pointer">Details</summary>
          {d.detail}
        </details>
      )}
      <Button variant="subtle" onPress={onRetry}>
        Retry
      </Button>
    </div>
  );
}
